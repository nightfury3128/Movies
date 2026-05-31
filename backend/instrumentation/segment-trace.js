/**
 * Full segment-numbering trace — finds the FIRST stage where
 * assignedSeg is the FFmpeg sequential file counter; expectedSegFromTfdt is
 * floor(t/SEG_DURATION) for diagnostics only (filenames no longer use it).
 */

import fs from 'fs';
import path from 'path';
import { readFragmentVideoTimeline } from './fragment-timeline.js';
import { SEG_DURATION } from '../cache/segment-cache.js';
import { instrLog } from '../logger.js';

const ON = process.env.SEEK_LOG !== '0';

/** @param {string} hlsPath @param {string} segmentFilename */
export function readExtinfForSegment(hlsPath, segmentFilename) {
  try {
    const playlist = fs.readFileSync(path.join(hlsPath, 'master.m3u8'), 'utf8');
    const lines = playlist.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === segmentFilename) {
        const m = /^#EXTINF:([\d.]+)/.exec(lines[i - 1] ?? '');
        if (m) return parseFloat(m[1]);
      }
    }
  } catch {}
  return null;
}

/** Wait until file size is stable, then read TFDT. */
export async function readTfdtWhenStable(filePath, { settleMs = 150 } = {}) {
  try {
    const stat1 = await fs.promises.stat(filePath);
    if (stat1.size === 0) return null;
    await new Promise(r => setTimeout(r, settleMs));
    const stat2 = await fs.promises.stat(filePath);
    if (stat1.size !== stat2.size) return null;
    return readFragmentVideoTimeline(filePath);
  } catch {
    return null;
  }
}

export class SegmentTrace {
  /** @param {string} sessionId @param {string} [hlsPath] */
  constructor(sessionId, hlsPath = null) {
    this.sessionId = sessionId;
    this.hlsPath   = hlsPath;
    /** @type {Map<number, object>} ffmpeg filename index → merged row */
    this.rows = new Map();
    this.firstDivergence = null;
    this._lastTableMax = -1;
  }

  setHlsPath(hlsPath) {
    this.hlsPath = hlsPath;
  }

  /**
   * Record a segment-numbering observation at one pipeline stage.
   *
   * @param {string} stage
   * @param {object} p
   * @param {number} [p.assignedSeg]
   * @param {number|null} [p.ffmpegReportedTime]
   * @param {string|null} [p.segmentFilename]
   * @param {string|null} [p.actualPath]
   * @param {number|null} [p.creationTime]  — mtimeMs or birthtimeMs
   * @param {number|null} [p.ffmpegSegCounter] — filename index when assignedSeg differs
   */
  record(stage, p = {}) {
    if (!ON) return null;

    const {
      assignedSeg,
      ffmpegReportedTime = null,
      segmentFilename = null,
      actualPath = null,
      creationTime = null,
    } = p;

    let ffmpegSegCounter = p.ffmpegSegCounter ?? assignedSeg;
    let filename = segmentFilename;
    if (filename) {
      const m = /^segment_(\d+)\.m4s$/.exec(filename);
      if (m) ffmpegSegCounter = parseInt(m[1], 10);
    } else if (ffmpegSegCounter != null && ffmpegSegCounter >= 0) {
      filename = `segment_${String(ffmpegSegCounter).padStart(5, '0')}.m4s`;
    }

    const filePath = actualPath
      ?? (filename && this.hlsPath ? path.join(this.hlsPath, filename) : null);

    let startSecondsFromTfdt = null;
    let expectedSegFromTfdt  = null;
    let delta                = null;
    let tfdtReadable         = false;

    if (filePath) {
      const tl = readFragmentVideoTimeline(filePath);
      if (tl) {
        tfdtReadable = true;
        startSecondsFromTfdt = +tl.startSeconds.toFixed(3);
        expectedSegFromTfdt  = Math.floor(tl.startSeconds / SEG_DURATION);
        if (assignedSeg != null) {
          delta = assignedSeg - expectedSegFromTfdt;
        }
      }
    }

    let extinfSeconds = null;
    if (filename && this.hlsPath) {
      extinfSeconds = readExtinfForSegment(this.hlsPath, filename);
    }

    let fileCreationTime = creationTime;
    if (filePath && fileCreationTime == null) {
      try {
        const st = fs.statSync(filePath);
        fileCreationTime = st.birthtimeMs || st.mtimeMs;
      } catch {}
    }

    const entry = {
      stage,
      assignedSeg,
      ffmpegReportedTime: ffmpegReportedTime != null ? +Number(ffmpegReportedTime).toFixed(3) : null,
      startSecondsFromTfdt,
      expectedSegFromTfdt,
      delta,
      segmentFilename:  filename,
      actualPath:       filePath,
      creationTime:     fileCreationTime,
      ffmpegSegCounter,
      extinfSeconds,
      tfdtReadable,
      sessionId:        this.sessionId,
    };

    console.log('[SEG-TRACE]', JSON.stringify(entry));
    instrLog('seg-trace', stage, entry);

    if (ffmpegSegCounter != null && ffmpegSegCounter >= 0) {
      this._mergeRow(ffmpegSegCounter, stage, entry);
    }

    if (ffmpegSegCounter != null && ffmpegSegCounter <= 5 && stage === 'ffmpeg-write') {
      this.printTable(6);
    }

    return entry;
  }

  /** @param {number} ffmpegSegCounter @param {string} stage @param {object} entry */
  _mergeRow(ffmpegSegCounter, stage, entry) {
    const row = this.rows.get(ffmpegSegCounter) ?? {
      ffmpegSegCounter,
      segmentFilename: entry.segmentFilename,
      wireAssignedSeg: null,
      stages:          {},
    };

    row.stages[stage] = entry;
    row.segmentFilename = entry.segmentFilename ?? row.segmentFilename;

    if (entry.startSecondsFromTfdt != null) row.startSecondsFromTfdt = entry.startSecondsFromTfdt;
    if (entry.expectedSegFromTfdt != null)  row.expectedSegFromTfdt  = entry.expectedSegFromTfdt;
    if (entry.delta != null)                row.delta                = entry.delta;
    if (entry.extinfSeconds != null)        row.extinfSeconds        = entry.extinfSeconds;
    if (entry.ffmpegReportedTime != null)   row.ffmpegReportedTime   = entry.ffmpegReportedTime;
    if (entry.creationTime != null)         row.creationTime         = entry.creationTime;

    if (stage === 'wire-ffmpeg-time') {
      row.wireAssignedSeg = entry.assignedSeg;
    }

    this.rows.set(ffmpegSegCounter, row);
  }

  /**
   * Print a timeline table for segment indices 0..maxIdx.
   * @param {number} [maxIdx=5]
   */
  printTable(maxIdx = 5) {
    if (!ON) return;
    if (maxIdx <= this._lastTableMax) return;
    this._lastTableMax = maxIdx;

    const hdr = [
      'idx'.padEnd(4),
      'filename'.padEnd(22),
      'ffmpegSeg'.padEnd(10),
      'wireSeg'.padEnd(8),
      'ffmpegTime'.padEnd(11),
      'tfdt(s)'.padEnd(10),
      'expected'.padEnd(9),
      'delta'.padEnd(6),
      'extinf(s)'.padEnd(10),
      'stages',
    ].join(' | ');

    const sep = '-'.repeat(hdr.length);
    const lines = [
      '',
      `[SEG-TIMELINE] session=${this.sessionId}`,
      hdr,
      sep,
    ];

    for (let i = 0; i <= maxIdx; i++) {
      const row = this.rows.get(i);
      if (!row) {
        lines.push(
          [
            String(i).padEnd(4),
            '(not yet)'.padEnd(22),
            '-'.padEnd(10),
            '-'.padEnd(8),
            '-'.padEnd(11),
            '-'.padEnd(10),
            '-'.padEnd(9),
            '-'.padEnd(6),
            '-'.padEnd(10),
            '-',
          ].join(' | '),
        );
        continue;
      }

      lines.push(
        [
          String(i).padEnd(4),
          (row.segmentFilename ?? '-').padEnd(22),
          String(row.ffmpegSegCounter ?? i).padEnd(10),
          String(row.wireAssignedSeg ?? '-').padEnd(8),
          (row.ffmpegReportedTime != null ? row.ffmpegReportedTime.toFixed(2) : '-').padEnd(11),
          (row.startSecondsFromTfdt != null ? row.startSecondsFromTfdt.toFixed(3) : '-').padEnd(10),
          (row.expectedSegFromTfdt != null ? String(row.expectedSegFromTfdt) : '-').padEnd(9),
          (row.delta != null ? String(row.delta) : '-').padEnd(6),
          (row.extinfSeconds != null ? row.extinfSeconds.toFixed(3) : '-').padEnd(10),
          Object.keys(row.stages).join(','),
        ].join(' | '),
      );
    }

    if (this.firstDivergence) {
      lines.push(sep);
      lines.push(`FIRST DIVERGENCE at stage=${this.firstDivergence.stage} assignedSeg=${this.firstDivergence.assignedSeg} expected=${this.firstDivergence.expectedSegFromTfdt} delta=${this.firstDivergence.delta}`);
    }

    lines.push('');
    console.log(lines.join('\n'));
  }

  summary(reason = 'complete') {
    if (!ON) return;
    const maxIdx = Math.max(5, ...this.rows.keys());
    this._lastTableMax = -1; // force reprint
    this.printTable(maxIdx);
    instrLog('seg-timeline', `summary (${reason})`, {
      sessionId: this.sessionId,
      rowCount:  this.rows.size,
      firstDivergence: this.firstDivergence,
    });
  }
}
