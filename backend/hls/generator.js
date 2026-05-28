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

export class HlsGenerator extends EventEmitter {
  constructor() {
    super();
    this.process = null;   // fluent-ffmpeg command object
    this.running = false;
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
  start(sourceUrl, videoName, outputDir, codecInfo) {
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

      console.log(`[ffmpeg] mode=${codecInfo?.mode ?? 'transcode'} source=${sourceUrl}`);
      console.log(`[ffmpeg] output=${playlistPath}`);

      // ── Mode selection ────────────────────────────────────────────────────
      const mode = codecInfo?.mode ?? 'transcode';

      // ── Input options (must come before .input() in fluent-ffmpeg) ────────
      const inputOpts = [
        // Give FFmpeg extra time to probe the stream format.
        // Without this, FFmpeg may give up before the first pieces arrive.
        '-analyzeduration', '2000000',  // 2 s
        '-probesize',       '5000000',  // 5 MB
      ];
      if (fmtHint) {
        // Must be the last items in inputOptions so they end up immediately
        // before -i in the command line.
        inputOpts.push('-f', fmtHint);
      }

      let cmd = ffmpeg(sourceUrl)
        .inputOptions(inputOpts);

      // ── Video codec selection ─────────────────────────────────────────────
      if (mode === 'remux') {
        cmd = cmd.videoCodec('copy');
      } else {
        // transcode → H.264 8-bit, browser-safe
        cmd = cmd
          .videoCodec('libx264')
          .outputOptions([
            '-preset',           'veryfast',
            // CRF 23: libx264's default quality, predictable cost.
            '-crf',              '23',
            // Chrome MSE only accepts 8-bit yuv420p.
            '-pix_fmt',         'yuv420p',
            // B-frames cause DTS < PTS (reordered), which produces negative
            // compositionTimeOffset in fMP4 — Chrome MSE rejects those buffers.
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
      } else if (mode === 'remux' && !codecInfo?.needsAudioTranscode) {
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
      // remux: -threads 2 — muxing is I/O-bound; more threads waste context switches.
      // transcode: -threads 0 — libx264 uses all cores automatically; let it.
      const threads = mode === 'remux' ? '2' : '0';

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

      cmd = cmd
        .outputFormat('hls')
        .outputOptions([
          ...mapOpts,

          '-threads', threads,

          // Shift timestamps if anything comes out negative (can happen with
          // some MKV files whose edit lists or codec delays cause negative DTS).
          '-avoid_negative_ts', 'make_zero',

          // Each segment covers 4 seconds of content.
          '-hls_time', '4',

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
          // It must be fetched before any segment can be decoded.
          '-hls_fmp4_init_filename', 'init.mp4',

          // Segment file naming pattern. %05d gives 5-digit zero-padded indices.
          '-hls_segment_filename', segmentPattern,
        ])
        .output(playlistPath);

      // ── FFmpeg event callbacks ────────────────────────────────────────────

      cmd.on('start', (cmdLine) => {
        console.log('[ffmpeg] Command:', cmdLine);
        this.emit('start', cmdLine);
      });

      cmd.on('stderr', (line) => {
        // Parse time= progress for eviction driving.
        // FFmpeg outputs lines like: "frame= 120 fps= 30 ... time=00:00:04.00 ..."
        const m = line.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) {
          const secs = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
          this.emit('ffmpeg-time', secs);
        }

        // Log interesting lines without spamming the console.
        if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
          console.log('[ffmpeg]', line);
        }
      });

      cmd.on('progress', (progress) => {
        this.emit('progress', progress);
      });

      cmd.on('error', (err, stdout, stderr) => {
        this.running = false;
        this.process = null;
        console.error('[ffmpeg] Error:', err.message);
        if (stderr) {
          const lines = stderr.split('\n').filter(Boolean);
          lines.slice(-10).forEach(l => console.error('[ffmpeg stderr]', l));
        }
        this.emit('error', err);
        reject(err);
      });

      cmd.on('end', () => {
        this.running = false;
        this.process = null;
        console.log('[ffmpeg] Finished — all segments written');
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
      this.process.kill('SIGTERM');
      this.running = false;
      this.process = null;
    }
  }
}
