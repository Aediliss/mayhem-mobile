/**
 * FORK: HF radiofacsimile (WEFAX) on the HAM receiver's USB audio, receive only. Written from the broadcast
 * parameters the meteorological fax services publish (e.g. NOAA's "Worldwide Marine Radiofacsimile Broadcast
 * Schedules"; WMO practice): the dial 1.9 kHz below the assigned frequency, so the audio is FM around 1900 Hz with
 * black at 1500 Hz and white at 2300 Hz; 120 lines a minute (60, 90 and 240 also used) and an index of cooperation
 * of 576 (π × 576 ≈ 1810 pixels a line; IOC 288 gives half); a start signal of black/white alternating at 300 Hz
 * (675 Hz for IOC 288) for about 5 s, then about 30 s of phasing lines (a short pulse marking each line's start, the
 * rest of the line the other level), the chart, and a stop signal alternating at 450 Hz.
 * A quadrature detector gives the tone frequency; Goertzel filters on it hear the start and stop signals; the phasing
 * lines' pulse sets where a line begins; each line's samples are averaged into its pixels. Without a start signal (tuned
 * in mid-chart) the lines run free from wherever they happen to start, as a fax recorder does.
 */
import type { DigitalDecoder } from './digital.js';
import type { SstvRows } from './sstv.js';

const RATE = 48_000;
export const WEFAX_BLACK = 1500, WEFAX_WHITE = 2300;
export type WefaxState = 'free' | 'start' | 'phasing' | 'image' | 'stop';
export interface WefaxStatus { state: WefaxState; lpm: number; ioc: number; line: number; aligned: boolean }

class Goertzel {
  private readonly k: number; private s1 = 0; private s2 = 0;
  constructor(hz: number) { this.k = 2 * Math.cos(2 * Math.PI * hz / RATE); }
  step(x: number): void { const s = x + this.k * this.s1 - this.s2; this.s2 = this.s1; this.s1 = s; }
  /** Power of the block so far, then start again. */
  take(): number { const p = this.s1 * this.s1 + this.s2 * this.s2 - this.k * this.s1 * this.s2; this.s1 = this.s2 = 0; return p; }
}

export class WefaxDecoder implements DigitalDecoder {
  readonly name = 'WEFAX';
  confidence = 0;
  onText: (text: string, meta?: string) => void = () => {};
  onImage: (img: SstvRows) => void = () => {};
  onStatus: (s: WefaxStatus) => void = () => {};
  /** Lines a minute; the start signal says the IOC, not this. */
  lpm = 120;
  /** Lines an image holds before the next one starts (15 minutes at 120 LPM). */
  maxLines = 1800;
  private ioc = 576;
  // detector (as the SSTV decoder's): mix 1900 Hz to zero, four one-pole stages each way, phase step = frequency
  private cr = 1; private ci = 0; private readonly dr = Math.cos(-2 * Math.PI * 1900 / RATE); private readonly di = Math.sin(-2 * Math.PI * 1900 / RATE);
  private i1 = 0; private i2 = 0; private i3 = 0; private i4 = 0; private q1 = 0; private q2 = 0; private q3 = 0; private q4 = 0;
  private readonly a = 1 - Math.exp(-2 * Math.PI * 1300 / RATE);
  private pi = 1; private pq = 0; private tick = 0;
  // start / stop signals: Goertzel on the frequency, blocks of 1/4 s
  private readonly g300 = new Goertzel(300); private readonly g450 = new Goertzel(450); private readonly g675 = new Goertzel(675);
  private bn = 0; private bsum = 0; private bsq = 0; private hits = { s300: 0, s450: 0, s675: 0 };
  // lines
  private state: WefaxState = 'free';
  private pos = 0; private width = 1810; private sum = new Float32Array(1810); private cnt = new Uint16Array(1810);
  private line = 0; private imageNo = 0; private aligned = false;
  private phase: Float32Array[] = []; private pulseAt = -1; private pulseSign = 0; private sinceStart = 0; private skipOne = false;

  reset(): void { this.toState('free'); this.line = 0; this.aligned = false; this.confidence = 0; this.pos = 0; this.phase = []; this.setIoc(576); }

  private setIoc(ioc: number): void { this.ioc = ioc; this.width = Math.round(Math.PI * ioc); this.sum = new Float32Array(this.width); this.cnt = new Uint16Array(this.width); }
  private get lineSamples(): number { return RATE * 60 / this.lpm; }
  private toState(s: WefaxState): void { if (s !== this.state) { this.state = s; this.status(); } }
  private status(): void { this.onStatus({ state: this.state, lpm: this.lpm, ioc: this.ioc, line: this.line, aligned: this.aligned }); }

  push(a: Float32Array, n: number): void {
    const al = this.a, Ls = this.lineSamples;
    for (let k = 0; k < n; k++) {
      const x = a[k], i = x * this.cr, q = x * this.ci;
      const nr = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = nr;
      if (++this.tick === 4096) { this.tick = 0; const g = 1.5 - (this.cr * this.cr + this.ci * this.ci) / 2; this.cr *= g; this.ci *= g; }
      this.i1 += al * (i - this.i1); this.i2 += al * (this.i1 - this.i2); this.i3 += al * (this.i2 - this.i3); this.i4 += al * (this.i3 - this.i4);
      this.q1 += al * (q - this.q1); this.q2 += al * (this.q1 - this.q2); this.q3 += al * (this.q2 - this.q3); this.q4 += al * (this.q3 - this.q4);
      const re = this.i4 * this.pi + this.q4 * this.pq, im = this.q4 * this.pi - this.i4 * this.pq;
      this.pi = this.i4; this.pq = this.q4;
      const f = 1900 + Math.atan2(im, re) * RATE / (2 * Math.PI);
      // start / stop tones
      const d = f - 1900; this.g300.step(d); this.g450.step(d); this.g675.step(d); this.bsum += d; this.bsq += d * d;
      if (++this.bn === RATE / 4) this.block();
      // pixels
      const v = Math.max(0, Math.min(1, (f - WEFAX_BLACK) / (WEFAX_WHITE - WEFAX_BLACK)));
      const col = Math.min(this.width - 1, Math.floor(this.pos * this.width / Ls));
      this.sum[col] += v; this.cnt[col]++;
      if (++this.pos >= Ls) { this.pos -= Ls; this.endLine(); }
    }
  }

  /** A quarter second of the frequency: is it a start (300 / 675 Hz) or stop (450 Hz) signal? */
  private block(): void {
    const n = this.bn, mean = this.bsum / n, varf = this.bsq / n - mean * mean;
    this.bn = 0; this.bsum = 0; this.bsq = 0;
    // a square wave between black and white keeps ~81 % of its power in the fundamental; Goertzel power → share
    const share = (p: number) => varf > 150 * 150 ? 2 * p / (n * n) / varf : 0;
    const s300 = share(this.g300.take()), s450 = share(this.g450.take()), s675 = share(this.g675.take());
    const h = this.hits;
    h.s300 = s300 > 0.45 ? h.s300 + 1 : 0; h.s450 = s450 > 0.45 ? h.s450 + 1 : 0; h.s675 = s675 > 0.45 ? h.s675 + 1 : 0;
    if ((h.s300 >= 4 || h.s675 >= 4) && this.state !== 'start') {
      this.setIoc(h.s675 >= 4 ? 288 : 576);
      this.toState('start'); this.phase = []; this.pulseAt = -1; this.aligned = false; this.sinceStart = 0;
      this.onText(`WEFAX start · IOC ${this.ioc} · ${this.lpm} LPM\n`);
    } else if (this.state === 'start' && h.s300 === 0 && h.s675 === 0) {
      this.toState('phasing'); this.pos = 0; this.sum.fill(0); this.cnt.fill(0);
    }
    if (h.s450 >= 4 && (this.state === 'image' || this.state === 'free' || this.state === 'phasing')) {
      if (this.state === 'image') this.onText(`WEFAX stop · ${this.line} lines\n`);
      this.toState('stop');
    } else if (this.state === 'stop' && h.s450 === 0) { this.toState('free'); this.line = 0; this.imageNo++; }
    this.confidence = this.state === 'image' || this.state === 'phasing' || this.state === 'start' ? 1 : this.confidence * 0.95;
  }

  private endLine(): void {
    const W = this.width, row = new Float32Array(W);
    for (let i = 0; i < W; i++) { row[i] = this.cnt[i] ? this.sum[i] / this.cnt[i] : 0; }
    this.sum.fill(0); this.cnt.fill(0);
    if (this.state === 'start' || this.state === 'stop') return;
    if (this.state === 'phasing') { this.phasingLine(row); return; }
    this.emit(row);
  }

  /** Phasing: find the pulse (5 % of a line, the other level from the rest) in the lines' average, move the line
   *  start onto it, and leave phasing when a line no longer shows it. */
  private phasingLine(row: Float32Array): void {
    const W = this.width, pw = Math.max(4, Math.round(W * 0.05));
    if (++this.sinceStart > Math.round(40 * this.lpm / 60)) { this.toState('image'); this.newImage(); this.emit(row); return; }   // phasing lasts ~30 s
    if (this.skipOne) { this.skipOne = false; return; }   // the line cut short by the move
    if (this.pulseAt < 0) {
      this.phase.push(row);
      if (this.phase.length < 5) return;
      const avg = new Float32Array(W); for (const r of this.phase) for (let i = 0; i < W; i++) avg[i] += r[i] / this.phase.length;
      let tot = 0; for (let i = 0; i < W; i++) tot += avg[i];
      let win = 0; for (let i = 0; i < pw; i++) win += avg[i];
      let best = 0, bestDev = 0;
      for (let p = 0; p < W; p++) {
        const dev = win / pw - (tot - win) / (W - pw);
        if (Math.abs(dev) > Math.abs(bestDev)) { bestDev = dev; best = p; }
        win += avg[(p + pw) % W] - avg[p];
      }
      if (Math.abs(bestDev) < 0.3) return;   // not phasing lines (yet)
      // the pulse starts each line: move the line start to it
      this.pulseAt = 0; this.pulseSign = Math.sign(bestDev); this.aligned = true; this.skipOne = true;
      this.pos = ((this.pos - best * this.lineSamples / W) % this.lineSamples + this.lineSamples) % this.lineSamples;
      this.onText(`WEFAX phasing · line start found\n`); this.status();
      return;
    }
    let inP = 0, rest = 0; for (let i = 0; i < W; i++) { if (i < pw) inP += row[i]; else rest += row[i]; }
    const dev = inP / pw - rest / (W - pw);
    if (dev * this.pulseSign < 0.3) { this.toState('image'); this.newImage(); this.emit(row); }
  }

  private newImage(): void { this.line = 0; this.imageNo++; }

  private emit(row: Float32Array): void {
    if (this.line >= this.maxLines) { this.line = 0; this.imageNo++; }
    const W = this.width, rgba = new Uint8ClampedArray(W * 4);
    for (let i = 0; i < W; i++) { const g = Math.round(row[i] * 255); rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = g; rgba[4 * i + 3] = 255; }
    const label = `${this.state === 'free' ? 'WEFAX (free-running)' : 'WEFAX'} ${this.lpm}/${this.ioc} #${this.imageNo}`;
    this.onImage({ mode: label, width: W, height: this.maxLines, line: this.line, count: 1, rows: rgba });
    this.line++;
    if (this.line % 20 === 0) this.status();
  }
}

// ---- transmitter side, for the tests ---------------------------------------------------------------------------------------
/** A fax transmission as audio: start signal, phasing (pulse white at the line start), [lines] (rows of 0-1 values,
 *  any width, stretched over the line), stop signal, then black. */
export function wefaxAudio(lines: Float32Array[], opts: { lpm?: number; ioc?: 576 | 288; phasingS?: number; startS?: number; rate?: number } = {}): Float32Array {
  const rate = opts.rate ?? RATE, lpm = opts.lpm ?? 120, Ls = rate * 60 / lpm, startHz = (opts.ioc ?? 576) === 288 ? 675 : 300;
  const out: number[] = []; let ph = 0;
  const tone = (f: number) => { ph += 2 * Math.PI * f / rate; out.push(Math.sin(ph)); };
  const lvl = (v: number) => WEFAX_BLACK + v * (WEFAX_WHITE - WEFAX_BLACK);
  const alt = (hz: number, s: number) => { for (let i = 0; i < s * rate; i++) tone(lvl(Math.floor(2 * i * hz / rate) % 2)); };
  alt(startHz, opts.startS ?? 5);
  const nPh = Math.round((opts.phasingS ?? 30) * lpm / 60);
  for (let l = 0; l < nPh; l++) for (let i = 0; i < Ls; i++) tone(lvl(i < 0.05 * Ls ? 1 : 0));
  for (const row of lines) for (let i = 0; i < Ls; i++) tone(lvl(row[Math.min(row.length - 1, Math.floor(i * row.length / Ls))]));
  alt(450, 5);
  for (let i = 0; i < 10 * rate; i++) tone(lvl(0));
  return Float32Array.from(out);
}
