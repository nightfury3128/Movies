/**
 * provider/evicting-store.js — sliding-window memory store for WebTorrent.
 *
 * WebTorrent's default store keeps ALL downloaded pieces in RAM. For a 10 GB
 * movie with 10+ concurrent users this is catastrophic. This store evicts
 * pieces that FFmpeg has already consumed, keeping only a small window.
 *
 * Design:
 *   - Pieces below `_evictBefore` (chunk index) are eligible for eviction.
 *   - Pieces in `HEADER_PRESERVE_CHUNKS` are pinned permanently — they contain
 *     the MKV/MP4 container header which FFmpeg re-reads on every seek restart.
 *   - Eviction is lazy: happens on put() so there's no background GC timer.
 */

export class EvictingMemoryStore {
  /**
   * @param {number} chunkLength  Chunk size in bytes (set by WebTorrent = piece size)
   * @param {object} opts         { length: totalBytes }
   */
  constructor(chunkLength, opts) {
    this.chunkLength = chunkLength;
    this.length      = opts?.length ?? 0;
    this.chunks      = new Map(); // chunkIndex → Buffer

    // Chunks below this index may be evicted (updated as FFmpeg advances).
    this._evictBefore = 0;
    // Chunks in range [0, HEADER_PRESERVE_CHUNKS) are always kept.
    this.HEADER_PRESERVE_CHUNKS = 0;
  }

  get(index, cb) {
    const chunk = this.chunks.get(index);
    if (!chunk) return cb(new Error('chunk not found'));
    cb(null, chunk);
  }

  put(index, buf, cb) {
    this.chunks.set(index, Buffer.from(buf));
    this._evict();
    cb(null);
  }

  /** True if the chunk containing `byteOffset` is in memory. */
  hasByte(byteOffset) {
    const idx = Math.floor(byteOffset / this.chunkLength);
    return this.chunks.has(idx);
  }

  /**
   * Advance the eviction frontier to the chunk containing `byteOffset`.
   * Call this each time FFmpeg reports progress so old chunks are freed.
   * @param {number} byteOffset  bytes-from-start-of-torrent (not file offset)
   */
  evictBefore(byteOffset) {
    const newFrontier = Math.floor(byteOffset / this.chunkLength);
    if (newFrontier > this._evictBefore) {
      this._evictBefore = newFrontier;
      this._evict();
    }
  }

  _evict() {
    for (const [idx] of this.chunks) {
      if (idx < this.HEADER_PRESERVE_CHUNKS) continue;
      if (idx < this._evictBefore) this.chunks.delete(idx);
    }
  }

  /** Number of bytes currently held in RAM. */
  ramBytes() {
    let total = 0;
    for (const buf of this.chunks.values()) total += buf.length;
    return total;
  }

  close(cb) {
    this.chunks.clear();
    cb?.(null);
  }

  destroy(cb) {
    this.close(cb);
  }
}

/**
 * WebTorrent expects `new StoreClass(chunkLen, opts)`.
 * We need a reference to the created store. This factory creates a subclass
 * that calls `onCapture` in its constructor so the caller can capture the ref.
 */
export function makeStoreClass(onCapture) {
  return class CapturedStore extends EvictingMemoryStore {
    constructor(chunkLength, opts) {
      super(chunkLength, opts);
      onCapture(this);
    }
  };
}
