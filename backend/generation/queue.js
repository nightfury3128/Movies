/**
 * generation/queue.js
 *
 * On-demand HLS segment generation with deduplication and batching.
 *
 * When a viewer requests segment N that is not on disk:
 *   1. A batch job for segments N..N+BATCH_SIZE-1 is created.
 *   2. Concurrent requests for any segment in the same batch join the same job.
 *   3. One FFmpeg process generates the entire batch.
 *   4. A per-segment poller resolves each waiter as soon as its file appears on disk
 *      — viewers don't need to wait for the full batch.
 *
 * A global worker pool caps concurrent FFmpeg processes.
 * Each infoHash has its own FIFO sub-queue so one popular movie cannot starve others.
 */

import { spawn }       from 'child_process';
import path            from 'path';
import fs              from 'fs';
import { EventEmitter } from 'events';
import { SEG_DURATION, BATCH_SIZE, INIT_IDX } from '../cache/segment-cache.js';

const MAX_WORKERS        = 3;          // max concurrent FFmpeg processes
const JOB_TIMEOUT_MS     = 120_000;    // 2 min hard cap per batch
const SEG_POLL_INTERVAL  = 150;        // ms between "is the file ready?" polls

export class GenerationQueue extends EventEmitter {
  constructor(segmentCache) {
    super();
    this.cache = segmentCache;

    // batchKey `${infoHash}:${batchStart}` → Job
    this._jobs = new Map();

    // Per-infoHash FIFO queues of pending jobs
    this._queues = new Map();   // infoHash → Job[]

    this._running = 0;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Ensure segment `segIndex` for `infoHash` will be generated.
   * Returns a Promise that resolves when the file exists on disk.
   * Multiple callers for the same batch share one job and one Promise.
   *
   * @param {object} session  - Active TorrentSession
   * @param {number} segIndex
   * @returns {Promise<void>}
   */
  requestSegment(session, segIndex) {
    const { infoHash } = session;

    // Already on disk — resolve immediately
    if (this.cache.hasSegment(infoHash, segIndex)) return Promise.resolve();

    const batchStart = Math.floor(segIndex / BATCH_SIZE) * BATCH_SIZE;
    const batchKey   = `${infoHash}:${batchStart}`;

    // Reuse existing job for this batch
    if (this._jobs.has(batchKey)) {
      return this._waitForSegment(this._jobs.get(batchKey), infoHash, segIndex);
    }

    const job = this._makeJob(session, batchStart, batchKey);
    this._jobs.set(batchKey, job);
    this._enqueue(infoHash, job);

    return this._waitForSegment(job, infoHash, segIndex);
  }

  /**
   * Ensure init.mp4 exists. Triggers generation of the first batch if needed.
   */
  requestInit(session) {
    if (this.cache.hasInit(session.infoHash)) return Promise.resolve();
    return this.requestSegment(session, 0).then(() => {
      if (!this.cache.hasInit(session.infoHash)) {
        throw new Error('init.mp4 not produced by first batch');
      }
    });
  }

  /**
   * Cancel all jobs for an infoHash (called on session destroy/hibernate).
   */
  cancelAll(infoHash) {
    // Kill running jobs
    for (const [key, job] of this._jobs) {
      if (job.infoHash !== infoHash) continue;
      if (job.proc) { try { job.proc.kill('SIGTERM'); } catch {} }
      job.cancelled = true;
      job._reject(new Error('Session cancelled'));
      this._jobs.delete(key);
    }
    // Clear queued jobs
    if (this._queues.has(infoHash)) {
      for (const job of this._queues.get(infoHash)) {
        job.cancelled = true;
        job._reject(new Error('Session cancelled'));
      }
      this._queues.delete(infoHash);
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _makeJob(session, batchStart, batchKey) {
    let _resolve, _reject;
    const done = new Promise((res, rej) => { _resolve = res; _reject = rej; });

    const totalSegs   = session.totalSegs ?? Infinity;
    const batchEnd    = Math.min(batchStart + BATCH_SIZE - 1, totalSegs - 1);

    return {
      batchKey,
      infoHash:   session.infoHash,
      batchStart,
      batchEnd,
      session,
      status:     'pending',   // pending | running | done | failed | cancelled
      proc:       null,
      done,
      _resolve,
      _reject,
      cancelled:  false,
    };
  }

  _enqueue(infoHash, job) {
    if (!this._queues.has(infoHash)) this._queues.set(infoHash, []);
    this._queues.get(infoHash).push(job);
    this._drain();
  }

  _drain() {
    while (this._running < MAX_WORKERS) {
      // Round-robin across infoHashes to prevent one movie hogging all workers
      const activeQueues = [...this._queues.values()].filter(q => q.length > 0);
      if (activeQueues.length === 0) break;

      // Pick the queue that has waited longest (its first job was enqueued first)
      activeQueues.sort((a, b) => a[0].batchStart - b[0].batchStart);
      const queue = activeQueues[0];
      const job   = queue.shift();

      // Remove empty queue
      const ih = job.infoHash;
      if (this._queues.get(ih)?.length === 0) this._queues.delete(ih);

      if (job.cancelled) continue;
      this._runJob(job);
    }
  }

  async _runJob(job) {
    this._running++;
    job.status = 'running';

    const { infoHash, batchStart, batchEnd } = job;
    const startSec    = batchStart * SEG_DURATION;
    const batchDurSec = (batchEnd - batchStart + 1) * SEG_DURATION;

    this.cache.ensureDir(infoHash);
    console.log(`[gen] ${infoHash.slice(0, 8)} batch ${batchStart}–${batchEnd} t=${startSec}s`);

    try {
      await this._spawnBatch(job, startSec, batchDurSec);

      // Register everything FFmpeg wrote
      if (this.cache.hasInit(infoHash)) this.cache.register(infoHash, INIT_IDX);
      for (let i = batchStart; i <= batchEnd; i++) {
        if (this.cache.hasSegment(infoHash, i)) this.cache.register(infoHash, i);
      }

      job.status = 'done';
      job._resolve();
      this.emit('batch:done', { infoHash, batchStart, batchEnd });
    } catch (err) {
      if (!job.cancelled) {
        console.error(`[gen] batch ${batchStart} failed: ${err.message}`);
        job.status = 'failed';
        job._reject(err);
      }
    } finally {
      this._jobs.delete(job.batchKey);
      this._running--;
      this._drain();
    }
  }

  /** Resolves when segment `segIndex` is on disk, or when the job finishes/fails. */
  _waitForSegment(job, infoHash, segIndex) {
    if (this.cache.hasSegment(infoHash, segIndex)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + JOB_TIMEOUT_MS;

      const poll = () => {
        if (this.cache.hasSegment(infoHash, segIndex)) return resolve();

        if (job.status === 'done') {
          // Batch complete — segment beyond end of content is OK
          return resolve();
        }
        if (job.status === 'failed' || job.cancelled) {
          return reject(new Error(`Generation failed for segment ${segIndex}`));
        }
        if (Date.now() >= deadline) {
          return reject(new Error(`Timed out waiting for segment ${segIndex}`));
        }

        setTimeout(poll, SEG_POLL_INTERVAL);
      };

      poll();
    });
  }

  _spawnBatch(job, startSec, batchDurSec) {
    return new Promise((resolve, reject) => {
      const { infoHash, batchStart, session } = job;
      const { internalUrl, videoFile, codecInfo } = session;

      if (!internalUrl) {
        return reject(new Error('No internalUrl — session may be hibernated'));
      }

      const outputDir    = this.cache.dir(infoHash);
      const segPattern   = path.join(outputDir, 'segment_%05d.m4s');
      const tempPlaylist = path.join(outputDir, `_tmp_${batchStart}.m3u8`);

      const ext     = path.extname(videoFile.name).toLowerCase();
      const fmtHint = { '.mkv': 'matroska', '.avi': 'avi', '.mov': 'mov',
                        '.mp4': 'mp4', '.webm': 'webm', '.m4v': 'mp4' }[ext];

      const args = [];

      // ── Input seek ─────────────────────────────────────────────────────────
      if (startSec > 0) {
        args.push('-ss', String(startSec));
      }
      // Slight overrun so FFmpeg doesn't cut the last segment short
      args.push('-t', String(batchDurSec + SEG_DURATION));

      // ── Input options ──────────────────────────────────────────────────────
      args.push('-reconnect', '1', '-reconnect_delay_max', '5');
      args.push('-rw_timeout', '30000000');
      args.push('-analyzeduration', '1000000', '-probesize', '2000000');
      // Only block end-of-file seeks on the very first batch (no -ss).
      // Later batches need FFmpeg to bisect-seek in the source.
      if (startSec === 0) args.push('-seekable', '0');
      if (fmtHint) args.push('-f', fmtHint);
      args.push('-i', internalUrl);

      // ── Stream selection ───────────────────────────────────────────────────
      args.push('-map', '0:v:0');
      if (codecInfo.audioCodec !== null) args.push('-map', '0:a:0');
      args.push('-sn');

      // ── Video codec ────────────────────────────────────────────────────────
      if (!codecInfo.needsVideoTranscode) {
        args.push('-c:v', 'copy');
      } else {
        args.push(
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-bf', '0',
          '-force_key_frames', `expr:gte(t,n_forced*${SEG_DURATION})`,
          '-sc_threshold', '0',
        );
      }

      // ── Audio codec ────────────────────────────────────────────────────────
      if (codecInfo.audioCodec !== null) {
        if (!codecInfo.needsAudioTranscode) {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
        }
      }

      // ── Misc ───────────────────────────────────────────────────────────────
      args.push('-threads', codecInfo.needsVideoTranscode ? '0' : '2');
      args.push('-avoid_negative_ts', 'make_zero');

      // ── HLS output ─────────────────────────────────────────────────────────
      args.push(
        '-f', 'hls',
        '-hls_time', String(SEG_DURATION),
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', segPattern,
        '-start_number', String(batchStart),
        tempPlaylist,
      );

      // ── Spawn ──────────────────────────────────────────────────────────────
      const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      job.proc = proc;

      let stderr = '';
      proc.stderr.on('data', chunk => {
        const line = chunk.toString();
        stderr += line;
        if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
          process.stdout.write(`[ffmpeg:${batchStart}] ${line}`);
        }
      });

      const timer = setTimeout(() => {
        console.warn(`[gen] batch ${batchStart} timeout — killing FFmpeg`);
        proc.kill('SIGTERM');
      }, JOB_TIMEOUT_MS);

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        job.proc = null;
        try { fs.unlinkSync(tempPlaylist); } catch {}

        if (job.cancelled || signal === 'SIGTERM') {
          return reject(new Error('FFmpeg killed'));
        }
        if (code !== 0) {
          const tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
          return reject(new Error(`FFmpeg exited ${code}:\n${tail}`));
        }
        resolve();
      });

      proc.on('error', err => { clearTimeout(timer); reject(err); });
    });
  }
}
