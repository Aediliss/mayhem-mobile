/**
 * FORK: Inmarsat Aero 10.5 kbps R and T channels: the bursts aircraft send to the ground station, after JAERO by
 * Jonathan Olds (MIT: burstoqpskdemodulator.cpp, aerol.cpp/.h RTChannelDeleaveFECScram, RISUData). A burst opens with
 * 128 symbols of unmodulated carrier and 128 of a symbol-timing tone, then the unique word 0xE15AE893 on both rails
 * (as on the P channel) and a block of 64 rows: 5 columns for an R packet (19 bytes: a 17-byte signal unit and its
 * CRC), 5 + 3k for a T packet (a 6-byte header — AES ID, GES ID, CRC — and k + 1 signal units of 12 bytes). The block
 * is de-interleaved as the P channel's (rows by 27·i mod 64), Viterbi-decoded from state 0, descrambled with the same
 * 15-bit sequence, and checked; the length is found by trying each column count until every CRC checks.
 * R packets with user data are short ISUs (up to three units of 11 bytes, put back together by sequence indicator);
 * T packets carry the same 0x71 / 0xC0 units as the P channel. ACARS in them is read as downlinks ("SAT … ↓ …").
 * Receive only.
 */
import { Decim, lowpass, rrc, SYMBOL_RATE } from './oqpsk.js';
import { fft } from '../../fft.js';
import { SCRAMBLE, SuReader, UW, deinterleaveCols, packLsb, suCrc, viterbi } from './frame.js';

const ROWS = 64, MAX_COLS = 95;
const UWS = Array.from({ length: 32 }, (_, m) => ((UW >>> (31 - m)) & 1) ? 1 : -1);

export interface RtStats { bursts: number; rPackets: number; tPackets: number; bad: number; messages: number }
export type RtPacket = { kind: 'R'; bytes: Uint8Array } | { kind: 'T'; aes: number; ges: number; units: number[][] };

/**
 * Try to read a burst's coded bits (soft, rails' polarity already undone, first bit right after the UW).
 * null when no column count makes every CRC check.
 */
export function decodeRt(coded: Float32Array, n = coded.length, msk = false): RtPacket | null {
  // 10.5k: the block is interleaved whole, so only its true length checks. MSK: each further 3 columns are a block of
  // their own, so every length up to the true one checks too: keep the longest before the CRCs fail
  let best: RtPacket | null = null;
  for (let cols = 5; cols <= MAX_COLS && cols * ROWS <= n; cols += 3) {
    const nb = cols * ROWS, de = new Float32Array(nb);
    if (msk) deinterleaveMsk(coded, cols, de); else deinterleaveCols(coded, cols, de);
    const { bits } = viterbi(de, nb / 2, true);
    const data = new Uint8Array(bits.length);
    for (let i = 0; i < bits.length; i++) data[i] = bits[i] ^ SCRAMBLE[i];
    const by = packLsb(data);
    if (cols === 5 && suCrc(by, 0, 17) === (by[17] | (by[18] << 8))) return { kind: 'R', bytes: by.slice(0, 19) };
    if (suCrc(by, 0, 4) !== (by[4] | (by[5] << 8))) { if (best) return best; continue; }
    const k = 1 + (cols - 5) / 3, units: number[][] = [];
    let ok = true;
    for (let u = 0; u < k && ok; u++) {
      const at = 6 + 12 * u;
      if (suCrc(by, at, 10) !== (by[at + 10] | (by[at + 11] << 8))) ok = false;
      else units.push(Array.from(by.subarray(at, at + 10)));
    }
    const t: RtPacket = { kind: 'T', aes: (by[0] << 16) | (by[1] << 8) | by[2], ges: by[3], units };
    if (ok && !msk) return t;
    if (ok) best = t; else if (best) return best;
  }
  return best;
}

const DEP = Array.from({ length: ROWS }, (_, i) => (i * 27) % ROWS);
/** The 600/1200 bps bursts' layout (JAERO deinterleaveMSK): a 64 × 5 block, then a 64 × 3 block per further unit. */
export function deinterleaveMsk(block: ArrayLike<number>, cols: number, out: Float32Array): void {
  let k = 0;
  for (let j = 0; j < 5; j++) for (let i = 0; i < ROWS; i++) out[k++] = block[DEP[i] * 5 + j];
  for (let base = 5; base < cols; base += 3) for (let j = 0; j < 3; j++) for (let i = 0; i < ROWS; i++) out[k++] = block[ROWS * base + DEP[i] * 3 + j];
}
/** Transmitter side (tests): a burst's bits after the UW: data bytes scrambled, coded from zero, interleaved. */
export function buildRt(bytes: number[], cols: number, msk = false): Uint8Array {
  const nb = cols * ROWS, nd = nb / 2, bits = new Uint8Array(nd);
  for (let i = 0; i < nd; i++) bits[i] = (((bytes[i >> 3] ?? 0) >> (i & 7)) & 1) ^ SCRAMBLE[i];
  let reg = 0; const coded = new Uint8Array(nb);
  const par = (x: number) => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
  for (let i = 0; i < nd; i++) { reg = ((reg << 1) | bits[i]) & 127; coded[2 * i] = par(reg & 109); coded[2 * i + 1] = par(reg & 79); }
  const out = new Uint8Array(nb);
  const dep = Array.from({ length: ROWS }, (_, i) => (i * 27) % ROWS);
  let k = 0;
  if (!msk) for (let j = 0; j < cols; j++) for (let i = 0; i < ROWS; i++) out[dep[i] * cols + j] = coded[k++];
  else {
    for (let j = 0; j < 5; j++) for (let i = 0; i < ROWS; i++) out[dep[i] * 5 + j] = coded[k++];
    for (let base = 5; base < cols; base += 3) for (let j = 0; j < 3; j++) for (let i = 0; i < ROWS; i++) out[ROWS * base + dep[i] * 3 + j] = coded[k++];
  }
  return out;
}
/** Transmitter side (tests): an R packet (17 bytes + CRC) and a T packet (header + units) as bytes. */
export function rPacket(seventeen: number[]): number[] { const u = seventeen.slice(0, 17); while (u.length < 17) u.push(0); const c = suCrc(u, 0, 17); return [...u, c & 255, c >> 8]; }
export function tPacket(aes: number, ges: number, units: number[][]): number[] {
  const h = [aes >> 16, (aes >> 8) & 255, aes & 255, ges], c = suCrc(h, 0, 4);
  return [...h, c & 255, c >> 8, ...units.flat()];
}

interface RIsu { aes: number; ges: number; q: number; ref: number; total: number; filled: number; data: number[]; age: number }

/** R/T packets in: R-channel ISUs put together, T-channel units through the P channel's reader, ACARS out. */
export class RtReader {
  readonly stats: RtStats = { bursts: 0, rPackets: 0, tPackets: 0, bad: 0, messages: 0 };
  private risus: RIsu[] = [];
  constructor(readonly su: SuReader) {}
  packet(p: RtPacket): void {
    if (p.kind === 'T') { this.stats.tPackets++; for (const u of p.units) this.su.unit(u, true); return; }
    this.stats.rPackets++;
    const b = p.bytes;
    if (!(b[1] & 0x08)) return;   // a signalling unit (log-on, access request, acknowledgement): counted, not read
    const seq = b[0] >> 4, type = b[0] & 15, total = [0, 1, 2, 2, 3, 3, 3][seq] ?? 0, index = [0, 0, 0, 1, 0, 1, 2][seq] ?? 0;
    if (!total || type < 1 || type > 11) return;
    const key = { aes: (b[2] << 16) | (b[3] << 8) | b[4], ges: b[5], q: b[1] >> 4, ref: b[1] & 7 };
    for (const x of this.risus) x.age++;
    this.risus = this.risus.filter(x => x.age <= 10);
    let it = this.risus.find(x => x.aes === key.aes && x.ges === key.ges && x.q === key.q && x.ref === key.ref);
    if (!it) { it = { ...key, total, filled: 0, data: [], age: 0 }; this.risus.push(it); }
    it.age = 0;
    const len = 11 * total - 11 + (index === total - 1 ? type : 11);
    if (it.data.length < len) it.data.length = len;
    for (let i = 0; i < type; i++) it.data[11 * index + i] = b[6 + i];
    if (index === total - 1) it.data.length = 11 * (total - 1) + type;
    it.filled |= 1 << index;
    if (it.filled !== (1 << total) - 1) return;
    this.risus = this.risus.filter(x => x !== it);
    const before = this.su.stats.messages;
    this.su.acars({ aes: it.aes, data: Array.from(it.data, v => v ?? 0) }, true);
    if (this.su.stats.messages > before) this.stats.messages++;
  }
}

/**
 * Bursts on one channel: found by their power, the carrier from the burst's unmodulated start, then the matched filter,
 * a Gardner clock and a Costas loop over the rest, the UW, and decodeRt.
 */
export class BurstRx {
  onPacket: (p: RtPacket, carrierHz: number, levelDb: number) => void = () => undefined;
  bursts = 0; bad = 0;
  private key = ''; private d1: Decim | null = null; private d2: Decim | null = null;
  private fs2 = 0; private sps = 0; private mf = new Float32Array(1);
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;
  private short = 0; private floor = 0; private n = 0;
  private inBurst = false; private quiet = 0; private loud = 0; private level = 0;
  private pre: [number, number][] = []; private bi: number[] = []; private bq: number[] = [];

  private setup(rate: number, off: number): void {
    const D1 = Math.max(1, Math.round(rate / 125_000)), fs1 = rate / D1;
    const D2 = Math.max(1, Math.round(fs1 / (8 * SYMBOL_RATE)));
    this.fs2 = fs1 / D2; this.sps = this.fs2 / SYMBOL_RATE;
    this.d1 = new Decim(lowpass(Math.min(0.45, 0.42 * fs1 / rate), D1 === 1 ? 1 : (8 * D1 + 1) | 1), D1);
    this.d2 = new Decim(lowpass(Math.min(0.45, 11_500 / fs1), D2 === 1 ? 1 : (10 * D2 + 1) | 1), D2);
    this.mf = rrc(this.sps);
    this.cr = 1; this.ci = 0; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    this.short = 0; this.floor = 0; this.n = 0; this.inBurst = false; this.pre = []; this.bi = []; this.bq = [];
  }
  reset(): void { this.key = ''; }

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

  /** Power: a one-symbol average against a slow floor; a burst is kept from a few symbols before it rose. */
  private detect(xi: Float32Array, xq: Float32Array, n: number): void {
    const sps = this.sps, a = 1 / sps, maxLen = Math.round((256 + 80 + MAX_COLS * 32 + 64) * sps), preLen = Math.round(16 * sps);
    for (let k = 0; k < n; k++) {
      const p = xi[k] * xi[k] + xq[k] * xq[k];
      this.short += a * (p - this.short); this.n++;
      // the floor starts as the mean power of the first stretch (the short average still ramps up from 0 there)
      if (this.n < 32 * sps) { this.floor += (p - this.floor) / this.n; continue; }
      if (!this.inBurst) {
        this.floor += (this.short < this.floor ? 0.01 : 0.0005) * (this.short - this.floor);
        this.pre.push([xi[k], xq[k]]); if (this.pre.length > preLen) this.pre.shift();
        if (this.short > 2.5 * this.floor) { if (++this.loud >= 12 * sps) { this.inBurst = true; this.quiet = 0; this.level = this.short; this.bi = this.pre.map(x => x[0]); this.bq = this.pre.map(x => x[1]); } }
        else this.loud = 0;
      } else {
        this.bi.push(xi[k]); this.bq.push(xq[k]);
        // the end: well under the burst's own level (or back near the floor)
        if (this.bi.length < 60 * sps) this.level = Math.max(this.level, this.short);
        this.quiet = this.short < Math.max(1.6 * this.floor, 0.3 * this.level) ? this.quiet + 1 : 0;
        if (this.quiet > 20 * sps || this.bi.length >= maxLen) { this.inBurst = false; this.loud = 0; this.pre = []; this.burst(Float32Array.from(this.bi), Float32Array.from(this.bq)); this.bi = []; this.bq = []; }
      }
    }
  }

  private burst(xi: Float32Array, xq: Float32Array): void {
    this.bursts++;
    const fs = this.fs2, sps = this.sps, n = xi.length;
    // the carrier: the strongest line in the unmodulated opening (symbols 24..120 after the rise)
    const s0 = Math.round(40 * sps), len = Math.min(Math.round(90 * sps), n - s0), N = 8192;
    if (len < 32 * sps) { this.bad++; return; }
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < len; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len); re[i] = xi[s0 + i] * w; im[i] = xq[s0 + i] * w; }
    fft(re, im);
    const lim = Math.floor(6000 / fs * N), mag = (b: number) => { const k = (b + N) % N; return re[k] * re[k] + im[k] * im[k]; };
    let best = 0; for (let b = -lim; b <= lim; b++) if (mag(b) > mag(best)) best = b;
    const y0 = Math.log(mag(best - 1) + 1e-9), y1 = Math.log(mag(best) + 1e-9), y2 = Math.log(mag(best + 1) + 1e-9);
    const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1), fHz = (best + (Number.isFinite(frac) ? Math.max(-0.5, Math.min(0.5, frac)) : 0)) * fs / N;
    let pw = 0; for (let i = 0; i < len; i++) pw += xi[s0 + i] ** 2 + xq[s0 + i] ** 2;
    const levelDb = 10 * Math.log10(pw / len / 16384 + 1e-12);
    // derotate, matched filter, then the loops (as the P channel's receiver)
    const w = -2 * Math.PI * fHz / fs, h = this.mf, T = h.length, H = (T - 1) >> 1;
    const ri = new Float32Array(n), rq = new Float32Array(n);
    for (let i = 0; i < n; i++) { const c = Math.cos(w * i), s = Math.sin(w * i); ri[i] = xi[i] * c - xq[i] * s; rq[i] = xi[i] * s + xq[i] * c; }
    const fi = new Float32Array(n), fq = new Float32Array(n);
    for (let i = 0; i < n; i++) { let a = 0, b = 0; for (let t = 0; t < T; t++) { const j = i + t - H; if (j >= 0 && j < n) { a += h[t] * ri[j]; b += h[t] * rq[j]; } } fi[i] = a; fq[i] = b; }
    const soft = this.track(fi, fq, n);
    // the UW: each rail with its own polarity, within the first ~900 bits
    let bestE = -1, bs = 0, sa = 1, sb = 1;
    for (let e = 63; e < Math.min(soft.length, 1100); e++) {
      let ca = 0, cb = 0, aa = 0;
      for (let m = 0; m < 32; m++) { const x = soft[e - 63 + 2 * m], y = soft[e - 62 + 2 * m]; ca += UWS[m] * x; cb += UWS[m] * y; aa += Math.abs(x) + Math.abs(y); }
      const sc = aa ? (Math.abs(ca) + Math.abs(cb)) / aa : 0;
      if (sc > bs) { bs = sc; bestE = e; sa = ca < 0 ? -1 : 1; sb = cb < 0 ? -1 : 1; }
    }
    if (bs < 0.7) { this.bad++; return; }
    const start = bestE + 1, aPar = (bestE - 63) & 1, coded = new Float32Array(soft.length - start);
    let am = 0; for (let i = 0; i < coded.length; i++) am += Math.abs(soft[start + i]);
    const gn = coded.length / (am || 1);
    for (let i = 0; i < coded.length; i++) { const rail = ((start + i) & 1) === aPar ? sa : sb; coded[i] = soft[start + i] * rail * gn; }
    const p = decodeRt(coded);
    if (!p) { this.bad++; return; }
    this.onPacket(p, fHz, levelDb);
  }

  /** Gardner and Costas over a burst already brought near 0 Hz: one soft bit a half-symbol strobe. */
  private track(fi: Float32Array, fq: Float32Array, n: number): Float32Array {
    const sps = this.sps, half = sps / 2, out: number[] = [];
    let ph = 0, fr = 0, tau = Math.round(H0 * sps), strobe = 0, amp = 0;
    const r: [number, number][] = [[0, 0], [0, 0], [0, 0]];
    const lw = 2 * Math.PI * 100 / (SYMBOL_RATE * 2), damp = 0.707;
    const ka = 4 * damp * lw / (1 + 2 * damp * lw + lw * lw), kb = 4 * lw * lw / (1 + 2 * damp * lw + lw * lw);
    for (let k = 0; k < Math.round(20 * sps) && k < n; k++) amp += Math.hypot(fi[k], fq[k]);
    amp /= Math.round(20 * sps) || 1;
    for (let t = tau; t < n - 1;) {
      const i0 = Math.floor(t), f = t - i0;
      let a = fi[i0] + f * (fi[i0 + 1] - fi[i0]), b = fq[i0] + f * (fq[i0 + 1] - fq[i0]);
      const c = Math.cos(ph), s = Math.sin(ph), ri = a * c + b * s, rq = b * c - a * s; a = ri; b = rq;
      r.shift(); r.push([ri, rq]);
      const isI = (strobe & 1) === 0, [r0, r1, r2] = r, A = amp || 1;
      const eT = isI ? r1[0] * (r0[0] - r2[0]) : r1[1] * (r0[1] - r2[1]);
      const sym = isI ? ri : rq;
      amp += 0.01 * (Math.abs(sym) - amp);
      const eP = isI ? Math.sign(ri) * rq / A : -Math.sign(rq) * ri / A;
      ph += ka * eP * 0.5 + fr; fr += kb * eP * 0.5;
      t += half + Math.max(-0.5, Math.min(0.5, 0.15 * eT / (A * A))) * 0.05 * sps;
      out.push(sym / A); strobe++;
    }
    return Float32Array.from(out);
  }
}
const H0 = 2;
