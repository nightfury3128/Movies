/**
 * pipeline/ffmpeg.js — FFmpeg HLS generator.
 *
 * Wraps fluent-ffmpeg to produce fMP4 HLS segments from a byte-range HTTP
 * source (the TorrentManager's internal server).
 *
 * Key design decisions:
 *
 *   seekOffset > 0   → parallel seek worker; uses -ss + -output_ts_offset so
 *                       output TFDT ≈ seekOffset seconds.
 *   isSeekWorker     → uses seek_init.mp4 name to avoid overwriting main init.
 *   remux mode       → -c:v copy (100× realtime, zero CPU decode/encode).
 *   transcode mode   → libx264 veryfast (universally compatible).
 *
 * Events emitted:
 *   'ffmpeg-time'    (seconds)  — current encode position from stderr
 *   'segment-open'  ({path, filename, segCounter}) — FFmpeg opened a new segment
 *   'start'         (cmdLine)  — process spawned
 *   'end'           ()         — process exited cleanly
 *   'error'         (err)      — unexpected exit
 */

import ffmpeg from 'fluent-ffmpeg';
import path   from 'path';
import fs     from 'fs';
import os     from 'os';
import { EventEmitter } from 'events';
import { log, warn, err as logErr } from '../logger.js';

const NS = 'ffmpeg';

// Segment duration in seconds.
const HLS_TIME = 2;

// CPU threads: use half the logical cores, capped at 4 per FFmpeg process.
const cpuThreads = String(Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2))));

export class HlsGenerator extends EventEmitter {
  constructor({ label = 'main' } = {}) {
    super();
    this.label   = label;
    this.process = null;
    this.running = false;
    this._lastTime = 0;
  }

  get lastTime() { return this._lastTime; }

  /**
   * Start FFmpeg. Resolves when the process exits (end/error/stop).
   *
   * @param {string} sourceUrl   Internal torrent HTTP URL
   * @param {string} videoName   Original filename (format hint)
   * @param {string} outputDir   Directory for HLS output
   * @param {object} codecInfo   From detectCodecs()
   * @param {number} seekOffset  > 0 for seek workers; shifts output TFDT
   * @param {boolean} isSeekWorker  Uses seek_init.mp4 instead of init.mp4
   */
  start(sourceUrl, videoName, outputDir, codecInfo, seekOffset = 0, isSeekWorker = false, seekByte = null, hlsTime = HLS_TIME, diagMode = null) {
    return new Promise((resolve, reject) => {
      if (this.running) return reject(new Error('HlsGenerator already running'));
      this.running = true;

      fs.mkdirSync(outputDir, { recursive: true });

      const ext     = path.extname(videoName).toLowerCase();
      const fmtHint = { '.mkv': 'matroska', '.avi': 'avi', '.mov': 'mov', '.mp4': 'mp4', '.webm': 'webm', '.m4v': 'mp4' }[ext] ?? null;

      const mode                = codecInfo?.mode               ?? 'transcode';
      let needsVideoTranscode   = codecInfo?.needsVideoTranscode ?? true;
      const needsAudioTranscode = codecInfo?.needsAudioTranscode ?? true;
      const hasAudio            = codecInfo?.audioCodec !== null && codecInfo?.audioCodec !== undefined;

      // Diagnostic override: force full transcode to isolate copy+transcode mismatch.
      const diagForceTranscode = diagMode === 'force_transcode_both';
      if (diagForceTranscode) needsVideoTranscode = true;

      log(NS, `start label=${this.label} mode=${mode} seekOffset=${seekOffset} isSeekWorker=${isSeekWorker}`);

      // ── Input options ──────────────────────────────────────────────────────
      const inputOpts = [
        '-reconnect', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', isSeekWorker ? '20000000' : '300000000',
        '-analyzeduration',   isSeekWorker ? '50000'     : '1000000',
        '-probesize',         isSeekWorker ? '200000'    : '2000000',
      ];

      if (isSeekWorker && seekByte != null && seekByte > 0) {
        // Linear read from seekByte via ?start=N on the internal HTTP URL.
        // Avoids MKV binary bisection: -ss on an MKV input makes FFmpeg issue
        // Range requests to fileSize/2, fileSize/4, … to locate the cluster —
        // those positions are never downloaded in a partial torrent and block
        // indefinitely. -seekable 0 prevents Range-based seeks; rw_timeout is
        // The TorrentManager HTTP server handles ?start=N and serves a 200
        // response from that byte offset; -seekable 0 prevents FFmpeg from
        // issuing any further seek requests.
        inputOpts.push('-seekable', '0');
      } else if (seekOffset > 0) {
        inputOpts.unshift('-ss', String(seekOffset));
        inputOpts.push('-fflags', '+ignidx');
      } else {
        // Normal start: disable seekable so FFmpeg doesn't follow MKV Cues.
        inputOpts.push('-seekable', '0');
      }

      if (fmtHint) inputOpts.push('-f', fmtHint);

      // For seek workers, append ?start=N so the TorrentManager HTTP server
      // streams from seekByte without needing a Range request header.
      // Encode seekOffset in ms so the HTTP handler can range-validate clusters.
      const effectiveUrl = (isSeekWorker && seekByte != null && seekByte > 0)
        ? `${sourceUrl}?start=${Math.floor(seekByte)}&seekTime=${Math.round(seekOffset * 1000)}`
        : sourceUrl;

      let cmd = ffmpeg(effectiveUrl).inputOptions(inputOpts);

      // ── Video codec ────────────────────────────────────────────────────────
      if (!needsVideoTranscode) {
        cmd = cmd.videoCodec('copy');
      } else {
        cmd = cmd
          .videoCodec('libx264')
          .outputOptions([
            '-preset', diagForceTranscode ? 'ultrafast' : 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-bf', '0',
            '-force_key_frames', `expr:gte(t,n_forced*${hlsTime})`,
            '-sc_threshold', '0',
          ]);
      }

      // ── Audio codec ────────────────────────────────────────────────────────
      if (!hasAudio) {
        cmd = cmd.noAudio();
      } else if (!needsAudioTranscode) {
        cmd = cmd.audioCodec('copy');
      } else {
        cmd = cmd
          .audioCodec('aac')
          .outputOptions(['-ar', '48000', '-ac', '2', '-b:a', '192k']);
      }

      // ── PTS normalisation (seek workers) ──────────────────────────────────
      // Transcode mode: setpts=PTS-STARTPTS resets timestamps to 0, then
      // -output_ts_offset shifts them to seekOffset so TFDT ≈ seekOffset.
      //
      // Remux mode (-c:v copy): source timestamps are already at the keyframe
      // position (~seekOffset). DO NOT apply setpts or -output_ts_offset —
      // doing so would produce TFDT ≈ 2×seekOffset, corrupting the timeline.
      if (seekOffset > 0 && needsVideoTranscode) {
        cmd = cmd.videoFilters('setpts=PTS-STARTPTS');
        if (hasAudio && needsAudioTranscode) {
          cmd = cmd.audioFilters('asetpts=PTS-STARTPTS');
        }
      }

      // ── Stream map + common output options ────────────────────────────────
      const mapOpts = ['-map', '0:v:0'];
      if (hasAudio) mapOpts.push('-map', '0:a:0');
      mapOpts.push('-sn'); // drop subtitle streams

      const segPattern   = path.join(outputDir, 'segment_%05d.m4s');
      const playlistPath = path.join(outputDir, 'master.m3u8');

      cmd = cmd
        .outputFormat('hls')
        .outputOptions([
          ...mapOpts,
          '-threads', cpuThreads,
          // Seek workers read mid-file: source timestamps are already positive (~seekTime).
          // make_zero would reset them to 0 when the header+cluster stream causes the AAC
          // encoder priming delay to appear negative, making every segment look like pre-roll.
          '-avoid_negative_ts',
          (diagMode === 'ts_norm_B' || diagMode === 'ts_norm_C') ? 'make_zero'
            : (isSeekWorker ? 'disabled' : 'make_zero'),
          ...(diagMode === 'ts_norm_A' ? ['-copyts', '-start_at_zero'] : []),
          ...(diagMode === 'ts_norm_B' ? ['-copyts'] : []),
          ...(diagMode === 'ts_norm_C' ? ['-copyts', '-start_at_zero'] : []),

          // Only shift timestamps for transcode mode (setpts reset to 0 above).
          // Remux mode leaves source timestamps intact — no offset needed.
          ...(seekOffset > 0 && needsVideoTranscode ? ['-output_ts_offset', String(seekOffset)] : []),

          '-hls_time',              String(hlsTime),
          '-hls_list_size',         '0',
          '-hls_flags',             'independent_segments',
          '-hls_segment_type',      'fmp4',
          '-hls_fmp4_init_filename', isSeekWorker ? 'seek_init.mp4' : 'init.mp4',
          '-hls_segment_filename',  segPattern,
        ])
        .output(playlistPath);

      // ── Callbacks ──────────────────────────────────────────────────────────
      const t0 = Date.now();

      cmd.on('start', cmdLine => {
        log(NS, `Spawned [${this.label}]`);
        this.emit('start', cmdLine);
      });

      cmd.on('stderr', line => {
        this.emit('stderr', line);

        const timeM = line.match(/time=(\d+):(\d+):([\d.]+)/);
        if (timeM) {
          const secs = +timeM[1] * 3600 + +timeM[2] * 60 + parseFloat(timeM[3]);
          this._lastTime = secs;
          this.emit('ffmpeg-time', secs);
        }

        // FFmpeg logs segment file opens before they're closed — useful for
        // triggering watchers earlier without waiting for close.
        const openM = line.match(/Opening '([^']*segment_(\d+)\.m4s)'/);
        if (openM) {
          this.emit('segment-open', {
            path:       openM[1],
            filename:   path.basename(openM[1]),
            segCounter: parseInt(openM[2], 10),
          });
        }
      });

      cmd.on('error', (e) => {
        this.running = false;
        this.process = null;
        if (/signal 15|code 255|SIGTERM|killed/i.test(e.message)) {
          log(NS, `Stopped [${this.label}]`);
          resolve();
          return;
        }
        logErr(NS, `Error [${this.label}]: ${e.message}`);
        reject(e);
      });

      cmd.on('end', () => {
        this.running = false;
        this.process = null;
        log(NS, `Done [${this.label}] (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        this.emit('end');
        resolve();
      });

      this.process = cmd;
      cmd.run();
    });
  }

  stop() {
    if (this.process && this.running) {
      log(NS, `Stopping [${this.label}]`);
      this.process.kill('SIGTERM');
      this.running = false;
      this.process = null;
    }
  }

  pause() {
    if (this.process && this.running) {
      this.process.kill('SIGSTOP');
      log(NS, `Paused [${this.label}]`);
    }
  }

  resume() {
    if (this.process && this.running) {
      this.process.kill('SIGCONT');
      log(NS, `Resumed [${this.label}]`);
    }
  }
}
