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
 * a hard-error limit and the message type must hold. When no MSK144 frame decodes, the ping is tried as MSK40 (20 ms
 * frames, a reversed sync word, LDPC(32,16) over a 12-bit hash of the two calls and a 4-bit report): shown as
 * "<CALL1 CALL2> RPT" only when two calls seen together in a decoded MSK144 message hash to it (a 32-bit code tried at
 * many offsets finds chance matches, so a bare hash is not shown).
 */
import { fft } from '../../fft.js';
import { Ft8Decoder } from './ft8.js';
import { MSK144_GEN, MSK144_MN, MSK144_NM, MSK144_NRW } from './msk144-tables.js';
import { ldpcBp, ldpcEncode, ldpcGen, type LdpcCode } from './ldpc.js';
import { wsprHash } from './wspr.js';
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
  const nb = bits.length, iI = Math.floor(s12 / 12), tI = s12 - 12 * iI, u = s12 + 6, iQ = Math.floor(u / 12), tQ = u - 12 * iQ;
  const bi = 2 * bits[(2 * iI + 1) % nb] - 1, bq = 2 * bits[(2 * (iQ % (nb / 2))) % nb] - 1;
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
function syncWave(sync: readonly number[]): { re: Float32Array; im: Float32Array } {
  const s = sync.map(b => 2 * b - 1), re = new Float32Array(42), im = new Float32Array(42);
  for (let i = 0; i < 6; i++) im[i] = PP[6 + i] * s[0];
  for (let i = 0; i < 12; i++) { im[6 + i] = PP[i] * s[2]; im[18 + i] = PP[i] * s[4]; im[30 + i] = PP[i] * s[6]; }
  for (let i = 0; i < 12; i++) { re[i] = PP[i] * s[1]; re[12 + i] = PP[i] * s[3]; re[24 + i] = PP[i] * s[5]; }
  for (let i = 0; i < 6; i++) re[36 + i] = PP[i] * s[7];
  return { re, im };
}
const CB = syncWave(S8);
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

  /** Pairs of calls seen together in a decoded MSK144 message lately ("CALL1 CALL2", both orders), for MSK40's hash:
   *  the two stations of a QSO go on to short messages. A hash is only shown when one of these matches it. */
  private readonly pairs: string[] = [];
  private learn(text: string): void {
    const calls = text.split(' ').filter(w => /^[A-Z0-9/]{3,11}$/.test(w) && /[0-9]/.test(w) && /[A-Z]/.test(w) && !/^[A-R]{2}[0-9]{2}$/.test(w) && !/^R?[+-]\d\d$/.test(w));
    if (calls.length < 2) return;
    for (const p of [`${calls[0]} ${calls[1]}`, `${calls[1]} ${calls[0]}`]) { const i = this.pairs.indexOf(p); if (i >= 0) this.pairs.splice(i, 1); this.pairs.unshift(p); }
    if (this.pairs.length > 20) this.pairs.length = 20;
  }
  private pairFor(h: number): string | null { return this.pairs.find(p => msk40Hash(p) === h) ?? null; }

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
    const r144 = msk144Search(xr, xi, ferr); let r: { ferr: number; offset: number; frames: number } | null = r144, text: string | null = null;
    if (r144) { text = this.unpacker.unpackPayload(r144.payload); if (!text) return; this.learn(text); }
    else {
      // an MSK40 short message: three of its 20 ms frames around the ping; the calls only when a recent pair hashes to it
      const s40 = msk40Search(xr.subarray(NSPM - NSPM40, NSPM + 2 * NSPM40), xi.subarray(NSPM - NSPM40, NSPM + 2 * NSPM40), ferr);
      const pair = s40 && this.pairFor(s40.hash);
      if (!s40 || !pair) return;
      r = s40; text = `<${pair}> ${MSK40_RPT[s40.rpt]}`;
    }
    if (!r || !text) return;
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
  const r = searchFrames(xr, xi, ferr, NSPM, [0, 336], CB, msk144DecodeFrame);
  return r && { payload: r.value, ferr: r.ferr, offset: r.offset, frames: r.frames };
}
function searchFrames<T>(xr: Float32Array, xi: Float32Array, ferr: number, nspm: number, syncAt: number[], cb: { re: Float32Array; im: Float32Array }, decode: (r: Float32Array, i: Float32Array) => T | null): { value: T; ferr: number; offset: number; frames: number } | null {
  const L = xr.length, nfr = Math.floor(L / nspm);
  for (const pat of PATTERNS) {
    if (pat.length > nfr && pat.slice(nfr).some(v => v)) continue;
    let best = { x: -1, f: 0, cr: new Float32Array(0), ci: new Float32Array(0), cc: new Float32Array(0) };
    for (let k = -4; k <= 4; k++) {
      const f = ferr + 2 * k, w = -2 * Math.PI * f / FS;
      const cr = new Float32Array(nspm), ci = new Float32Array(nspm);
      for (let fr = 0; fr < nfr; fr++) {
        if (!pat[fr]) continue;
        for (let s = 0; s < nspm; s++) { const n = fr * nspm + s, c = Math.cos(w * n), sn = Math.sin(w * n); cr[s] += xr[n] * c - xi[n] * sn; ci[s] += xr[n] * sn + xi[n] * c; }
      }
      const cc = new Float32Array(nspm); let mx = 0;
      for (let sh = 0; sh < nspm; sh++) {
        let a = 0, b = 0;
        for (const o of syncAt) for (let m = 0; m < 42; m++) { const j = (sh + o + m) % nspm; a += cr[j] * cb.re[m] + ci[j] * cb.im[m]; b += ci[j] * cb.re[m] - cr[j] * cb.im[m]; }
        cc[sh] = Math.hypot(a, b); if (cc[sh] > mx) mx = cc[sh];
      }
      if (mx > best.x) best = { x: mx, f, cr, ci, cc };
    }
    // the two highest sync peaks, each tried at its sample and one either side
    const cc = Float32Array.from(best.cc), peaks: number[] = [];
    for (let p = 0; p < 2; p++) { let b = 0; for (let i = 1; i < nspm; i++) if (cc[i] > cc[b]) b = i; peaks.push(b); for (let d = -7; d <= 7; d++) cc[(b + d + nspm) % nspm] = 0; }
    for (const pk of peaks) for (const d of [0, -1, 1]) {
      const sh = (pk + d + nspm) % nspm, r = new Float32Array(nspm), i = new Float32Array(nspm);
      for (let s = 0; s < nspm; s++) { r[s] = best.cr[(s + sh) % nspm]; i[s] = best.ci[(s + sh) % nspm]; }
      const v = decode(r, i);
      if (v) return { value: v, ferr: best.f, offset: sh, frames: pat.reduce((a, b) => a + b, 0) };
    }
  }
  return null;
}

// ---- MSK40: the short messages "<CALL1 CALL2> RPT" (genmsk40.f90, encode_msk40.f90, bpdecode40.f90, msk40decodeframe.f90)
const NSPM40 = 240, S8R = [1, 0, 1, 1, 0, 0, 0, 1];   // its sync word is MSK144's reversed
const CB40 = syncWave(S8R);
const G40 = [0x4428, 0x5a6b, 0x1b04, 0x2c12, 0x60c4, 0x1071, 0xbe6a, 0x36dd, 0xc580, 0xad9a, 0xeca2, 0x7843, 0x332e, 0xa685, 0x5906, 0x1efe];
const COLORDER40 = [4, 1, 2, 3, 0, 8, 6, 10, 13, 28, 20, 23, 17, 15, 27, 25, 16, 12, 18, 19, 7, 21, 22, 11, 24, 5, 26, 14, 9, 29, 30, 31];
const CODE40: LdpcCode = {
  n: 32, m: 16, colw: 3, roww: 7,
  mn: Uint8Array.from([1, 6, 13, 2, 3, 14, 4, 8, 15, 5, 11, 12, 7, 10, 16, 6, 9, 15, 1, 11, 16, 2, 4, 5, 3, 7, 9, 8, 10, 12, 8, 13, 14, 1, 4, 12, 2, 6, 10, 3, 11, 15, 5, 9, 14, 7, 13, 15, 12, 14, 16, 1, 2, 8, 3, 5, 6, 4, 9, 11, 1, 7, 14, 5, 10, 13, 3, 4, 16, 2, 15, 16, 6, 7, 12, 7, 8, 11, 1, 9, 10, 2, 11, 13, 3, 12, 13, 4, 6, 14, 1, 5, 15, 8, 9, 16]),
  nm: Uint8Array.from([1, 7, 12, 18, 21, 27, 31, 2, 8, 13, 18, 24, 28, 0, 2, 9, 14, 19, 23, 29, 0, 3, 8, 12, 20, 23, 30, 0, 4, 8, 15, 19, 22, 31, 0, 1, 6, 13, 19, 25, 30, 0, 5, 9, 16, 21, 25, 26, 0, 3, 10, 11, 18, 26, 32, 0, 6, 9, 15, 20, 27, 32, 0, 5, 10, 13, 22, 27, 0, 0, 4, 7, 14, 20, 26, 28, 0, 4, 10, 12, 17, 25, 29, 0, 1, 11, 16, 22, 28, 29, 0, 2, 11, 15, 17, 21, 30, 0, 3, 6, 14, 16, 24, 31, 0, 5, 7, 17, 23, 24, 32, 0]),
  nrw: Uint8Array.from([7, 6, 6, 6, 6, 6, 6, 6, 6, 5, 6, 6, 6, 6, 6, 6]),
};
export const MSK40_RPT = ['-03', '+00', '+03', '+06', '+10', '+13', '+16', 'R-03', 'R+00', 'R+03', 'R+06', 'R+10', 'R+13', 'R+16', 'RRR', '73'];
/** The 12-bit hash of "CALL1 CALL2" (WSJT-X's hash(): lookup3 over the 37-character padded text, seed 146). */
export const msk40Hash = (pair: string): number => wsprHash(pair.padEnd(37)) & 4095;
/** 16 message bits (12-bit hash, 4-bit report) → the 32-bit codeword in transmitted order, as encode_msk40. */
export function msk40Encode(ig: number): Uint8Array {
  const msg = Array.from({ length: 16 }, (_, i) => (ig >> i) & 1), itmp = new Uint8Array(32), cw = new Uint8Array(32);
  for (let i = 0; i < 16; i++) { let s = 0; for (let j = 0; j < 16; j++) s ^= msg[j] & ((G40[i] >> (15 - j)) & 1); itmp[i] = s; itmp[16 + i] = msg[i]; }
  for (let k = 0; k < 32; k++) cw[COLORDER40[k]] = itmp[k];
  return cw;
}
/** The 40 channel bits of an MSK40 frame. */
export function msk40Frame(ig: number): Uint8Array { const b = new Uint8Array(40); b.set(S8R, 0); b.set(msk40Encode(ig), 8); return b; }
/** Test signal: [frames] repeats of an MSK40 frame. */
export function msk40Audio(ig: number, frames: number, rate: number, centreHz = AUDIO_CENTRE, amp = 1): Float32Array {
  const bits = msk40Frame(ig), out = new Float32Array(Math.round(frames * NSPM40 * rate / FS));
  for (let k = 0; k < out.length; k++) { const s12 = (k * FS / rate) % NSPM40, [i, q] = iq(bits, s12), w = 2 * Math.PI * centreHz * k / rate; out[k] = amp * (i * Math.cos(w) - q * Math.sin(w)); }
  return out;
}
/** One MSK40 frame (240 samples from its start) → the hash and report index, or null (msk40decodeframe's tests: at most
 *  3 sync bits wrong; BP; at most 4 code bits from the hard decisions, their summed reliability under 0.65; a report
 *  from the R / RRR / 73 half, as WSJT-X takes from an unknown station). */
export function msk40DecodeFrame(re: Float32Array, im: Float32Array): { hash: number; rpt: number } | null {
  let ar = 0, ai = 0;
  for (let m = 0; m < 42; m++) { ar += re[m] * CB40.re[m] + im[m] * CB40.im[m]; ai += im[m] * CB40.re[m] - re[m] * CB40.im[m]; }
  const ph = Math.atan2(ai, ar), c = Math.cos(ph), s = Math.sin(ph), N = NSPM40;
  const R = new Float32Array(N), I = new Float32Array(N);
  for (let k = 0; k < N; k++) { R[k] = re[k] * c + im[k] * s; I[k] = im[k] * c - re[k] * s; }
  const sb = new Float32Array(40);
  for (let k = 0; k < 6; k++) sb[0] += I[k] * PP[6 + k] + I[N - 6 + k] * PP[k];
  for (let k = 0; k < 12; k++) sb[1] += R[k] * PP[k];
  for (let i = 2; i <= 20; i++) { let a = 0, b = 0; for (let k = 0; k < 12; k++) { a += I[(i - 1) * 12 - 6 + k] * PP[k]; b += R[(i - 1) * 12 + k] * PP[k]; } sb[2 * i - 2] = a; sb[2 * i - 1] = b; }
  let bad = 0; for (let i = 0; i < 8; i++) if ((sb[i] >= 0 ? 1 : 0) !== S8R[i]) bad++;
  if (bad > 3) return null;
  let m = 0, m2 = 0; for (const x of sb) { m += x; m2 += x * x; } m /= 40; m2 /= 40;
  const sd = Math.sqrt(Math.max(1e-20, m2 - m * m)), soft = sb.map(x => x / sd), llr = new Float32Array(32);
  for (let i = 0; i < 32; i++) llr[i] = 2 * soft[8 + i] / (0.75 * 0.75);
  const cw = ldpcBp(CODE40, llr, 5); if (!cw) return null;
  const msg = Array.from({ length: 16 }, (_, k) => cw[COLORDER40[16 + k]]);
  const ig = msg.reduce((a, b, k) => a | (b << k), 0), enc = msk40Encode(ig);
  let ham = 0, cord = 0; for (let i = 0; i < 32; i++) if (enc[i] !== (soft[8 + i] >= 0 ? 1 : 0)) { ham++; cord += Math.abs(soft[8 + i]); }
  const rpt = ig & 15;
  if (ham > 4 || cord >= 0.65 || rpt < 7) return null;
  return { hash: ig >> 4, rpt };
}
/** Sync and decode MSK40 frames of 12 kHz complex baseband near [ferr], as msk144Search. */
export function msk40Search(xr: Float32Array, xi: Float32Array, ferr: number): { hash: number; rpt: number; ferr: number; offset: number; frames: number } | null {
  const r = searchFrames(xr, xi, ferr, NSPM40, [0], CB40, msk40DecodeFrame);
  return r && { ...r.value, ferr: r.ferr, offset: r.offset, frames: r.frames };
}
