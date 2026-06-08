/**
 * server.js — Athera streaming engine entry point.
 *
 * Architecture:
 *   Browser → Fastify → SessionManager → TorrentManager + HlsGenerator
 *                                      → SeekWorkerManager
 *                                      → SegmentTimelineRegistry (authoritative)
 *                                      → SegmentCache (persistent HLS on disk)
 *
 * Sessions are keyed by infoHash so multiple viewers share one download + FFmpeg.
 * HLS output persists at cache/segments/<infoHash>/ across server restarts.
 */

import Fastify       from 'fastify';
import cors          from '@fastify/cors';
import staticPlugin  from '@fastify/static';
import path          from 'path';
import { fileURLToPath } from 'url';

import { SessionManager }  from './session/manager.js';
import { SegmentCache }    from './cache/segment-cache.js';
import torrentRoutes       from './routes/torrent.js';
import streamRoutes        from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENABLE_TFDT_NORMALIZATION = /^(1|true|yes|on)$/i.test(process.env.ENABLE_TFDT_NORMALIZATION ?? 'true');

console.log(`[config] ENABLE_TFDT_NORMALIZATION=${ENABLE_TFDT_NORMALIZATION}`);

// ── Persistent segment cache ──────────────────────────────────────────────────
const segmentCache = new SegmentCache();
segmentCache.start();

// ── Session manager ───────────────────────────────────────────────────────────
const sessionManager = new SessionManager(segmentCache);

// ── Fastify ───────────────────────────────────────────────────────────────────
const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target:  'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
    },
  },
});

await fastify.register(cors, { origin: '*' });

// Serve backend dir statically (test.html lives one level up, served separately).
await fastify.register(staticPlugin, {
  root:   __dirname,
  prefix: '/',
  serve:  true,
  index:  false,
});

// ── Route plugins ─────────────────────────────────────────────────────────────
await fastify.register(torrentRoutes, {
  prefix:         '/torrent',
  sessionManager,
  segmentCache,
});

await fastify.register(streamRoutes, {
  prefix:         '/stream',
  sessionManager,
  segmentCache,
});

// ── Serve test.html from repo root ────────────────────────────────────────────
const TEST_HTML = path.join(__dirname, '..', 'test.html');
fastify.get('/', async (req, reply) => {
  return reply.type('text/html').send(
    await import('fs').then(m => m.promises.readFile(TEST_HTML, 'utf8'))
  );
});

// ── Health check ──────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status:      'ok',
  time:        new Date().toISOString(),
  sessions:    sessionManager.all().length,
  cacheBytes:  segmentCache.totalBytes(),
  memoryMB:    (process.memoryUsage().heapUsed / 1048576).toFixed(1),
}));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`\n🚀 Athera engine listening on http://${HOST}:${PORT}\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(sig) {
  console.log(`\n[server] ${sig} — shutting down`);
  await fastify.close();

  // Destroy all active sessions.
  for (const session of sessionManager.all()) {
    session.generator?.stop();
    session._stopWatcher?.();
    await session.torrentManager?.stop().catch(() => {});
  }

  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));
