/**
 * routes/torrent.js
 *
 * POST /torrent/start   — allocate a session and return immediately (<1 ms)
 * GET  /torrent/events/:sessionId — SSE stream: progress → codec:detected → stream:ready
 * GET  /torrent/feed/:sessionId   — persistent SSE: emits segment:ready as segments land on disk
 * GET  /torrent/status  — poll progress for one or all sessions
 * POST /torrent/stop    — decrement viewer count; optionally destroy session
 *
 * STARTUP FLOW (non-blocking):
 *   POST /start returns in <1 ms with { sessionId, eventsUrl }.
 *   The browser opens an EventSource on eventsUrl and receives:
 *     - 'progress'       every 500 ms while downloading
 *     - 'codec:detected' once ffprobe finishes
 *     - 'stream:ready'   once MIN_SEGMENTS=1 segment exists → player loads
 *   The SSE stream closes itself after 'stream:ready'.
 *
 * PERSISTENT CACHE FAST PATH:
 *   If the SegmentCache already has a complete transcoding for this infoHash
 *   (detected by #EXT-X-ENDLIST in master.m3u8), the session skips torrent
 *   download and FFmpeg entirely — stream:ready fires in milliseconds.
 *
 * SEGMENT FEED:
 *   GET /torrent/feed/:sessionId is a persistent SSE connection open during
 *   playback. It replays all already-written segment indices on connect (for
 *   late joiners) then streams new segment:ready events as FFmpeg writes them.
 *   The MSE SegmentPlayer in test.html uses this to pre-fetch segments.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { TorrentManager } from '../torrent/manager.js';
import { HlsGenerator } from '../hls/generator.js';
import { SessionManager, extractInfoHash } from '../session/manager.js';
import { detectCodecs, probeInitMimeType } from '../hls/codec.js';
import { seekLog, seekWarn, seekErr, instrLog, fmtBytes } from '../logger.js';
import { SeekTimeline } from '../instrumentation/seek-timeline.js';
import { watchSeekDir } from '../instrumentation/seek-dir-watcher.js';
import { readFragmentVideoTimeline, readFragmentMediaRange, globalIdxFromFragmentStart } from '../instrumentation/fragment-timeline.js';
import { toSegmentPayload } from '../timeline/segment-registry.js';
import { readExtinfForSegment } from '../instrumentation/segment-trace.js';
import { watchMainHlsDir } from '../instrumentation/main-hls-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// infoHash → codecInfo. Persists for the process lifetime.
const codecCache = new Map();

export default async function torrentRoutes(fastify, opts) {
  const { sessionManager, segmentCache } = opts;

  // ─── POST /torrent/start ──────────────────────────────────────────────────────
  fastify.post('/start', {
    schema: {
      body: {
        type: 'object',
        required: ['magnet'],
        properties: {
          magnet: { type: 'string', minLength: 10 },
        },
      },
    },
  }, async (request, reply) => {
    const magnet   = request.body.magnet.trim();
    const infoHash = extractInfoHash(magnet);
    if (!infoHash) {
      return reply.code(400).send({ error: 'Invalid magnet URI — could not extract infoHash' });
    }

    // Share an existing active session for the same torrent.
    const existing = sessionManager.getByInfoHash(infoHash);
    if (existing) {
      console.log(`[route] ${infoHash} — joining existing session ${existing.sessionId}`);
      return reply.send({
        status:    'joining',
        sessionId: existing.sessionId,
        eventsUrl: `/torrent/events/${existing.sessionId}`,
      });
    }

    const session = sessionManager.create(magnet);

    startSession(session, magnet, sessionManager, segmentCache).catch(err => {
      console.error('[route] session startup error:', err.message);
      session.state = 'error';
      if (session.events.listenerCount('error') > 0) {
        session.events.emit('error', { message: err.message });
      }
    });

    return reply.send({
      status:    'starting',
      sessionId: session.sessionId,
      eventsUrl: `/torrent/events/${session.sessionId}`,
    });
  });

  // ─── GET /torrent/events/:sessionId ──────────────────────────────────────────
  fastify.get('/events/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event, data) => {
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    if (session.lastProgress) send('progress', session.lastProgress);

    if (session.state === 'streaming') {
      const viewerId = sessionManager.addViewer(sessionId);
      const mimeType = resolveMimeType(session.hlsPath, session.codecInfo);
      send('stream:ready', {
        streamUrl: `/stream/${session.sessionId}/master.m3u8`,
        feedUrl:   `/torrent/feed/${session.sessionId}`,
        initUrl:   `/stream/${session.sessionId}/init.mp4`,
        mimeType,
        duration:  session.codecInfo?.duration ?? null,
        viewerId,
      });
      reply.raw.end();
      return;
    }
    if (session.state === 'error') {
      send('error', { message: 'Session failed to start' });
      reply.raw.end();
      return;
    }

    const onProgress = p => send('progress', p);
    const onCodec    = c => send('codec:detected', c);
    const onReady    = d => {
      const viewerId = sessionManager.addViewer(sessionId);
      send('stream:ready', { ...d, viewerId });
      reply.raw.end();
      cleanup();
    };
    const onError    = e => { send('error', e); reply.raw.end(); cleanup(); };

    session.events.on('progress',       onProgress);
    session.events.on('codec:detected', onCodec);
    session.events.on('stream:ready',   onReady);
    session.events.on('error',          onError);

    function cleanup() {
      session.events.off('progress',       onProgress);
      session.events.off('codec:detected', onCodec);
      session.events.off('stream:ready',   onReady);
      session.events.off('error',          onError);
    }
    request.raw.on('close', cleanup);

    return new Promise(resolve => request.raw.on('close', resolve));
  });

  // ─── GET /torrent/feed/:sessionId ────────────────────────────────────────────
  // Persistent SSE that emits 'segment:ready' events so the MSE player can
  // pre-fetch segments as soon as they land on disk. Late joiners receive a
  // replay of all already-written segments (indices 0..lastSegmentIdx).
  fastify.get('/feed/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event, data) => {
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    // Replay all already-registered segments for late joiners.
    // Use the timeline for authoritative startTime/endTime; fall back to
    // 0..lastSegmentIdx for sessions that haven't promoted through the new pipeline yet.
    const knownEntries = session.timeline.getAll();
    if (knownEntries.length > 0) {
      for (const e of knownEntries) {
        send('segment:ready', toSegmentPayload(e));
      }
    } else {
      for (let i = 0; i <= session.lastSegmentIdx; i++) {
        send('segment:ready', {
          segmentId: `segment_${String(i).padStart(5, '0')}.m4s`,
          file:      `segment_${String(i).padStart(5, '0')}.m4s`,
          startTime: i * SEG_DURATION,
          endTime:   (i + 1) * SEG_DURATION,
          duration:  SEG_DURATION,
        });
      }
    }

    const onSegment = d => send('segment:ready', d);
    session.events.on('segment:ready', onSegment);

    function cleanup() { session.events.off('segment:ready', onSegment); }
    request.raw.on('close', cleanup);

    return new Promise(resolve => request.raw.on('close', resolve));
  });

  // ─── POST /torrent/seek ──────────────────────────────────────────────────────
  // Starts a parallel FFmpeg process at `seekTime` so the user can jump ahead
  // of the main FFmpeg position. Segments are renamed to media indices on disk.
  // It stops automatically once the main FFmpeg catches up to where it started.
  fastify.post('/seek', async (request, reply) => {
    const reqT0      = Date.now();
    const sessionId  = request.body?.sessionId;
    const seekTime   = parseFloat(request.body?.seekTime);

    seekLog('route', 'POST /torrent/seek received', { sessionId, seekTime, body: request.body });

    if (!sessionId || isNaN(seekTime)) {
      seekWarn('route', 'reject: missing sessionId or seekTime');
      return reply.code(400).send({ error: 'sessionId and seekTime required' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) {
      seekWarn('route', 'reject: session not found', { sessionId });
      return reply.code(404).send({ error: 'Session not found' });
    }

    // Segment that actually covers seekTime (startTime <= seekTime < endTime).
    const covering   = session.timeline.findSeekTargetSegment(seekTime);
    // FFmpeg -ss target: one nominal segment before seek point (not a distant timeline entry).
    const seekOffset = Math.max(0, seekTime - SEG_DURATION);
    const mainTime   = session.mainLastTime ?? 0;
    const computeSeekByte = () => (session.codecInfo?.duration && session.videoFile?.length)
      ? (seekTime / session.codecInfo.duration) * session.videoFile.length
      : null;
    let seekByte = computeSeekByte();

    seekLog('route', 'computed seek targets', {
      sessionId,
      infoHash:      session.infoHash,
      seekTime,
      covering:      covering ? toSegmentPayload(covering) : null,
      seekOffset,
      mainLastTime:  mainTime,
      seekByte:      seekByte != null ? fmtBytes(seekByte) : null,
      hasTorrent:    !!session.torrentManager,
      hasSeekWorker: !!session.seekWorker,
      mode:          session.mode,
      duration:      session.codecInfo?.duration ?? null,
    });

    const seekReply = (action, entry, extra = {}) => {
      const payload = toSegmentPayload(entry) ?? {
        segmentId: entry?.file ?? null,
        file:      entry?.file ?? null,
        startTime: entry?.startTime ?? seekOffset,
        endTime:   entry?.endTime ?? seekOffset + SEG_DURATION,
        duration:  entry?.duration ?? SEG_DURATION,
      };
      return reply.send({ action, ...payload, ...extra });
    };

    const segmentOnDisk = (entry) => {
      if (!entry?.file) return false;
      try {
        return fs.statSync(path.join(session.hlsPath, entry.file)).size > 0;
      } catch {
        return false;
      }
    };

    const placeholderEntry = (start = seekOffset) => ({
      file: null, startTime: start, endTime: start + SEG_DURATION, duration: SEG_DURATION,
    });

    // Helper: wait until a segment covering seekTime is registered and on disk.
    const waitForCoveringSegment = async (timeoutMs) => {
      let entry = session.timeline.findSeekTargetSegment(seekTime);
      if (entry && segmentOnDisk(entry)) return entry;
      entry = await session.timeline.waitForTime(seekTime, timeoutMs);
      if (!entry) return null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (segmentOnDisk(entry)) return entry;
        await new Promise(r => setTimeout(r, 200));
      }
      return segmentOnDisk(entry) ? entry : null;
    };

    // Cached: segment must cover seekTime (not merely "latest before T on disk").
    if (covering && segmentOnDisk(covering)) {
      seekLog('route', 'cached — segment covers seekTime', {
        file: covering.file, startTime: covering.startTime, endTime: covering.endTime,
        seekTime, elapsedMs: Date.now() - reqT0,
      });
      return seekReply('cached', covering);
    }

    // Main encoder already passed seekTime — wait for covering segment, no seek worker.
    if (mainTime >= seekTime) {
      seekLog('route', 'main past target — waiting for covering segment', { seekTime, mainTime });
      const found = await waitForCoveringSegment(5_000);
      if (found) return seekReply('cached', found);

      seekWarn('route', 'main past target but covering segment missing', { seekTime, mainTime });
      return seekReply('waiting', placeholderEntry());
    }

    // No live torrent yet (typical cache-hit session) — start torrent so seek worker can run.
    if (!session.torrentManager || !session.internalUrl) {
      try {
        await ensureTorrentForSeek(session);
      } catch (err) {
        seekWarn('route', 'cannot start torrent for seek', { seekTime, err: err.message });
        return seekReply('waiting', placeholderEntry());
      }
      // videoFile.length is only known after ensureTorrentForSeek() on cache-hit sessions.
      seekByte = computeSeekByte();
      seekLog('route', 'torrent started for cache seek', {
        seekTime,
        seekByte: seekByte != null ? fmtBytes(seekByte) : null,
        elapsedMs: Date.now() - reqT0,
      });
    }

    // Replace any running seek worker with this new one.
    if (session.seekWorker) {
      session.seekTimeline?.summary('superseded by new seek');
      session.unwatchSeekDir?.();
      session.torrentManager?.endSeekInstrumentation();
      seekLog('route', 'replacing existing seek worker', {
        oldTempDir: session.seekWorkerTempDir,
        newSeekTime: seekTime,
      });
      try { session.seekWorker.stop(); } catch (e) {
        seekWarn('route', 'stop old seek worker failed', { err: e.message });
      }
      if (session.seekWorkerTempDir) {
        try { fs.rmSync(session.seekWorkerTempDir, { recursive: true, force: true }); } catch (e) {
          seekWarn('route', 'rm old tempDir failed', { dir: session.seekWorkerTempDir, err: e.message });
        }
        session.seekWorkerTempDir = null;
      }
      session.seekWorker = null;
    }

    const jobId    = Date.now().toString(36);
    const timeline = new SeekTimeline(jobId);
    session.seekTimeline = timeline;
    timeline.mark('seek request', { sessionId, seekTime, seekOffset, covering: covering?.file ?? null });

    // NOTE: seek-ahead path does NOT call startSeek() — only _prioritizeByteRange().
    timeline.mark('startSeek() skipped (seek-ahead uses prioritize only)', {
      seekByte: seekByte != null ? fmtBytes(seekByte) : null,
      note: 'startSeek() only used for seek-back; byte-0 reads may still occur for MKV header',
    });

    let pieceRange = null;
    if (seekByte != null) {
      pieceRange = session.torrentManager._prioritizeByteRange(seekByte, {
        reason: 'seek-ahead', seekTime, seekOffset, jobId,
      });
      timeline.mark('prioritize pieces', {
        seekByte, ...(pieceRange ?? {}),
      });
      if (pieceRange) {
        session.torrentManager.beginSeekInstrumentation({
          timeline,
          seekByte,
          startPiece: pieceRange.startPiece,
          endPiece:   pieceRange.endPiece,
          jobId,
        });
      }
    } else {
      seekWarn('route', 'skipped piece prioritization — no duration/file length');
    }

    const tempDir = path.join(session.hlsPath, `seek_${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    session.unwatchSeekDir = watchSeekDir(tempDir, timeline, jobId);

    const seekGen = new HlsGenerator({ label: `seek-${jobId}`, timeline });
    session.seekWorker = seekGen;
    session.seekWorkerTempDir = tempDir;

    seekLog('route', 'spawning seek worker FFmpeg', {
      jobId, tempDir, internalUrl: session.internalUrl, seekOffset,
    });

    timeline.mark('spawn ffmpeg', { jobId, seekOffset, tempDir });

    seekGen.start(
      session.internalUrl,
      session.videoFile.name,
      tempDir,      // isolated subdir — never touches main cache files
      session.codecInfo,
      seekOffset,   // -ss: exact segment boundary
      true,         // isSeekWorker: use seek_init.mp4
    ).then(() => {
      seekLog('route', 'seek worker FFmpeg exited cleanly', { jobId, tempDir });
      timeline.summary('ffmpeg exit');
      session.unwatchSeekDir?.();
      session.torrentManager?.endSeekInstrumentation();
    }).catch(err => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      if (session.seekWorker === seekGen) {
        session.seekWorker = null;
        session.seekWorkerTempDir = null;
      }
      timeline.mark('ffmpeg error', { err: err.message });
      timeline.summary('ffmpeg error');
      session.unwatchSeekDir?.();
      session.torrentManager?.endSeekInstrumentation();
      if (!err.message?.includes('SIGTERM')) {
        seekErr('route', 'seek worker FFmpeg error', { jobId, err: err.message });
      } else {
        seekLog('route', 'seek worker FFmpeg stopped (SIGTERM)', { jobId });
      }
    });

    wireSeekWorkerFfmpegTime(session, seekGen, seekTime, seekOffset, tempDir, segmentCache, jobId, timeline);

    // Auto-print timeline summary if seek stalls (no segment promoted in 90s)
    const stallTimer = setTimeout(() => {
      if (session.seekWorker === seekGen) {
        timeline.summary('90s stall — no completion');
        instrLog('seek-worker', 'STALL DETECTED — no seek worker completion in 90s', {
          jobId, seekTime, mainLastTime: session.mainLastTime,
        });
      }
    }, 90_000);
    if (stallTimer.unref) stallTimer.unref();
    seekGen.once('end', () => clearTimeout(stallTimer));

    return seekReply('started', placeholderEntry(), { jobId, seekTime });
  });

  // ─── GET /torrent/timeline?sessionId= ────────────────────────────────────────
  // Authoritative segment list for frontend bootstrap (sorted by startTime).
  fastify.get('/timeline', async (request, reply) => {
    const sessionId = request.query.sessionId;
    if (!sessionId) {
      return reply.code(400).send({ error: 'sessionId required' });
    }
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    return reply.send(
      session.timeline.getAll().map(e => ({
        segmentId: e.file,
        startTime: e.startTime,
        endTime:   e.endTime,
        duration:  e.duration ?? (e.endTime - e.startTime),
      }))
    );
  });

  // ─── GET /torrent/covering?sessionId=&time=|&after= ─────────────────────────
  // time=  → segment covering seek target (seek / preroll)
  // after= → segment extending bufferedEnd, or next after a gap (gap recovery)
  fastify.get('/covering', async (request, reply) => {
    const sessionId = request.query.sessionId;
    const time      = request.query.time != null ? parseFloat(request.query.time) : NaN;
    const after     = request.query.after != null ? parseFloat(request.query.after) : NaN;
    if (!sessionId || (isNaN(time) && isNaN(after))) {
      return reply.code(400).send({ error: 'sessionId and time or after required' });
    }
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    let entry = !isNaN(after)
      ? session.timeline.findNextForBuffer(after)
      : session.timeline.findSeekTargetSegment(time);

    const waitMs = Math.min(Math.max(parseInt(request.query.wait ?? '0', 10) || 0, 0), 30_000);
    if ((!entry?.file) && waitMs > 0) {
      entry = !isNaN(after)
        ? await session.timeline.waitForNextAfter(after, waitMs)
        : await session.timeline.waitForTime(time, waitMs);
    }

    if (!entry?.file) return reply.send({ segment: null });

    try {
      const p = path.join(session.hlsPath, entry.file);
      if (!fs.existsSync(p) || fs.statSync(p).size <= 0) {
        return reply.send({ segment: null });
      }
    } catch {
      return reply.send({ segment: null });
    }

    return reply.send({ segment: toSegmentPayload(entry) });
  });

  // ─── GET /torrent/status ─────────────────────────────────────────────────────
  fastify.get('/status', async (request, reply) => {
    const { sessionId, viewerId, currentTime } = request.query;

    if (sessionId && viewerId && currentTime !== undefined) {
      sessionManager.updateViewerTime(sessionId, viewerId, parseFloat(currentTime));
    }

    if (sessionId) {
      const session = sessionManager.getBySessionId(sessionId);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      return reply.send(buildSessionStatus(session));
    }

    return reply.send(sessionManager.all().map(buildSessionStatus));
  });

  // ─── POST /torrent/stop ──────────────────────────────────────────────────────
  fastify.post('/stop', async (request, reply) => {
    const sessionId = request.body?.sessionId ?? request.query?.sessionId;
    const viewerId  = request.body?.viewerId  ?? null;

    if (!sessionId) return reply.code(400).send({ error: 'sessionId required' });

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.removeViewer(session.sessionId, viewerId);
    const afterViewers = sessionManager.get(session.sessionId)?.viewers ?? 0;

    let didClean = false;
    if (afterViewers <= 0) {
      await sessionManager.destroy(session.sessionId);
      didClean = true;
    } else {
      console.log(`[route] stop: ${afterViewers} viewer(s) still watching — keeping session alive`);
    }

    return reply.send({ status: 'stopped', sessionId, viewers: afterViewers, cleaned: didClean });
  });
}

// ─── BACKGROUND SESSION STARTUP ──────────────────────────────────────────────

async function startSession(session, magnet, sessionManager, segmentCache) {
  const infoHash = session.infoHash;

  // ── Fast path: already fully transcoded ─────────────────────────────────────
  if (segmentCache.isComplete(infoHash)) {
    console.log(`[route] Cache hit for ${infoHash} — skipping download + transcode`);

    const meta = segmentCache.loadMeta(infoHash) ?? {};
    const playlistDur = segmentCache.sumPlaylistDuration(infoHash);
    session.codecInfo = {
      mode:       meta.mode ?? 'cached',
      videoCodec: meta.videoCodec ?? null,
      audioCodec: meta.audioCodec ?? null,
      duration:   meta.duration ?? null,
    };
    session.mode = session.codecInfo.mode;

    // Populate lastSegmentIdx and rebuild timeline from cached files so the
    // /feed endpoint can replay all segment indices to the connecting MSE player.
    session.lastSegmentIdx = segmentCache.highestSegmentIndex(infoHash);
    rebuildTimelineFromDisk(session);

    const mimeType = resolveMimeType(session.hlsPath, session.codecInfo);
    session.codecInfo = { ...session.codecInfo, mimeType };

    try {
      const probed = probeInitMimeType(path.join(session.hlsPath, 'init.mp4'));
      segmentCache.saveMeta(infoHash, {
        ...(segmentCache.loadMeta(infoHash) ?? {}),
        mimeType:         probed.mimeType,
        videoMimeCodec:   probed.videoMimeCodec,
        audioMimeCodec:   probed.audioMimeCodec,
        duration:         session.codecInfo.duration ?? playlistDur,
      });
    } catch (err) {
      console.warn(`[codec] Could not refresh meta mime for ${infoHash}: ${err.message}`);
    }

    session.state = 'streaming';
    session.events.emit('stream:ready', {
      streamUrl: `/stream/${session.sessionId}/master.m3u8`,
      feedUrl:   `/torrent/feed/${session.sessionId}`,
      initUrl:   `/stream/${session.sessionId}/init.mp4`,
      mimeType,
      duration:  session.codecInfo.duration ?? playlistDur,
    });

    if (!session.codecInfo.duration) {
      probeSourceDuration(session, magnet, segmentCache).catch(err => {
        console.warn(`[route] Background duration probe failed for ${infoHash}:`, err.message);
      });
    }

    // Warm torrent in background so cache-hit seeks avoid cold-start + MKV probe delay.
    warmTorrentForSession(session, magnet).catch(err => {
      console.warn(`[route] Background torrent warm failed for ${infoHash}:`, err.message);
    });
    return;
  }

  // ── Normal path: download + transcode ────────────────────────────────────────

  // Drop any partial cache from a previous interrupted run so FFmpeg writes
  // a clean sequence of segment_00000.m4s, segment_00001.m4s, ... from scratch.
  segmentCache.drop(infoHash);

  session.torrentManager = new TorrentManager();
  session.generator      = new HlsGenerator();

  // 1. Start torrent download + internal HTTP server
  let internalUrl, videoFile;
  try {
    ({ internalUrl, videoFile } = await session.torrentManager.start(magnet));
  } catch (err) {
    session.state = 'error';
    session.events.emit('error', { message: `Torrent start failed: ${err.message}` });
    await sessionManager.destroy(session.sessionId).catch(() => {});
    return;
  }

  session.videoFile   = videoFile;
  session.internalUrl = internalUrl;

  session.torrentManager.on('progress', p => {
    session.lastProgress = p;
    session.events.emit('progress', p);
  });

  // 2. Codec detection — skip if cached for this infoHash
  let codecInfo;
  if (codecCache.has(infoHash)) {
    codecInfo = codecCache.get(infoHash);
    console.log(`[route] Codec cache hit for ${infoHash}: mode=${codecInfo.mode}`);
  } else {
    const ext     = path.extname(videoFile.name).toLowerCase();
    const fmtHint = {
      '.mkv':  'matroska', '.avi': 'avi', '.mov': 'mov',
      '.mp4':  'mp4', '.webm': 'webm', '.m4v': 'mp4',
    }[ext] ?? null;

    try {
      codecInfo = await detectCodecs(internalUrl, fmtHint ? ['-f', fmtHint] : []);
      codecCache.set(infoHash, codecInfo);
    } catch (err) {
      session.state = 'error';
      session.events.emit('error', { message: `Codec detection failed: ${err.message}` });
      await sessionManager.destroy(session.sessionId).catch(() => {});
      return;
    }
  }

  session.codecInfo = codecInfo;
  session.mode      = codecInfo.mode;
  session.state     = 'ready';

  // Persist duration immediately so cache hits survive server restarts.
  segmentCache.saveMeta(infoHash, {
    mode:       codecInfo.mode,
    audioCodec: codecInfo.audioCodec,
    videoCodec: codecInfo.videoCodec,
    duration:   codecInfo.duration ?? null,
  });

  session.events.emit('codec:detected', {
    videoCodec: codecInfo.videoCodec,
    audioCodec: codecInfo.audioCodec,
    mode:       codecInfo.mode,
  });

  session.segmentTrace.setHlsPath(session.hlsPath);
  session.unwatchMainHls = watchMainHlsDir(session.hlsPath, session.segmentTrace);

  // 3. Start FFmpeg (fire-and-forget)
  session.generator
    .start(internalUrl, videoFile.name, session.hlsPath, session.codecInfo)
    .then(() => {
      // FFmpeg finished cleanly — persist codec metadata so cached sessions
      // can reconstruct the correct MSE mimeType on future server restarts.
      segmentCache.saveMeta(infoHash, {
        mode:       codecInfo.mode,
        audioCodec: codecInfo.audioCodec,
        videoCodec: codecInfo.videoCodec,
        duration:   codecInfo.duration ?? null,
      });
      console.log(`[route] Transcoding complete for ${infoHash}`);
    })
    .catch(err => {
      console.error('[route] FFmpeg error:', err.message);
      session.state = 'error';
      session.events.emit('error', { message: err.message });
    });

  wireMainFfmpegTime(session, segmentCache);

  session.generator.on('segment-open', ({ filename, segCounter, ffmpegTime, label }) => {
    if (label !== 'main') return;
    session.segmentTrace?.record('ffmpeg-segment-open', {
      assignedSeg:        segCounter,
      ffmpegSegCounter:   segCounter,
      ffmpegReportedTime: ffmpegTime,
      segmentFilename:    filename,
      actualPath:         path.join(session.hlsPath, filename),
    });
  });

  // 4. Wait for HLS bootstrap (init + first segment).
  try {
    await Promise.race([
      waitForHlsBootstrap(session.hlsPath, session.segmentTrace),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout waiting for first HLS segment')), 120_000)
      ),
    ]);
    console.log(`[route] HLS bootstrap ready: ${session.sessionId}`);
  } catch (err) {
    session.state = 'error';
    session.events.emit('error', { message: err.message });
    await sessionManager.destroy(session.sessionId).catch(() => {});
    return;
  }

  // Register init.mp4 in the LRU index.
  segmentCache.register(infoHash, -1); // INIT_IDX = -1

  const mimeType = resolveMimeType(session.hlsPath, session.codecInfo);
  session.codecInfo = { ...session.codecInfo, mimeType };
  segmentCache.saveMeta(infoHash, {
    mode:            codecInfo.mode,
    audioCodec:      codecInfo.audioCodec,
    videoCodec:      codecInfo.videoCodec,
    duration:        codecInfo.duration ?? null,
    mimeType,
    videoMimeCodec:  session.codecInfo.videoMimeCodec ?? null,
    audioMimeCodec:  session.codecInfo.audioMimeCodec ?? null,
  });

  // 5. Signal the browser.
  session.state = 'streaming';
  session.events.emit('stream:ready', {
    streamUrl: `/stream/${session.sessionId}/master.m3u8`,
    feedUrl:   `/torrent/feed/${session.sessionId}`,
    initUrl:   `/stream/${session.sessionId}/init.mp4`,
    mimeType,
    duration:  session.codecInfo?.duration ?? null,
  });
}

// ─── CONSTANTS & HELPERS ─────────────────────────────────────────────────────

const EVICTION_SAFETY = 20 * 1024 * 1024;
const SEG_DURATION    = 2;
const SEGMENT_FILE_RE = /^segment_(?:t\d+(?:_\d+)?|\d+)\.m4s$/;

/** Unique on-disk name for seek-worker fragments (never reuse main encoder indices). */
function seekSegmentFilename(hlsPath, startTime) {
  const base = `segment_t${Math.round(startTime * 1000)}.m4s`;
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(hlsPath, name))) {
    name = `segment_t${Math.round(startTime * 1000)}_${n}.m4s`;
    n++;
  }
  return name;
}

/** Move or copy a finished segment into the session cache directory. */
async function installSegmentFile(srcPath, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  if (path.resolve(srcPath) === path.resolve(destPath)) return;
  try {
    await fs.promises.rename(srcPath, destPath);
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'ENOTEMPTY') {
      await fs.promises.copyFile(srcPath, destPath);
      await fs.promises.unlink(srcPath).catch(() => {});
    } else {
      throw err;
    }
  }
}

// ── Unified promotion pipeline ────────────────────────────────────────────────
//
// ALL segment files — whether written by the main encoder or a seek worker —
// pass through promoteCompletedSegment().  TFDT sets startTime/endTime in the
// timeline; FFmpeg's sequential %05d filename is kept as-is (no rename to
// floor(t/SEG_DURATION), which collides when segment durations vary).

/**
 * Read TFDT from a fully-written fMP4 segment, compute its canonical filename
 * from media time, rename in-place if necessary, then register in the session
 * timeline + segment cache + legacy SegmentRegistry.
 *
 * Emits `segment:ready` with { segmentId, startTime, endTime, index } on the
 * session event bus.  Returns the timeline entry on success, null on failure.
 *
 * @param {string} srcPath      - Absolute path of the just-finished segment
 * @param {object} session
 * @param {object} segmentCache
 * @param {string} [source]     - 'main' | 'seek'
 * @param {object} [opts]
 * @param {object} [opts.timeline]  - SeekTimeline instrumentation (seek worker only)
 * @param {string} [opts.jobId]
 */
/** Map seek-worker relative TFDT to absolute media timeline. */
function absoluteSeekTimes(startTime, endTime, seekOffset) {
  if (seekOffset == null || !Number.isFinite(seekOffset)) {
    return { startTime, endTime };
  }
  // FFmpeg HLS fMP4 keeps fragment tfdt near 0 after -ss; -output_ts_offset does not
  // propagate into tfdt boxes. Add seekOffset when timestamps are clearly relative.
  if (seekOffset > SEG_DURATION && startTime < seekOffset) {
    return { startTime: startTime + seekOffset, endTime: endTime + seekOffset };
  }
  return { startTime, endTime };
}

async function promoteCompletedSegment(srcPath, session, segmentCache, source = 'main', opts = {}) {
  let mediaRange = readFragmentMediaRange(srcPath);

  if (!mediaRange) {
    await new Promise(r => setTimeout(r, 80));
    mediaRange = readFragmentMediaRange(srcPath);
  }

  const srcName   = path.basename(srcPath);
  const srcMatch  = /^segment_(\d+)\.m4s$/.exec(srcName);
  const srcSeq    = srcMatch ? parseInt(srcMatch[1], 10) : null;

  if (source === 'main' && srcSeq == null) {
    seekWarn('promote', 'unrecognised filename — skipping', { srcPath });
    return null;
  }

  let startTime, endTime;
  let expectedIdx = null;

  if (mediaRange) {
    const extinf = source === 'main'
      ? readExtinfForSegment(session.hlsPath, srcName)
      : null;
    const dur = extinf
      ?? (mediaRange.durationSeconds > 0 && mediaRange.durationSeconds <= 30
        ? mediaRange.durationSeconds : null)
      ?? SEG_DURATION;
    startTime   = mediaRange.startSeconds;
    endTime     = startTime + dur;
    expectedIdx = globalIdxFromFragmentStart(startTime);
  } else if (srcSeq != null) {
    startTime = srcSeq * SEG_DURATION;
    endTime   = startTime + SEG_DURATION;
    seekWarn('promote', 'TFDT unreadable — falling back to filename index', { srcPath, srcSeq });
  } else {
    seekWarn('promote', 'TFDT unreadable for seek segment — skipping', { srcPath });
    return null;
  }

  if (source === 'seek') {
    const tfdtRelative = startTime;
    ({ startTime, endTime } = absoluteSeekTimes(startTime, endTime, opts.seekOffset));
    if (tfdtRelative !== startTime) {
      expectedIdx = globalIdxFromFragmentStart(startTime);
      seekLog('promote', 'seek TFDT relative — applied seekOffset', {
        file: srcName,
        seekOffset: opts.seekOffset,
        tfdtRelative: +tfdtRelative.toFixed(3),
        startTime:    +startTime.toFixed(3),
      });
    } else if (opts.seekOffset > SEG_DURATION && tfdtRelative < SEG_DURATION) {
      seekWarn('promote', 'seek worker TFDT near 0 but offset not applied', {
        file: srcName, seekOffset: opts.seekOffset, startSeconds: tfdtRelative,
      });
    }
  }

  const stableName = source === 'seek'
    ? seekSegmentFilename(session.hlsPath, startTime)
    : srcName;
  const stablePath = path.join(session.hlsPath, stableName);

  try {
    await installSegmentFile(srcPath, stablePath);
  } catch (err) {
    seekWarn('promote', 'install segment file failed', {
      srcPath, stablePath, err: err.message,
    });
    return null;
  }

  // Register in the timeline — this is THE authoritative record.
  const entry = session.timeline.register({ file: stableName, startTime, endTime, source });

  if (source === 'main' && srcSeq != null) {
    session.registry.markReady(srcSeq);
    segmentCache.register(session.infoHash, srcSeq, { trace: session.segmentTrace });
    if (srcSeq > session.lastSegmentIdx) session.lastSegmentIdx = srcSeq;
  }

  session.segmentTrace?.record('promote', {
    assignedSeg:          srcSeq,
    expectedSegFromTfdt:  expectedIdx,
    source,
    startTime:            +startTime.toFixed(3),
    endTime:              +endTime.toFixed(3),
    segmentFilename:      stableName,
    actualPath:           stablePath,
    tfdtParsed:           mediaRange != null,
  });

  const payload = toSegmentPayload(entry);
  session.events.emit('segment:ready', payload);

  if (opts.timeline) {
    opts.timeline.markOnce(`promote-${stableName}`, 'segment promoted', {
      stableName, startTime: startTime.toFixed(3), source,
    });
  }

  seekLog('promote', `segment complete`, {
    segmentId: stableName, startTime: startTime.toFixed(3), srcSeq, source,
  });

  return entry;
}

/**
 * Wire the main HLS generator to the promotion pipeline.
 *
 * Two event sources:
 *   segment-open(N) → segment N-1 is fully written, promote it.
 *   ffmpeg end       → promote the last segment.
 *
 * ffmpeg-time events are still used for:
 *   - EvictingMemoryStore eviction (byte-position based)
 *   - session.mainLastTime (seek worker auto-stop uses this, NOT lastSegmentIdx)
 */
function wireMainFfmpegTime(session, segmentCache) {
  let lastOpenedCounter = null;   // FFmpeg's %05d counter of the segment now being written

  // FFmpeg opens segment N → segment lastOpenedCounter is complete.
  session.generator.on('segment-open', async ({ segCounter }) => {
    const prevCounter = lastOpenedCounter;
    lastOpenedCounter = segCounter;

    if (prevCounter === null) return;  // first segment just opened, nothing to promote yet

    const prevFile = path.join(session.hlsPath, `segment_${String(prevCounter).padStart(5, '0')}.m4s`);
    await promoteCompletedSegment(prevFile, session, segmentCache, 'main');
  });

  // FFmpeg finishes → promote the last segment.
  session.generator.on('end', async () => {
    if (lastOpenedCounter === null) return;
    const lastFile = path.join(session.hlsPath, `segment_${String(lastOpenedCounter).padStart(5, '0')}.m4s`);
    await promoteCompletedSegment(lastFile, session, segmentCache, 'main');
  });

  // ffmpeg-time: eviction + mainLastTime only.  Segment completion is now
  // driven by segment-open / end above — never by floor(secs/SEG_DURATION).
  session.generator.on('ffmpeg-time', secs => {
    session.mainLastTime = secs;

    if (session.codecInfo?.duration && session.videoFile?.length) {
      const bytePos = (secs / session.codecInfo.duration) * session.videoFile.length;
      session.torrentManager?.store?.evictBefore(Math.max(0, bytePos - EVICTION_SAFETY));
      session.torrentManager?.prioritizeEncodeReadahead(
        secs, session.codecInfo.duration, session.videoFile.length,
      );
    }
  });
}

/**
 * Scan tempDir for fully-written seek segments and promote each one through
 * promoteCompletedSegment() — the unified pipeline.
 *
 * Size-stability check: stat, wait 150 ms, stat again.  Skip if still growing.
 * isFinal=true skips the wait so the last batch clears before tempDir is removed.
 */
async function promoteSeekSegments({
  tempDir, seekOffset, segmentCache, session, jobId, timeline, promoted, isFinal = false,
}) {
  let files;
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!/^segment_\d{5}\.m4s$/.test(file) || promoted.has(file)) continue;

    const src = path.join(tempDir, file);

    try {
      const stat1 = await fs.promises.stat(src);
      if (stat1.size === 0) continue;

      if (!isFinal) {
        await new Promise(r => setTimeout(r, 150));
        const stat2 = await fs.promises.stat(src);
        if (stat1.size !== stat2.size) continue;
      }
    } catch {
      continue;
    }

    // Quick TFDT check before handing to the unified promote function.
    const timelineInfo = readFragmentVideoTimeline(src);
    if (!timelineInfo) {
      instrLog('promote', `tfdt not parseable yet — skipping ${file}`, { jobId });
      continue;
    }

    if (seekOffset > SEG_DURATION && timelineInfo.startSeconds < SEG_DURATION) {
      seekLog('promote', 'seek fragment tfdt relative — offset applied at promote', {
        jobId, file, seekOffset, tfdtRelative: timelineInfo.startSeconds,
      });
    }

    promoted.add(file);
    await promoteCompletedSegment(src, session, segmentCache, 'seek', { timeline, jobId, seekOffset });
  }
}

function wireSeekWorkerFfmpegTime(session, seekGen, seekTime, seekOffset, tempDir, segmentCache, jobId, timeline) {
  const promoted = new Set();
  let pollActive = true;

  const pollPromotion = async () => {
    if (!pollActive) return;
    try {
      await promoteSeekSegments({ tempDir, seekOffset, segmentCache, session, jobId, timeline, promoted });
    } catch {}
    if (pollActive) setTimeout(pollPromotion, 250);
  };
  pollPromotion();

  // Auto-stop: main encoder has passed the seek point — its segments now cover
  // the range the seek worker was filling.  Use actual media time, not segment index.
  session.generator?.on('ffmpeg-time', checkCatchUp);
  function checkCatchUp() {
    if (session.mainLastTime >= seekTime) {
      timeline?.mark('main caught up — stopping seek worker', {
        mainLastTime: session.mainLastTime, seekTime,
      });
      session.generator?.off('ffmpeg-time', checkCatchUp);
      seekGen.stop();
      if (session.seekWorker === seekGen) {
        session.seekWorker      = null;
        session.seekWorkerTempDir = null;
        session.unwatchSeekDir?.();
        session.torrentManager?.endSeekInstrumentation();
        timeline?.summary('main ffmpeg caught up');
      }
    }
  }

  seekGen.once('end', async () => {
    pollActive = false;
    session.generator?.off('ffmpeg-time', checkCatchUp);
    try {
      await promoteSeekSegments({
        tempDir, seekOffset, segmentCache, session, jobId, timeline, promoted, isFinal: true,
      });
    } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (session.seekWorker === seekGen) {
      session.seekWorker      = null;
      session.seekWorkerTempDir = null;
    }
  });
}

/**
 * Rebuild a session's SegmentTimelineRegistry from already-on-disk segments.
 * Called for cache-hit sessions (no active FFmpeg) so /feed replays accurate timing.
 */
function rebuildTimelineFromDisk(session) {
  let files;
  try { files = fs.readdirSync(session.hlsPath); } catch { return; }

  for (const file of files.sort()) {
    if (!SEGMENT_FILE_RE.test(file)) continue;
    const filePath = path.join(session.hlsPath, file);
    const range = readFragmentMediaRange(filePath);
    if (!range) continue;
    const extinf = readExtinfForSegment(session.hlsPath, file);
    const dur    = extinf ?? (range.durationSeconds <= 30 ? range.durationSeconds : SEG_DURATION);
    session.timeline.register({
      file,
      startTime: range.startSeconds,
      endTime:   range.startSeconds + dur,
      source:    'cache',
    });
    const m = /^segment_(\d+)\.m4s$/.exec(file);
    if (m) {
      const fileSeq = parseInt(m[1], 10);
      session.registry.markReady(fileSeq);
      if (fileSeq > session.lastSegmentIdx) session.lastSegmentIdx = fileSeq;
    }
  }
  seekLog('startup', 'timeline rebuilt from disk', {
    sessionId: session.sessionId, entries: session.timeline.count(),
  });
}

function buildMimeType(codecInfo) {
  if (codecInfo?.mimeType) return codecInfo.mimeType;
  const video = 'avc1.640028';
  const audio = 'mp4a.40.2';
  return codecInfo?.audioMimeCodec === null && codecInfo?.audioCodec === null
    ? `video/mp4; codecs="${video}"`
    : `video/mp4; codecs="${video}, ${audio}"`;
}

/** Probe init.mp4 on disk — authoritative for MSE SourceBuffer mimeType. */
function resolveMimeType(hlsPath, codecInfo) {
  if (codecInfo?.mimeType) return codecInfo.mimeType;
  const initPath = path.join(hlsPath, 'init.mp4');
  try {
    if (fs.existsSync(initPath) && fs.statSync(initPath).size > 0) {
      const probed = probeInitMimeType(initPath);
      console.log(`[codec] init mimeType: ${probed.mimeType}`);
      return probed.mimeType;
    }
  } catch (err) {
    console.warn(`[codec] init probe failed, using fallback: ${err.message}`);
  }
  return buildMimeType(codecInfo);
}

/** Start torrent in background for cache sessions (does not block stream:ready). */
function warmTorrentForSession(session, magnet) {
  if (session.torrentManager?.internalUrl && session.videoFile) return Promise.resolve();
  if (!magnet) return Promise.reject(new Error('session has no magnetUri'));
  return ensureTorrentForSeek(session);
}

/** Start WebTorrent + internal HTTP server on demand (cache-hit seeks). */
async function ensureTorrentForSeek(session) {
  if (session.torrentManager && session.internalUrl && session.videoFile) return;

  const magnet = session.magnetUri;
  if (!magnet) throw new Error('session has no magnetUri');

  session.torrentManager = new TorrentManager();
  const { internalUrl, videoFile } = await session.torrentManager.start(magnet);
  session.internalUrl = internalUrl;
  session.videoFile   = videoFile;

  if (!session.codecInfo?.duration && codecCache.has(session.infoHash)) {
    session.codecInfo = { ...session.codecInfo, ...codecCache.get(session.infoHash) };
  }
}

/** ffprobe source file duration for cache hits missing meta.json (non-blocking). */
async function probeSourceDuration(session, magnet, segmentCache) {
  const infoHash = session.infoHash;
  const existing = segmentCache.loadMeta(infoHash);
  if (existing?.duration) {
    session.codecInfo = { ...session.codecInfo, duration: existing.duration };
    return existing.duration;
  }

  console.log(`[route] Probing source duration for ${infoHash}`);
  const tm = new TorrentManager();
  try {
    const { internalUrl, videoFile } = await tm.start(magnet);
    const ext = path.extname(videoFile.name).toLowerCase();
    const fmtHint = {
      '.mkv': 'matroska', '.avi': 'avi', '.mov': 'mov',
      '.mp4': 'mp4', '.webm': 'webm', '.m4v': 'mp4',
    }[ext] ?? null;

    const codecInfo = await detectCodecs(internalUrl, fmtHint ? ['-f', fmtHint] : []);
    if (!codecInfo.duration) return null;

    const meta = {
      ...(existing ?? {}),
      duration: codecInfo.duration,
    };
    segmentCache.saveMeta(infoHash, meta);
    codecCache.set(infoHash, { ...codecCache.get(infoHash), duration: codecInfo.duration });
    session.codecInfo = { ...session.codecInfo, duration: codecInfo.duration };
    console.log(`[route] Source duration ${codecInfo.duration}s saved for ${infoHash}`);
    return codecInfo.duration;
  } finally {
    await tm.stop().catch(() => {});
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const MIN_SEGMENTS = 1;

function waitForHlsBootstrap(hlsDir, trace = null) {
  return new Promise((resolve) => {
    const check = () => {
      try {
        const files = fs.readdirSync(hlsDir);
        const hasInit = files.includes('init.mp4') && fs.statSync(path.join(hlsDir, 'init.mp4')).size > 0;
        const hasPlaylist = files.includes('master.m3u8');
        const m4sFiles = files.filter(f => f.endsWith('.m4s')).sort();
        const m4sCount = m4sFiles.length;
        if (hasInit && hasPlaylist && m4sCount >= MIN_SEGMENTS) {
          if (trace) {
            for (const f of m4sFiles.slice(0, 6)) {
              const m = /^segment_(\d+)\.m4s$/.exec(f);
              if (!m) continue;
              trace.record('bootstrap-detect', {
                assignedSeg:      parseInt(m[1], 10),
                ffmpegSegCounter: parseInt(m[1], 10),
                segmentFilename:  f,
                actualPath:       path.join(hlsDir, f),
              });
            }
          }
          resolve();
          return;
        }
      } catch { /* dir may not exist yet */ }
      setTimeout(check, 200);
    };
    check();
  });
}

function waitForSegmentFile(filePath, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return resolve(true);
      } catch {}
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 200);
    };
    check();
  });
}

function buildSessionStatus(session) {
  const torrentStatus = session.torrentManager?.status() ?? {};

  let hlsSegments = 0;
  try { hlsSegments = fs.readdirSync(session.hlsPath).filter(f => f.endsWith('.m4s')).length; } catch {}

  return {
    sessionId:    session.sessionId,
    infoHash:     session.infoHash,
    state:        session.state,
    mode:         session.mode,
    viewers:      session.viewers,
    streamUrl:    `/stream/${session.sessionId}/master.m3u8`,
    name:          torrentStatus.name          ?? null,
    downloaded:    torrentStatus.downloaded    ?? 0,
    total:         torrentStatus.total         ?? 0,
    progress:      torrentStatus.progress      ?? 0,
    downloadSpeed: torrentStatus.downloadSpeed ?? 0,
    numPeers:      torrentStatus.numPeers      ?? 0,
    hlsSegments,
    memoryUsedMB:  torrentStatus.memoryUsedMB  ?? 0,
    duration:      session.codecInfo?.duration ?? null,
  };
}
