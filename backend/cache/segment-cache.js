/**
 * cache/segment-cache.js — persistent LRU segment cache.
 *
 * Segments are stored in cache/segments/<infoHash>/. This directory persists
 * across server restarts so fully transcoded torrents can be served without
 * re-running FFmpeg.
 *
 * LRU eviction removes the least-recently-used infoHash directory when total
 * disk usage exceeds maxBytes.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', 'cache', 'segments');
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

export class SegmentCache {
  /**
   * @param {string} cacheDir  Root dir for all segment directories.
   * @param {number} maxBytes  Total disk limit before LRU eviction.
   */
  constructor(cacheDir = DEFAULT_CACHE_DIR, maxBytes = DEFAULT_MAX_BYTES) {
    this.cacheDir = cacheDir;
    this.maxBytes = maxBytes;
    this._lru     = new Map(); // infoHash → lastAccessMs
  }

  start() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this._loadLru();
  }

  /** @returns {string} Absolute path to the HLS directory for this torrent. */
  dir(infoHash) {
    return path.join(this.cacheDir, infoHash);
  }

  /** Mark an infoHash as recently used. */
  touch(infoHash) {
    this._lru.set(infoHash, Date.now());
    this._saveLru();
  }

  /**
   * Check if a fully transcoded copy exists (has #EXT-X-ENDLIST in master.m3u8).
   */
  isComplete(infoHash) {
    try {
      const playlist = fs.readFileSync(path.join(this.dir(infoHash), 'master.m3u8'), 'utf8');
      return playlist.includes('#EXT-X-ENDLIST');
    } catch {
      return false;
    }
  }

  /** Total bytes used by all cached segment directories. */
  totalBytes() {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(this.cacheDir)) {
        total += this._dirSize(path.join(this.cacheDir, entry));
      }
    } catch {}
    return total;
  }

  /** Evict LRU infoHash dirs until under maxBytes. */
  evict() {
    const sorted = [...this._lru.entries()].sort((a, b) => a[1] - b[1]); // oldest first
    for (const [infoHash] of sorted) {
      if (this.totalBytes() <= this.maxBytes) break;
      try {
        fs.rmSync(this.dir(infoHash), { recursive: true, force: true });
        this._lru.delete(infoHash);
        this._saveLru();
      } catch {}
    }
  }

  _dirSize(dir) {
    let size = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        try { size += fs.statSync(path.join(dir, f)).size; } catch {}
      }
    } catch {}
    return size;
  }

  _lruPath() { return path.join(this.cacheDir, 'lru.json'); }

  _loadLru() {
    try {
      const data = JSON.parse(fs.readFileSync(this._lruPath(), 'utf8'));
      for (const [k, v] of Object.entries(data)) this._lru.set(k, v);
    } catch {}
  }

  _saveLru() {
    try {
      fs.writeFileSync(this._lruPath(), JSON.stringify(Object.fromEntries(this._lru)));
    } catch {}
  }
}
