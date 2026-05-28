/**
 * torrent/manager.js
 *
 * WHY THIS FILE EXISTS:
 * WebTorrent downloads files in pieces. To let FFmpeg seek inside a file that
 * is still downloading, we need to expose it over HTTP with Range header support.
 * A plain pipe doesn't allow seeking; HTTP does.
 *
 * WebTorrent's file.createReadStream({ start, end }) transparently waits for
 * the requested torrent pieces before returning bytes — so when FFmpeg seeks
 * to a position that hasn't been downloaded yet, the range request simply blocks
 * until those pieces arrive. This gives us zero-copy seek support for free.
 *
 * MULTI-USER CHANGES vs THE ORIGINAL:
 *   - No `path:` option — we use EvictingMemoryStore instead of writing to disk.
 *     Writing to disk would require one full movie file per user; with 5-10 users
 *     that could be 50–100 GB of disk I/O. EvictingMemoryStore keeps only the
 *     ~20 MB sliding window that FFmpeg has not yet consumed.
 *   - Internal HTTP server binds to port 0 (OS assigns a free port) instead of
 *     a hardcoded 9881. With multiple instances running simultaneously, hardcoding
 *     would cause EADDRINUSE on the second user.
 *   - this.store is exposed publicly so the route layer can call evictBefore()
 *     whenever FFmpeg reports progress via the 'ffmpeg-time' event.
 *
 * FLOW:
 *   magnet link
 *     → WebTorrent client (with EvictingMemoryStore)
 *     → pieces arrive into RAM (evicted as FFmpeg advances)
 *     → internal HTTP server (port 0, loopback only)
 *     → FFmpeg reads via Range requests
 *     → HLS segments written to cache/hls/<sessionId>/
 */

import WebTorrent from 'webtorrent';
import http from 'http';
import path from 'path';
import { EventEmitter } from 'events';
import { EvictingMemoryStore } from './store.js';

// Extensions we consider "video files" when picking which torrent file to stream.
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v']);

// Minimum bytes from the START of the file before FFmpeg begins.
// MKV headers (even with 20+ subtitle tracks) are typically < 500 KB.
// 1 MB gives comfortable margin.
const BUFFER_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB

// How many bytes BEHIND the current byte position to retain in RAM.
// 20 MB lets FFmpeg re-read the container header (always at byte 0) on seeks
// without re-downloading pieces from peers.
const EVICTION_SAFETY = 20 * 1024 * 1024; // 20 MB

export class TorrentManager extends EventEmitter {
  constructor() {
    super();

    // WebTorrent client — one instance per TorrentManager, one manager per session.
    // maxConns limits simultaneous peer connections to keep RAM usage manageable.
    this.client = new WebTorrent({ maxConns: 50 });

    this.torrent       = null;   // active WebTorrent torrent object
    this.videoFile     = null;   // the specific file we're streaming
    this.state         = 'idle'; // idle | downloading | ready | error
    this.store         = null;   // EvictingMemoryStore instance (exposed for eviction calls)
    this.internalPort  = null;   // OS-assigned port (filled in 'listening' callback)
    this.internalUrl   = null;   // http://127.0.0.1:<port>/

    this._internalServer  = null;  // http.Server instance
    this._bufferEmitted   = false; // guard so we only emit 'ready' once
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────────

  /**
   * Start downloading a magnet link.
   * Resolves with { internalUrl, videoFile } once enough buffer is available.
   *
   * @param {string} magnetUri
   * @returns {Promise<{ internalUrl: string, videoFile: object }>}
   */
  start(magnetUri) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'idle') {
        return reject(new Error('TorrentManager already active. Call stop() first.'));
      }

      this.state = 'downloading';
      this._bufferEmitted = false;

      /**
       * Store factory — WebTorrent calls `new StoreClass(chunkLen, opts)` internally.
       * We intercept that construction to capture the store reference so we can
       * call evictBefore() on it from outside this class.
       *
       * WHY a factory closure instead of passing EvictingMemoryStore directly?
       * If we pass EvictingMemoryStore directly, WebTorrent calls `new EvictingMemoryStore()`
       * and we have no way to get a reference to that specific instance. The factory
       * pattern creates a subclass that calls our capture callback in its constructor.
       */
      const StoreClass = makeStoreClass((capturedStore) => {
        this.store = capturedStore;
      });

      this.client.add(magnetUri, {
        // No `path:` — store: replaces disk writes entirely.
        store: StoreClass,

        // Sequential piece selection: always prioritize the lowest-index
        // missing piece so we can play from the beginning as quickly as possible.
        // Without this, BitTorrent's default rarest-first strategy downloads
        // pieces from all over the file, which means the start of the video
        // (the container header) may arrive last.
      }, (torrent) => {
        this.torrent = torrent;
        console.log(`[torrent] Added: ${torrent.name}`);

        // Select the largest video file as our streaming target.
        // Most movie torrents have one big video file and small extras (subs, nfo).
        this.videoFile = this._pickVideoFile(torrent.files);
        if (!this.videoFile) {
          this.state = 'error';
          return reject(new Error('No video file found in torrent'));
        }

        console.log(`[torrent] Streaming file: ${this.videoFile.name} (${formatBytes(this.videoFile.length)})`);

        // Deselect everything, then select only the video file so we don't
        // waste bandwidth downloading subtitle/NFO files.
        torrent.files.forEach(f => f.deselect());
        this.videoFile.select();

        // Force sequential piece selection by opening a read stream from byte 0.
        // WebTorrent's default strategy is rarest-first, which downloads pieces
        // from all over the file. For streaming we need the beginning first so
        // FFmpeg can read the container header immediately. Draining this stream
        // causes WebTorrent to prioritize piece 0 → 1 → 2 … in order.
        const primeBytes = Math.min(BUFFER_THRESHOLD_BYTES * 4, this.videoFile.length - 1);
        const primeStream = this.videoFile.createReadStream({ start: 0, end: primeBytes });
        primeStream.resume();
        primeStream.on('error', () => {}); // ignore — pieces may not exist yet

        // Start the internal HTTP server and wait for the OS to assign a port
        // before we start polling for the buffer threshold.
        this._startInternalServer(() => {
          // Poll every 500 ms so FFmpeg starts as soon as the threshold is crossed.
          const pollInterval = setInterval(() => {
            const downloaded = this.videoFile.downloaded;
            const speed      = formatBytes(torrent.downloadSpeed) + '/s';
            const pct        = ((downloaded / this.videoFile.length) * 100).toFixed(1);

            process.stdout.write(
              `\r[torrent] ${pct}% — ${formatBytes(downloaded)} / ${formatBytes(this.videoFile.length)} @ ${speed}   `
            );
            this.emit('progress', { downloaded, total: this.videoFile.length, speed: torrent.downloadSpeed });

            if (!this._bufferEmitted && downloaded >= BUFFER_THRESHOLD_BYTES) {
              this._bufferEmitted = true;
              clearInterval(pollInterval);
              console.log('\n[torrent] Buffer threshold reached — signalling FFmpeg to start');
              this.state = 'ready';
              this.emit('ready');
              resolve({ internalUrl: this.internalUrl, videoFile: this.videoFile });
            }
          }, 500);

          torrent.on('error', (err) => {
            clearInterval(pollInterval);
            this.state = 'error';
            this.emit('error', err);
            reject(err);
          });

          torrent.on('done', () => {
            console.log('\n[torrent] Download complete');
            this.emit('done');
          });
        });
      });

      this.client.on('error', (err) => {
        this.state = 'error';
        reject(err);
      });
    });
  }

  /** Destroy the active torrent and stop the internal server. */
  async stop() {
    if (this._internalServer) {
      await new Promise(r => this._internalServer.close(r));
      this._internalServer = null;
    }

    if (this.torrent) {
      await new Promise(r => this.torrent.destroy(r));
      this.torrent = null;
    }

    this.videoFile    = null;
    this.store        = null;
    this.internalPort = null;
    this.internalUrl  = null;
    this.state        = 'idle';
    this._bufferEmitted = false;
    console.log('[torrent] Stopped and cleaned up');
  }

  /** Returns a plain-object status snapshot. */
  status() {
    if (!this.torrent) return { state: this.state };
    return {
      state:         this.state,
      name:          this.torrent.name,
      downloaded:    this.videoFile?.downloaded ?? 0,
      total:         this.videoFile?.length     ?? 0,
      progress:      this.videoFile
        ? (this.videoFile.downloaded / this.videoFile.length)
        : 0,
      downloadSpeed: this.torrent.downloadSpeed,
      numPeers:      this.torrent.numPeers,
      internalUrl:   this.internalUrl,
      memoryUsedMB:  this.store
        ? (this.store.memoryUsedBytes / (1024 * 1024)).toFixed(1)
        : 0,
    };
  }

  // ─── INTERNALS ───────────────────────────────────────────────────────────────

  /**
   * Picks the largest video file in the torrent.
   * WHY largest? Because in a movie torrent the main feature is always the
   * largest file; smaller ones are subtitles, samples, or NFOs.
   */
  _pickVideoFile(files) {
    const videos = files.filter(f => {
      const ext = path.extname(f.name).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext);
    });

    if (videos.length === 0) return null;

    videos.sort((a, b) => b.length - a.length);
    return videos[0];
  }

  /**
   * Starts an HTTP server that serves the torrent video file with full
   * Range header support.
   *
   * WHY port 0?
   * With multiple TorrentManager instances running concurrently (one per user)
   * we cannot bind them all to the same hardcoded port. `listen(0)` asks the OS
   * to assign a free ephemeral port — guaranteed unique, no manual tracking needed.
   *
   * WHY NOT just point FFmpeg at the downloaded file path?
   * The file is stored in EvictingMemoryStore, not on disk. There is no path.
   * Even if there were, FFmpeg would read past the end and exit. By serving via
   * HTTP and using file.createReadStream(), we block at the byte boundary of the
   * last downloaded piece — exactly what streaming needs.
   *
   * WHY HTTP instead of a named pipe / FIFO?
   * Named pipes don't support seeking. HTTP Range requests do. FFmpeg's MKV
   * demuxer seeks backward to re-read the header; without seek support it errors.
   *
   * @param {Function} onListening - Called once the port is known
   */
  _startInternalServer(onListening) {
    this._internalServer = http.createServer((req, res) => {
      if (!this.videoFile) {
        res.writeHead(503);
        res.end('No video file');
        return;
      }

      const totalSize = this.videoFile.length;
      const ext       = path.extname(this.videoFile.name).toLowerCase();

      const mime = {
        '.mkv':  'video/x-matroska',
        '.mp4':  'video/mp4',
        '.avi':  'video/x-msvideo',
        '.mov':  'video/quicktime',
        '.webm': 'video/webm',
        '.m4v':  'video/mp4',
      }[ext] ?? 'application/octet-stream';

      const rangeHeader = req.headers['range'];

      if (rangeHeader) {
        // Parse "bytes=START-END" — FFmpeg sends this when seeking.
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        const start     = parseInt(match[1], 10);
        const end       = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': chunkSize,
          'Content-Type':   mime,
        });

        // createReadStream() blocks internally if pieces [start..end] aren't
        // downloaded yet — it will resume automatically once they arrive.
        const stream = this.videoFile.createReadStream({ start, end });
        stream.on('error', (err) => {
          console.error('[internal-server] Stream error:', err.message);
          res.destroy();
        });
        stream.pipe(res);

        // After we've committed to serving from `start`, evict everything
        // well behind this position. The 20 MB safety margin lets FFmpeg
        // re-read the container header (at byte 0) without re-downloading.
        if (this.store) {
          this.store.evictBefore(Math.max(0, start - EVICTION_SAFETY));
        }
      } else {
        // Non-range GET: FFmpeg initial probe or full download request.
        res.writeHead(200, {
          'Content-Length': totalSize,
          'Accept-Ranges':  'bytes',
          'Content-Type':   mime,
        });
        const stream = this.videoFile.createReadStream();
        stream.on('error', (err) => {
          console.error('[internal-server] Stream error:', err.message);
          res.destroy();
        });
        stream.pipe(res);
      }
    });

    // Bind to port 0 so the OS assigns a free ephemeral port.
    // The assigned port is available via server.address().port in the callback.
    this._internalServer.listen(0, '127.0.0.1', () => {
      this.internalPort = this._internalServer.address().port;
      this.internalUrl  = `http://127.0.0.1:${this.internalPort}/`;
      console.log(`[internal-server] Listening on ${this.internalUrl}`);
      onListening();
    });

    this._internalServer.on('error', (err) => {
      console.error('[internal-server] Error:', err.message);
      this.emit('error', err);
    });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Creates a subclass of EvictingMemoryStore that calls `onCapture(instance)`
 * the moment WebTorrent calls `new StoreClass(chunkLen, opts)`.
 *
 * WHY? WebTorrent constructs the store internally — we can't intercept the
 * constructor call any other way. By returning a freshly created subclass
 * whose constructor fires the capture callback, we get a reference to the
 * exact store instance WebTorrent is using, which is required for eviction.
 *
 * @param {Function} onCapture - Called with the new store instance
 * @returns {typeof EvictingMemoryStore}
 */
function makeStoreClass(onCapture) {
  return class extends EvictingMemoryStore {
    constructor(chunkLen, opts) {
      super(chunkLen, opts);
      onCapture(this);
    }
  };
}
