/**
 * FORK: drone control links told by how they look, receive only (nothing is decoded). A short-time spectrum of the
 * band finds LoRa packets, a single tone sweeping linearly across its bandwidth over and over: the sweep's width is the
 * bandwidth, its slope (bandwidth² / 2^SF) the spreading factor. Packets of one bandwidth and spreading factor are
 * kept together as a link, with the channels they hop over and the time between them.
 *
 * A link is said to be consistent with ExpressLRS only where its published air parameters fit (ExpressLRS, GPL-3.0,
 * src/src/common.cpp and src/lib/FHSS): LoRa at 812.5 kHz (SF5-8) on the 2.4 GHz grid of 80 channels from 2400.4 MHz
 * 1 MHz apart, or at 500 kHz (SF5-9) on its 900 MHz grids (FCC915: 40 from 903.5 MHz; EU868: 13 from 863.275 MHz;
 * AU915: 20 from 915.5 MHz), packets 2 / 3.003 / 4 / 6.666 / 10 / 20 ms apart (2.4 GHz) or 4 … 40 ms (900 MHz).
 * Anything else is named only by what it is: a hopping LoRa link. No DOM.
 */
import { fftInPlace } from './ham/filters.js';

export interface LoraBurst { atS: number; durS: number; centerHz: number; spanHz: number; bwHz: number; sf: number }
export interface LinkSeen {
  key: string; bwHz: number; sf: number; packets: number; channels: number[]; intervalMs: number | null;
  /** Heard often enough to be named (three packets). */
  sure: boolean;
  /** 'ExpressLRS 2.4 GHz', 'ExpressLRS 900 MHz (FCC915)', … or '' when the published parameters do not fit. */
  fits: string; rateHz: number | null; firstS: number; lastS: number;
}

/** The packet intervals (µs) ExpressLRS uses at each spreading factor (its air-rate tables). */
const R2G4: Record<number, number[]> = { 5: [2000, 3003], 6: [4000], 7: [6666, 10000], 8: [20000] };
const R900: Record<number, number[]> = { 5: [4000, 5000], 6: [5000, 10000], 7: [10000], 8: [20000], 9: [40000] };
const GRIDS = [
  { name: 'ExpressLRS 2.4 GHz', bw: 812_500, start: 2400.4e6, step: 1e6, count: 80, rates: R2G4 },
  { name: 'ExpressLRS 900 MHz (FCC915)', bw: 500_000, start: 903.5e6, step: (926.9e6 - 903.5e6) / 39, count: 40, rates: R900 },
  { name: 'ExpressLRS 900 MHz (EU868)', bw: 500_000, start: 863.275e6, step: (869.575e6 - 863.275e6) / 12, count: 13, rates: R900 },
  { name: 'ExpressLRS 900 MHz (AU915)', bw: 500_000, start: 915.5e6, step: (926.9e6 - 915.5e6) / 19, count: 20, rates: R900 },
];

/** LoRa packets in a stream of int8 I/Q at fs, the tuned centre at centreHz. */
export class LinkPrinter {
  onBurst: (b: LoraBurst) => void = () => undefined;
  private readonly N = 256; private readonly floor: Float32Array; private frames = 0;
  private acc = new Float32Array(512); private fill = 0;
  /** The burst being followed: its peak frequencies (Hz from centre) frame by frame. */
  private cur: { start: number; last: number; peaks: number[] } | null = null;
  constructor(readonly fs: number, public centreHz: number) { this.floor = new Float32Array(this.N); }
  push(iq: Int8Array): void {
    const n = iq.length >> 1;
    for (let i = 0; i < n; i++) {
      this.acc[2 * this.fill] = iq[2 * i] / 128; this.acc[2 * this.fill + 1] = iq[2 * i + 1] / 128;
      if (++this.fill === this.N) { this.frame(); this.fill = 0; }
    }
  }
  private frame(): void {
    const N = this.N, re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = this.acc[2 * i] * w; im[i] = this.acc[2 * i + 1] * w; }
    fftInPlace(re, im, false);
    // the frame's noise: its median bin (a chirp fills one or two bins, so the median stays at the noise)
    const pw = new Float32Array(N); for (let k = 0; k < N; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    const med = Float32Array.from(pw).sort()[N >> 1] || 1e-9, thr = 25 * Math.max(med, this.floor[0] * 0.5);
    this.floor[0] = this.frames ? this.floor[0] + 0.01 * (med - this.floor[0]) : med;   // a slow noise level as a lower bound
    let best = -1, bv = 0;
    for (let k = 0; k < N; k++) if (pw[k] > thr && pw[k] > bv) { bv = pw[k]; best = k; }
    const t = this.frames++;
    if (best < 0) { if (this.cur && t - this.cur.last > 3) this.finish(); return; }
    const hz = ((best + N / 2) % N - N / 2) * this.fs / N;
    if (!this.cur || t - this.cur.last > 3) { if (this.cur) this.finish(); this.cur = { start: t, last: t, peaks: [] }; }
    this.cur.last = t; this.cur.peaks.push(hz);
  }
  private finish(): void {
    const c = this.cur; this.cur = null;
    if (!c || c.peaks.length < 8) return;
    const T = this.N / this.fs, lo = Math.min(...c.peaks), hi = Math.max(...c.peaks), span = hi - lo + this.fs / this.N;
    // the sweep: each run of frames between wraps (where the chirp falls back to the bottom) is a straight line; its
    // least-squares slope, the median over the runs (whole bins per frame would round a slow chirp's slope)
    const slopes: number[] = []; let a = 0;
    for (let i = 1; i <= c.peaks.length; i++) {
      if (i < c.peaks.length && c.peaks[i] >= c.peaks[i - 1] - this.fs / this.N) continue;
      const n = i - a;
      if (n >= 3) { let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let j = 0; j < n; j++) { const y = c.peaks[a + j]; sx += j; sy += y; sxx += j * j; sxy += j * y; } const m = (n * sxy - sx * sy) / (n * sxx - sx * sx); if (m > 0) slopes.push(m / T); }
      a = i;
    }
    if (slopes.length < 2) return;
    slopes.sort((x, y) => x - y);
    const slope = slopes[slopes.length >> 1];
    // a chirp, not a wideband burst whose peak jumps about: most steps follow the slope (or wrap back down)
    const bin = this.fs / this.N, want = slope * T;
    let fit = 0; for (let i = 1; i < c.peaks.length; i++) { const d = c.peaks[i] - c.peaks[i - 1]; if (Math.abs(d - want) <= 1.5 * bin || d < -0.5 * span) fit++; }
    if (fit < 0.7 * (c.peaks.length - 1)) return;
    const bw = Math.abs(span - 812_500) < 0.25 * 812_500 ? 812_500 : Math.abs(span - 500_000) < 0.25 * 500_000 ? 500_000 : Math.round(span / 1000) * 1000;
    const sf = Math.round(Math.log2(bw * bw / slope));
    if (sf < 5 || sf > 12) return;
    this.onBurst({ atS: c.start * T, durS: (c.last - c.start + 1) * T, centerHz: this.centreHz + (lo + hi) / 2, spanHz: Math.round(span), bwHz: bw, sf });
  }
}

/** Bursts kept together as links (one per bandwidth and spreading factor), and what they fit. */
export class LinkTracker {
  readonly links = new Map<string, LinkSeen & { times: number[] }>();
  add(b: LoraBurst): LinkSeen {
    const key = `${b.bwHz}/${b.sf}`;
    let l = this.links.get(key);
    if (!l) { l = { key, bwHz: b.bwHz, sf: b.sf, packets: 0, channels: [], intervalMs: null, fits: '', rateHz: null, firstS: b.atS, lastS: b.atS, times: [], sure: false }; this.links.set(key, l); }
    l.packets++; l.sure = l.packets >= 3; l.lastS = b.atS; l.times.push(b.atS); if (l.times.length > 200) l.times.shift();
    const ch = Math.round(b.centerHz / 1e5) * 1e5; if (!l.channels.includes(ch)) l.channels.push(ch);
    // the time between packets: the shortest gap seen often enough (hops out of view make longer ones)
    const gaps = l.times.slice(1).map((t, i) => (t - l!.times[i]) * 1000).filter(g => g > 0.5).sort((a, c) => a - c);
    l.intervalMs = gaps.length >= 2 ? Math.round(gaps[Math.floor(gaps.length * 0.1)] * 100) / 100 : null;
    l.fits = ''; l.rateHz = null;
    for (const g of GRIDS) {
      const ivs = g.rates[b.sf]; if (g.bw !== b.bwHz || !ivs) continue;
      const onGrid = l.channels.filter(c => { const k = Math.round((c - g.start) / g.step); return k >= 0 && k < g.count && Math.abs(c - (g.start + k * g.step)) < 0.15 * g.step + 60e3; }).length;
      if (!l.sure || onGrid < Math.max(2, 0.8 * l.channels.length) || l.channels.length < 2) continue;
      l.fits = g.name;
      // the rate: the published interval that the gaps are whole multiples of
      if (l.intervalMs) { const iv = ivs.find(x => Math.abs(l!.intervalMs! * 1000 / x - Math.round(l!.intervalMs! * 1000 / x)) < 0.08 && Math.round(l!.intervalMs! * 1000 / x) >= 1); if (iv) l.rateHz = Math.round(1e6 / iv); }
      break;
    }
    return l;
  }
}

// ---------------------------------------------------------------------------------------------------- test transmitter

/** One LoRa packet (upchirp preamble then data chirps) at fs, `offsetHz` from centre. */
export function loraPacket(fs: number, bw: number, sf: number, offsetHz: number, symbols = 24, seed = 1): Float32Array {
  const M = 2 ** sf, Ts = M / bw, ns = Math.round(Ts * fs), out = new Float32Array(2 * ns * symbols);
  let r = seed, ph = 0;
  for (let s = 0; s < symbols; s++) {
    r = (r * 1103515245 + 12345) >>> 0;
    const shift = s < 10 ? 0 : (r >>> 8) % M;                     // preamble: plain upchirps; then data
    for (let n = 0; n < ns; n++) {
      const t = n / fs, f0 = (shift / M) * bw;
      let f = -bw / 2 + f0 + (bw / Ts) * t; if (f > bw / 2) f -= bw;
      ph += 2 * Math.PI * (f + offsetHz) / fs;
      out[2 * (s * ns + n)] = Math.cos(ph); out[2 * (s * ns + n) + 1] = Math.sin(ph);
    }
  }
  return out;
}
