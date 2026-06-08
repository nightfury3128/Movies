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

function wu32(buf, o, value) {
  buf[o] = (value >>> 24) & 0xff;
  buf[o + 1] = (value >>> 16) & 0xff;
  buf[o + 2] = (value >>> 8) & 0xff;
  buf[o + 3] = value & 0xff;
}

function wu64(buf, o, value) {
  const big = BigInt(Math.max(0, Math.round(value)));
  wu32(buf, o, Number((big >> 32n) & 0xffffffffn));
  wu32(buf, o + 4, Number(big & 0xffffffffn));
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

function findBoxes(buf, type, start = 0, len = buf.length - start) {
  const boxes = [];
  let pos = start;
  const end = start + len;
  while (pos + 8 <= end) {
    const size = ru32(buf, pos);
    if (size < 8) break;
    if (rtype(buf, pos) === type) boxes.push({ offset: pos, size });
    pos += size;
  }
  return boxes;
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

/**
 * Rewrite one track's TFDT baseMediaDecodeTime in-place.
 * @param {string} filePath
 * @param {{trackId:number,tfdtRaw:number}} opts
 * @returns {Promise<{ok:boolean,trackId:number|null,oldTfdtRaw:number|null,newTfdtRaw:number|null,version:number|null,reason?:string}>}
 */
export async function rewriteTrackTfdt(filePath, opts = {}) {
  const trackId = opts.trackId;
  const tfdtRaw = opts.tfdtRaw;
  if (!Number.isFinite(trackId) || !Number.isFinite(tfdtRaw) || tfdtRaw < 0) {
    return { ok: false, trackId: trackId ?? null, oldTfdtRaw: null, newTfdtRaw: null, version: null, reason: 'invalid_input' };
  }

  const buf = await fs.promises.readFile(filePath);
  const moofs = findBoxes(buf, 'moof');
  for (const moof of moofs) {
    const trafs = findBoxes(buf, 'traf', moof.offset + 8, moof.size - 8);
    for (const traf of trafs) {
      const tfhd = findBox(buf, 'tfhd', traf.offset + 8, traf.size - 8);
      const tfdt = findBox(buf, 'tfdt', traf.offset + 8, traf.size - 8);
      if (!tfhd || !tfdt) continue;

      const tfhdPayload = tfhd.offset + 8;
      if (tfhdPayload + 8 > buf.length) continue;
      const currentTrackId = ru32(buf, tfhdPayload + 4);
      if (currentTrackId !== trackId) continue;

      const tfdtPayload = tfdt.offset + 8;
      if (tfdtPayload + 8 > buf.length) continue;
      const version = buf[tfdtPayload];
      const oldTfdtRaw = version === 1 ? ru64(buf, tfdtPayload + 4) : ru32(buf, tfdtPayload + 4);
      if (version === 1) {
        wu64(buf, tfdtPayload + 4, tfdtRaw);
      } else {
        if (tfdtRaw > 0xffffffff) {
          return { ok: false, trackId, oldTfdtRaw, newTfdtRaw: null, version, reason: 'tfdt_v0_overflow' };
        }
        wu32(buf, tfdtPayload + 4, Math.round(tfdtRaw));
      }
      await fs.promises.writeFile(filePath, buf);
      return { ok: true, trackId, oldTfdtRaw, newTfdtRaw: Math.round(tfdtRaw), version };
    }
  }

  return { ok: false, trackId, oldTfdtRaw: null, newTfdtRaw: null, version: null, reason: 'track_tfdt_not_found' };
}

// ── trun duration ────────────────────────────────────────────────────────────

/**
 * Parse total sample duration (ticks) from a trun box payload.
 * @param {Buffer} payload
 * @returns {number|null}
 */
function parseTrunInfo(payload) {
  if (payload.length < 8) return null;

  const flags       = ru32(payload, 0) & 0xffffff;
  const sampleCount = ru32(payload, 4);
  if (sampleCount === 0) return null;

  // Optional fields before per-sample table (ISO BMFF 8.8.8).
  let off = 8;
  if (flags & 0x001) off += 4; // data_offset
  if (flags & 0x004) off += 4; // first_sample_flags

  let total = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (flags & 0x100) {
      if (off + 4 > payload.length) break;
      total += ru32(payload, off);  // sample_duration
      off += 4;
    }
    if (flags & 0x200) off += 4; // sample_size
    if (flags & 0x400) off += 4; // sample_flags
    if (flags & 0x800) off += 4; // sample_composition_time_offset
  }
  return {
    sampleCount,
    duration: total > 0 ? total : null,
    hasSampleDurations: !!(flags & 0x100),
  };
}

function parseTrunDuration(payload) {
  return parseTrunInfo(payload)?.duration ?? null;
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
      // version==0: version(1)+flags(3)+creation(4)+modification(4)+timescale(4) → ts at offset 12
      // version==1: version(1)+flags(3)+creation(8)+modification(8)+timescale(4) → ts at offset 20
      return version === 1 ? ru32(mdhdPayload, 20) : ru32(mdhdPayload, 12);
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
  // moof (mfhd + traf→tfhd+tfdt+trun) is always within the first few KB.
  // Everything after is mdat (raw media). Reading the full file wastes RAM.
  const HEAD_BYTES = 8192;
  try {
    const fh = await fs.promises.open(filePath, 'r');
    let buf;
    try {
      const { size }      = await fh.stat();
      const readLen       = Math.min(size, HEAD_BYTES);
      const tmp           = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await fh.read(tmp, 0, readLen, 0);
      buf = tmp.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }

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
 * Read video + audio TFDT/duration from a media segment.
 * Assumes the local FFmpeg pipeline writes track 1 as video and track 2 as audio.
 * @param {string} filePath
 * @param {{videoTimescale?:number,audioTimescale?:number}} opts
 * @returns {Promise<{video:null|object,audio:null|object,deltaMs:number|null}>}
 */
export async function readFragmentTracks(filePath, opts = {}) {
  const videoTimescale = opts.videoTimescale ?? 90000;
  const audioTimescale = opts.audioTimescale ?? 48000;
  const HEAD_BYTES = 16384;

  const empty = { video: null, audio: null, deltaMs: null };
  try {
    const fh = await fs.promises.open(filePath, 'r');
    let buf;
    try {
      const { size } = await fh.stat();
      const readLen = Math.min(size, HEAD_BYTES);
      const tmp = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await fh.read(tmp, 0, readLen, 0);
      buf = tmp.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }

    const raw = { video: null, audio: null };

    const parseTraf = payload => {
      let trackId = null;
      let tfdt = null;
      let defaultSampleDuration = 0;
      const truns = [];
      let p = 0;
      while (p + 8 <= payload.length) {
        const size = ru32(payload, p);
        if (size < 8) break;
        const type = rtype(payload, p);
        const pp = payload.subarray(p + 8, p + size);
        if (type === 'tfhd' && pp.length >= 8) {
          const flags = ru32(pp, 0) & 0xffffff;
          trackId = ru32(pp, 4);
          let off = 8;
          if (flags & 0x000001) off += 8; // base_data_offset
          if (flags & 0x000002) off += 4; // sample_description_index
          if ((flags & 0x000008) && off + 4 <= pp.length) {
            defaultSampleDuration = ru32(pp, off);
          }
        } else if (type === 'tfdt' && pp.length >= 8) {
          tfdt = pp[0] === 1 ? ru64(pp, 4) : ru32(pp, 4);
        } else if (type === 'trun') {
          truns.push(pp);
        }
        p += size;
      }

      let sampleCount = 0;
      let trunDur = 0;
      let currentDts = tfdt ?? 0;
      let firstPts = null;
      let lastPts = null;

      for (const pp of truns) {
        if (pp.length < 8) continue;
        const version = pp[0];
        const flags = ru32(pp, 0) & 0xffffff;
        const count = ru32(pp, 4);
        sampleCount += count;

        let off = 8;
        if (flags & 0x000001) off += 4; // data_offset
        if (flags & 0x000004) off += 4; // first_sample_flags

        for (let i = 0; i < count; i++) {
          if (off > pp.length) break;

          let sampleDur = defaultSampleDuration || 0;
          if (flags & 0x000100) {
            if (off + 4 > pp.length) break;
            sampleDur = ru32(pp, off);
            off += 4;
          }
          if (flags & 0x000200) off += 4; // sample_size
          if (flags & 0x000400) off += 4; // sample_flags

          let cto = 0;
          if (flags & 0x000800) {
            if (off + 4 > pp.length) break;
            cto = ru32(pp, off);
            if (version === 1 && cto & 0x80000000) cto -= 0x100000000;
            off += 4;
          }

          const pts = currentDts + cto;
          if (firstPts == null) firstPts = pts;
          lastPts = pts;
          currentDts += sampleDur;
          trunDur += sampleDur;
        }
      }

      return {
        trackId,
        tfdt,
        trunDur: trunDur > 0 ? trunDur : null,
        sampleCount,
        firstPts: firstPts ?? tfdt,
        lastPts: lastPts ?? tfdt,
      };
    };

    const walk = array => {
      let pos = 0;
      while (pos + 8 <= array.length) {
        const size = ru32(array, pos);
        if (size < 8) break;
        const type = rtype(array, pos);
        const payload = array.subarray(pos + 8, pos + size);
        if (type === 'traf') {
          const traf = parseTraf(payload);
          if (traf.trackId === 1 || (traf.trackId == null && raw.video == null)) raw.video = traf;
          else if (traf.trackId === 2 || raw.audio == null) raw.audio = traf;
        } else if (type === 'moof') {
          walk(payload);
        }
        pos += size;
      }
    };

    walk(buf);

    const convert = (track, timescale) => {
      if (track?.tfdt == null || !timescale) return null;
      const start = track.tfdt / timescale;
      const duration = track.trunDur != null ? track.trunDur / timescale : null;
      return {
        tfdtRaw:  track.tfdt,
        tfdt:     start,
        trackId:  track.trackId ?? null,
        start,
        end:      duration != null ? start + duration : null,
        duration,
        firstPts: track.firstPts != null ? track.firstPts / timescale : null,
        lastPts:  track.lastPts  != null ? track.lastPts  / timescale : null,
        sampleCount: track.sampleCount ?? null,
      };
    };

    const video = convert(raw.video, videoTimescale);
    const audio = convert(raw.audio, audioTimescale);
    return {
      video,
      audio,
      deltaMs: video && audio ? Math.round((audio.start - video.start) * 1000) : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Read the audio track timescale from an init segment buffer.
 * Walks moov → trak (hdlr = 'soun') → mdia → mdhd → timescale.
 * @param {Buffer} buf
 * @returns {number|null}
 */
export function readAudioTimescale(buf) {
  const moov = findBox(buf, 'moov');
  if (!moov) return null;
  const moovData = buf.subarray(moov.offset + 8, moov.offset + moov.size);
  let pos = 0;
  while (pos + 8 <= moovData.length) {
    const size = ru32(moovData, pos);
    if (size < 8) break;
    if (rtype(moovData, pos) === 'trak') {
      const trakData = moovData.subarray(pos + 8, pos + size);
      const mdia = findBox(trakData, 'mdia');
      if (mdia) {
        const mdiaData = trakData.subarray(mdia.offset + 8, mdia.offset + mdia.size);
        const hdlr = findBox(mdiaData, 'hdlr');
        if (hdlr) {
          const hdlrP = mdiaData.subarray(hdlr.offset + 8, hdlr.offset + hdlr.size);
          if (hdlrP.length >= 12) {
            const handler = String.fromCharCode(hdlrP[8], hdlrP[9], hdlrP[10], hdlrP[11]);
            if (handler === 'soun') {
              const mdhd = findBox(mdiaData, 'mdhd');
              if (mdhd) {
                const mdhdP = mdiaData.subarray(mdhd.offset + 8, mdhd.offset + mdhd.size);
                if (mdhdP.length >= 13) {
                  return mdhdP[0] === 1 ? ru32(mdhdP, 20) : ru32(mdhdP, 12);
                }
              }
            }
          }
        }
      }
    }
    pos += size;
  }
  return null;
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

/**
 * Read video and audio timescales from an init segment file.
 * @param {string} filePath
 * @returns {Promise<{video:number|null, audio:number|null}>}
 */
export async function readInitTracksTimescale(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    return { video: readVideoTimescale(buf), audio: readAudioTimescale(buf) };
  } catch {
    return { video: null, audio: null };
  }
}

function readTrackIdFromTkhd(payload) {
  if (payload.length < 24) return null;
  const version = payload[0];
  return version === 1 && payload.length >= 32
    ? ru32(payload, 20)
    : ru32(payload, 12);
}

function readTrackInfoFromInit(buf) {
  const moov = findBox(buf, 'moov');
  if (!moov) return { video: null, audio: null };
  const moovData = buf.subarray(moov.offset + 8, moov.offset + moov.size);
  const result = { video: null, audio: null };

  let pos = 0;
  while (pos + 8 <= moovData.length) {
    const size = ru32(moovData, pos);
    if (size < 8) break;
    if (rtype(moovData, pos) !== 'trak') {
      pos += size;
      continue;
    }

    const trakData = moovData.subarray(pos + 8, pos + size);
    const tkhd = findBox(trakData, 'tkhd');
    const mdia = findBox(trakData, 'mdia');
    if (!mdia) {
      pos += size;
      continue;
    }

    const mdiaData = trakData.subarray(mdia.offset + 8, mdia.offset + mdia.size);
    const hdlr = findBox(mdiaData, 'hdlr');
    const mdhd = findBox(mdiaData, 'mdhd');
    const minf = findBox(mdiaData, 'minf');
    if (!hdlr || !mdhd || !minf) {
      pos += size;
      continue;
    }

    const hdlrPayload = mdiaData.subarray(hdlr.offset + 8, hdlr.offset + hdlr.size);
    const mdhdPayload = mdiaData.subarray(mdhd.offset + 8, mdhd.offset + mdhd.size);
    if (hdlrPayload.length < 12 || mdhdPayload.length < 13) {
      pos += size;
      continue;
    }

    const handler = String.fromCharCode(hdlrPayload[8], hdlrPayload[9], hdlrPayload[10], hdlrPayload[11]);
    const timescale = mdhdPayload[0] === 1 ? ru32(mdhdPayload, 20) : ru32(mdhdPayload, 12);
    const trackId = tkhd
      ? readTrackIdFromTkhd(trakData.subarray(tkhd.offset + 8, tkhd.offset + tkhd.size))
      : null;

    let codec = null;
    const minfData = mdiaData.subarray(minf.offset + 8, minf.offset + minf.size);
    const stbl = findBox(minfData, 'stbl');
    if (stbl) {
      const stblData = minfData.subarray(stbl.offset + 8, stbl.offset + stbl.size);
      const stsd = findBox(stblData, 'stsd');
      if (stsd) {
        const stsdPayload = stblData.subarray(stsd.offset + 8, stsd.offset + stsd.size);
        if (stsdPayload.length >= 16) {
          codec = String.fromCharCode(stsdPayload[12], stsdPayload[13], stsdPayload[14], stsdPayload[15]);
        }
      }
    }

    const entry = { trackId, timescale, codec };
    if (handler === 'vide') result.video = entry;
    else if (handler === 'soun') result.audio = entry;
    pos += size;
  }

  return result;
}

/**
 * Read video/audio track ids, timescales, and sample-entry codec names from init.
 * @param {string} filePath
 * @returns {Promise<{video:null|object,audio:null|object}>}
 */
export async function readInitTrackInfo(filePath) {
  try {
    return readTrackInfoFromInit(await fs.promises.readFile(filePath));
  } catch {
    return { video: null, audio: null };
  }
}
