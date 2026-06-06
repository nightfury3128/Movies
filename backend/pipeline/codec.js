/**
 * pipeline/codec.js — codec detection via ffprobe.
 *
 * Determines whether to remux (copy) or transcode the source video/audio.
 * Remux runs at ~100x realtime; transcode uses ~1 CPU core per session.
 *
 * For 10-15 concurrent users, remux (H.264+AAC sources) is required to
 * avoid saturating the CPU. Transcode is reserved for incompatible sources.
 */

import { promisify } from 'util';
import { exec } from 'child_process';

const execP = promisify(exec);

// H.264 video can be remuxed without re-encoding.
const REMUX_VIDEO = new Set(['h264']);
// These audio codecs can be remuxed directly into fMP4.
const REMUX_AUDIO = new Set(['aac', 'mp3']);

/**
 * Probe a video source via ffprobe and return codec capabilities.
 * @param {string} sourceUrl   URL served by TorrentManager's internal HTTP.
 * @param {string} filename    Original filename (provides format hint).
 * @returns {Promise<CodecInfo>}
 */
export async function detectCodecs(sourceUrl, filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const fmtHint = { mkv: 'matroska', mp4: 'mp4', avi: 'avi', mov: 'mov', webm: 'webm', m4v: 'mp4' }[ext] ?? null;
  const fmtOpt  = fmtHint ? `-f ${fmtHint}` : '';

  const cmd = `ffprobe -v quiet -analyzeduration 500000 -probesize 1000000 -print_format json -show_streams -show_format ${fmtOpt} "${sourceUrl}"`;

  let probe;
  try {
    const { stdout } = await execP(cmd, { timeout: 30_000 });
    probe = JSON.parse(stdout);
  } catch (e) {
    console.warn('[codec] ffprobe failed:', e.message, '— falling back to transcode');
    return fallbackCodecInfo();
  }

  const streams  = probe.streams ?? [];
  const videoSt  = streams.find(s => s.codec_type === 'video');
  const audioSt  = streams.find(s => s.codec_type === 'audio');

  const videoCodec = videoSt?.codec_name?.toLowerCase() ?? null;
  const audioCodec = audioSt?.codec_name?.toLowerCase() ?? null;

  // Pixel format — Chrome MSE only accepts 8-bit yuv420p for H.264.
  const pixFmt = videoSt?.pix_fmt ?? '';
  const is8bit420 = pixFmt === 'yuv420p';

  const needsVideoTranscode = !videoCodec || !REMUX_VIDEO.has(videoCodec) || !is8bit420;
  const needsAudioTranscode = audioCodec != null && !REMUX_AUDIO.has(audioCodec);
  const mode = (!needsVideoTranscode && !needsAudioTranscode) ? 'remux' : 'transcode';

  // Duration: prefer explicit header value; fall back to size/bitrate (works when
  // format.duration is absent in poorly-muxed MKV or AVI/TS sources).
  const durationRaw = videoSt?.duration ?? audioSt?.duration ?? probe.format?.duration;
  let duration = durationRaw ? parseFloat(durationRaw) : null;
  if (!duration) {
    const br   = parseFloat(probe.format?.bit_rate);
    const size = parseFloat(probe.format?.size);
    if (br > 0 && size > 0) duration = size * 8 / br;
  }

  const mimeType = audioCodec !== null
    ? 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'
    : 'video/mp4; codecs="avc1.64001f"';

  return {
    mode,
    videoCodec,
    audioCodec,
    needsVideoTranscode,
    needsAudioTranscode,
    pixFmt,
    duration: isFinite(duration) ? duration : null,
    mimeType,
  };
}

function fallbackCodecInfo() {
  return {
    mode:                'transcode',
    videoCodec:          null,
    audioCodec:          null,
    needsVideoTranscode: true,
    needsAudioTranscode: true,
    pixFmt:              null,
    duration:            null,
    mimeType:            'video/mp4; codecs="avc1.64001f"',
  };
}
