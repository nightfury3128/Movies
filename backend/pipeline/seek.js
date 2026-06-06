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
import { HlsGenerator }      from './ffmpeg.js';
import { readSegmentTiming, readFragmentTracks } from './fmp4.js';
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
    });
    this._trace(null, 'seek.worker_spawn.source', {
      jobId,
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
      this._trace(null, 'seek.worker.prioritize_requested', {
        jobId,
        seekTime,
        seekByte,
        endByte: seekByte + windowBytes,
        windowBytes,
      });
    }

    const generator = new HlsGenerator({ label: jobId });
    const worker = {
      jobId,
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

        try {
          await worker.generator.start(
            this.session.internalUrl,
            this.session.videoFile?.name ?? 'video.mkv',
            seekDir,
            this.session.codecInfo,
            seekOffset,
            true,    // isSeekWorker
            seekByte, // safe cluster offset; use ?start=N instead of -ss to avoid MKV bisection
            1         // hlsTime: 1s segments for faster first-frame delivery
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
    };

    // ── Dir monitor (GROUP 2 + 3): watch ALL files in seekDir every 500 ms ────
    const FIRST_OUTPUT_NAMES = new Set(['master.m3u8', 'seek_init.mp4', 'segment_00000.m4s']);
    const prevDirFiles = new Map(); // filename → { size, mtime }
    const dirMonitorHandle = setInterval(() => {
      if (worker.state !== 'running') { clearInterval(dirMonitorHandle); return; }
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
      if (worker.state !== 'running') return;
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
      if (worker.state !== 'running') { clearInterval(pollHandle); return; }
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
    if (worker.state !== 'running') return;
    const session = this.session;
    const file = path.basename(segPath);

    // Retry until we can parse the TFDT (file might still be written).
    let timing = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      timing = await readSegmentTiming(segPath, timescale);
      if (timing) break;
      await sleep(80);
    }

    if (!timing) {
      warn(NS, `Could not parse TFDT from ${segPath}`);
      worker._lastFailureReason = 'tfdt_parse_failed';
      this._trace(worker, 'seek.tfdt_failed', { file, path: segPath, timescale });
      this._trace(worker, 'seek.segment.parse_failed', { path: segPath });
      return;
    }

    worker._segsParsed++;
    const relativeStart = timing.startTime;
    const relativeEnd = timing.endTime;
    const absoluteStart = worker.seekOffset + relativeStart;
    const absoluteEnd = worker.seekOffset + relativeEnd;
    const tracks = await readFragmentTracks(segPath, {
      videoTimescale: timescale,
      audioTimescale: 48000,
    });
    if (!worker._rootFirstAv && (tracks.video || tracks.audio)) {
      worker._rootFirstAv = {
        firstVideoPts: tracks.video ? worker.seekOffset + tracks.video.start : null,
        firstAudioPts: tracks.audio ? worker.seekOffset + tracks.audio.start : null,
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
      baseMediaDecodeTime: Math.round(relativeStart * timescale),
      timescale,
      startSeconds: +relativeStart.toFixed(4),
      endSeconds:   +relativeEnd.toFixed(4),
      seekOffset:   +worker.seekOffset.toFixed(4),
      absoluteStart: +absoluteStart.toFixed(4),
      absoluteEnd:   +absoluteEnd.toFixed(4),
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

    // Preroll check: discard segments entirely before the seek target.
    const PREROLL_WINDOW = 0.5;
    const prerollResult = absoluteEnd < worker.seekTime - PREROLL_WINDOW ? 'discard' : 'keep';
    const overlapsTargetAtEvaluation = _overlapsTarget(absoluteTiming, worker.seekTime);
    const decision = prerollResult === 'discard'
      ? 'discard_before_target'
      : overlapsTargetAtEvaluation ? 'promote_overlap' : 'promote_after_target';
    this._trace(worker, 'seek.root.segment', {
      segment: file,
      absoluteStart: +absoluteStart.toFixed(3),
      absoluteEnd: +absoluteEnd.toFixed(3),
      containsVideo: !!tracks.video,
      containsAudio: !!tracks.audio,
      decision: prerollResult === 'discard' ? 'discard' : 'keep',
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
      result:        prerollResult,
      reason:        prerollResult === 'discard' ? 'before_target' : 'covers_or_after_target',
    });

    if (prerollResult === 'discard') {
      if (!worker._spawnFirstDiscard) {
        worker._spawnFirstDiscard = file;
        this._trace(worker, 'seek.worker_spawn.first_discard', {
          segmentId: file,
          absoluteStart: +absoluteStart.toFixed(3),
          absoluteEnd: +absoluteEnd.toFixed(3),
          requestedSeekTime: +worker.seekTime.toFixed(3),
          reason: absoluteEnd < worker.seekTime ? 'before_target' : 'timeline_mismatch',
        });
      }
      try { await fs.promises.unlink(segPath); } catch {}
      worker._lastFailureReason = 'preroll_discarded';
      this._trace(worker, 'seek.segment.preroll_discarded', {
        path: segPath,
        relativeStart,
        relativeEnd,
        seekOffset: worker.seekOffset,
        startTime: absoluteStart,
        endTime: absoluteEnd,
        absoluteStart,
        absoluteEnd,
        seekTime: worker.seekTime,
        overlapsTarget: _overlapsTarget(absoluteTiming, worker.seekTime),
      });
      this._trace(worker, 'seek.proof.preroll_discarded', {
        stage: 'preroll_discarded',
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
        promoted: false,
        inserted: false,
        timelineCount: session.timeline.count(),
      });
      return;
    }

    const destName = `segment_t${Math.round(absoluteStart * 1000)}.m4s`;
    const destPath = path.join(session.hlsPath, destName);

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

    // Copy seek_init.mp4 before the first segment.
    if (!worker.seekInitCopied) {
      const seekInitSrc  = path.join(worker.seekDir, 'seek_init.mp4');
      const seekInitDest = path.join(session.hlsPath, 'seek_init.mp4');
      try {
        await fs.promises.copyFile(seekInitSrc, seekInitDest);
        worker.seekInitCopied = true;
        this._trace(worker, 'seek.segment.seek_init_copied');
      } catch (e) {
        warn(NS, `Worker ${worker.jobId} seek_init.mp4 copy failed: ${e.message}`);
      }
    }

    try {
      await fs.promises.copyFile(segPath, destPath);
      await fs.promises.unlink(segPath);
    } catch (e) {
      warn(NS, `Failed to move seek segment: ${e.message}`);
      worker._lastFailureReason = 'move_failed';
      this._trace(worker, 'seek.segment.move_failed', {
        path: segPath, destPath, message: e.message,
      });
      return;
    }

    let destStat = null;
    try { destStat = await fs.promises.stat(destPath); } catch {}
    const overlapsTarget = _overlapsTarget(absoluteTiming, worker.seekTime);
    if (overlapsTarget) worker._spawnCoveringFound = true;
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
    if (tracks.video || tracks.audio) {
      const videoStart = tracks.video ? worker.seekOffset + tracks.video.start : null;
      const audioStart = tracks.audio ? worker.seekOffset + tracks.audio.start : null;
      this._trace(worker, 'seek.root.track_starts', {
        segment: destName,
        videoTfdt: tracks.video?.tfdt != null ? +tracks.video.tfdt.toFixed(3) : null,
        audioTfdt: tracks.audio?.tfdt != null ? +tracks.audio.tfdt.toFixed(3) : null,
        videoStart: videoStart != null ? +videoStart.toFixed(3) : null,
        audioStart: audioStart != null ? +audioStart.toFixed(3) : null,
        trackDeltaMs: videoStart != null && audioStart != null ? Math.round((audioStart - videoStart) * 1000) : null,
      });
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
    session.events.emit('segment:ready', toSegmentPayload(entry));
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

    log(NS, `Segment ${destName} rel=[${relativeStart.toFixed(2)}-${relativeEnd.toFixed(2)}s] abs=[${absoluteStart.toFixed(2)}-${absoluteEnd.toFixed(2)}s] target=${worker.seekTime.toFixed(3)}s overlap=${overlapsTarget} timeline=${countBefore}->${countAfter}`);
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _overlapsTarget(timing, targetTime) {
  return timing.startTime <= targetTime && targetTime < timing.endTime;
}
