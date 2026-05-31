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
import { seekLog, seekWarn, instrLog, instrWarn, fmtBytes, fmtByteNum } from '../logger.js';

// Extensions we consider "video files" when picking which torrent file to stream.
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v']);

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

    this.torrent       = null;
    this.videoFile     = null;
    this.state         = 'idle';
    this.store         = null;
    this.internalPort  = null;
    this.internalUrl   = null;

    this._internalServer  = null;
    this._bufferEmitted   = false;

    // Seek-restart window (solo restart). See startSeek().
    this._seekWindowStart = null;
    this._seekWindowEnd   = null;
    // Verbose HTTP range logging until this timestamp (set by _prioritizeByteRange).
    this._rangeLogUntil   = 0;
    // Active seek debug session (timeline + piece range)
    this._seekTimeline    = null;
    this._seekActive      = false;
    this._seekByte        = null;
    this._lastEncodeReadaheadAt = 0;
    this._seekPieceStart  = null;
    this._seekPieceEnd    = null;
    this._seekFirstRange  = true;
    this._pendingWaits    = new Map(); // pieceIndex → waitStartMs
    this._loggedSeekPieces = new Set();
    /** @type {((...args: unknown[]) => void)|null} */
    this._pumpWaitHandler = null;
  }

  _cancelPumpWait() {
    if (this._pumpWaitHandler && this.torrent) {
      this.torrent.off('download', this._pumpWaitHandler);
    }
    this._pumpWaitHandler = null;
  }

  _isPieceReadyForByte(fromByte) {
    if (this.store?.hasByte(fromByte)) return true;
    const piece = this._byteToPiece(fromByte);
    if (piece == null) return false;
    return typeof this.torrent?.have === 'function' && this.torrent.have(piece);
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
        this._wireStorePutHook();
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
        // Each stalled _pumpBytes() call adds one torrent.once('download',…) listener.
        // With up to ~50 concurrent range requests from FFmpeg + seek workers, the
        // default 11-listener warning fires constantly. Raise the limit to silence it.
        torrent.setMaxListeners(100);
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

        // Pin the video file header (first 40 MB of file content) against eviction.
        // The MKV EBML header + SeekHead + Cues table can be up to 40 MB for
        // large files. FFmpeg re-reads local byte 0 on every seek-restart (-ss),
        // so those pieces must NEVER be evicted. The file may start at a non-zero
        // torrent offset (e.g. piece 29), so HEADER_PRESERVE_CHUNKS must be
        // large enough to cover fileOffset + 40 MB in torrent-chunk units.
        if (this.store && torrent.pieceLength) {
          const HEADER_PIN_BYTES = 40 * 1024 * 1024;
          const fileOffset     = this.videoFile.offset ?? 0;
          const fileStartPiece = Math.floor(fileOffset / torrent.pieceLength);
          const headerEndByte  = fileOffset + HEADER_PIN_BYTES;
          const headerEndPiece = Math.min(
            Math.floor(headerEndByte / torrent.pieceLength),
            torrent.pieces.length - 1,
          );
          this.store.HEADER_PRESERVE_CHUNKS = headerEndPiece + 1;
          console.log(`[pin] selected file header pieces ${fileStartPiece}-${headerEndPiece} pinned (store preserves chunks 0-${headerEndPiece})`);
        }

        // Mark the first 40 MB of the video file as critical priority so
        // WebTorrent downloads them sequentially before any rarest-first pieces.
        // Without this, rarest-first scatter creates gaps in the first ~22 MB
        // that stall FFmpeg even when enough total data has downloaded.
        // 40 MB covers ~30s of typical 1080p content — enough for MIN_SEGMENTS
        // to complete before the first gap.
        if (torrent.pieces?.length && torrent.pieceLength) {
          const videoOffset  = this.videoFile.offset ?? 0;
          const startPiece   = Math.floor(videoOffset / torrent.pieceLength);
          const primeEnd     = videoOffset + Math.min(40 * 1024 * 1024, this.videoFile.length);
          const endPiece     = Math.min(Math.floor(primeEnd / torrent.pieceLength), torrent.pieces.length - 1);
          torrent.critical(startPiece, endPiece);
          console.log(`[torrent] Sequential priority: pieces ${startPiece}–${endPiece} (first 40 MB)`);
        }

        // Start the internal HTTP server and wait for the OS to assign a port
        // before we start polling for the buffer threshold.
        this._startInternalServer(() => {
          // Resolve immediately — _pumpBytes handles blocking reads, so there
          // is no minimum buffer needed before FFmpeg can start. A progress
          // interval keeps the console and 'progress' events alive.
          console.log('[torrent] Internal server ready — starting FFmpeg immediately');
          this.state = 'ready';
          this.emit('ready');
          resolve({ internalUrl: this.internalUrl, videoFile: this.videoFile });

          const progressInterval = setInterval(() => {
            if (!this.torrent || !this.videoFile) { clearInterval(progressInterval); return; }
            const downloaded = this.videoFile.downloaded;
            const speed      = formatBytes(torrent.downloadSpeed) + '/s';
            const pct        = ((downloaded / this.videoFile.length) * 100).toFixed(1);
            process.stdout.write(
              `\r[torrent] ${pct}% — ${formatBytes(downloaded)} / ${formatBytes(this.videoFile.length)} @ ${speed}   `
            );
            this.emit('progress', { downloaded, total: this.videoFile.length, speed: torrent.downloadSpeed });
          }, 500);

          torrent.on('error', (err) => {
            clearInterval(progressInterval);
            this.state = 'error';
            this.emit('error', err);
          });

          torrent.on('done', () => {
            clearInterval(progressInterval);
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

  /**
   * Attach seek-debug instrumentation for one seek operation.
   * @param {{ timeline: object, seekByte: number, startPiece: number, endPiece: number, jobId: string }} opts
   */
  beginSeekInstrumentation({ timeline, seekByte, startPiece, endPiece, jobId }) {
    this.endSeekInstrumentation();

    this._seekTimeline   = timeline;
    this._seekActive     = true;
    this._seekByte       = seekByte;
    this._seekPieceStart = startPiece;
    this._seekPieceEnd   = endPiece;
    this._seekFirstRange = true;
    this._rangeLogUntil  = Date.now() + 300_000;
    this._pendingWaits   = new Map();
    this._loggedSeekPieces = new Set();

    this._wireStorePutHook();

    if (this.torrent) {
      this._onTorrentDownload = () => {
        if (!this._seekActive || typeof this.torrent.have !== 'function') return;
        for (let p = this._seekPieceStart; p <= this._seekPieceEnd; p++) {
          if (!this.torrent.have(p) || this._loggedSeekPieces.has(p)) continue;
          this._loggedSeekPieces.add(p);
          const waitStart = this._pendingWaits.get(p);
          const waitMs    = waitStart != null ? Date.now() - waitStart : null;
          if (waitStart != null) this._pendingWaits.delete(p);

          instrLog('PIECE', 'downloaded (in seek range)', {
            jobId,
            pieceIndex: p,
            pieceSize:  this.torrent.pieceLength ?? 0,
            totalDownloaded: this.videoFile?.downloaded ?? 0,
            waitMs,
          });
          timeline?.markOnce(`piece-${p}`, 'piece available in seek range', { pieceIndex: p, waitMs });
        }
      };
      this.torrent.on('download', this._onTorrentDownload);
    }

    instrLog('seek-instrument', 'active', { jobId, seekByte: fmtBytes(seekByte), startPiece, endPiece });
  }

  endSeekInstrumentation() {
    if (this.torrent && this._onTorrentDownload) {
      this.torrent.off('download', this._onTorrentDownload);
      this._onTorrentDownload = null;
    }
    this._cancelPumpWait();
    this._seekTimeline   = null;
    this._seekActive     = false;
    this._seekByte        = null;
    this._seekPieceStart  = null;
    this._seekPieceEnd    = null;
    this._seekFirstRange  = true;
    this._pendingWaits    = new Map();
    this._loggedSeekPieces = new Set();
  }

  _wireStorePutHook() {
    if (!this.store) return;
    this.store.onPut = (chunkIndex, size) => {
      if (!this._seekActive || this._seekPieceStart == null) return;
      if (chunkIndex < this._seekPieceStart || chunkIndex > this._seekPieceEnd) return;

      const waitStart = this._pendingWaits.get(chunkIndex);
      const waitMs    = waitStart != null ? Date.now() - waitStart : null;
      if (waitStart != null) this._pendingWaits.delete(chunkIndex);

      instrLog('PIECE', 'chunk stored (in seek range)', {
        chunkIndex,
        size,
        totalDownloaded: this.videoFile?.downloaded ?? 0,
        waitMs,
      });
      this._seekTimeline?.markOnce(`store-${chunkIndex}`, 'piece stored in RAM (seek range)', {
        chunkIndex, waitMs,
      });
    };
  }

  _byteToPiece(byte) {
    if (!this.torrent?.pieceLength) return null;
    const fileOffset = this.videoFile?.offset ?? 0;
    return Math.floor((fileOffset + byte) / this.torrent.pieceLength);
  }

  _isRangeSatisfiable(start, end) {
    if (!this.store) return { satisfiable: false, reason: 'no-store' };
    if (!this.store.hasByte(start)) {
      return { satisfiable: false, reason: 'start-chunk-missing', startPiece: this._byteToPiece(start) };
    }
    // Check contiguous chunks through end (sample every chunk boundary)
    const cl = this.store.chunkLength;
    for (let b = start; b <= end; b += cl) {
      if (!this.store.hasByte(b)) {
        return { satisfiable: false, reason: 'gap-in-range', gapAt: b, piece: this._byteToPiece(b) };
      }
    }
    return { satisfiable: true };
  }

  _logRangeRequest({ rangeHeader, start, end, totalSize, isRange }) {
    const seekActive = this._seekActive;
    const seekWindow = this._seekWindowStart != null
      ? { start: this._seekWindowStart, end: this._seekWindowEnd }
      : null;
    const downloaded = this.videoFile?.downloaded ?? 0;
    const sat        = this._isRangeSatisfiable(start, end ?? totalSize - 1);

    instrLog('RANGE', isRange ? `range=${rangeHeader}` : 'non-range GET (full file)', {
      start:           fmtByteNum(start),
      end:             end != null ? fmtByteNum(end) : 'EOF',
      seekWindow,
      seekActive,
      downloaded:      fmtByteNum(downloaded),
      fileLength:      fmtByteNum(totalSize),
      satisfiable:     sat.satisfiable,
      ...(sat.satisfiable ? {} : sat),
      startPiece:      this._byteToPiece(start),
    });

    if (seekActive && start === 0) {
      instrWarn('RANGE', '⚠ read at byte 0 during active seek — MKV demuxer probes EBML header before -ss cluster seek', {
        seekByte: fmtBytes(this._seekByte),
        note: 'startSeek() NOT called on seek-ahead path; header bytes must still be in store',
        headerInStore: this.store?.hasByte(0) ?? null,
      });
      this._seekTimeline?.markOnce('range-byte0', 'HTTP range/read at byte 0 during seek', {
        start, seekByte: this._seekByte,
      });
    }

    if (seekActive && this._seekFirstRange) {
      this._seekFirstRange = false;
      this._seekTimeline?.markOnce('first-range', 'first HTTP range request (seek worker)', {
        range: rangeHeader ?? 'GET',
        start, end: end ?? 'EOF', satisfiable: sat.satisfiable,
      });
    }
  }

  /**
   * Prepare the store and HTTP server for a seek-back to `seekByte`.
   *
   * 1. Lowers the store's eviction boundary so pieces in the seek area can be
   *    re-stored when WebTorrent re-downloads them.
   * 2. Sets the dead-zone end so the HTTP server returns 416 for bytes between
   *    the preserved header and the seek area (Cues table, etc.) instead of
   *    blocking the FFmpeg read indefinitely.
   * 3. Calls torrent.critical() to prioritize pieces around seekByte.
   *
   * @param {number} seekByte - Approximate byte offset corresponding to seekTime
   */
  startSeek(seekByte) {
    const oldWindow = this._seekWindowStart != null
      ? { start: this._seekWindowStart, end: this._seekWindowEnd }
      : null;

    let evictionChange = null;
    if (this.store) {
      evictionChange = this.store.resetTo(Math.max(0, seekByte - EVICTION_SAFETY), {
        log: true,
        extra: { reason: 'startSeek' },
      });
    }

    const newWindowStart = Math.max(0, seekByte - EVICTION_SAFETY);
    const newWindowEnd   = seekByte + 30 * 1024 * 1024;

    this._seekWindowStart = newWindowStart;
    this._seekWindowEnd   = newWindowEnd;
    this._rangeLogUntil   = Date.now() + 300_000;
    this._seekActive      = true;

    instrLog('startSeek', `seekByte=${fmtBytes(seekByte)}`, {
      window: `[${fmtBytes(newWindowStart)}, ${fmtBytes(newWindowEnd)}]`,
      oldWindow,
      newWindow: { start: newWindowStart, end: newWindowEnd },
      evictionChange,
    });
    this._seekTimeline?.mark('startSeek()', {
      seekByte, windowStart: newWindowStart, windowEnd: newWindowEnd, evictionChange,
    });

    console.log(`[torrent] Seek mode: window ${this._seekWindowStart}–${this._seekWindowEnd}`);

    return this._prioritizeByteRange(seekByte, { reason: 'seek-back' });
  }

  /** Called once FFmpeg has advanced past the seek point. */
  disableSeekMode() {
    if (this._seekWindowStart !== null) {
      instrLog('startSeek', 'seek mode disabled', {
        window: { start: this._seekWindowStart, end: this._seekWindowEnd },
      });
      this._seekWindowStart = null;
      this._seekWindowEnd   = null;
      console.log('[torrent] Seek mode disabled');
    }
  }

  /**
   * Keep torrent pieces ahead of FFmpeg's current read position so the HTTP
   * pump does not stall waiting for rarest-first peers.
   * Throttled — safe to call from ffmpeg-time (fires ~1 Hz).
   */
  prioritizeEncodeReadahead(encodeSecs, durationSec, fileLength, meta = {}) {
    if (!this.torrent?.pieceLength || !this.videoFile || !durationSec || !fileLength) return null;
    const now = Date.now();
    if (now - this._lastEncodeReadaheadAt < 5000) return null;
    this._lastEncodeReadaheadAt = now;
    const readaheadSecs = 90;
    const bytePos = Math.min(
      ((encodeSecs + readaheadSecs) / durationSec) * fileLength,
      fileLength - 1,
    );
    return this._prioritizeByteRange(bytePos, { ...meta, reason: 'encode-readahead' });
  }

  _prioritizeByteRange(seekByte, meta = {}) {
    if (!this.torrent?.pieceLength || !this.videoFile) {
      seekWarn('torrent', '_prioritizeByteRange skipped — no torrent/videoFile', meta);
      return null;
    }
    const fileOffset = this.videoFile.offset ?? 0;
    const absStart   = fileOffset + Math.max(0, seekByte - 30 * 1024 * 1024);
    const absEnd     = fileOffset + seekByte + 30 * 1024 * 1024;
    const startPiece = Math.floor(absStart / this.torrent.pieceLength);
    const endPiece   = Math.min(
      Math.floor(absEnd / this.torrent.pieceLength),
      this.torrent.pieces.length - 1,
    );
    const pieceLength = this.torrent.pieceLength;

    // Snapshot which pieces are already complete before critical()
    const hadBefore = [];
    for (let p = startPiece; p <= endPiece && p <= startPiece + 5; p++) {
      if (this.torrent.pieces[p]) hadBefore.push(p);
    }

    this.torrent.critical(startPiece, endPiece);

    // FFmpeg probes the MKV EBML header at byte 0 before input -ss can take
    // effect on HTTP sources. Re-prioritize header pieces — main-stream eviction
    // may have dropped them while the user was still near t=0.
    const headerStartPiece = Math.floor(fileOffset / pieceLength);
    const headerEndPiece   = Math.min(
      Math.floor((fileOffset + 4 * 1024 * 1024) / pieceLength),
      this.torrent.pieces.length - 1,
    );
    if (headerEndPiece >= headerStartPiece) {
      this.torrent.critical(headerStartPiece, headerEndPiece);
    }

    this._rangeLogUntil = Date.now() + 300_000;

    instrLog('priority', `seekByte=${fmtBytes(seekByte)}`, {
      ...meta,
      pieceLength,
      startPiece,
      endPiece,
      pieceCount: endPiece - startPiece + 1,
      sampleHadBefore: hadBefore,
      downloaded: fmtByteNum(this.videoFile.downloaded ?? 0),
      fileLength: fmtByteNum(this.videoFile.length),
      criticalAccepted: true,
    });
    this._seekTimeline?.mark('prioritize pieces', {
      seekByte, startPiece, endPiece, pieceLength,
    });

    console.log(`[torrent] Seek priority: pieces ${startPiece}–${endPiece}`);
    return { startPiece, endPiece, seekByte, pieceLength };
  }

  _isByteAllowed(start) {
    if (!this.store) return true;

    const headerEnd = this.store.HEADER_PRESERVE_CHUNKS * this.store.chunkLength;
    if (start < headerEnd) return true;

    if (this._seekWindowStart !== null) {
      return start >= this._seekWindowStart && start <= this._seekWindowEnd;
    }

    return true;
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
    this._bufferEmitted   = false;
    this._seekWindowStart = null;
    this._seekWindowEnd   = null;
    this.endSeekInstrumentation();
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
   * Pump bytes [fromByte, endByte] into `res`, retrying when the read stream
   * ends before reaching endByte. This happens when store.get() returns an
   * error for a piece not yet downloaded — WebTorrent ends the read stream at
   * the current piece boundary. We wait for the torrent's next 'download' event
   * (any new piece arriving) then resume from where we left off, giving FFmpeg
   * a continuous byte stream without EOF.
   */
  _pumpBytes(res, fromByte, endByte, reqMeta = {}) {
    if (res.destroyed || !this.videoFile) return;

    const verbose = this._seekActive || Date.now() < this._rangeLogUntil;
    const pumpT0  = Date.now();
    const startPiece = this._byteToPiece(fromByte);

    if (verbose && startPiece != null && !this.store?.hasByte(fromByte)) {
      if (!this._pendingWaits.has(startPiece)) {
        this._pendingWaits.set(startPiece, pumpT0);
        instrLog('RANGE', 'waiting for piece', {
          pieceIndex: startPiece,
          resumeAt:   fmtByteNum(fromByte),
          needUntil:  fmtByteNum(endByte),
          ...reqMeta,
        });
        this._seekTimeline?.markOnce(`wait-${startPiece}`, 'HTTP pump waiting for piece', {
          pieceIndex: startPiece, fromByte,
        });
      }
    }

    // Node.js 18+ streams have autoDestroy:true — on error they call destroy()
    // which triggers FileStream.destroy() → torrent.deselect() → the file
    // stops downloading entirely. Re-select here to undo that, then mark the
    // specific pieces FFmpeg needs as critical so they're fetched before any
    // rarest-first pieces.
    if (this.videoFile && this.torrent) {
      this.videoFile.select();
      if (this.torrent.pieceLength) {
        const absoluteByte = (this.videoFile.offset ?? 0) + fromByte;
        const piece = Math.floor(absoluteByte / this.torrent.pieceLength);
        this.torrent.critical(piece, Math.min(piece + 16, this.torrent.pieces.length - 1));
      }
    }

    const s = this.videoFile.createReadStream({ start: fromByte, end: endByte });

    s.on('data', (chunk) => {
      fromByte += chunk.length;
      if (!res.write(chunk)) {
        s.pause();
        res.once('drain', () => s.resume());
      }
    });

    const retry = (reason) => {
      if (res.destroyed || !this.torrent) return;
      const neededPiece = this._byteToPiece(fromByte);
      if (neededPiece != null && !this._pendingWaits.has(neededPiece)) {
        this._pendingWaits.set(neededPiece, Date.now());
      }

      const available = this._isPieceReadyForByte(fromByte);
      console.log('[PIECE WAIT]', { neededPiece, available, reason, resumeAt: fromByte });
      instrLog('PIECE', 'wait', { neededPiece, available, reason, resumeAt: fmtByteNum(fromByte) });

      if (available) {
        console.log('[PIECE READY]', { piece: neededPiece });
        instrLog('PIECE', 'ready (immediate)', { piece: neededPiece });
        if (neededPiece != null) this._pendingWaits.delete(neededPiece);
        this._pumpBytes(res, fromByte, endByte, reqMeta);
        return;
      }

      if (verbose) {
        instrLog('RANGE', 'pump stalled — waiting for required piece', {
          reason,
          pieceIndex: neededPiece,
          resumeAt:   fmtByteNum(fromByte),
          needUntil:  fmtByteNum(endByte),
          waitedMs:   Date.now() - pumpT0,
          ...reqMeta,
        });
      }

      this._cancelPumpWait();
      this._pumpWaitHandler = () => {
        if (res.destroyed || !this.torrent) {
          this._cancelPumpWait();
          return;
        }
        const piece = this._byteToPiece(fromByte);
        if (!this._isPieceReadyForByte(fromByte)) return;

        this._cancelPumpWait();
        const waitMs = piece != null && this._pendingWaits.has(piece)
          ? Date.now() - this._pendingWaits.get(piece)
          : null;
        if (piece != null) this._pendingWaits.delete(piece);

        console.log('[PIECE READY]', { piece, waitMs });
        instrLog('PIECE', 'ready', { piece, waitMs, resumeAt: fmtByteNum(fromByte) });
        if (verbose) {
          instrLog('RANGE', 'resuming pump after required piece', {
            pieceIndex: piece,
            waitMs,
            resumeAt: fmtByteNum(fromByte),
            ...reqMeta,
          });
        }
        this._pumpBytes(res, fromByte, endByte, reqMeta);
      };
      this.torrent.on('download', this._pumpWaitHandler);
    };

    s.on('error', () => retry('stream-error'));

    s.on('end', () => {
      if (fromByte <= endByte) {
        retry('stream-end-early');
      } else {
        if (verbose) {
          instrLog('RANGE', 'pump complete', {
            deliveredUntil: fmtByteNum(fromByte),
            durationMs: Date.now() - pumpT0,
            ...reqMeta,
          });
        }
        res.end();
      }
    });
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

        const start = parseInt(match[1], 10);
        const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;

        this._logRangeRequest({ rangeHeader, start, end, totalSize, isRange: true });

        // Restricted mode (seek restart active): 416 outside allowed ranges.
        if (this.store && this._seekWindowStart !== null) {
          if (!this._isByteAllowed(start)) {
            instrWarn('RANGE', '416 — byte outside seek-back window', {
              start: fmtByteNum(start),
              windowStart: fmtByteNum(this._seekWindowStart),
              windowEnd:   fmtByteNum(this._seekWindowEnd),
            });
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
            res.end();
            return;
          }
        }

        // No Content-Length on range responses — see comment above.
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Type':  mime,
        });

        this._pumpBytes(res, start, end, { range: rangeHeader });
      } else {
        // Non-range GET: FFmpeg initial probe. No Content-Length — see above.
        this._logRangeRequest({ rangeHeader: null, start: 0, end: totalSize - 1, totalSize, isRange: false });

        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Type':  mime,
        });
        this._pumpBytes(res, 0, totalSize - 1, { range: 'GET-full' });
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
