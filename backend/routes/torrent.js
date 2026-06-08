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
// Large-seek promotion: pause main encoder and let seek worker race ahead.
const SEEK_PROMOTE_THRESHOLD_S = 30;
const DebugLevel = Object.freeze({ OFF: 0, NORMAL: 1, VERBOSE: 2 });
const SSE_BATCH_MS = 500;
const MAX_TRACE_QUEUE = 5000;

function _segmentOwner(session, entryOrFile) {
  const file = typeof entryOrFile === 'string' ? entryOrFile : entryOrFile?.file;
  const entry = typeof entryOrFile === 'object' ? entryOrFile : session.timeline?.findByFile?.(file);
  const owner = file ? session._generationOwnership?.get(file) : null;
  return {
    generation: owner?.generation ?? entry?.generation ?? (entry?.source === 'main' ? 0 : null),
    workerId: owner?.workerId ?? entry?.workerId ?? (entry?.source === 'main' ? 'main' : null),
    seekEpoch: owner?.seekEpoch ?? entry?.seekEpoch ?? null,
    source: owner?.source ?? entry?.source ?? null,
    createdAt: owner?.createdAt ?? entry?.createdAt ?? null,
  };
}

function _ownedSegmentPayload(session, entry) {
  if (!entry) return null;
  const owner = _segmentOwner(session, entry);
  return {
    ...toSegmentPayload(entry),
    source: owner.source ?? entry.source,
    generation: owner.generation,
    workerId: owner.workerId,
    seekEpoch: owner.seekEpoch,
    createdAt: owner.createdAt,
  };
}

function _debugLevelFromReq(req) {
  const raw = Number(req.query?.debugLevel ?? DebugLevel.NORMAL);
  return Number.isFinite(raw) ? Math.max(DebugLevel.OFF, Math.min(DebugLevel.VERBOSE, raw)) : DebugLevel.NORMAL;
}

function _traceLevel(phase = '') {
  if (/fatal|error|failed|failure|hard_timeout|adaptive_timeout/i.test(phase)) return DebugLevel.OFF;
  if (/^track_timeline\./i.test(phase)) return DebugLevel.NORMAL;
  if (/seek\.root\.|seek\.worker_spawn\.|seek\.decode_point\.|seek\.worker_start\.rejected|seek\.ffmpeg\.command_audit|ffmpeg\.timestamp_warning|seek\.init\.track_info|seek\.first5\.|seek\.segment0\.|seek\.rebase\.trace|seek\.first_divergence\.detected|seek\.av_root_cause\.report|tfdt\.normalization\.|torrent\.priority_source|preroll\.rejected_too_far_from_target|request|started|worker_started|spawned|end$|ready$|done$|segment\.promoted|timeline\.inserted|seek\.summary|seek\.success|stream_ready|stalled|resumed|segment\.|cache\.ownership_audit|timeline\.insert|SEGMENT_OWNERSHIP_VIOLATION|seek\.epoch_created/i.test(phase)) {
    return DebugLevel.NORMAL;
  }
  if (/progress|stderr|piece_gate\.progress|download_rate|bytes_sent|file_modified|file_created|tfdt|timeline|seek_byte|cluster|dir\.|proof\.parsed|proof\.generated/i.test(phase)) {
    return DebugLevel.VERBOSE;
  }
  return DebugLevel.NORMAL;
}

function _createSseWriter(reply, debugLevel) {
  const queue = [];
  let timer = null;

  const sendRaw = (event, data) => {
    try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const events = queue.splice(0, queue.length);
    sendRaw('event_batch', { type: 'event_batch', events });
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(flush, SSE_BATCH_MS);
  };

  const sendBatched = (event, data) => {
    const level = event === 'server:trace' ? _traceLevel(data?.phase) : DebugLevel.NORMAL;
    if (level > debugLevel) return;
    if (queue.length > MAX_TRACE_QUEUE && level >= DebugLevel.VERBOSE) return;
    queue.push({ event, level, data });
    schedule();
  };

  const close = () => {
    if (timer) clearTimeout(timer);
    flush();
  };

  return { sendRaw, sendBatched, close };
}

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

    const sse = _createSseWriter(reply, _debugLevelFromReq(req));
    const send = sse.sendRaw;

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
    if (session.lastProgress) sse.sendBatched('progress', session.lastProgress);

    const onProgress = p  => sse.sendBatched('progress', p);
    const onTrace    = d  => sse.sendBatched('server:trace', d);
    const onReady    = d  => {
      sse.close();
      const viewerId = sessionManager.addViewer(session.sessionId);
      send('stream:ready', { ...d, viewerId });
      cleanup();
      reply.raw.end();
    };
    const onError    = e  => { send('error', e); cleanup(); reply.raw.end(); };

    session.events.on('progress',     onProgress);
    session.events.on('server:trace', onTrace);
    session.events.once('stream:ready', onReady);
    session.events.once('error',        onError);

    const cleanup = () => {
      session.events.off('progress',      onProgress);
      session.events.off('server:trace',  onTrace);
      session.events.off('stream:ready',  onReady);
      session.events.off('error',         onError);
      sse.close();
    };
    req.raw.on('close', cleanup);

    return new Promise(r => req.raw.on('close', r));
  });

  // ── GET /torrent/feed/:sessionId ──────────────────────────────────────────
  // Persistent SSE for new segment:ready events.
  // Only the first 60 s of segments are replayed on connect so the player can
  // start immediately without flooding the client. Segments beyond that window
  // are served on-demand via GET /torrent/timeline (windowed) and
  // GET /torrent/covering (seek / gap-fill).
  fastify.get('/feed/:sessionId', async (req, reply) => {
    const session = sessionManager.getBySessionId(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sse = _createSseWriter(reply, _debugLevelFromReq(req));
    const send = sse.sendRaw;

    // Hot-window replay: only segments starting in the first 60 s so the player
    // can begin buffering without blocking the event loop with thousands of events.
    // The client fetches the rest on-demand via /torrent/timeline and /torrent/covering.
    const HOT_WINDOW_SEC = 60;
    for (const entry of session.timeline.getAll()) {
      if (entry.startTime < HOT_WINDOW_SEC) send('segment:ready', _ownedSegmentPayload(session, entry));
    }

    // Send duration immediately if already known.
    const knownDuration = session.codecInfo?.duration ?? session._estDuration ?? null;
    if (knownDuration) send('duration:ready', { duration: knownDuration });

    const onSegment  = d => send('segment:ready', d);
    const onDuration = d => send('duration:ready', d);
    const onTrace    = d => sse.sendBatched('server:trace', d);
    session.events.on('segment:ready',  onSegment);
    session.events.on('duration:ready', onDuration);
    session.events.on('server:trace',   onTrace);

    const cleanup = () => {
      session.events.off('segment:ready',  onSegment);
      session.events.off('duration:ready', onDuration);
      session.events.off('server:trace',   onTrace);
      sse.close();
    };
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
      duration:      session.codecInfo?.duration ?? session._estDuration ?? null,
      mainLastTime:  session.mainLastTime,
      timelineCount: session.timeline.count(),
      clusterCount:  session.timeline.clusterCount?.() ?? 0,
      seekWorkers:   session.seekWorkerMgr?.getWorkerStats() ?? [],
      pieces:        stats.pieces ?? null,
      ramBytes:      stats.ramBytes ?? null,
      viewers:       session.viewers,
    });
  });

  // ── GET /torrent/timeline ─────────────────────────────────────────────────
  // Returns segments in a time window: [after - 2, after + window].
  // Defaults: after=0, window=120. The -2 s overlap avoids missing a segment
  // that starts just before the requested position.
  fastify.get('/timeline', async (req, reply) => {
    const session = sessionManager.getBySessionId(req.query.sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const after  = req.query.after  != null ? parseFloat(req.query.after)  : 0;
    const window = req.query.window != null ? parseFloat(req.query.window) : 120;
    const from   = after - 2;
    const to     = after + window;

	    const entries = session.timeline.getAll()
	      .filter(e => e.startTime >= from && e.startTime <= to)
	      .map(e => _ownedSegmentPayload(session, e));

    return reply.send(entries);
  });

  // ── GET /torrent/covering ─────────────────────────────────────────────────
  // Long-poll: waits up to `wait` ms for a segment covering `time` or
  // extending `after` (bufferedEnd). Returns {segment} or {segment: null}.
  fastify.get('/covering', async (req, reply) => {
    const { sessionId, time, after, wait = '8000' } = req.query;
    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const waitMs = Math.min(parseInt(wait, 10) || 8000, 30_000);
    const startedAt = Date.now();
    _trace(session, 'route.covering.start', {
      time: time != null ? parseFloat(time) : null,
      after: after != null ? parseFloat(after) : null,
      waitMs,
    });

    let entry = null;
    if (time != null) {
      const t = parseFloat(time);
      entry = await session.timeline.waitForTime(t, waitMs);
      // Discard stale timeline entries (loaded from a previous run) whose file
      // no longer exists on disk.
      if (entry && !_segmentExistsOnDisk(session.hlsPath, entry.file)) entry = null;
      _trace(session, entry ? 'route.covering.timeline_hit' : 'route.covering.timeline_miss', {
        time: t,
        waitMs,
        elapsedMs: Date.now() - startedAt,
        segment: entry ? _ownedSegmentPayload(session, entry) : null,
      });

      // If no segment found and no seek worker is still running for this target,
      // respawn one. The original worker may have exhausted its retries before
      // prioritizeRange had time to pull the pieces — a fresh attempt after a
      // cooldown succeeds once the pieces arrive.
      if (!entry && session.seekWorkerMgr && session.state === 'streaming') {
        const hasActive = session.seekWorkerMgr.getWorkerStats()
          .some(w => Math.abs(w.seekTime - t) < 1 && w.state === 'running');
        _trace(session, 'route.covering.respawn_check', {
          time: t,
          hasActive,
          workers: session.seekWorkerMgr.getWorkerStats(),
        });
        if (!hasActive) {
          const last       = session._lastSeekSpawn;
          const COOLDOWN   = 12_000;
          if (!last || Math.abs(last.time - t) > 1 || Date.now() - last.at >= COOLDOWN) {
            session._lastSeekSpawn = { time: t, at: Date.now() };
            const decodePoint = await _resolveSafeDecodePoint(session, t);
            if (!decodePoint) {
              _trace(session, 'route.covering.respawn_skipped', {
                time: t,
                reason: 'SEEK_DECODE_POINT_NOT_FOUND',
              });
              return reply.send({ segment: null, code: 'SEEK_DECODE_POINT_NOT_FOUND' });
            }
            _trace(session, 'route.covering.respawn_start', {
              time: t,
              decodePoint,
              cooldownMs: COOLDOWN,
            });
            session.seekWorkerMgr.startWorker(t, decodePoint).catch(() => {});
            log(NS, `covering: respawned seek worker t=${t.toFixed(1)}s`);
            entry = await session.timeline.waitForTime(t, 12_000);
            if (entry && !_segmentExistsOnDisk(session.hlsPath, entry.file)) entry = null;
            _trace(session, entry ? 'route.covering.respawn_hit' : 'route.covering.respawn_timeout', {
              time: t,
              elapsedMs: Date.now() - startedAt,
              segment: entry ? _ownedSegmentPayload(session, entry) : null,
            });
          } else {
            _trace(session, 'route.covering.respawn_cooldown', {
              time: t,
              cooldownMs: COOLDOWN,
              last,
            });
          }
        }
      }
    } else if (after != null) {
      const bufferedEnd = parseFloat(after);
      entry = await session.timeline.waitForNextAfter(bufferedEnd, waitMs);
      if (entry && !_segmentExistsOnDisk(session.hlsPath, entry.file)) entry = null;
      _trace(session, entry ? 'route.covering.after_hit' : 'route.covering.after_timeout', {
        after: bufferedEnd,
        waitMs,
        elapsedMs: Date.now() - startedAt,
        segment: entry ? _ownedSegmentPayload(session, entry) : null,
      });
    }

    _trace(session, entry ? 'route.covering.response.segment' : 'route.covering.response.empty', {
      elapsedMs: Date.now() - startedAt,
      segment: entry ? _ownedSegmentPayload(session, entry) : null,
    });
    return reply.send({ segment: _ownedSegmentPayload(session, entry) });
  });

  // ── POST /torrent/seek ────────────────────────────────────────────────────
  fastify.post('/seek', async (req, reply) => {
    const { sessionId, seekTime: seekTimeRaw, currentPlaybackTime: currentPlaybackTimeRaw, seekEpoch: clientSeekEpochRaw } = req.body ?? {};
    const seekTime = parseFloat(seekTimeRaw);
    const currentPlaybackTime = parseFloat(currentPlaybackTimeRaw);
    const clientSeekEpoch = Number.isFinite(Number(clientSeekEpochRaw)) ? Number(clientSeekEpochRaw) : null;

    if (!sessionId || !isFinite(seekTime)) {
      return reply.code(400).send({ error: 'sessionId and seekTime required' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);
    const requestStartedAt = Date.now();
    const seekEpoch = (session._seekEpoch = (session._seekEpoch ?? 0) + 1);
    _trace(session, 'seek.epoch_created', {
      seekEpoch,
      seekTime,
      generation: session.seekWorkerMgr?._seekGeneration ?? 0,
      clientSeekEpoch,
    });
    _trace(session, 'route.seek.request', {
      seekTime,
      seekEpoch,
      currentPlaybackTime: isFinite(currentPlaybackTime) ? currentPlaybackTime : null,
      mainLastTime: session.mainLastTime,
      state: session.state,
      mode: session.mode,
      timelineCount: session.timeline.count(),
    });

    // Case 1: Segment already covers seekTime — serve immediately.
    const covering = session.timeline.findSeekTargetSegment(seekTime);
    const onDisk   = covering && _segmentExistsOnDisk(session.hlsPath, covering.file);
    if (onDisk) {
      log(NS, `seek ${seekTime}s → cached (${covering.file})`);
      const owner = _segmentOwner(session, covering);
      const cacheAccepted = owner.generation == null || owner.generation === (session.seekWorkerMgr?._seekGeneration ?? 0);
      _trace(session, 'segment.cache_hit', {
        segment: covering.file,
        cacheKey: session.infoHash,
        ...owner,
        currentGeneration: session.seekWorkerMgr?._seekGeneration ?? 0,
        accepted: cacheAccepted,
      });
      _trace(session, 'route.seek.cached', {
        seekTime,
        seekEpoch,
        elapsedMs: Date.now() - requestStartedAt,
        segment: _ownedSegmentPayload(session, covering),
      });
      return reply.send({ action: 'cached', ..._ownedSegmentPayload(session, covering) });
    }

    // Case 2: Main encoder is close enough — wait for it.
    // remux runs at ~100x so it catches up quickly; transcode is ~1x, start a worker sooner.
    // Only applies when the main encoder is still running; after a large seek it may have
    // been stopped and its lastTime is stale.
    const mainTime    = session.mainLastTime ?? 0;
    const mainRunning = !!session.generator?.running;
    const waitThreshold = session.mode === 'remux' ? 60 : 8;
    if (mainRunning && seekTime <= mainTime + waitThreshold) {
      log(NS, `seek ${seekTime}s → waiting (mainTime=${mainTime.toFixed(1)}s mode=${session.mode})`);
      const seekOffset = Math.max(0, seekTime - 2);
      const timelineEnd = session.timeline.latestTime?.() ?? 0;
      _trace(session, 'seek.worker_spawn.no_worker_path', {
        requestedSeekTime: seekTime,
        currentPlaybackTime: isFinite(currentPlaybackTime) ? currentPlaybackTime : null,
        mainLastTime: mainTime,
        timelineEnd,
        seekByte: null,
        seekOffset,
        decodePoint: null,
        workerStartTime: null,
        workerStartByte: null,
        workerStartOffset: null,
        source: 'mainLastTime',
        reason: 'wait_main_encoder',
      });
      _trace(session, 'seek.worker_spawn.report', {
        requestedSeekTime: seekTime,
        workerStartTime: null,
        deltaSeconds: null,
        segmentsGenerated: 0,
        segmentsPromoted: 0,
        coveringSegmentFound: false,
        result: 'NO_WORKER_WAIT_MAIN',
        rootCauseCandidate: 'NO_WORKER_CREATED_WAIT_MAIN',
      });
      _trace(session, 'route.seek.wait_main_encoder', {
        seekTime,
        seekEpoch,
        mainTime,
        waitThreshold,
        seekOffset,
        elapsedMs: Date.now() - requestStartedAt,
      });
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
      _trace(session, 'route.seek.no_worker_manager', { seekTime });
      return reply.code(503).send({ error: 'Seek worker not available' });
    }

    const decodePoint = await _resolveSafeDecodePoint(session, seekTime);
    if (!decodePoint) {
      _trace(session, 'seek.decode_point.failed', {
        seekTime,
        code: 'SEEK_DECODE_POINT_NOT_FOUND',
      });
      return reply.send({
        action: 'waiting',
        code: 'SEEK_DECODE_POINT_NOT_FOUND',
        startTime: seekTime,
        endTime: seekTime,
        duration: 0,
      });
    }
    _trace(session, 'route.seek.safe_decode_point', {
      seekTime,
      decodePoint,
      clusterCount: session.timeline.clusterCount?.() ?? 0,
      fileLength: session.videoFile?.length,
    });

    // Large-seek bandwidth promotion: pause (SIGSTOP) the main encoder so WebTorrent
    // can redirect all peer bandwidth to the seek position. Pause instead of stop so
    // sequential viewers keep their feed once the seek worker finishes and the encoder
    // is resumed (SIGCONT) via SeekWorkerManager._cleanupWorker.
    if (seekTime > mainTime + SEEK_PROMOTE_THRESHOLD_S && mainRunning && !session._mainPaused) {
      log(NS, `seek: pausing main encoder (${mainTime.toFixed(1)}s → ${seekTime.toFixed(1)}s)`);
      _trace(session, 'route.seek.promote_pause_main', {
        seekTime,
        mainTime,
        thresholdSec: SEEK_PROMOTE_THRESHOLD_S,
      });
      session.generator.pause();
      session._mainPaused = true;
    }

    try {
      const timelineEnd = session.timeline.latestTime?.() ?? 0;
      const workerStartTime = typeof decodePoint === 'number'
        ? (session.mode === 'remux' ? Math.max(0, seekTime - 12) : seekTime)
        : Math.max(0, decodePoint?.startTime ?? seekTime);
      const workerStartByte = typeof decodePoint === 'number'
        ? decodePoint
        : (decodePoint?.clusterOffset ?? decodePoint?.byteOffset ?? null);
      const sourceOfTruth = typeof decodePoint === 'number'
        ? (session.mode === 'remux' ? 'byteMapping' : 'requestedSeekTime')
        : decodePoint?.startTime != null ? 'decodePoint' : 'requestedSeekTime';
      _trace(session, 'seek.worker_spawn.creation_inputs', {
        requestedSeekTime: seekTime,
        currentPlaybackTime: isFinite(currentPlaybackTime) ? currentPlaybackTime : null,
        mainLastTime: mainTime,
        timelineEnd,
        seekByte: workerStartByte,
        seekOffset: workerStartTime,
        decodePoint,
        workerStartTime,
        workerStartByte,
        workerStartOffset: workerStartTime,
      });
      _trace(session, 'seek.worker_spawn.source', {
        requestedSeekTime: seekTime,
        currentPlaybackTime: isFinite(currentPlaybackTime) ? currentPlaybackTime : null,
        mainLastTime: mainTime,
        timelineEnd,
        source: sourceOfTruth,
        decodePoint,
        workerStartTime,
        workerStartByte,
        workerStartOffset: workerStartTime,
      });
      const { startTime, endTime } = await session.seekWorkerMgr.startWorker(seekTime, decodePoint, {
        seekEpoch,
        currentPlaybackTime: isFinite(currentPlaybackTime) ? currentPlaybackTime : null,
        mainLastTime: mainTime,
        timelineEnd,
      });
      log(NS, `seek ${seekTime}s → worker started (~${startTime.toFixed(1)}s)`);
      _trace(session, 'route.seek.worker_started', {
        seekTime,
        seekEpoch,
        decodePoint,
        startTime,
        endTime,
        elapsedMs: Date.now() - requestStartedAt,
      });
      return reply.send({
        action:    'started',
        seekEpoch,
        startTime,
        endTime,
        duration:  endTime - startTime,
      });
    } catch (e) {
      warn(NS, `seek worker failed: ${e.message}`);
      _trace(session, 'route.seek.worker_start_failed', {
        seekTime,
        seekEpoch,
        decodePoint,
        message: e.message,
        elapsedMs: Date.now() - requestStartedAt,
      });
      if (e.message === 'INVALID_SEEK_WORKER_START_ZERO') {
        return reply.send({
          action: 'waiting',
          code: 'INVALID_SEEK_WORKER_START_ZERO',
          startTime: seekTime,
          endTime: seekTime,
          duration: 0,
        });
      }
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
  _trace(session, 'pipeline.start', { hlsPath });

  // ── 1. WebTorrent ──────────────────────────────────────────────────────────
  const torrentMgr = new TorrentManager();
  session.torrentManager = torrentMgr;
  torrentMgr.on('server:trace', d => _trace(session, d.phase, d));

  torrentMgr.on('progress', p => {
    session.lastProgress = p;
    session.events.emit('progress', p);
  });

  log(NS, `[${sessionId}] Starting WebTorrent`);
  _trace(session, 'pipeline.webtorrent.start');
  const { internalUrl, videoFile } = await torrentMgr.start(magnetUri);
  session.internalUrl = internalUrl;
  session.videoFile   = videoFile;
  _trace(session, 'pipeline.webtorrent.ready', {
    internalUrl,
    videoFile: {
      name: videoFile.name,
      length: videoFile.length,
      offset: videoFile.offset,
    },
  });

  // ── 2. Codec detection ─────────────────────────────────────────────────────
  log(NS, `[${sessionId}] Detecting codecs`);
  _trace(session, 'pipeline.codec.detect_start', { fileName: videoFile.name });
  const codecInfo = await detectCodecs(internalUrl, videoFile.name);
  session.codecInfo = codecInfo;
  session.mode      = codecInfo.mode;
  session.mimeType  = codecInfo.mimeType;
  log(NS, `[${sessionId}] Codecs: mode=${codecInfo.mode} video=${codecInfo.videoCodec} audio=${codecInfo.audioCodec}`);
  _trace(session, 'pipeline.codec.detect_done', codecInfo);

  // ── 3. Prepare output dir ──────────────────────────────────────────────────
  await fs.promises.mkdir(hlsPath, { recursive: true });
  segmentCache.touch(session.infoHash);
  segmentCache.evict();
  _trace(session, 'pipeline.output_ready', { hlsPath });

  // ── 4. Check if already fully cached ──────────────────────────────────────
  if (segmentCache.isComplete(session.infoHash)) {
    log(NS, `[${sessionId}] Serving from cache`);
    _trace(session, 'pipeline.cache.complete');
    await _bootstrapFromCache(session);
    session.seekWorkerMgr = new SeekWorkerManager(session);
    session._priorityInterval = setInterval(() => _rebalancePiecePriority(session), 5000);
    session.state = 'streaming';
    session.events.emit('stream:ready', _buildReadyPayload(session, null));
    _trace(session, 'pipeline.stream_ready.cache', _buildReadyPayload(session, null));
    return;
  }

  // ── 5. Start FFmpeg main pipeline ──────────────────────────────────────────
  const generator = new HlsGenerator({ label: sessionId });
  session.generator = generator;
  let lastMainTraceAt = 0;

  generator.on('ffmpeg-time', t => {
    session.mainLastTime = t;
    const now = Date.now();
    if (now - lastMainTraceAt >= 1000) {
      lastMainTraceAt = now;
      _trace(session, 'main.ffmpeg.progress', {
        seconds: t,
        timelineCount: session.timeline.count(),
      });
    }

    // Advance eviction frontier — free RAM for old pieces.
    // Use actual duration if known; otherwise estimate from first-segment bitrate.
    if (videoFile.length) {
      let dur = codecInfo.duration ?? session._estDuration ?? null;
      // Skip the first 5s to avoid low-bitrate openings (black screens, title cards)
      // skewing the bitrate estimate; require at least 4 segments past that point.
      if (!dur && t > 10 && session.timeline.count() >= 4) {
        const segs = session.timeline.getAll().filter(s => s.startTime >= 5).slice(0, 8);
        let hlsBytes = 0, hlsSecs = 0;
        for (const s of segs) {
          try {
            hlsBytes += fs.statSync(path.join(hlsPath, s.file)).size;
            hlsSecs += s.duration;
          } catch {}
        }
        if (hlsBytes > 0 && hlsSecs > 0) {
          session._estDuration = videoFile.length / (hlsBytes / hlsSecs);
          dur = session._estDuration;
          log(NS, `[${sessionId}] Estimated duration: ${dur.toFixed(0)}s`);
          // Push to all connected feed clients so they don't have to wait for the next status poll.
          session.events.emit('duration:ready', { duration: dur });
          // Persist in playlist so the cache path can serve it without re-running ffprobe.
          _writeDurationToPlaylist(path.join(hlsPath, 'master.m3u8'), dur);
        }
      }
      if (dur) {
        const fileOff = videoFile.offset ?? 0;
        torrentMgr.evictBefore(fileOff + (t / dur) * videoFile.length);
      }
    }

    // Clean up expired seek workers.
    session.seekWorkerMgr?.cleanupExpired(t);
  });

  // Start FFmpeg (background — non-blocking).
  generator.once('start', cmdLine => _trace(session, 'main.ffmpeg.spawned', { cmdLine }));
  generator.once('end', () => _trace(session, 'main.ffmpeg.end', {
    seconds: session.mainLastTime,
    timelineCount: session.timeline.count(),
  }));
  generator.start(internalUrl, videoFile.name, hlsPath, codecInfo).catch(e => {
    if (session.state !== 'stopped' && session.state !== 'stopping') {
      warn(NS, `[${sessionId}] FFmpeg exited: ${e.message}`);
      _trace(session, 'main.ffmpeg.error', { message: e.message });
    }
  });

  // ── 6. Wait for init.mp4 ──────────────────────────────────────────────────
  log(NS, `[${sessionId}] Waiting for init.mp4`);
  _trace(session, 'pipeline.wait_init_start');
  await _waitForFile(path.join(hlsPath, 'init.mp4'), 60_000, 100);
  _trace(session, 'pipeline.wait_init_done');

  // Timescale read is deferred — init.mp4 may not be fully written yet.
  // It will be read once init.mp4 exists AND parses (checked below after first segment).

  // ── 7. Start segment watcher ───────────────────────────────────────────────
  const stopWatcher = _watchMainHlsDir(session);
  session._stopWatcher = stopWatcher;
  _trace(session, 'pipeline.main_watcher_started');

  // ── 8. Set up seek worker manager + viewer-aware piece prioritization ──────
  session.seekWorkerMgr = new SeekWorkerManager(session);
  session._priorityInterval = setInterval(() => _rebalancePiecePriority(session), 5000);

  // 5-second download-rate trace fed to browser telemetry panel.
  const _dlRateTimer = setInterval(() => {
    const t   = torrentMgr.torrent;
    if (!t) return;
    const dur = session.codecInfo?.duration ?? session._estDuration;
    _trace(session, 'torrent.download_rate', {
      speed:      t.downloadSpeed,
      peers:      t.numPeers,
      progress:   +t.progress.toFixed(4),
      downloaded: t.downloaded,
      total:      t.length,
      mainByte:   dur && session.mainLastTime
        ? Math.floor((session.mainLastTime / dur) * (videoFile.length ?? 0))
        : null,
    });
  }, 5000);
  const _stopWatcherOrig = stopWatcher;
  session._stopWatcher   = () => { clearInterval(_dlRateTimer); _stopWatcherOrig(); };

  // ── 9. Wait for first segment + read timescale in parallel ───────────────
  // init.mp4 is fully written before FFmpeg closes the first segment, so both
  // are safe to run concurrently once init.mp4 exists.
  log(NS, `[${sessionId}] Waiting for first segment`);
  _trace(session, 'pipeline.wait_first_segment_start', { timeoutMs: FIRST_SEG_TIMEOUT_MS });
  const [, timescale] = await Promise.all([
    _waitForFirstSegment(session, FIRST_SEG_TIMEOUT_MS),
    readInitTimescale(path.join(hlsPath, 'init.mp4')),
  ]);
  session.videoTimescale = timescale ?? 90000;
  log(NS, `[${sessionId}] Video timescale: ${session.videoTimescale}`);
  _trace(session, 'pipeline.wait_first_segment_done', {
    videoTimescale: session.videoTimescale,
    timelineCount: session.timeline.count(),
  });

  // Re-register any already-seen segments with the correct timescale.
  if (timescale && timescale !== 90000) {
    for (const entry of session.timeline.getAll()) {
      const timing = await readSegmentTiming(path.join(hlsPath, entry.file), timescale);
      if (timing) {
        session.timeline.register({ file: entry.file, startTime: timing.startTime, endTime: timing.endTime, source: 'main' });
      }
    }
  }

  // ── 10. Emit stream:ready ──────────────────────────────────────────────────
  session.state = 'streaming';
  const payload = _buildReadyPayload(session, null);
  log(NS, `[${sessionId}] Stream ready mimeType=${payload.mimeType}`);
  session.events.emit('stream:ready', payload);
  _trace(session, 'pipeline.stream_ready', payload);
}

// ── Segment watcher ───────────────────────────────────────────────────────────

function _watchMainHlsDir(session) {
  const { hlsPath } = session;
  const seen = new Set();
  let prevSeg = null; // filename currently open in FFmpeg — not yet complete

  const processComplete = file => {
    if (!file.endsWith('.m4s') || seen.has(file)) return;
    seen.add(file);
    _trace(session, 'main.segment.complete_detected', { file });
    _processMainSegment(session, path.join(hlsPath, file), file);
  };

  // Segments already on disk at startup are complete (from a prior run).
  try { for (const f of fs.readdirSync(hlsPath)) processComplete(f); } catch {}

  // FFmpeg logs "Opening segment_N" immediately after closing segment_N-1.
  // Process N-1 (now complete) on the N open event; hold N until N+1 opens.
  const onOpen = ({ filename }) => {
    if (prevSeg) processComplete(prevSeg);
    prevSeg = filename;
    _trace(session, 'main.segment.open_current', { filename });
  };
  session.generator.on('segment-open', onOpen);

  return () => session.generator.off('segment-open', onOpen);
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
    _trace(session, 'main.segment.parse_failed', { filename });
    return;
  }

	  const entry = session.timeline.register({
    file:      filename,
    startTime: timing.startTime,
    endTime:   timing.endTime,
    source:    'main',
    segmentId: filename,
    byteOffset: _estimateFileByteForTime(session, timing.startTime),
    clusterOffset: null,
	  });
	  session._generationOwnership ??= new Map();
	  session._generationOwnership.set(filename, {
	    generation: 0,
	    workerId: 'main',
	    seekEpoch: null,
	    source: 'main',
	    createdAt: Date.now(),
	  });
	  _trace(session, 'timeline.insert', {
	    segment: filename,
	    start: +timing.startTime.toFixed(3),
	    end: +timing.endTime.toFixed(3),
	    generation: 0,
	    workerId: 'main',
	    seekEpoch: null,
	    source: 'main',
	  });
	  _trace(session, 'generation.segment_promoted', {
	    segment: filename,
	    generation: 0,
	    workerId: 'main',
	    currentActiveGeneration: session.seekWorkerMgr?._seekGeneration ?? 0,
	    accepted: true,
	  });
	  _trace(session, 'generation.timeline_insert', {
	    segment: filename,
	    generation: 0,
	    workerId: 'main',
	    timelineStart: +timing.startTime.toFixed(3),
	    timelineEnd: +timing.endTime.toFixed(3),
	    currentGeneration: session.seekWorkerMgr?._seekGeneration ?? 0,
	  });

	  session.events.emit('segment:ready', {
	    ..._ownedSegmentPayload(session, entry),
	    generation: 0,
	    workerId: 'main',
	  });
  _trace(session, 'main.segment.promoted', {
    file: filename,
    startTime: timing.startTime,
    endTime: timing.endTime,
    duration: timing.endTime - timing.startTime,
    timelineCount: session.timeline.count(),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildReadyPayload(session, viewerId) {
  return {
    streamUrl:      `/stream/${session.sessionId}/master.m3u8`,
    feedUrl:        `/torrent/feed/${session.sessionId}`,
    initUrl:        `/stream/${session.sessionId}/init.mp4`,
    mimeType:       session.mimeType ?? 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
    duration:       session.codecInfo?.duration ?? session._estDuration ?? null,
    videoTimescale: session.videoTimescale ?? 90000,
    viewerId,
  };
}

async function _resolveSafeDecodePoint(session, seekTime) {
  const MIN_PREROLL_SEC = 12;
  const MAX_KNOWN_PREROLL_SEC = 120;
  const known = session.timeline.findClusterBefore?.(seekTime, 0);
  if (known && seekTime - known.startTime <= MAX_KNOWN_PREROLL_SEC) {
    const selected = {
      requestedTime: seekTime,
      startTime: known.startTime,
      endTime: known.endTime ?? null,
      byteOffset: known.byteOffset ?? known.clusterOffset,
      clusterOffset: known.clusterOffset,
      source: known.source ?? 'timeline',
    };
    _trace(session, 'seek.decode_point.selected', { seekTime, decodePoint: selected, reason: 'timeline_hit' });
    return selected;
  }

  const duration = session.codecInfo?.duration ?? session._estDuration ?? null;
  if (session.torrentManager?.safeDecodePointForTime) {
    const discovered = await session.torrentManager.safeDecodePointForTime(seekTime, {
      duration,
      minPrerollSec: MIN_PREROLL_SEC,
    });
    if (_isUsableDecodePoint(discovered, seekTime)) {
      session.timeline.recordCluster({
        startTime: discovered.startTime,
        endTime: discovered.endTime ?? null,
        byteOffset: discovered.byteOffset ?? discovered.clusterOffset,
        clusterOffset: discovered.clusterOffset,
        source: discovered.source,
      });
      _trace(session, 'seek.decode_point.selected', { seekTime, decodePoint: discovered, reason: 'discovered' });
      return discovered;
    }
    _trace(session, 'seek.decode_point.failed', {
      seekTime,
      decodePoint: discovered ?? null,
      reason: 'discovered_point_unusable',
    });
  }

  if (seekTime > 30 && duration && session.videoFile?.length) {
    const estimatedByte = _estimateFileByteForTime(session, Math.max(0, seekTime - MIN_PREROLL_SEC));
    if (estimatedByte != null && estimatedByte > 0) {
      const estimated = {
        requestedTime: seekTime,
        startTime: Math.max(0, seekTime - MIN_PREROLL_SEC),
        endTime: null,
        byteOffset: estimatedByte,
        clusterOffset: estimatedByte,
        source: 'estimated_byte_fallback',
      };
      _trace(session, 'seek.decode_point.selected', { seekTime, decodePoint: estimated, reason: 'estimated_byte_fallback' });
      return estimated;
    }
  }

  if (seekTime <= 30) {
    const fallback = {
      requestedTime: seekTime,
      startTime: 0,
      endTime: null,
      byteOffset: 0,
      clusterOffset: 0,
      source: 'route_fallback_header',
    };
    _trace(session, 'seek.decode_point.selected', { seekTime, decodePoint: fallback, reason: 'early_seek_header_fallback' });
    return fallback;
  }

  _trace(session, 'seek.decode_point.failed', {
    seekTime,
    reason: 'SEEK_DECODE_POINT_NOT_FOUND',
    duration,
    fileLength: session.videoFile?.length ?? null,
  });
  return null;
}

function _isUsableDecodePoint(point, seekTime) {
  if (!point || point.clusterOffset == null || !isFinite(point.clusterOffset)) return false;
  const startTime = point.startTime ?? 0;
  if (seekTime > 30 && point.clusterOffset === 0 && startTime < seekTime - 120) return false;
  return true;
}

function _estimateFileByteForTime(session, time) {
  const duration = session.codecInfo?.duration ?? session._estDuration ?? null;
  if (!duration || !session.videoFile?.length || !isFinite(time)) return null;
  return Math.max(0, Math.min(session.videoFile.length - 1, Math.floor((time / duration) * session.videoFile.length)));
}

function _trace(session, phase, data = {}) {
  if (!session?.events) return;
  session.events.emit('server:trace', {
    phase,
    ns: NS,
    at: Date.now(),
    sessionId: session.sessionId,
    state: session.state,
    mode: session.mode,
    mainLastTime: session.mainLastTime,
    timelineCount: session.timeline?.count?.(),
    ...data,
  });
}

/** Inject (or update) an #EXT-X-TORRENT-DURATION tag in a playlist file. */
function _writeDurationToPlaylist(playlistPath, duration) {
  try {
    let text = fs.readFileSync(playlistPath, 'utf8');
    const tag = `#EXT-X-TORRENT-DURATION:${duration.toFixed(3)}`;
    if (text.includes('#EXT-X-TORRENT-DURATION:')) {
      text = text.replace(/^#EXT-X-TORRENT-DURATION:[\d.]+$/m, tag);
    } else {
      text = tag + '\n' + text;
    }
    fs.writeFileSync(playlistPath, text);
  } catch {}
}

async function _bootstrapFromCache(session) {
  const { hlsPath, timeline } = session;

  // Timescale from init.mp4 (small file, fine to read fully).
  const ts = await readInitTimescale(path.join(hlsPath, 'init.mp4'));
  if (ts) session.videoTimescale = ts;

  // Parse timing from the playlist — one text-file read instead of one binary
  // readFile() per segment. For a 2-hour movie this avoids ~3600 × 2 MB Buffer
  // allocations and the GC pressure they cause. EXTINF durations are derived
  // from the same TFDT data that readSegmentTiming would read, so timing is
  // equivalent (rounding error < 1 ms).
  let playlist;
  try { playlist = fs.readFileSync(path.join(hlsPath, 'master.m3u8'), 'utf8'); } catch { return; }

  const durationTag = /^#EXT-X-TORRENT-DURATION:([\d.]+)/m.exec(playlist);
  if (durationTag && !session.codecInfo) {
    session.codecInfo = { duration: parseFloat(durationTag[1]) };
  }

  const lines  = playlist.split('\n');
  let   cursor = 0;
  const batch  = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF:')) continue;
    const dur      = parseFloat(line.slice(8));
    const filename = lines[i + 1]?.trim();
    if (!filename || !filename.endsWith('.m4s')) continue;
    batch.push({ file: filename, startTime: cursor, endTime: cursor + dur, source: 'cache' });
    cursor += dur;
  }

  // Single bulk insert keeps the timeline sorted without per-entry splice cost.
  timeline.bulkRegister(batch);
  session._generationOwnership ??= new Map();
  for (const entry of batch) {
    const createdAt = Date.now();
    session._generationOwnership.set(entry.file, {
      generation: null,
      workerId: null,
      seekEpoch: null,
      source: 'cache',
      createdAt,
    });
    _trace(session, 'timeline.insert', {
      segment: entry.file,
      start: +entry.startTime.toFixed(3),
      end: +entry.endTime.toFixed(3),
      generation: null,
      workerId: null,
      seekEpoch: null,
      source: 'cache',
    });
  }
}

function _segmentExistsOnDisk(hlsPath, file) {
  try { return fs.statSync(path.join(hlsPath, file)).size > 0; } catch { return false; }
}

/**
 * Prioritize torrent pieces 30 s ahead of every known viewer position.
 * Runs every 5 s so piece priorities stay current as viewers move through content.
 */
function _rebalancePiecePriority(session) {
  if (!session.torrentManager || !session.videoFile?.length) return;
  const dur = session.codecInfo?.duration ?? session._estDuration;
  if (!dur) return;

  const activeSeek = session._activeSeek;
  const seekByte = activeSeek?.clusterOffset ?? activeSeek?.seekByte;
  if (activeSeek && seekByte != null && isFinite(seekByte)) {
    const startByte = Math.max(0, seekByte);
    const endByte = Math.min(session.videoFile.length, startByte + 100 * 1024 * 1024);
    _trace(session, 'torrent.priority_source', {
      source: 'active_pending_seek',
      priority: {
        targetTime: activeSeek.targetTime,
        seekByte: startByte,
        reason: 'active_pending_seek',
      },
      targetTime: activeSeek.targetTime,
      seekByte: startByte,
      reason: 'active_pending_seek',
      mainLastTime: session.mainLastTime ?? null,
    });
    session.torrentManager.prioritizeRange(startByte, endByte);
    return;
  }

  for (const pos of session.viewerTimes.values()) {
    const startByte = (pos / dur) * session.videoFile.length;
    const endByte   = (Math.min(pos + 30, dur) / dur) * session.videoFile.length;
    _trace(session, 'torrent.priority_source', {
      source: 'viewer_playback',
      priority: {
        targetTime: pos,
        seekByte: startByte,
        reason: 'viewer_playback',
      },
      targetTime: pos,
      seekByte: startByte,
      reason: 'viewer_playback',
      mainLastTime: session.mainLastTime ?? null,
    });
    session.torrentManager.prioritizeRange(startByte, endByte);
  }
}

function _waitForFile(filePath, timeoutMs, minBytes = 0) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (fs.statSync(filePath).size > minBytes) { resolve(); return; }
      } catch {}
      if (Date.now() >= deadline) { reject(new Error(`Timeout waiting for ${filePath}`)); return; }
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
