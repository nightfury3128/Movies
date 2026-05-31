/**
 * pipeline/fmp4.js — minimal fMP4 box parser.
 *
 * Reads TFDT (base media decode time) and segment duration from fMP4 media
 * segments, and reads the video track timescale from init segments.
 *
 * These values are used by the seek pipeline to:
 *   - Compute accurate startTime/endTime for timeline registration
 *   - Name seek artifacts with their actual decode time (segment_t<ms>.m4s)
 */

import fs from 'fs';

// ── low-level box walk ────────────────────────────────────────────────────────

function ru32(buf, o) {
  return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
}

function ru64(buf, o) {
  return ru32(buf, o) * 0x100000000 + ru32(buf, o + 4);
}

function rtype(buf, o) {
  return String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
}

/**
 * Find first box of given type within buf[start..start+len].
 * Returns { offset, size } or null.
 */
function findBox(buf, type, start = 0, len = buf.length - start) {
  let pos = start;
  const end = start + len;
  while (pos + 8 <= end) {
    const size = ru32(buf, pos);
    if (size < 8) break;
    if (rtype(buf, pos) === type) return { offset: pos, size };
    pos += size;
  }
  return null;
}

// ── TFDT extraction ──────────────────────────────────────────────────────────

/**
 * Extract the video TFDT (raw ticks) from an fMP4 media segment.
 * Walks moof → traf → tfdt.
 * @param {Buffer} buf
 * @returns {number|null}
 */
export function readTfdt(buf) {
  const moof = findBox(buf, 'moof');
  if (!moof) return null;

  const moofData = buf.subarray(moof.offset + 8, moof.offset + moof.size);
  const traf = findBox(moofData, 'traf');
  if (!traf) return null;

  const trafData = moofData.subarray(traf.offset + 8, traf.offset + traf.size);
  const tfdt = findBox(trafData, 'tfdt');
  if (!tfdt) return null;

  const payload = trafData.subarray(tfdt.offset + 8, tfdt.offset + tfdt.size);
  if (payload.length < 8) return null;

  const version = payload[0];
  return version === 1 ? ru64(payload, 4) : ru32(payload, 4);
}

// ── trun duration ────────────────────────────────────────────────────────────

/**
 * Parse total sample duration (ticks) from a trun box payload.
 * @param {Buffer} payload
 * @returns {number|null}
 */
function parseTrunDuration(payload) {
  if (payload.length < 8) return null;

  const flags       = ru32(payload, 0) & 0xffffff;
  const sampleCount = ru32(payload, 4);
  const hasDuration   = (flags & 0x100) !== 0;
  const hasDefaultDur = (flags & 0x200) !== 0;

  let off = 8;
  if (flags & 0x001) off += 4; // data_offset
  if (hasDefaultDur)  off += 4; // default_sample_duration

  if (sampleCount === 0) return null;

  if (hasDuration) {
    let total = 0;
    for (let i = 0; i < sampleCount; i++) {
      if (off + 4 > payload.length) break;
      total += ru32(payload, off);
      off += 4;
      if (flags & 0x400) off += 4; // first_sample_flags
      if (flags & 0x800) off += 4; // sample_size
      if (flags & 0x010) off += 4; // sample_flags
      if (flags & 0x020) off += 4; // sample_composition_time_offset
    }
    return total > 0 ? total : null;
  }

  if (hasDefaultDur && payload.length >= 12) {
    const defaultDur = ru32(payload, 8);
    return defaultDur * sampleCount;
  }

  return null;
}

/**
 * Extract total video sample duration (ticks) from a media segment.
 * Walks moof → traf → trun.
 * @param {Buffer} buf
 * @returns {number|null}
 */
export function readTrunDuration(buf) {
  const moof = findBox(buf, 'moof');
  if (!moof) return null;

  const moofData = buf.subarray(moof.offset + 8, moof.offset + moof.size);
  const traf = findBox(moofData, 'traf');
  if (!traf) return null;

  const trafData = moofData.subarray(traf.offset + 8, traf.offset + traf.size);
  const trun = findBox(trafData, 'trun');
  if (!trun) return null;

  return parseTrunDuration(trafData.subarray(trun.offset + 8, trun.offset + trun.size));
}

// ── Init segment timescale ───────────────────────────────────────────────────

/**
 * Read the video track timescale from an init segment (init.mp4).
 * Walks moov → trak (video, hdlr = 'vide') → mdia → mdhd → timescale.
 * @param {Buffer} buf
 * @returns {number|null}
 */
export function readVideoTimescale(buf) {
  const moov = findBox(buf, 'moov');
  if (!moov) return null;

  const moovData = buf.subarray(moov.offset + 8, moov.offset + moov.size);
  let pos = 0;

  while (pos + 8 <= moovData.length) {
    const size = ru32(moovData, pos);
    if (size < 8) break;
    const type = rtype(moovData, pos);

    if (type === 'trak') {
      const trakData = moovData.subarray(pos + 8, pos + size);

      const mdia = findBox(trakData, 'mdia');
      if (!mdia) { pos += size; continue; }

      const mdiaData = trakData.subarray(mdia.offset + 8, mdia.offset + mdia.size);

      // Check handler type
      const hdlr = findBox(mdiaData, 'hdlr');
      if (!hdlr) { pos += size; continue; }
      const hdlrPayload = mdiaData.subarray(hdlr.offset + 8, hdlr.offset + hdlr.size);
      if (hdlrPayload.length < 12) { pos += size; continue; }
      const handler = String.fromCharCode(
        hdlrPayload[8], hdlrPayload[9], hdlrPayload[10], hdlrPayload[11]
      );
      if (handler !== 'vide') { pos += size; continue; }

      // Found video track — read mdhd timescale
      const mdhd = findBox(mdiaData, 'mdhd');
      if (!mdhd) { pos += size; continue; }
      const mdhdPayload = mdiaData.subarray(mdhd.offset + 8, mdhd.offset + mdhd.size);
      if (mdhdPayload.length < 12) { pos += size; continue; }

      const version = mdhdPayload[0];
      // version==0: flags(3)+creation(4)+modification(4)+timescale(4) → ts at offset 8
      // version==1: flags(3)+creation(8)+modification(8)+timescale(4) → ts at offset 20
      return version === 1 ? ru32(mdhdPayload, 20) : ru32(mdhdPayload, 8);
    }

    pos += size;
  }

  return null;
}

// ── File helpers ─────────────────────────────────────────────────────────────

/**
 * Read TFDT and duration from a segment file.
 * @param {string} filePath
 * @param {number} timescale
 * @returns {Promise<{tfdt:number, startTime:number, durTicks:number|null, duration:number, endTime:number}|null>}
 */
export async function readSegmentTiming(filePath, timescale) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const tfdt = readTfdt(buf);
    if (tfdt == null) return null;

    const startTime = tfdt / timescale;
    const durTicks  = readTrunDuration(buf);
    const duration  = durTicks != null ? durTicks / timescale : 2.0;
    return { tfdt, startTime, durTicks, duration, endTime: startTime + duration };
  } catch {
    return null;
  }
}

/**
 * Read video timescale from an init segment file.
 * @param {string} filePath
 * @returns {Promise<number|null>}
 */
export async function readInitTimescale(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    return readVideoTimescale(buf);
  } catch {
    return null;
  }
}
