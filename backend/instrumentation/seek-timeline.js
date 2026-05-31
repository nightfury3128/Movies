/**
 * Per-seek-operation timeline — all events share T+0 from construction.
 */

const ON = process.env.SEEK_LOG !== '0';

export class SeekTimeline {
  constructor(jobId) {
    this.jobId   = jobId;
    this.t0      = process.hrtime.bigint();
    this.events  = [];
    this._once   = new Set();
  }

  /** Elapsed ms since seek operation started */
  elapsedMs() {
    return Number(process.hrtime.bigint() - this.t0) / 1e6;
  }

  /**
   * Record a timeline event. Prints immediately as T+xxx label.
   * @param {string} label
   * @param {object} [detail]
   */
  mark(label, detail = {}) {
    const t = this.elapsedMs();
    const entry = { t, label, jobId: this.jobId, ...detail };
    this.events.push(entry);
    if (ON) {
      const extra = Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '';
      console.log(`[TIMELINE] T+${(t / 1000).toFixed(3)}s ${label}${extra}`);
    }
    return entry;
  }

  /** Same as mark but fires only once per key */
  markOnce(key, label, detail = {}) {
    if (this._once.has(key)) return null;
    this._once.add(key);
    return this.mark(label, detail);
  }

  /** Print full summary block at end of seek / on timeout */
  summary(reason = 'complete') {
    if (!ON) return;
    console.log(`\n[TIMELINE] ═══ SEEK SUMMARY jobId=${this.jobId} (${reason}) ═══`);
    for (const e of this.events) {
      const extra = Object.entries(e)
        .filter(([k]) => !['t', 'label', 'jobId'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      console.log(`  T+${(e.t / 1000).toFixed(3)}s  ${e.label}${extra ? '  ' + extra : ''}`);
    }
    console.log(`[TIMELINE] ═══ END (${this.events.length} events) ═══\n`);
  }
}
