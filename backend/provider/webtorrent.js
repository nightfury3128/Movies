/**
 * provider/webtorrent.js — ByteProvider backed by WebTorrent.
 *
 * Implements the acquisition layer described in architecture.md:
 *
 *   interface ByteProvider {
 *     getRange(start, end)   // served via internal HTTP
 *     prioritize(start, end) // piece critical marking
 *     availability()         // piece bitfield summary
 *   }
 *
 * One TorrentManager per active session. Exposes an internal HTTP server
 * on a random loopback port so FFmpeg can Range-request bytes. Uses an
 * EvictingMemoryStore to bound RAM usage to a sliding window.
 *
 * Port 0 (OS-assigned) is critical for multi-user: multiple instances
 * can coexist without EADDRINUSE.
 */

import WebTorrent   from 'webtorrent';
import http         from 'http';
import path         from 'path';
import { EventEmitter } from 'events';
import { makeStoreClass } from './evicting-store.js';
import { log, warn, err, dbg, fmtBytes } from '../logger.js';

const NS = 'torrent';

// File extensions considered video.
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v']);

// Bytes behind FFmpeg cursor to retain in RAM (MKV header pin + read-ahead).
const EVICTION_SAFETY_BYTES = 40 * 1024 * 1024; // 40 MB

// ── EBML helpers (MKV Cues parsing) ──────────────────────────────────────────

// Parse one EBML VINT at buf[pos]. Returns {value, length} or null.
// value = Infinity for the "unknown size" marker.
function _readVint(buf, pos) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  let len, mask;
  if      (b & 0x80) { len = 1; mask = 0x7F; }
  else if (b & 0x40) { len = 2; mask = 0x3F; }
  else if (b & 0x20) { len = 3; mask = 0x1F; }
  else if (b & 0x10) { len = 4; mask = 0x0F; }
  else if (b & 0x08) { len = 5; mask = 0x07; }
  else if (b & 0x04) { len = 6; mask = 0x03; }
  else if (b & 0x02) { len = 7; mask = 0x01; }
  else if (b & 0x01) { len = 8; mask = 0x00; }
  else return null;
  if (pos + len > buf.length) return null;
  let unknown = (b & mask) === mask;
  for (let i = 1; i < len && unknown; i++) if (buf[pos + i] !== 0xFF) unknown = false;
  if (unknown) return { value: Infinity, length: len };
  let value = b & mask;
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, length: len };
}

// Byte length of an EBML element ID whose first byte is b.
function _ebmlIdLen(b) {
  if (b & 0x80) return 1;
  if (b & 0x40) return 2;
  if (b & 0x20) return 3;
  if (b & 0x10) return 4;
  return null;
}

// Read a big-endian unsigned integer of `len` bytes from buf[pos..].
function _readUintBE(buf, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

export class TorrentManager extends EventEmitter {
  constructor() {
    super();
    this.client       = new WebTorrent({ maxConns: 55 });
    this.torrent      = null;
    this.videoFile    = null;
    this.store        = null;
    this.internalPort = null;
    this.internalUrl  = null;
    this._server      = null;
    this._bufferReady = false;
    this._firstClusterOffset         = null;
    this._firstClusterOffsetPromise  = null;
    this._clusterCache = new Map(); // seekByte → Promise<clusterByteOffset>
    this._cuesTable    = undefined; // undefined = not loaded; null = absent; array = entries
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start downloading. Resolves once enough bytes are buffered for FFmpeg.
   * @returns {Promise<{internalUrl:string, videoFile:object}>}
   */
  start(magnetUri) {
    return new Promise((resolve, reject) => {
      const StoreClass = makeStoreClass(s => {
        this.store = s;
      });

      this.client.add(magnetUri, { store: StoreClass }, torrent => {
        this.torrent = torrent;
        torrent.setMaxListeners(120);

        log(NS, `Added: ${torrent.name}`);

        this.videoFile = this._pickVideoFile(torrent.files);
        if (!this.videoFile) {
          return reject(new Error('No video file found in torrent'));
        }

        log(NS, `Video: ${this.videoFile.name} (${fmtBytes(this.videoFile.length)})`);

        // Download only the video file.
        torrent.files.forEach(f => f.deselect());
        this.videoFile.select();

        // Pin header pieces so they're never evicted.
        if (this.store && torrent.pieceLength) {
          const HEADER_BYTES  = 40 * 1024 * 1024;
          const fileStart     = this.videoFile.offset ?? 0;
          const headerEndByte = fileStart + HEADER_BYTES;
          this.store.HEADER_PRESERVE_CHUNKS = Math.floor(headerEndByte / torrent.pieceLength) + 1;
        }

        // Critical priority for first 40 MB (covers MKV header + Cues).
        if (torrent.pieces?.length && torrent.pieceLength) {
          const fileOff   = this.videoFile.offset ?? 0;
          const primeEnd  = fileOff + Math.min(40 * 1024 * 1024, this.videoFile.length);
          const startPiece = Math.floor(fileOff / torrent.pieceLength);
          const endPiece   = Math.min(Math.floor(primeEnd / torrent.pieceLength), torrent.pieces.length - 1);
          torrent.critical(startPiece, endPiece);
          log(NS, `Priority pieces ${startPiece}–${endPiece} (header region)`);
        }

        this._startInternalServer(torrent, resolve, reject);
        this._wireProgressEvents(torrent);
      });

      this.client.on('error', reject);
    });
  }

  /** Advance the eviction frontier. Call as FFmpeg reports position in bytes. */
  evictBefore(byteOffset) {
    const safe = Math.max(0, byteOffset - EVICTION_SAFETY_BYTES);
    this.store?.evictBefore(safe);
  }

  /**
   * Mark pieces at a byte range as critical for download priority.
   * Used by the seek pipeline to pre-fetch pieces at the seek target.
   */
  prioritizeRange(startByte, endByte) {
    if (!this.torrent?.pieceLength) return;
    const pieceLen  = this.torrent.pieceLength;
    const fileOff   = this.videoFile?.offset ?? 0;
    const absStart  = fileOff + startByte;
    const absEnd    = fileOff + endByte;
    const startPiece = Math.floor(absStart / pieceLen);
    const endPiece   = Math.min(Math.floor(absEnd / pieceLen), this.torrent.pieces.length - 1);
    if (startPiece <= endPiece) {
      this.torrent.critical(startPiece, endPiece);
      log(NS, `Prioritized pieces ${startPiece}–${endPiece} for seek`);
      this._trace('torrent.prioritize', {
        startByte,
        endByte,
        startPiece,
        endPiece,
        pieceLen,
        fileOff,
        windowMB: +((endByte - startByte) / 1048576).toFixed(1),
      });
    }
  }

  /**
   * Wait until at least `count` pieces near seekByte are downloaded,
   * or timeoutMs elapses. Returns true if ready, false if timed out.
   */
  /**
   * Compute a piece-gate timeout from current swarm health.
   * Fast swarm → short gate; slow / no peers → longer gate.
   *
   * Formula: 3× the naive "time to download count pieces at current speed".
   * The 3× factor absorbs the priority-switch lag (WebTorrent takes a moment
   * to redirect bandwidth to seekByte) plus peer response variance.
   *
   * Bounds:
   *   remux   — [2 s, 15 s]  (seek worker is fast once pieces arrive)
   *   transcode — [3 s, 20 s]
   */
  seekGateMs(count = 3, mode = 'transcode') {
    const t         = this.torrent;
    const speed     = t?.downloadSpeed ?? 0;   // bytes/sec
    const pieceSize = t?.pieceLength   ?? 0;   // bytes per piece
    const peers     = t?.numPeers      ?? 0;

    const isRemux = mode === 'remux';
    const MIN_MS  = isRemux ? 2000  : 3000;
    const MAX_MS  = isRemux ? 15000 : 20000;

    if (!peers || !pieceSize || speed < 10 * 1024) return MAX_MS;

    const estimatedMs = (count * pieceSize / speed) * 3000;
    return Math.max(MIN_MS, Math.min(MAX_MS, estimatedMs));
  }

  /**
   * Wait for pieces at seekByte to land in the in-memory store.
   *
   * Event-driven: resolves immediately on each WebTorrent 'download' event so
   * fast swarms no longer pay the old 500 ms polling floor. A 500 ms fallback
   * timer still fires to re-evaluate the adaptive budget from live speed and
   * to handle already-verified pieces that arrive without triggering events.
   * Hard ceiling: 30 s.
   */
  async waitForPiecesAdaptive(seekByte, count = 3, mode = 'transcode') {
    const HARD_MAX = 30_000;
    const start    = Date.now();

    if (this._hasPiecesAt(seekByte, count)) {
      const diag = this.seekDiagnostics(seekByte, count);
      log(NS, 'Piece gate ready', diag);
      this._trace('torrent.piece_gate.ready', { ...diag, waitedMs: 0 });
      return true;
    }

    return new Promise(resolve => {
      let done      = false;
      let softTimer = null;
      let hardTimer = null;
      let lastPieceSummaryAt = 0;

      const cleanup = val => {
        if (done) return;
        done = true;
        this.torrent?.off('download', onDownload);
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        resolve(val);
      };

      // Fires on every piece the torrent downloads — zero extra latency.
      const onDownload = () => {
        if (done) return;
        if (this._hasPiecesAt(seekByte, count)) {
          const diag = this.seekDiagnostics(seekByte, count);
          log(NS, 'Piece gate ready', diag);
          this._trace('torrent.piece_gate.ready', { ...diag, waitedMs: Date.now() - start });
          cleanup(true);
        }
      };

      // Fallback: re-evaluate every 500 ms for adaptive timeout and edge cases
      // (e.g. pieces that were already verified and don't trigger 'download').
      const schedSoft = () => {
        softTimer = setTimeout(() => {
          if (done) return;
          if (this._hasPiecesAt(seekByte, count)) { onDownload(); return; }
          const elapsed = Date.now() - start;
          const budget  = this.seekGateMs(count, mode);
          const diag    = { ...this.seekDiagnostics(seekByte, count), waitedMs: elapsed, budgetMs: budget };
          if (Date.now() - lastPieceSummaryAt >= 5000) {
            lastPieceSummaryAt = Date.now();
            this._trace('torrent.piece_gate.summary', diag);
          }
          if (elapsed >= budget) {
            warn(NS, 'Piece gate adaptive timeout', diag);
            this._trace('torrent.piece_gate.adaptive_timeout', diag);
            cleanup(false);
            return;
          }
          schedSoft();
        }, 500);
      };

      hardTimer = setTimeout(() => {
        const diag = { ...this.seekDiagnostics(seekByte, count), waitedMs: HARD_MAX };
        warn(NS, 'Piece gate hard timeout', diag);
        this._trace('torrent.piece_gate.hard_timeout', diag);
        cleanup(false);
      }, HARD_MAX);

      this.torrent?.on('download', onDownload);
      schedSoft();
    });
  }

  waitForPiecesAt(seekByte, count = 3, timeoutMs = 20000) {
    if (this._hasPiecesAt(seekByte, count)) {
      const diag = this.seekDiagnostics(seekByte, count);
      log(NS, 'Retry piece wait: already verified', diag);
      this._trace('torrent.retry_piece_wait.already_ready', diag);
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let done = false;
      const finish = val => {
        if (done) return;
        done = true;
        this.torrent?.off('download', onDownload);
        clearTimeout(deadline);
        if (val) {
          const diag = this.seekDiagnostics(seekByte, count);
          log(NS, 'Retry piece wait: ready', diag);
          this._trace('torrent.retry_piece_wait.ready', diag);
        } else {
          const diag = { ...this.seekDiagnostics(seekByte, count), timeoutMs };
          warn(NS, 'Retry piece wait: timeout', diag);
          this._trace('torrent.retry_piece_wait.timeout', diag);
        }
        resolve(val);
      };
      const onDownload = () => {
        if (this._hasPiecesAt(seekByte, count)) finish(true);
      };
      const deadline = setTimeout(() => finish(false), timeoutMs);
      this.torrent?.on('download', onDownload);
    });
  }

  /**
   * Pre-fetch the MKV cluster boundary for seekByte, caching the result so the
   * HTTP handler can respond immediately when FFmpeg connects. Call this as soon
   * as pieces are being prioritized — the scan runs concurrently with the piece gate.
   */
  prefetchClusterAt(seekByte, expectedTimeMs = null) {
    const key = `${Math.floor(seekByte)}:${expectedTimeMs ?? 'any'}`;
    if (!this._clusterCache.has(key)) {
      this._trace('torrent.cluster.prefetch_start', { seekByte, expectedTimeMs });
      this._clusterCache.set(key, this._findClusterAt(seekByte, expectedTimeMs).catch(() => seekByte));
    }
    return this._clusterCache.get(key);
  }

  async safeDecodePointForTime(seekTimeSec, { duration = null, minPrerollSec = 12, existing = null } = {}) {
    if (existing?.clusterOffset != null) {
      this._trace('torrent.safe_decode.timeline_hit', { seekTimeSec, decodePoint: existing });
      return {
        requestedTime: seekTimeSec,
        startTime: existing.startTime,
        endTime: existing.endTime ?? null,
        byteOffset: existing.byteOffset ?? existing.clusterOffset,
        clusterOffset: existing.clusterOffset,
        source: existing.source ?? 'timeline',
      };
    }

    const seekTimeMs = seekTimeSec * 1000;

    try {
      const cues = await this._loadCues();
      if (cues && cues.length > 0) {
        let lo = 0, hi = cues.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (cues[mid].timeMs <= seekTimeMs) lo = mid; else hi = mid - 1;
        }
        const cue = cues[lo];
        const decodePoint = {
          requestedTime: seekTimeSec,
          startTime: cue.timeMs / 1000,
          endTime: null,
          byteOffset: cue.clusterByte,
          clusterOffset: cue.clusterByte,
          source: 'cues',
        };
        this._trace('torrent.safe_decode.cues_hit', decodePoint);
        return decodePoint;
      }
    } catch (e) {
      warn(NS, `safeDecodePointForTime: Cues failed: ${e.message}`);
    }

    if (duration && this.videoFile?.length) {
      const prerolls = [...new Set([minPrerollSec, 30, 60].filter(s => seekTimeSec - s >= 0))];
      if (seekTimeSec < minPrerollSec) prerolls.unshift(seekTimeSec);

      for (const prerollSec of prerolls) {
        const targetTime = Math.max(0, seekTimeSec - prerollSec);
        const hintByte = Math.max(0, Math.floor((targetTime / duration) * this.videoFile.length));
        const expectedTimeMs = Math.round(targetTime * 1000);
        const clusterOffset = await this.prefetchClusterAt(hintByte, expectedTimeMs);
        let clusterMs = null;
        try { clusterMs = await this._readClusterTimestampMs(clusterOffset); } catch {}

        if (clusterMs != null && clusterMs / 1000 <= seekTimeSec) {
          const decodePoint = {
            requestedTime: seekTimeSec,
            startTime: clusterMs != null ? clusterMs / 1000 : targetTime,
            endTime: null,
            byteOffset: hintByte,
            clusterOffset,
            source: 'scan',
          };
          this._trace('torrent.safe_decode.scan_hit', decodePoint);
          return decodePoint;
        }

        this._trace('torrent.safe_decode.scan_rejected', {
          seekTimeSec,
          hintByte,
          clusterOffset,
          clusterTimeSec: clusterMs != null ? clusterMs / 1000 : null,
          reason: clusterMs == null ? 'timestamp_unreadable' : 'after_target',
        });
      }
    }

    const decodePoint = {
      requestedTime: seekTimeSec,
      startTime: 0,
      endTime: null,
      byteOffset: 0,
      clusterOffset: 0,
      source: 'fallback_header',
    };
    this._trace('torrent.safe_decode.fallback', decodePoint);
    return decodePoint;
  }

  /**
   * Return the best file-relative byte offset for a given seek time.
   *
   * Strategy order:
   *   1. MKV Cues table  — O(1) once loaded; cached for all subsequent seeks.
   *   2. Interpolation   — reads cluster timestamp at hintByte; 1-2 reads.
   *   3. hintByte        — original linear estimate, unchanged.
   */
  async seekByteForTime(seekTimeSec, hintByte) {
    const seekTimeMs = seekTimeSec * 1000;

    // 1. Cues table
    try {
      const cues = await this._loadCues();
      if (cues && cues.length > 0) {
        let lo = 0, hi = cues.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (cues[mid].timeMs <= seekTimeMs) lo = mid; else hi = mid - 1;
        }
        const { timeMs, clusterByte } = cues[lo];
        log(NS, `seekByteForTime: Cues hit seekTime=${seekTimeSec}s → byte=${clusterByte} cueTime=${timeMs}ms`);
        this._trace('torrent.seek_byte.cues_hit', { seekTimeSec, seekTimeMs, cueTimeMs: timeMs, clusterByte });
        return clusterByte;
      }
    } catch (e) {
      warn(NS, `seekByteForTime: Cues failed: ${e.message}`);
    }

    // 2. Interpolation: measure actual bitrate from cluster timestamp at hintByte
    if (hintByte != null && hintByte > 0) {
      try {
        const firstCluster = await this._getFirstClusterOffset();
        if (firstCluster > 0 && firstCluster < hintByte) {
          const hintCluster = await this.prefetchClusterAt(hintByte); // uses cache if running
          const hintMs      = await this._readClusterTimestampMs(hintCluster);
          if (hintMs > 0 && hintMs < seekTimeMs) {
            const slope   = (hintCluster - firstCluster) / hintMs;
            const raw     = Math.floor(firstCluster + slope * seekTimeMs);
            const fileLen = this.videoFile?.length ?? raw;
            const refined = Math.max(firstCluster, Math.min(raw, fileLen - 1024 * 1024));
            log(NS, `seekByteForTime: interpolated seekTime=${seekTimeSec}s hintMs=${hintMs} → refined=${refined}`);
            this._trace('torrent.seek_byte.interpolated', { seekTimeSec, hintByte, hintCluster, hintMs, refined });
            return refined;
          }
        }
      } catch (e) {
        warn(NS, `seekByteForTime: interpolation failed: ${e.message}`);
      }
    }

    this._trace('torrent.seek_byte.fallback', { seekTimeSec, hintByte });
    return hintByte;
  }

  _hasPiecesAt(seekByte, count) {
    // storeReady = pieces are in RAM now; gateWouldPass = verified but may be evicted.
    // Using storeReady prevents FFmpeg from starting when pieces were evicted from the
    // sliding-window store and would cause an rw_timeout stall.
    return this.seekDiagnostics(seekByte, count).storeReady;
  }

  /**
   * Snapshot of torrent verification vs in-RAM store for a seek byte.
   * gateWouldPass: torrent.pieces null count (verified at some point).
   * storeReady:    chunks actually present in EvictingMemoryStore.
   * mismatch:      verified in torrent but evicted/missing from store.
   */
  seekDiagnostics(fileByte, count = 3) {
    const torrent  = this.torrent;
    const fileOff  = this.videoFile?.offset ?? 0;
    const pieceLen = torrent?.pieceLength ?? 0;
    const absByte  = fileOff + fileByte;

    if (!torrent?.pieces?.length || !pieceLen) {
      return { fileByte, gateWouldPass: false, storeReady: false, mismatch: false };
    }

    const startPiece = Math.floor(absByte / pieceLen);
    const endPiece   = Math.min(startPiece + count + 5, torrent.pieces.length);
    let verified = 0;
    let storeHits = 0;
    const pieces = [];

    for (let i = startPiece; i < endPiece; i++) {
      const isVerified = !torrent.pieces[i];
      const inStore    = this.store?.hasByte(i * pieceLen) ?? false;
      if (isVerified) verified++;
      if (inStore) storeHits++;
      if (i < startPiece + 4) {
        pieces.push({ i, v: isVerified, s: inStore });
      }
    }

    const gateWouldPass = verified >= count;
    const storeReady    = storeHits >= count;

    return {
      fileByte,
      absByte,
      startPiece,
      endPiece: endPiece - 1,
      verified,
      storeHits,
      gateWouldPass,
      storeReady,
      mismatch: gateWouldPass && !storeReady,
      evictChunk: this.store?._evictBefore ?? 0,
      ramMB: +((this.store?.ramBytes() ?? 0) / 1048576).toFixed(1),
      peers: torrent.numPeers ?? 0,
      speedKB: Math.round((torrent.downloadSpeed ?? 0) / 1024),
      pieces,
    };
  }

  _storeDiagAtFileByte(fileByte) {
    const fileOff  = this.videoFile?.offset ?? 0;
    const pieceLen = this.torrent?.pieceLength ?? 0;
    const absByte  = fileOff + fileByte;
    const chunk    = pieceLen ? Math.floor(absByte / pieceLen) : -1;
    return {
      fileByte,
      absByte,
      chunk,
      inStore: this.store?.hasByte(absByte) ?? false,
      evictChunk: this.store?._evictBefore ?? 0,
    };
  }

  getStats() {
    const t = this.torrent;
    if (!t) return { downloaded: 0, total: 0, downloadSpeed: 0, numPeers: 0, progress: 0 };

    const total      = this.videoFile?.length ?? t.length ?? 0;
    const downloaded = Math.round((t.progress ?? 0) * t.length);
    return {
      downloaded,
      total,
      downloadSpeed: t.downloadSpeed ?? 0,
      numPeers:      t.numPeers      ?? 0,
      progress:      t.progress      ?? 0,
      pieces: {
        total: t.pieces?.length ?? 0,
        have:  t.pieces?.filter(Boolean).length ?? 0,
      },
      ramBytes: this.store?.ramBytes() ?? 0,
    };
  }

  async stop() {
    return new Promise(resolve => {
      if (this._server) {
        this._server.close(() => {
          this._server = null;
          if (this.torrent) {
            this.torrent.destroy(() => {
              this.torrent = null;
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Write multiple readables to an HTTP response in order via manual writes.
   * Avoids pipe()-to-ServerResponse bugs where the second segment hits
   * "write after end". Uses chunked encoding (no Content-Length).
   */
  async _serveConcat(res, sources, onChunk = null) {
    let chunks = 0;
    let bytes = 0;
    const startedAt = Date.now();
    const writeChunk = chunk => new Promise((resolve, reject) => {
      if (res.destroyed || res.writableEnded) { resolve(); return; }
      const ok = res.write(chunk, err => err ? reject(err) : resolve());
      if (!ok) res.once('drain', resolve);
    });

    for (const src of sources) {
      for await (const chunk of src) {
        chunks++;
        bytes += chunk.length;
        if (onChunk) onChunk(chunk);
        if (chunks === 1 || (bytes >= 1048576 && bytes - chunk.length < 1048576)) {
          this._trace('torrent.http.concat_progress', {
            bytes,
            chunks,
            elapsedMs: Date.now() - startedAt,
          });
        }
        await writeChunk(chunk);
        if (res.destroyed || res.writableEnded) return;
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end();
    this._trace('torrent.http.concat_done', {
      bytes,
      chunks,
      elapsedMs: Date.now() - startedAt,
    });
  }

  _pickVideoFile(files) {
    const videos = files.filter(f => VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
    if (!videos.length) return null;
    return videos.reduce((a, b) => (a.length > b.length ? a : b));
  }

  _startInternalServer(torrent, resolve, reject) {
    const server = http.createServer(async (req, res) => {
      try {
      const file = this.videoFile;
      if (!file) { res.writeHead(404); res.end(); return; }

      const total = file.length;
      const rangeHeader = req.headers.range;

      // ?start=N: seek workers append this to stream from seekByte without
      // needing special HTTP request headers (fluent-ffmpeg splits header values).
      let baseOffset = 0;
      let seekTimeMs = null;
      if (req.url && req.url.includes('?')) {
        const qs = req.url.slice(req.url.indexOf('?') + 1);
        const m  = qs.match(/(?:^|&)start=(\d+)/);
        if (m) baseOffset = parseInt(m[1], 10) || 0;
        const m2 = qs.match(/(?:^|&)seekTime=(\d+)/);
        if (m2) seekTimeMs = parseInt(m2[1], 10) || null;
      }

      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!m) { res.writeHead(400); res.end(); return; }

        // Range bytes are relative to baseOffset so FFmpeg reconnects work.
        const start = baseOffset + parseInt(m[1], 10);
        const end   = m[2] ? baseOffset + parseInt(m[2], 10) : total - 1;

        if (start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
          'Content-Type':   'video/mp4',
          'Accept-Ranges':  'bytes',
        });
        const rs1 = file.createReadStream({ start, end });
        rs1.on('error', () => {});
        rs1.pipe(res);
      } else if (baseOffset > 0) {
        // Seek worker: MKV demuxer requires the EBML file header at byte 0.
        // Step 1: find the header/metadata boundary (byte 0 to firstCluster).
        // Step 2: find the nearest MKV Cluster element start at or after seekByte.
        // Serve: header[0..firstCluster) + cluster data[clusterStart..] so FFmpeg
        // receives a valid MKV with codec info followed by a real cluster boundary.
        let firstCluster = -1;
        try { firstCluster = await this._getFirstClusterOffset(); } catch {}

        // Find the actual cluster boundary at/after baseOffset.
        // baseOffset is an estimate (seekTime/duration * fileLen) — rarely cluster-aligned.
        // Always call _findClusterAt with expectedTimeMs so range-based timecode validation
        // rejects H.264 payload false positives; never use the cache for seek workers
        // because the cache may have been populated during interpolation without time context.
        // Use the result pre-fetched by prefetchClusterAt() when available — the seek
        // worker starts that scan early so the HTTP handler doesn't duplicate the work.
        // Fall back to a direct scan (with time-based false-positive rejection) on miss.
        let clusterStart = baseOffset;
        if (firstCluster > 0 && firstCluster < baseOffset) {
          try {
            clusterStart = await this.prefetchClusterAt(baseOffset, seekTimeMs);
          } catch { clusterStart = baseOffset; }
        }

        const serveMode = (firstCluster > 0 && firstCluster <= clusterStart) ? 'header+cluster' : 'cluster-only';
        const serveDiag = {
          baseOffset,
          clusterStart,
          firstCluster,
          serveMode,
          header: this._storeDiagAtFileByte(0),
          seek: this._storeDiagAtFileByte(baseOffset),
          cluster: this._storeDiagAtFileByte(clusterStart),
          diag: this.seekDiagnostics(baseOffset),
        };
        log(NS, 'Seek HTTP serve', serveDiag);
        this._trace('torrent.http.seek_serve', serveDiag);

        // ── Stream diagnostics (GROUP 5) ─────────────────────────────────────
        const _streamStart  = Date.now();
        let   _streamBytes  = 0;
        let   _streamFirst  = false;
        this._trace('torrent.stream.open', { baseOffset, clusterStart, seekTimeMs });
        const _streamInterval = setInterval(() => {
          this._trace('torrent.stream.bytes_sent', {
            bytesServed: _streamBytes,
            elapsedMs:   Date.now() - _streamStart,
            rateMBps:    +(_streamBytes / Math.max(1, (Date.now() - _streamStart) / 1000) / 1048576).toFixed(3),
          });
        }, 1000);
        const _onStreamData = chunk => {
          if (!_streamFirst) {
            _streamFirst = true;
            this._trace('torrent.stream.first_byte', { elapsedMs: Date.now() - _streamStart, firstChunkSize: chunk.length });
          }
          _streamBytes += chunk.length;
        };
        res.on('finish', () => {
          clearInterval(_streamInterval);
          this._trace('torrent.stream.closed', { bytesServed: _streamBytes, elapsedMs: Date.now() - _streamStart });
        });
        res.on('close', () => clearInterval(_streamInterval));

        const onStreamErr = (which, rangeStart, rangeEnd, e) => {
          clearInterval(_streamInterval);
          const errDiag = {
            which,
            range: `${rangeStart}-${rangeEnd}`,
            err: e?.message ?? String(e),
            store: this._storeDiagAtFileByte(rangeStart),
            diag: this.seekDiagnostics(baseOffset),
          };
          warn(NS, 'Seek HTTP stream error', errDiag);
          this._trace('torrent.http.seek_stream_error', errDiag);
          if (!res.destroyed) res.destroy();
        };

        if (firstCluster > 0 && firstCluster <= clusterStart) {
          // Chunked (no Content-Length): header + cluster are one continuous body.
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          const headerStream = file.createReadStream({ start: 0, end: firstCluster - 1 });
          const dataStream   = file.createReadStream({ start: clusterStart, end: total - 1 });
          this._serveConcat(res, [headerStream, dataStream], _onStreamData).catch(e => {
            if (!e?.message?.includes('aborted')) onStreamErr('seek-concat', clusterStart, total - 1, e);
          });
        } else {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          const rs3 = file.createReadStream({ start: clusterStart, end: total - 1 });
          rs3.on('data', _onStreamData);
          rs3.on('error', e => onStreamErr('cluster', clusterStart, total - 1, e));
          rs3.pipe(res);
        }
      } else {
        res.writeHead(200, {
          'Content-Length': String(total),
          'Content-Type':   'video/mp4',
          'Accept-Ranges':  'bytes',
        });
        const rs2 = file.createReadStream();
        rs2.on('error', () => {});
        rs2.pipe(res);
      }
      } catch (e) {
        warn(NS, 'HTTP handler error', { url: req.url, err: e.message });
        this._trace('torrent.http.handler_error', { url: req.url, err: e.message });
        if (!res.headersSent) { res.writeHead(500); res.end(); } else { res.end(); }
      }
    });

    this._server = server;
    server.listen(0, '127.0.0.1', () => {
      this.internalPort = server.address().port;
      this.internalUrl  = `http://127.0.0.1:${this.internalPort}/`;
      log(NS, `Internal HTTP on port ${this.internalPort}`);
      this._trace('torrent.http.listen', { port: this.internalPort });

      // Wait for MIN_BUFFER before handing URL to FFmpeg
      this._waitForBuffer(torrent, resolve);
    });

    server.on('error', reject);
  }

  _waitForBuffer(torrent, resolve) {
    const MIN_PIECES = 4;
    let resolved = false;
    const check = () => {
      if (resolved || !torrent.pieces) return;
      const pending  = torrent.pieces.filter(Boolean).length;
      const verified = torrent.pieces.length - pending;
      if (pending >= MIN_PIECES || torrent.done) {
        resolved = true;
        torrent.off('download', check);
        this._bufferReady = true;
        const payload = { pending, verified, total: torrent.pieces.length };
        log(NS, 'Buffer ready', payload);
        this._trace('torrent.buffer_ready', payload);
        resolve({ internalUrl: this.internalUrl, videoFile: this.videoFile });
      }
    };

    torrent.on('download', check);
    check();
  }

  _wireProgressEvents(torrent) {
    const emit = () => {
      this.emit('progress', {
        downloaded:    Math.round((torrent.progress ?? 0) * torrent.length),
        total:         torrent.length ?? 0,
        speed:         torrent.downloadSpeed ?? 0,
        numPeers:      torrent.numPeers ?? 0,
        progress:      torrent.progress ?? 0,
      });
    };

    const interval = setInterval(emit, 5000);
    torrent.once('done', () => {
      clearInterval(interval);
      this.emit('done');
    });
    torrent.on('error', e => {
      clearInterval(interval);
      err(NS, 'Torrent error', { msg: e.message });
      this._trace('torrent.error', { message: e.message });
    });
  }

  // Returns a promise for the byte offset of the first Matroska Cluster element
  // in the video file. Result is cached. The first 40 MB are always pinned in
  // the evicting store so this read completes immediately.
  _getFirstClusterOffset() {
    if (this._firstClusterOffset !== null) return Promise.resolve(this._firstClusterOffset);
    if (!this._firstClusterOffsetPromise) {
      this._firstClusterOffsetPromise = this._findFirstClusterOffset()
        .then(off => {
          this._firstClusterOffset = off;
          log(NS, `First MKV cluster at byte ${off}`);
          this._trace('torrent.cluster.first_found', { offset: off });
          return off;
        })
        .catch(e => {
          this._firstClusterOffset = -1;
          this._trace('torrent.cluster.first_failed', { message: e?.message });
          return -1;
        });
    }
    return this._firstClusterOffsetPromise;
  }

  _findFirstClusterOffset() {
    const SCAN_BYTES = 2 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const end = Math.min(SCAN_BYTES - 1, (this.videoFile?.length ?? SCAN_BYTES) - 1);
      const rs = this.videoFile.createReadStream({ start: 0, end });
      rs.on('data', d => chunks.push(d));
      rs.on('end', () => {
        const buf = Buffer.concat(chunks);
        for (let i = 0; i < buf.length - 3; i++) {
          if (buf[i] === 0x1f && buf[i+1] === 0x43 && buf[i+2] === 0xb6 && buf[i+3] === 0x75) {
            resolve(i);
            return;
          }
        }
        resolve(-1);
      });
      rs.on('error', reject);
    });
  }

  // Promise wrapper for videoFile.createReadStream. Times out after 8 s.
  _readFileRange(start, end) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const rs = this.videoFile.createReadStream({ start, end });
      const timer = setTimeout(() => { rs.destroy(); reject(new Error(`readFileRange timeout ${start}-${end}`)); }, 8000);
      rs.on('data',  d => chunks.push(d));
      rs.on('end',   () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      rs.on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  // Read the MKV Cluster Timestamp (element ID 0xE7) at a known cluster byte.
  // Timecode is always the first element in a cluster body — scan up to 48 bytes.
  async _readClusterTimestampMs(clusterByte) {
    const buf = await this._readFileRange(clusterByte, clusterByte + 255);
    if (buf[0] !== 0x1F || buf[1] !== 0x43 || buf[2] !== 0xB6 || buf[3] !== 0x75) {
      throw new Error('Not a cluster at byte ' + clusterByte);
    }
    const clSz = _readVint(buf, 4);
    if (!clSz) throw new Error('Bad cluster header');
    let pos = 4 + clSz.length;
    for (let i = 0; i < 48 && pos < buf.length - 2; i++, pos++) {
      if (buf[pos] !== 0xE7) continue;
      const sz = _readVint(buf, pos + 1);
      if (sz && sz.value >= 1 && sz.value <= 8 && pos + 1 + sz.length + sz.value <= buf.length) {
        return _readUintBE(buf, pos + 1 + sz.length, sz.value);
      }
    }
    throw new Error('Timecode not found in cluster');
  }

  /**
   * Parse the MKV Cues element from the first 2 MB of the file.
   * Returns a sorted [{timeMs, clusterByte}] array, or null if unavailable.
   * Cached on this._cuesTable after the first call.
   */
  async _loadCues() {
    if (this._cuesTable !== undefined) return this._cuesTable;

    const fileLen = this.videoFile?.length ?? 0;
    if (!fileLen) { this._cuesTable = null; return null; }

    try {
      const buf = await this._readFileRange(0, Math.min(2 * 1024 * 1024 - 1, fileLen - 1));

      // Locate Segment element (0x18538067) — gives us segBase for CueClusterPosition offsets.
      let segBase = 0;
      for (let i = 0; i < Math.min(buf.length - 7, 4096); i++) {
        if (buf[i] === 0x18 && buf[i+1] === 0x53 && buf[i+2] === 0x80 && buf[i+3] === 0x67) {
          const sz = _readVint(buf, i + 4);
          if (sz) segBase = i + 4 + sz.length;
          break;
        }
      }

      // Find Cues element (0x1C53BB6B).
      let cuesBodyStart = -1, cuesBodyEnd = buf.length;
      for (let i = segBase; i < buf.length - 7; i++) {
        if (buf[i] === 0x1C && buf[i+1] === 0x53 && buf[i+2] === 0xBB && buf[i+3] === 0x6B) {
          const sz = _readVint(buf, i + 4);
          if (!sz) break;
          cuesBodyStart = i + 4 + sz.length;
          if (sz.value !== Infinity) cuesBodyEnd = Math.min(cuesBodyStart + sz.value, buf.length);
          break;
        }
      }

      if (cuesBodyStart < 0) {
        log(NS, 'Cues element not found in first 2 MB');
        this._cuesTable = null;
        return null;
      }

      const cuePoints = [];
      let pos = cuesBodyStart;

      while (pos < cuesBodyEnd - 1) {
        if (buf[pos] !== 0xBB) {
          // Skip non-CuePoint element
          const idLen = _ebmlIdLen(buf[pos]);
          if (!idLen) break;
          const sz = _readVint(buf, pos + idLen);
          if (!sz || sz.value === Infinity) break;
          pos += idLen + sz.length + sz.value;
          continue;
        }

        // CuePoint (0xBB)
        const cpSz = _readVint(buf, pos + 1);
        if (!cpSz) break;
        const cpStart = pos + 1 + cpSz.length;
        const cpEnd   = Math.min(cpStart + cpSz.value, cuesBodyEnd);

        let cueTimeMs = -1, cueClusterPos = -1;
        let cpos = cpStart;

        while (cpos < cpEnd - 1) {
          const cid = buf[cpos];
          const csz = _readVint(buf, cpos + 1);
          if (!csz) break;
          const vstart = cpos + 1 + csz.length;

          if (cid === 0xB3 && csz.value >= 1 && csz.value <= 8 && vstart + csz.value <= buf.length) {
            // CueTime
            cueTimeMs = _readUintBE(buf, vstart, csz.value);
          } else if (cid === 0xB7) {
            // CueTrackPositions: find CueClusterPosition (0xF1)
            let tpos = vstart, tend = vstart + csz.value;
            while (tpos < tend - 1 && tpos < buf.length - 1) {
              const tid = buf[tpos];
              const tsz = _readVint(buf, tpos + 1);
              if (!tsz) break;
              const tvstart = tpos + 1 + tsz.length;
              if (tid === 0xF1 && tsz.value >= 1 && tsz.value <= 8 && tvstart + tsz.value <= buf.length) {
                cueClusterPos = _readUintBE(buf, tvstart, tsz.value);
              }
              tpos = tvstart + tsz.value;
            }
          }

          cpos = vstart + csz.value;
        }

        if (cueTimeMs >= 0 && cueClusterPos >= 0) {
          cuePoints.push({ timeMs: cueTimeMs, clusterByte: segBase + cueClusterPos });
        }

        pos = cpEnd;
      }

      if (cuePoints.length === 0) {
        log(NS, 'Cues: element found but no entries parsed');
        this._cuesTable = null;
        return null;
      }

      cuePoints.sort((a, b) => a.timeMs - b.timeMs);
      log(NS, `Cues: ${cuePoints.length} entries [${cuePoints[0].timeMs}ms–${cuePoints[cuePoints.length-1].timeMs}ms]`);
      this._trace('torrent.cues.loaded', {
        count: cuePoints.length,
        firstMs: cuePoints[0].timeMs,
        lastMs:  cuePoints[cuePoints.length - 1].timeMs,
      });
      this._cuesTable = cuePoints;
      return cuePoints;
    } catch (e) {
      warn(NS, `_loadCues failed: ${e.message}`);
      this._cuesTable = null;
      return null;
    }
  }

  /**
   * Scan up to 4 MB forward from `seekByte` looking for the first MKV Cluster
   * element boundary (`0x1F 0x43 0xB6 0x75`). Returns the absolute file byte
   * offset of that cluster, or `seekByte` if none is found (safe fallback).
   *
   * Called when serving `?start=seekByte`: seekByte is an estimate derived from
   * seekTime/duration and is rarely cluster-aligned. Finding the real cluster
   * boundary ensures FFmpeg receives syntactically valid MKV.
   *
   * The 4 MB window is safe: the piece gate guarantees that pieces at seekByte
   * are in the evicting store, and typical cluster sizes are well under 4 MB.
   */
  _findClusterAt(seekByte, expectedTimeMs = null) {
    const SCAN_BYTES = 4 * 1024 * 1024;
    const fileLen    = this.videoFile?.length ?? 0;
    const scanEnd    = Math.min(seekByte + SCAN_BYTES - 1, fileLen - 1);
    if (scanEnd < seekByte) return Promise.resolve(seekByte);

    return new Promise(resolve => {
      const chunks = [];
      const rs = this.videoFile.createReadStream({ start: seekByte, end: scanEnd });
      rs.on('data',  d => chunks.push(d));
      rs.on('end', () => {
        const buf = Buffer.concat(chunks);
        const nearStartThreshold = Math.floor(fileLen * 0.05);

        for (let i = 0; i < buf.length - 3; i++) {
          if (buf[i] !== 0x1f || buf[i+1] !== 0x43 || buf[i+2] !== 0xb6 || buf[i+3] !== 0x75) continue;

          // Validate candidate: parse EBML cluster VINT size, then look for
          // the Timecode element (0xE7) within the first 64 bytes of the body.
          const clSz = _readVint(buf, i + 4);
          if (!clSz) continue; // malformed VINT → false positive

          const bodyStart = i + 4 + clSz.length;
          let valid = false;
          for (let j = bodyStart; j < Math.min(bodyStart + 64, buf.length - 2); j++) {
            if (buf[j] !== 0xE7) continue;
            const sz = _readVint(buf, j + 1);
            if (!sz || sz.value < 1 || sz.value > 8) continue;
            if (j + 1 + sz.length + sz.value > buf.length) continue;
            const timecode = _readUintBE(buf, j + 1 + sz.length, sz.value);

            if (expectedTimeMs != null) {
              // Range check: a real cluster at this seek position must have a
              // timecode within 50%–200% of the expected seek time. H.264/HEVC
              // payload bytes that happen to form 0x1F43B675 will produce a
              // random "timecode" far outside this window, rejecting the false positive.
              if (timecode < expectedTimeMs * 0.5 || timecode > expectedTimeMs * 2.0) {
                this._trace('torrent.cluster.seek_false_positive', {
                  seekByte, candidateOffset: seekByte + i, timecode, expectedTimeMs,
                });
                break;
              }
            } else if ((seekByte + i) > nearStartThreshold && timecode === 0) {
              // Fallback when expectedTimeMs is not known: reject zero timecode far from start.
              this._trace('torrent.cluster.seek_false_positive', {
                seekByte, candidateOffset: seekByte + i, timecode,
              });
              break;
            }
            if (valid) {
              this._trace('torrent.cluster.candidate_keyframe', {
                seekByte,
                candidateOffset: seekByte + i,
                timecode,
                expectedTimeMs,
                passedRangeCheck: true,
              });
            }
            valid = true;
            break;
          }
          if (!valid) continue;

          dbg(NS, 'Cluster scan found', { clusterStart: seekByte + i, seekByte });
          this._trace('torrent.cluster.seek_found', {
            seekByte,
            clusterStart: seekByte + i,
            scanBytes: i,
          });
          resolve(seekByte + i);
          return;
        }
        // No cluster found in scan window — serve from seekByte and hope for the best.
        resolve(seekByte);
      });
      rs.on('error', e => {
        warn(NS, 'Cluster scan read failed', { seekByte, err: e.message, fallback: seekByte });
        this._trace('torrent.cluster.seek_scan_error', {
          seekByte,
          err: e.message,
          fallback: seekByte,
        });
        resolve(seekByte);
      });
    });
  }

  _trace(phase, data = {}) {
    this.emit('server:trace', {
      phase,
      ns: NS,
      at: Date.now(),
      ...data,
    });
  }
}
