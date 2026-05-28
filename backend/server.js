/**
 * server.js — Main entry point
 *
 * Architecture overview (multi-user):
 *
 *   Browser / VLC  (N concurrent users)
 *       │  POST /torrent/start  →  SessionManager.create() or join existing
 *       │  GET  /stream/<sessionId>/master.m3u8 + .m4s segments
 *       ▼
 *   Fastify (port 3000)
 *       │  routes/torrent.js  — torrent lifecycle, codec detection
 *       │  routes/stream.js   — serve HLS files, update idle timer
 *       │
 *       │  One session per unique infoHash:
 *       │
 *       ▼
 *   SessionManager
 *       │  Map<sessionId, { torrentManager, generator, viewers, … }>
 *       │
 *       ├─► TorrentManager (one per session)
 *       │       │  WebTorrent client + EvictingMemoryStore (no disk writes)
 *       │       │  Internal HTTP server on port 0 (loopback only, OS-assigned)
 *       │       │  Serves the partially-downloaded video to FFmpeg via Range requests
 *       │
 *       └─► HlsGenerator (one per session)
 *               │  FFmpeg reads from TorrentManager's internal HTTP server
 *               │  Decides remux vs transcode based on codec detection
 *               │  Writes fMP4 HLS segments → cache/hls/<sessionId>/
 *               │  Emits 'ffmpeg-time' → drives EvictingMemoryStore eviction
 *
 * KEY MULTI-USER DECISIONS:
 *   - No global manager/generator singletons — they're created per session.
 *   - Sessions keyed by sessionId — every /start request gets its own session.
 *     Two users watching the same torrent each get independent download + FFmpeg.
 *   - EvictingMemoryStore keeps only a ~20 MB sliding window per download,
 *     avoiding disk I/O and bounding RAM to O(active_users × 20 MB).
 *   - Idle cleanup destroys sessions with 0 viewers after 5 minutes, freeing
 *     CPU, RAM, and disk.
 *
 * WHY FASTIFY?
 * Fastify has schema-based validation, a fast JSON serialiser, and first-class
 * async/await. For a streaming server with low overhead per request, Fastify
 * is the better default choice over Express.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { SessionManager } from './session/manager.js';
import torrentRoutes from './routes/torrent.js';
import streamRoutes from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');

// ─── Bootstrap cache directories ─────────────────────────────────────────────
// These must exist before WebTorrent or FFmpeg write anything.
// 'downloads' directory is no longer used (EvictingMemoryStore replaced disk writes)
// but we keep it for backward compatibility in case any tooling inspects it.
fs.mkdirSync(path.join(CACHE_DIR, 'downloads'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'hls'),       { recursive: true });

// ─── Session manager ──────────────────────────────────────────────────────────
// Single SessionManager instance for the process lifetime.
// All torrent/generator state lives inside it, keyed by infoHash.
const sessionManager = new SessionManager(CACHE_DIR);

// Start the idle-cleanup timer.
// Sessions with zero viewers idle for more than 5 minutes are destroyed,
// freeing RAM (EvictingMemoryStore), CPU (FFmpeg), and disk (HLS segments).
sessionManager.startCleanup(5 * 60 * 1000);

// ─── Fastify setup ────────────────────────────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
    },
  },
});

// CORS — required so HLS.js (running in browser) can fetch segments from localhost.
await fastify.register(cors, { origin: '*' });

// Serve test.html and other static assets from the backend root directory.
await fastify.register(staticPlugin, {
  root:  __dirname,
  prefix: '/',
  serve: true,
  index: false,
});

// ─── Register route plugins ───────────────────────────────────────────────────
// Pass sessionManager as a plugin option so routes don't need to import it
// directly — this makes future testing and DI easier.
await fastify.register(torrentRoutes, {
  prefix: '/torrent',
  sessionManager,
});

await fastify.register(streamRoutes, {
  prefix: '/stream',
  sessionManager,
});

// ─── Health check ─────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status:   'ok',
  time:     new Date().toISOString(),
  sessions: sessionManager.all().length,
}));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGINT (Ctrl-C) or SIGTERM, we stop every active session cleanly before
// exiting. Without this, FFmpeg processes and WebTorrent connections leak.
async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down`);

  sessionManager.stopCleanup();

  // Destroy all sessions concurrently — each destroy() is safe to call in parallel
  // because sessions don't share resources.
  const all = sessionManager.all();
  await Promise.allSettled(all.map(s => sessionManager.destroy(s.sessionId)));

  await fastify.close();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start listening ──────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: 3000, host: '0.0.0.0' });
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  Torrent→HLS multi-user server running');
  console.log('  API base    : http://localhost:3000');
  console.log('  Stream      : http://localhost:3000/stream/<sessionId>/master.m3u8');
  console.log('  Status (all): http://localhost:3000/torrent/status');
  console.log('  Test page   : http://localhost:3000/test.html');
  console.log('─────────────────────────────────────────────────────\n');
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
