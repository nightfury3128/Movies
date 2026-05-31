/**
 * logger.js — structured console logger with namespaced categories.
 *
 * Use namespaced functions rather than raw console.log so we can add
 * structured JSON output, log levels, or pino later without touching callers.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function fmt(ns, msg, meta) {
  const base = `[${ts()}][${ns}] ${msg}`;
  return meta && Object.keys(meta).length ? base + ' ' + JSON.stringify(meta) : base;
}

export function log(ns, msg, meta)  { if (LEVEL >= 2) console.log(fmt(ns, msg, meta)); }
export function warn(ns, msg, meta) { if (LEVEL >= 1) console.warn(fmt(ns, msg, meta)); }
export function err(ns, msg, meta)  { if (LEVEL >= 0) console.error(fmt(ns, msg, meta)); }
export function dbg(ns, msg, meta)  { if (LEVEL >= 3) console.log(fmt(ns, msg, meta)); }

export function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024)       return n + ' B';
  if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
