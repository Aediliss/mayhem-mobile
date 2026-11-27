/**
 * FORK: Inmarsat Aero R and T channels at 600 and 1200 bps: MSK bursts from aircraft, after JAERO by Jonathan Olds (MIT:
 * burstmskdemodulator.cpp, aerol.cpp's MSK burst path). JAERO demodulates MSK coherently as offset QPSK and then
 * differentially decodes each rail sample against the one before; for MSK that comes to the sign of the frequency
 * in each bit, so here the bits come from an FM discriminator: the carrier from the squared burst (MSK squared has
 * lines at twice the carrier ± half the bit rate), mixed out, low-passed, the discriminator integrated over each bit
 * with a clock pulled to its zero crossings. The unique word 0xE15AE893 (32 bits, either polarity) opens the data;
 * the block is 64 × 5 and then 64 × 3 per further unit (deinterleaveMsk), and decoded as the 10.5k bursts are.
 * Receive only.
 */
import { Decim, lowpass } from './oqpsk.js';
import { fft } from '../../fft.js';
import { SuReader, UW } from './frame.js';
import { decodeRt, RtReader, type RtPacket } from './burst.js';

const UWB = Array.from({ length: 32 }, (_, m) => ((UW >>> (31 - m)) & 1) ? 1 : -1);
const MAX_BITS = 95 * 64 + 600;

export class MskBurstRx {
  onPacket: (p: RtPacket, carrierHz: number, levelDb: number) => void = () => undefined;
  bursts = 0; bad = 0;
  private key = ''; private d1: Decim | null = null; private d2: Decim | null = null;
  private fs2 = 0; private spb = 0;
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;
  private short = 0; private floor = 0; private n = 0; private level = 0;
  private inBurst = false; private quiet = 0; private loud = 0;
  private pre: [number, number][] = []; private bi: number[] = []; private bq: number[] = [];

  constructor(readonly bitRate: 600 | 1200) {}
  reset(): void { this.key = ''; }

  private setup(rate: number, off: number): void {
    const D1 = Math.max(1, Math.round(rate / 125_000)), fs1 = rate / D1;
    const D2 = Math.max(1, Math.round(fs1 / (16 * this.bitRate))); this.fs2 = fs1 / D2; this.spb = this.fs2 / this.bitRate;
    this.d1 = new Decim(lowpass(Math.min(0.45, 0.42 * fs1 / rate), D1 === 1 ? 1 : (8 * D1 + 1) | 1), D1);
    this.d2 = new Decim(lowpass(Math.min(0.45, 0.45 * this.fs2 / fs1), D2 === 1 ? 1 : (10 * D2 + 1) | 1), D2);
    this.cr = 1; this.ci = 0; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    this.short = 0; this.floor = 0; this.n = 0; this.inBurst = false; this.pre = []; this.bi = []; this.bq = [];
  }

  onIq(iq: Int8Array, rate: number, offsetHz = 0): void {
    const key = `${rate}|${offsetHz}`;
    if (key !== this.key) { this.key = key; this.setup(rate, offsetHz); }
    const n = iq.length >> 1, xi = new Float32Array(n), xq = new Float32Array(n);
    let cr = this.cr, ci = this.ci;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1];
      xi[k] = a * cr - b * ci; xq[k] = a * ci + b * cr;
      const t = cr * this.cdr - ci * this.cdi; ci = cr * this.cdi + ci * this.cdr; cr = t;
    }
    const g = 1.5 - (cr * cr + ci * ci) / 2; this.cr = cr * g; this.ci = ci * g;
    const o1i = new Float32Array(n), o1q = new Float32Array(n), m1 = this.d1!.run(xi, xq, n, o1i, o1q);
    const o2i = new Float32Array(m1), o2q = new Float32Array(m1), m2 = this.d2!.run(o1i, o1q, m1, o2i, o2q);
    this.detect(o2i, o2q, m2);
  }

  /** As the 10.5k bursts: a power rise held for a few bits starts one, falling well under its own level ends it. */
  private detect(xi: Float32Array, xq: Float32Array, n: number): void {
    const spb = this.spb, a = 1 / spb, maxLen = Math.round(MAX_BITS * spb), preLen = Math.round(8 * spb);
    for (let k = 0; k < n; k++) {
      const p = xi[k] * xi[k] + xq[k] * xq[k];
      this.short += a * (p - this.short); this.n++;
      // the floor starts as the mean power of the first stretch (the short average still ramps up from 0 there)
      if (this.n < 32 * spb) { this.floor += (p - this.floor) / this.n; continue; }
      if (!this.inBurst) {
        this.floor += (this.short < this.floor ? 0.01 : 0.0005) * (this.short - this.floor);
        this.pre.push([xi[k], xq[k]]); if (this.pre.length > preLen) this.pre.shift();
        if (this.short > 2.5 * this.floor) { if (++this.loud >= 6 * spb) { this.inBurst = true; this.quiet = 0; this.level = this.short; this.bi = this.pre.map(x => x[0]); this.bq = this.pre.map(x => x[1]); } }
        else this.loud = 0;
      } else {
        this.bi.push(xi[k]); this.bq.push(xq[k]);
        if (this.bi.length < 60 * spb) this.level = Math.max(this.level, this.short);
        this.quiet = this.short < Math.max(1.6 * this.floor, 0.3 * this.level) ? this.quiet + 1 : 0;
        if (this.quiet > 10 * spb || this.bi.length >= maxLen) { this.inBurst = false; this.loud = 0; this.pre = []; this.burst(Float32Array.from(this.bi), Float32Array.from(this.bq)); this.bi = []; this.bq = []; }
      }
    }
  }

  /** The carrier from the squared burst: the pair of lines half the bit rate either side of twice the carrier. */
  private carrier(xi: Float32Array, xq: Float32Array, n: number): number {
    // past the opening (carrier and timing tone, whose own lines would pair with anything), the data's two lines
    const N = 16384, s0 = Math.min(Math.round(300 * this.spb), Math.max(0, n - N)), len = Math.min(n - s0, N), re = new Float32Array(N), im = new Float32Array(N), fs = this.fs2;
    for (let i = 0; i < len; i++) { const a = xi[s0 + i], b = xq[s0 + i], w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len); re[i] = (a * a - b * b) * w; im[i] = 2 * a * b * w; }
    fft(re, im);
    const hz = fs / N, half = this.bitRate / 2 / hz, lim = Math.floor(0.4 * fs / hz);
    const P = (b: number) => { const k = ((Math.round(b) % N) + N) % N; return re[k] * re[k] + im[k] * im[k]; };
    let best = 0, bv = -1;
    for (let c = -lim; c <= lim; c++) { const v = Math.min(P(c - half), P(c + half)); if (v > bv) { bv = v; best = c; } }   // both lines, not one strong one
    // refine each line by parabola and take their mean
    const ref = (b: number) => { const y0 = Math.log(P(b - 1) + 1e-9), y1 = Math.log(P(b) + 1e-9), y2 = Math.log(P(b + 1) + 1e-9), d = y0 - 2 * y1 + y2; return b + (d ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / (2 * d))) : 0); };
    return (ref(Math.round(best - half)) + ref(Math.round(best + half))) / 2 * hz / 2;
  }

  private burst(xi: Float32Array, xq: Float32Array): void {
    this.bursts++;
    const n = xi.length, fs = this.fs2, spb = this.spb;
    if (n < 200 * spb) { this.bad++; return; }
    const fHz = this.carrier(xi, xq, n);
    let pw = 0; for (let i = 0; i < n; i++) pw += xi[i] * xi[i] + xq[i] * xq[i];
    const levelDb = 10 * Math.log10(pw / n / 16384 + 1e-12);
    // mix the carrier out, low-pass to the MSK main lobe, discriminator
    const w = -2 * Math.PI * fHz / fs, h = lowpass(Math.min(0.45, 0.9 * this.bitRate / fs), (Math.round(4 * spb) * 2 + 1)), T = h.length, H = (T - 1) >> 1;
    const ri = new Float32Array(n), rq = new Float32Array(n);
    for (let i = 0; i < n; i++) { const c = Math.cos(w * i), s = Math.sin(w * i); ri[i] = xi[i] * c - xq[i] * s; rq[i] = xi[i] * s + xq[i] * c; }
    const disc = new Float32Array(n); let pi = 0, pq = 0;
    for (let i = 0; i < n; i++) {
      let a = 0, b = 0; for (let t = 0; t < T; t++) { const j = i + t - H; if (j >= 0 && j < n) { a += h[t] * ri[j]; b += h[t] * rq[j]; } }
      disc[i] = Math.atan2(b * pi - a * pq, a * pi + b * pq); pi = a; pq = b;
    }
    // integrate and dump, the clock pulled toward the zero crossings
    const soft: number[] = []; let ph = 0, acc = 0, last = disc[0] > 0;
    for (let i = 0; i < n; i++) {
      const x = disc[i], pos = x > 0;
      if (pos !== last) { const err = ph < 0.5 ? ph : ph - 1; ph -= err * 0.1; }
      last = pos; acc += x; ph += 1 / spb;
      if (ph >= 1) { ph -= 1; soft.push(acc); acc = 0; }
    }
    // the UW (one stream, either polarity) within the burst's opening
    let bestE = -1, bs = 0, sign = 1;
    for (let e = 31; e < Math.min(soft.length, 1800); e++) {
      let c = 0, a = 0; for (let m = 0; m < 32; m++) { const x = soft[e - 31 + m]; c += UWB[m] * x; a += Math.abs(x); }
      const sc = a ? Math.abs(c) / a : 0;
      if (sc > bs) { bs = sc; bestE = e; sign = c < 0 ? -1 : 1; }
    }
    if (bs < 0.7) { this.bad++; return; }
    const coded = new Float32Array(soft.length - bestE - 1);
    let am = 0; for (let i = 0; i < coded.length; i++) am += Math.abs(soft[bestE + 1 + i]);
    const gn = coded.length / (am || 1);
    for (let i = 0; i < coded.length; i++) coded[i] = soft[bestE + 1 + i] * sign * gn;
    const p = decodeRt(coded, coded.length, true);
    if (!p) { this.bad++; return; }
    this.onPacket(p, fHz, levelDb);
  }
}

/** The R/T bursts beside upstream's 600/1200 P-channel decoder: receiver, R/T reader and the unit reader together. */
export class AeroMskBursts {
  readonly rx: MskBurstRx; readonly su = new SuReader(); readonly rt = new RtReader(this.su);
  constructor(bitRate: 600 | 1200) { this.rx = new MskBurstRx(bitRate); this.rx.onPacket = p => this.rt.packet(p); }
  set hz(v: number) { this.su.hz = v; }
  set onAcars(f: ((line: string, aes: number) => void) | null) { this.su.onAcars = f; }
  get bursts(): number { return this.rx.bursts; }
  reset(): void { this.rx.reset(); this.su.reset(); }
  onIq(iq: Int8Array, rate: number, offsetHz = 0): void { this.rx.onIq(iq, rate, offsetHz); }
}
