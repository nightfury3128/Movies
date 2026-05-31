/**
 * Verbose logging helpers. Seek-path logs are always on unless SEEK_LOG=0.
 * Set EXTREME_LOG=1 (default) for torrent range / pump / stream wait details.
 *
 * Import this module first in server.js — it patches console.log/warn/error
 * with ISO timestamps (disable via SERVER_LOG_TS=0).
 */

const SEEK_ON    = process.env.SEEK_LOG    !== '0';
const EXTREME_ON = process.env.EXTREME_LOG !== '0';
const SERVER_TS  = process.env.SERVER_LOG_TS !== '0';

const ISO_TS_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:/;

export function ts() {
  return new Date().toISOString();
}

function prependTs(args) {
  if (!SERVER_TS || !args.length) return args;
  const first = args[0];
  if (typeof first === 'string' && ISO_TS_RE.test(first)) return args;
  return [`[${ts()}]`, ...args];
}

let _consolePatched = false;

export function patchConsoleTimestamps() {
  if (_consolePatched || !SERVER_TS) return;
  _consolePatched = true;
  for (const method of ['log', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => orig(...prependTs(args));
  }
}

patchConsoleTimestamps();

function fmtData(data) {
  if (data === undefined) return '';
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [unserializable]';
  }
}

export function seekLog(tag, msg, data) {
  if (!SEEK_ON) return;
  console.log(`[${ts()}] [seek:${tag}] ${msg}${fmtData(data)}`);
}

export function seekWarn(tag, msg, data) {
  if (!SEEK_ON) return;
  console.warn(`[${ts()}] [seek:${tag}] ${msg}${fmtData(data)}`);
}

export function seekErr(tag, msg, data) {
  if (!SEEK_ON) return;
  console.error(`[${ts()}] [seek:${tag}] ${msg}${fmtData(data)}`);
}

/** Structured single-tag logs: [RANGE], [startSeek], [priority], etc. */
export function instrLog(tag, msg, data) {
  if (!SEEK_ON) return;
  console.log(`[${ts()}] [${tag}] ${msg}${fmtData(data)}`);
}

export function instrWarn(tag, msg, data) {
  if (!SEEK_ON) return;
  console.warn(`[${ts()}] [${tag}] ${msg}${fmtData(data)}`);
}

export function extremeLog(tag, msg, data) {
  if (!EXTREME_ON) return;
  console.log(`[${ts()}] [${tag}] ${msg}${fmtData(data)}`);
}

export function extremeWarn(tag, msg, data) {
  if (!EXTREME_ON) return;
  console.warn(`[${ts()}] [${tag}] ${msg}${fmtData(data)}`);
}

/** Human-readable byte offset */
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Raw byte integer for structured range logs */
export function fmtByteNum(n) {
  if (n == null || isNaN(n)) return '?';
  return String(n);
}
