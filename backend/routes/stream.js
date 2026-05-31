/**
 * routes/stream.js
 *
 * Serves HLS playlist and segment files from the persistent segment cache.
 * Timeline-aware: legacy filename requests redirect to TFDT-renamed files via
 * the session SegmentTimelineRegistry.
 */

import path from 'path';
import fs from 'fs';
import { createReadStream } from 'fs';
import { INIT_IDX, SEG_DURATION } from '../cache/segment-cache.js';
import { seekLog, seekWarn, instrLog } from '../logger.js';
import {
  readFragmentVideoTimeline,
  globalIdxFromFragmentStart,
} from '../instrumentation/fragment-timeline.js';

const SEGMENT_ID_RE = /^segment_(?:t\d+(?:_\d+)?|\d+)\.m4s$/;

export default async function streamRoutes(fastify, opts) {
  const { sessionManager, segmentCache } = opts;

  // ─── GET /stream/:sessionId/by-id/:segmentId ───────────────────────────────
  fastify.get('/:sessionId/by-id/:segmentId', async (request, reply) => {
    const { sessionId, segmentId } = request.params;

    if (segmentId.includes('..') || path.isAbsolute(segmentId)) {
      return reply.code(400).send({ error: 'Invalid segmentId' });
    }
    if (!SEGMENT_ID_RE.test(segmentId)) {
      return reply.code(400).send({ error: 'segmentId must match segment_NNNNN.m4s or segment_tNNNN.m4s' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);
    touchSegmentLru(session, segmentCache, segmentId);

    const filePath = path.join(session.hlsPath, segmentId);
    return serveHlsFile(reply, filePath, segmentId, { sessionId, filename: segmentId, session });
  });

  // ─── GET /stream/:sessionId/:filename ──────────────────────────────────────
  fastify.get('/:sessionId/:filename', async (request, reply) => {
    const { sessionId, filename } = request.params;

    if (filename.includes('..') || path.isAbsolute(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);

    // Legacy filename → resolve via timeline registry before hitting disk.
    if (SEGMENT_ID_RE.test(filename) && session.timeline) {
      const resolved = resolveLegacySegmentRequest(session, filename);
      if (resolved && resolved.file !== filename) {
        instrLog('stream', 'legacy filename mapped to timeline segment', {
          requested: filename,
          actual:    resolved.file,
          startTime: resolved.startTime,
        });
        touchSegmentLru(session, segmentCache, resolved.file);
        const actualPath = path.join(session.hlsPath, resolved.file);
        return serveHlsFile(reply, actualPath, resolved.file, { sessionId, filename: resolved.file, session });
      }
    }

    const filePath = path.join(session.hlsPath, filename);

    const segMatch = filename.match(/^segment_(\d+)\.m4s$/);
    if (segMatch) {
      const segIdx = parseInt(segMatch[1], 10);
      const ahead  = segIdx > session.lastSegmentIdx;
      if (ahead || session.seekWorker) {
        seekLog('stream', 'segment request', {
          sessionId,
          filename,
          segIdx,
          mainLastSeg: session.lastSegmentIdx,
          seekWorker:  !!session.seekWorker,
          exists:      fs.existsSync(filePath),
        });
      }
    }

    touchSegmentLru(session, segmentCache, filename);
    return serveHlsFile(reply, filePath, filename, { sessionId, filename, session });
  });

  // ─── GET /stream/:sessionId ───────────────────────────────────────────────
  fastify.get('/:sessionId', async (request, reply) => {
    return reply.redirect(`/stream/${request.params.sessionId}/master.m3u8`);
  });
}

/** Map a legacy index-based filename to the timeline entry covering that time. */
function resolveLegacySegmentRequest(session, filename) {
  const m = /^segment_(\d+)\.m4s$/.exec(filename);
  if (!m || !session.timeline) return null;

  const legacyIdx = parseInt(m[1], 10);
  const approxTime = legacyIdx * SEG_DURATION;

  const byFile = session.timeline.findByFile(filename);
  if (byFile) return byFile;

  return session.timeline.findSegmentForTime(approxTime)
    ?? session.timeline.segmentForLegacyIndex(legacyIdx, SEG_DURATION);
}

function touchSegmentLru(session, segmentCache, filename) {
  const base = path.basename(filename).toLowerCase();
  if (base === 'init.mp4') {
    segmentCache.touch(session.infoHash, INIT_IDX);
    return;
  }
  const m = filename.match(/^segment_(\d+)\.m4s$/);
  if (m) segmentCache.touch(session.infoHash, parseInt(m[1], 10));
}

async function serveHlsFile(reply, filePath, filename, ctx = {}) {
  const ext      = path.extname(filename).toLowerCase();
  const base     = path.basename(filename).toLowerCase();
  const t0       = Date.now();
  const session  = ctx.session;
  const timeline = session?.seekTimeline;

  if (!fs.existsSync(filePath)) {
    if (ext === '.m4s' || base === 'init.mp4') {
      instrLog('waitForFile', 'enter', { filename, filePath, timeoutMs: 120_000 });
      timeline?.markOnce(`wait-${filename}`, 'client waiting for segment', { filename });

      const found = await waitForSegmentOnDisk(session, filename, filePath, 120_000, { ...ctx, timeline, t0 });

      if (!found) {
        instrLog('waitForFile', 'TIMEOUT', {
          filename, filePath, waitedMs: Date.now() - t0,
        });
        timeline?.mark('waitForFile timeout', { filename, waitedMs: Date.now() - t0 });
        timeline?.summary('waitForFile timeout');
        return reply.code(404).send({ error: 'Segment not ready after 120 s' });
      }

      // waitForSegmentOnDisk may have resolved a different TFDT-renamed file.
      if (found.file && found.file !== filename) {
        const actualPath = path.join(session.hlsPath, found.file);
        instrLog('waitForFile', 'serving TFDT-renamed file', {
          requested: filename, actual: found.file, waitedMs: Date.now() - t0,
        });
        return serveHlsFile(reply, actualPath, found.file, ctx);
      }

      instrLog('waitForFile', 'complete', {
        filename, waitedMs: Date.now() - t0, size: fs.statSync(filePath).size,
      });
      timeline?.markOnce(`served-${filename}`, 'client served segment', {
        filename, waitedMs: Date.now() - t0,
      });
    } else {
      return reply.code(404).send({ error: 'File not found' });
    }
  } else if (ext === '.m4s' && session?.seekWorker) {
    timeline?.markOnce(`served-${filename}`, 'client served segment (immediate)', { filename });
  }

  let mime;
  if (ext === '.m3u8') {
    mime = 'application/vnd.apple.mpegurl';
  } else if (ext === '.m4s' || ext === '.mp4' || base === 'init.mp4') {
    mime = 'video/mp4';
  } else if (ext === '.ts') {
    mime = 'video/mp2t';
  } else {
    mime = 'application/octet-stream';
  }

  const cacheControl = ext === '.m3u8' ? 'no-cache, no-store' : 'public, max-age=3600';

  if (ext === '.m3u8' && base === 'master.m3u8') {
    let body = fs.readFileSync(filePath, 'utf8');
    const dur = session?.codecInfo?.duration;
    if (dur && !body.includes('#EXT-X-TORRENT-DURATION:')) {
      body = body.replace('#EXTM3U\n', `#EXTM3U\n#EXT-X-TORRENT-DURATION:${dur}\n`);
    }
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', cacheControl);
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Content-Length', Buffer.byteLength(body));
    return reply.send(body);
  }

  if (ext === '.m4s') {
    const segMatch = filename.match(/^segment_(\d+)\.m4s$/);
    if (segMatch) {
      const segIdx       = parseInt(segMatch[1], 10);
      const timelineInfo = readFragmentVideoTimeline(filePath);
      const expectedSeg  = timelineInfo != null
        ? globalIdxFromFragmentStart(timelineInfo.startSeconds)
        : null;
      const delta        = expectedSeg != null ? segIdx - expectedSeg : null;

      let creationTime = null;
      try {
        const st = fs.statSync(filePath);
        creationTime = st.birthtimeMs || st.mtimeMs;
      } catch {}

      const serveEntry = {
        assignedSeg:          segIdx,
        ffmpegReportedTime:   null,
        startSecondsFromTfdt: timelineInfo?.startSeconds ?? null,
        expectedSegFromTfdt:  expectedSeg,
        delta,
        segmentFilename:      filename,
        actualPath:           filePath,
        creationTime,
      };

      session?.segmentTrace?.record('serve', serveEntry);
      console.log('[SERVE SEGMENT]', serveEntry);
    }
  }

  reply.header('Content-Type', mime);
  reply.header('Cache-Control', cacheControl);
  reply.header('Access-Control-Allow-Origin', '*');

  const { size } = fs.statSync(filePath);
  reply.header('Content-Length', size);

  return reply.send(createReadStream(filePath));
}

/**
 * Wait until a segment is on disk. Uses the timeline registry when available
 * so legacy filename requests resolve to the actual TFDT-renamed file.
 *
 * @returns {Promise<{ file: string }|true|null>}
 */
async function waitForSegmentOnDisk(session, filename, filePath, timeoutMs, ctx = {}) {
  const deadline = Date.now() + timeoutMs;

  const fileReady = (f) => {
    try {
      const p = path.join(session.hlsPath, f);
      return fs.existsSync(p) && fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  };

  // Exact segmentId request — wait on timeline registry for that file.
  if (SEGMENT_ID_RE.test(filename) && session?.timeline) {
    if (fileReady(filename)) return { file: filename };

    const entry = await session.timeline.waitForFile(filename, timeoutMs);
    if (entry && fileReady(entry.file)) return { file: entry.file };
  }

  // Legacy index filename — resolve via timeline covering that approximate time.
  const legacyMatch = filename.match(/^segment_(\d+)\.m4s$/);
  if (legacyMatch && session?.timeline) {
    const legacyIdx  = parseInt(legacyMatch[1], 10);
    const approxTime = legacyIdx * SEG_DURATION;

    const existing = session.timeline.findSegmentForTime(approxTime)
      ?? session.timeline.segmentForLegacyIndex(legacyIdx, SEG_DURATION);
    if (existing && fileReady(existing.file)) {
      return { file: existing.file };
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      const entry = await session.timeline.waitForTime(approxTime, remaining);
      if (entry && fileReady(entry.file)) return { file: entry.file };
    }
  }

  // Polling fallback (init.mp4, sessions without timeline).
  const pollFound = await waitForFilePoll(filePath, deadline, ctx);
  return pollFound ? { file: filename } : null;
}

function waitForFilePoll(filePath, deadline, ctx = {}) {
  return new Promise((resolve) => {
    const pollT0 = ctx.t0 ?? Date.now();
    let polls = 0;
    const check = () => {
      polls++;
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          instrLog('waitForFile', 'found (poll)', {
            filename: ctx.filename, polls, elapsedMs: Date.now() - pollT0,
          });
          return resolve(true);
        }
      } catch { /* not yet */ }
      if (Date.now() >= deadline) {
        instrLog('waitForFile', 'deadline exceeded', {
          filename: ctx.filename, polls, elapsedMs: Date.now() - pollT0,
        });
        return resolve(false);
      }
      if (polls === 1) {
        instrLog('waitForFile', 'first poll (missing)', {
          filename: ctx.filename, filePath, elapsedMs: Date.now() - pollT0,
        });
      } else if (polls % 100 === 0) {
        instrLog('waitForFile', `poll #${polls} (still missing)`, {
          filename: ctx.filename,
          elapsedMs: Date.now() - pollT0,
          remainingMs: deadline - Date.now(),
        });
      }
      setTimeout(check, 200);
    };
    check();
  });
}
