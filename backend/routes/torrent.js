/**
 * routes/torrent.js — torrent lifecycle routes.
 *
 * POST /torrent/start         allocate session, begin pipeline async
 * GET  /torrent/events/:id    SSE: progress → stream:ready
 * GET  /torrent/feed/:id      SSE: segment:ready (persistent during playback)
 * GET  /torrent/status        poll session metrics
 * GET  /torrent/timeline      all registered segments for a session
 * GET  /torrent/covering      wait for segment covering a time / extending buffer
 * POST /torrent/seek          trigger seek worker or return cached segment
 * POST /torrent/stop          decrement viewer count
 */

import path from 'path';
import fs   from 'fs';
import { fileURLToPath } from 'url';

import { TorrentManager }                        from '../provider/webtorrent.js';
import { detectCodecs }                          from '../pipeline/codec.js';
import { HlsGenerator }                          from '../pipeline/ffmpeg.js';
import { readSegmentTiming, readInitTimescale }  from '../pipeline/fmp4.js';
import { SeekWorkerManager }   from '../pipeline/seek.js';
import { extractInfoHash }     from '../session/manager.js';
import { toSegmentPayload }    from '../core/timeline.js';
import { log, warn, fmtBytes } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NS = 'route';

// Minimum bytes to download before handing the source to FFmpeg.
// Also wait for this many HLS segments before declaring stream:ready.
const MIN_SEGMENTS = 1;
// How many seconds of wall-clock to wait for the first segment before erroring.
const FIRST_SEG_TIMEOUT_MS = 120_000;

export default async function torrentRoutes(fastify, opts) {
  const { sessionManager, segmentCache } = opts;

  // ── POST /torrent/start ────────────────────────────────────────────────────
  fastify.post('/start', {
    schema: {
      body: {
        type: 'object', required: ['magnet'],
        properties: { magnet: { type: 'string', minLength: 10 } },
      },
    },
  }, async (req, reply) => {
    const magnet   = req.body.magnet.trim();
    const infoHash = extractInfoHash(magnet);
    if (!infoHash) return reply.code(400).send({ error: 'Invalid magnet URI' });

    // Share existing session for the same torrent.
    const existing = sessionManager.getByInfoHash(infoHash);
    if (existing) {
      log(NS, `Join existing session ${existing.sessionId}`);
      return reply.send({
        status:    'joining',
        sessionId: existing.sessionId,
        eventsUrl: `/torrent/events/${existing.sessionId}`,
      });
    }

    const session = sessionManager.create(magnet);

    _startPipeline(session, segmentCache).catch(e => {
      warn(NS, `Pipeline error: ${e.message}`);
      session.state = 'error';
      session.events.emit('error', { message: e.message });
    });

    return reply.send({
      status:    'starting',
      sessionId: session.sessionId,
      eventsUrl: `/torrent/events/${session.sessionId}`,
    });
  });

  // ── GET /torrent/events/:sessionId ────────────────────────────────────────
  fastify.get('/events/:sessionId', async (req, reply) => {
    const session = sessionManager.getBySessionId(req.params.sessionId);
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

    // Already streaming → fast path.
    if (session.state === 'streaming') {
      const viewerId = sessionManager.addViewer(session.sessionId);
      send('stream:ready', _buildReadyPayload(session, viewerId));
      reply.raw.end();
      return;
    }

    if (session.state === 'error') {
      send('error', { message: 'Session failed to start' });
      reply.raw.end();
      return;
    }

    // Replay last progress if we have one.
    if (session.lastProgress) send('progress', session.lastProgress);

    const onProgress = p  => send('progress', p);
    const onReady    = d  => {
      const viewerId = sessionManager.addViewer(session.sessionId);
      send('stream:ready', { ...d, viewerId });
      cleanup();
      reply.raw.end();
    };
    const onError    = e  => { send('error', e); cleanup(); reply.raw.end(); };

    session.events.on('progress',     onProgress);
    session.events.once('stream:ready', onReady);
    session.events.once('error',        onError);

    const cleanup = () => {
      session.events.off('progress',      onProgress);
      session.events.off('stream:ready',  onReady);
      session.events.off('error',         onError);
    };
    req.raw.on('close', cleanup);

    return new Promise(r => req.raw.on('close', r));
  });

  // ── GET /torrent/feed/:sessionId ──────────────────────────────────────────
  // Persistent SSE for segment:ready events. Replays all known segments on
  // connect so late joiners get the full timeline immediately.
  fastify.get('/feed/:sessionId', async (req, reply) => {
    const session = sessionManager.getBySessionId(req.params.sessionId);
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

    // Replay history
    for (const entry of session.timeline.getAll()) {
      send('segment:ready', toSegmentPayload(entry));
    }

    const onSegment = d => send('segment:ready', d);
    session.events.on('segment:ready', onSegment);

    const cleanup = () => session.events.off('segment:ready', onSegment);
    req.raw.on('close', cleanup);

    return new Promise(r => req.raw.on('close', r));
  });

  // ── GET /torrent/status ───────────────────────────────────────────────────
  fastify.get('/status', async (req, reply) => {
    const { sessionId, viewerId, currentTime } = req.query;
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    if (viewerId && currentTime != null) {
      sessionManager.updateViewerTime(sessionId, viewerId, parseFloat(currentTime));
    }
    sessionManager.touch(sessionId);

    const stats    = session.torrentManager?.getStats() ?? {};
    const memoryMB = process.memoryUsage().heapUsed / 1048576;

    // Count segments on disk.
    let hlsSegments = 0;
    try {
      hlsSegments = fs.readdirSync(session.hlsPath).filter(f => f.endsWith('.m4s')).length;
    } catch {}

    return reply.send({
      state:         session.state,
      mode:          session.mode        ?? '—',
      downloaded:    stats.downloaded   ?? 0,
      total:         stats.total        ?? 0,
      downloadSpeed: stats.downloadSpeed ?? 0,
      numPeers:      stats.numPeers     ?? 0,
      progress:      stats.progress     ?? 0,
      hlsSegments,
      memoryUsedMB:  memoryMB.toFixed(1),
      duration:      session.codecInfo?.duration ?? null,
      mainLastTime:  session.mainLastTime,
      timelineCount: session.timeline.count(),
      seekWorkers:   session.seekWorkerMgr?.getWorkerStats() ?? [],
      pieces:        stats.pieces ?? null,
      ramBytes:      stats.ramBytes ?? null,
      viewers:       session.viewers,
    });
  });

  // ── GET /torrent/timeline ─────────────────────────────────────────────────
  fastify.get('/timeline', async (req, reply) => {
    const session = sessionManager.getBySessionId(req.query.sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    return reply.send(session.timeline.getAll().map(e => ({
      segmentId: e.file,
      file:      e.file,
      startTime: e.startTime,
      endTime:   e.endTime,
      duration:  e.duration,
      source:    e.source,
    })));
  });

  // ── GET /torrent/covering ─────────────────────────────────────────────────
  // Long-poll: waits up to `wait` ms for a segment covering `time` or
  // extending `after` (bufferedEnd). Returns {segment} or {segment: null}.
  fastify.get('/covering', async (req, reply) => {
    const { sessionId, time, after, wait = '8000' } = req.query;
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const waitMs = Math.min(parseInt(wait, 10) || 8000, 30_000);

    let entry = null;
    if (time != null) {
      const t = parseFloat(time);
      entry = await session.timeline.waitForTime(t, waitMs);
    } else if (after != null) {
      const bufferedEnd = parseFloat(after);
      entry = await session.timeline.waitForNextAfter(bufferedEnd, waitMs);
    }

    return reply.send({ segment: toSegmentPayload(entry) });
  });

  // ── POST /torrent/seek ────────────────────────────────────────────────────
  fastify.post('/seek', async (req, reply) => {
    const { sessionId, seekTime: seekTimeRaw } = req.body ?? {};
    const seekTime = parseFloat(seekTimeRaw);

    if (!sessionId || !isFinite(seekTime)) {
      return reply.code(400).send({ error: 'sessionId and seekTime required' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);

    // Case 1: Segment already covers seekTime — serve immediately.
    const covering = session.timeline.findSeekTargetSegment(seekTime);
    const onDisk   = covering && _segmentExistsOnDisk(session.hlsPath, covering.file);
    if (onDisk) {
      log(NS, `seek ${seekTime}s → cached (${covering.file})`);
      return reply.send({ action: 'cached', ...toSegmentPayload(covering) });
    }

    // Case 2: Main encoder is close enough — wait for it.
    const mainTime = session.mainLastTime ?? 0;
    if (seekTime <= mainTime + 20) {
      log(NS, `seek ${seekTime}s → waiting (mainTime=${mainTime.toFixed(1)}s)`);
      const seekOffset = Math.max(0, seekTime - 2);
      return reply.send({
        action:    'waiting',
        startTime: seekOffset,
        endTime:   seekOffset + 2,
        duration:  2,
      });
    }

    // Case 3: Start a seek worker.
    if (!session.seekWorkerMgr) {
      warn(NS, `seek: no seekWorkerMgr on session ${sessionId}`);
      return reply.send({ action: 'waiting', startTime: seekTime - 2, endTime: seekTime });
    }

    // Estimate byte offset for piece prioritization.
    const seekByte = session.codecInfo?.duration && session.videoFile?.length
      ? (seekTime / session.codecInfo.duration) * session.videoFile.length
      : null;

    try {
      const { startTime, endTime } = await session.seekWorkerMgr.startWorker(seekTime, seekByte);
      log(NS, `seek ${seekTime}s → worker started (~${startTime.toFixed(1)}s)`);
      return reply.send({
        action:    'started',
        startTime,
        endTime,
        duration:  endTime - startTime,
      });
    } catch (e) {
      warn(NS, `seek worker failed: ${e.message}`);
      return reply.send({ action: 'waiting', startTime: seekTime - 2, endTime: seekTime });
    }
  });

  // ── POST /torrent/stop ────────────────────────────────────────────────────
  fastify.post('/stop', async (req, reply) => {
    const { sessionId, viewerId } = req.body ?? {};
    if (!sessionId) return reply.code(400).send({ error: 'sessionId required' });

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.send({ cleaned: false, viewers: 0 });

    sessionManager.removeViewer(sessionId, viewerId);

    return reply.send({
      cleaned:  true,
      viewers:  session.viewers,
    });
  });
}

// ── Pipeline startup ──────────────────────────────────────────────────────────

async function _startPipeline(session, segmentCache) {
  const { sessionId, magnetUri, hlsPath } = session;

  // ── 1. WebTorrent ──────────────────────────────────────────────────────────
  const torrentMgr = new TorrentManager();
  session.torrentManager = torrentMgr;

  torrentMgr.on('progress', p => {
    session.lastProgress = p;
    session.events.emit('progress', p);
  });

  log(NS, `[${sessionId}] Starting WebTorrent`);
  const { internalUrl, videoFile } = await torrentMgr.start(magnetUri);
  session.internalUrl = internalUrl;
  session.videoFile   = videoFile;

  // ── 2. Codec detection ─────────────────────────────────────────────────────
  log(NS, `[${sessionId}] Detecting codecs`);
  const codecInfo = await detectCodecs(internalUrl, videoFile.name);
  session.codecInfo = codecInfo;
  session.mode      = codecInfo.mode;
  log(NS, `[${sessionId}] Codecs: mode=${codecInfo.mode} video=${codecInfo.videoCodec} audio=${codecInfo.audioCodec}`);

  // ── 3. Prepare output dir ──────────────────────────────────────────────────
  await fs.promises.mkdir(hlsPath, { recursive: true });
  segmentCache.touch(session.infoHash);

  // ── 4. Check if already fully cached ──────────────────────────────────────
  if (segmentCache.isComplete(session.infoHash)) {
    log(NS, `[${sessionId}] Serving from cache`);
    await _bootstrapFromCache(session);
    session.state = 'streaming';
    session.events.emit('stream:ready', _buildReadyPayload(session, null));
    return;
  }

  // ── 5. Start FFmpeg main pipeline ──────────────────────────────────────────
  const generator = new HlsGenerator({ label: sessionId });
  session.generator = generator;

  generator.on('ffmpeg-time', t => {
    session.mainLastTime = t;

    // Advance eviction frontier — free RAM for old pieces.
    if (codecInfo.duration && videoFile.length) {
      const bytePos = (t / codecInfo.duration) * videoFile.length;
      torrentMgr.evictBefore(bytePos);
    }

    // Clean up expired seek workers.
    session.seekWorkerMgr?.cleanupExpired(t);
  });

  // Start FFmpeg (background — non-blocking).
  generator.start(internalUrl, videoFile.name, hlsPath, codecInfo).catch(e => {
    if (session.state !== 'stopped' && session.state !== 'stopping') {
      warn(NS, `[${sessionId}] FFmpeg exited: ${e.message}`);
    }
  });

  // ── 6. Wait for init.mp4 ──────────────────────────────────────────────────
  log(NS, `[${sessionId}] Waiting for init.mp4`);
  await _waitForFile(path.join(hlsPath, 'init.mp4'), 60_000);

  // Read actual video timescale from init segment.
  const timescale = await readInitTimescale(path.join(hlsPath, 'init.mp4'));
  session.videoTimescale = timescale ?? 90000;
  log(NS, `[${sessionId}] Video timescale: ${session.videoTimescale}`);

  // ── 7. Start segment watcher ───────────────────────────────────────────────
  const stopWatcher = _watchMainHlsDir(session);
  session._stopWatcher = stopWatcher;

  // ── 8. Set up seek worker manager ─────────────────────────────────────────
  session.seekWorkerMgr = new SeekWorkerManager(session);

  // ── 9. Wait for first segment ─────────────────────────────────────────────
  log(NS, `[${sessionId}] Waiting for first segment`);
  await _waitForFirstSegment(session, FIRST_SEG_TIMEOUT_MS);

  // ── 10. Emit stream:ready ──────────────────────────────────────────────────
  session.state = 'streaming';
  const payload = _buildReadyPayload(session, null);
  log(NS, `[${sessionId}] Stream ready mimeType=${payload.mimeType}`);
  session.events.emit('stream:ready', payload);
}

// ── Segment watcher ───────────────────────────────────────────────────────────

function _watchMainHlsDir(session) {
  const { hlsPath, timeline, videoTimescale } = session;
  const seen = new Set();
  const POLL_MS = 200;

  const poll = async () => {
    let files;
    try { files = fs.readdirSync(hlsPath); } catch { return; }

    for (const file of files) {
      if (!file.endsWith('.m4s') || seen.has(file)) continue;
      seen.add(file);

      // Small delay to let FFmpeg finish writing.
      setTimeout(() => _processMainSegment(session, path.join(hlsPath, file), file), 120);
    }
  };

  const timer = setInterval(poll, POLL_MS);
  poll();

  return () => clearInterval(timer);
}

async function _processMainSegment(session, filePath, filename) {
  // readSegmentTiming already imported at top
  const timescale = session.videoTimescale ?? 90000;

  let timing = null;
  for (let i = 0; i < 5; i++) {
    timing = await readSegmentTiming(filePath, timescale);
    if (timing) break;
    await sleep(80);
  }

  if (!timing) {
    warn('watcher', `Could not parse TFDT from ${filename}`);
    return;
  }

  const entry = session.timeline.register({
    file:      filename,
    startTime: timing.startTime,
    endTime:   timing.endTime,
    source:    'main',
  });

  session.events.emit('segment:ready', toSegmentPayload(entry));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildReadyPayload(session, viewerId) {
  return {
    streamUrl:      `/stream/${session.sessionId}/master.m3u8`,
    feedUrl:        `/torrent/feed/${session.sessionId}`,
    initUrl:        `/stream/${session.sessionId}/init.mp4`,
    mimeType:       session.mimeType ?? 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
    duration:       session.codecInfo?.duration ?? null,
    videoTimescale: session.videoTimescale ?? 90000,
    viewerId,
  };
}

async function _bootstrapFromCache(session) {
  const { hlsPath, timeline, videoTimescale } = session;
  const timescale = videoTimescale ?? 90000;
  // readSegmentTiming already imported at top

  let files;
  try { files = fs.readdirSync(hlsPath); } catch { return; }

  const segFiles = files.filter(f => f.endsWith('.m4s')).sort();
  for (const file of segFiles) {
    const timing = await readSegmentTiming(path.join(hlsPath, file), timescale);
    if (timing) {
      timeline.register({ file, startTime: timing.startTime, endTime: timing.endTime, source: 'cache' });
    }
  }

  // Try to get timescale from init.
  const ts = await readInitTimescale(path.join(hlsPath, 'init.mp4'));
  if (ts) session.videoTimescale = ts;

  // Try to get duration from playlist.
  try {
    const playlist = fs.readFileSync(path.join(hlsPath, 'master.m3u8'), 'utf8');
    const durationTag = /^#EXT-X-TORRENT-DURATION:([\d.]+)/m.exec(playlist);
    if (durationTag && !session.codecInfo) {
      session.codecInfo = { duration: parseFloat(durationTag[1]) };
    }
  } catch {}
}

function _segmentExistsOnDisk(hlsPath, file) {
  try { return fs.statSync(path.join(hlsPath, file)).size > 0; } catch { return false; }
}

function _waitForFile(filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fs.existsSync(filePath)) { resolve(); return; }
      if (Date.now() >= deadline)  { reject(new Error(`Timeout waiting for ${filePath}`)); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function _waitForFirstSegment(session, timeoutMs) {
  if (session.timeline.count() > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for first segment')), timeoutMs);
    session.events.once('segment:ready', () => { clearTimeout(timer); resolve(); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
