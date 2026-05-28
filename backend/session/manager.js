/**
 * session/manager.js — Per-user session registry
 *
 * WHY PER-USER SESSIONS (NOT SHARED BY infoHash)?
 * The previous design keyed sessions by infoHash so two users requesting the
 * same movie would share one download and one FFmpeg process. This caused a
 * fatal interaction with the rolling HLS window (-hls_list_size 6): FFmpeg
 * deleted old segments as it advanced, so the first user's player got 404s on
 * segments the second user's progress had already caused to be purged — the
 * stream died after ~24 seconds for whoever fell behind.
 *
 * The fix is to give every /torrent/start request its own independent session:
 * its own WebTorrent client, its own FFmpeg process, its own HLS directory.
 * Sessions are therefore keyed by sessionId (a timestamp-based opaque token)
 * rather than infoHash.
 *
 * RESOURCE COST:
 * Two users watching the same torrent will each download it independently and
 * each run a separate FFmpeg process. That doubles bandwidth and CPU compared
 * to a shared-session model. For 5–10 users watching DIFFERENT content (the
 * stated goal), this is a non-issue.
 *
 * LIFECYCLE:
 *   create() → torrentManager.start() → generator.start() → viewers > 0
 *   removeViewer() → viewers reaches 0 → idle timer fires → destroy()
 */

import path from 'path';
import fs   from 'fs';

export class SessionManager {
  /**
   * @param {string} cacheDir - Absolute path to the cache root (e.g. <root>/cache)
   */
  constructor(cacheDir) {
    this.cacheDir = cacheDir;

    // Primary (and only) index: sessionId → session.
    // infoHash is stored inside the session for logging but is NOT a lookup key.
    this._sessions = new Map();

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
    const infoHash  = extractInfoHash(magnetUri); // stored for display only

    const session = {
      infoHash,                  // reference only — NOT a lookup key
      magnetUri,
      sessionId,
      torrentManager: null,
      generator:      null,
      viewers:        0,
      hlsPath:        path.join(this.cacheDir, 'hls', sessionId),
      codecInfo:      null,
      mode:           null,      // 'remux' | 'transcode'
      state:          'initializing',
      videoFile:      null,
      internalUrl:    null,
      createdAt:      Date.now(),
      lastAccessed:   Date.now(),
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

  addViewer(sessionId) {
    const s = this._sessions.get(sessionId);
    if (s) {
      s.viewers += 1;
      s.lastAccessed = Date.now();
      console.log(`[session] ${sessionId} viewers: ${s.viewers}`);
    }
  }

  removeViewer(sessionId) {
    const s = this._sessions.get(sessionId);
    if (s && s.viewers > 0) {
      s.viewers -= 1;
      s.lastAccessed = Date.now();
      console.log(`[session] ${sessionId} viewers: ${s.viewers}`);
    }
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  /**
   * Fully tear down a session:
   *   1. Stop FFmpeg
   *   2. Stop WebTorrent + internal HTTP server
   *   3. Delete the HLS output directory
   *   4. Remove from the Map
   */
  async destroy(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    console.log(`[session] Destroying ${sessionId}`);

    if (session.generator) {
      try { session.generator.stop(); } catch (e) { console.warn('[session] generator.stop():', e.message); }
    }

    if (session.torrentManager) {
      try { await session.torrentManager.stop(); } catch (e) { console.warn('[session] torrentManager.stop():', e.message); }
    }

    try {
      fs.rmSync(session.hlsPath, { recursive: true, force: true });
    } catch (e) {
      console.warn('[session] rmSync:', e.message);
    }

    this._sessions.delete(sessionId);
    console.log(`[session] ${sessionId} destroyed`);
  }

  // ─── CLEANUP TIMER ────────────────────────────────────────────────────────────

  /**
   * Start a background interval that destroys sessions idle for `idleMs`.
   * This is the safety net for users who close their browser tab without
   * calling /torrent/stop.
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
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

/**
 * Extract the lower-cased infoHash from a magnet URI.
 * Used for validation (400 on invalid magnet) and display only.
 *
 * @param {string} magnetUri
 * @returns {string|null}
 */
export function extractInfoHash(magnetUri) {
  const m = magnetUri.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}
