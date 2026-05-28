/**
 * routes/stream.js
 *
 * Serves HLS playlist and segment files from session-scoped cache directories.
 *
 * WHY A DEDICATED ROUTE INSTEAD OF @fastify/static ALONE?
 * Static plugins serve files with a fixed root. Our HLS output lives in
 * session-scoped subdirectories (cache/hls/<sessionId>/). Rather than expose
 * the entire cache dir we use a route that:
 *   1. Validates the sessionId via SessionManager (no path-traversal risk).
 *   2. Calls sessionManager.touch() to reset the idle-cleanup timer.
 *   3. Applies correct MIME types for both legacy .ts AND modern .m4s / init.mp4.
 *
 * CORS headers are required because HLS.js runs in the browser and makes
 * XHR/fetch requests to localhost. Without CORS the browser blocks them.
 *
 * fMP4 HLS MIME TYPES:
 *   - init.mp4  → video/mp4   (initialization segment)
 *   - *.m4s     → video/mp4   (media segments)
 *   - master.m3u8 → application/vnd.apple.mpegurl
 *
 * CACHE STRATEGY:
 *   - Playlists (.m3u8): no-cache, no-store — HLS.js re-requests every few seconds.
 *   - Segments (.m4s, init.mp4): public, max-age=3600 — immutable once written.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache');

export default async function streamRoutes(fastify, opts) {
  // opts.sessionManager is injected by server.js
  const { sessionManager } = opts;

  // ─── GET /stream/:sessionId/:filename ──────────────────────────────────────
  // Serves master.m3u8, init.mp4, and segment_XXXXX.m4s for a given session.
  fastify.get('/:sessionId/:filename', async (request, reply) => {
    const { sessionId, filename } = request.params;

    // Basic path traversal guard: reject anything with ".." or absolute paths.
    if (filename.includes('..') || path.isAbsolute(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    // Look up the session so we can validate the sessionId exists and update
    // the idle-cleanup timer on every segment request.
    if (sessionManager) {
      const session = sessionManager.getBySessionId(sessionId);
      if (session) {
        // Reset the idle timer — a viewer is actively fetching segments.
        sessionManager.touch(session.sessionId);
      }
    }

    const filePath = path.join(CACHE_DIR, 'hls', sessionId, filename);

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'Segment not found yet — try again in a moment' });
    }

    const ext = path.extname(filename).toLowerCase();
    const base = path.basename(filename).toLowerCase();

    // ── MIME type resolution ────────────────────────────────────────────────
    // .m3u8   → HLS playlist
    // .m4s    → fMP4 media segment
    // init.mp4 or *.mp4 → fMP4 initialization segment
    // .ts     → legacy MPEG-TS segment (kept for backward-compat)
    let mime;
    if (ext === '.m3u8') {
      mime = 'application/vnd.apple.mpegurl';
    } else if (ext === '.m4s') {
      mime = 'video/mp4';
    } else if (ext === '.mp4' || base === 'init.mp4') {
      mime = 'video/mp4';
    } else if (ext === '.ts') {
      mime = 'video/mp2t';
    } else {
      mime = 'application/octet-stream';
    }

    // ── Cache-Control ───────────────────────────────────────────────────────
    // Playlists are rewritten by FFmpeg every segment interval (~4 s).
    // Segments and the init file are immutable once written.
    const cacheControl = ext === '.m3u8'
      ? 'no-cache, no-store'
      : 'public, max-age=3600';

    reply.header('Content-Type', mime);
    reply.header('Cache-Control', cacheControl);
    reply.header('Access-Control-Allow-Origin', '*');

    // Segments are complete files by the time they appear in the playlist,
    // so Content-Length is always accurate. HLS.js uses it to detect stalled
    // downloads and to report accurate progress during fragment loading.
    const { size } = fs.statSync(filePath);
    reply.header('Content-Length', size);

    return reply.send(createReadStream(filePath));
  });

  // ─── GET /stream/:sessionId ───────────────────────────────────────────────
  // Convenience redirect: /stream/<sessionId> → /stream/<sessionId>/master.m3u8
  fastify.get('/:sessionId', async (request, reply) => {
    return reply.redirect(`/stream/${request.params.sessionId}/master.m3u8`);
  });
}
