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

export class EvictingMemoryStore {
  /**
   * @param {number} chunkLength - Size in bytes of each chunk (WebTorrent sets this to pieceLength)
   * @param {object} opts
   * @param {number} [opts.length] - Total size of the torrent file in bytes
   */
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;

    // Total file length — used to clamp the last chunk's size.
    this.length = opts.length ?? 0;

    /**
     * Map<chunkIndex, Buffer>
     * Chunks are added by put() and removed by evictBefore().
     */
    this.chunks = new Map();

    /**
     * Any chunk with index < evictBeforeIndex has been evicted and will NOT
     * be served by get(). put() calls for indices below this value are silently
     * dropped so WebTorrent doesn't refill evicted pieces from the network.
     *
     * WHY silently drop? Because WebTorrent may re-verify pieces at any time.
     * Erroring on put() would cause WebTorrent to mark the piece as failed and
     * attempt a re-download, consuming bandwidth for data we no longer need.
     */
    this.evictBeforeIndex = 0;
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
    if (index < this.evictBeforeIndex) {
      // Silently discard — evicted range, we've already streamed past here.
      return cb(null);
    }

    this.chunks.set(index, chunk);
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

    // The chunk whose END byte equals bytePos is at floor(bytePos / chunkLength).
    // Chunks 0 … targetIndex-1 have their last byte < bytePos — safe to evict.
    const targetIndex = Math.floor(bytePos / this.chunkLength);
    if (targetIndex <= this.evictBeforeIndex) return; // nothing new to evict

    for (let i = this.evictBeforeIndex; i < targetIndex; i++) {
      this.chunks.delete(i);
    }

    this.evictBeforeIndex = targetIndex;
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
