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
import { log, warn, err, fmtBytes } from '../logger.js';

const NS = 'torrent';

// File extensions considered video.
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v']);

// Bytes behind FFmpeg cursor to retain in RAM (MKV header pin + read-ahead).
const EVICTION_SAFETY_BYTES = 40 * 1024 * 1024; // 40 MB

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
    }
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

  _pickVideoFile(files) {
    const videos = files.filter(f => VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
    if (!videos.length) return null;
    return videos.reduce((a, b) => (a.length > b.length ? a : b));
  }

  _startInternalServer(torrent, resolve, reject) {
    const server = http.createServer((req, res) => {
      const file = this.videoFile;
      if (!file) { res.writeHead(404); res.end(); return; }

      const total = file.length;
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!m) { res.writeHead(400); res.end(); return; }

        const start = parseInt(m[1], 10);
        const end   = m[2] ? parseInt(m[2], 10) : total - 1;

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
        file.createReadStream({ start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': String(total),
          'Content-Type':   'video/mp4',
          'Accept-Ranges':  'bytes',
        });
        file.createReadStream().pipe(res);
      }
    });

    this._server = server;
    server.listen(0, '127.0.0.1', () => {
      this.internalPort = server.address().port;
      this.internalUrl  = `http://127.0.0.1:${this.internalPort}/`;
      log(NS, `Internal HTTP on port ${this.internalPort}`);

      // Wait for MIN_BUFFER before handing URL to FFmpeg
      this._waitForBuffer(torrent, resolve);
    });

    server.on('error', reject);
  }

  _waitForBuffer(torrent, resolve) {
    const MIN_PIECES = 4;
    const check = () => {
      if (!torrent.pieces) return;
      const downloaded = torrent.pieces.filter(Boolean).length;
      if (downloaded >= MIN_PIECES || torrent.done) {
        this._bufferReady = true;
        log(NS, `Buffer ready (${downloaded} pieces)`);
        resolve({ internalUrl: this.internalUrl, videoFile: this.videoFile });
        return;
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

    const interval = setInterval(emit, 500);
    torrent.once('done', () => {
      clearInterval(interval);
      this.emit('done');
    });
    torrent.on('error', e => {
      clearInterval(interval);
      err(NS, 'Torrent error', { msg: e.message });
    });
  }
}
