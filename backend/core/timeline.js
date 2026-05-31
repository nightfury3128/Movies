/**
 * core/timeline.js — SegmentTimelineRegistry
 *
 * THE single source of truth for media time → segment file mapping.
 *
 * Every registered segment is keyed by media time, not filename or index.
 * All seek resolution, gap recovery, and playback scheduling consult this
 * registry — never raw file listings or playlist order.
 *
 * Persistence: optionally writes to a JSON file so the timeline survives
 * a server restart (critical for cached sessions that skip re-transcoding).
 *
 * Async waiting: callers can await segment availability without polling loops.
 */

import fs from 'fs';

export class SegmentTimelineRegistry {
  /**
   * @param {string|null} persistPath  Optional JSON path for persistence.
   */
  constructor(persistPath = null) {
    this._segments    = [];   // sorted ascending by startTime
    this._persistPath = persistPath;
    this._waiters     = [];   // { mode, time?, bufferedEnd?, file?, resolve, timer }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Register a segment. Idempotent: same file re-registered is a no-op unless
   * timing changed.
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

    // Insert sorted by startTime
    let i = this._segments.length;
    while (i > 0 && this._segments[i - 1].startTime > startTime) i--;
    this._segments.splice(i, 0, entry);

    this._persist();
    this._resolveWaiters(startTime, endTime, entry);
    return entry;
  }

  bulkRegister(entries) {
    for (const e of entries) {
      if (!this._segments.find(s => s.file === e.file)) {
        this._segments.push(e);
      }
    }
    this._segments.sort((a, b) => a.startTime - b.startTime);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Segment where startTime <= time < endTime. */
  findSegmentForTime(time) {
    for (const s of this._segments) {
      if (s.startTime <= time && time < s.endTime) return s;
    }
    return null;
  }

  findSeekTargetSegment(time) {
    return this.findSegmentForTime(time);
  }

  /** Segment that extends bufferedEnd (starts ≤ bufferedEnd + before, ends > bufferedEnd + after). */
  findNextForBuffer(bufferedEnd, maxGapSec = 45) {
    for (const s of this._segments) {
      if (s.startTime <= bufferedEnd + 0.5 && s.endTime > bufferedEnd + 0.1) return s;
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

  findByFile(file) {
    return this._segments.find(s => s.file === file) ?? null;
  }

  findNextAfter(startTime) {
    for (const s of this._segments) {
      if (s.startTime > startTime) return s;
    }
    return null;
  }

  findNearestSegment(time) {
    if (!this._segments.length) return null;
    return this._segments.reduce((best, s) =>
      Math.abs(s.startTime - time) < Math.abs(best.startTime - time) ? s : best
    );
  }

  findSegmentsInRange(startTime, endTime) {
    return this._segments.filter(s => s.startTime < endTime && s.endTime > startTime);
  }

  hasTime(time) { return this.findSegmentForTime(time) != null; }

  latestTime() {
    return this._segments.length ? this._segments[this._segments.length - 1].endTime : 0;
  }

  getAll()  { return [...this._segments]; }
  count()   { return this._segments.length; }

  // ── Async wait ────────────────────────────────────────────────────────────

  waitForTime(time, timeoutMs = 30_000) {
    const existing = this.findSegmentForTime(time);
    if (existing) return Promise.resolve(existing);
    return this._makeWaiter({ mode: 'cover', time }, timeoutMs, () => this.findSegmentForTime(time));
  }

  waitForNextAfter(bufferedEnd, timeoutMs = 30_000) {
    const existing = this.findNextForBuffer(bufferedEnd);
    if (existing) return Promise.resolve(existing);
    return this._makeWaiter({ mode: 'after', bufferedEnd }, timeoutMs, () => this.findNextForBuffer(bufferedEnd));
  }

  waitForFile(file, timeoutMs = 30_000) {
    const existing = this.findByFile(file);
    if (existing) return Promise.resolve(existing);
    return this._makeWaiter({ mode: 'file', file }, timeoutMs, () => this.findByFile(file));
  }

  _makeWaiter(spec, timeoutMs, fallback) {
    return new Promise(resolve => {
      let timer;
      const waiter = {
        ...spec,
        resolve: entry => { clearTimeout(timer); resolve(entry); },
      };
      this._waiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i !== -1) this._waiters.splice(i, 1);
        resolve(fallback());
      }, timeoutMs);
    });
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
      } else if (w.mode === 'after') {
        if (
          (entry.startTime <= w.bufferedEnd + 0.5 && entry.endTime > w.bufferedEnd + 0.1) ||
          (entry.startTime > w.bufferedEnd + 0.1 && entry.startTime - w.bufferedEnd <= 45)
        ) {
          resolved = entry;
        }
      } else if (w.mode === 'cover') {
        if (w.time >= startTime && w.time < endTime) resolved = entry;
      }

      if (resolved) w.resolve(resolved);
      else remaining.push(w);
    }
    this._waiters = remaining;
  }
}

/** Normalise a timeline entry into the wire format used by SSE and HTTP responses. */
export function toSegmentPayload(entry) {
  if (!entry) return null;
  return {
    segmentId: entry.file,
    file:      entry.file,
    startTime: entry.startTime,
    endTime:   entry.endTime,
    duration:  entry.duration ?? (entry.endTime - entry.startTime),
  };
}
