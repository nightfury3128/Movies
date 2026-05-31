/**
 * timeline/segment-registry.js
 *
 * THE single source of truth for media timeline → file mapping.
 *
 * Every segment written by either the main encoder or seek worker must pass
 * through register(). No other code should map time → file or file → time.
 *
 * Entry shape:
 *   { file, startTime, endTime, duration, source, createdAt }
 *
 * Waiting callers (stream.js waitForFile) resolve instantly when the segment
 * they need is registered, with no polling loop.
 */

import fs from 'fs';

export class SegmentTimelineRegistry {
  /**
   * @param {string|null} persistPath  - Optional JSON file to persist/reload entries.
   */
  constructor(persistPath = null) {
    this._segments    = [];   // sorted ascending by startTime
    this._persistPath = persistPath;
    this._waiters     = [];   // { minTime, maxTime, resolve, timer }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Register a segment.  Idempotent: registering the same file twice is a no-op.
   *
   * @param {{ file: string, startTime: number, endTime: number, source?: string }} opts
   * @returns {object} the registry entry
   */
  register({ file, startTime, endTime, source = 'main' }) {
    const existing = this._segments.find(s => s.file === file);
    if (existing) {
      const same = Math.abs(existing.startTime - startTime) < 0.001
        && Math.abs(existing.endTime - endTime) < 0.001;
      if (same) return existing;
      existing.startTime = startTime;
      existing.endTime   = endTime;
      existing.duration  = endTime - startTime;
      existing.source    = source;
      this._segments.sort((a, b) => a.startTime - b.startTime);
      this._persist();
      this._resolveWaiters(startTime, endTime, existing);
      return existing;
    }

    const entry = {
      file,
      startTime,
      endTime,
      duration:  endTime - startTime,
      source,
      createdAt: Date.now(),
    };

    // Insert sorted by startTime.
    let i = this._segments.length;
    while (i > 0 && this._segments[i - 1].startTime > startTime) i--;
    this._segments.splice(i, 0, entry);

    this._persist();
    this._resolveWaiters(startTime, endTime, entry);
    return entry;
  }

  /**
   * Bulk-register a list of persisted entries (on server restart from cache).
   * @param {object[]} entries
   */
  bulkRegister(entries) {
    for (const e of entries) {
      if (!this._segments.find(s => s.file === e.file)) {
        this._segments.push(e);
      }
    }
    this._segments.sort((a, b) => a.startTime - b.startTime);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** @returns {object|null} segment where startTime <= time < endTime */
  findSegmentForTime(time) {
    for (const s of this._segments) {
      if (s.startTime <= time && time < s.endTime) return s;
    }
    return null;
  }

  /** True when entry spans seekTime. */
  coversTime(entry, time) {
    return entry != null && entry.startTime <= time && time < entry.endTime;
  }

  /**
   * Segment valid for a cached seek response — must cover seekTime.
   * @returns {object|null}
   */
  findSeekTargetSegment(time) {
    return this.findSegmentForTime(time);
  }

  /**
   * For MSE gap recovery: segment that extends bufferedEnd, or the next
   * registered segment after a hole (so the client can prefetch/wait).
   * @param {number} bufferedEnd
   * @returns {object|null}
   */
  findNextForBuffer(bufferedEnd, maxGapSec = 45) {
    for (const s of this._segments) {
      if (s.startTime <= bufferedEnd + 0.5 && s.endTime > bufferedEnd + 0.1) {
        return s;
      }
    }
    let best = null;
    for (const s of this._segments) {
      if (s.startTime <= bufferedEnd + 0.1) continue;
      const gap = s.startTime - bufferedEnd;
      if (gap > maxGapSec) continue;
      if (!best || s.startTime < best.startTime) best = s;
    }
    return best;
  }

  /**
   * @deprecated Use findSeekTargetSegment for seek; only returns covering segments.
   * @returns {object|null}
   */
  findPrerollSegment(time) {
    return this.findSegmentForTime(time);
  }

  /** @returns {object|null} */
  findByFile(file) {
    return this._segments.find(s => s.file === file) ?? null;
  }

  /** Next segment after `startTime` (strictly greater startTime). */
  findNextAfter(startTime) {
    for (const s of this._segments) {
      if (s.startTime > startTime) return s;
    }
    return null;
  }

  /** @returns {object|null} closest segment by startTime */
  findNearestSegment(time) {
    if (!this._segments.length) return null;
    return this._segments.reduce((best, s) =>
      Math.abs(s.startTime - time) < Math.abs(best.startTime - time) ? s : best
    );
  }

  /** @returns {object[]} all segments whose range overlaps [startTime, endTime] */
  findSegmentsInRange(startTime, endTime) {
    return this._segments.filter(s => s.startTime < endTime && s.endTime > startTime);
  }

  hasTime(time) {
    return this.findSegmentForTime(time) != null;
  }

  /** Latest endTime registered, or 0 if empty. */
  latestTime() {
    return this._segments.length ? this._segments[this._segments.length - 1].endTime : 0;
  }

  getAll() { return [...this._segments]; }

  count() { return this._segments.length; }

  // ── Async wait ────────────────────────────────────────────────────────────

  /**
   * Resolve with the segment covering `time` as soon as it is registered.
   * Returns null if nothing is registered within `timeoutMs`.
   *
   * @param {number} time       - Seek target in seconds
   * @param {number} timeoutMs
   * @returns {Promise<object|null>}
   */
  waitForTime(time, timeoutMs = 30_000) {
    const existing = this.findSegmentForTime(time);
    if (existing) return Promise.resolve(existing);

    return new Promise(resolve => {
      let timer;
      const waiter = {
        time,
        mode:    'cover',
        resolve: entry => { clearTimeout(timer); resolve(entry); },
      };
      this._waiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i !== -1) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  /**
   * Resolve when a preroll segment for `time` is available.
   * @param {number} time
   * @param {number} timeoutMs
   * @returns {Promise<object|null>}
   */
  waitForPreroll(time, timeoutMs = 30_000) {
    return this.waitForTime(time, timeoutMs);
  }

  /**
   * Resolve when a segment extending `bufferedEnd` (or the next after a hole) registers.
   * @param {number} bufferedEnd
   * @param {number} timeoutMs
   * @returns {Promise<object|null>}
   */
  waitForNextAfter(bufferedEnd, timeoutMs = 30_000) {
    const existing = this.findNextForBuffer(bufferedEnd);
    if (existing) return Promise.resolve(existing);

    return new Promise(resolve => {
      let timer;
      const waiter = {
        mode:         'after',
        bufferedEnd,
        resolve: entry => { clearTimeout(timer); resolve(entry); },
      };
      this._waiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i !== -1) this._waiters.splice(i, 1);
        resolve(this.findNextForBuffer(bufferedEnd));
      }, timeoutMs);
    });
  }

  /**
   * Resolve when a specific segment file is registered.
   * @param {string} file
   * @param {number} timeoutMs
   */
  waitForFile(file, timeoutMs = 30_000) {
    const existing = this.findByFile(file);
    if (existing) return Promise.resolve(existing);

    return new Promise(resolve => {
      let timer;
      const waiter = {
        file,
        mode:    'file',
        resolve: entry => { clearTimeout(timer); resolve(entry); },
      };
      this._waiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i !== -1) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  // ── Compatibility ─────────────────────────────────────────────────────────

  /**
   * Return the segment whose startTime corresponds to a legacy FFmpeg index.
   * Only used during the migration period where callers still have an integer idx.
   *
   * @param {number} idx        - Legacy segment index
   * @param {number} segDuration - Nominal segment duration (default 2 s)
   */
  segmentForLegacyIndex(idx, segDuration = 2) {
    const approxTime = idx * segDuration;
    return this.findSegmentForTime(approxTime) ?? this.findNearestSegment(approxTime);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load() {
    if (!this._persistPath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this._persistPath, 'utf8'));
      if (Array.isArray(saved)) this._segments = saved;
    } catch {}
  }

  _persist() {
    if (!this._persistPath) return;
    try { fs.writeFileSync(this._persistPath, JSON.stringify(this._segments)); } catch {}
  }

  _resolveWaiters(startTime, endTime, entry) {
    const remaining = [];
    for (const w of this._waiters) {
      let resolved = null;
      if (w.mode === 'file') {
        if (w.file === entry.file) resolved = entry;
      } else if (w.mode === 'preroll') {
        resolved = this.findSegmentForTime(w.time);
      } else if (w.mode === 'after') {
        if (entry.startTime <= w.bufferedEnd + 0.5 && entry.endTime > w.bufferedEnd + 0.1) {
          resolved = entry;
        } else if (entry.startTime > w.bufferedEnd + 0.1) {
          resolved = entry;
        }
      } else if (w.time >= startTime && w.time < endTime) {
        resolved = entry;
      }

      if (resolved) w.resolve(resolved);
      else remaining.push(w);
    }
    this._waiters = remaining;
  }
}

/** @param {object|null} entry @returns {object|null} */
export function toSegmentPayload(entry) {
  if (!entry) return null;
  const file = entry.file ?? entry.segmentId;
  if (!file) return null;
  return {
    segmentId: file,
    file,
    startTime: entry.startTime,
    endTime:   entry.endTime,
    duration:  entry.duration ?? (entry.endTime - entry.startTime),
  };
}
