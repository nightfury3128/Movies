/**
 * Parse video tfdt baseMediaDecodeTime from an fMP4 media segment (.m4s).
 */

import fs from 'fs';

const VIDEO_TIMESCALE = 16000;
export const FRAGMENT_SEG_DURATION = 2;

/**
 * Global segment index for a fragment from its video decode start time.
 * @param {number} startSeconds
 */
export function globalIdxFromFragmentStart(startSeconds) {
  return Math.floor(startSeconds / FRAGMENT_SEG_DURATION);
}

/**
 * @param {string} filePath
 * @returns {{ bmdt: number, startSeconds: number, timescale: number } | null}
 */
export function readFragmentVideoTimeline(filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  const bmdt = readFirstVideoTfdt(data);
  if (bmdt == null) return null;

  return {
    bmdt,
    startSeconds: bmdt / VIDEO_TIMESCALE,
    timescale:    VIDEO_TIMESCALE,
  };
}

/**
 * Full media range for one fMP4 segment: TFDT start + trun sample duration.
 *
 * @param {string} filePath
 * @returns {{ startSeconds: number, durationSeconds: number, endSeconds: number, timescale: number } | null}
 */
export function readFragmentMediaRange(filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  const bmdt = readFirstVideoTfdt(data);
  if (bmdt == null) return null;

  const durationTicks = readFirstVideoTrunDuration(data);
  const durationSeconds = durationTicks != null
    ? durationTicks / VIDEO_TIMESCALE
    : FRAGMENT_SEG_DURATION;

  const startSeconds = bmdt / VIDEO_TIMESCALE;
  return {
    startSeconds,
    durationSeconds,
    endSeconds: startSeconds + durationSeconds,
    timescale:  VIDEO_TIMESCALE,
  };
}

/** @param {Buffer} data */
function readFirstVideoTfdt(data) {
  let found = null;

  /** @param {Buffer} buf */
  function walk(buf) {
    let o = 0;
    while (o + 8 <= buf.length) {
      const sz = buf.readUInt32BE(o);
      if (sz < 8) break;
      const type = buf.toString('latin1', o + 4, o + 8);
      const payload = buf.subarray(o + 8, o + sz);

      if (type === 'tfdt' && found == null) {
        const version = payload[0];
        found = version === 1
          ? Number(payload.readBigUInt64BE(4))
          : payload.readUInt32BE(4);
      } else if (type === 'moof' || type === 'traf' || type === 'mfhd') {
        walk(payload);
      }

      o += sz;
    }
  }

  walk(data);
  return found;
}

/** @param {Buffer} data @returns {number|null} total sample duration in timescale ticks */
function readFirstVideoTrunDuration(data) {
  let found = null;

  /** @param {Buffer} buf */
  function walk(buf) {
    let o = 0;
    while (o + 8 <= buf.length) {
      const sz = buf.readUInt32BE(o);
      if (sz < 8) break;
      const type = buf.toString('latin1', o + 4, o + 8);
      const payload = buf.subarray(o + 8, o + sz);

      if (type === 'trun' && found == null) {
        found = parseTrunDuration(payload);
      } else if (type === 'moof' || type === 'traf' || type === 'mfhd' || type === 'trak') {
        walk(payload);
      }

      o += sz;
    }
  }

  walk(data);
  return found;
}

/** @param {Buffer} payload @returns {number|null} */
function parseTrunDuration(payload) {
  if (payload.length < 8) return null;
  const flags         = payload.readUInt32BE(0) & 0xffffff;
  const sampleCount   = payload.readUInt32BE(4);
  const hasDuration   = (flags & 0x100) !== 0;
  const hasDefaultDur = (flags & 0x200) !== 0;

  let offset = 8;
  if (flags & 0x001) offset += 4; // data_offset
  if (hasDefaultDur) offset += 4;

  if (sampleCount === 0) return null;

  if (hasDuration) {
    let total = 0;
    for (let i = 0; i < sampleCount; i++) {
      if (offset + 4 > payload.length) break;
      total += payload.readUInt32BE(offset);
      offset += 4;
      if (flags & 0x400) offset += 4; // first_sample_flags
      if (flags & 0x800) offset += 4; // sample_size
      if (flags & 0x010) offset += 4; // sample_flags
      if (flags & 0x020) offset += 4; // sample_composition_time_offset
    }
    return total > 0 ? total : null;
  }

  if (hasDefaultDur && offset >= 12) {
    const defaultDur = payload.readUInt32BE(8);
    return defaultDur * sampleCount;
  }

  return null;
}
