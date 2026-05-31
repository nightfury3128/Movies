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
 *       │  One session per active infoHash. HLS output goes to:
 *       │    cache/segments/<infoHash>/   ← persistent across sessions
 *       │
 *       ▼
 *   SessionManager
 *       │  Map<sessionId, { torrentManager, generator, viewers, … }>
 *       │
 *       ├─► TorrentManager (one per active session, null for cached sessions)
 *       │       WebTorrent + EvictingMemoryStore + internal HTTP server
 *       │
 *       ├─► HlsGenerator (one per active session, null for cached sessions)
 *       │       FFmpeg → cache/segments/<infoHash>/
 *       │
 *       └─► SegmentCache
 *               LRU disk cache at cache/segments/.
 *               Fully transcoded torrents skip download + FFmpeg on repeat views.
 *               Evicts LRU segments when total exceeds maxBytes (default 50 GB).
 */

import './logger.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { SessionManager } from './session/manager.js';
import { SegmentCache } from './cache/segment-cache.js';
import torrentRoutes from './routes/torrent.js';
import streamRoutes from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');

// ─── Persistent segment cache ─────────────────────────────────────────────────
const segmentCache = new SegmentCache();
segmentCache.start(); // creates cache/segments/, loads lru.json

// ─── Session manager ──────────────────────────────────────────────────────────
const sessionManager = new SessionManager(CACHE_DIR, segmentCache);
sessionManager.startCleanup(2 * 60 * 1000);

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

await fastify.register(cors, { origin: '*' });

await fastify.register(staticPlugin, {
  root:  __dirname,
  prefix: '/',
  serve: true,
  index: false,
});

// ─── Register route plugins ───────────────────────────────────────────────────
await fastify.register(torrentRoutes, {
  prefix: '/torrent',
  sessionManager,
  segmentCache,
});

await fastify.register(streamRoutes, {
  prefix: '/stream',
  sessionManager,
  segmentCache,
});

// ─── Health check ─────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status:      'ok',
  time:        new Date().toISOString(),
  sessions:    sessionManager.all().length,
  cacheBytes:  segmentCache.totalBytes(),
}));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down`);

  sessionManager.stopCleanup();
  segmentCache.stop();

  const all = sessionManager.all();
  await Promise.allSettled(all.map(s => sessionManager.destroy(s.sessionId)));

  await fastify.close();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (non-fatal):', reason?.message ?? reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (non-fatal):', err.message);
});

// ─── Start listening ──────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: 3000, host: '0.0.0.0' });
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  Torrent→HLS multi-user server running');
  console.log('  API base    : http://localhost:3000');
  console.log('  Stream      : http://localhost:3000/stream/<sessionId>/master.m3u8');
  console.log('  Status (all): http://localhost:3000/torrent/status');
  console.log('  Test page   : http://localhost:3000/test.html');
  console.log(`  Cache       : ${(segmentCache.totalBytes() / 1024 ** 3).toFixed(2)} GB used`);
  console.log('  Seek logs   : on (set SEEK_LOG=0 to disable)');
  console.log('  Extreme logs: on (set EXTREME_LOG=0 to disable torrent/stream pump detail)');
  console.log('  Server TS   : on (set SERVER_LOG_TS=0 to disable console timestamps)');
  console.log('─────────────────────────────────────────────────────\n');
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
