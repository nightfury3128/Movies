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
    this._clusters    = [];   // sorted ascending by startTime
    this._persistPath = persistPath;
    this._waiters     = [];   // { mode, time?, bufferedEnd?, file?, resolve, timer }
    this._persistTimer = null;
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Register a segment. Idempotent: same file re-registered is a no-op unless
   * timing changed.
   */
  register({
    file,
    startTime,
    endTime,
    source = 'main',
    byteOffset = null,
    clusterOffset = null,
    segmentId = file,
    decodeStartTime = null,
  }) {
    const existing = this._segments.find(s => s.file === file);
    if (existing) {
      const same = Math.abs(existing.startTime - startTime) < 0.001
        && Math.abs(existing.endTime - endTime) < 0.001;
      if (same) {
        this._mergeSegmentMetadata(existing, { byteOffset, clusterOffset, segmentId, decodeStartTime, source });
        this._persist();
        return existing;
      }
      existing.startTime = startTime;
      existing.endTime   = endTime;
      existing.duration  = endTime - startTime;
      existing.source    = source;
      this._mergeSegmentMetadata(existing, { byteOffset, clusterOffset, segmentId, decodeStartTime, source });
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
      segmentId,
      createdAt: Date.now(),
    };
    this._mergeSegmentMetadata(entry, { byteOffset, clusterOffset, segmentId, decodeStartTime, source });

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
        this._segments.push(this._normaliseSegment(e));
      }
    }
    this._segments.sort((a, b) => a.startTime - b.startTime);
    this._persist();
  }

  recordCluster({ startTime, endTime = null, byteOffset = null, clusterOffset, source = 'scan' }) {
    if (!isFinite(startTime) || !isFinite(clusterOffset) || clusterOffset < 0) return null;
    const entry = {
      startTime,
      endTime,
      byteOffset: byteOffset ?? clusterOffset,
      clusterOffset,
      source,
      createdAt: Date.now(),
    };

    const MERGE_WINDOW = 0.25;
    const existing = this._clusters.find(c => Math.abs(c.startTime - startTime) < MERGE_WINDOW);
    if (existing) {
      const rank = s => s === 'cues' ? 3 : s === 'seek' ? 2 : s === 'scan' ? 1 : 0;
      if (rank(source) >= rank(existing.source)) {
        existing.endTime       = endTime ?? existing.endTime ?? null;
        existing.byteOffset    = entry.byteOffset;
        existing.clusterOffset = clusterOffset;
        existing.source        = source;
        existing.updatedAt     = Date.now();
        this._persist();
      }
      return existing;
    }

    let i = this._clusters.length;
    while (i > 0 && this._clusters[i - 1].startTime > startTime) i--;
    this._clusters.splice(i, 0, entry);
    this._persist();
    return entry;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Segment where startTime <= time < endTime. O(log n). */
  findSegmentForTime(time) {
    const segs = this._segments;
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].endTime <= time)       lo = mid + 1;
      else if (segs[mid].startTime > time) hi = mid - 1;
      else return segs[mid];
    }
    return null;
  }

  findSeekTargetSegment(time) {
    return this.findSegmentForTime(time);
  }

  /** Segment that extends bufferedEnd. O(log n) entry point + short linear scan. */
  findNextForBuffer(bufferedEnd, maxGapSec = 45) {
    const segs = this._segments;
    if (!segs.length) return null;

    // Skip segments whose endTime is too far behind to matter.
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].endTime <= bufferedEnd - maxGapSec) lo = mid + 1;
      else hi = mid;
    }

    // Pass 1: segment overlapping / continuing bufferedEnd.
    for (let i = lo; i < segs.length; i++) {
      const s = segs[i];
      if (s.startTime > bufferedEnd + 0.5) break;
      if (s.endTime > bufferedEnd + 0.1) return s;
    }

    // Pass 2: nearest future segment within gap tolerance.
    for (let i = lo; i < segs.length; i++) {
      const s = segs[i];
      if (s.startTime <= bufferedEnd + 0.1) continue;
      if (s.startTime - bufferedEnd > maxGapSec) break; // sorted — no further candidates
      return s;
    }
    return null;
  }

  findByFile(file) {
    return this._segments.find(s => s.file === file) ?? null;
  }

  /** First segment with startTime strictly after `startTime`. O(log n). */
  findNextAfter(startTime) {
    const segs = this._segments;
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].startTime <= startTime) lo = mid + 1;
      else hi = mid;
    }
    return lo < segs.length ? segs[lo] : null;
  }

  /** Segment whose startTime is nearest to `time`. O(log n). */
  findNearestSegment(time) {
    const segs = this._segments;
    if (!segs.length) return null;
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].startTime < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= segs.length) return segs[segs.length - 1];
    if (lo === 0)          return segs[0];
    const before = segs[lo - 1], after = segs[lo];
    return Math.abs(before.startTime - time) <= Math.abs(after.startTime - time) ? before : after;
  }

  findClusterBefore(time, minPrerollSec = 0) {
    const target = time - minPrerollSec;
    let best = null;
    for (const c of this._clusters) {
      if (c.startTime <= target) best = c;
      else break;
    }
    return best;
  }

  /** All segments overlapping [startTime, endTime). O(log n) entry + linear result. */
  findSegmentsInRange(startTime, endTime) {
    const segs = this._segments;
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].endTime <= startTime) lo = mid + 1;
      else hi = mid;
    }
    const result = [];
    for (let i = lo; i < segs.length && segs[i].startTime < endTime; i++) result.push(segs[i]);
    return result;
  }

  hasTime(time) { return this.findSegmentForTime(time) != null; }

  latestTime() {
    return this._segments.length ? this._segments[this._segments.length - 1].endTime : 0;
  }

  getAll()  { return [...this._segments]; }
  getClusters() { return [...this._clusters]; }
  count()   { return this._segments.length; }
  clusterCount() { return this._clusters.length; }

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
      if (Array.isArray(saved)) {
        this._segments = saved.map(e => this._normaliseSegment(e));
        this._clusters = [];
      } else if (saved && typeof saved === 'object') {
        this._segments = Array.isArray(saved.segments) ? saved.segments.map(e => this._normaliseSegment(e)) : [];
        this._clusters = Array.isArray(saved.clusters) ? saved.clusters.map(e => ({
          ...e,
          byteOffset: e.byteOffset ?? e.clusterOffset,
        })).filter(e => isFinite(e.startTime) && isFinite(e.clusterOffset)) : [];
        this._segments.sort((a, b) => a.startTime - b.startTime);
        this._clusters.sort((a, b) => a.startTime - b.startTime);
      }
    } catch {}
  }

  _persist() {
    if (!this._persistPath || this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        fs.writeFileSync(this._persistPath, JSON.stringify({
          version: 2,
          segments: this._segments,
          clusters: this._clusters,
        }));
      } catch {}
    }, 1000);
  }

  _normaliseSegment(entry) {
    return {
      ...entry,
      segmentId: entry.segmentId ?? entry.file,
      duration: entry.duration ?? (entry.endTime - entry.startTime),
    };
  }

  _mergeSegmentMetadata(entry, metadata) {
    if (metadata.segmentId) entry.segmentId = metadata.segmentId;
    if (metadata.byteOffset != null && isFinite(metadata.byteOffset)) entry.byteOffset = metadata.byteOffset;
    if (metadata.clusterOffset != null && isFinite(metadata.clusterOffset)) entry.clusterOffset = metadata.clusterOffset;
    if (metadata.decodeStartTime != null && isFinite(metadata.decodeStartTime)) entry.decodeStartTime = metadata.decodeStartTime;
    if (metadata.clusterOffset != null && isFinite(metadata.clusterOffset)) {
      this.recordCluster({
        startTime: metadata.decodeStartTime ?? entry.startTime,
        endTime: entry.endTime,
        byteOffset: metadata.byteOffset ?? metadata.clusterOffset,
        clusterOffset: metadata.clusterOffset,
        source: metadata.source ?? entry.source ?? 'segment',
      });
    }
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

/**
 * ClusterIndex — maps media time → cluster byte offset.
 *
 * Populated by seek workers as they discover safe decode points (Cues table
 * hits or scan results). Consulted before hitting the Cues table so that the
 * second seek to a nearby time reuses the already-discovered cluster without
 * any async I/O.
 *
 * Entries come from MKV Cues (keyframe-guaranteed) or _findClusterAt scans.
 * Only Cues-derived entries are guaranteed to start at IDR frames.
 */
export class ClusterIndex {
  constructor() {
    this._entries = []; // [{startTime, clusterByte, source}] sorted by startTime
  }

  /**
   * Record a discovered cluster location.
   * @param {number} startTimeSec  Cluster's timecode in seconds
   * @param {number} clusterByte   File-relative byte offset of cluster start
   * @param {string} source        'cues' | 'scan' | 'estimate'
   */
  record(startTimeSec, clusterByte, source = 'scan') {
    if (!isFinite(startTimeSec) || !isFinite(clusterByte) || clusterByte < 0) return;
    const MERGE_WINDOW = 0.2; // merge entries within 200ms of each other
    const existing = this._entries.findIndex(e => Math.abs(e.startTime - startTimeSec) < MERGE_WINDOW);
    if (existing !== -1) {
      // Prefer 'cues' source over 'scan' over 'estimate'
      const rank = s => s === 'cues' ? 2 : s === 'scan' ? 1 : 0;
      if (rank(source) >= rank(this._entries[existing].source)) {
        this._entries[existing].clusterByte = clusterByte;
        this._entries[existing].source      = source;
      }
      return;
    }
    let i = this._entries.length;
    while (i > 0 && this._entries[i - 1].startTime > startTimeSec) i--;
    this._entries.splice(i, 0, { startTime: startTimeSec, clusterByte, source });
  }

  /**
   * Find the best safe decode starting point for a seek.
   * Returns the latest entry whose startTime ≤ (seekTimeSec - minPrerollSec),
   * or null if none exists.
   *
   * @param {number} seekTimeSec
   * @param {number} minPrerollSec  Minimum seconds before target (default 0)
   */
  findBefore(seekTimeSec, minPrerollSec = 0) {
    const target = seekTimeSec - minPrerollSec;
    let best = null;
    // Entries are sorted; stop once we pass target.
    for (const e of this._entries) {
      if (e.startTime <= target) best = e;
      else break;
    }
    return best;
  }

  count() { return this._entries.length; }
  getAll() { return [...this._entries]; }
}

/** Normalise a timeline entry into the wire format used by SSE and HTTP responses. */
export function toSegmentPayload(entry) {
  if (!entry) return null;
  return {
    segmentId: entry.segmentId ?? entry.file,
    file:      entry.file,
    startTime: entry.startTime,
    endTime:   entry.endTime,
    duration:  entry.duration ?? (entry.endTime - entry.startTime),
    byteOffset: entry.byteOffset ?? null,
    clusterOffset: entry.clusterOffset ?? null,
    decodeStartTime: entry.decodeStartTime ?? null,
  };
}
