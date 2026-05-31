/**
 * session/manager.js — Per-user session registry
 *
 * Sessions are keyed by sessionId. Multiple users watching the same torrent
 * share one session (the second user joins via getByInfoHash). The HLS output
 * directory for every session is the persistent segment cache directory
 * (cache/segments/<infoHash>/), so transcoded segments survive session teardown
 * and can be served to future viewers without re-running FFmpeg.
 *
 * LIFECYCLE:
 *   create() → torrentManager.start() → generator.start() → viewers > 0
 *   removeViewer() → viewers reaches 0 → idle timer fires → destroy()
 *
 * destroy() stops FFmpeg + WebTorrent but does NOT delete the HLS directory —
 * that lives in the persistent SegmentCache and is managed by SegmentCache.evict().
 */

import fs              from 'fs';
import crypto           from 'crypto';
import { EventEmitter }  from 'events';
import { SegmentRegistry } from '../cache/segment-registry.js';
import { SegmentTimelineRegistry } from '../timeline/segment-registry.js';
import { SegmentTrace } from '../instrumentation/segment-trace.js';
import { seekLog } from '../logger.js';

export class SessionManager {
  /**
   * @param {string}        cacheDir     - Absolute path to the cache root
   * @param {SegmentCache}  segmentCache - Persistent segment cache instance
   */
  constructor(cacheDir, segmentCache) {
    this.cacheDir     = cacheDir;
    this.segmentCache = segmentCache;
    this._sessions    = new Map();
    this._cleanupTimer = null;
  }

  // ─── READ ─────────────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  has(sessionId) {
    return this._sessions.has(sessionId);
  }

  /** @returns {object|undefined} */
  get(sessionId) {
    return this._sessions.get(sessionId);
  }

  /** Alias — keeps stream.js callers readable. */
  getBySessionId(sessionId) {
    return this._sessions.get(sessionId);
  }

  /**
   * Find the first non-errored session for the given infoHash.
   * Used to share a session between multiple users watching the same torrent.
   * @returns {object|undefined}
   */
  getByInfoHash(infoHash) {
    for (const session of this._sessions.values()) {
      if (session.infoHash === infoHash && session.state !== 'error') {
        return session;
      }
    }
    return undefined;
  }

  /** @returns {object[]} */
  all() {
    return [...this._sessions.values()];
  }

  // ─── WRITE ────────────────────────────────────────────────────────────────────

  /**
   * Allocate a new session record.
   * Does NOT start downloading or transcoding — just builds the object.
   *
   * @param {string} magnetUri
   * @returns {object}
   */
  create(magnetUri) {
    const sessionId = Date.now().toString();
    const infoHash  = extractInfoHash(magnetUri);

    const session = {
      infoHash,
      magnetUri,
      sessionId,
      torrentManager: null,
      generator:      null,
      viewers:        0,
      // Points to the persistent cache dir — shared across all sessions for this torrent.
      hlsPath:        this.segmentCache.dir(infoHash),
      codecInfo:      null,
      mode:           null,      // 'remux' | 'transcode' | 'cached'
      state:          'initializing',
      videoFile:      null,
      internalUrl:    null,
      createdAt:      Date.now(),
      lastAccessed:   Date.now(),
      events:         new EventEmitter(),
      lastProgress:   null,
      viewerTimes:    new Map(),
      lastSegmentIdx: -1,      // compat: highest index registered (derived from TFDT)
      mainLastTime:   0,       // authoritative: latest ffmpeg-time in seconds
      seekWorkers:    new Map(),   // jobId → { gen, tempDir, segStart, lastUsed }
      _ffmpegSpeed:   5.0,         // video-seconds per real-second; updated in wireMainFfmpegTime
      registry:       new SegmentRegistry(),
      timeline:       new SegmentTimelineRegistry(), // THE clock — one per session
      segmentTrace:   new SegmentTrace(sessionId),
      unwatchMainHls: null,
    };

    this._sessions.set(sessionId, session);
    console.log(`[session] Created ${sessionId} (infoHash=${infoHash ?? 'unknown'})`);
    return session;
  }

  /** Reset the idle timer — viewer is actively fetching. */
  touch(sessionId) {
    const s = this._sessions.get(sessionId);
    if (s) s.lastAccessed = Date.now();
  }

  /**
   * Register a new viewer. Returns a unique viewerId the client must include
   * in all subsequent status polls and the stop request.
   * @returns {string} viewerId
   */
  addViewer(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    s.viewers += 1;
    s.lastAccessed = Date.now();
    const viewerId = crypto.randomBytes(6).toString('hex');
    s.viewerTimes.set(viewerId, 0);
    console.log(`[session] ${sessionId} viewers: ${s.viewers}`);
    return viewerId;
  }

  /**
   * Update the recorded playback position for one viewer.
   * Called on every status poll — used to track active viewer ranges for
   * SegmentCache eviction protection.
   */
  updateViewerTime(sessionId, viewerId, currentTime) {
    const s = this._sessions.get(sessionId);
    if (s && viewerId && s.viewerTimes.has(viewerId)) {
      s.viewerTimes.set(viewerId, currentTime);
    }
  }

  removeViewer(sessionId, viewerId = null) {
    const s = this._sessions.get(sessionId);
    if (s && s.viewers > 0) {
      s.viewers -= 1;
      s.lastAccessed = Date.now();
      if (viewerId) s.viewerTimes.delete(viewerId);
      console.log(`[session] ${sessionId} viewers: ${s.viewers}`);
    }
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  /**
   * Tear down a session:
   *   1. Stop FFmpeg
   *   2. Stop WebTorrent + internal HTTP server
   *   3. Remove from the Map
   *
   * Does NOT delete the HLS directory — segments live in the persistent cache
   * and are managed by SegmentCache.evict().
   */
  async destroy(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    console.log(`[session] Destroying ${sessionId}`);

    if (session.seekWorker) {
      seekLog('session', 'destroy: stopping seek worker', {
        sessionId, tempDir: session.seekWorkerTempDir,
      });
      try { session.seekWorker.stop(); } catch (e) { console.warn('[session] seekWorker.stop():', e.message); }
      if (session.seekWorkerTempDir) {
        try { fs.rmSync(session.seekWorkerTempDir, { recursive: true, force: true }); } catch {}
      }
    }

    for (const [, w] of session.seekWorkers) {
      try { w.gen.stop(); } catch (e) { console.warn('[session] seekWorker.stop():', e.message); }
    }

    if (session.generator) {
      try { session.generator.stop(); } catch (e) { console.warn('[session] generator.stop():', e.message); }
    }

    if (session.torrentManager) {
      try { await session.torrentManager.stop(); } catch (e) { console.warn('[session] torrentManager.stop():', e.message); }
    }

    session.unwatchMainHls?.();
    session.segmentTrace?.summary('session destroy');

    this._sessions.delete(sessionId);
    console.log(`[session] ${sessionId} destroyed`);
  }

  // ─── CLEANUP TIMER ────────────────────────────────────────────────────────────

  /**
   * Start a background interval that destroys sessions idle for `idleMs`.
   * Safety net for users who close their browser tab without calling /torrent/stop.
   */
  startCleanup(idleMs = 5 * 60 * 1000) {
    if (this._cleanupTimer) return;

    this._cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const session of this._sessions.values()) {
        if (session.viewers === 0 && (now - session.lastAccessed) > idleMs) {
          console.log(`[session] Idle cleanup: destroying ${session.sessionId}`);
          await this.destroy(session.sessionId);
        }
      }
    }, 60_000);

    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    console.log(`[session] Cleanup timer started (idleMs=${idleMs})`);
  }

  stopCleanup() {
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
  }
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

/**
 * Extract the lower-cased infoHash from a magnet URI.
 *
 * @param {string} magnetUri
 * @returns {string|null}
 */
export function extractInfoHash(magnetUri) {
  const m = magnetUri.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}
