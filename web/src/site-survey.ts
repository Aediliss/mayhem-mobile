/**
 * FORK: the Site Survey's baseline, comparison and report (pure: no DOM). A site is a named place; its baseline is, for
 * each span (centre frequency and rate), every bin's highest level above the noise floor and its busiest share of time
 * over the learning passes. Watching, a pass's bins that stand 10 dB or more above anything the baseline held near them
 * (±2 bins, for drift) and 15 dB over the floor are a NEW EMITTER, grouped into signals by adjacent bins. Emitters the
 * baseline held strongly that are now gone are listed too (a camera or alarm sensor that stopped). Levels are relative to
 * each pass's own floor, so a different gain setting does not read as a change. Our own design.
 */
import type { SurveyPass } from './dsp/survey.js';

export interface SpanBase { centreHz: number; rate: number; passes: number; floorDb: number; maxRel: number[]; occ: number[]; valid: number[] }
export interface Emitter { hz: number; bwHz: number; relDb: number }
export interface NewEmitter extends Emitter { key: string; firstMs: number; lastMs: number; passes: number; spanHz: number }
export interface SiteData { v: 1; site: string; created: number; updated: number; spans: SpanBase[]; alerts: NewEmitter[] }

const NEAR = 2, NEW_OVER_DB = 10, MIN_REL_DB = 15;
const keyOf = (centreHz: number, rate: number) => `${Math.round(centreHz)}@${Math.round(rate)}`;
const hzOf = (b: { centreHz: number; rate: number }, k: number, n: number) => b.centreHz + (k - n / 2) * b.rate / n;

/** Signals in [rel] (dB over the floor): runs of usable bins over [min], gaps of up to 2 bins joined. */
export function emittersIn(span: { centreHz: number; rate: number }, rel: ArrayLike<number>, valid: ArrayLike<number>, min = MIN_REL_DB, pick: (k: number) => boolean = () => true): Emitter[] {
  const n = rel.length, out: Emitter[] = []; let s = -1, e = -1, pk = -99, wsum = 0, hsum = 0;
  const close = () => { if (s >= 0) out.push({ hz: Math.round(hsum / wsum), bwHz: Math.round((e - s + 1) * span.rate / n), relDb: Math.round(pk * 10) / 10 }); s = -1; pk = -99; wsum = 0; hsum = 0; };
  for (let k = 0; k < n; k++) {
    const on = !!valid[k] && rel[k] >= min && pick(k);
    if (on) { if (s >= 0 && k - e > NEAR + 1) close(); if (s < 0) s = k; e = k; pk = Math.max(pk, rel[k]); const w = 10 ** (rel[k] / 10); wsum += w; hsum += w * hzOf(span, k, n); }
  }
  close();
  return out;
}

export class SiteSurvey {
  site: string; created: number; updated: number;
  /** Learning: passes go into the baseline; else they are compared with it. */
  learning = true;
  private readonly spans = new Map<string, SpanBase>();
  private readonly alerts = new Map<string, NewEmitter>();
  constructor(site = 'site', now = Date.now()) { this.site = site; this.created = now; this.updated = now; }

  get spanCount(): number { return this.spans.size; }
  /** Learning passes the span has had (0: not learned). */
  passesOf(centreHz: number, rate: number): number { return this.spans.get(keyOf(centreHz, rate))?.passes ?? 0; }

  /** A pass from the worker. Returns the new emitters it raised (watching) or nothing (learning). */
  add(p: SurveyPass, now = Date.now()): NewEmitter[] {
    this.updated = now;
    const k = keyOf(p.centreHz, p.rate), b = this.spans.get(k);
    if (this.learning || !b) {
      if (!b) this.spans.set(k, { centreHz: p.centreHz, rate: p.rate, passes: 1, floorDb: round(p.floorDb), maxRel: Array.from(p.maxRel, round), occ: Array.from(p.occ, x => Math.round(x * 100) / 100), valid: Array.from(p.valid) });
      else {
        b.floorDb = round((b.floorDb * b.passes + p.floorDb) / (b.passes + 1)); b.passes++;
        for (let i = 0; i < b.maxRel.length; i++) { b.maxRel[i] = Math.max(b.maxRel[i], round(p.maxRel[i])); b.occ[i] = Math.max(b.occ[i], Math.round(p.occ[i] * 100) / 100); }
      }
      return [];
    }
    // watching: bins well over anything the baseline held near them
    const n = b.maxRel.length, near = (i: number) => { let m = -99; for (let j = Math.max(0, i - NEAR); j <= Math.min(n - 1, i + NEAR); j++) m = Math.max(m, b.maxRel[j]); return m; };
    const fresh = emittersIn(p, p.maxRel, p.valid, MIN_REL_DB, i => p.maxRel[i] >= Math.max(near(i), 0) + NEW_OVER_DB);
    const raised: NewEmitter[] = [];
    for (const e of fresh) {
      const ak = `${Math.round(e.hz / 25_000) * 25}k`, a = this.alerts.get(ak);
      if (a) { a.lastMs = now; a.passes++; a.relDb = Math.max(a.relDb, e.relDb); a.bwHz = Math.max(a.bwHz, e.bwHz); }
      else { const x = { ...e, key: ak, firstMs: now, lastMs: now, passes: 1, spanHz: p.centreHz }; this.alerts.set(ak, x); raised.push(x); }
    }
    return raised;
  }

  /** The baseline's own emitters for a span (what was there while learning). */
  baselineEmitters(b: SpanBase): Emitter[] { return emittersIn(b, b.maxRel, b.valid); }
  /** Baseline emitters a pass no longer shows (more than 15 dB down where they were). */
  gone(p: SurveyPass): Emitter[] {
    const b = this.spans.get(keyOf(p.centreHz, p.rate)); if (!b) return [];
    return this.baselineEmitters(b).filter(e => { const k = Math.round((e.hz - p.centreHz) / p.rate * p.maxRel.length + p.maxRel.length / 2); let m = -99; for (let j = k - NEAR; j <= k + NEAR; j++) if (j >= 0 && j < p.maxRel.length) m = Math.max(m, p.maxRel[j]); return m < e.relDb - 15; });
  }
  alertList(): NewEmitter[] { return [...this.alerts.values()].sort((a, b) => b.lastMs - a.lastMs); }
  clearAlerts(): void { this.alerts.clear(); }

  toJSON(): SiteData { return { v: 1, site: this.site, created: this.created, updated: this.updated, spans: [...this.spans.values()], alerts: this.alertList() }; }
  static fromJSON(d: SiteData): SiteSurvey {
    const s = new SiteSurvey(d.site, d.created); s.updated = d.updated; s.learning = false;
    for (const b of d.spans ?? []) s.spans.set(keyOf(b.centreHz, b.rate), { ...b });
    for (const a of d.alerts ?? []) s.alerts.set(a.key, { ...a });
    return s;
  }

  /** A printable, self-contained HTML report. */
  reportHtml(now = Date.now()): string {
    const mhz = (h: number) => (h / 1e6).toFixed(3), when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const spans = [...this.spans.values()].sort((a, b) => a.centreHz - b.centreHz), al = this.alertList();
    const rows = spans.map(b => {
      const base = this.baselineEmitters(b), news = al.filter(a => Math.abs(a.hz - b.centreHz) <= b.rate / 2);
      return `<tr><td>${mhz(b.centreHz - b.rate / 2)}–${mhz(b.centreHz + b.rate / 2)}</td><td>${b.passes}</td><td>${b.floorDb.toFixed(1)}</td><td>${base.length ? base.map(e => `${mhz(e.hz)} (${(e.bwHz / 1e3).toFixed(0)} kHz, +${e.relDb.toFixed(0)} dB)`).join('<br>') : '—'}</td><td class="${news.length ? 'new' : ''}">${news.length ? news.map(e => `${mhz(e.hz)} (+${e.relDb.toFixed(0)} dB, ${e.passes}×)`).join('<br>') : '—'}</td></tr>`;
    }).join('');
    const arows = al.map(a => `<tr><td>${mhz(a.hz)} MHz</td><td>${(a.bwHz / 1e3).toFixed(0)} kHz</td><td>+${a.relDb.toFixed(0)} dB</td><td>${a.passes}</td><td>${when(a.firstMs)}</td><td>${when(a.lastMs)}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>RF site survey: ${esc(this.site)}</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top;font-size:12px}th{background:#eee}.new{color:#b00;font-weight:600}small{color:#555}
@media print{body{margin:10mm}}</style></head><body>
<h1>RF site survey: ${esc(this.site)}</h1><small>Baseline started ${when(this.created)} · last updated ${when(this.updated)} · report ${when(now)} · Mad Mobile (receive only)</small>
<h2>Spans</h2><table><tr><th>Span (MHz)</th><th>Learning passes</th><th>Floor (dB, relative)</th><th>Baseline emitters</th><th>New emitters</th></tr>${rows || '<tr><td colspan="5">no spans learned</td></tr>'}</table>
<h2>New emitters (${al.length})</h2><table><tr><th>Frequency</th><th>Width</th><th>Over the floor</th><th>Passes seen</th><th>First seen</th><th>Last seen</th></tr>${arows || '<tr><td colspan="6">none</td></tr>'}</table>
<p><small>Levels are dB above each pass's noise floor (the median bin), not absolute power. A new emitter is a signal 10 dB or more above anything the baseline held within two bins of it, and 15 dB over the floor. Intermittent devices (key fobs, sensors, radios used now and then) appear when they happen to transmit during a pass: learn over several passes and at different times of day.</small></p>
</body></html>`;
  }
}
const round = (x: number) => Math.round(x * 10) / 10;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
