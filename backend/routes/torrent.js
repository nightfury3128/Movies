/**
 * routes/torrent.js
 *
 * Fastify plugin that handles the torrent lifecycle API:
 *
 *   POST /torrent/start   — add a magnet link, begin downloading + transcoding
 *   GET  /torrent/status  — poll progress and state (all sessions or one)
 *   POST /torrent/stop    — decrement viewer count; optionally tear down session
 *
 * MULTI-USER DESIGN:
 * The routes are thin — all real work happens in TorrentManager, HlsGenerator,
 * and SessionManager. Each unique torrent (identified by infoHash) gets exactly
 * one session. If a second user sends the same magnet link, they join the
 * existing session (incrementing the viewer count) rather than starting a second
 * download. This is the key change from the single-user PoC.
 *
 * SESSION LIFECYCLE (POST /start):
 *   1. Extract infoHash from magnet.
 *   2. If session exists and is ready → addViewer() and return join response.
 *   3. Otherwise:
 *      a. sessionManager.create() → allocates session record
 *      b. TorrentManager.start()  → begins download, returns internalUrl
 *      c. detectCodecs()          → ffprobe to decide remux vs transcode
 *      d. HlsGenerator.start()    → fires FFmpeg (NOT awaited)
 *      e. Wire 'ffmpeg-time' event → drives EvictingMemoryStore.evictBefore()
 *      f. waitForPlaylist()       → poll until master.m3u8 is non-empty
 *      g. addViewer() and return streaming response
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { TorrentManager } from '../torrent/manager.js';
import { HlsGenerator } from '../hls/generator.js';
import { SessionManager, extractInfoHash } from '../session/manager.js';
import { detectCodecs } from '../hls/codec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache');

export default async function torrentRoutes(fastify, opts) {
  // opts.sessionManager is injected by server.js
  const { sessionManager } = opts;

  // ─── POST /torrent/start ────────────────────────────────────────────────────
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
    const magnet = request.body.magnet.trim();

    // ── Step 1: validate magnet URI ──────────────────────────────────────────
    const infoHash = extractInfoHash(magnet);
    if (!infoHash) {
      return reply.code(400).send({ error: 'Invalid magnet URI — could not extract infoHash' });
    }

    // ── Step 2: create new session (one per request, per user) ──────────────
    // Sessions are keyed by sessionId (timestamp), NOT by infoHash.
    // Every /start call gets its own WebTorrent client + FFmpeg process.
    // This prevents the shared rolling-window 404 bug where two users sharing
    // one session caused FFmpeg to delete segments the lagging user still needed.
    const session = sessionManager.create(magnet);
    session.torrentManager = new TorrentManager();
    session.generator      = new HlsGenerator();

    // Ensure the HLS output directory exists before FFmpeg tries to write to it.
    fs.mkdirSync(session.hlsPath, { recursive: true });

    // ── Step 4: start torrent download ───────────────────────────────────────
    let internalUrl, videoFile;
    try {
      ({ internalUrl, videoFile } = await session.torrentManager.start(magnet));
    } catch (err) {
      console.error('[route] TorrentManager.start() failed:', err.message);
      await sessionManager.destroy(session.sessionId);
      return reply.code(500).send({ error: `Torrent start failed: ${err.message}` });
    }

    session.videoFile    = videoFile;
    session.internalUrl  = internalUrl;

    // ── Step 5: probe codecs ─────────────────────────────────────────────────
    // Build the same format hint that generator.js would use so ffprobe can
    // parse the stream format quickly without reading large amounts of data.
    const ext     = path.extname(videoFile.name).toLowerCase();
    const fmtHint = {
      '.mkv':  'matroska',
      '.avi':  'avi',
      '.mov':  'mov',
      '.mp4':  'mp4',
      '.webm': 'webm',
      '.m4v':  'mp4',
    }[ext] ?? null;

    const probeInputOpts = fmtHint ? ['-f', fmtHint] : [];

    try {
      session.codecInfo = await detectCodecs(internalUrl, probeInputOpts);
    } catch (err) {
      console.error('[route] detectCodecs() failed:', err.message);
      await sessionManager.destroy(session.sessionId);
      return reply.code(500).send({ error: `Codec detection failed: ${err.message}` });
    }

    session.mode  = session.codecInfo.mode;
    session.state = 'ready';

    // ── Step 6: start FFmpeg (fire-and-forget) ───────────────────────────────
    // We don't await this — it runs for the duration of the movie.
    // Errors are logged and the session state is set to 'error'; the cleanup
    // timer will eventually destroy it.
    session.generator
      .start(internalUrl, videoFile.name, session.hlsPath, session.codecInfo)
      .catch((err) => {
        console.error('[route] FFmpeg error:', err.message);
        session.state = 'error';
      });

    // ── Step 7: wire FFmpeg time progress → EvictingMemoryStore eviction ─────
    // 'ffmpeg-time' fires every second (approximately) with the current stream
    // position in seconds. We convert that to a byte offset and tell the store
    // to free everything more than 20 MB behind.
    //
    // WHY HERE AND NOT INSIDE THE GENERATOR?
    // The generator doesn't know about the store — it only knows about FFmpeg.
    // Keeping eviction wiring in the route layer preserves the separation:
    //   generator → emits 'ffmpeg-time'
    //   route     → converts seconds→bytes → calls store.evictBefore()
    session.generator.on('ffmpeg-time', (secs) => {
      if (session.codecInfo?.duration && session.videoFile?.length) {
        const bytePos = (secs / session.codecInfo.duration) * session.videoFile.length;
        session.torrentManager.store?.evictBefore(Math.max(0, bytePos - 20 * 1024 * 1024));
      }
    });

    // ── Step 8: wait for first playlist ─────────────────────────────────────
    // FFmpeg creates master.m3u8 immediately at startup (0 bytes). We wait
    // until it's non-empty, which means at least one segment has been written.
    // Responding before the playlist is populated causes HLS.js to get an
    // empty playlist and immediately report a fatal manifest error.
    try {
      await Promise.race([
        waitForPlaylist(session.hlsPath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for HLS playlist')), 3 * 60_000)
        ),
      ]);
    } catch (err) {
      console.error('[route] waitForPlaylist() timed out:', err.message);
      await sessionManager.destroy(session.sessionId);
      return reply.code(500).send({ error: err.message });
    }

    // ── Step 9: register viewer and respond ──────────────────────────────────
    sessionManager.addViewer(session.sessionId);
    session.state = 'streaming';

    return reply.send({
      status:    'streaming',
      sessionId: session.sessionId,
      streamUrl: `/stream/${session.sessionId}/master.m3u8`,
      videoFile: videoFile.name,
      videoSize: videoFile.length,
      mode:      session.mode,
      viewers:   session.viewers,
      hint:      'Open streamUrl in VLC or load with HLS.js',
    });
  });

  // ─── GET /torrent/status ─────────────────────────────────────────────────────
  // No query param: return all active sessions.
  // ?sessionId=X: return one session.
  fastify.get('/status', async (request, reply) => {
    const { sessionId } = request.query;

    if (sessionId) {
      const session = sessionManager.getBySessionId(sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return reply.send(buildSessionStatus(session));
    }

    // Return all sessions as an array.
    const all = sessionManager.all().map(buildSessionStatus);
    return reply.send(all);
  });

  // ─── POST /torrent/stop ──────────────────────────────────────────────────────
  // Decrements the viewer count. Destroys the session immediately if
  // `clean === 'true'` or if the viewer count would reach 0.
  fastify.post('/stop', async (request, reply) => {
    const sessionId = request.body?.sessionId ?? request.query?.sessionId;
    const clean     = request.body?.clean     ?? request.query?.clean;

    if (!sessionId) {
      return reply.code(400).send({ error: 'sessionId required' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    sessionManager.removeViewer(session.sessionId);
    const afterViewers = sessionManager.get(session.sessionId)?.viewers ?? 0;

    const shouldDestroy = (clean === 'true' || clean === true) || afterViewers <= 0;
    let didClean = false;

    if (shouldDestroy) {
      await sessionManager.destroy(session.sessionId);
      didClean = true;
    }

    return reply.send({ status: 'stopped', sessionId, cleaned: didClean });
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Resolves once master.m3u8 is non-empty (i.e. FFmpeg has written the
 * playlist header + at least one segment entry). Polls every 500 ms.
 *
 * Waiting for a non-empty playlist rather than just a segment file is important:
 * FFmpeg creates the .m3u8 file immediately at startup (0 bytes) and only
 * fills it after the first segment is finalised. If we return as soon as a
 * segment file appears, the browser may receive an empty playlist and error.
 *
 * @param {string} hlsDir
 * @returns {Promise<void>}
 */
function waitForPlaylist(hlsDir) {
  const playlist = path.join(hlsDir, 'master.m3u8');
  return new Promise((resolve) => {
    const check = () => {
      try {
        if (fs.existsSync(playlist) && fs.statSync(playlist).size > 0) {
          resolve();
          return;
        }
      } catch { /* dir may not exist yet — FFmpeg is still starting */ }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Build a status snapshot suitable for sending to the client.
 * Reads live stats from the TorrentManager and counts HLS segments on disk.
 *
 * @param {object} session
 * @returns {object}
 */
function buildSessionStatus(session) {
  const torrentStatus = session.torrentManager?.status() ?? {};

  let hlsSegments = 0;
  try {
    const files = fs.readdirSync(session.hlsPath);
    // Count .m4s segments (fMP4 HLS)
    hlsSegments = files.filter(f => f.endsWith('.m4s')).length;
  } catch { /* hlsPath may not exist yet */ }

  return {
    sessionId:    session.sessionId,
    infoHash:     session.infoHash,
    state:        session.state,
    mode:         session.mode,
    viewers:      session.viewers,
    streamUrl:    `/stream/${session.sessionId}/master.m3u8`,

    // Torrent download progress
    name:          torrentStatus.name          ?? null,
    downloaded:    torrentStatus.downloaded    ?? 0,
    total:         torrentStatus.total         ?? 0,
    progress:      torrentStatus.progress      ?? 0,
    downloadSpeed: torrentStatus.downloadSpeed ?? 0,
    numPeers:      torrentStatus.numPeers      ?? 0,

    // Resource usage
    hlsSegments,
    memoryUsedMB: torrentStatus.memoryUsedMB  ?? 0,
  };
}
