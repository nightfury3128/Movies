/**
 * hls/generator.js
 *
 * WHY HLS?
 * Browsers can't play raw MKV or torrent streams directly. HLS (HTTP Live
 * Streaming) solves this by splitting the video into small segments and
 * serving a .m3u8 playlist that lists them in order. The browser downloads
 * segments one at a time — this means:
 *   1. Playback can start before the full file is downloaded.
 *   2. Seeking works by jumping to the right segment.
 *   3. Any standard web server can serve the files (no WebSocket, no chunked HTTP tricks).
 *
 * WHY fMP4 (fragmented MP4) INSTEAD OF MPEG-TS SEGMENTS?
 * fMP4 segments (.m4s) are the modern HLS format. They:
 *   - Support H.265/HEVC, AV1, Opus, and other codecs that MPEG-TS can't carry.
 *   - Are smaller on disk (no TS overhead bytes).
 *   - Are natively understood by browsers' MSE (Media Source Extensions) API.
 *   - Require an init segment (init.mp4) which is generated once at startup.
 *
 * WHY VOD MODE (-hls_list_size 0)?
 * Each user gets their own session and FFmpeg process (keyed by sessionId, not
 * infoHash). There is no shared rolling window. Keeping all segments in the
 * playlist (hls_list_size 0) enables full seeking and prevents 404s when users
 * lag behind the FFmpeg write position. Without per-user sessions the old
 * rolling-window design caused the first user to get 404s on segments deleted
 * by the second user's FFmpeg advancement.
 *
 * WHY 'remux' vs 'transcode' MODE?
 * - remux:     -c:v copy — no CPU decode/encode, runs at ~100x realtime.
 *              Source must be H.264 8-bit + AAC/MP3 for browser compatibility.
 * - transcode: libx264 + aac — universally compatible but uses ~1 CPU core.
 *              Required for HEVC, AV1, 10-bit, EAC3, DTS, >2ch sources.
 *
 * MULTI-USER CHANGES vs THE ORIGINAL:
 *   - start() now accepts `codecInfo` (from detectCodecs()) rather than
 *     always transcoding. This allows remux for H.264/AAC files — saving
 *     significant CPU when 5-10 users are streaming simultaneously.
 *   - Emits 'ffmpeg-time' event with the current playback position in seconds.
 *     The route layer listens to this event to drive EvictingMemoryStore.evictBefore().
 *   - No 'append_list' flag — it conflicts with rolling-window mode and produces
 *     empty/corrupt playlists.
 *   - hlsDir is NOT stored on the instance — it's passed into start(). Each
 *     session has its own directory; the generator instance is session-scoped.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { seekLog, seekWarn, seekErr, instrLog } from '../logger.js';

export class HlsGenerator extends EventEmitter {
  constructor({ label = 'main', timeline = null } = {}) {
    super();
    this.process  = null;
    this.running  = false;
    this.label    = label;
    this.timeline = timeline;
  }

  /**
   * Start FFmpeg reading from `sourceUrl` and writing fMP4 HLS to `outputDir`.
   *
   * @param {string} sourceUrl  - URL of the internal range server (http://127.0.0.1:<port>/)
   * @param {string} videoName  - Original filename (used only for format hint)
   * @param {string} outputDir  - Directory where master.m3u8 + segments will be written
   * @param {object} codecInfo  - Output from detectCodecs(); drives remux vs transcode
   * @returns {Promise<void>}   - Resolves when FFmpeg exits (fully muxed or stopped)
   */
  /**
   * @param {number} [seekOffset=0]  - If > 0, restart from this time (seconds).
   * @param {boolean} [isSeekWorker=false] - Parallel seek-ahead FFmpeg.
   *   Uses seek_init.mp4 instead of init.mp4; segment files are renamed to
   *   media indices by the route layer (hls_start_number is not portable).
   */
  start(sourceUrl, videoName, outputDir, codecInfo, seekOffset = 0, isSeekWorker = false) {
    return new Promise((resolve, reject) => {
      if (this.running) return reject(new Error('HlsGenerator already running'));
      this.running = true;

      fs.mkdirSync(outputDir, { recursive: true });

      const playlistPath   = path.join(outputDir, 'master.m3u8');
      const segmentPattern = path.join(outputDir, 'segment_%05d.m4s');

      // ── Format hint ───────────────────────────────────────────────────────
      // Providing a container format hint skips FFmpeg's probe overhead.
      // Without it FFmpeg reads enough bytes to guess the format — wasteful
      // when the first few KB are the MKV/MP4 header which already tells us.
      const ext     = path.extname(videoName).toLowerCase();
      const fmtHint = {
        '.mkv':  'matroska',
        '.avi':  'avi',
        '.mov':  'mov',
        '.mp4':  'mp4',
        '.webm': 'webm',
        '.m4v':  'mp4',
      }[ext] ?? null;

      console.log(`[ffmpeg:${this.label}] mode=${codecInfo?.mode ?? 'transcode'} source=${sourceUrl} seek=${seekOffset} isSeekWorker=${isSeekWorker}`);
      console.log(`[ffmpeg:${this.label}] output=${playlistPath}`);

      if (isSeekWorker || seekOffset > 0) {
        seekLog('ffmpeg', 'start() seek worker config', {
          label: this.label, seekOffset, isSeekWorker, outputDir, mode: codecInfo?.mode,
        });
      }

      const mode               = codecInfo?.mode               ?? 'transcode';
      const needsVideoTranscode = codecInfo?.needsVideoTranscode ?? true;
      const needsAudioTranscode = codecInfo?.needsAudioTranscode ?? true;
      // Copy-video + transcode-audio seek workers drift ~800ms per fMP4 fragment.
      const lockAvOnSeek = isSeekWorker && seekOffset > 0
        && codecInfo?.audioCodec !== null
        && needsAudioTranscode;
      const useVideoTranscode = needsVideoTranscode || (lockAvOnSeek && !needsVideoTranscode);

      // ── Input options ─────────────────────────────────────────────────────
      const inputOpts = [];

      if (seekOffset > 0) {
        // Seek restart: FFmpeg needs to bisect-seek in the HTTP source to find
        // the right cluster. -seekable 0 is removed (we need seeking). -re is
        // removed so FFmpeg catches up to seekOffset quickly without waiting.
        // -ss as an INPUT option tells FFmpeg to seek in the source rather than
        // discarding decoded frames (much faster for both remux and transcode).
        //
        // DO NOT add -copyts here.
        // -copyts would preserve the source container's own start PTS (which is
        // non-zero for many MKV files) through to the output TFDT, causing a
        // permanent mismatch between the fMP4 TFDT and the 0-based segment
        // filename.  Example: source start PTS = 106.535 s, seekOffset = 138 s →
        // FFmpeg input-seeks to absolute source PTS 244.535 s; with -copyts that
        // same 244.535 s becomes the output TFDT, but the segment is named
        // segment_00069 (= floor(138/2)) → delta −53.
        // The correct approach for both remux and transcode is to let make_zero
        // collapse the source PTS to 0, then shift by +output_ts_offset to land
        // at seekOffset — same as the transcode path.
        inputOpts.push(
          '-ss',                  String(seekOffset),
          '-reconnect',           '1',
          '-reconnect_delay_max', '5',
          '-rw_timeout',          '300000000',
          '-analyzeduration',     '2000000',
          '-probesize',           '5000000',
        );
      } else {
        // Normal start: do NOT use -re. The torrent HTTP pump already blocks on
        // missing pieces, so FFmpeg cannot read ahead of the download. With -re,
        // a slow swarm stalls FFmpeg at ~2 s (realtime throttle) and the first
        // HLS segment never appears — the browser waits forever on SSE.
        // -seekable 0 prevents FFmpeg from following the MKV Cues pointer to EOF.
        inputOpts.push(
          '-reconnect',           '1',
          '-reconnect_delay_max', '5',
          '-rw_timeout',          '300000000',
          '-seekable',            '0',
          '-analyzeduration',     '2000000',
          '-probesize',           '5000000',
        );
      }

      if (fmtHint) {
        inputOpts.push('-f', fmtHint);
      }

      let cmd = ffmpeg(sourceUrl)
        .inputOptions(inputOpts);

      // ── Video codec selection ─────────────────────────────────────────────
      if (!useVideoTranscode) {
        // Copy video bitstream as-is — zero CPU cost, lossless quality.
        // Works for H.264 8-bit sources regardless of audio mode.
        cmd = cmd.videoCodec('copy');
      } else if (lockAvOnSeek && !needsVideoTranscode) {
        // Seek-only re-encode: lock audio/video PTS (ultrafast — short burst).
        cmd = cmd
          .videoCodec('libx264')
          .outputOptions([
            '-preset',           'ultrafast',
            '-crf',              '28',
            '-pix_fmt',         'yuv420p',
            '-bf',               '0',
            '-force_key_frames', 'expr:gte(t,n_forced*2)',
            '-sc_threshold',     '0',
          ]);
      } else {
        // Re-encode to H.264 8-bit for browser compatibility (HEVC, AV1, 10-bit, etc.)
        cmd = cmd
          .videoCodec('libx264')
          .outputOptions([
            '-preset',           'veryfast',
            '-crf',              '23',
            // Chrome MSE only accepts 8-bit yuv420p.
            '-pix_fmt',         'yuv420p',
            // B-frames cause DTS < PTS (reordered) → negative compositionTimeOffset
            // in fMP4 → Chrome MSE rejects those buffers.
            '-bf',               '0',
            // Force keyframe at each segment boundary so segments are independently decodable.
            '-force_key_frames', 'expr:gte(t,n_forced*4)',
            // Disable scene-cut keyframes so segment durations stay exactly 4 s.
            '-sc_threshold',     '0',
          ]);
      }

      // ── Audio codec selection ─────────────────────────────────────────────
      if (codecInfo?.audioCodec === null) {
        // Video-only file — don't add an audio map at all.
        // Adding -map 0:a:0 for a video-only file causes FFmpeg to error out.
      } else if (!needsAudioTranscode) {
        // Source audio is already browser-safe (aac/mp3, ≤2ch) — copy it.
        cmd = cmd.audioCodec('copy');
      } else {
        // Transcode audio to stereo AAC-LC.
        // -ac 2: downmix to stereo. Source is often 5.1 (6-channel). HLS.js's
        //   TS→fMP4 transmuxer does not correctly write the AudioSpecificConfig
        //   for multichannel audio, so Chrome's MSE immediately closes the
        //   MediaSource (readyState → ended) when the audio init segment arrives.
        cmd = cmd
          .audioCodec('aac')
          .audioBitrate('192k')
          .audioChannels(2);
      }

      // ── Thread control ────────────────────────────────────────────────────
      // copy video: -threads 2 — I/O-bound; extra threads waste context switches.
      // transcode:  -threads 0 — libx264 uses all cores automatically; let it.
      const threads = useVideoTranscode ? '0' : '2';

      // ── Stream map ────────────────────────────────────────────────────────
      // Explicitly pick first video + first audio (if audio exists).
      // Without -map, FFmpeg may include subtitle streams, which the fMP4
      // muxer doesn't support and will error out.
      const mapOpts = ['-map', '0:v:0'];
      if (codecInfo?.audioCodec !== null) {
        mapOpts.push('-map', '0:a:0');
      }
      // Always suppress subtitle streams.
      mapOpts.push('-sn');

      const hlsOutputOpts = [
          ...mapOpts,
          '-threads', threads,
      ];

      if (isSeekWorker && seekOffset > 0) {
        if (useVideoTranscode && codecInfo?.audioCodec !== null) {
          // Relative fragment TFDT; promote + MSE timestampOffset map to absolute time.
          const pts = 'PTS-STARTPTS';
          cmd = cmd.videoFilters(`setpts=${pts}`);
          cmd = cmd.audioFilters(`asetpts=${pts}`);
        } else if (codecInfo?.audioCodec !== null && needsAudioTranscode) {
          cmd = cmd.audioFilters('asetpts=PTS-STARTPTS');
        }
      }
      hlsOutputOpts.push('-avoid_negative_ts', 'make_zero');

      cmd = cmd
        .outputFormat('hls')
        .outputOptions([
          ...hlsOutputOpts,

          // Each segment covers 2 seconds of content (down from 4).
          // Smaller segments mean the first segment is ready ~2 s sooner.
          '-hls_time', '2',

          // VOD mode: keep all segments in the playlist (0 = unlimited).
          // Each user has their own session/FFmpeg process so there's no shared
          // rolling window to worry about. Keeping all segments enables full seeking
          // and prevents 404s when users fall behind the FFmpeg write position.
          '-hls_list_size', '0',

          // independent_segments: each segment begins with a keyframe so the
          //   browser can seek to any segment boundary independently.
          // NOTE: no delete_segments — we need all segments available for seeking.
          // NOTE: do NOT add append_list — it conflicts with -y and produces corrupt playlists.
          '-hls_flags', 'independent_segments',

          // fMP4 container for segments (instead of legacy MPEG-TS).
          // Required for modern codec support and cleaner MSE integration.
          '-hls_segment_type', 'fmp4',

          // init.mp4 contains the codec initialization data (moov/mvhd/trak…).
          // Seek workers use 'seek_init.mp4' so they never overwrite the main
          // init.mp4 that the MSE player has already buffered.
          '-hls_fmp4_init_filename', isSeekWorker ? 'seek_init.mp4' : 'init.mp4',

          // Segment file naming pattern. %05d gives 5-digit zero-padded indices.
          '-hls_segment_filename', segmentPattern,
        ])
        .output(playlistPath);

      // ── FFmpeg event callbacks ────────────────────────────────────────────

      const spawnT0 = Date.now();
      let lastProgressLog = 0;
      let firstFrameLogged = false;
      let stderrBuffer = [];
      let lastFfmpegTime = 0;

      cmd.on('start', (cmdLine) => {
        console.log(`[ffmpeg:${this.label}] Command:`, cmdLine);
        if (isSeekWorker) {
          instrLog('seek-worker', 'spawn', { label: this.label, cmdLine });
          this.timeline?.markOnce('ffmpeg-spawn', 'spawn ffmpeg seek worker', { label: this.label });
        }
        this.emit('start', cmdLine);
      });

      cmd.on('stderr', (line) => {
        const trimmed = line.trim();
        if (isSeekWorker) stderrBuffer.push(trimmed);

        // Parse time= progress for eviction driving.
        const m = line.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) {
          const secs = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
          lastFfmpegTime = secs;
          this.emit('ffmpeg-time', secs);

          if (isSeekWorker) {
            this.timeline?.markOnce('ffmpeg-first-progress', 'first ffmpeg progress event', {
              time: secs, elapsedSec: ((Date.now() - spawnT0) / 1000).toFixed(1),
            });

            const now = Date.now();
            if (now - lastProgressLog >= 1000) {
              lastProgressLog = now;
              const frameM = line.match(/frame=\s*(\d+)/);
              const fpsM   = line.match(/fps=\s*([\d.]+)/);
              const spdM   = line.match(/speed=\s*([\d.]+x)/);
              instrLog('seek-worker', 'progress', {
                label: this.label,
                frame: frameM?.[1] ?? '?',
                fps:   fpsM?.[1]   ?? '?',
                time:  m[0],
                speed: spdM?.[1]   ?? '?',
                elapsedSec: ((now - spawnT0) / 1000).toFixed(1),
              });
            }
          }
        }

        if (isSeekWorker && !firstFrameLogged && /frame=\s*[1-9]/.test(line)) {
          firstFrameLogged = true;
          this.timeline?.markOnce('ffmpeg-first-frame', 'first frame decoded', {
            elapsedSec: ((Date.now() - spawnT0) / 1000).toFixed(1),
          });
          instrLog('seek-worker', 'first frame decoded', {
            label: this.label,
            elapsedSec: ((Date.now() - spawnT0) / 1000).toFixed(1),
          });
        }

        // FFmpeg HLS muxer logs when it opens each segment file — earliest
        // signal of which %05d counter FFmpeg assigned before the file is closed.
        const openM = line.match(/Opening '([^']*(segment_\d+\.m4s))'/);
        if (openM) {
          const segPath = openM[1];
          const segM    = /segment_(\d+)\.m4s$/.exec(segPath);
          const segCounter = segM ? parseInt(segM[1], 10) : null;
          this.emit('segment-open', {
            path:       segPath,
            filename:   path.basename(segPath),
            segCounter,
            ffmpegTime: lastFfmpegTime,
            label:      this.label,
            isSeekWorker,
          });
          instrLog('ffmpeg-segment-open', this.label, {
            filename:   path.basename(segPath),
            segCounter,
            ffmpegTime: +lastFfmpegTime.toFixed(3),
          });
        }

        const isSeekWorkerRun = isSeekWorker || seekOffset > 0;
        if (isSeekWorkerRun) {
          // Full stderr capture for seek workers
          seekLog('ffmpeg-stderr', trimmed, { label: this.label });
        } else if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
          console.log(`[ffmpeg:${this.label}]`, line);
        }
      });

      cmd.on('progress', (progress) => {
        this.emit('progress', progress);
      });

      cmd.on('error', (err, stdout, stderr) => {
        this.running = false;
        this.process = null;
        // SIGTERM from generator.stop() causes FFmpeg to exit with code 255 /
        // "signal 15". Treat this as a graceful stop — don't emit 'error' or
        // reject, so session cleanup doesn't crash the server.
        if (err.message.includes('signal 15') || err.message.includes('code 255') || err.message.includes('SIGTERM')) {
          console.log(`[ffmpeg:${this.label}] Stopped (SIGTERM)`);
          if (isSeekWorker) {
            seekLog('ffmpeg', 'stopped via SIGTERM', { label: this.label, stderrLines: stderrBuffer.length });
            this.timeline?.mark('ffmpeg stopped (SIGTERM)', { stderrLines: stderrBuffer.length });
          }
          resolve();
          return;
        }
        console.error(`[ffmpeg:${this.label}] Error:`, err.message);
        seekErr('ffmpeg', 'process error', { label: this.label, err: err.message });
        if (isSeekWorker && stderrBuffer.length) {
          seekErr('ffmpeg', 'full stderr dump on error', { lines: stderrBuffer.slice(-50) });
        }
        if (stderr) {
          const lines = stderr.split('\n').filter(Boolean);
          lines.slice(-10).forEach(l => console.error(`[ffmpeg:${this.label} stderr]`, l));
        }
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        reject(err);
      });

      cmd.on('end', () => {
        this.running = false;
        this.process = null;
        console.log(`[ffmpeg:${this.label}] Finished — all segments written`);
        if (isSeekWorker) seekLog('ffmpeg', 'process end', { label: this.label });
        this.emit('end');
        resolve();
      });

      this.process = cmd;
      cmd.run();
    });
  }

  /**
   * Kill FFmpeg if it's running. Used during session cleanup.
   * We send SIGTERM first; fluent-ffmpeg will escalate to SIGKILL if needed.
   */
  stop() {
    if (this.process && this.running) {
      seekLog('ffmpeg', 'stop() called', { label: this.label });
      this.process.kill('SIGTERM');
      this.running = false;
      this.process = null;
    }
  }
}
