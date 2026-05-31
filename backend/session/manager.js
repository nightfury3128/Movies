/**
 * session/manager.js — per-torrent session registry.
 *
 * One session per active infoHash. Multiple viewers can join an existing
 * session, sharing one download + one FFmpeg process.
 *
 * Session lifecycle:
 *   create() → state: 'initializing'
 *   pipeline starts → state: 'streaming'
 *   last viewer leaves → idle timer starts (2 min)
 *   idle timer fires → destroy()
 *
 * HLS output lives at cache/segments/<infoHash>/ and persists after destroy()
 * so future viewers can be served from cache without re-downloading.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { SegmentTimelineRegistry } from '../core/timeline.js';
import { SegmentCache } from '../cache/segment-cache.js';
import { log } from '../logger.js';

const NS = 'session';
const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export class SessionManager {
  constructor(segmentCache) {
    this._sessions = new Map(); // sessionId → session
    this.segmentCache = segmentCache;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getBySessionId(id)  { return this._sessions.get(id); }

  getByInfoHash(infoHash) {
    for (const s of this._sessions.values()) {
      if (s.infoHash === infoHash && s.state !== 'error' && s.state !== 'stopped') return s;
    }
    return undefined;
  }

  all() { return [...this._sessions.values()]; }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Allocate a new session. Does NOT start the pipeline.
   */
  create(magnetUri) {
    const sessionId = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const infoHash  = extractInfoHash(magnetUri);
    const hlsPath   = this.segmentCache.dir(infoHash);

    const session = {
      sessionId,
      infoHash,
      magnetUri,
      hlsPath,
      state:          'initializing',
      mode:           null,
      codecInfo:      null,
      videoFile:      null,
      internalUrl:    null,
      videoTimescale: 90000,  // updated from init.mp4 after FFmpeg starts
      mimeType:       'video/mp4; codecs="avc1.64001f,mp4a.40.2"',

      // Resources (set by startPipeline)
      torrentManager: null,
      generator:      null,
      seekWorkerMgr:  null,

      // Timeline — the authoritative media clock
      timeline: new SegmentTimelineRegistry(hlsPath + '/timeline.json'),

      // Viewer tracking
      viewers:     0,
      viewerTimes: new Map(),

      // Encoder state
      mainLastTime: 0,
      lastProgress: null,

      // Cleanup
      _idleTimer:    null,
      _stopWatcher:  null,

      // Events bus
      events: new EventEmitter(),
    };

    session.events.setMaxListeners(50);
    session.timeline.load(); // recover from previous run if file exists

    this._sessions.set(sessionId, session);
    log(NS, `Created ${sessionId} infoHash=${infoHash ?? '?'}`);
    return session;
  }

  touch(sessionId) {
    const s = this._sessions.get(sessionId);
    if (s) s.lastAccessed = Date.now();
  }

  addViewer(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;

    if (s._idleTimer) { clearTimeout(s._idleTimer); s._idleTimer = null; }

    s.viewers++;
    const viewerId = crypto.randomBytes(6).toString('hex');
    s.viewerTimes.set(viewerId, 0);
    this.segmentCache.touch(s.infoHash);
    log(NS, `${sessionId} viewers=${s.viewers} (+${viewerId})`);
    return viewerId;
  }

  removeViewer(sessionId, viewerId) {
    const s = this._sessions.get(sessionId);
    if (!s) return;

    s.viewerTimes.delete(viewerId);
    s.viewers = Math.max(0, s.viewers - 1);
    log(NS, `${sessionId} viewers=${s.viewers} (-${viewerId})`);

    if (s.viewers <= 0) {
      s._idleTimer = setTimeout(() => this._destroy(sessionId), IDLE_TIMEOUT_MS);
    }
  }

  updateViewerTime(sessionId, viewerId, currentTime) {
    const s = this._sessions.get(sessionId);
    if (s && viewerId && s.viewerTimes.has(viewerId)) {
      s.viewerTimes.set(viewerId, currentTime);
    }
  }

  async _destroy(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return;

    log(NS, `Destroying ${sessionId}`);
    s.state = 'stopped';

    // Stop the watcher
    s._stopWatcher?.();

    // Stop seek workers
    if (s.seekWorkerMgr) {
      for (const [id] of s.seekWorkerMgr._workers) {
        await s.seekWorkerMgr.killWorker(id).catch(() => {});
      }
    }

    // Stop FFmpeg
    s.generator?.stop();

    // Stop WebTorrent (last — FFmpeg may still be reading)
    if (s.torrentManager) {
      setTimeout(() => s.torrentManager.stop().catch(() => {}), 500);
    }

    this._sessions.delete(sessionId);
  }
}

/** Extract infoHash from magnet URI. */
export function extractInfoHash(magnet) {
  const m = /[?&]xt=urn:btih:([a-fA-F0-9]{40})/i.exec(magnet)
    ?? /[?&]xt=urn:btih:([a-zA-Z2-7]{32})/i.exec(magnet);
  return m ? m[1].toLowerCase() : null;
}
