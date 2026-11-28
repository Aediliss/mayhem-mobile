/**
 * FORK: FST4W-120 receiver, receive only. After WSJT-X (GPL-3.0): lib/fst4/genfst4.f90 (frame), get_crc24.f90 (CRC),
 * ldpc_240_74_*.f90 (code), decode240_74.f90 (belief propagation), lib/77bit/packjt77.f90 (message type 0.6) and
 * lib/fst4_decode.f90 (timing: FST4W-120 is 8200 samples a symbol at 12 kHz, the frame nominally 1 s into the even
 * minute):
 *  - 160 symbols of 4-GFSK (BT 2) at 12000/8200 = 1.4634 baud and Hz: five 8-symbol sync blocks (S1 S2 S1 S2 S1) with
 *    four blocks of 30 data symbols between them; data symbols carry two code bits each, Gray-mapped (00 01 11 10);
 *  - 50 message bits (WSPR's three message types in packjt77's 0.6 layout: call (28-bit), locator and power; compound
 *    call with prefix or suffix and power; hashed call (22-bit) with a 6-character locator) + CRC-24 (0x100065B)
 *    through LDPC(240,74).
 * The receiver mixes 1500 Hz audio down to a 300 Hz complex baseband (205 samples a symbol); short spectra a quarter
 * symbol apart find candidates against the sync blocks over ±100 Hz; each is refined by correlating the five sync
 * blocks coherently (each block's eight symbols together); the data symbols' four tone magnitudes give the bits'
 * likelihoods; belief propagation (sum-product, as decode240_74) decodes, and the CRC and the unpacking must hold.
 */
import { fft } from '../../fft.js';
import { WsprFrontEnd } from './wspr.js';
import { FST4W_GEN, FST4W_MN, FST4W_NM, FST4W_NRW } from './fst4w-tables.js';
import { ldpcBp, ldpcChecks, ldpcEncode, ldpcGen, type LdpcCode } from './ldpc.js';
import type { DigitalDecoder } from './digital.js';

const FS = 300, NSS = 205, NSYM = 160, N = 240, K = 74, M = N - K;
const DF = FS / NSS;                        // 1.4634 Hz: tone spacing = baud
export const FST4W_TONE_HZ = DF;
export const FST4W_SYMBOL_S = NSS / FS;     // 0.6833 s
const SLOT_S = 120, NPOINTS = 112 * FS;     // the slot's first 112 s (the frame ends 110.3 s in)
const AUDIO_CENTRE = 1500;
const SYNC1 = [0, 1, 3, 2, 1, 0, 2, 3], SYNC2 = [2, 3, 1, 0, 3, 2, 0, 1];
const SYNC_AT = [0, 38, 76, 114, 152], SYNC_OF = [SYNC1, SYNC2, SYNC1, SYNC2, SYNC1];
const DATA_AT = (() => { const a: number[] = []; for (const b of [8, 46, 84, 122]) for (let i = 0; i < 30; i++) a.push(b + i); return a; })();
const GRAY = [0, 1, 3, 2];   // two bits → tone

// ---- CRC-24 (get_crc24.f90: polynomial 0x100065B, the last 24 of [len] bits zero when computing) ------------------------
const P24 = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1];
export function fst4Crc24(bits: ArrayLike<number>, len: number): number {
  const r = Array.from({ length: 25 }, (_, i) => bits[i] & 1);
  for (let i = 0; i <= len - 25; i++) {
    r[24] = bits[i + 24] & 1;
    if (r[0]) for (let k = 0; k < 25; k++) r[k] ^= P24[k];
    r.push(r.shift()!);
  }
  let n = 0; for (let i = 0; i < 24; i++) n = n * 2 + r[i];
  return n;
}

// ---- messages (packjt77 type 0.6) ---------------------------------------------------------------------------------------
const NTOKENS = 2063592, MAX22 = 4194304, NZZZ = 46656;
const A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ans = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', ls = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function packBase(call: string): number {
  let c6: string;
  if (/^[A-Z0-9]{1,2}[0-9][A-Z]{0,3}$/.test(call) && /[0-9]/.test(call[2] ?? '') && call.length <= 6) c6 = call.padEnd(6);
  else if (/[0-9]/.test(call[1] ?? '') && call.length <= 5) c6 = ` ${call}`.padEnd(6);
  else return -1;
  const i = [ans.indexOf(c6[0]), A2.indexOf(c6[1]), '0123456789'.indexOf(c6[2]), ls.indexOf(c6[3]), ls.indexOf(c6[4]), ls.indexOf(c6[5])];
  if (i.some(v => v < 0)) return -1;
  return NTOKENS + MAX22 + ((((i[0] * 36 + i[1]) * 10 + i[2]) * 27 + i[3]) * 27 + i[4]) * 27 + i[5];
}
export function fst4Hash22(call: string): number {
  let n = 0n; const t = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
  for (let i = 0; i < 11; i++) { const j = t.indexOf(call[i] ?? ' '); if (j < 0) return -1; n = n * 38n + BigInt(j); }
  return Number(((47055833459n * n) >> 42n) & 0x3FFFFFn);
}
function unpackBase(n28: number): string | null {
  if (n28 < NTOKENS + MAX22) return null;
  let n = n28 - NTOKENS - MAX22; const c: string[] = [];
  c[5] = ls[n % 27]; n = Math.floor(n / 27); c[4] = ls[n % 27]; n = Math.floor(n / 27); c[3] = ls[n % 27]; n = Math.floor(n / 27);
  c[2] = String(n % 10); n = Math.floor(n / 10); c[1] = A2[n % 36]; n = Math.floor(n / 36);
  if (n > 36) return null; c[0] = ans[n];
  const call = c.join('').trim();
  return call.length >= 3 && !call.includes(' ') ? call : null;
}
const putBits = (b: Uint8Array, at: number, n: number, v: number) => { for (let i = 0; i < n; i++) b[at + i] = Math.floor(v / 2 ** (n - 1 - i)) % 2; };
const getBits = (b: ArrayLike<number>, at: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + b[at + i]; return v; };

/** "K1ABC FN42 37", "PJ4/K1ABC 37", "K1ABC/7 30", "<PJ4/K1ABC> FK52UD" → the 50 message bits, or null. */
export function fst4wPack(msg: string): Uint8Array | null {
  const w = msg.trim().toUpperCase().split(/\s+/), b = new Uint8Array(50);
  const dbmOf = (s: string) => /^\d{1,2}$/.test(s) ? Math.round(0.3 * Math.max(0, Math.min(60, Number(s)))) : -1;
  if (w.length === 3 && !w[0].startsWith('<')) {   // type 1
    const n28 = packBase(w[0]), d = dbmOf(w[2]);
    if (n28 < 0 || !/^[A-R]{2}[0-9]{2}$/.test(w[1]) || d < 0) return null;
    const g = w[1], ig = (g.charCodeAt(0) - 65) * 1800 + (g.charCodeAt(1) - 65) * 100 + Number(g[2]) * 10 + Number(g[3]);
    putBits(b, 0, 28, n28); putBits(b, 28, 15, ig); putBits(b, 43, 5, d);   // bits 48, 49: 0 0
    return b;
  }
  if (w.length === 2 && w[0].includes('/') && !w[0].startsWith('<')) {   // type 2
    const c = w[0], i1 = c.indexOf('/') + 1, m1 = c.length, d = dbmOf(w[1]);
    if (i1 < 2 || i1 === m1 || d < 0) return null;
    const parts = c.split('/'); if (parts.length !== 2) return null;
    let npfx: number, base: string;
    if (i1 <= 4) {   // a prefix of 1-3 characters
      base = parts[1]; npfx = A2.indexOf(c[0]);
      if (i1 >= 3) npfx = 36 * npfx + A2.indexOf(c[1]);
      if (i1 === 4) npfx = 36 * npfx + A2.indexOf(c[2]);
    } else {   // a suffix of 1-3 characters
      base = parts[0]; const s = parts[1];
      if (s.length === 1) npfx = A2.indexOf(s);
      else if (s.length === 2) npfx = 36 * A2.indexOf(s[0]) + A2.indexOf(s[1]);
      else if (s.length === 3 && /[0-9]/.test(s[2])) npfx = 360 * A2.indexOf(s[0]) + 10 * A2.indexOf(s[1]) + A2.indexOf(s[2]);
      else return null;
      npfx += NZZZ;
    }
    const n28 = packBase(base); if (n28 < 0) return null;
    putBits(b, 0, 28, n28); putBits(b, 28, 16, npfx); putBits(b, 44, 5, d); b[49] = 1;
    return b;
  }
  if (w.length === 2 && w[0].startsWith('<') && w[0].endsWith('>')) {   // type 3: no power in FST4W's
    const call = w[0].slice(1, -1), g = w[1];
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
    const h = fst4Hash22(call); if (h < 0) return null;
    let ig = (g.charCodeAt(0) - 65) * 18 * 100 * 625 + (g.charCodeAt(1) - 65) * 100 * 625 + Number(g[2]) * 10 * 625 + Number(g[3]) * 625;
    ig += g.length === 6 ? (g.charCodeAt(4) - 65) * 25 + (g.charCodeAt(5) - 65) : 24 * 25 + 24;
    putBits(b, 0, 22, h); putBits(b, 22, 25, ig); b[48] = 1;   // bits 48-50 (1-based): 0 1 0
    return b;
  }
  return null;
}

export interface Fst4wMessage { text: string; call: string; grid: string; dbm: number; type: 1 | 2 | 3 }
/** The 50 message bits → the message (learning calls for the hashed type), or null. */
export function fst4wUnpack(b: ArrayLike<number>, hashes?: Map<number, string>): Fst4wMessage | null {
  const j48 = b[47], j49 = b[48], j50 = b[49];
  const type = j50 ? 2 : !j49 ? 1 : !j48 ? 3 : -1;
  if (type === 1) {
    const call = unpackBase(getBits(b, 0, 28)); let ig = getBits(b, 28, 15); const dbm = Math.round(getBits(b, 43, 5) * 10 / 3);
    if (!call || dbm > 60) return null;
    const j1 = Math.floor(ig / 1800); ig -= j1 * 1800; const j2 = Math.floor(ig / 100); ig -= j2 * 100;
    if (j1 > 17 || j2 > 17) return null;
    const grid = String.fromCharCode(65 + j1, 65 + j2) + String(Math.floor(ig / 10)) + String(ig % 10);
    hashes?.set(fst4Hash22(call), call);
    return { text: `${call} ${grid} ${dbm}`, call, grid, dbm, type: 1 };
  }
  if (type === 2) {
    const base = unpackBase(getBits(b, 0, 28)); let npfx = getBits(b, 28, 16); const dbm = Math.round(getBits(b, 44, 5) * 10 / 3);
    if (!base || dbm > 60) return null;
    let call: string;
    if (npfx < NZZZ) {
      const p = [' ', ' ', ' '];
      for (let i = 2; i >= 0; i--) { p[i] = A2[npfx % 36]; npfx = Math.floor(npfx / 36); if (npfx === 0) break; }
      call = `${p.join('').trim()}/${base}`;
    } else {
      npfx -= NZZZ;
      const s = npfx <= 35 ? A2[npfx] : npfx <= 1295 ? A2[Math.floor(npfx / 36)] + A2[npfx % 36] : npfx <= 12959 ? A2[Math.floor(npfx / 360)] + A2[Math.floor(npfx / 10) % 36] + A2[npfx % 10] : null;
      if (!s) return null;
      call = `${base}/${s}`;
    }
    hashes?.set(fst4Hash22(call), call);
    return { text: `${call} ${dbm}`, call, grid: '', dbm, type: 2 };
  }
  if (type === 3) {
    const n22 = getBits(b, 0, 22); let n = getBits(b, 22, 25);
    const j1 = Math.floor(n / 1125000); n -= j1 * 1125000; const j2 = Math.floor(n / 62500); n -= j2 * 62500;
    const j3 = Math.floor(n / 6250); n -= j3 * 6250; const j4 = Math.floor(n / 625); n -= j4 * 625; const j5 = Math.floor(n / 25), j6 = n % 25;
    if (j1 > 17 || j2 > 17 || j3 > 9 || j4 > 9 || j5 > 24 || j6 > 24) return null;
    const grid = String.fromCharCode(65 + j1, 65 + j2) + j3 + j4 + (j5 !== 24 || j6 !== 24 ? String.fromCharCode(65 + j5, 65 + j6) : '');
    const known = hashes?.get(n22);
    return { text: `<${known ?? '...'}> ${grid}`, call: known ?? '', grid, dbm: -1, type: 3 };
  }
  return null;
}

// ---- the code -----------------------------------------------------------------------------------------------------------
const CODE: LdpcCode = { n: N, m: M, mn: FST4W_MN, nm: FST4W_NM, nrw: FST4W_NRW, colw: 3, roww: 5 };
const GEN = ldpcGen(FST4W_GEN, K);
/** 74 bits (message + CRC) → the 240-bit codeword (systematic: the message first). */
export const fst4wEncode = (m74: ArrayLike<number>): Uint8Array => ldpcEncode(GEN, m74, K);
/** How many parity checks fail. */
export const fst4wChecks = (cw: ArrayLike<number>): number => ldpcChecks(CODE, cw);
/** A message → the 160 tones, or null. */
export function fst4wTones(msg: string): Uint8Array | null {
  const b = fst4wPack(msg); if (!b) return null;
  const m74 = new Uint8Array(K); m74.set(b);
  putBits(m74, 50, 24, fst4Crc24(m74, K));
  const cw = fst4wEncode(m74), t = new Uint8Array(NSYM);
  SYNC_AT.forEach((at, k) => SYNC_OF[k].forEach((v, i) => { t[at + i] = v; }));
  DATA_AT.forEach((at, i) => { t[at] = GRAY[2 * cw[2 * i] + cw[2 * i + 1]]; });
  return t;
}

/** Belief propagation (sum-product, after decode240_74): LLRs (> 0 means 1) → the codeword, or null. */
export const fst4wBp = (llr: Float32Array, iters = 30): Uint8Array | null => ldpcBp(CODE, llr, iters);

// ---- test signal (GFSK, BT 2, as gen_fst4wave) -----------------------------------------------------------------------------
function erf(x: number): number {   // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
/** Tones → real audio at [rate] (tests): [centreHz] is the middle of the four tones, 4-GFSK with BT 2. */
export function fst4wAudio(tones: ArrayLike<number>, centreHz: number, rate: number, amp = 1): Float32Array {
  const nsps = Math.round(rate * FST4W_SYMBOL_S), ns = tones.length, c = Math.PI * Math.sqrt(2 / Math.LN2);
  const pulse = Float32Array.from({ length: 3 * nsps }, (_, i) => { const tt = (i - 1.5 * nsps) / nsps; return 0.5 * (erf(c * 2 * (tt + 0.5)) - erf(c * 2 * (tt - 0.5))); });
  const dphi = new Float64Array((ns + 2) * nsps), pk = 2 * Math.PI / nsps;
  for (let j = 0; j < ns; j++) for (let i = 0; i < 3 * nsps; i++) dphi[j * nsps + i] += pk * pulse[i] * tones[j];
  const base = 2 * Math.PI * (centreHz - 1.5 * rate / nsps) / rate, out = new Float32Array(ns * nsps); let ph = 0;
  for (let k = 0; k < out.length; k++) { out[k] = amp * Math.sin(ph); ph += dphi[k + nsps] + base; }
  return out;
}

// ---- the receiver -------------------------------------------------------------------------------------------------------------
export interface Fst4wDecode { utc: string; snr: number; dt: number; hz: number; text: string; msg: Fst4wMessage }
interface Cand { f: number; t: number; score: number }
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Coherent correlation of 8 symbols of [tones] at [f] Hz starting at sample [t0]; |sum| (phase continuous within). */
function blockCorr(id: Float32Array, qd: Float32Array, f: number, t0: number, tones: readonly number[]): number {
  let re = 0, im = 0, ph = 0; const np = id.length;
  for (let s = 0; s < tones.length; s++) {
    const w = 2 * Math.PI * (f + (tones[s] - 1.5) * DF) / FS, cw = Math.cos(w), sw = Math.sin(w);
    let c = Math.cos(ph), sn = Math.sin(ph);
    for (let j = 0; j < NSS; j++) {
      const k = t0 + s * NSS + j;
      if (k >= 0 && k < np) { re += id[k] * c + qd[k] * sn; im += qd[k] * c - id[k] * sn; }
      const c2 = c * cw - sn * sw; sn = c * sw + sn * cw; c = c2;
    }
    ph += w * NSS;
  }
  return Math.hypot(re, im);
}
const syncScore = (id: Float32Array, qd: Float32Array, f: number, t0: number) => SYNC_AT.reduce((a, at, k) => a + blockCorr(id, qd, f, t0 + at * NSS, SYNC_OF[k]), 0);

/** |correlation| of each of the 160 symbols with each of its four tones, indexed by the two bits' value (tone GRAY[v]),
 *  and the complex values kept for the multi-symbol sums: with modulation index 1 every tone ends a symbol with the
 *  same phase step, α = 2π f·NSS/FS plus π, so symbol i is turned back by i(α + π) to line them all up. */
interface Corrs extends Array<number[]> { re: Float32Array; im: Float32Array }
function symbolCorrs(id: Float32Array, qd: Float32Array, f: number, t0: number): Corrs {
  const out = [] as unknown as Corrs, re = new Float32Array(NSYM * 4), im = new Float32Array(NSYM * 4), np = id.length;
  const step = 2 * Math.PI * f * NSS / FS + Math.PI;
  for (let i = 0; i < NSYM; i++) {
    const m = [0, 0, 0, 0], rc = Math.cos(-i * step), rs = Math.sin(-i * step);
    for (let v = 0; v < 4; v++) {
      const w = 2 * Math.PI * (f + (GRAY[v] - 1.5) * DF) / FS, cw = Math.cos(w), sw = Math.sin(w);
      let c = 1, sn = 0, a = 0, b = 0;
      for (let j = 0; j < NSS; j++) {
        const k = t0 + i * NSS + j;
        if (k >= 0 && k < np) { a += id[k] * c + qd[k] * sn; b += qd[k] * c - id[k] * sn; }
        const c2 = c * cw - sn * sw; sn = c * sw + sn * cw; c = c2;
      }
      re[4 * i + v] = a * rc - b * rs; im[4 * i + v] = a * rs + b * rc; m[v] = Math.hypot(a, b);
    }
    out.push(m);
  }
  out.re = re; out.im = im;
  return out;
}
/** Three sets of 320 bit metrics (every symbol's two bits, first bit first): from 1, 2 and 4 symbols coherently;
 *  each a max-log difference, normalised to unit spread and scaled by 2.83 as WSJT-X does. */
function bitMetrics(cs: Corrs): Float32Array[] {
  const sets = [1, 2, 4].map(nseq => {
    const bm = new Float32Array(2 * NSYM), nh = 1 << (2 * nseq), mags = new Float32Array(nh);
    for (let s0 = 0; s0 < NSYM; s0 += nseq) {
      for (let h = 0; h < nh; h++) {
        let a = 0, b = 0;
        for (let k = 0; k < nseq; k++) { const v = (h >> (2 * (nseq - 1 - k))) & 3, idx = 4 * (s0 + k) + v; a += cs.re[idx]; b += cs.im[idx]; }
        mags[h] = Math.hypot(a, b);
      }
      for (let ib = 0; ib < 2 * nseq; ib++) {
        const bit = 2 * nseq - 1 - ib; let m1 = -1, m0 = -1;
        for (let h = 0; h < nh; h++) { if ((h >> bit) & 1) { if (mags[h] > m1) m1 = mags[h]; } else if (mags[h] > m0) m0 = mags[h]; }
        bm[2 * s0 + ib] = m1 - m0;
      }
    }
    let m = 0, m2 = 0; for (const x of bm) { m += x; m2 += x * x; } m /= bm.length; m2 /= bm.length;
    const sd = Math.sqrt(Math.max(1e-20, m2 - m * m)); for (let i = 0; i < bm.length; i++) bm[i] = 2.83 * bm[i] / sd;
    return bm;
  });
  return sets;
}

export class Fst4wDecoder implements DigitalDecoder {
  readonly name = 'FST4W';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Fst4wDecode[], slot: number) => void = () => {};
  readonly hashes = new Map<number, string>();
  budgetMs = 4000;
  private readonly RING = FS * 130;
  private readonly ri = new Float32Array(this.RING); private readonly rq = new Float32Array(this.RING);
  private wpos = 0; private total = 0; private t0 = 0; private lastSlot = -1;
  private readonly fe = new WsprFrontEnd(48_000, (i, q) => { this.ri[this.wpos] = i; this.rq[this.wpos] = q; this.wpos = (this.wpos + 1) % this.RING; this.total++; }, FS);

  reset(): void { this.wpos = 0; this.total = 0; this.t0 = 0; this.lastSlot = -1; this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.fe.push(a, n);
    const now = Date.now(), est = now - (this.total / FS + this.fe.delayS) * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.02 * (est - this.t0);
    const slot = Math.floor(now / (SLOT_S * 1000)), into = now - slot * SLOT_S * 1000;
    if (slot === this.lastSlot || into < 112_500) return;
    this.lastSlot = slot;
    const first = Math.round((slot * SLOT_S * 1000 - this.t0) / 1000 * FS), id = new Float32Array(NPOINTS), qd = new Float32Array(NPOINTS);
    let have = 0;
    for (let k = 0; k < NPOINTS; k++) { const s = first + k; if (s >= 0 && s < this.total && this.total - s <= this.RING) { id[k] = this.ri[s % this.RING]; qd[k] = this.rq[s % this.RING]; have++; } }
    if (have < NPOINTS / 2) return;
    const list = this.decodeBuffer(id, qd, slot * SLOT_S * 1000);
    if (list.length) this.onDecodes(list, slot);
  }

  /** 112 s of 300 Hz complex baseband (1500 Hz audio at 0 Hz) starting on the even minute. */
  decodeBuffer(id: Float32Array, qd: Float32Array, slotMs = 0): Fst4wDecode[] {
    const started = Date.now(), np = id.length;
    // quarter-symbol-step spectra: one symbol (Hann) zero-padded to 512, bins of 0.586 Hz
    const NF = 512, BIN = FS / NF, STEP = NSS / 4, nfr = Math.floor((np - NSS) / STEP) + 1;
    const re = new Float32Array(NF), im = new Float32Array(NF), win = Float32Array.from({ length: NSS }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / NSS));
    const amp: Float32Array[] = [];
    for (let k = 0; k < nfr; k++) {
      re.fill(0); im.fill(0); const o = Math.round(k * STEP);
      for (let j = 0; j < NSS; j++) { re[j] = id[o + j] * win[j]; im[j] = qd[o + j] * win[j]; }
      fft(re, im);
      const row = new Float32Array(NF);
      for (let j = 0; j < NF; j++) { const b = (j + NF / 2) % NF; row[j] = Math.hypot(re[b], im[b]); }   // row[NF/2] is 0 Hz
      amp.push(row);
    }
    // coarse: the centre at every bin within ±100 Hz, the start at every quarter symbol from -1 s to +3 s of DT
    const TB = DF / BIN, fbMax = Math.floor(100 / BIN), sMin = Math.round(0 / STEP), sMax = Math.round(4 * FS / STEP);
    const W = 2 * fbMax + 1, H = sMax - sMin + 1, score = new Float32Array(W * H);
    for (let fi = 0; fi < W; fi++) {
      const fb = fi - fbMax, tb = [0, 1, 2, 3].map(t => NF / 2 + Math.round(fb + (t - 1.5) * TB));
      for (let si = 0; si < H; si++) {
        const s0 = sMin + si; let sig = 0, tot = 0;
        for (let k = 0; k < 5; k++) for (let i = 0; i < 8; i++) {
          const fr = s0 + 4 * (SYNC_AT[k] + i); if (fr < 0 || fr >= nfr) continue;
          const r = amp[fr], want = SYNC_OF[k][i], a0 = r[tb[0]], a1 = r[tb[1]], a2 = r[tb[2]], a3 = r[tb[3]];
          const aw = want === 0 ? a0 : want === 1 ? a1 : want === 2 ? a2 : a3;
          sig += aw - (a0 + a1 + a2 + a3 - aw) / 3; tot += a0 + a1 + a2 + a3;
        }
        score[fi * H + si] = tot > 0 ? sig / tot : 0;
      }
    }
    // peaks: the best start for each frequency, then local maxima across frequency
    const bestS = new Int32Array(W), bestV = new Float32Array(W);
    for (let fi = 0; fi < W; fi++) { let b = 0, v = -1e9; for (let si = 0; si < H; si++) if (score[fi * H + si] > v) { v = score[fi * H + si]; b = si; } bestS[fi] = b; bestV[fi] = v; }
    const sorted = Float32Array.from(bestV).sort(), med = sorted[W >> 1], mad = sorted[Math.floor(W * 0.84)] - med || 1e-6;
    const cands: Cand[] = [];
    for (let fi = 2; fi < W - 2; fi++) {
      const v = bestV[fi]; if (v < med + 3 * mad || v < 0.03) continue;
      if (v < bestV[fi - 1] || v < bestV[fi + 1] || v < bestV[fi - 2] || v < bestV[fi + 2]) continue;
      cands.push({ f: (fi - fbMax) * BIN, t: (sMin + bestS[fi]) * STEP, score: v });
    }
    cands.sort((a, b) => b.score - a.score); cands.length = Math.min(cands.length, 24);
    // noise for the SNR: the median spectrum amplitude² per bin, against 2500 Hz
    const out: Fst4wDecode[] = [], d = new Date(slotMs), utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
    let nsum = 0, nn = 0; for (let k = 0; k < nfr; k += 7) { const r = Float32Array.from(amp[k]).sort(); nsum += r[NF >> 1] ** 2; nn++; }
    const noiseBin = nsum / Math.max(1, nn);
    for (const c of cands) {
      if (Date.now() - started > this.budgetMs) break;
      // fine: frequency and start together (an error in one is partly made up by the other), on the coherent sync
      // blocks: ±0.6 Hz × ±1/3 symbol, then ±0.1 Hz × ±10 samples around the best
      let f = c.f, t = Math.round(c.t), best = -1;
      const grid = (df: number, nf: number, dt: number, nt: number) => {
        const f0 = f, t0 = t;
        for (let i = -nf; i <= nf; i++) for (let k = -nt; k <= nt; k++) { const v = syncScore(id, qd, f0 + i * df, t0 + k * dt); if (v > best) { best = v; f = f0 + i * df; t = t0 + k * dt; } }
      };
      grid(0.1, 6, 10, 7); grid(0.025, 4, 2, 5);
      if (out.some(o => Math.abs(o.hz - (AUDIO_CENTRE + f)) < 1.5 && Math.abs(o.dt - (t / FS - 1)) < 0.5)) continue;
      // every symbol's four tone correlations, then bit metrics from 1, 2 and 4 symbols at a time (as WSJT-X's
      // get_fst4_bitmetrics); the sync symbols must be mostly right; belief propagation on each metric in turn
      const cs = symbolCorrs(id, qd, f, t), sets = bitMetrics(cs);
      let goodSync = 0;
      SYNC_AT.forEach((at, k) => SYNC_OF[k].forEach((want, i) => { const m = cs[at + i]; let b = 0; for (let v = 1; v < 4; v++) if (m[v] > m[b]) b = v; if (GRAY[b] === want) goodSync++; }));
      if (goodSync < 16) continue;
      let cw: Uint8Array | null = null;
      for (const bm of sets) {
        const llr = new Float32Array(N);
        DATA_AT.forEach((at, i) => { llr[2 * i] = bm[2 * at]; llr[2 * i + 1] = bm[2 * at + 1]; });
        const c = fst4wBp(llr);
        if (c && fst4Crc24(c, K) === 0) { cw = c; break; }
      }
      if (!cw) continue;
      let sigP = 0; for (const at of DATA_AT) sigP += Math.max(...cs[at]) ** 2;
      const msg = fst4wUnpack(cw.subarray(0, 50), this.hashes); if (!msg) continue;
      // SNR in 2500 Hz: a tone of complex amplitude A is 2A² of audio power; complex noise of variance σ² over FS Hz is
      // σ²·5000/FS in 2500 Hz of audio. A from the strongest tone's correlation over a symbol (A·NSS); σ² from the median
      // spectrum bin (|X|² of complex noise: median = ln 2 × mean; the Hann window's Σw² = 0.375·NSS).
      const A2 = sigP / DATA_AT.length / (NSS * NSS), s2 = noiseBin / Math.LN2 / (0.375 * NSS);
      const snr = Math.round(10 * Math.log10(Math.max(1e-12, 2 * A2 / Math.max(1e-30, s2 * 5000 / FS))));
      const x: Fst4wDecode = { utc, snr, dt: Math.round((t / FS - 1) * 10) / 10, hz: Math.round(AUDIO_CENTRE + f), text: msg.text, msg };
      out.push(x); this.onText(msg.text, `FST4W ${x.hz} Hz`);
    }
    this.confidence = out.length ? 1 : this.confidence * 0.8;
    return out;
  }
}
