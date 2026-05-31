/**
 * fs.watch on seek worker temp dir — logs CREATE/RENAME/CHANGE for HLS artifacts.
 */

import fs from 'fs';
import path from 'path';
import { instrLog } from '../logger.js';

const WATCH_NAMES = /^(segment_\d+\.m4s|seek_init\.mp4|master\.m3u8)$/;

/**
 * @param {string} tempDir
 * @param {import('./seek-timeline.js').SeekTimeline|null} timeline
 * @param {string} jobId
 * @returns {() => void} cleanup
 */
export function watchSeekDir(tempDir, timeline, jobId) {
  let watcher;
  try {
    watcher = fs.watch(tempDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !WATCH_NAMES.test(filename)) return;

      const full = path.join(tempDir, filename);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* mid-write */ }

      const tag = eventType === 'rename' ? 'RENAME' : eventType.toUpperCase();
      instrLog('seek-dir', `${tag} ${filename}`, { jobId, size, path: full });
      timeline?.markOnce(`dir-${filename}`, `seek-dir ${tag}`, { filename, size });

      if (/^segment_\d+\.m4s$/.test(filename)) {
        timeline?.markOnce('first-segment-file', 'first segment file in temp dir', {
          filename, size, elapsedSec: (timeline.elapsedMs() / 1000).toFixed(1),
        });
      }
      if (filename === 'seek_init.mp4') {
        timeline?.markOnce('seek-init', 'seek_init.mp4 written', { size });
      }
      if (filename === 'master.m3u8') {
        timeline?.markOnce('master-m3u8', 'master.m3u8 written', { size });
      }
    });
  } catch (e) {
    instrLog('seek-dir', 'watch failed', { jobId, tempDir, err: e.message });
    return () => {};
  }

  // Snapshot existing files (race: FFmpeg may have written before watch attached)
  try {
    for (const f of fs.readdirSync(tempDir)) {
      if (WATCH_NAMES.test(f)) {
        instrLog('seek-dir', `EXISTING ${f}`, { jobId });
      }
    }
  } catch { /* empty dir */ }

  return () => { try { watcher?.close(); } catch {} };
}
