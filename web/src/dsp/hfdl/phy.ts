/**
 * FORK: HFDL (HF Data Link, ARINC 635 / ICAO Annex 10), the physical layer, receive only. Ported from dumphfdl
 * (Tomasz Lemiech, GPL-3.0-or-later, src/hfdl.c); the conventions it inherits from liquid-dsp (bit order of the
 * sequences, the PSK constellations, the scrambler register) were checked against liquid-dsp 1.6 itself.
 *
 * A burst at 1800 symbols a second on a carrier 1440 Hz above the dial (upper sideband): a 448-symbol prekey (a plain
 * tone), the 127-bit sequence A twice, M1 (A's partner sequence rotated by one of eight amounts, which names the data
 * rate and slot length), the first 15 bits of that rotation (M2), nine 15-symbol training blocks T, then 72 (single
 * slot) or 168 (double slot) segments of 30 data symbols and one T. Data is BPSK, 4-PSK or 8-PSK, each symbol's sign
 * flipped by a 15-stage scrambler (x^15 + x + 1, 120 bits then over again), interleaved in a 40-row table, then a
 * rate-1/2 K=7 convolutional code (0x6D, 0x4F), each code bit sent twice at 300 bps. Bytes go least significant bit
 * first. The receiver here works on blocks: the prekey's tone gives the frequency error, A twice the timing and the
 * phase, then a fractionally spaced LMS equaliser trained on every T block. No DOM.
 */
import { Viterbi, convEncode } from '../sonde/viterbi.js';
import { rrcTaps } from '../hamid/symbols.js';
import { ComplexFirDecimator } from '../ham/filters.js';

export const HFDL_BAUD = 1800;
export const HFDL_SPS = 4;
export const HFDL_FS = HFDL_BAUD * HFDL_SPS;
/** The carrier sits this far above the published (dial) frequency. */
export const HFDL_CARRIER_HZ = 1440;
const PREKEY = 448, A_LEN = 127, M2_LEN = 15, T_LEN = 15, SEG = 30;

const A_OCTETS = [0x5B, 0xBC, 0x74, 0x57, 0x03, 0xD9, 0x89, 0x39, 0xF2, 0x08, 0xD5, 0x36, 0x94, 0x2C, 0x32, 0xFE];
/** A, oldest bit first (each octet most significant bit first). */
export const A_BITS = Array.from({ length: A_LEN }, (_, i) => (A_OCTETS[i >> 3] >> (7 - (i & 7))) & 1);
const M1_SRC = [
  0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1,
  0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0,
  1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
const M_SHIFTS = [72, 82, 113, 123, 61, 103, 93, 9];
/** M1 for each of the eight rates, and M2 (its first 15 bits). */
export const M1_BITS = M_SHIFTS.map(s => Array.from({ length: A_LEN }, (_, j) => M1_SRC[(s + j) % A_LEN]));
const T_BITS = Array.from({ length: T_LEN }, (_, i) => (0x9AF >> (T_LEN - 1 - i)) & 1);

export interface HfdlRate { bps: number; arity: 1 | 2 | 3; segs: number; repeat: boolean; shift: number; slot: 'S' | 'D' }
/** Indexed by M1: 300 / 600 / 1200 / 1800 bps, single then double slot. */
export const HFDL_RATES: HfdlRate[] = [300, 600, 1200, 1800, 300, 600, 1200, 1800].map((bps, i) => ({
  bps, arity: (bps <= 600 ? 1 : bps === 1200 ? 2 : 3) as 1 | 2 | 3, segs: i < 4 ? 72 : 168, repeat: bps === 300, shift: i < 4 ? 17 : 23, slot: i < 4 ? 'S' : 'D',
}));
/** Octets one burst carries at a rate (the decoder's whole output, padding included). */
export function hfdlCapacity(rate: number): number { const r = HFDL_RATES[rate]; return Math.ceil(r.segs * SEG * r.arity / (r.repeat ? 4 : 2) / 8); }
/** Symbols in a burst from the first A on. */
export function hfdlBodySymbols(rate: number): number { return 2 * A_LEN + A_LEN + M2_LEN + 9 * T_LEN + HFDL_RATES[rate].segs * (SEG + T_LEN); }

/** The scrambler's 120 bits (liquid's msequence: g = 0x4001, state 0x4D4B, output = parity(state & g) shifted in). */
export const SCRAMBLER = ((): Uint8Array => {
  const out = new Uint8Array(120); let v = 0x4d4b;
  for (let i = 0; i < 120; i++) { let p = v & 0x4001, b = 0; while (p) { b ^= p & 1; p >>= 1; } v = ((v << 1) | b) & 0x7fff; out[i] = b; }
  return out;
})();

/** The order the deinterleaver reads code bits in: read k is the channel bit at popOrder[k]. */
const popOrders = new Map<number, Uint32Array>();
export function popOrder(rate: number): Uint32Array {
  let o = popOrders.get(rate); if (o) return o;
  const r = HFDL_RATES[rate], n = r.segs * SEG * r.arity, cols = n / 40, table = new Uint32Array(n);
  let row = 0, col = 0;
  for (let i = 0; i < n; i++) {
    table[row * cols + col] = i;
    if (++row === 40) { row = 0; col++; }
    col -= r.shift; if (col < 0) col += cols;
  }
  o = new Uint32Array(n); row = 0; col = 0;
  for (let k = 0; k < n; k++) { o[k] = table[row * cols + col]; row = (row + 9) % 40; if (row === 0) col++; }
  popOrders.set(rate, o); return o;
}

const grayDecode = (g: number) => { let n = g; for (let m = g >> 1; m; m >>= 1) n ^= m; return n; };
/** The constellation (liquid's PSK: symbol s at gray_decode(s) * 2π / M; BPSK 0 → +1). */
export function pskPoints(arity: number): Float64Array {
  const M = 1 << arity, p = new Float64Array(2 * M);
  for (let s = 0; s < M; s++) { const a = grayDecode(s) * 2 * Math.PI / M; p[2 * s] = Math.cos(a); p[2 * s + 1] = Math.sin(a); }
  return p;
}
const POINTS = [new Float64Array(0), pskPoints(1), pskPoints(2), pskPoints(3)];

/** The known symbols from the first A to the end (NaN where data goes), and the data's positions. */
function frameTemplate(rate: number): { known: Float32Array; data: Int32Array } {
  const r = HFDL_RATES[rate], n = hfdlBodySymbols(rate), known = new Float32Array(n), data = new Int32Array(r.segs * SEG);
  let k = 0, d = 0;
  const bits = (b: number[]) => { for (const x of b) known[k++] = x ? -1 : 1; };
  bits(A_BITS); bits(A_BITS); bits(M1_BITS[rate]); bits(M1_BITS[rate].slice(0, M2_LEN));
  for (let t = 0; t < 9; t++) bits(T_BITS);
  for (let s = 0; s < r.segs; s++) { for (let i = 0; i < SEG; i++) { data[d++] = k; known[k++] = NaN; } bits(T_BITS); }
  return { known, data };
}

// ------------------------------------------------------------------------------------------------ test transmitter

/** One burst's symbols (interleaved I/Q, prekey included) carrying `bytes` (zero-padded to the rate's capacity). */
export function hfdlBurstSymbols(bytes: ArrayLike<number>, rate: number): Float32Array {
  const r = HFDL_RATES[rate], cap = hfdlCapacity(rate), nUser = r.segs * SEG * r.arity / (r.repeat ? 4 : 2);
  if (bytes.length > cap - 1) throw new Error(`HFDL: ${bytes.length} octets do not fit a ${r.bps} bps burst (${cap - 1})`);
  const user = new Uint8Array(nUser);
  for (let i = 0; i < bytes.length * 8; i++) user[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  const c = new Uint8Array(2 * nUser); convEncode(user, 0, c, 0);
  // HFDL sends the 0x6D bit first; the shared encoder writes 0x4F first
  for (let i = 0; i < nUser; i++) { const t = c[2 * i]; c[2 * i] = c[2 * i + 1]; c[2 * i + 1] = t; }
  const coded = r.repeat ? Uint8Array.from({ length: 2 * c.length }, (_, k) => c[k >> 1]) : c;
  const order = popOrder(rate), chan = new Uint8Array(coded.length);
  for (let k = 0; k < coded.length; k++) chan[order[k]] = coded[k];
  const { known, data } = frameTemplate(rate), out = new Float32Array(2 * (PREKEY + known.length));
  for (let i = 0; i < PREKEY; i++) out[2 * i] = 1;
  for (let k = 0; k < known.length; k++) out[2 * (PREKEY + k)] = known[k];
  const P = POINTS[r.arity];
  for (let i = 0; i < data.length; i++) {
    let s = 0; for (let b = 0; b < r.arity; b++) s = (s << 1) | chan[i * r.arity + b];
    const f = SCRAMBLER[i % 120] ? -1 : 1, at = PREKEY + data[i];
    out[2 * at] = f * P[2 * s]; out[2 * at + 1] = f * P[2 * s + 1];
  }
  return out;
}

/** Symbols shaped at HFDL_FS (root raised cosine), rotated by `cfoHz` and `phase`: what a channel filter hands the receiver. */
export function hfdlShape(sym: Float32Array, o: { cfoHz?: number; phase?: number; lead?: number } = {}): Float32Array {
  const h = rrcTaps(HFDL_SPS, 0.35, 4), half = (h.length - 1) / 2, lead = o.lead ?? 400, n = sym.length / 2;
  const len = lead + n * HFDL_SPS + h.length + 400, out = new Float32Array(2 * len);
  for (let k = 0; k < n; k++) {
    const re = sym[2 * k], im = sym[2 * k + 1]; if (!re && !im) continue;
    const c = lead + k * HFDL_SPS;
    for (let j = 0; j < h.length; j++) { const at = c + j - half, g = h[j] * HFDL_SPS; out[2 * at] += re * g; out[2 * at + 1] += im * g; }
  }
  const w = 2 * Math.PI * (o.cfoHz ?? 0) / HFDL_FS, p0 = o.phase ?? 0;
  for (let i = 0; i < len; i++) { const a = w * i + p0, c = Math.cos(a), s = Math.sin(a), re = out[2 * i], im = out[2 * i + 1]; out[2 * i] = re * c - im * s; out[2 * i + 1] = re * s + im * c; }
  return out;
}

// ------------------------------------------------------------------------------------------------------- receiver

export interface HfdlBurst {
  /** The decoder's octets (the PDU, then padding). */
  bytes: Uint8Array; rate: number; bps: number; slot: 'S' | 'D';
  /** Frequency error (Hz, carrier above where it should be), SNR (dB) over the training blocks, training bits wrong. */
  cfoHz: number; snrDb: number; trainErrors: number; trainBits: number;
  /** Sample (at HFDL_FS, counted from the first sample pushed) where the first A begins. */
  at: number;
}

/** Bursts from complex baseband at HFDL_FS, the carrier at 0 Hz. */
export class HfdlRx {
  onBurst: (b: HfdlBurst) => void = () => undefined;
  /** Prekeys heard, A found, M1 read (diagnostics). */
  tones = 0; preambles = 0; rates = 0;
  private readonly mf: ComplexFirDecimator;
  private buf = new Float32Array(2 * 1 << 16); private base = 0; private len = 0;
  private pos = 0; private st: 'search' | 'pre' = 'search'; private cfo = 0;
  private found: { t0: number; cfo: number; rot: [number, number]; rate: number } | null = null;
  private tmp = new Float32Array(0);
  private readonly vit = new Viterbi(3240 * 168 / 72);
  constructor() { this.mf = new ComplexFirDecimator(Float32Array.from(rrcTaps(HFDL_SPS, 0.35, 4)), 1); }

  push(x: Float32Array, n = x.length >> 1): void {
    if (this.tmp.length < 2 * n) this.tmp = new Float32Array(2 * n);
    const c = this.mf.process(x, n, this.tmp);
    if (2 * (this.len + c) > this.buf.length) {
      // drop what lies behind the search point, then grow if a burst still needs more room
      const keep = Math.max(0, Math.min(this.len, this.base + this.len - (this.pos - 64)));
      this.buf.copyWithin(0, 2 * (this.len - keep), 2 * this.len); this.base += this.len - keep; this.len = keep;
      if (2 * (this.len + c) > this.buf.length) { const nb = new Float32Array(Math.max(this.buf.length * 2, 2 * (this.len + c))); nb.set(this.buf.subarray(0, 2 * this.len)); this.buf = nb; }
    }
    this.buf.set(this.tmp.subarray(0, 2 * c), 2 * this.len); this.len += c;
    this.run();
  }

  private get end(): number { return this.base + this.len; }
  private at(i: number): number { return 2 * (i - this.base); }

  private run(): void {
    for (;;) {
      if (this.st === 'search') {
        if (this.pos < this.base) this.pos = this.base;
        if (this.end < this.pos + 1024) return;
        const f = this.tone(this.pos);
        if (f === null) { this.pos += 256; continue; }
        this.tones++; this.cfo = f; this.st = 'pre';
      }
      // the first A starts within 2300 samples of a window that is mostly prekey; found once, then the body awaited
      if (!this.found) {
        if (this.end < this.pos + 2400 + 400 * HFDL_SPS) return;
        this.found = this.preamble(this.pos, this.cfo);
        if (!this.found) { this.pos += 1024; this.st = 'search'; continue; }
      }
      const r = this.found, total = hfdlBodySymbols(r.rate) * HFDL_SPS;
      if (this.end < r.t0 + total + 16 * HFDL_SPS) return;
      this.found = null; this.body(r);
      this.pos = Math.floor(r.t0 + total); this.st = 'search';
    }
  }

  /** A tone filling most of the 1024 samples from i: its frequency, or null. */
  private tone(i: number): number | null {
    const b = this.buf, o = this.at(i);
    let r0 = 0, r1r = 0, r1i = 0, r16r = 0, r16i = 0;
    for (let k = 0; k < 1024; k++) {
      const p = o + 2 * k, xr = b[p], xi = b[p + 1]; r0 += xr * xr + xi * xi;
      if (k >= 1) { const yr = b[p - 2], yi = b[p - 1]; r1r += xr * yr + xi * yi; r1i += xi * yr - xr * yi; }
      if (k >= 16) { const yr = b[p - 32], yi = b[p - 31]; r16r += xr * yr + xi * yi; r16i += xi * yr - xr * yi; }
    }
    if (Math.hypot(r16r, r16i) < 0.6 * r0 || r0 < 1e-12) return null;
    const f16 = Math.atan2(r16i, r16r) / (2 * Math.PI * 16) * HFDL_FS, f1 = Math.atan2(r1i, r1r) / (2 * Math.PI) * HFDL_FS;
    const f = f16 + 450 * Math.round((f1 - f16) / 450);
    return Math.abs(f) < 700 ? f : null;
  }

  /** Sample i (fractional) of the filtered stream, turned back by the frequency error. */
  private sample(t: number, cfo: number, out: Float64Array, o: number): void {
    const b = this.buf, i = Math.floor(t), u = t - i, p = this.at(i);
    // cubic (Catmull-Rom) between i and i+1
    const w0 = ((-0.5 * u + 1) * u - 0.5) * u, w1 = (1.5 * u - 2.5) * u * u + 1, w2 = ((-1.5 * u + 2) * u + 0.5) * u, w3 = (0.5 * u - 0.5) * u * u;
    const re = w0 * b[p - 2] + w1 * b[p] + w2 * b[p + 2] + w3 * b[p + 4], im = w0 * b[p - 1] + w1 * b[p + 1] + w2 * b[p + 3] + w3 * b[p + 5];
    const a = -2 * Math.PI * cfo * t / HFDL_FS, c = Math.cos(a), s = Math.sin(a);
    out[o] = re * c - im * s; out[o + 1] = re * s + im * c;
  }

  private preamble(from: number, cfo0: number): { t0: number; cfo: number; rot: [number, number]; rate: number } | null {
    const b = this.buf, n = 2400 + 254 * HFDL_SPS + 8, z = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      const p = this.at(from + k), a = -2 * Math.PI * cfo0 * (from + k) / HFDL_FS, c = Math.cos(a), s = Math.sin(a);
      z[2 * k] = b[p] * c - b[p + 1] * s; z[2 * k + 1] = b[p] * s + b[p + 1] * c;
    }
    const corr = (t: number, off: number): [number, number, number] => {
      let cr = 0, ci = 0, e = 0;
      for (let j = 0; j < A_LEN; j++) { const p = 2 * (t + off + HFDL_SPS * j), g = A_BITS[j] ? -1 : 1; cr += g * z[p]; ci += g * z[p + 1]; e += z[p] * z[p] + z[p + 1] * z[p + 1]; }
      return [cr, ci, e];
    };
    const metric = new Float64Array(2400), at = (t: number): number => {
      if (metric[t]) return metric[t];
      const [ar, ai, ae] = corr(t, 0), [br, bi, be] = corr(t, A_LEN * HFDL_SPS);
      return (metric[t] = (Math.hypot(ar, ai) / Math.sqrt(A_LEN * ae + 1e-30) + Math.hypot(br, bi) / Math.sqrt(A_LEN * be + 1e-30)) / 2 + 1e-12);
    };
    // every other sample (the correlation peak is four samples wide at four samples a symbol), then the best's neighbours
    let best = -1, bv = 0;
    for (let t = 16; t < 2400; t += 2) { const m = at(t); if (m > bv) { bv = m; best = t; } }
    for (const t of [best - 1, best + 1]) if (t >= 0 && t < 2400) { const m = at(t); if (m > bv) { bv = m; best = t; } }
    if (best > 0) at(best - 1); if (best < 2399) at(best + 1);
    if (bv < 0.4) return null;
    this.preambles++;
    const m0 = metric[best - 1] || bv, m2 = metric[best + 1] || bv, den = m0 - 2 * bv + m2;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (m0 - m2) / den)) : 0;
    const [ar, ai] = corr(best, 0), [br, bi] = corr(best, A_LEN * HFDL_SPS);
    // the phase turned between the two A's: what the prekey's estimate left over
    const dphi = Math.atan2(bi * ar - br * ai, br * ar + bi * ai), cfo = cfo0 + dphi / (2 * Math.PI * A_LEN / HFDL_BAUD);
    const t0 = from + best + frac;
    // phase and gain over both A's at the refined frequency, then M1
    const v = new Float64Array(2); let cr = 0, ci = 0;
    for (let j = 0; j < 2 * A_LEN; j++) { this.sample(t0 + HFDL_SPS * j, cfo, v, 0); const g = A_BITS[j % A_LEN] ? -1 : 1; cr += g * v[0]; ci += g * v[1]; }
    const mag = Math.hypot(cr, ci) / (2 * A_LEN); if (!(mag > 0)) return null;
    const rot: [number, number] = [cr / (2 * A_LEN * mag * mag), -ci / (2 * A_LEN * mag * mag)];
    const m1 = new Float64Array(A_LEN);
    for (let j = 0; j < A_LEN; j++) { this.sample(t0 + HFDL_SPS * (2 * A_LEN + j), cfo, v, 0); m1[j] = v[0] * rot[0] - v[1] * rot[1]; }
    let rate = -1, rv = 0;
    for (let k = 0; k < 8; k++) { let c = 0; for (let j = 0; j < A_LEN; j++) c += M1_BITS[k][j] ? -m1[j] : m1[j]; c /= A_LEN; if (c > rv) { rv = c; rate = k; } }
    if (rv < 0.4) return null;
    this.rates++;
    return { t0, cfo, rot, rate };
  }

  private body(p: { t0: number; cfo: number; rot: [number, number]; rate: number }): void {
    const r = HFDL_RATES[p.rate], { known, data } = frameTemplate(p.rate), P = POINTS[r.arity], M = 1 << r.arity;
    const L = 5, NT = 2 * L + 1, w = new Float64Array(2 * NT); w[2 * L] = p.rot[0]; w[2 * L + 1] = p.rot[1];
    const x = new Float64Array(2 * NT), ys = new Float64Array(2 * data.length);
    let th = 0, fr = 0, errE = 0, errN = 0, tErr = 0, tBits = 0, di = 0;
    for (let k = 0; k < known.length; k++) {
      const t = p.t0 + HFDL_SPS * k;
      for (let m = 0; m < NT; m++) this.sample(t + (m - L) * (HFDL_SPS / 2), p.cfo, x, 2 * m);
      let ur = 0, ui = 0;
      for (let m = 0; m < NT; m++) { ur += w[2 * m] * x[2 * m] - w[2 * m + 1] * x[2 * m + 1]; ui += w[2 * m] * x[2 * m + 1] + w[2 * m + 1] * x[2 * m]; }
      const c = Math.cos(th), s = Math.sin(th), zr = ur * c + ui * s, zi = ui * c - ur * s;
      let dr: number, dI: number; const isData = Number.isNaN(known[k]);
      if (isData) {
        ys[2 * di] = zr; ys[2 * di + 1] = zi; di++;
        let bs = 0, bd = Infinity; for (let q = 0; q < M; q++) { const d = (zr - P[2 * q]) ** 2 + (zi - P[2 * q + 1]) ** 2; if (d < bd) { bd = d; bs = q; } }
        dr = P[2 * bs]; dI = P[2 * bs + 1];
      } else {
        dr = known[k]; dI = 0;
        if (k >= 3 * A_LEN + M2_LEN) { errE += (zr - dr) ** 2 + zi * zi; errN++; tBits++; if (Math.sign(zr) !== Math.sign(dr)) tErr++; }
      }
      // decision-directed carrier loop, then the equaliser (normalised LMS, its error turned back to the input side)
      const pe = zi * dr - zr * dI; fr += 2e-4 * pe; th += 0.03 * pe + fr;
      const er = dr - zr, ei = dI - zi, eR = er * c - ei * s, eI = er * s + ei * c;
      let px = 1e-9; for (let m = 0; m < 2 * NT; m++) px += x[m] * x[m];
      const mu = (isData ? 0.01 : 0.03) / px;
      for (let m = 0; m < NT; m++) { const a = x[2 * m], bI = -x[2 * m + 1]; w[2 * m] += mu * (eR * a - eI * bI); w[2 * m + 1] += mu * (eR * bI + eI * a); }
    }
    const nv = Math.max(errE / Math.max(1, errN), 1e-3);
    // soft bits (positive = 1), most significant bit of each symbol first, scrambler undone
    const soft = new Float32Array(data.length * r.arity);
    for (let i = 0; i < data.length; i++) {
      const f = SCRAMBLER[i % 120] ? -1 : 1, yr = f * ys[2 * i], yi = f * ys[2 * i + 1];
      for (let b = 0; b < r.arity; b++) {
        const bit = r.arity - 1 - b; let d0 = Infinity, d1 = Infinity;
        for (let q = 0; q < M; q++) { const d = (yr - P[2 * q]) ** 2 + (yi - P[2 * q + 1]) ** 2; if ((q >> bit) & 1) { if (d < d1) d1 = d; } else if (d < d0) d0 = d; }
        soft[i * r.arity + b] = (d0 - d1) / nv;
      }
    }
    const order = popOrder(p.rate), n = soft.length / (r.repeat ? 4 : 2), v = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) {
      const k = 2 * i + j, a = r.repeat ? soft[order[2 * k]] + soft[order[2 * k + 1]] : soft[order[k]];
      v[2 * i + (1 - j)] = a;   // back to the shared decoder's order (0x4F first)
    }
    const bits = new Uint8Array(n); this.vit.decode(v, 0, n, 0, bits);
    const bytes = new Uint8Array(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
    this.onBurst({ bytes, rate: p.rate, bps: r.bps, slot: r.slot, cfoHz: Math.round((p.cfo + fr * HFDL_FS / (2 * Math.PI * HFDL_SPS)) * 10) / 10, snrDb: Math.round(10 * Math.log10(1 / nv) * 10) / 10, trainErrors: tErr, trainBits: tBits, at: p.t0 });
  }
}
