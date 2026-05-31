/**
 * hls/codec.js — ffprobe-based codec detection
 *
 * WHY THIS EXISTS:
 * Before starting FFmpeg in HLS-output mode, we need to decide whether to:
 *   (a) remux:     copy video+audio bitstreams as-is (fast, no CPU, browser must support codec)
 *   (b) transcode: re-encode to H.264 + AAC (slower, CPU-intensive, universally playable)
 *
 * Running ffprobe once upfront lets us make an informed decision rather than
 * blindly transcoding everything (wasteful) or blindly remuxing (breaks on HEVC/AC3).
 *
 * WHY A 30-SECOND TIMEOUT?
 * ffprobe reads from the internal HTTP range server, which blocks on pieces not
 * yet downloaded. If the torrent is extremely slow or the magnet resolves to a
 * dead swarm, ffprobe could hang forever. 30 s is generous for a 1 MB buffer.
 *
 * BROWSER SAFETY RULES (as of 2024):
 *   Video: H.264 (h264/avc1) is universally safe. HEVC, AV1, VP9 are not safe
 *          in all browser+OS combinations. 10-bit H.264 is rejected by MSE.
 *   Audio: AAC-LC and MP3 are universally safe. EAC3, DTS, TrueHD are not.
 *          Multichannel (>2) AAC may confuse the HLS.js TS→fMP4 transmuxer,
 *          so we transcode >2ch sources to stereo AAC.
 */

import ffmpeg from 'fluent-ffmpeg';
import { execFileSync } from 'child_process';

// Codec strings ffprobe reports for browser-safe video.
const SAFE_VIDEO_CODECS = new Set(['h264', 'avc1']);

// Codec strings ffprobe reports for browser-safe audio.
const SAFE_AUDIO_CODECS = new Set(['aac', 'mp3']);

/**
 * Run ffprobe on `url` and return a codec descriptor object.
 *
 * @param {string}   url           - URL accessible to ffprobe (e.g. http://127.0.0.1:<port>/)
 * @param {string[]} inputOptions  - Extra input options passed before -i (e.g. ['-f','matroska'])
 * @returns {Promise<{
 *   videoCodec:           string,
 *   audioCodec:           string|null,
 *   pixFmt:               string,
 *   audioChannels:        number,
 *   is10Bit:              boolean,
 *   needsVideoTranscode:  boolean,
 *   needsAudioTranscode:  boolean,
 *   mode:                 'remux'|'transcode',
 *   duration:             number|null,
 *   bitrate:              number|null,
 * }>}
 */
export async function detectCodecs(url, inputOptions = []) {
  // Prepend probe limits so ffprobe doesn't try to seek to the end of a 4+ GB
  // MKV file to read cue tables — that blocks until the entire torrent downloads.
  const probeOpts = [
    // Prevent ffprobe from seeking to end-of-file for MKV Cues table — same
    // issue as FFmpeg without -seekable 0: issues a range request for byte ~4.4 GB
    // which blocks forever until those torrent pieces download.
    '-seekable',        '0',
    '-probesize',       '1000000',  // 1 MB — enough for any container header
    '-analyzeduration', '500000',   // 500 ms — avoids waiting for A/V sync frames
    ...inputOptions,
  ];
  const data = await probeWithTimeout(url, probeOpts, 30_000);

  const streams  = data.streams  ?? [];
  const format   = data.format   ?? {};

  // ── Find primary video stream ────────────────────────────────────────────────
  const videoStream = streams.find(s => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error(`ffprobe found no video stream in: ${url}`);
  }

  const videoCodec = (videoStream.codec_name ?? '').toLowerCase();
  const pixFmt     = (videoStream.pix_fmt    ?? '').toLowerCase();

  // 10-bit pixel formats contain '10' in their name (yuv420p10le, yuv420p10be,
  // yuv422p10le, p010le, …). MSE only accepts 8-bit yuv420p for H.264.
  const is10Bit = pixFmt.includes('10');

  // ── Find primary audio stream ────────────────────────────────────────────────
  const audioStream = streams.find(s => s.codec_type === 'audio');
  const audioCodec    = audioStream ? (audioStream.codec_name ?? '').toLowerCase() : null;
  const audioChannels = audioStream ? (audioStream.channels ?? 0) : 0;

  // ── Browser compatibility decisions ─────────────────────────────────────────
  // Video must be H.264 8-bit to remux safely.
  const needsVideoTranscode =
    !SAFE_VIDEO_CODECS.has(videoCodec) || is10Bit;

  // Audio needs transcoding if:
  //   - codec is not browser-safe (not aac/mp3)
  //   - OR more than 2 channels (HLS.js fMP4 transmux breaks on >2ch AAC)
  // If there's no audio stream, no transcoding needed.
  const needsAudioTranscode = audioStream
    ? (!SAFE_AUDIO_CODECS.has(audioCodec) || audioChannels > 2)
    : false;

  const mode = (needsVideoTranscode || needsAudioTranscode) ? 'transcode' : 'remux';

  // ── Duration / bitrate from container-level metadata ────────────────────────
  const duration = format.duration ? parseFloat(format.duration) : null;
  const bitrate  = format.bit_rate ? parseInt(format.bit_rate, 10) : null;

  console.log(
    `[codec] ${videoCodec} / ${audioCodec ?? 'none'} | ` +
    `pix=${pixFmt} | 10bit=${is10Bit} | ch=${audioChannels} | mode=${mode}`
  );

  return {
    videoCodec,
    audioCodec,
    pixFmt,
    audioChannels,
    is10Bit,
    needsVideoTranscode,
    needsAudioTranscode,
    mode,
    duration,
    bitrate,
  };
}

/**
 * Read MSE mimeType strings from an on-disk fMP4 init segment.
 * Must match bytes in init.mp4 — hardcoded avc1/mp4a strings cause APPEND_FAILED.
 *
 * @param {string} initPath - Absolute path to init.mp4
 * @returns {{ mimeType: string, videoMimeCodec: string, audioMimeCodec: string|null }}
 */
export function probeInitMimeType(initPath) {
  let raw;
  try {
    raw = execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', initPath,
    ], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`ffprobe init failed: ${err.message}`);
  }

  const streams = JSON.parse(raw).streams ?? [];
  const video   = streams.find(s => s.codec_type === 'video');
  if (!video) throw new Error('init.mp4 has no video stream');

  const audio       = streams.find(s => s.codec_type === 'audio');
  const videoMime   = video.mime_codec_string ?? avc1FromStream(video);
  const audioMime   = audio?.mime_codec_string ?? (audio ? 'mp4a.40.2' : null);

  const mimeType = audioMime
    ? `video/mp4; codecs="${videoMime}, ${audioMime}"`
    : `video/mp4; codecs="${videoMime}"`;

  return { mimeType, videoMimeCodec: videoMime, audioMimeCodec: audioMime };
}

/** Build avc1.PPCCLL from ffprobe stream when mime_codec_string is absent. */
function avc1FromStream(stream) {
  const tag = stream.codec_tag_string ?? 'avc1';
  if (tag !== 'avc1' && tag !== 'h264') return 'avc1.640028';
  const ex = stream.extradata;
  if (ex && typeof ex === 'string') {
    const buf = Buffer.from(ex, 'base64');
    if (buf.length >= 4) {
      const profile = buf[1].toString(16).padStart(2, '0');
      const level   = buf[3].toString(16).padStart(2, '0');
      return `avc1.${profile}00${level}`;
    }
  }
  return 'avc1.640028';
}

// ─── INTERNALS ───────────────────────────────────────────────────────────────

/**
 * Wraps fluent-ffmpeg's ffprobe in a Promise and races it against a timeout.
 *
 * fluent-ffmpeg's ffprobe() already accepts extra input options via the
 * second argument (`options` array) — we pass them through directly.
 *
 * @param {string}   url
 * @param {string[]} inputOptions
 * @param {number}   timeoutMs
 * @returns {Promise<object>} raw ffprobe JSON output
 */
function probeWithTimeout(url, inputOptions, timeoutMs) {
  const probe = new Promise((resolve, reject) => {
    // fluent-ffmpeg passes inputOptions before the -i flag, which is exactly
    // where format hints (-f matroska) and probe-size overrides belong.
    ffmpeg.ffprobe(url, inputOptions, (err, data) => {
      if (err) reject(err);
      else     resolve(data);
    });
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`ffprobe timed out after ${timeoutMs}ms for: ${url}`)), timeoutMs)
  );

  return Promise.race([probe, timeout]);
}
