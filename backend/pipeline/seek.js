/**
 * pipeline/seek.js — SeekWorkerManager
 *
 * Manages parallel FFmpeg processes that generate segments near a seek target
 * before the main encoder reaches that position.
 *
 * Lifecycle:
 *   1. POST /torrent/seek → SeekWorkerManager.startWorker()
 *   2. Parallel FFmpeg writes to a temp dir under hlsPath
 *   3. Watcher parses TFDT from each new .m4s → renames → copies to hlsPath
 *   4. Renamed segment is registered in timeline → emits segment:ready
 *   5. Worker auto-stops when main encoder surpasses workerSeekTime + WINDOW
 *
 * Segment naming:
 *   First seek segment → predicted name `segment_t<seekOffset_ms>.m4s`
 *   Subsequent segments → `segment_t<tfdt_ms>.m4s` from actual TFDT
 *
 * The predicted name matches what the frontend's _predictSeekSegmentId()
 * computes, so the optimistic prefetch succeeds without a covering-poll roundtrip.
 */

import fs   from 'fs';
import path from 'path';
import { HlsGenerator }      from './ffmpeg.js';
import { readSegmentTiming } from './fmp4.js';
import { toSegmentPayload }  from '../core/timeline.js';
import { log, warn }         from '../logger.js';

const NS = 'seek';

// How far ahead of the seek target to keep the worker alive.
const WORKER_WINDOW_SEC = 60;
// Max concurrent seek workers per session.
const MAX_SEEK_WORKERS  = 2;
// Polling interval for new segment files (ms).
const POLL_MS = 200;
// Delay after seeing a segment open event before reading (FFmpeg may still be writing).
const READ_DELAY_MS = 120;

export class SeekWorkerManager {
  /**
   * @param {object} session   Session object from SessionManager
   */
  constructor(session) {
    this.session = session;
    this._workers = new Map(); // jobId → worker state
    this._jobCounter = 0;
  }

  /**
   * Start a seek worker for the given target time.
   * Returns the jobId and approximate startTime for the first segment.
   *
   * @param {number} seekTime   Target media time in seconds
   * @param {number} seekByte   Estimated byte offset for piece prioritization
   */
  async startWorker(seekTime, seekByte) {
    // Kill existing workers to limit concurrency.
    if (this._workers.size >= MAX_SEEK_WORKERS) {
      const oldest = [...this._workers.keys()][0];
      await this.killWorker(oldest);
    }

    const jobId    = `seek_${++this._jobCounter}_${Date.now()}`;
    const seekDir  = path.join(this.session.hlsPath + '_seek', jobId);
    const seekOffset = Math.max(0, seekTime - 2); // start 2s before target for preroll

    await fs.promises.mkdir(seekDir, { recursive: true });

    // Prioritize torrent pieces at the seek byte.
    if (seekByte != null && this.session.torrentManager) {
      const window = this.session.videoFile?.length
        ? Math.min(50 * 1024 * 1024, this.session.videoFile.length - seekByte)
        : 50 * 1024 * 1024;
      this.session.torrentManager.prioritizeRange(seekByte, seekByte + window);
    }

    const generator = new HlsGenerator({ label: jobId });
    const worker = {
      jobId,
      seekTime,
      seekOffset,
      seekDir,
      generator,
      state:             'starting',
      segmentsGenerated: 0,
      startedAt:         Date.now(),
      stopPoll:          null,
      isFirstSegment:    true,
    };

    this._workers.set(jobId, worker);

    // Start FFmpeg seek worker (non-blocking — runs in background).
    generator.start(
      this.session.internalUrl,
      this.session.videoFile?.name ?? 'video.mkv',
      seekDir,
      this.session.codecInfo,
      seekOffset,
      true // isSeekWorker
    ).catch(e => {
      warn(NS, `Worker ${jobId} error: ${e.message}`);
      worker.state = 'error';
      this._cleanupWorker(jobId);
    }).then(() => {
      if (worker.state !== 'stopped') {
        worker.state = 'done';
        this._cleanupWorker(jobId);
      }
    });

    worker.state = 'running';
    this._watchDir(worker);

    log(NS, `Worker ${jobId} started seekTime=${seekTime} offset=${seekOffset}`);
    return { jobId, startTime: seekOffset, endTime: seekOffset + 2 };
  }

  async killWorker(jobId) {
    const worker = this._workers.get(jobId);
    if (!worker) return;
    worker.state = 'stopped';
    worker.stopPoll?.();
    worker.generator.stop();
    await this._cleanupWorker(jobId);
    log(NS, `Worker ${jobId} killed`);
  }

  /** Called by the main FFmpeg time event — cleans up workers that are no longer needed. */
  cleanupExpired(mainTime) {
    for (const [jobId, worker] of this._workers) {
      if (mainTime > worker.seekTime + WORKER_WINDOW_SEC) {
        this.killWorker(jobId);
      }
    }
  }

  getWorkerStats() {
    return [...this._workers.values()].map(w => ({
      jobId:             w.jobId,
      seekTime:          w.seekTime,
      state:             w.state,
      segmentsGenerated: w.segmentsGenerated,
      elapsedMs:         Date.now() - w.startedAt,
    }));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _watchDir(worker) {
    const session  = this.session;
    const { seekDir, jobId } = worker;
    const timescale = session.videoTimescale ?? 90000;

    const seen = new Set();

    const poll = () => {
      if (worker.state !== 'running') return;

      let files;
      try { files = fs.readdirSync(seekDir); } catch { return; }

      for (const file of files) {
        if (!file.endsWith('.m4s') || file.startsWith('seek_init') || seen.has(file)) continue;
        seen.add(file);

        const fullPath = path.join(seekDir, file);
        // Short delay to let FFmpeg finish writing.
        setTimeout(() => this._processSegment(worker, fullPath, timescale), READ_DELAY_MS);
      }
    };

    const timer = setInterval(poll, POLL_MS);
    worker.stopPoll = () => clearInterval(timer);
  }

  async _processSegment(worker, segPath, timescale) {
    if (worker.state !== 'running') return;

    // Retry until we can parse the TFDT (file might still be written).
    let timing = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      timing = await readSegmentTiming(segPath, timescale);
      if (timing) break;
      await sleep(80);
    }

    if (!timing) {
      warn(NS, `Could not parse TFDT from ${segPath}`);
      return;
    }

    const session = this.session;

    // Determine output filename.
    let destName;
    if (worker.isFirstSegment) {
      // Use predicted name so the frontend's optimistic prefetch finds it.
      destName = `segment_t${Math.round(worker.seekOffset * 1000)}.m4s`;
      worker.isFirstSegment = false;
    } else {
      destName = `segment_t${Math.round(timing.startTime * 1000)}.m4s`;
    }

    const destPath = path.join(session.hlsPath, destName);

    try {
      await fs.promises.copyFile(segPath, destPath);
      await fs.promises.unlink(segPath);
    } catch (e) {
      warn(NS, `Failed to move seek segment: ${e.message}`);
      return;
    }

    worker.segmentsGenerated++;

    // Register in timeline (authoritative).
    const entry = session.timeline.register({
      file:      destName,
      startTime: timing.startTime,
      endTime:   timing.endTime,
      source:    'seek',
    });

    // Emit segment:ready so the SSE feed delivers it to the frontend.
    session.events.emit('segment:ready', toSegmentPayload(entry));

    log(NS, `Segment ${destName} [${timing.startTime.toFixed(2)}–${timing.endTime.toFixed(2)}s]`);
  }

  async _cleanupWorker(jobId) {
    const worker = this._workers.get(jobId);
    if (!worker) return;

    worker.stopPoll?.();
    this._workers.delete(jobId);

    // Best-effort cleanup of temp seek dir.
    try {
      await fs.promises.rm(worker.seekDir, { recursive: true, force: true });
    } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
