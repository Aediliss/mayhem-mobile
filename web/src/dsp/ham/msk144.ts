/**
 * FORK: MSK144 (meteor scatter) on the HAM receiver's USB audio, receive only. After WSJT-X (GPL-3.0):
 * lib/genmsk_128_90.f90 (frame), encode_128_90.f90 and crc13.cpp (CRC-13, polynomial 0x15D7), ldpc_128_90_*.f90 and
 * bpdecode128_90.f90 (code), msk144spd.f90, msk144sync.f90, msk144_freq_search.f90 and msk144decodeframe.f90 (the
 * short-ping decoder):
 *  - a 72 ms frame, sent over and over: 8-bit sync (01110010), 48 code bits, the sync again, 80 code bits; 2000 bit/s
 *    as offset-QPSK with half-sine pulses (MSK), so tones 500 Hz either side of the centre (1500 Hz audio);
 *  - 77 message bits (the FT8 packing: calls, grid / report, free text...) + CRC-13 → LDPC(128,90).
 * The audio is mixed to a 12 kHz complex baseband at 1500 Hz; every 18 ms the squared signal's spectrum over a frame
 * looks for MSK's two lines (±1000 Hz, shifted by twice the frequency error); a strong one (3× the median) is a ping:
 * its three frames, in six combinations, are summed coherently at frequencies near the estimate, the sync word found by
 * correlation, the phase taken from the two syncs, the bits matched-filtered, and belief propagation decodes; the CRC,
 * a hard-error limit and the message type must hold. Short (MSK40) messages are not decoded.
 */
import { fft } from '../../fft.js';
import { Ft8Decoder } from './ft8.js';
import { MSK144_GEN, MSK144_MN, MSK144_NM, MSK144_NRW } from './msk144-tables.js';
import { ldpcBp, ldpcEncode, ldpcGen, type LdpcCode } from './ldpc.js';
import type { DigitalDecoder } from './digital.js';

const FS = 12_000, NSPM = 864, N = 128, K = 90, STEP = 216;
const S8 = [0, 1, 1, 1, 0, 0, 1, 0];
const PP = Float32Array.from({ length: 12 }, (_, i) => Math.sin(i * Math.PI / 12));
const CODE: LdpcCode = { n: N, m: N - K, mn: MSK144_MN, nm: MSK144_NM, nrw: MSK144_NRW, colw: 3, roww: 11 };
const GEN = ldpcGen(MSK144_GEN, K);
const AUDIO_CENTRE = 1500;

/** A bitwise CRC as boost::augmented_crc: the long division of every bit given (the zeros already appended). */
export function augmentedCrc(bits: ArrayLike<number>, width: number, poly: number): number {
  let r = 0; const top = 1 << (width - 1), mask = (1 << width) - 1;
  for (let i = 0; i < bits.length; i++) { const hi = r & top; r = ((r << 1) | (bits[i] & 1)) & mask; if (hi) r ^= poly; }
  return r;
}
/** CRC-13 of 77 message bits, as encode_128_90: over the bits, 3 zeros, then two zero bytes. */
export function crc13(msg77: ArrayLike<number>): number {
  const b = new Uint8Array(96); for (let i = 0; i < 77; i++) b[i] = msg77[i];
  return augmentedCrc(b, 13, 0x15D7);
}

/** A 77-bit payload (10 bytes, FT8's layout) → the 128-bit codeword. */
export function msk144Encode(payload: Uint8Array): Uint8Array {
  const m = new Uint8Array(K); for (let i = 0; i < 77; i++) m[i] = (payload[i >> 3] >> (7 - (i & 7))) & 1;
  const c = crc13(m); for (let i = 0; i < 13; i++) m[77 + i] = (c >> (12 - i)) & 1;
  return ldpcEncode(GEN, m, K);
}
/** The 144 channel bits of a frame (0/1). */
export function msk144Frame(payload: Uint8Array): Uint8Array {
  const cw = msk144Encode(payload), b = new Uint8Array(144);
  b.set(S8, 0); b.set(cw.subarray(0, 48), 8); b.set(S8, 56); b.set(cw.subarray(48), 64);
  return b;
}
/** I and Q of a frame at [s12] (12 kHz sample units, may be fractional) of the frame: half-sine pulses, I carrying the
 *  even bits (2nd, 4th... 1-based) and Q the odd ones half a bit later, the first bit's pulse wrapping round the end. */
function iq(bits: ArrayLike<number>, s12: number): [number, number] {
  const iI = Math.floor(s12 / 12), tI = s12 - 12 * iI, u = s12 + 6, iQ = Math.floor(u / 12), tQ = u - 12 * iQ;
  const bi = 2 * bits[(2 * iI + 1) % 144] - 1, bq = 2 * bits[(2 * (iQ % 72)) % 144] - 1;
  return [bi * Math.sin(Math.PI * tI / 12), bq * Math.sin(Math.PI * tQ / 12)];
}
/** Test signal: [frames] repeats of a frame as real audio at [rate] around [centreHz]: Re{(I + jQ)·e^{jωt}}. */
export function msk144Audio(payload: Uint8Array, frames: number, rate: number, centreHz = AUDIO_CENTRE, amp = 1): Float32Array {
  const bits = msk144Frame(payload), out = new Float32Array(Math.round(frames * NSPM * rate / FS));
  for (let k = 0; k < out.length; k++) {
    const s12 = (k * FS / rate) % NSPM, [i, q] = iq(bits, s12), w = 2 * Math.PI * centreHz * k / rate;
    out[k] = amp * (i * Math.cos(w) - q * Math.sin(w));
  }
  return out;
}

// the sync word's waveform over the frame's first 42 samples (as msk144sync's cb)
const CB = (() => {
  const s = S8.map(b => 2 * b - 1), re = new Float32Array(42), im = new Float32Array(42);
  for (let i = 0; i < 6; i++) im[i] = PP[6 + i] * s[0];
  for (let i = 0; i < 12; i++) { im[6 + i] = PP[i] * s[2]; im[18 + i] = PP[i] * s[4]; im[30 + i] = PP[i] * s[6]; }
  for (let i = 0; i < 12; i++) { re[i] = PP[i] * s[1]; re[12 + i] = PP[i] * s[3]; re[24 + i] = PP[i] * s[5]; }
  for (let i = 0; i < 6; i++) re[36 + i] = PP[i] * s[7];
  return { re, im };
})();
const PATTERNS = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 1, 1]];

export interface Msk144Decode { utc: string; snr: number; dt: number; hz: number; text: string; frames: number }

/** One frame (864 complex samples, frame start at 0) → the 77 message bits as 10 bytes, or null (msk144decodeframe). */
export function msk144DecodeFrame(re: Float32Array, im: Float32Array): Uint8Array | null {
  // carrier phase from the two syncs
  let ar = 0, ai = 0;
  for (const o of [0, 336]) for (let m = 0; m < 42; m++) { const xr = re[o + m], xi = im[o + m]; ar += xr * CB.re[m] + xi * CB.im[m]; ai += xi * CB.re[m] - xr * CB.im[m]; }
  const ph = Math.atan2(ai, ar), c = Math.cos(ph), s = Math.sin(ph);
  const R = new Float32Array(NSPM), I = new Float32Array(NSPM);
  for (let k = 0; k < NSPM; k++) { R[k] = re[k] * c + im[k] * s; I[k] = im[k] * c - re[k] * s; }
  // matched filter
  const sb = new Float32Array(144);
  for (let k = 0; k < 6; k++) sb[0] += I[k] * PP[6 + k] + I[858 + k] * PP[k];
  for (let k = 0; k < 12; k++) sb[1] += R[k] * PP[k];
  for (let i = 2; i <= 72; i++) {
    let a = 0, b = 0;
    for (let k = 0; k < 12; k++) { a += I[(i - 1) * 12 - 6 + k] * PP[k]; b += R[(i - 1) * 12 + k] * PP[k]; }
    sb[2 * i - 2] = a; sb[2 * i - 1] = b;
  }
  let badSync = 0; for (let i = 0; i < 8; i++) { if ((sb[i] >= 0 ? 1 : 0) !== S8[i]) badSync++; if ((sb[56 + i] >= 0 ? 1 : 0) !== S8[i]) badSync++; }
  if (badSync > 4) return null;
  let m = 0, m2 = 0; for (const x of sb) { m += x; m2 += x * x; } m /= 144; m2 /= 144;
  const sd = Math.sqrt(Math.max(1e-20, m2 - m * m)), llr = new Float32Array(N), f = 2 / (0.6 * 0.6);
  for (let i = 0; i < 48; i++) llr[i] = f * sb[8 + i] / sd;
  for (let i = 0; i < 80; i++) llr[48 + i] = f * sb[64 + i] / sd;
  const crcOk = (cw: Uint8Array) => { const c13 = crc13(cw); let r = 0; for (let i = 0; i < 13; i++) r = r * 2 + cw[77 + i]; return c13 === r; };
  const cw = ldpcBp(CODE, llr, 10, crcOk, true); if (!cw) return null;
  let hard = 0; for (let i = 0; i < N; i++) if ((2 * cw[i] - 1) * llr[i] < 0) hard++;
  if (hard >= 18) return null;
  const p = new Uint8Array(10); for (let i = 0; i < 77; i++) p[i >> 3] |= cw[i] << (7 - (i & 7));
  const n3 = (cw[71] << 2) | (cw[72] << 1) | cw[73], i3 = (cw[74] << 2) | (cw[75] << 1) | cw[76];
  if ((i3 === 0 && (n3 === 1 || n3 === 3 || n3 === 4 || n3 > 5)) || i3 === 3 || i3 > 5) return null;
  return p;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export class Msk144Decoder implements DigitalDecoder {
  readonly name = 'MSK144';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Msk144Decode[], at: number) => void = () => {};
  /** Hz either side of 1500 to look for a signal. */
  tolHz = 100;
  private readonly unpacker = new Ft8Decoder();
  // front end: 48 kHz → 12 kHz (real low-pass, every 4th), then 1500 Hz to zero and a complex low-pass
  private readonly lp1: Float32Array; private readonly h1: Float32Array; private p1 = 0; private ph1 = 0;
  private readonly lp2: Float32Array; private readonly h2r: Float32Array; private readonly h2i: Float32Array; private p2 = 0;
  private cr = 1; private ci = 0; private readonly dr = Math.cos(-2 * Math.PI * AUDIO_CENTRE / FS); private readonly di = Math.sin(-2 * Math.PI * AUDIO_CENTRE / FS); private tick = 0;
  private readonly RING = 1 << 15; private readonly rr = new Float32Array(this.RING); private readonly ri = new Float32Array(this.RING);
  private total = 0; private sinceStep = 0; private t0 = 0;
  private readonly met: number[] = []; private readonly recent: { at: number; v: number; ferr: number; ratio: number }[] = [];
  private readonly seen = new Map<string, number>();
  /** Decodes made since the last reset (tests). */
  decodes = 0;

  constructor(readonly inRate = 48_000) {
    const win = (n: number, fc: number) => { const h = new Float32Array(n), mid = (n - 1) / 2; let s = 0; for (let i = 0; i < n; i++) { const x = i - mid, v = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x); h[i] = v * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1))); s += h[i]; } for (let i = 0; i < n; i++) h[i] /= s; return h; };
    this.lp1 = inRate === FS ? Float32Array.of(1) : win(63, 4800 / inRate); this.h1 = new Float32Array(2 * this.lp1.length);
    this.lp2 = win(41, 2000 / FS); this.h2r = new Float32Array(2 * this.lp2.length); this.h2i = new Float32Array(2 * this.lp2.length);
  }

  reset(): void { this.total = 0; this.sinceStep = 0; this.met.length = 0; this.recent.length = 0; this.seen.clear(); this.confidence = 0; this.t0 = 0; }

  push(a: Float32Array, n: number): void {
    const D = this.inRate / FS, T1 = this.lp1.length, T2 = this.lp2.length;
    for (let k = 0; k < n; k++) {
      this.h1[this.p1] = this.h1[this.p1 + T1] = a[k]; this.p1 = (this.p1 + 1) % T1;
      if (++this.ph1 < D) continue;
      this.ph1 = 0; let x = 0; for (let t = 0; t < T1; t++) x += this.lp1[t] * this.h1[this.p1 + t];
      const i = x * this.cr, q = x * this.ci;
      const nr = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = nr;
      if (++this.tick === 4096) { this.tick = 0; const g = 1.5 - (this.cr * this.cr + this.ci * this.ci) / 2; this.cr *= g; this.ci *= g; }
      this.h2r[this.p2] = this.h2r[this.p2 + T2] = i; this.h2i[this.p2] = this.h2i[this.p2 + T2] = q; this.p2 = (this.p2 + 1) % T2;
      let yr = 0, yi = 0; for (let t = 0; t < T2; t++) { yr += this.lp2[t] * this.h2r[this.p2 + t]; yi += this.lp2[t] * this.h2i[this.p2 + t]; }
      const w = this.total & (this.RING - 1); this.rr[w] = 2 * yr; this.ri[w] = 2 * yi; this.total++;
      if (++this.sinceStep === STEP) { this.sinceStep = 0; this.step(); }
    }
    const now = Date.now(); this.t0 = this.t0 === 0 ? now - this.total / FS * 1000 : this.t0 + 0.02 * (now - this.total / FS * 1000 - this.t0);
  }

  private at(k: number): [number, number] { const w = k & (this.RING - 1); return [this.rr[w], this.ri[w]]; }

  /** Every 18 ms: the detection metric of the frame that started 3 frames ago; a peak above 3× the median is a ping. */
  private step(): void {
    const start = this.total - 3 * NSPM; if (start < NSPM) return;
    const NF = 1024, re = new Float32Array(NF), im = new Float32Array(NF);
    for (let k = 0; k < NSPM; k++) {
      const [x, y] = this.at(start + k); let a = x * x - y * y, b = 2 * x * y;
      const e = k < 12 ? (1 - Math.cos(k * Math.PI / 12)) / 2 : k >= NSPM - 12 ? (1 - Math.cos((NSPM - 1 - k) * Math.PI / 12)) / 2 : 1;
      a *= e; b *= e; re[k] = a; im[k] = b;
    }
    fft(re, im);
    const df = FS / NF, pw = (b: number) => { const j = ((b % NF) + NF) % NF; return re[j] * re[j] + im[j] * im[j]; };
    const look = (centre: number) => {   // the strongest bin within ±2·tol of [centre] Hz, its interpolated frequency, and peak/average
      const lo = Math.round((centre - 2 * this.tolHz) / df), hi = Math.round((centre + 2 * this.tolHz) / df);
      let best = lo, bv = -1, sum = 0, cnt = 0;
      for (let b = lo; b <= hi; b++) { const v = pw(b); sum += v; cnt++; if (v > bv) { bv = v; best = b; } }
      const j = (x: number) => ((x % NF) + NF) % NF, a0 = { r: re[j(best - 1)], i: im[j(best - 1)] }, a1 = { r: re[j(best)], i: im[j(best)] }, a2 = { r: re[j(best + 1)], i: im[j(best + 1)] };
      const nr = a0.r - a2.r, ni = a0.i - a2.i, dr = 2 * a1.r - a0.r - a2.r, di = 2 * a1.i - a0.i - a2.i, dd = dr * dr + di * di;
      const delta = dd > 0 ? -(nr * dr + ni * di) / dd : 0;
      return { v: bv, f: (best + Math.max(-0.5, Math.min(0.5, delta))) * df, ratio: bv / ((sum - bv) / Math.max(1, cnt - 1) + 1e-30) };
    };
    const h = look(1000), l = look(-1000);
    const top = h.v >= l.v ? h : l, ferr = (h.v >= l.v ? h.f - 1000 : l.f + 1000) / 2;
    this.met.push(top.v); if (this.met.length > 200) this.met.shift();
    this.recent.push({ at: start, v: top.v, ferr, ratio: top.ratio }); if (this.recent.length > 3) this.recent.shift();
    if (this.met.length < 20 || this.recent.length < 3) return;
    const med = [...this.met].sort((a, b) => a - b)[this.met.length >> 2] || 1e-30;
    const mid = this.recent[1];
    const peak = mid.v >= this.recent[0].v && mid.v >= this.recent[2].v;
    this.confidence = Math.max(this.confidence * 0.98, Math.min(1, mid.v / med / 30));
    if (!peak || (mid.v / med < 3 && mid.ratio < 12) || Math.abs(mid.ferr) > this.tolHz) return;
    this.tryDecode(mid.at, mid.ferr, 12 * Math.log10(mid.v / med) / 2 - 9);
  }

  /** Three frames around [at] (the frame before, it, the one after), as msk144spd. */
  private tryDecode(at: number, ferr: number, snr: number): void {
    const ib = Math.max(0, at - NSPM), L = 3 * NSPM; if (ib + L > this.total) return;
    const xr = new Float32Array(L), xi = new Float32Array(L);
    for (let k = 0; k < L; k++) { const [a, b] = this.at(ib + k); xr[k] = a; xi[k] = b; }
    const r = msk144Search(xr, xi, ferr);
    if (!r) return;
    const text = this.unpacker.unpackPayload(r.payload); if (!text) return;
    const whenMs = this.t0 + (ib + r.offset) / FS * 1000, last = this.seen.get(text) ?? -1e12;
    if (whenMs - last < 3000) { this.seen.set(text, whenMs); return; }
    this.seen.set(text, whenMs);
    const d = new Date(whenMs), utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
    const tod = ((whenMs / 1000) % 15 + 15) % 15;
    const x: Msk144Decode = { utc, snr: Math.round(snr), dt: Math.round(tod * 10) / 10, hz: Math.round(AUDIO_CENTRE + r.ferr), text, frames: r.frames };
    this.decodes++;
    this.onText(text, `MSK144 ${x.hz} Hz`);
    this.onDecodes([x], whenMs);
  }
}

/** Sync and decode three frames of 12 kHz complex baseband near frequency [ferr]: the six frame combinations, the
 *  frequency ±8 Hz in 2 Hz steps, the two best sync positions and a sample either side. */
export function msk144Search(xr: Float32Array, xi: Float32Array, ferr: number): { payload: Uint8Array; ferr: number; offset: number; frames: number } | null {
  const L = xr.length, nfr = Math.floor(L / NSPM);
  for (const pat of PATTERNS) {
    if (pat.length > nfr && pat.slice(nfr).some(v => v)) continue;
    let best = { x: -1, f: 0, cr: new Float32Array(0), ci: new Float32Array(0), cc: new Float32Array(0) };
    for (let k = -4; k <= 4; k++) {
      const f = ferr + 2 * k, w = -2 * Math.PI * f / FS;
      const cr = new Float32Array(NSPM), ci = new Float32Array(NSPM);
      for (let fr = 0; fr < nfr; fr++) {
        if (!pat[fr]) continue;
        for (let s = 0; s < NSPM; s++) { const n = fr * NSPM + s, c = Math.cos(w * n), sn = Math.sin(w * n); cr[s] += xr[n] * c - xi[n] * sn; ci[s] += xr[n] * sn + xi[n] * c; }
      }
      const cc = new Float32Array(NSPM); let mx = 0;
      for (let sh = 0; sh < NSPM; sh++) {
        let a = 0, b = 0;
        for (const o of [0, 336]) for (let m = 0; m < 42; m++) { const j = (sh + o + m) % NSPM; a += cr[j] * CB.re[m] + ci[j] * CB.im[m]; b += ci[j] * CB.re[m] - cr[j] * CB.im[m]; }
        cc[sh] = Math.hypot(a, b); if (cc[sh] > mx) mx = cc[sh];
      }
      if (mx > best.x) best = { x: mx, f, cr, ci, cc };
    }
    // the two highest sync peaks, each tried at its sample and one either side
    const cc = Float32Array.from(best.cc), peaks: number[] = [];
    for (let p = 0; p < 2; p++) { let b = 0; for (let i = 1; i < NSPM; i++) if (cc[i] > cc[b]) b = i; peaks.push(b); for (let d = -7; d <= 7; d++) cc[(b + d + NSPM) % NSPM] = 0; }
    for (const pk of peaks) for (const d of [0, -1, 1]) {
      const sh = (pk + d + NSPM) % NSPM, r = new Float32Array(NSPM), i = new Float32Array(NSPM);
      for (let s = 0; s < NSPM; s++) { r[s] = best.cr[(s + sh) % NSPM]; i[s] = best.ci[(s + sh) % NSPM]; }
      const p = msk144DecodeFrame(r, i);
      if (p) return { payload: p, ferr: best.f, offset: sh, frames: pat.reduce((a, b) => a + b, 0) };
    }
  }
  return null;
}
