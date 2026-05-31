/**
 * fs.watch on main HLS output dir — traces segment files as FFmpeg writes them.
 */

import fs from 'fs';
import path from 'path';
import { readTfdtWhenStable } from './segment-trace.js';

const SEGMENT_RE = /^segment_(\d+)\.m4s$/;

/**
 * @param {string} hlsDir
 * @param {import('./segment-trace.js').SegmentTrace|null} trace
 * @returns {() => void} cleanup
 */
export function watchMainHlsDir(hlsDir, trace) {
  const pending = new Map(); // filename → timeout handle
  const traced  = new Set();

  const scheduleTrace = (filename) => {
    if (!trace || traced.has(filename)) return;
    const prev = pending.get(filename);
    if (prev) clearTimeout(prev);

    pending.set(filename, setTimeout(async () => {
      pending.delete(filename);
      if (traced.has(filename)) return;

      const full = path.join(hlsDir, filename);
      let creationTime = null;
      try {
        const st = await fs.promises.stat(full);
        if (st.size === 0) return;
        creationTime = st.birthtimeMs || st.mtimeMs;
      } catch {
        return;
      }

      const tl = await readTfdtWhenStable(full);
      if (!tl && filename.match(SEGMENT_RE)) {
        // File may still be growing — retry once.
        setTimeout(() => scheduleTrace(filename), 200);
        return;
      }

      traced.add(filename);
      const m = SEGMENT_RE.exec(filename);
      const segCounter = m ? parseInt(m[1], 10) : null;

      trace.record('ffmpeg-write', {
        assignedSeg:      segCounter,
        ffmpegSegCounter: segCounter,
        segmentFilename:  filename,
        actualPath:       full,
        creationTime,
      });
    }, 200));
  };

  let watcher;
  try {
    watcher = fs.watch(hlsDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !SEGMENT_RE.test(filename)) return;
      scheduleTrace(filename);
    });
  } catch {
    return () => {};
  }

  // Snapshot any segments already on disk when watch attaches.
  try {
    for (const f of fs.readdirSync(hlsDir)) {
      if (SEGMENT_RE.test(f)) scheduleTrace(f);
    }
  } catch {}

  return () => {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    try { watcher?.close(); } catch {}
  };
}
