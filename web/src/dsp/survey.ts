/**
 * FORK: the Site Survey's DSP side: one span's spectrum over a dwell, against its own noise floor. Each 100 ms tick (16
 * 1024-point frames, whatever the rate) gives a spectrum in dB; over the dwell each bin keeps its highest level above
 * the tick's floor (the median bin) and how often it stood 10 dB over it. At the end of the dwell (the app retunes, or
 * asks) the pass goes to the page, where the site's baseline and the comparison live (src/site-survey.ts). Our own
 * design. The edges (filter roll-off) and the DC spike are marked unusable.
 */
import { fft } from '../fft.js';
import type { Emit, IqProcessor } from './core.js';

export const SURVEY_BINS = 1024;
const FRAMES = 16, TICK_S = 0.1;

export interface SurveyPass { centreHz: number; rate: number; ticks: number; floorDb: number; maxRel: Float32Array; occ: Float32Array; valid: Uint8Array }

export class SpanAccum {
  private readonly win = Float32Array.from({ length: SURVEY_BINS }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / SURVEY_BINS));
  private readonly re = new Float32Array(SURVEY_BINS); private readonly im = new Float32Array(SURVEY_BINS);
  private readonly acc = new Float64Array(SURVEY_BINS); private frames = 0; private pos = 0; private every = SURVEY_BINS;
  private maxRel = new Float32Array(SURVEY_BINS); private occN = new Float32Array(SURVEY_BINS); private floors: number[] = []; private ticks = 0;
  readonly valid = new Uint8Array(SURVEY_BINS);
  /** Samples skipped first: what was still in flight from the last tuning. */
  private skip = 0;
  constructor(readonly centreHz: number, readonly rate: number, settleS = 0) {
    this.skip = Math.round(settleS * rate);
    this.every = Math.max(SURVEY_BINS, Math.floor(rate * TICK_S / FRAMES));
    const edge = Math.ceil(SURVEY_BINS * 0.05), dc = Math.max(2, Math.ceil(SURVEY_BINS * 0.004));
    for (let k = 0; k < SURVEY_BINS; k++) this.valid[k] = k >= edge && k < SURVEY_BINS - edge && Math.abs(k - SURVEY_BINS / 2) > dc ? 1 : 0;
    this.maxRel.fill(-99);
  }
  get tickCount(): number { return this.ticks; }
  push(iq: ArrayLike<number>, n = iq.length >> 1): void {
    for (let i = 0; i < n; i++) {
      if (this.skip > 0) { this.skip--; continue; }
      if (this.pos < SURVEY_BINS) { this.re[this.pos] = iq[2 * i] * this.win[this.pos]; this.im[this.pos] = iq[2 * i + 1] * this.win[this.pos]; }
      if (++this.pos === SURVEY_BINS) this.frame();
      if (this.pos >= this.every) this.pos = 0;
    }
  }
  private frame(): void {
    fft(this.re, this.im);
    for (let k = 0; k < SURVEY_BINS; k++) { const j = (k + SURVEY_BINS / 2) % SURVEY_BINS; this.acc[k] += this.re[j] * this.re[j] + this.im[j] * this.im[j]; }
    if (++this.frames < FRAMES) return;
    const db = new Float32Array(SURVEY_BINS), v: number[] = [];
    for (let k = 0; k < SURVEY_BINS; k++) { db[k] = 10 * Math.log10(this.acc[k] / FRAMES + 1e-20); if (this.valid[k]) v.push(db[k]); }
    v.sort((a, b) => a - b); const floor = v[v.length >> 1];
    for (let k = 0; k < SURVEY_BINS; k++) { const r = db[k] - floor; if (r > this.maxRel[k]) this.maxRel[k] = r; if (r >= 10) this.occN[k]++; }
    this.floors.push(floor); this.ticks++;
    this.acc.fill(0); this.frames = 0;
  }
  /** The pass so far. */
  pass(): SurveyPass {
    const f = [...this.floors].sort((a, b) => a - b);
    return { centreHz: this.centreHz, rate: this.rate, ticks: this.ticks, floorDb: f.length ? f[f.length >> 1] : 0, maxRel: this.maxRel.slice(), occ: this.occN.map(x => x / Math.max(1, this.ticks)), valid: this.valid.slice() };
  }
}

/** The worker's processor: the current span's accumulator; each retune hands the last span's pass to the page. */
export class SurveyProcessor implements IqProcessor {
  private acc: SpanAccum | null = null; private centreHz = 0; private rate = 0;
  constructor(private readonly emit: Emit) {}
  /** A new span (the app retuned): the last one's pass goes out. */
  begin(centreHz: number): void { this.flush(); this.centreHz = centreHz; this.acc = this.rate ? new SpanAccum(centreHz, this.rate, 0.25) : null; }
  /** Send the current pass (if it has a second of signal). */
  flush(): void {
    const a = this.acc; this.acc = null;
    if (!a || a.tickCount < 10) return;
    const p = a.pass();
    this.emit({ type: 'surveyPass', pass: { ...p, maxRel: p.maxRel, occ: p.occ, valid: p.valid } }, [p.maxRel.buffer, p.occ.buffer, p.valid.buffer]);
  }
  reset(rate: number): void { if (rate === this.rate && this.acc) return; this.rate = rate; if (this.centreHz) this.acc = new SpanAccum(this.centreHz, rate, 0.25); }
  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate || !this.acc) this.reset(rate);
    this.acc!.push(iq, iq.length >> 1);
    if (this.acc!.tickCount % 10 === 9 && this.acc!.tickCount !== this.lastTick) { this.lastTick = this.acc!.tickCount; this.emit({ type: 'surveyTick', centreHz: this.centreHz, ticks: this.acc!.tickCount }); }
  }
  private lastTick = -1;
}
