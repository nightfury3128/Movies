/**
 * routes/stream.js — HLS file serving.
 *
 * GET /stream/:sessionId/init.mp4
 * GET /stream/:sessionId/master.m3u8
 * GET /stream/:sessionId/by-id/:segmentId
 * GET /stream/:sessionId/:filename
 *
 * Segment requests block until the file appears on disk (or 120s timeout).
 * This is intentional: the browser asks for a segment, and the server waits
 * for FFmpeg/seek worker to produce it rather than returning 404.
 *
 * Seek artifact resolution: if the client requests `segment_t118000.m4s` but
 * the timeline has a nearby-time segment under a different name, we serve the
 * actual file from disk. This handles minor TFDT rounding differences.
 */

import path from 'path';
import fs   from 'fs';

const SEGMENT_RE = /^segment_(?:t\d+(?:_\d+)?|\d+)\.m4s$/;
const SEG_WAIT_MS = 120_000;

export default async function streamRoutes(fastify, opts) {
  const { sessionManager, segmentCache } = opts;

  // ── GET /stream/:id/by-id/:segmentId ──────────────────────────────────────
  fastify.get('/:sessionId/by-id/:segmentId', async (req, reply) => {
    const { sessionId, segmentId } = req.params;

    if (segmentId.includes('..') || path.isAbsolute(segmentId)) {
      return reply.code(400).send({ error: 'Invalid segmentId' });
    }
    if (!SEGMENT_RE.test(segmentId)) {
      return reply.code(400).send({ error: 'Invalid segment filename' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);
    return _serveSegment(reply, session, segmentId);
  });

  // ── GET /stream/:id/:filename ──────────────────────────────────────────────
  fastify.get('/:sessionId/:filename', async (req, reply) => {
    const { sessionId, filename } = req.params;

    if (filename.includes('..') || path.isAbsolute(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const session = sessionManager.getBySessionId(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    sessionManager.touch(sessionId);

    // For segment files, use the timeline-aware path which can wait.
    if (SEGMENT_RE.test(filename)) {
      return _serveSegment(reply, session, filename);
    }

    // For init.mp4, master.m3u8 — serve directly with wait.
    const filePath = path.join(session.hlsPath, filename);
    return _serveStatic(reply, filePath, filename);
  });

  // ── GET /stream/:id ────────────────────────────────────────────────────────
  fastify.get('/:sessionId', async (req, reply) => {
    return reply.redirect(`/stream/${req.params.sessionId}/master.m3u8`);
  });
}

// ── Segment serving ───────────────────────────────────────────────────────────

async function _serveSegment(reply, session, segmentId) {
  const hlsPath = session.hlsPath;

  // Fast path: file already on disk.
  const directPath = path.join(hlsPath, segmentId);
  if (fs.existsSync(directPath)) {
    return _sendFile(reply, directPath, segmentId);
  }

  // For seek artifacts: check if the timeline has a segment covering the same time.
  const resolvedId = _resolveSegmentId(session, segmentId);
  if (resolvedId && resolvedId !== segmentId) {
    const resolvedPath = path.join(hlsPath, resolvedId);
    if (fs.existsSync(resolvedPath)) {
      return _sendFile(reply, resolvedPath, resolvedId);
    }
  }

  // Wait for the segment to appear (via timeline registration).
  const targetId   = resolvedId ?? segmentId;
  const targetPath = path.join(hlsPath, targetId);
  const isSeek     = _isSeekArtifact(segmentId);

  let entry = null;
  if (isSeek) {
    // For seek segments, wait for any segment covering the predicted time.
    const predictedTime = _parseSeekTime(segmentId);
    if (predictedTime != null) {
      entry = await session.timeline.waitForTime(predictedTime, SEG_WAIT_MS);
    }
  } else {
    entry = await session.timeline.waitForFile(targetId, SEG_WAIT_MS);
  }

  if (!entry) {
    return reply.code(404).send({ error: 'Segment not ready (timeout)' });
  }

  // The entry might have a different filename (e.g. rounding).
  const actualPath = path.join(hlsPath, entry.file);
  if (fs.existsSync(actualPath)) {
    return _sendFile(reply, actualPath, entry.file);
  }

  // Last resort: wait for the file to appear on disk.
  await _waitForFileDisk(actualPath, 30_000);
  if (fs.existsSync(actualPath)) {
    return _sendFile(reply, actualPath, entry.file);
  }

  return reply.code(404).send({ error: 'Segment file not found' });
}

async function _serveStatic(reply, filePath, filename) {
  // For init.mp4 / master.m3u8, wait up to 60 s if not yet written.
  const maxWait = filename === 'init.mp4' ? 60_000 : 30_000;
  if (!fs.existsSync(filePath)) {
    await _waitForFileDisk(filePath, maxWait);
  }
  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: `File not found: ${filename}` });
  }
  return _sendFile(reply, filePath, filename);
}

function _sendFile(reply, filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const mime = {
    '.m4s':  'video/mp4',
    '.mp4':  'video/mp4',
    '.m3u8': 'application/vnd.apple.mpegurl',
  }[ext] ?? 'application/octet-stream';

  const stat = fs.statSync(filePath);
  reply.header('Content-Type', mime);
  reply.header('Content-Length', stat.size);
  reply.header('Cache-Control', 'no-cache');
  reply.header('Access-Control-Allow-Origin', '*');
  return reply.send(fs.createReadStream(filePath));
}

// ── Timeline-aware segment ID resolution ─────────────────────────────────────

/**
 * For a seek artifact filename like `segment_t118000.m4s`, find the timeline
 * entry whose startTime ≈ 118.0s.  Returns the actual filename or null.
 */
function _resolveSegmentId(session, segmentId) {
  // Main segments: check timeline by filename.
  const byFile = session.timeline.findByFile(segmentId);
  if (byFile) return byFile.file;

  // Seek artifact: look up by predicted time.
  if (_isSeekArtifact(segmentId)) {
    const t = _parseSeekTime(segmentId);
    if (t == null) return null;
    const covering = session.timeline.findSegmentForTime(t)
      ?? session.timeline.findNearestSegment(t);
    if (covering && Math.abs(covering.startTime - t) < 2) return covering.file;
  }

  return null;
}

function _isSeekArtifact(id) {
  return /^segment_t\d+\.m4s$/.test(id ?? '');
}

function _parseSeekTime(segmentId) {
  const m = /^segment_t(\d+)\.m4s$/.exec(segmentId);
  return m ? parseInt(m[1], 10) / 1000 : null;
}

// ── Disk wait ─────────────────────────────────────────────────────────────────

function _waitForFileDisk(filePath, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fs.existsSync(filePath)) { resolve(); return; }
      if (Date.now() >= deadline)  { resolve(); return; } // resolve anyway, caller checks again
      setTimeout(check, 200);
    };
    check();
  });
}
