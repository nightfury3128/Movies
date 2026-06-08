/**
 * pipeline/seek.js — SeekWorkerManager
 *
 * Manages parallel FFmpeg processes that generate segments near a seek target
 * before the main encoder reaches that position.
 *
 * Lifecycle:
 *   1. POST /torrent/seek → SeekWorkerManager.startWorker()
 *   2. Piece-ready gate: waits up to PIECE_GATE_MS for pieces at seekByte
 *   3. Parallel FFmpeg writes to a temp dir under hlsPath
 *   4. Watcher parses TFDT from each new .m4s → renames → copies to hlsPath
 *   5. Renamed segment is registered in timeline → emits segment:ready
 *   6. Worker auto-stops when main encoder surpasses workerSeekTime + WINDOW
 *   7. On rw_timeout failure: retries up to MAX_RETRIES times
 *
 * Segment naming:
 *   All seek segments → `segment_t<tfdt_ms>.m4s` from actual TFDT
 *
 * The predicted name matches what the frontend's _predictSeekSegmentId()
 * computes, so the optimistic prefetch succeeds without a covering-poll roundtrip.
 */

import fs   from 'fs';
import path from 'path';
import { spawn as cpSpawn } from 'child_process';
import { HlsGenerator }      from './ffmpeg.js';
import { readSegmentTiming, readFragmentTracks, readInitTracksTimescale, readInitTrackInfo, rewriteTrackTfdt } from './fmp4.js';
import { toSegmentPayload }  from '../core/timeline.js';
import { log, warn }         from '../logger.js';

const NS = 'seek';

// How far ahead of the seek target to keep the worker alive.
const WORKER_WINDOW_SEC = 60;
// Max concurrent seek workers per session.
const MAX_SEEK_WORKERS  = 2;
// Polling interval for new segment files (ms).
const POLL_MS = 100;
// Retry: up to 3 total FFmpeg attempts per seek worker.
const MAX_RETRIES    = 2;
const RETRY_DELAY_MS = 3000;
const MAX_SEEK_PREROLL_SECONDS = 120;
const ENABLE_TFDT_NORMALIZATION = /^(1|true|yes|on)$/i.test(process.env.ENABLE_TFDT_NORMALIZATION ?? 'true');
const TFDT_NORMALIZATION_THRESHOLD_MS = 500;

export class SeekWorkerManager {
  /**
   * @param {object} session   Session object from SessionManager
   */
  constructor(session) {
    this.session = session;
    this._workers = new Map(); // jobId → worker state
    this._jobCounter = 0;
    this._seekGeneration = 0; // incremented on every startWorker call to detect races
  }

  /**
   * Start a seek worker for the given target time.
   * Returns the jobId and approximate startTime for the first segment.
   *
   * @param {number} seekTime   Target media time in seconds
   * @param {object|number} decodePoint Safe decode point, or legacy byte offset
   */
  async startWorker(seekTime, decodePoint = null, diagnostics = {}) {
    // Stamp this seek before any awaits so concurrent calls can detect the race.
    const gen = ++this._seekGeneration;

    // Kill all existing workers — a new seek supersedes all previous ones.
    for (const [id] of [...this._workers]) {
      await this.killWorker(id);
    }

    // If another seek arrived while we were awaiting killWorker, bail — that newer
    // seek will start its own worker and send its own response to the client.
    if (this._seekGeneration !== gen) {
      return { jobId: null, startTime: seekTime, endTime: seekTime + 2 };
    }

    const jobId    = `seek_${++this._jobCounter}_${Date.now()}`;
    const seekEpoch = diagnostics?.seekEpoch ?? this.session._seekEpoch ?? null;
    const seekDir  = path.join(this.session.hlsPath + '_seek', jobId);
    const mode     = this.session.codecInfo?.mode ?? 'transcode';
    const safePoint = typeof decodePoint === 'number'
      ? {
          requestedTime: seekTime,
          startTime: mode === 'remux' ? Math.max(0, seekTime - 12) : seekTime,
          byteOffset: decodePoint,
          clusterOffset: decodePoint,
          source: 'legacy',
        }
      : {
          requestedTime: seekTime,
          startTime: Math.max(0, decodePoint?.startTime ?? seekTime),
          byteOffset: decodePoint?.byteOffset ?? decodePoint?.clusterOffset ?? null,
          clusterOffset: decodePoint?.clusterOffset ?? decodePoint?.byteOffset ?? null,
          source: decodePoint?.source ?? 'unknown',
        };
    const seekOffset = safePoint.startTime;
    const seekByte   = safePoint.clusterOffset ?? safePoint.byteOffset;
    const positionSource = typeof decodePoint === 'number'
      ? (mode === 'remux' ? 'byteMapping' : 'requestedSeekTime')
      : decodePoint?.startTime != null ? 'decodePoint' : 'requestedSeekTime';

    if (seekTime > 30 && seekByte === 0 && seekOffset < seekTime - 120) {
      const rejection = {
        requestedSeekTime: seekTime,
        seekOffset,
        seekByte,
        safePoint,
        reason: 'INVALID_SEEK_WORKER_START_ZERO',
      };
      this._trace(null, 'seek.worker_start.rejected', rejection);
      throw new Error('INVALID_SEEK_WORKER_START_ZERO');
    }
    if (Math.abs(seekTime - seekOffset) > 120 && seekOffset === 0) {
      const rejection = {
        requestedSeekTime: seekTime,
        seekOffset,
        seekByte,
        safePoint,
        reason: 'INVALID_SEEK_WORKER_START_ZERO',
      };
      this._trace(null, 'seek.worker_start.rejected', rejection);
      throw new Error('INVALID_SEEK_WORKER_START_ZERO');
    }

    this.session._activeSeek = {
      targetTime: seekTime,
      seekByte,
      clusterOffset: safePoint.clusterOffset ?? null,
      seekOffset,
      jobId,
      generation: gen,
      seekEpoch,
      startedAt: Date.now(),
    };

    if (safePoint.clusterOffset != null) {
      this.session.timeline.recordCluster({
        startTime: seekOffset,
        byteOffset: safePoint.byteOffset ?? safePoint.clusterOffset,
        clusterOffset: safePoint.clusterOffset,
        source: safePoint.source,
      });
    }

    await fs.promises.mkdir(seekDir, { recursive: true });
    this._trace(null, 'seek.worker.create', {
      jobId,
      seekTime,
      seekByte,
      seekOffset,
      safePoint,
      mode,
      seekDir,
      seekEpoch,
    });
    this._trace(null, 'seek.worker_spawn.source', {
      jobId,
      seekEpoch,
      requestedSeekTime: seekTime,
      currentPlaybackTime: diagnostics.currentPlaybackTime ?? null,
      mainLastTime: diagnostics.mainLastTime ?? null,
      timelineEnd: diagnostics.timelineEnd ?? null,
      source: positionSource,
      decodePoint,
      workerStartTime: seekOffset,
      workerStartByte: seekByte,
      workerStartOffset: seekOffset,
    });

    // Kick off piece prioritization immediately so WebTorrent starts downloading
    // while the piece-ready gate is waiting.
    if (seekByte != null && this.session.torrentManager) {
      const windowBytes = this.session.videoFile?.length
        ? Math.min(100 * 1024 * 1024, this.session.videoFile.length - seekByte)
        : 100 * 1024 * 1024;
      this.session.torrentManager.prioritizeRange(seekByte, seekByte + windowBytes);
      this._trace(null, 'torrent.priority_source', {
        source: 'active_seek_worker_start',
        priority: {
          targetTime: seekTime,
          seekByte,
          reason: 'seek.worker.start',
        },
        targetTime: seekTime,
        seekByte,
        reason: 'seek.worker.start',
      });
      this._trace(null, 'seek.worker.prioritize_requested', {
      jobId,
      seekEpoch,
      seekTime,
        seekByte,
        endByte: seekByte + windowBytes,
        windowBytes,
      });
    }

    const generator = new HlsGenerator({ label: jobId });
    const worker = {
      jobId,
      generation: gen,
      seekEpoch,
      seekTime,
      seekByte,
      seekOffset,
      safePoint,
      seekDir,
      generator,
      state:             'running',
      segmentsGenerated: 0,
      seekInitCopied:    false,
      startedAt:         Date.now(),
      stopPoll:          null,
      resetWatcher:      null,
      // per-attempt instrumentation counters (reset by resetWatcher between retries)
      _segsSeen:         0,
      _segsParsed:       0,
      _segsPromoted:     0,
      _timelineInserted: 0,
      _lastFailureReason: null,
      _rootFirstAv:      null,
      _rootFirstKept:    null,
      _spawnFirstSegment: null,
      _spawnFirstDiscard: null,
      _spawnCoveringFound: false,
      _spawnSource: positionSource,
      _avDurationFirstBad: false,
      _avDurationFfprobeMismatch: false,
      _avDurationParserMismatch: false,
      _avDurationPrev: null,
      _avDurationDeltas: [],
      _avDurationAccumulatingReported: false,
      _prerollEntered:       false,
      _prerollCount:         0,
      _prerollTargetReached: false,
      _avSyncFirstSegDone:   false,
      _diagProbeDone:        false,
      // telemetry
      _stderrBuf:        [],   // rolling last-20 stderr lines
      _firstOutputSeen:  null, // first output filename (any type)
      _milestones:       {},   // phase → Date.now() timestamp
    };

    this._workers.set(jobId, worker);
    this._watchDir(worker);

    // Piece gate + FFmpeg with retry — runs in background, non-blocking.
    this._runWorker(worker).catch(() => {});

    log(NS, `Worker ${jobId} started seekTime=${seekTime} offset=${seekOffset}`);
    this._trace(worker, 'seek.worker.started');
    this._trace(worker, 'seek.worker_spawn.validation', {
      requestedSeekTime: +seekTime.toFixed(3),
      workerStartTime: +seekOffset.toFixed(3),
      deltaSeconds: +(seekOffset - seekTime).toFixed(3),
      source: positionSource,
      currentPlaybackTime: diagnostics.currentPlaybackTime ?? null,
      mainLastTime: diagnostics.mainLastTime ?? null,
      timelineEnd: diagnostics.timelineEnd ?? null,
    });
    this._trace(worker, 'seek.root.gap', {
      requestedTime: +seekTime.toFixed(3),
      decodePoint: +seekOffset.toFixed(3),
      gapSeconds: +(seekTime - seekOffset).toFixed(3),
      source: safePoint.source,
    });
    return { jobId, startTime: seekOffset, endTime: seekOffset + 2 };
  }

  /**
   * Background lifecycle: piece-ready gate → FFmpeg with up to MAX_RETRIES retries.
   * Between retries, clears the seek dir and resets the watcher so the new FFmpeg
   * run's segments are picked up cleanly.
   */
  async _runWorker(worker) {
    const { jobId, seekDir, seekOffset } = worker;
    let seekByte = worker.seekByte;

    // Start cluster boundary scan immediately — runs concurrently while FFmpeg
    // connects. The HTTP server awaits the cached promise so response headers
    // are sent as soon as the cluster boundary is known, not when FFmpeg connects.
    if (seekByte != null && this.session.torrentManager?.prefetchClusterAt) {
      this._trace(worker, 'seek.worker.cluster_prefetch_start');
      this.session.torrentManager.prefetchClusterAt(seekByte, Math.round(seekOffset * 1000));
    }

    // Gate: wait until WebTorrent has pieces at seekByte before starting FFmpeg.
    // Without this, FFmpeg stalls on createReadStream and hangs indefinitely.
    if (seekByte != null && this.session.torrentManager?.waitForPiecesAdaptive) {
      const gateMode = this.session.codecInfo?.mode ?? 'transcode';
      this._trace(worker, 'seek.worker.piece_gate_start', { seekByte });
      const ready = await this.session.torrentManager.waitForPiecesAdaptive(seekByte, 3, gateMode);
      if (!ready) warn(NS, `Worker ${jobId} piece gate timed out — attempting FFmpeg anyway`);
      worker._milestones.piece_gate_passed = Date.now();
      this._trace(worker, 'seek.worker.piece_gate_done', { seekByte, ready });
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (worker.state !== 'running') return;

      try {
        log(NS, `Worker ${jobId} FFmpeg attempt ${attempt + 1} seekTime=${worker.seekTime} seekByte=${seekByte}`);
        this._trace(worker, 'seek.worker.ffmpeg_attempt', {
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          diagnostics: seekByte != null && this.session.torrentManager?.seekDiagnostics
            ? this.session.torrentManager.seekDiagnostics(seekByte, 3)
            : null,
        });

        let lastProgressTraceAt = 0;
        let lastParsedProgressTraceAt = 0;
        const onStderr = line => {
          // Buffer last 20 lines for exit report
          worker._stderrBuf.push(line);
          if (worker._stderrBuf.length > 20) worker._stderrBuf.shift();
          this._trace(worker, 'seek.ffmpeg.stderr', { attempt: attempt + 1, line });
          if (/(packet duration|non monotonically increasing|timestamp|DTS|PTS|edit list|negative)/i.test(line)) {
            this._trace(worker, 'ffmpeg.timestamp_warning', {
              attempt: attempt + 1,
              line,
            });
          }
          // Parse structured progress (GROUP 1)
          if (line.includes('frame=') || line.includes('time=')) {
            const frame = line.match(/frame=\s*(\d+)/)?.[1];
            const time  = line.match(/time=(\S+)/)?.[1];
            const speed = line.match(/speed=\s*(\S+)/)?.[1];
            const size  = line.match(/size=\s*(\S+)/)?.[1];
            const fps   = line.match(/fps=\s*([\d.]+)/)?.[1];
            if (frame || time) {
              if (!worker._milestones.first_decode) worker._milestones.first_decode = Date.now();
              const now = Date.now();
              if (now - lastParsedProgressTraceAt < 1000) return;
              lastParsedProgressTraceAt = now;
              this._trace(worker, 'seek.ffmpeg.progress_parsed', {
                attempt: attempt + 1,
                frame:   frame ? +frame : null,
                time,
                speed,
                size,
                fps:     fps ? +fps : null,
                elapsedMs: Date.now() - worker.startedAt,
              });
            }
          }
        };
        worker.generator.on('stderr', onStderr);

        const onStart = cmdLine => {
          worker._milestones.ffmpeg_spawned = Date.now();
          this._trace(worker, 'seek.ffmpeg.spawned', { attempt: attempt + 1, cmdLine });
          worker._commandAudit = _buildFfmpegCommandAudit({
            worker,
            cmdLine,
            codecInfo: this.session.codecInfo,
            diagMode,
          });
          this._trace(worker, 'seek.ffmpeg.command_audit', worker._commandAudit);
          this._trace(worker, 'avsync.ffmpeg.spawn', {
            jobId:                       worker.jobId,
            generation:                  worker.generation,
            requestedSeekTime:           +worker.seekTime.toFixed(3),
            workerStartTime:             +worker.seekOffset.toFixed(3),
            requestedMinusWorkerStartMs: Math.round((worker.seekTime - worker.seekOffset) * 1000),
            attempt,
            cmdLine,
          });
        };
        const onProgress = seconds => {
          const now = Date.now();
          if (now - lastProgressTraceAt < 1000) return;
          lastProgressTraceAt = now;
          this._trace(worker, 'seek.ffmpeg.progress', { attempt: attempt + 1, seconds });

          // Advance the eviction frontier so the store frees old pieces.
          // The main encoder normally does this; after it's paused/stopped the seek
          // worker is the only source of position progress.
          const dur = this.session.codecInfo?.duration ?? this.session._estDuration;
          if (dur && this.session.videoFile?.length) {
            const fileOff  = this.session.videoFile.offset ?? 0;
            const curByte  = fileOff + (seconds / dur) * this.session.videoFile.length;
            this.session.torrentManager?.evictBefore(curByte);

            // Rolling prefetch: keep pieces prioritized 30 s ahead of the current
            // seek-worker position so pieces are ready before FFmpeg reaches them.
            const aheadByte = ((Math.min(seconds + 30, dur) / dur)) * this.session.videoFile.length;
            this.session.torrentManager?.prioritizeRange(aheadByte, aheadByte + 5 * 1024 * 1024);
          }
        };
        const onOpen = ({ filename, segCounter }) => this._trace(worker, 'seek.ffmpeg.segment_open', {
          attempt: attempt + 1,
          filename,
          segCounter,
        });
        const onEnd = () => {
          this._trace(worker, 'seek.ffmpeg.end', { attempt: attempt + 1, segmentsGenerated: worker.segmentsGenerated });
          this._trace(worker, 'seek.ffmpeg.exit', {
            attempt: attempt + 1, exitCode: 0, signal: null,
            runtimeMs: Date.now() - worker.startedAt,
            stderrTail: worker._stderrBuf.slice(-20),
          });
        };

        worker.generator.once('start', onStart);
        worker.generator.on('ffmpeg-time', onProgress);
        worker.generator.on('segment-open', onOpen);
        worker.generator.once('end', onEnd);

        const diagMode = process.env.AVSYNC_DIAG_MODE ?? null;
        try {
          await worker.generator.start(
            this.session.internalUrl,
            this.session.videoFile?.name ?? 'video.mkv',
            seekDir,
            this.session.codecInfo,
            seekOffset,
            true,
            seekByte,
            1,
            diagMode
          );
        } finally {
          worker.generator.off('ffmpeg-time', onProgress);
          worker.generator.off('segment-open', onOpen);
          worker.generator.off('stderr', onStderr);
        }

        // Give the watcher 300 ms to flush any final segment still being processed.
        await sleep(300);

        if (worker.segmentsGenerated === 0) {
          this._traceSpawnReport(worker, 'FAILED');
          this._trace(worker, 'seek.success_check', {
            attempt:          attempt + 1,
            segmentsSeen:     worker._segsSeen,
            segmentsParsed:   worker._segsParsed,
            segmentsPromoted: worker._segsPromoted,
            timelineInserted: worker._timelineInserted,
            lastFailureReason: worker._lastFailureReason,
          });
          this._trace(worker, 'seek.failure_report', {
            attempt:          attempt + 1,
            segmentsSeen:     worker._segsSeen,
            segmentsParsed:   worker._segsParsed,
            segmentsPromoted: worker._segsPromoted,
            timelineInserted: worker._timelineInserted,
            lastReason:       worker._lastFailureReason ?? 'unknown',
          });
          this._trace(worker, 'seek.summary', {
            attempt:          attempt + 1,
            segmentsSeen:     worker._segsSeen,
            segmentsParsed:   worker._segsParsed,
            segmentsPromoted: worker._segsPromoted,
            timelineInserted: worker._timelineInserted,
            failureReason:    worker._lastFailureReason ?? 'no_segments',
          });
          this._trace(worker, 'seek.worker.no_segments_after_ffmpeg', { attempt: attempt + 1 });
          throw new Error('FFmpeg exited with no segments (rw_timeout stall at seek position)');
        }

        this._trace(worker, 'seek.summary', {
          attempt:          attempt + 1,
          segmentsSeen:     worker._segsSeen,
          segmentsParsed:   worker._segsParsed,
          segmentsPromoted: worker._segsPromoted,
          timelineInserted: worker._timelineInserted,
          failureReason:    null,
        });
        this._traceSpawnReport(worker, worker._spawnCoveringFound ? 'SUCCESS' : 'FAILED');

        if (worker.state === 'running') {
          worker.state = 'done';
          this._trace(worker, 'seek.worker.done', {
            segmentsGenerated: worker.segmentsGenerated,
            elapsedMs: Date.now() - worker.startedAt,
          });
          this._cleanupWorker(jobId);
        }
        return;
      } catch (e) {
        if (worker.state !== 'running') return;
        this._traceSpawnReport(worker, 'FAILED');
        // Emit exit trace for non-programmatic FFmpeg errors (GROUP 6)
        if (e.message !== 'FFmpeg exited with no segments (rw_timeout stall at seek position)') {
          this._trace(worker, 'seek.ffmpeg.exit', {
            attempt: attempt + 1,
            exitCode: /rw_timeout/i.test(e.message) ? 1 : null,
            signal:   /SIGTERM|signal 15/i.test(e.message) ? 'SIGTERM' : null,
            runtimeMs: Date.now() - worker.startedAt,
            message:  e.message,
            stderrTail: worker._stderrBuf.slice(-20),
          });
        }
        // Worker timeline (GROUP 7)
        this._trace(worker, 'seek.worker.timeline', {
          attempt: attempt + 1,
          milestones: { ...worker._milestones },
          workerStartedAt: worker.startedAt,
          now: Date.now(),
        });
        this._trace(worker, 'seek.worker.attempt_failed', {
          attempt: attempt + 1,
          message: e.message,
          retrying: attempt < MAX_RETRIES,
        });
        if (attempt < MAX_RETRIES) {
          warn(NS, `Worker ${jobId} attempt ${attempt + 1} failed: ${e.message} — retrying`);
          try {
            for (const f of fs.readdirSync(seekDir)) {
              try { fs.unlinkSync(path.join(seekDir, f)); } catch {}
            }
          } catch {}
          worker.resetWatcher?.();
          if (worker.segmentsGenerated === 0 && seekByte != null &&
              this.session.torrentManager?.waitForPiecesAdaptive) {
            const retryMode = this.session.codecInfo?.mode ?? 'transcode';
            await this.session.torrentManager.waitForPiecesAdaptive(seekByte, 3, retryMode);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
        } else {
          warn(NS, `Worker ${jobId} failed after ${attempt + 1} attempts: ${e.message}`);
          worker.state = 'error';
          this._trace(worker, 'seek.worker.failed', {
            message: e.message,
            attempts: attempt + 1,
            elapsedMs: Date.now() - worker.startedAt,
          });
          this._cleanupWorker(jobId);
        }
      }
    }
  }

  async killWorker(jobId) {
    const worker = this._workers.get(jobId);
    if (!worker) return;
    worker.state = 'stopped';
    worker.stopPoll?.();
    worker.generator.stop();
    await this._cleanupWorker(jobId);
    log(NS, `Worker ${jobId} killed`);
    this._trace(worker, 'seek.worker.killed');
  }

  /** Called by the main FFmpeg time event — cleans up workers that are no longer needed. */
  cleanupExpired(mainTime) {
    for (const [jobId, worker] of this._workers) {
      if (mainTime > worker.seekTime + WORKER_WINDOW_SEC) {
        this._trace(worker, 'seek.worker.expired', {
          mainTime,
          windowSec: WORKER_WINDOW_SEC,
        });
        this.killWorker(jobId);
      }
    }
  }

  getWorkerStats() {
    return [...this._workers.values()].map(w => ({
      jobId:             w.jobId,
      generation:        w.generation,
      seekEpoch:         w.seekEpoch ?? null,
      seekTime:          w.seekTime,
      state:             w.state,
      segmentsGenerated: w.segmentsGenerated,
      elapsedMs:         Date.now() - w.startedAt,
    }));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _watchDir(worker) {
    const timescale = this.session.videoTimescale ?? 90000;
    const { seekDir } = worker;
    // Use a container object so resetWatcher can clear both fields atomically,
    // even though the closures below capture the container by reference.
    const state = { seen: new Set(), prevSeg: null };

    worker.resetWatcher = () => {
      state.seen = new Set();
      state.prevSeg = null;
      prevDirFiles.clear();
      worker._segsSeen = 0;
      worker._segsParsed = 0;
      worker._segsPromoted = 0;
      worker._timelineInserted = 0;
      worker._lastFailureReason = null;
      worker._firstOutputSeen = null;
      worker._rootFirstAv = null;
      worker._rootFirstKept = null;
      worker._spawnFirstSegment = null;
      worker._spawnFirstDiscard = null;
      worker._spawnCoveringFound = false;
      worker._avDurationFirstBad = false;
      worker._avDurationFfprobeMismatch = false;
      worker._avDurationParserMismatch = false;
      worker._avDurationPrev = null;
      worker._avDurationDeltas = [];
      worker._avDurationAccumulatingReported = false;
    };

    // ── Dir monitor (GROUP 2 + 3): watch ALL files in seekDir every 500 ms ────
    const FIRST_OUTPUT_NAMES = new Set(['master.m3u8', 'seek_init.mp4', 'segment_00000.m4s']);
    const prevDirFiles = new Map(); // filename → { size, mtime }
    const dirMonitorHandle = setInterval(() => {
      if (!this._isCurrentWorker(worker)) { clearInterval(dirMonitorHandle); return; }
      try {
        for (const f of fs.readdirSync(seekDir)) {
          const fp = path.join(seekDir, f);
          try {
            const st    = fs.statSync(fp);
            const prev  = prevDirFiles.get(f);
            const elapsed = Date.now() - worker.startedAt;
            if (!prev) {
              prevDirFiles.set(f, { size: st.size, mtime: st.mtimeMs });
              this._trace(worker, 'seek.dir.file_created', { filename: f, fileSize: st.size, mtime: st.mtimeMs, elapsedMs: elapsed });
              if (FIRST_OUTPUT_NAMES.has(f) && !worker._firstOutputSeen) {
                worker._firstOutputSeen = f;
                worker._milestones.first_output = Date.now();
                this._trace(worker, 'seek.first_output', { filename: f, elapsedMs: elapsed });
              }
            } else if (st.size !== prev.size) {
              prevDirFiles.set(f, { size: st.size, mtime: st.mtimeMs });
              this._trace(worker, 'seek.dir.file_modified', { filename: f, fileSize: st.size, prevSize: prev.size, elapsedMs: elapsed });
            }
          } catch {}
        }
      } catch {}
    }, 500);

    const processComplete = (file, fullPath) => {
      if (!this._isCurrentWorker(worker)) return;
      if (!file.endsWith('.m4s') || file.startsWith('seek_init') || state.seen.has(file)) return;
      state.seen.add(file);
      worker._segsSeen++;
      try {
        const st = fs.statSync(fullPath);
        this._trace(worker, 'seek.segment_discovered', {
          file,
          fileSize: st.size,
          mtime:    st.mtimeMs,
        });
      } catch {
        this._trace(worker, 'seek.segment_discovered', { file, fileSize: null, mtime: null });
      }
      this._trace(worker, 'seek.segment.complete_detected', { file });
      this._processSegment(worker, fullPath, timescale);
    };

    // Catch any segments already on disk from a prior worker run (they are complete).
    try {
      for (const file of fs.readdirSync(seekDir)) {
        processComplete(file, path.join(seekDir, file));
      }
    } catch {}

    // FFmpeg logs "Opening 'segment_N.m4s'" immediately AFTER closing segment_N-1.
    // So when this event fires for segment N, segment N-1 is fully written and closed.
    // Process N-1 now (complete); hold N until N+1 opens.
    const onOpen = ({ path: segPath, filename }) => {
      if (!this._isCurrentWorker(worker)) return;
      if (filename.startsWith('seek_init')) return;
      if (state.prevSeg) processComplete(state.prevSeg.filename, state.prevSeg.path);
      state.prevSeg = { filename, path: segPath };
      this._trace(worker, 'seek.segment.open_current', { filename });
      this._trace(worker, 'seek.proof.generated', {
        stage: 'ffmpeg_segment_open',
        filename,
        path: segPath,
        seekTime: worker.seekTime,
        segmentsSeen: worker._segsSeen,
        segmentsParsed: worker._segsParsed,
        segmentsPromoted: worker._segsPromoted,
        timelineInserted: worker._timelineInserted,
        timelineCount: this.session.timeline.count(),
      });
    };
    worker.generator.on('segment-open', onOpen);

    // Fallback poll: catches segments the event missed AND any file that is no
    // longer the currently-open one (i.e. prevSeg moved past it).
    const pollHandle = setInterval(() => {
      if (!this._isCurrentWorker(worker)) { clearInterval(pollHandle); return; }
      try {
        for (const file of fs.readdirSync(seekDir)) {
          if (!file.endsWith('.m4s') || file.startsWith('seek_init') || state.seen.has(file)) continue;
          if (state.prevSeg?.filename === file) continue; // still being written
          // File exists and isn't the current open one — already closed by FFmpeg.
          state.seen.add(file);
          this._processSegment(worker, path.join(seekDir, file), timescale);
        }
      } catch { clearInterval(pollHandle); }
    }, POLL_MS);

    worker.stopPoll = () => {
      worker.generator.off('segment-open', onOpen);
      clearInterval(pollHandle);
      clearInterval(dirMonitorHandle);
    };
  }

  async _processSegment(worker, segPath, timescale) {
    if (!this._isCurrentWorker(worker)) return;
    const session = this.session;
    const file = path.basename(segPath);
    if (!worker._initTimescaleProbeDone) {
      worker._initTimescaleProbeDone = true;
      try {
        const ts = await readInitTracksTimescale(path.join(worker.seekDir, 'seek_init.mp4'));
        if (ts.video) worker._initVideoTimescale = ts.video;
        if (ts.audio) worker._initAudioTimescale = ts.audio;
        this._trace(worker, 'seek.init.timescales', {
          videoTimescaleFromInit: ts.video,
          audioTimescaleFromInit: ts.audio,
          videoTimescaleUsed: worker._initVideoTimescale ?? timescale,
          audioTimescaleUsed: worker._initAudioTimescale ?? 48000,
          source: 'seek_dir',
        });
        const info = await readInitTrackInfo(path.join(worker.seekDir, 'seek_init.mp4'));
        this._trace(worker, 'seek.init.track_info', {
          videoTimescale: info.video?.timescale ?? ts.video ?? null,
          audioTimescale: info.audio?.timescale ?? ts.audio ?? null,
          videoTrackId: info.video?.trackId ?? null,
          audioTrackId: info.audio?.trackId ?? null,
          videoCodec: info.video?.codec ?? null,
          audioCodec: info.audio?.codec ?? null,
        });
      } catch {}
    }
    timescale = worker._initVideoTimescale ?? timescale;

    // Retry until we can parse the TFDT (file might still be written).
    let timing = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this._isCurrentWorker(worker)) return;
      timing = await readSegmentTiming(segPath, timescale);
      if (timing) break;
      await sleep(80);
    }
    if (!this._isCurrentWorker(worker)) return;

    if (!timing) {
      warn(NS, `Could not parse TFDT from ${segPath}`);
      worker._lastFailureReason = 'tfdt_parse_failed';
      this._trace(worker, 'seek.tfdt_failed', { file, path: segPath, timescale });
      this._trace(worker, 'seek.segment.parse_failed', { path: segPath });
      return;
    }

    const audioTimescaleUsed = worker._initAudioTimescale ?? 48000;
    let tracks = await readFragmentTracks(segPath, {
      videoTimescale: timescale,
      audioTimescale: audioTimescaleUsed,
    });
    if (!this._isCurrentWorker(worker)) return;
    const segmentNumber = _segmentNumber(file);
    const normalization = await this._maybeNormalizeTfdt(worker, {
      segPath,
      segment: file,
      segmentNumber,
      tracks,
      videoTimescale: timescale,
      audioTimescale: audioTimescaleUsed,
    });
    if (normalization?.tracks) tracks = normalization.tracks;
    if (!this._isCurrentWorker(worker)) return;
    if (tracks.video?.start != null) {
      const videoDuration = tracks.video.duration ?? timing.duration;
      timing = {
        ...timing,
        tfdt: tracks.video.tfdtRaw ?? timing.tfdt,
        startTime: tracks.video.start,
        duration: videoDuration,
        endTime: tracks.video.end ?? (tracks.video.start + videoDuration),
      };
    }

    worker._segsParsed++;
    const clock = _resolveSeekFragmentClock(worker, timing);
    const relativeStart = clock.relativeStart;
    const relativeEnd = clock.relativeEnd;
    const absoluteStart = clock.absoluteStart;
    const absoluteEnd = clock.absoluteEnd;
    if (!worker._rootFirstAv && (tracks.video || tracks.audio)) {
      worker._rootFirstAv = {
        firstVideoPts: tracks.video ? _fragmentTimeToTimeline(clock, tracks.video.start) : null,
        firstAudioPts: tracks.audio ? _fragmentTimeToTimeline(clock, tracks.audio.start) : null,
        deltaMs: tracks.deltaMs,
      };
      this._trace(worker, 'seek.root.first_av_packets', {
        segment: file,
        firstVideoPts: worker._rootFirstAv.firstVideoPts != null ? +worker._rootFirstAv.firstVideoPts.toFixed(3) : null,
        firstAudioPts: worker._rootFirstAv.firstAudioPts != null ? +worker._rootFirstAv.firstAudioPts.toFixed(3) : null,
        deltaMs: worker._rootFirstAv.deltaMs,
        containsVideo: !!tracks.video,
        containsAudio: !!tracks.audio,
      });
    }
    const absoluteTiming = {
      ...timing,
      relativeStartTime: relativeStart,
      relativeEndTime: relativeEnd,
      absoluteStartTime: absoluteStart,
      absoluteEndTime: absoluteEnd,
      startTime: absoluteStart,
      endTime: absoluteEnd,
      clockBasis: clock.basis,
      timestampOffset: clock.timestampOffset,
    };
    if (!worker._spawnFirstSegment) {
      worker._spawnFirstSegment = file;
      this._trace(worker, 'seek.worker_spawn.first_segment', {
        segmentId: file,
        relativeStart: +relativeStart.toFixed(3),
        relativeEnd: +relativeEnd.toFixed(3),
        absoluteStart: +absoluteStart.toFixed(3),
        absoluteEnd: +absoluteEnd.toFixed(3),
        requestedSeekTime: +worker.seekTime.toFixed(3),
        workerStartTime: +worker.seekOffset.toFixed(3),
      });
    }

    this._trace(worker, 'seek.tfdt_parsed', {
      file,
      baseMediaDecodeTime: timing.tfdt,
      timescale,
      fragmentStartSeconds: +clock.fragmentStart.toFixed(4),
      fragmentEndSeconds:   +clock.fragmentEnd.toFixed(4),
      startSeconds: +relativeStart.toFixed(4),
      endSeconds:   +relativeEnd.toFixed(4),
      seekOffset:   +worker.seekOffset.toFixed(4),
      absoluteStart: +absoluteStart.toFixed(4),
      absoluteEnd:   +absoluteEnd.toFixed(4),
      clockBasis: clock.basis,
      timestampOffset: +clock.timestampOffset.toFixed(4),
    });

	    this._trace(worker, 'seek.segment_timing', {
	      file,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd:   +relativeEnd.toFixed(3),
      seekOffset:    +worker.seekOffset.toFixed(3),
      startTime:  +absoluteStart.toFixed(3),
      endTime:    +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd:   +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      delta:      +(absoluteStart - worker.seekTime).toFixed(3),
	      overlapsTarget: _overlapsTarget(absoluteTiming, worker.seekTime),
	    });
	    this._trace(worker, 'generation.segment_discovered', {
	      segment: file,
	      generation: worker.generation,
	      workerId: worker.jobId,
	      source: 'seek',
	      absoluteStart: +absoluteStart.toFixed(3),
	      absoluteEnd: +absoluteEnd.toFixed(3),
	    });
    this._trace(worker, 'seek.proof.parsed', {
      stage: 'tfdt_parsed',
      file,
      path: segPath,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      startTime: +absoluteStart.toFixed(3),
      endTime: +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      overlapsTarget: _overlapsTarget(absoluteTiming, worker.seekTime),
      segmentsSeen: worker._segsSeen,
      segmentsParsed: worker._segsParsed,
      segmentsPromoted: worker._segsPromoted,
      timelineInserted: worker._timelineInserted,
      timelineCount: this.session.timeline.count(),
    });

    // Preroll accumulation: segments before the target are promoted normally so
    // the player has a contiguous decode chain from the decode point.
    const PREROLL_WINDOW = 0.5;
    const isPreroll = absoluteEnd < worker.seekTime - PREROLL_WINDOW;
    const remainingPrerollSeconds = worker.seekTime - absoluteEnd;
    if (remainingPrerollSeconds > MAX_SEEK_PREROLL_SECONDS) {
      worker._lastFailureReason = 'preroll_too_far_from_target';
      this._trace(worker, 'preroll.rejected_too_far_from_target', {
        file,
        targetTime: +worker.seekTime.toFixed(3),
        segmentStart: +absoluteStart.toFixed(3),
        segmentEnd: +absoluteEnd.toFixed(3),
        remaining: +remainingPrerollSeconds.toFixed(3),
        maxPrerollSeconds: MAX_SEEK_PREROLL_SECONDS,
        seekOffset: +worker.seekOffset.toFixed(3),
        seekByte: worker.seekByte,
      });
      return;
    }
    const overlapsTargetAtEvaluation = _overlapsTarget(absoluteTiming, worker.seekTime);
    const decision = isPreroll
      ? 'preroll_accumulate'
      : overlapsTargetAtEvaluation ? 'promote_overlap' : 'promote_after_target';

    this._trace(worker, 'seek.root.segment', {
      segment: file,
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      containsVideo: !!tracks.video,
      containsAudio: !!tracks.audio,
      decision: 'keep',
      detailedDecision: decision,
      targetTime: +worker.seekTime.toFixed(3),
    });
    this._trace(worker, 'seek.segment.evaluated', {
      segmentId: file,
      file,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      overlapsTarget: overlapsTargetAtEvaluation,
      decision,
    });
    this._trace(worker, 'seek.preroll_check', {
      file,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd:   +relativeEnd.toFixed(3),
      seekOffset:    +worker.seekOffset.toFixed(3),
      startTime:     +absoluteStart.toFixed(3),
      endTime:       +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd:   +absoluteEnd.toFixed(3),
      targetTime:    +worker.seekTime.toFixed(3),
      prerollWindow: PREROLL_WINDOW,
      result:        'keep',
      reason:        isPreroll ? 'preroll_accumulate' : 'covers_or_after_target',
    });

    if (isPreroll) {
      if (!worker._prerollEntered) {
        worker._prerollEntered = true;
        this._trace(worker, 'seek.preroll.enter', {
          decodePoint:  +worker.seekOffset.toFixed(3),
          targetTime:   +worker.seekTime.toFixed(3),
          gapSeconds:   +(worker.seekTime - worker.seekOffset).toFixed(3),
        });
      }
      this._trace(worker, 'seek.preroll.segment', {
        file,
        absoluteStart:  +absoluteStart.toFixed(3),
        absoluteEnd:    +absoluteEnd.toFixed(3),
        targetTime:     +worker.seekTime.toFixed(3),
        remaining:      +(worker.seekTime - absoluteEnd).toFixed(3),
        prerollIndex:   worker._prerollCount,
      });
      this._trace(worker, 'seek.preroll.coverage', {
        coveredFrom:    +worker.seekOffset.toFixed(3),
        coveredTo:      +absoluteEnd.toFixed(3),
        targetTime:     +worker.seekTime.toFixed(3),
        remaining:      +(worker.seekTime - absoluteEnd).toFixed(3),
        prerollCount:   worker._prerollCount + 1,
      });
      worker._prerollCount++;
      // Fall through — promote this segment normally (no discard).
    }

    const destName = `segment_t${Math.round(absoluteStart * 1000)}.m4s`;
    const destPath = path.join(session.hlsPath, destName);
    const trackBase = {
      workerStartTime: worker.seekOffset,
      videoBaseUsed: tracks.video ? clock.timestampOffset : null,
      audioBaseUsed: tracks.audio ? clock.timestampOffset : null,
      absoluteVideoStart: tracks.video ? _fragmentTimeToTimeline(clock, tracks.video.start) : null,
      absoluteAudioStart: tracks.audio ? _fragmentTimeToTimeline(clock, tracks.audio.start) : null,
    };
    const trackTimeline = _buildTrackTimelineDiagnostics({
      segmentId: file,
      promotedSegmentId: destName,
      workerStartTime: worker.seekOffset,
      clock,
      tracks,
      videoTimescale: timescale,
      audioTimescale: audioTimescaleUsed,
      computedSegmentStart: absoluteStart,
      computedSegmentEnd: absoluteEnd,
    });

    this._recordSeekAvRootCauseSegment(worker, {
      segment: file,
      segmentNumber: _segmentNumber(file),
      segmentPath: segPath,
      tracks,
      timescale,
      audioTimescaleUsed,
      clock,
      trackBase,
    });
    this._recordFirstFiveDriftDiagnostics(worker, {
      segment: file,
      segmentNumber: _segmentNumber(file),
      tracks,
      videoTimescale: timescale,
      audioTimescale: audioTimescaleUsed,
    });

    this._trace(worker, 'track_timeline.raw', trackTimeline.raw);
    this._trace(worker, 'track_timeline.absolute_conversion.before', trackTimeline.conversionBefore);
    this._trace(worker, 'track_timeline.absolute_conversion.after', trackTimeline.conversionAfter);
    this._trace(worker, 'track_timeline.origin', trackTimeline.origin);

    if (file === 'segment_00000.m4s') {
      this._trace(worker, 'seek.segment0.forensics', _buildSegment0Forensics({
        worker,
        segment: file,
        tracks,
        videoTimescale: timescale,
        audioTimescale: audioTimescaleUsed,
      }));
      this._trace(worker, 'seek.segment0.raw_boxes', _buildSegment0RawBoxes({
        worker,
        segment: file,
        tracks,
        videoTimescale: timescale,
        audioTimescale: audioTimescaleUsed,
      }));
      this._trace(worker, 'seek.rebase.trace', _buildRebaseTrace({
        worker,
        segment: file,
        tracks,
        trackBase,
      }));
      this._trace(worker, 'track_timeline.first_worker_segment', trackTimeline.firstSegment);
      this._runSegment0Ffprobe(worker, segPath);
    }

    if (trackTimeline.divergence) {
      console.error('TRACK_TIMELINE_DIVERGENCE', trackTimeline.divergence);
      this._trace(worker, 'track_timeline.divergence', trackTimeline.divergence);
    }

    // Validate before promoting.
    if (!isFinite(absoluteStart) || !isFinite(absoluteEnd) || absoluteEnd <= absoluteStart) {
      worker._lastFailureReason = 'invalid_timestamp';
      this._trace(worker, 'seek.promote_decision', {
        file, destName, action: 'reject', reason: 'invalid_timestamp',
        relativeStart, relativeEnd, seekOffset: worker.seekOffset,
        startTime: absoluteStart, endTime: absoluteEnd,
        absoluteStart, absoluteEnd,
      });
      this._trace(worker, 'seek.timeline_reject', {
        file: destName, reason: 'invalid_timestamp',
        relativeStart, relativeEnd, seekOffset: worker.seekOffset,
        startTime: absoluteStart, endTime: absoluteEnd,
        absoluteStart, absoluteEnd,
      });
      return;
    }

    const alreadyInTimeline = session.timeline.findSegmentForTime(absoluteStart);
    if (alreadyInTimeline && alreadyInTimeline.file === destName) {
      worker._lastFailureReason = 'duplicate';
      this._trace(worker, 'seek.promote_decision', {
        file, destName, action: 'reject', reason: 'duplicate',
        relativeStart, relativeEnd, seekOffset: worker.seekOffset,
        startTime: absoluteStart, endTime: absoluteEnd,
        absoluteStart, absoluteEnd,
      });
      this._trace(worker, 'seek.timeline_reject', { file: destName, reason: 'duplicate' });
      return;
    }

	    this._trace(worker, 'seek.promote_decision', {
	      file, destName, action: 'promote',
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      startTime: +absoluteStart.toFixed(3),
      endTime:   +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
	      absoluteEnd: +absoluteEnd.toFixed(3),
	    });
	    this._trace(worker, 'generation.segment_promoted', {
	      segment: destName,
	      generation: worker.generation,
	      workerId: worker.jobId,
	      currentActiveGeneration: this._seekGeneration,
	      accepted: worker.generation === this._seekGeneration,
	    });

    // Copy seek_init.mp4 before the first segment.
    if (!this._isCurrentWorker(worker)) return;

    if (!worker.seekInitCopied) {
      const seekInitSrc  = path.join(worker.seekDir, 'seek_init.mp4');
      const seekInitDest = path.join(session.hlsPath, 'seek_init.mp4');
      try {
        if (!this._isCurrentWorker(worker)) return;
        await fs.promises.copyFile(seekInitSrc, seekInitDest);
        if (!this._isCurrentWorker(worker)) return;
        worker.seekInitCopied = true;
        this._trace(worker, 'seek.segment.seek_init_copied');
        // Read actual timescales from init segment for A/V sync diagnostics.
        readInitTracksTimescale(seekInitDest).then(ts => {
          worker._initVideoTimescale = ts.video;
          worker._initAudioTimescale = ts.audio;
          this._trace(worker, 'seek.init.timescales', {
            videoTimescaleFromInit: ts.video,
            audioTimescaleFromInit: ts.audio,
            videoTimescaleUsed:     session.videoTimescale ?? 90000,
            audioTimescaleAssumed:  48000,
            audioTimescaleMismatch: ts.audio != null && ts.audio !== 48000,
          });
        }).catch(() => {});
        readInitTrackInfo(seekInitDest).then(info => {
          this._trace(worker, 'seek.init.track_info', {
            videoTimescale: info.video?.timescale ?? null,
            audioTimescale: info.audio?.timescale ?? null,
            videoTrackId: info.video?.trackId ?? null,
            audioTrackId: info.audio?.trackId ?? null,
            videoCodec: info.video?.codec ?? null,
            audioCodec: info.audio?.codec ?? null,
            source: 'hls_dir',
          });
        }).catch(() => {});
      } catch (e) {
        warn(NS, `Worker ${worker.jobId} seek_init.mp4 copy failed: ${e.message}`);
      }
    }

    try {
      if (!this._isCurrentWorker(worker)) return;
      await fs.promises.copyFile(segPath, destPath);
      if (!this._isCurrentWorker(worker)) {
        try { await fs.promises.unlink(destPath); } catch {}
        return;
      }
      await fs.promises.unlink(segPath);
    } catch (e) {
      warn(NS, `Failed to move seek segment: ${e.message}`);
      worker._lastFailureReason = 'move_failed';
      this._trace(worker, 'seek.segment.move_failed', {
        path: segPath, destPath, message: e.message,
      });
      return;
    }

    if (!this._isCurrentWorker(worker)) return;

    let destStat = null;
    try { destStat = await fs.promises.stat(destPath); } catch {}
    const overlapsTarget = _overlapsTarget(absoluteTiming, worker.seekTime);
    if (overlapsTarget) worker._spawnCoveringFound = true;
    if (overlapsTarget && !worker._prerollTargetReached) {
      worker._prerollTargetReached = true;
      this._trace(worker, 'seek.preroll.target_reached', {
        file:                        destName,
        absoluteStart:               +absoluteStart.toFixed(3),
        absoluteEnd:                 +absoluteEnd.toFixed(3),
        targetTime:                  +worker.seekTime.toFixed(3),
        prerollSegmentsAccumulated:  worker._prerollCount,
      });
    }
    if (!worker._rootFirstKept) {
      worker._rootFirstKept = destName;
      this._trace(worker, 'seek.root.first_kept_segment', {
        segment: destName,
        sourceSegment: file,
        absoluteStart: +absoluteStart.toFixed(3),
        absoluteEnd: +absoluteEnd.toFixed(3),
        containsVideo: !!tracks.video,
        containsAudio: !!tracks.audio,
        targetTime: +worker.seekTime.toFixed(3),
      });
    }
    let avDurationSummary = null;
    if (tracks.video || tracks.audio) {
      const videoStart = tracks.video ? _fragmentTimeToTimeline(clock, tracks.video.start) : null;
      const audioStart = tracks.audio ? _fragmentTimeToTimeline(clock, tracks.audio.start) : null;
      const trackDeltaMs = videoStart != null && audioStart != null
        ? Math.round((audioStart - videoStart) * 1000) : null;
      avDurationSummary = this._traceAvDurationInternal(worker, {
        segment: destName,
        sourceSegment: file,
        tracks,
        expectedDuration: timing.duration,
      });
      this._trace(worker, 'seek.root.track_starts', {
        segment: destName,
        videoTfdt:    tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(3) : null,
        audioTfdt:    tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(3) : null,
        videoStart:   videoStart != null ? +videoStart.toFixed(3) : null,
        audioStart:   audioStart != null ? +audioStart.toFixed(3) : null,
        trackDeltaMs,
      });
      // CHECK #1/#2/#3/#4 — full A/V sync diagnostic trace
      this._trace(worker, 'seek.av_sync.segment', {
        segment:               destName,
        seekOffset:            +worker.seekOffset.toFixed(3),
        // timescales actually used for conversion
        videoTimescale:        timescale,
        audioTimescale:        audioTimescaleUsed,
        audioTimescaleInitSeg: worker._initAudioTimescale ?? null,
        // raw ticks straight from the TFDT box
        videoTfdtRaw:          tracks.video?.tfdtRaw ?? null,
        audioTfdtRaw:          tracks.audio?.tfdtRaw ?? null,
        // seconds after dividing by respective timescales
        videoTfdtSeconds:      tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        audioTfdtSeconds:      tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        // absolute start times after applying the same clock basis used for timeline registration
        videoStart:            videoStart != null ? +videoStart.toFixed(3) : null,
        audioStart:            audioStart != null ? +audioStart.toFixed(3) : null,
        actualAudioMinusVideoMs: trackDeltaMs,
        // what delta WOULD be if audio used video timescale instead
        hypotheticalDeltaMs_audioAt90k: (tracks.video && tracks.audio?.tfdtRaw != null)
          ? Math.round(((tracks.audio.tfdtRaw / timescale) - tracks.video.tfdt) * 1000) : null,
        hypotheticalDeltaMs_audioAt48k: (tracks.video && tracks.audio?.tfdtRaw != null)
          ? Math.round(((tracks.audio.tfdtRaw / 48000) - tracks.video.tfdt) * 1000) : null,
        hypotheticalDeltaMs_audioAt44k1: (tracks.video && tracks.audio?.tfdtRaw != null)
          ? Math.round(((tracks.audio.tfdtRaw / 44100) - tracks.video.tfdt) * 1000) : null,
      });
      // S4 — raw MP4 box values (fire for every segment, before/independent of promotion)
      this._trace(worker, 'avsync.mp4', {
        segment:              file,
        videoTfdt:            tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        videoTimescale:       timescale,
        videoTfdtRaw:         tracks.video?.tfdtRaw ?? null,
        videoEarliestPts:     tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        videoLatestPts:       tracks.video?.end  != null ? +tracks.video.end.toFixed(6)  : null,
        audioTfdt:            tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        audioTimescale:       audioTimescaleUsed,
        audioTfdtRaw:         tracks.audio?.tfdtRaw ?? null,
        audioEarliestPts:     tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        audioLatestPts:       tracks.audio?.end  != null ? +tracks.audio.end.toFixed(6)  : null,
        audioMinusVideoTfdtMs: tracks.video && tracks.audio
          ? Math.round((tracks.audio.tfdt - tracks.video.tfdt) * 1000) : null,
      });
      // S5 — rebase pipeline (fragment TFDT seconds → timeline seconds)
      this._trace(worker, 'avsync.rebase', {
        segment:          file,
        workerStartTime:  +worker.seekOffset.toFixed(3),
        videoTfdtSeconds: tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        audioTfdtSeconds: tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        formula:          clock.basis === 'relative'
          ? 'timeline = workerStartTime + fragmentTime'
          : 'timeline = fragmentTime',
        clockBasis:       clock.basis,
        timestampOffset:  +clock.timestampOffset.toFixed(3),
        videoStart:       videoStart != null ? +videoStart.toFixed(3) : null,
        audioStart:       audioStart != null ? +audioStart.toFixed(3) : null,
        trackDeltaMs,
      });
      // S-DIAG: per-mode test data (Test 1/2) + root cause detector (Test 5)
      this._trace(worker, 'avsync.transcode_test', {
        diagMode:      process.env.AVSYNC_DIAG_MODE ?? 'normal',
        segment:       file,
        videoFirstPts: tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        audioFirstPts: tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        videoLatestPts: tracks.video?.end != null ? +tracks.video.end.toFixed(6) : null,
        audioLatestPts: tracks.audio?.end != null ? +tracks.audio.end.toFixed(6) : null,
        trackDeltaMs,
      });
      if (trackDeltaMs != null) {
        const _drift   = Math.abs(trackDeltaMs);
        const _dMode   = process.env.AVSYNC_DIAG_MODE ?? null;
        let _rootCause = null;
        if (!_dMode && _drift > 500)                                _rootCause = 'FFMPEG_FRAGMENT_GENERATION';
        else if (_dMode === 'force_transcode_both' && _drift < 100) _rootCause = 'COPY_VIDEO_TRANSCODE_AUDIO_TIMESTAMP_MISMATCH';
        else if (_dMode?.startsWith('ts_norm_') && _drift < 100)   _rootCause = 'TIMESTAMP_REBASING';
        if (_rootCause) {
          this._trace(worker, 'avsync.root_cause', {
            diagMode: _dMode ?? 'normal', audioMinusVideoMs: trackDeltaMs,
            drift: _drift, rootCause: _rootCause,
          });
        }
      }
      // Tests 3 + 4: ffprobe + mpegts remux comparison on first segment
      if (!worker._diagProbeDone) {
        worker._diagProbeDone = true;
        this._runDiagProbes(worker, segPath, tracks);
      }
    }
    if (avDurationSummary) {
      this._runAvDurationFfprobe(worker, destPath, destName, avDurationSummary);
    }
    this._trace(worker, 'seek.proof.written', {
      stage: 'written_to_hls_dir',
      sourceFile: file,
      file: destName,
      destPath,
      existsOnDisk: !!destStat,
      fileSize: destStat?.size ?? null,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      startTime: +absoluteStart.toFixed(3),
      endTime: +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      overlapsTarget,
      timelineCount: session.timeline.count(),
    });

    worker.segmentsGenerated++;
    worker._segsPromoted++;

    // Register in timeline (authoritative).
    if (!this._isCurrentWorker(worker)) return;

    const countBefore = session.timeline.count();
	    const entry = session.timeline.register({
      file:      destName,
      startTime: absoluteStart,
      endTime:   absoluteEnd,
      source:    'seek',
      byteOffset: worker.safePoint?.byteOffset ?? worker.seekByte,
      clusterOffset: worker.safePoint?.clusterOffset ?? worker.seekByte,
      decodeStartTime: worker.seekOffset,
      segmentId: destName,
    });
	    const countAfter = session.timeline.count();
	    if (!this._isCurrentWorker(worker)) return;
	    session._generationOwnership ??= new Map();
	    session._generationOwnership.set(destName, {
	      generation: worker.generation,
	      workerId: worker.jobId,
	      seekEpoch: worker.seekEpoch ?? null,
	      source: 'seek',
	      createdAt: Date.now(),
	    });
	    this._trace(worker, 'timeline.insert', {
	      segment: destName,
	      start: +absoluteStart.toFixed(3),
	      end: +absoluteEnd.toFixed(3),
	      generation: worker.generation,
	      workerId: worker.jobId,
	      seekEpoch: worker.seekEpoch ?? null,
	      source: 'seek',
	    });
	    this._trace(worker, 'generation.timeline_insert', {
	      segment: destName,
	      generation: worker.generation,
	      workerId: worker.jobId,
	      seekEpoch: worker.seekEpoch ?? null,
	      timelineStart: +absoluteStart.toFixed(3),
	      timelineEnd: +absoluteEnd.toFixed(3),
	      currentGeneration: this._seekGeneration,
	    });
    this._trace(worker, 'track_timeline.registration', {
      ...trackTimeline.registration,
      inserted: countAfter > countBefore,
      timelineCountBefore: countBefore,
      timelineCountAfter: countAfter,
    });

    if (countAfter > countBefore) {
      worker._timelineInserted++;
      this._trace(worker, 'seek.timeline_insert', {
        file: destName,
        relativeStart:       +relativeStart.toFixed(3),
        relativeEnd:         +relativeEnd.toFixed(3),
        seekOffset:          +worker.seekOffset.toFixed(3),
        startTime:           +absoluteStart.toFixed(3),
        endTime:             +absoluteEnd.toFixed(3),
        absoluteStart:       +absoluteStart.toFixed(3),
        absoluteEnd:         +absoluteEnd.toFixed(3),
        targetTime:          +worker.seekTime.toFixed(3),
        overlapsTarget,
        timelineCountBefore: countBefore,
        timelineCountAfter:  countAfter,
      });
      this._trace(worker, 'seek.timeline.inserted', {
        file: destName,
        relativeStart: +relativeStart.toFixed(3),
        relativeEnd: +relativeEnd.toFixed(3),
        seekOffset: +worker.seekOffset.toFixed(3),
        absoluteStart: +absoluteStart.toFixed(3),
        absoluteEnd: +absoluteEnd.toFixed(3),
        targetTime: +worker.seekTime.toFixed(3),
        overlapsTarget,
        timelineCount: countAfter,
      });
    } else {
      this._trace(worker, 'seek.timeline_reject', {
        file: destName, reason: 'no_count_increase',
        relativeStart, relativeEnd, seekOffset: worker.seekOffset,
        startTime: absoluteStart, endTime: absoluteEnd,
        absoluteStart, absoluteEnd,
        targetTime: worker.seekTime,
        overlapsTarget,
        countBefore, countAfter,
      });
    }

    this._trace(worker, 'seek.proof.timeline', {
      stage: 'timeline_register',
      file: destName,
      inserted: countAfter > countBefore,
      timelineCountBefore: countBefore,
      timelineCountAfter: countAfter,
      timelineCountIncreased: countAfter > countBefore,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      startTime: +absoluteStart.toFixed(3),
      endTime: +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      overlapsTarget,
      timelineEntry: toSegmentPayload(entry),
    });

    // Emit segment:ready so the SSE feed delivers it to the frontend.
    if (!this._isCurrentWorker(worker)) return;
	    session.events.emit('segment:ready', {
	      ...toSegmentPayload(entry),
	      generation: worker.generation,
	      workerId: worker.jobId,
	      seekEpoch: worker.seekEpoch ?? null,
	    });
    this._trace(worker, 'seek.segment.promoted', {
      file: destName,
      relativeStart,
      relativeEnd,
      seekOffset: worker.seekOffset,
      startTime: absoluteStart,
      endTime: absoluteEnd,
      absoluteStart,
      absoluteEnd,
      targetTime: worker.seekTime,
      overlapsTarget,
      duration: absoluteEnd - absoluteStart,
      segmentsGenerated: worker.segmentsGenerated,
      elapsedMs: Date.now() - worker.startedAt,
    });
    this._trace(worker, 'seek.proof.promoted', {
      stage: 'segment_ready_emitted',
      file: destName,
      promoted: true,
      emitted: true,
      existsOnDisk: !!destStat,
      fileSize: destStat?.size ?? null,
      relativeStart: +relativeStart.toFixed(3),
      relativeEnd: +relativeEnd.toFixed(3),
      seekOffset: +worker.seekOffset.toFixed(3),
      startTime: +absoluteStart.toFixed(3),
      endTime: +absoluteEnd.toFixed(3),
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      targetTime: +worker.seekTime.toFixed(3),
      overlapsTarget,
      timelineCount: countAfter,
    });

    if (isPreroll) {
      this._trace(worker, 'seek.preroll.promote', {
        file:          destName,
        absoluteStart: +absoluteStart.toFixed(3),
        absoluteEnd:   +absoluteEnd.toFixed(3),
        targetTime:    +worker.seekTime.toFixed(3),
        prerollIndex:  worker._prerollCount - 1,
      });
    }
    // S2 — first promoted segment per worker
    if (!worker._avSyncFirstSegDone) {
      worker._avSyncFirstSegDone = true;
      this._trace(worker, 'avsync.first_segment', {
        segment:               destName,
        absoluteStart:         +absoluteStart.toFixed(3),
        absoluteEnd:           +absoluteEnd.toFixed(3),
        videoTfdtRaw:          tracks?.video?.tfdtRaw ?? null,
        audioTfdtRaw:          tracks?.audio?.tfdtRaw ?? null,
        videoTimescale:        timescale,
        audioTimescale:        audioTimescaleUsed,
        videoTfdtSeconds:      tracks?.video?.tfdt != null ? +tracks.video.tfdt.toFixed(6) : null,
        audioTfdtSeconds:      tracks?.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(6) : null,
        clockBasis:            clock.basis,
        timestampOffset:       +clock.timestampOffset.toFixed(3),
        videoStart:            tracks?.video ? +_fragmentTimeToTimeline(clock, tracks.video.start).toFixed(3) : null,
        audioStart:            tracks?.audio ? +_fragmentTimeToTimeline(clock, tracks.audio.start).toFixed(3) : null,
        actualAudioMinusVideoMs: tracks?.video && tracks?.audio
          ? Math.round((tracks.audio.start - tracks.video.start) * 1000) : null,
      });
    }
    // S3 — every promoted segment
    this._trace(worker, 'avsync.segment', {
      segment:      destName,
      clockBasis:   clock.basis,
      timestampOffset: +clock.timestampOffset.toFixed(3),
      videoStart:   tracks?.video ? +_fragmentTimeToTimeline(clock, tracks.video.start).toFixed(3) : null,
      audioStart:   tracks?.audio ? +_fragmentTimeToTimeline(clock, tracks.audio.start).toFixed(3) : null,
      videoEnd:     tracks?.video?.end != null ? +_fragmentTimeToTimeline(clock, tracks.video.end).toFixed(3) : null,
      audioEnd:     tracks?.audio?.end != null ? +_fragmentTimeToTimeline(clock, tracks.audio.end).toFixed(3) : null,
      trackDeltaMs: tracks?.video && tracks?.audio
        ? Math.round((tracks.audio.start - tracks.video.start) * 1000) : null,
    });
    log(NS, `Segment ${destName} rel=[${relativeStart.toFixed(2)}-${relativeEnd.toFixed(2)}s] abs=[${absoluteStart.toFixed(2)}-${absoluteEnd.toFixed(2)}s] target=${worker.seekTime.toFixed(3)}s overlap=${overlapsTarget} timeline=${countBefore}->${countAfter}`);
  }

  async _maybeNormalizeTfdt(worker, { segPath, segment, segmentNumber, tracks, videoTimescale, audioTimescale }) {
    const videoTfdtSeconds = tracks.video?.tfdt ?? null;
    const audioTfdtSeconds = tracks.audio?.tfdt ?? null;
    const deltaSeconds = audioTfdtSeconds != null && videoTfdtSeconds != null
      ? audioTfdtSeconds - videoTfdtSeconds
      : null;
    const deltaMs = deltaSeconds != null ? Math.round(deltaSeconds * 1000) : null;
    const basePayload = {
      segment,
      videoTfdtSeconds,
      audioTfdtSeconds,
      deltaMs,
      enabled: ENABLE_TFDT_NORMALIZATION,
    };
    this._trace(worker, 'tfdt.normalization.detected', basePayload);
    this._recordTfdtNormalizationMetric(worker, {
      segment,
      segmentNumber,
      videoTfdt: videoTfdtSeconds,
      audioTfdt: audioTfdtSeconds,
      deltaMs,
      normalized: false,
      correctedDeltaMs: null,
      stage: 'pre',
    });

    const skip = reason => {
      this._trace(worker, 'tfdt.normalization.skipped', { ...basePayload, reason });
      this._recordTfdtNormalizationMetric(worker, {
        segment,
        segmentNumber,
        videoTfdt: videoTfdtSeconds,
        audioTfdt: audioTfdtSeconds,
        deltaMs,
        normalized: false,
        correctedDeltaMs: deltaMs,
        stage: 'post',
        reason,
      });
      return { tracks, applied: false, reason };
    };

    if (!ENABLE_TFDT_NORMALIZATION) return skip('disabled');
    if (segmentNumber === 0) return skip('segment0_reference');
    if (videoTfdtSeconds == null || audioTfdtSeconds == null) return skip('missing_tfdt');
    if (!Number.isFinite(videoTimescale) || !Number.isFinite(audioTimescale) || videoTimescale <= 0 || audioTimescale <= 0) {
      return skip('invalid_timescale');
    }
    if (Math.abs(deltaMs ?? 0) <= TFDT_NORMALIZATION_THRESHOLD_MS) return skip('below_threshold');

    const correctedAudioTfdt = audioTfdtSeconds - deltaSeconds;
    const correctedAudioTfdtRaw = Math.round(correctedAudioTfdt * audioTimescale);
    const trackId = tracks.audio?.trackId ?? 2;
    const rewrite = await rewriteTrackTfdt(segPath, {
      trackId,
      tfdtRaw: correctedAudioTfdtRaw,
    });
    if (!rewrite.ok) {
      this._trace(worker, 'tfdt.normalization.skipped', {
        ...basePayload,
        reason: rewrite.reason ?? 'rewrite_failed',
        rewrite,
      });
      return { tracks, applied: false, reason: rewrite.reason ?? 'rewrite_failed' };
    }

    this._trace(worker, 'tfdt.normalization.applied', {
      segment,
      originalAudioTfdt: audioTfdtSeconds,
      videoTfdt: videoTfdtSeconds,
      deltaMs,
      correctedAudioTfdt,
      audioTrackId: trackId,
      originalAudioTfdtRaw: rewrite.oldTfdtRaw,
      correctedAudioTfdtRaw: rewrite.newTfdtRaw,
    });

    const correctedTracks = await readFragmentTracks(segPath, {
      videoTimescale,
      audioTimescale,
    });
    const correctedDeltaMs = correctedTracks.video && correctedTracks.audio
      ? Math.round((correctedTracks.audio.tfdt - correctedTracks.video.tfdt) * 1000)
      : null;
    this._trace(worker, 'tfdt.normalization.validation', {
      segment,
      correctedDeltaMs,
    });
    this._recordTfdtNormalizationMetric(worker, {
      segment,
      segmentNumber,
      videoTfdt: correctedTracks.video?.tfdt ?? videoTfdtSeconds,
      audioTfdt: correctedTracks.audio?.tfdt ?? correctedAudioTfdt,
      deltaMs,
      normalized: true,
      correctedDeltaMs,
      stage: 'post',
    });

    return { tracks: correctedTracks, applied: true, correctedDeltaMs };
  }

  _recordTfdtNormalizationMetric(worker, entry) {
    if (entry.segmentNumber == null || entry.segmentNumber < 0 || entry.segmentNumber > 4) return;
    worker._tfdtNormalization ??= {
      entries: [],
      pre: new Map(),
      post: new Map(),
    };
    worker._tfdtNormalization.entries.push(entry);
    if (entry.stage === 'pre') worker._tfdtNormalization.pre.set(entry.segmentNumber, entry);
    if (entry.stage === 'post') worker._tfdtNormalization.post.set(entry.segmentNumber, entry);
    this._trace(worker, 'tfdt.normalization.metric', entry);
  }

  _recordFirstFiveDriftDiagnostics(worker, detail) {
    const n = detail.segmentNumber;
    if (n == null || n < 0 || n > 4) return;
    worker._firstFiveDrift ??= {
      segments: new Map(),
      continuity: [],
      finalReportEmitted: false,
    };

    const v = detail.tracks.video ?? null;
    const a = detail.tracks.audio ?? null;
    const record = {
      segment: detail.segment,
      segmentNumber: n,
      mp4Timing: {
        segment: detail.segment,
        videoTfdtRaw: v?.tfdtRaw ?? null,
        audioTfdtRaw: a?.tfdtRaw ?? null,
        videoTimescale: detail.videoTimescale,
        audioTimescale: detail.audioTimescale,
        videoTfdtSeconds: v?.tfdt ?? null,
        audioTfdtSeconds: a?.tfdt ?? null,
        tfdtDeltaMs: _deltaMs(a?.tfdt, v?.tfdt),
      },
      packetTiming: {
        segment: detail.segment,
        videoFirstPts: v?.firstPts ?? null,
        videoLastPts: v?.lastPts ?? null,
        audioFirstPts: a?.firstPts ?? null,
        audioLastPts: a?.lastPts ?? null,
        firstPtsDeltaMs: _deltaMs(a?.firstPts, v?.firstPts),
        lastPtsDeltaMs: _deltaMs(a?.lastPts, v?.lastPts),
      },
      samples: {
        segment: detail.segment,
        videoSampleCount: v?.sampleCount ?? null,
        audioSampleCount: a?.sampleCount ?? null,
        videoDuration: v?.duration ?? null,
        audioDuration: a?.duration ?? null,
        durationDeltaMs: _deltaMs(a?.duration, v?.duration),
      },
    };

    worker._firstFiveDrift.segments.set(n, record);
    this._trace(worker, 'seek.first5.mp4_timing', record.mp4Timing);
    this._trace(worker, 'seek.first5.packet_timing', record.packetTiming);
    this._trace(worker, 'seek.first5.samples', record.samples);

    if (n > 0 && worker._firstFiveDrift.segments.has(n - 1)) {
      const prev = worker._firstFiveDrift.segments.get(n - 1);
      const continuity = _buildContinuity(prev, record);
      worker._firstFiveDrift.continuity.push(continuity);
      this._trace(worker, 'seek.first5.continuity', continuity);
    }

    if (n === 4) this._emitFirstFiveFinalReport(worker);
  }

  _emitFirstFiveFinalReport(worker) {
    const state = worker._firstFiveDrift;
    if (!state || state.finalReportEmitted) return;
    const segs = [0, 1, 2, 3, 4].map(i => state.segments.get(i) ?? null);
    if (segs.some(s => !s)) return;

    const deltas = segs.map(s => s.packetTiming.firstPtsDeltaMs ?? s.mp4Timing.tfdtDeltaMs ?? null);
    const c01 = state.continuity.find(c => c.fromSegment === 'segment_00000.m4s' && c.toSegment === 'segment_00001.m4s') ?? null;
    const segment0 = segs[0];
    const segment1 = segs[1];
    const segment0Drift = Math.abs(deltas[0] ?? 0);
    const segment1Drift = Math.abs(deltas[1] ?? 0);
    const tfdtJump = c01 && Math.abs(segment1.mp4Timing.tfdtDeltaMs ?? 0) > 100
      && Math.abs(c01.audioGapMs ?? 0) <= 100
      && Math.abs(c01.videoGapMs ?? 0) <= 100;
    const audioGapOnly = c01
      && Math.abs(c01.audioGapMs ?? 0) > 100
      && Math.abs(c01.videoGapMs ?? 0) <= 100;
    const firstDurationDivergence = Math.abs(segment0.samples.durationDeltaMs ?? 0) > 100;
    const ffprobe = worker._avRootCause?.ffprobe ?? null;
    const parserBug = segment0Drift > 100
      && ffprobe?.audioMinusVideoStartMs != null
      && Math.abs(ffprobe.audioMinusVideoStartMs) <= 100;

    let rootCause;
    let mostLikelyFix;
    if (parserBug) {
      rootCause = 'INTERNAL_MP4_PARSER_BUG';
      mostLikelyFix = 'Fix backend fMP4 parser/timescale/track association before changing FFmpeg or playback.';
    } else if (segment0Drift > 100) {
      rootCause = 'FIRST_FRAGMENT_BAD';
      mostLikelyFix = 'Change seek-worker FFmpeg generation path; first fragment is already desynced.';
    } else if (firstDurationDivergence) {
      rootCause = 'FIRST_SEGMENT_DURATION_DIVERGENCE';
      mostLikelyFix = 'Inspect FFmpeg first-fragment cut/mux duration handling before compensation.';
    } else if (audioGapOnly) {
      rootCause = 'AUDIO_PACKET_GAP_BETWEEN_SEGMENTS';
      mostLikelyFix = 'Investigate FFmpeg audio packet continuity at first HLS fMP4 fragment boundary.';
    } else if (tfdtJump) {
      rootCause = 'TFDT_BASE_DECODE_TIME_JUMP';
      mostLikelyFix = 'Investigate FFmpeg baseMediaDecodeTime assignment across seek-worker fragments.';
    } else if (segment1Drift > 100) {
      rootCause = 'SEGMENT_BOUNDARY_AUDIO_SHIFT';
      mostLikelyFix = 'Change FFmpeg seek-worker muxing/transcode strategy; drift appears at segment_00000 -> segment_00001 boundary.';
    } else {
      rootCause = 'NO_DRIFT_IN_FIRST_FIVE';
      mostLikelyFix = 'Reproduce another seek; first five generated fragments did not show the reported drift.';
    }

    const report = {
      title: 'AV DRIFT ROOT CAUSE REPORT',
      seek: {
        requestedTime: worker.seekTime,
        workerStartTime: worker.seekOffset,
        gap: worker.seekTime - worker.seekOffset,
      },
      ffmpeg: {
        mode: worker._commandAudit?.mode ?? null,
        videoCopy: worker._commandAudit?.videoCopy ?? null,
        audioCopy: worker._commandAudit?.audioCopy ?? null,
        qualityProfile: worker._commandAudit?.qualityProfile ?? null,
        cmdLine: worker._commandAudit?.cmdLine ?? worker._commandAudit?.ffmpegCommand ?? null,
      },
      segmentDrift: {
        segment_00000: deltas[0],
        segment_00001: deltas[1],
        segment_00002: deltas[2],
        segment_00003: deltas[3],
        segment_00004: deltas[4],
      },
      continuity: {
        videoGap00000To00001: c01?.videoGapMs ?? null,
        audioGap00000To00001: c01?.audioGapMs ?? null,
        firstBoundary: c01,
        all: state.continuity,
      },
      tfdtNormalization: _buildTfdtNormalizationSeekSummary(worker),
      classification: {
        ROOT_CAUSE: rootCause,
        mostLikelyFix,
      },
      segments: segs,
      ffprobeSegment0: ffprobe,
    };

    state.finalReportEmitted = true;
    this._trace(worker, 'seek.first5.final_report', report);
  }

  _recordSeekAvRootCauseSegment(worker, detail) {
    const segmentNumber = detail.segmentNumber;
    if (segmentNumber == null || segmentNumber < 0 || segmentNumber > 4) return;

    worker._avRootCause ??= {
      firstFive: [],
      segment0: null,
      firstDivergence: null,
      rebaseIntroduced: false,
      reportEmitted: false,
      ffprobeReportEmitted: false,
      lastReport: null,
      ffprobe: null,
    };

    const v = detail.tracks.video ?? null;
    const a = detail.tracks.audio ?? null;
    const entry = {
      segment: detail.segment,
      segmentNumber,
      videoTfdt: v?.tfdt ?? null,
      audioTfdt: a?.tfdt ?? null,
      videoFirstPts: v?.firstPts ?? null,
      audioFirstPts: a?.firstPts ?? null,
      absoluteVideoStart: detail.trackBase.absoluteVideoStart,
      absoluteAudioStart: detail.trackBase.absoluteAudioStart,
    };

    const existingIndex = worker._avRootCause.firstFive.findIndex(s => s.segmentNumber === segmentNumber);
    if (existingIndex === -1) worker._avRootCause.firstFive.push(entry);
    else worker._avRootCause.firstFive[existingIndex] = entry;
    worker._avRootCause.firstFive.sort((x, y) => x.segmentNumber - y.segmentNumber);

    const deltaMs = _deltaMs(entry.absoluteAudioStart, entry.absoluteVideoStart)
      ?? _deltaMs(entry.audioFirstPts, entry.videoFirstPts)
      ?? _deltaMs(entry.audioTfdt, entry.videoTfdt);
    if (!worker._avRootCause.firstDivergence && Math.abs(deltaMs ?? 0) > 100) {
      worker._avRootCause.firstDivergence = {
        message: 'FIRST_DIVERGENCE_DETECTED',
        segment: detail.segment,
        segmentNumber,
        deltaMs,
      };
      this._trace(worker, 'seek.first_divergence.detected', worker._avRootCause.firstDivergence);
    }

    if (segmentNumber === 0) {
      worker._avRootCause.segment0 = {
        forensics: _buildSegment0Forensics({
          worker,
          segment: detail.segment,
          tracks: detail.tracks,
          videoTimescale: detail.timescale,
          audioTimescale: detail.audioTimescaleUsed,
        }),
        rawBoxes: _buildSegment0RawBoxes({
          worker,
          segment: detail.segment,
          tracks: detail.tracks,
          videoTimescale: detail.timescale,
          audioTimescale: detail.audioTimescaleUsed,
        }),
        rebaseTrace: _buildRebaseTrace({
          worker,
          segment: detail.segment,
          tracks: detail.tracks,
          trackBase: detail.trackBase,
        }),
      };
    }

    this._maybeEmitSeekAvRootCauseReport(worker);
  }

  _maybeEmitSeekAvRootCauseReport(worker) {
    const state = worker._avRootCause;
    if (!state || !state.segment0) return;
    if (state.reportEmitted && (!state.ffprobe || state.ffprobeReportEmitted)) return;

    const seg0 = state.segment0.forensics;
    const seg0Desynced = Math.abs(seg0.tfdtDeltaMs ?? 0) > 100
      || Math.abs(seg0.firstPtsDeltaMs ?? 0) > 100;
    const rebase = state.segment0.rebaseTrace;
    const rawDelta = seg0.firstPtsDeltaMs ?? seg0.tfdtDeltaMs ?? 0;
    const absoluteDelta = _deltaMs(rebase.after.absoluteAudioTime, rebase.after.absoluteVideoTime) ?? 0;
    const rebaseIntroduced = Math.abs(rawDelta) <= 100 && Math.abs(absoluteDelta) > 100;
    const laterDivergence = !seg0Desynced && !rebaseIntroduced && state.firstDivergence?.segmentNumber >= 3;

    let rootCause = 'PENDING_MORE_SEGMENTS';
    let firstDriftCodeLocation = null;
    if (seg0Desynced) {
      rootCause = 'FFMPEG_GENERATION';
      firstDriftCodeLocation = 'backend/pipeline/ffmpeg.js:HlsGenerator.start() seek-worker FFmpeg command output';
    } else if (rebaseIntroduced) {
      rootCause = 'TIMELINE_REBASE';
      firstDriftCodeLocation = 'backend/pipeline/seek.js:_fragmentTimeToTimeline() / _resolveSeekFragmentClock()';
    } else if (laterDivergence) {
      rootCause = 'SEGMENT_CONTINUITY';
      firstDriftCodeLocation = 'backend/pipeline/seek.js:SeekWorkerManager._processSegment() generated segment chain';
    }

    if (rootCause === 'PENDING_MORE_SEGMENTS' && state.firstFive.length < 5) return;
    if (rootCause === 'PENDING_MORE_SEGMENTS') {
      rootCause = 'NO_DIVERGENCE_IN_FIRST_FIVE';
      firstDriftCodeLocation = null;
    }

    const report = {
      workerId: worker.jobId,
      generation: worker.generation,
      requestedSeekTime: worker.seekTime,
      workerStartTime: worker.seekOffset,
      questions: {
        segment00000AlreadyDesynced: seg0Desynced,
        ffmpegMode: {
          videoCopy: worker._commandAudit?.videoCopy ?? null,
          audioCopy: worker._commandAudit?.audioCopy ?? null,
          videoCodecMode: worker._commandAudit?.videoCodecMode ?? null,
          audioCodecMode: worker._commandAudit?.audioCodecMode ?? null,
        },
        tfdtValuesAlreadyDifferent: Math.abs(seg0.tfdtDeltaMs ?? 0) > 100,
        firstPtsValuesAlreadyDifferent: Math.abs(seg0.firstPtsDeltaMs ?? 0) > 100,
        rebasingIntroducesOffset: rebaseIntroduced,
        firstDriftCodeLocation,
      },
      rootCause,
      rootCauseMarker: rootCause === 'PENDING_MORE_SEGMENTS' ? null : `ROOT_CAUSE: ${rootCause}`,
      segment0: state.segment0,
      firstFive: state.firstFive,
      firstDivergence: state.firstDivergence,
      commandAudit: worker._commandAudit ?? null,
      ffprobe: state.ffprobe,
    };

    state.lastReport = report;
    state.reportEmitted = true;
    if (state.ffprobe) state.ffprobeReportEmitted = true;
    this._trace(worker, 'seek.av_root_cause.report', report);
  }

  _runSegment0Ffprobe(worker, segPath) {
    this._probeSegmentStreams(segPath).then(result => {
      if (!this._isCurrentWorker(worker)) return;
      worker._avRootCause ??= {
        firstFive: [],
        segment0: null,
        firstDivergence: null,
        reportEmitted: false,
        ffprobeReportEmitted: false,
        lastReport: null,
        ffprobe: null,
      };
      worker._avRootCause.ffprobe = result;
      this._trace(worker, 'seek.segment0.ffprobe', result);
      this._maybeEmitSeekAvRootCauseReport(worker);
    }).catch(() => {});
  }

  _probeSegmentStreams(segPath) {
    return new Promise(resolve => {
      const out = [];
      const proc = cpSpawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        segPath,
      ]);
      proc.stdout.on('data', d => out.push(d));
      proc.on('close', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(out).toString()); } catch {}
        const streams = parsed?.streams ?? [];
        const video = streams.find(s => s.codec_type === 'video') ?? null;
        const audio = streams.find(s => s.codec_type === 'audio') ?? null;
        const vStart = video?.start_time != null ? parseFloat(video.start_time) : null;
        const aStart = audio?.start_time != null ? parseFloat(audio.start_time) : null;
        resolve({
          segment: path.basename(segPath),
          video: video ? {
            start_time: video.start_time ?? null,
            duration: video.duration ?? null,
            nb_frames: video.nb_frames ?? null,
          } : null,
          audio: audio ? {
            start_time: audio.start_time ?? null,
            duration: audio.duration ?? null,
            nb_frames: audio.nb_frames ?? null,
            sample_rate: audio.sample_rate ?? null,
          } : null,
          audioMinusVideoStartMs: _deltaMs(aStart, vStart),
        });
      });
      proc.on('error', () => resolve({
        segment: path.basename(segPath),
        video: null,
        audio: null,
        audioMinusVideoStartMs: null,
        error: 'ffprobe_failed',
      }));
      setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve({
          segment: path.basename(segPath),
          video: null,
          audio: null,
          audioMinusVideoStartMs: null,
          error: 'ffprobe_timeout',
        });
      }, 8000);
    });
  }

  // ── Diagnostic probe helpers (Tests 3 + 4) ──────────────────────────────────

  _probeSegment(segPath) {
    return new Promise(resolve => {
      const out = [];
      const proc = cpSpawn('ffprobe', [
        '-v', 'quiet', '-print_format', 'json',
        '-show_packets', '-select_streams', 'v:0,a:0',
        '-read_intervals', '%+#8',
        segPath,
      ]);
      proc.stdout.on('data', d => out.push(d));
      proc.on('close', () => {
        try { resolve(JSON.parse(Buffer.concat(out).toString())); }
        catch { resolve(null); }
      });
      proc.on('error', () => resolve(null));
      setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 8000);
    });
  }

  _remuxToTs(srcPath, dstPath) {
    return new Promise(resolve => {
      const proc = cpSpawn('ffmpeg', [
        '-v', 'quiet', '-i', srcPath, '-c', 'copy', '-f', 'mpegts', '-y', dstPath,
      ]);
      proc.on('close', code => resolve(code === 0));
      proc.on('error', () => resolve(false));
      setTimeout(() => { try { proc.kill(); } catch {} resolve(false); }, 8000);
    });
  }

  _traceAvDurationInternal(worker, { segment, tracks, expectedDuration }) {
    const video = tracks.video ? {
      packetCount: tracks.video.sampleCount ?? null,
      firstPts: tracks.video.start,
      lastPts: tracks.video.end,
      duration: tracks.video.duration,
    } : null;
    const audio = tracks.audio ? {
      packetCount: tracks.audio.sampleCount ?? null,
      firstPts: tracks.audio.start,
      lastPts: tracks.audio.end,
      duration: tracks.audio.duration,
    } : null;
    const durationDeltaMs = video?.duration != null && audio?.duration != null
      ? Math.round((audio.duration - video.duration) * 1000) : null;
    const startDeltaMs = video?.firstPts != null && audio?.firstPts != null
      ? Math.round((audio.firstPts - video.firstPts) * 1000) : null;

    const summary = { segment, video, audio, durationDeltaMs, startDeltaMs };
    this._trace(worker, 'avduration.segment', summary);

    if (durationDeltaMs != null && Math.abs(durationDeltaMs) > 100 && !worker._avDurationFirstBad) {
      worker._avDurationFirstBad = true;
      this._trace(worker, 'avduration.first_bad', {
        marker: 'FIRST_DURATION_MISMATCH',
        segment,
        videoDuration: video?.duration ?? null,
        audioDuration: audio?.duration ?? null,
        durationDeltaMs,
      });
    }

    this._trace(worker, 'avduration.boundary', {
      segment,
      expectedDuration,
      actualVideoDuration: video?.duration ?? null,
      actualAudioDuration: audio?.duration ?? null,
      videoMinusExpectedMs: video?.duration != null && expectedDuration != null
        ? Math.round((video.duration - expectedDuration) * 1000) : null,
      audioMinusExpectedMs: audio?.duration != null && expectedDuration != null
        ? Math.round((audio.duration - expectedDuration) * 1000) : null,
    });

    if (worker._avDurationPrev) {
      const prev = worker._avDurationPrev;
      const videoGapMs = prev.video?.lastPts != null && video?.firstPts != null
        ? Math.max(0, Math.round((video.firstPts - prev.video.lastPts) * 1000)) : null;
      const audioGapMs = prev.audio?.lastPts != null && audio?.firstPts != null
        ? Math.max(0, Math.round((audio.firstPts - prev.audio.lastPts) * 1000)) : null;
      const videoOverlapMs = prev.video?.lastPts != null && video?.firstPts != null
        ? Math.max(0, Math.round((prev.video.lastPts - video.firstPts) * 1000)) : null;
      const audioOverlapMs = prev.audio?.lastPts != null && audio?.firstPts != null
        ? Math.max(0, Math.round((prev.audio.lastPts - audio.firstPts) * 1000)) : null;
      this._trace(worker, 'avduration.continuity', {
        segmentN: prev.segment,
        segmentNPlus1: segment,
        videoGapMs,
        audioGapMs,
        videoOverlapMs,
        audioOverlapMs,
      });
    }
    worker._avDurationPrev = summary;

    if (startDeltaMs != null && Math.abs(startDeltaMs) <= 5 &&
        durationDeltaMs != null && Math.abs(durationDeltaMs) > 100) {
      worker._avDurationParserMismatch = true;
      this._trace(worker, 'avduration.root_cause', {
        segment,
        rootCause: 'TRACK_DURATION_DIVERGENCE',
        reason: 'videoStart == audioStart but videoDuration != audioDuration',
        startDeltaMs,
        durationDeltaMs,
      });
    }

    if (durationDeltaMs != null) {
      worker._avDurationDeltas.push(durationDeltaMs);
      if (worker._avDurationDeltas.length > 5) worker._avDurationDeltas.shift();
      const recent = worker._avDurationDeltas.slice(-3);
      if (!worker._avDurationAccumulatingReported && recent.length === 3 &&
          recent.every(v => Math.abs(v) > 100) &&
          Math.max(...recent) - Math.min(...recent) <= 150) {
        worker._avDurationAccumulatingReported = true;
        this._trace(worker, 'avduration.root_cause', {
          segment,
          rootCause: 'ACCUMULATING_AUDIO_TIMELINE',
          reason: 'audio duration delta is roughly stable across consecutive segments',
          recentDurationDeltaMs: recent,
        });
      }
    }

    return summary;
  }

  _probeAvDuration(segPath) {
    return new Promise(resolve => {
      const out = [];
      const proc = cpSpawn('ffprobe', [
        '-v', 'quiet', '-print_format', 'json',
        '-show_streams', '-show_packets',
        segPath,
      ]);
      proc.stdout.on('data', d => out.push(d));
      proc.on('close', () => {
        try { resolve(JSON.parse(Buffer.concat(out).toString())); }
        catch { resolve(null); }
      });
      proc.on('error', () => resolve(null));
      setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 8000);
    });
  }

  async _runAvDurationFfprobe(worker, segPath, segment, internalSummary) {
    const probe = await this._probeAvDuration(segPath);
    if (!this._isCurrentWorker(worker) || !probe) return;

    const packetSummary = codecType => {
      const packets = (probe.packets ?? []).filter(p => p.codec_type === codecType);
      if (!packets.length) return { packetCount: 0, firstPts: null, lastPts: null, duration: null };
      const pts = packets.map(p => parseFloat(p.pts_time)).filter(Number.isFinite);
      const durations = packets.map(p => parseFloat(p.duration_time)).filter(Number.isFinite);
      const firstPts = pts.length ? Math.min(...pts) : null;
      let lastPts = pts.length ? Math.max(...pts) : null;
      if (lastPts != null) {
        const lastPacket = packets.reduce((best, p) => {
          const v = parseFloat(p.pts_time);
          return Number.isFinite(v) && (!best || v > parseFloat(best.pts_time)) ? p : best;
        }, null);
        const lastDur = parseFloat(lastPacket?.duration_time);
        if (Number.isFinite(lastDur)) lastPts += lastDur;
      }
      return {
        packetCount: packets.length,
        firstPts,
        lastPts,
        duration: durations.length ? durations.reduce((a, b) => a + b, 0) : (
          firstPts != null && lastPts != null ? lastPts - firstPts : null
        ),
      };
    };
    const streamByType = codecType => (probe.streams ?? []).find(s => s.codec_type === codecType) ?? null;
    const num = value => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : null;
    };
    const videoStream = streamByType('video');
    const audioStream = streamByType('audio');
    const videoPackets = packetSummary('video');
    const audioPackets = packetSummary('audio');
    const videoDuration = num(videoStream?.duration) ?? videoPackets.duration;
    const audioDuration = num(audioStream?.duration) ?? audioPackets.duration;
    const durationDeltaMs = videoDuration != null && audioDuration != null
      ? Math.round((audioDuration - videoDuration) * 1000) : null;

    this._trace(worker, 'avduration.ffprobe', {
      segment,
      video: videoStream ? {
        start_time: num(videoStream.start_time),
        duration: videoDuration,
        nb_frames: videoStream.nb_frames ?? videoPackets.packetCount ?? null,
        avg_frame_rate: videoStream.avg_frame_rate ?? null,
      } : null,
      audio: audioStream ? {
        start_time: num(audioStream.start_time),
        duration: audioDuration,
        nb_frames: audioStream.nb_frames ?? audioPackets.packetCount ?? null,
        sample_rate: audioStream.sample_rate != null ? Number(audioStream.sample_rate) : null,
      } : null,
      packetFallback: { video: videoPackets, audio: audioPackets },
      durationDeltaMs,
    });

    if (audioStream) {
      const tags = audioStream.tags ?? {};
      const sideData = audioStream.side_data_list ?? [];
      this._trace(worker, 'avduration.aac', {
        segment,
        codec: audioStream.codec_name ?? null,
        sampleRate: audioStream.sample_rate != null ? Number(audioStream.sample_rate) : null,
        channels: audioStream.channels ?? null,
        channelLayout: audioStream.channel_layout ?? null,
        encoderDelay: audioStream.initial_padding ?? tags.encoder_delay ?? tags.ENCODER_DELAY ?? null,
        primingSamples: audioStream.initial_padding ?? tags.priming_samples ?? tags.PRIMING_SAMPLES ?? null,
        paddingSamples: audioStream.trailing_padding ?? tags.padding_samples ?? tags.PADDING_SAMPLES ?? null,
        sideData,
      });
    }

    if (durationDeltaMs != null && Math.abs(durationDeltaMs) > 100) {
      worker._avDurationFfprobeMismatch = true;
      this._trace(worker, 'avduration.root_cause', {
        segment,
        rootCause: 'FFMPEG_GENERATED_FRAGMENT',
        reason: 'duration mismatch appears in ffprobe output',
        durationDeltaMs,
      });
    } else if (internalSummary?.durationDeltaMs != null &&
        Math.abs(internalSummary.durationDeltaMs) > 100 &&
        !worker._avDurationFfprobeMismatch) {
      this._trace(worker, 'avduration.root_cause', {
        segment,
        rootCause: 'TIMESTAMP_PARSER',
        reason: 'duration mismatch appears in internal parsing but not ffprobe output',
        parserDurationDeltaMs: internalSummary.durationDeltaMs,
        ffprobeDurationDeltaMs: durationDeltaMs,
      });
    }
  }

  async _runDiagProbes(worker, segPath, fmp4Tracks) {
    // Test 4: ffprobe verification — does the raw file already contain the offset?
    const probe = await this._probeSegment(segPath);
    if (probe?.packets) {
      const vPkt = probe.packets.find(p => p.codec_type === 'video');
      const aPkt = probe.packets.find(p => p.codec_type === 'audio');
      const vPts  = vPkt ? parseFloat(vPkt.pts_time)  : null;
      const aPts  = aPkt ? parseFloat(aPkt.pts_time)  : null;
      const vDts  = vPkt ? parseFloat(vPkt.dts_time)  : null;
      const aDts  = aPkt ? parseFloat(aPkt.dts_time)  : null;
      const probeDeltaMs = (vPts != null && aPts != null)
        ? Math.round((aPts - vPts) * 1000) : null;
      this._trace(worker, 'avsync.ffprobe', {
        segment:        path.basename(segPath),
        video:          vPkt ? { firstPts: vPts, firstDts: vDts, duration: parseFloat(vPkt.duration_time ?? 0) } : null,
        audio:          aPkt ? { firstPts: aPts, firstDts: aDts, duration: parseFloat(aPkt.duration_time ?? 0) } : null,
        audioMinusVideoMs: probeDeltaMs,
      });
      if (probeDeltaMs != null && Math.abs(probeDeltaMs) > 500) {
        this._trace(worker, 'avsync.root_cause', {
          diagMode: 'ffprobe_verified',
          audioMinusVideoMs: probeDeltaMs,
          drift: Math.abs(probeDeltaMs),
          rootCause: 'FFMPEG_FRAGMENT_GENERATION',
          note: 'ffprobe confirms offset exists in generated fMP4 file',
        });
      }
    }

    // Test 3: remux to MPEG-TS and compare — does fMP4 muxing introduce the offset?
    const tsPath = segPath + '.diag.ts';
    const remuxed = await this._remuxToTs(segPath, tsPath);
    if (remuxed) {
      const tsProbe = await this._probeSegment(tsPath);
      fs.unlink(tsPath, () => {});
      if (tsProbe?.packets) {
        const vPkt = tsProbe.packets.find(p => p.codec_type === 'video');
        const aPkt = tsProbe.packets.find(p => p.codec_type === 'audio');
        const tsDeltaMs = (vPkt && aPkt)
          ? Math.round((parseFloat(aPkt.pts_time) - parseFloat(vPkt.pts_time)) * 1000) : null;
        const fmp4DeltaMs = fmp4Tracks.video && fmp4Tracks.audio
          ? Math.round((fmp4Tracks.audio.tfdt - fmp4Tracks.video.tfdt) * 1000) : null;
        const verdict = (fmp4DeltaMs != null && tsDeltaMs != null)
          ? (Math.abs(fmp4DeltaMs - tsDeltaMs) < 50 ? 'SAME_IN_BOTH_MUXERS' : 'DIFFERS_BETWEEN_MUXERS')
          : null;
        this._trace(worker, 'avsync.mpegts_compare', {
          segment:              path.basename(segPath),
          fmp4_deltaMs:         fmp4DeltaMs,
          mpegts_deltaMs:       tsDeltaMs,
          delta_difference:     (fmp4DeltaMs != null && tsDeltaMs != null) ? (fmp4DeltaMs - tsDeltaMs) : null,
          verdict,
        });
        if (verdict === 'DIFFERS_BETWEEN_MUXERS' && tsDeltaMs != null && Math.abs(tsDeltaMs) < 100) {
          this._trace(worker, 'avsync.root_cause', {
            diagMode: 'mpegts_compare',
            rootCause: 'FMP4_MUXING',
            fmp4_deltaMs: fmp4DeltaMs, mpegts_deltaMs: tsDeltaMs,
            note: 'offset absent in MPEG-TS remux, present in fMP4',
          });
        }
      }
    }
  }

  _traceSpawnReport(worker, result) {
    if (!worker) return;
    const deltaSeconds = worker.seekOffset - worker.seekTime;
    this._trace(worker, 'seek.worker_spawn.report', {
      requestedSeekTime: +worker.seekTime.toFixed(3),
      workerStartTime: +worker.seekOffset.toFixed(3),
      deltaSeconds: +deltaSeconds.toFixed(3),
      segmentsGenerated: worker.segmentsGenerated,
      segmentsPromoted: worker._segsPromoted,
      coveringSegmentFound: !!worker._spawnCoveringFound,
      result,
      rootCauseCandidate: Math.abs(deltaSeconds) > 5
        ? 'WORKER_STARTED_FROM_WRONG_POSITION'
        : 'NOT_WORKER_POSITION',
    });
  }

  _isCurrentWorker(worker) {
    if (!worker || worker.state !== 'running') return false;
    if (worker.generation !== this._seekGeneration) return false;
    return this._workers.get(worker.jobId) === worker;
  }

  async _cleanupWorker(jobId) {
    const worker = this._workers.get(jobId);
    if (!worker) return;

    worker.stopPoll?.();
    this._workers.delete(jobId);

    // Resume the main encoder if it was paused for bandwidth and this is the last
    // worker finishing naturally. Don't resume on state='stopped' (killed for a new
    // seek) — startWorker will manage the paused state for the replacement worker.
    const finishedNaturally = worker.state === 'done' || worker.state === 'error';
    if (finishedNaturally && this._workers.size === 0 && this.session._mainPaused) {
      // Always clear the flag; only send SIGCONT if FFmpeg is still alive.
      if (this.session.generator?.running) {
        this.session.generator.resume();
        log(NS, `Worker ${jobId} ${worker.state} — resumed main encoder`);
      }
      this.session._mainPaused = false;
    }
    if (this.session._activeSeek?.jobId === jobId) {
      this.session._activeSeek = null;
    }

    // Best-effort cleanup of temp seek dir.
    try {
      await fs.promises.rm(worker.seekDir, { recursive: true, force: true });
    } catch {}
  }

  _trace(worker, phase, data = {}) {
    this.session.events.emit('server:trace', {
      phase,
      ns: NS,
      at: Date.now(),
      jobId: worker?.jobId ?? data.jobId,
      generation: worker?.generation ?? data.generation,
      seekEpoch: worker?.seekEpoch ?? data.seekEpoch,
      seekTime: worker?.seekTime ?? data.seekTime,
      seekByte: worker?.seekByte ?? data.seekByte,
      seekOffset: worker?.seekOffset ?? data.seekOffset,
      state: worker?.state,
      segmentsGenerated: worker?.segmentsGenerated,
      elapsedMs: worker?.startedAt ? Date.now() - worker.startedAt : undefined,
      ...data,
    });
  }
}

function _resolveSeekFragmentClock(worker, timing) {
  const fragmentStart = timing.startTime;
  const fragmentEnd = timing.endTime;
  const seekOffset = Number.isFinite(worker.seekOffset) ? worker.seekOffset : 0;
  const target = worker.seekTime;

  const relative = {
    basis: 'relative',
    fragmentStart,
    fragmentEnd,
    relativeStart: fragmentStart,
    relativeEnd: fragmentEnd,
    absoluteStart: seekOffset + fragmentStart,
    absoluteEnd: seekOffset + fragmentEnd,
    timestampOffset: seekOffset,
  };

  const absolute = {
    basis: 'absolute',
    fragmentStart,
    fragmentEnd,
    relativeStart: fragmentStart - seekOffset,
    relativeEnd: fragmentEnd - seekOffset,
    absoluteStart: fragmentStart,
    absoluteEnd: fragmentEnd,
    timestampOffset: 0,
  };

  const covers = c => c.absoluteStart <= target && target < c.absoluteEnd;
  const valid = c => Number.isFinite(c.absoluteStart)
    && Number.isFinite(c.absoluteEnd)
    && c.absoluteEnd > c.absoluteStart;

  if (valid(absolute) && covers(absolute) && !covers(relative)) return absolute;
  if (valid(relative) && covers(relative) && !covers(absolute)) return relative;

  // FFmpeg seek workers commonly preserve or offset PTS onto the movie timeline.
  // If the fragment clock is already near the worker's decode point, avoid adding
  // seekOffset again.
  const absoluteLike = seekOffset <= 0
    || fragmentStart >= Math.max(0, seekOffset - 1)
    || Math.abs(fragmentStart - target) <= Math.abs(relative.absoluteStart - target);

  return absoluteLike && valid(absolute) ? absolute : relative;
}

function _fragmentTimeToTimeline(clock, fragmentTime) {
  return clock.basis === 'relative'
    ? clock.timestampOffset + fragmentTime
    : fragmentTime;
}

function _buildFfmpegCommandAudit({ worker, cmdLine, codecInfo, diagMode }) {
  const hasAudio = codecInfo?.audioCodec !== null && codecInfo?.audioCodec !== undefined;
  const diagForceTranscode = diagMode === 'force_transcode_both';
  const needsVideoTranscode = diagForceTranscode
    ? true
    : codecInfo?.needsVideoTranscode ?? true;
  const needsAudioTranscode = codecInfo?.needsAudioTranscode ?? true;
  const videoCopy = !needsVideoTranscode;
  const audioCopy = hasAudio && !needsAudioTranscode;
  const qualityProfile = diagForceTranscode
    ? 'ultrafast_diag_force_transcode_both'
    : needsVideoTranscode ? 'libx264_veryfast_crf23' : 'copy';
  return {
    jobId: worker.jobId,
    workerId: worker.jobId,
    generation: worker.generation,
    seekTime: worker.seekTime,
    requestedSeekTime: worker.seekTime,
    seekOffset: worker.seekOffset,
    workerStartTime: worker.seekOffset,
    mode: codecInfo?.mode ?? null,
    cmdLine,
    ffmpegCommand: cmdLine,
    videoCodecMode: videoCopy ? 'copy' : 'transcode',
    audioCodecMode: !hasAudio ? 'none' : audioCopy ? 'copy' : 'transcode',
    videoCopy,
    audioCopy,
    needsVideoTranscode,
    needsAudioTranscode,
    qualityProfile,
  };
}

function _buildContinuity(prev, next) {
  const videoGapMs = _positiveDeltaMs(next.packetTiming.videoFirstPts, prev.packetTiming.videoLastPts);
  const videoOverlapMs = _positiveDeltaMs(prev.packetTiming.videoLastPts, next.packetTiming.videoFirstPts);
  const audioGapMs = _positiveDeltaMs(next.packetTiming.audioFirstPts, prev.packetTiming.audioLastPts);
  const audioOverlapMs = _positiveDeltaMs(prev.packetTiming.audioLastPts, next.packetTiming.audioFirstPts);
  return {
    fromSegment: prev.segment,
    toSegment: next.segment,
    videoPrevLastPts: prev.packetTiming.videoLastPts,
    videoNextFirstPts: next.packetTiming.videoFirstPts,
    videoGapMs,
    videoOverlapMs,
    audioPrevLastPts: prev.packetTiming.audioLastPts,
    audioNextFirstPts: next.packetTiming.audioFirstPts,
    audioGapMs,
    audioOverlapMs,
  };
}

function _buildTfdtNormalizationSeekSummary(worker) {
  const state = worker._tfdtNormalization;
  const pre = {};
  const post = {};
  for (let i = 0; i <= 4; i++) {
    const key = `segment_${String(i).padStart(5, '0')}`;
    pre[key] = state?.pre.get(i)?.deltaMs ?? null;
    post[key] = state?.post.get(i)?.correctedDeltaMs ?? state?.post.get(i)?.deltaMs ?? null;
  }
  return {
    enabled: ENABLE_TFDT_NORMALIZATION,
    thresholdMs: TFDT_NORMALIZATION_THRESHOLD_MS,
    preNormalizationDrift: pre,
    postNormalizationDrift: post,
  };
}

function _buildSegment0Forensics({ worker, segment, tracks, videoTimescale, audioTimescale }) {
  const v = tracks.video ?? null;
  const a = tracks.audio ?? null;
  return {
    workerId: worker.jobId,
    generation: worker.generation,
    segment,
    videoTfdt: v?.tfdt ?? null,
    audioTfdt: a?.tfdt ?? null,
    videoFirstPts: v?.firstPts ?? null,
    audioFirstPts: a?.firstPts ?? null,
    videoLastPts: v?.lastPts ?? null,
    audioLastPts: a?.lastPts ?? null,
    videoDuration: v?.duration ?? null,
    audioDuration: a?.duration ?? null,
    videoTimescale,
    audioTimescale,
    tfdtDeltaMs: _deltaMs(a?.tfdt, v?.tfdt),
    firstPtsDeltaMs: _deltaMs(a?.firstPts, v?.firstPts),
    lastPtsDeltaMs: _deltaMs(a?.lastPts, v?.lastPts),
    durationDeltaMs: _deltaMs(a?.duration, v?.duration),
  };
}

function _buildSegment0RawBoxes({ worker, segment, tracks, videoTimescale, audioTimescale }) {
  return {
    workerId: worker.jobId,
    generation: worker.generation,
    segment,
    video: tracks.video ? {
      tfdtRaw: tracks.video.tfdtRaw ?? null,
      baseMediaDecodeTime: tracks.video.tfdtRaw ?? null,
      timescale: videoTimescale,
    } : null,
    audio: tracks.audio ? {
      tfdtRaw: tracks.audio.tfdtRaw ?? null,
      baseMediaDecodeTime: tracks.audio.tfdtRaw ?? null,
      timescale: audioTimescale,
    } : null,
  };
}

function _buildRebaseTrace({ worker, segment, tracks, trackBase }) {
  return {
    workerId: worker.jobId,
    generation: worker.generation,
    segment,
    before: {
      workerStartTime: trackBase.workerStartTime,
      relativeVideoTime: tracks.video?.start ?? null,
      relativeAudioTime: tracks.audio?.start ?? null,
    },
    after: {
      absoluteVideoTime: trackBase.absoluteVideoStart,
      absoluteAudioTime: trackBase.absoluteAudioStart,
    },
    videoBaseUsed: trackBase.videoBaseUsed,
    audioBaseUsed: trackBase.audioBaseUsed,
  };
}

function _segmentNumber(file) {
  const m = /^segment_(\d+)\.m4s$/.exec(file ?? '');
  return m ? parseInt(m[1], 10) : null;
}

function _buildTrackTimelineDiagnostics({
  segmentId,
  promotedSegmentId,
  workerStartTime,
  clock,
  tracks,
  videoTimescale,
  audioTimescale,
  computedSegmentStart,
  computedSegmentEnd,
}) {
  const v = tracks.video ?? null;
  const a = tracks.audio ?? null;
  const videoBaseUsed = v ? clock.timestampOffset : null;
  const audioBaseUsed = a ? clock.timestampOffset : null;
  const videoAbsoluteStart = v ? videoBaseUsed + v.start : null;
  const audioAbsoluteStart = a ? audioBaseUsed + a.start : null;
  const videoAbsoluteEnd = v?.end != null ? videoBaseUsed + v.end : null;
  const audioAbsoluteEnd = a?.end != null ? audioBaseUsed + a.end : null;
  const deltaMs = _deltaMs(audioAbsoluteStart, videoAbsoluteStart);

  const common = {
    segmentId,
    promotedSegmentId,
  };

  const raw = {
    ...common,
    videoTfdt: v?.tfdt ?? null,
    audioTfdt: a?.tfdt ?? null,
    videoFirstPts: v?.firstPts ?? null,
    audioFirstPts: a?.firstPts ?? null,
    videoLastPts: v?.lastPts ?? null,
    audioLastPts: a?.lastPts ?? null,
    videoDuration: v?.duration ?? null,
    audioDuration: a?.duration ?? null,
    tfdtDeltaMs: _deltaMs(a?.tfdt, v?.tfdt),
    firstPtsDeltaMs: _deltaMs(a?.firstPts, v?.firstPts),
    lastPtsDeltaMs: _deltaMs(a?.lastPts, v?.lastPts),
  };

  const conversionBefore = {
    ...common,
    workerStartTime,
    relativeVideoTime: v?.start ?? null,
    relativeAudioTime: a?.start ?? null,
    videoBaseUsed,
    audioBaseUsed,
  };

  const conversionAfter = {
    ...common,
    absoluteVideoTime: videoAbsoluteStart,
    absoluteAudioTime: audioAbsoluteStart,
    videoBaseUsed,
    audioBaseUsed,
  };

  const origin = {
    ...common,
    videoTrackOrigin: v
      ? `absoluteTime = ${videoBaseUsed} + ${v.start}`
      : null,
    audioTrackOrigin: a
      ? `absoluteTime = ${audioBaseUsed} + ${a.start}`
      : null,
    videoTimescale,
    audioTimescale,
    videoBaseUsed,
    audioBaseUsed,
    clockBasis: clock.basis,
  };

  const registration = {
    ...common,
    computedSegmentStart,
    computedSegmentEnd,
    videoAbsoluteStart,
    audioAbsoluteStart,
    videoAbsoluteEnd,
    audioAbsoluteEnd,
    startDeltaMs: deltaMs,
    endDeltaMs: _deltaMs(audioAbsoluteEnd, videoAbsoluteEnd),
  };

  const firstSegment = {
    ...common,
    workerStartTime,
    videoTfdt: v?.tfdt ?? null,
    audioTfdt: a?.tfdt ?? null,
    videoFirstPts: v?.firstPts ?? null,
    audioFirstPts: a?.firstPts ?? null,
    absoluteVideoStart: videoAbsoluteStart,
    absoluteAudioStart: audioAbsoluteStart,
  };

  return {
    raw,
    conversionBefore,
    conversionAfter,
    origin,
    registration,
    firstSegment,
    divergence: Math.abs(deltaMs ?? 0) > 250
      ? {
          segmentId,
          promotedSegmentId,
          videoAbsoluteStart,
          audioAbsoluteStart,
          deltaMs,
        }
      : null,
  };
}

function _deltaMs(a, b) {
  return a != null && b != null ? Math.round((a - b) * 1000) : null;
}

function _positiveDeltaMs(a, b) {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((a - b) * 1000));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _overlapsTarget(timing, targetTime) {
  return timing.startTime <= targetTime && targetTime < timing.endTime;
}
