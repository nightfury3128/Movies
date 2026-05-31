/**
 * torrent/store.js — EvictingMemoryStore
 *
 * WHY NOT write to disk?
 * The original design wrote the video file to cache/downloads/. For 5-10 concurrent
 * users downloading different movies that means 5-10 full movie files on disk
 * simultaneously (e.g. 5 × 10 GB = 50 GB). This is unacceptable for a machine
 * with limited disk space.
 *
 * WHY NOT keep all pieces in RAM?
 * Keeping the full file in RAM is equally bad: a 10 GB file requires 10 GB of
 * process heap. Node.js V8 heap limits and OOM-killer would terminate the process.
 *
 * THE EVICTION SOLUTION:
 * We keep pieces in a Map<chunkIndex, Buffer>. Once FFmpeg has read past a byte
 * position (we know this from the 'ffmpeg-time' progress event), we evict all
 * chunks whose END byte is before (currentBytePosition - EVICTION_SAFETY).
 * The safety margin (20 MB by default) gives FFmpeg room for backward seeks
 * (e.g. re-reading the container header) without triggering a re-download.
 *
 * ABSTRACT-CHUNK-STORE INTERFACE:
 * WebTorrent expects its `store:` option to be a class that implements:
 *   constructor(chunkLength, opts)  — opts.length = total file size in bytes
 *   get(index, opts, cb)            — opts may have { offset, length }
 *   put(index, chunk, cb)
 *   close(cb)
 *   destroy(cb)
 *
 * We implement this interface from scratch rather than using memory-chunk-store
 * so we can add eviction without monkey-patching an external module.
 *
 * THREAD SAFETY:
 * Node.js is single-threaded so we don't need locks. All callbacks are called
 * synchronously-or-next-tick to match the abstract-chunk-store contract.
 */

import { instrLog } from '../logger.js';

export class EvictingMemoryStore {
  /**
   * @param {number} chunkLength - Size in bytes of each chunk (WebTorrent sets this to pieceLength)
   * @param {object} opts
   * @param {number} [opts.length] - Total size of the torrent file in bytes
   */
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;
    this.length = opts.length ?? 0;
    this.chunks = new Map();
    this.evictBeforeIndex = 0;
    /** @type {((index: number, size: number) => void)|null} */
    this.onPut = null;

    // Number of leading chunks to NEVER evict.
    // The MKV/MP4 container header lives in the first 1-2 MB. FFmpeg must re-read
    // it on every seek-restart (input -ss). Without preserving these chunks, any
    // seek would fail immediately because the header has been evicted.
    this.HEADER_PRESERVE_CHUNKS = Math.ceil(2 * 1024 * 1024 / chunkLength);
  }

  // ─── abstract-chunk-store API ────────────────────────────────────────────────

  /**
   * Retrieve a chunk (or a sub-range of it) by index.
   *
   * @param {number}   index  - Chunk index (0-based)
   * @param {object}   opts   - May contain { offset: number, length: number }
   * @param {Function} cb     - cb(err, data)
   */
  get(index, opts, cb) {
    // Normalize: fluent-ffmpeg / WebTorrent sometimes calls with (index, cb)
    if (typeof opts === 'function') { cb = opts; opts = {}; }

    const chunk = this.chunks.get(index);
    if (!chunk) {
      // Returning an error causes WebTorrent to treat the piece as missing and
      // re-request it from peers — the correct behaviour when a piece hasn't
      // arrived yet (or was evicted).
      return cb(new Error(`chunk ${index} not in store`));
    }

    const offset = opts.offset ?? 0;
    const length = opts.length ?? (chunk.length - offset);

    if (offset === 0 && length === chunk.length) {
      // Fast path: return the whole buffer without copying.
      return cb(null, chunk);
    }

    // Return a slice. Buffer.slice() returns a view (no copy) when possible;
    // slice + copy only happens when the range is out-of-bounds.
    return cb(null, chunk.slice(offset, offset + length));
  }

  /**
   * Store a chunk.
   * Silently ignores chunks below evictBeforeIndex (already past, don't need them).
   *
   * @param {number}   index  - Chunk index
   * @param {Buffer}   chunk  - Raw bytes
   * @param {Function} cb     - cb(err)
   */
  put(index, chunk, cb) {
    // Always keep header chunks regardless of eviction boundary.
    if (index < this.evictBeforeIndex && index >= this.HEADER_PRESERVE_CHUNKS) {
      // Silently discard — evicted non-header chunk.
      return cb(null);
    }
    this.chunks.set(index, chunk);
    if (this.onPut) this.onPut(index, chunk.length);
    cb(null);
  }

  /**
   * Evict all chunks whose END byte is strictly less than `bytePos`.
   *
   * Call this after confirming FFmpeg has advanced past bytePos.
   * Typical caller: `store.evictBefore(Math.max(0, ffmpegBytePos - 20 * 1024 * 1024))`
   *
   * @param {number} bytePos - Byte offset; all chunks ending before this are freed
   */
  evictBefore(bytePos) {
    if (bytePos <= 0) return;
    const targetIndex = Math.floor(bytePos / this.chunkLength);
    if (targetIndex <= this.evictBeforeIndex) return;

    // Never evict the preserved header chunks.
    const deleteFrom = Math.max(this.evictBeforeIndex, this.HEADER_PRESERVE_CHUNKS);
    for (let i = deleteFrom; i < targetIndex; i++) {
      this.chunks.delete(i);
    }
    this.evictBeforeIndex = targetIndex;
  }

  /**
   * Lower the eviction boundary so pieces in [bytePos, oldBoundary) can be
   * re-stored when WebTorrent re-downloads them after a seek-back.
   * Only lowers — never raises — the boundary.
   *
   * @param {number} bytePos - New lower bound (clamped to header preserve zone)
   */
  resetTo(bytePos, meta = {}) {
    const oldIndex = this.evictBeforeIndex;
    const targetIndex = Math.max(
      Math.floor(bytePos / this.chunkLength),
      this.HEADER_PRESERVE_CHUNKS,
    );
    if (targetIndex >= this.evictBeforeIndex) {
      if (meta.log) {
        instrLog('store', 'resetTo no-op (would raise boundary)', {
          bytePos, oldChunk: oldIndex, targetChunk: targetIndex,
        });
      }
      return { changed: false, oldIndex, newIndex: oldIndex };
    }
    this.evictBeforeIndex = targetIndex;
    if (meta.log) {
      instrLog('store', 'eviction boundary lowered', {
        bytePos,
        oldChunk: oldIndex,
        newChunk: targetIndex,
        oldByte:  oldIndex * this.chunkLength,
        newByte:  targetIndex * this.chunkLength,
        ...meta.extra,
      });
    } else {
      console.log(`[store] Eviction reset to byte ${bytePos} (chunk ${targetIndex}, was ${oldIndex})`);
    }
    return { changed: true, oldIndex, newIndex: targetIndex, bytePos };
  }

  /** True if chunk index is present in RAM */
  hasChunk(index) {
    return this.chunks.has(index);
  }

  /** Check whether byte `pos` is inside a stored chunk */
  hasByte(pos) {
    const idx = Math.floor(pos / this.chunkLength);
    return this.chunks.has(idx);
  }

  /**
   * Number of bytes currently held in RAM.
   * Useful for logging and health checks.
   */
  get memoryUsedBytes() {
    return this.chunks.size * this.chunkLength;
  }

  /**
   * close() — called by WebTorrent when the torrent is removed.
   * We release all buffers so GC can reclaim memory.
   */
  close(cb) {
    this.chunks.clear();
    if (cb) cb(null);
  }

  /**
   * destroy() — alias of close() in abstract-chunk-store convention.
   */
  destroy(cb) {
    this.close(cb);
  }
}
