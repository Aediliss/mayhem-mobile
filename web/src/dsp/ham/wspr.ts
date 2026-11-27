/**
 * FORK: WSPR-2 receiver, receive only. After WSJT-X's wsprd (lib/wsprd: wsprd.c, wsprd_utils.c, wsprsim_utils.c; Joe
 * Taylor K1JT and Steven Franke K9AN, GPL-3.0-or-later):
 *  - 2-minute slots starting on even UTC minutes, the transmission 1 s in and 110.6 s long; 162 symbols of 4-FSK at
 *    375/256 = 1.4648 baud and 1.4648 Hz spacing, a tone = sync bit + 2 × data bit (the fixed 162-bit sync vector);
 *  - 50 message bits (28 callsign, 15 locator, 7 power) and 31 zero tail bits through the K=32 rate-1/2 convolutional
 *    code (Layland-Lushbaugh polynomials 0xF2D05351, 0xE4613C47), interleaved by bit reversal of 8-bit addresses;
 *  - messages type 1 (call, 4-character locator, dBm), type 2 (compound call with a prefix or suffix, dBm) and type 3
 *    (a hashed call, a 6-character locator, dBm), the hash being lookup3's hashlittle (Bob Jenkins, public domain).
 * The audio band 1400-1600 Hz is mixed down to a 375 Hz complex baseband; as in wsprd, half-symbol-step spectra give
 * candidates (peaks of the average spectrum over ±110 Hz), a coarse search over frequency, start time and linear drift
 * against the sync vector, then a fine one on the samples themselves; each symbol's four tone amplitudes give a soft
 * bit (the two tones its sync bit allows). The code is decoded by a stack (Zigangirov-Jelinek) sequential decoder,
 * written here from the textbook algorithm, with a Fano metric for a Gaussian channel; a path must end in the 31 zero
 * tail bits and unpack to a valid message.
 */
import { fft } from '../../fft.js';
import { popcount32 } from '../core.js';
import type { DigitalDecoder } from './digital.js';

export const WSPR_SYNC = Uint8Array.from([
  1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1,
  0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1,
  0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1,
  0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0,
  0, 0]);
const POLY1 = 0xF2D05351, POLY2 = 0xE4613C47;
const FS = 375, SYM = 256, DF = FS / SYM, NBITS = 81, NSYM = 162;   // 1.4648 Hz tones, 0.6827 s symbols
export const WSPR_TONE_HZ = DF;
export const WSPR_SYMBOL_S = SYM / FS;
export const WSPR_SLOT_S = 120;
const NPOINTS = 114 * FS;            // as wsprd: 114 s from the start of the even minute
const AUDIO_CENTRE = 1500;           // the WSPR band is 1400-1600 Hz of USB audio
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
const parity = (x: number) => popcount32(x) & 1;

// ---- the hash (lookup3 hashlittle, Bob Jenkins, public domain), as nhash(call, len, 146) -----------------------------
const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
export function wsprHash(s: string): number {
  const k = Array.from(s, ch => ch.charCodeAt(0) & 0xFF);
  let a = (0xDEADBEEF + k.length + 146) >>> 0, b = a, c = a, i = 0, len = k.length;
  const w = (o: number) => (k[o] | (k[o + 1] << 8) | (k[o + 2] << 16) | (k[o + 3] << 24)) >>> 0;
  while (len > 12) {
    a = (a + w(i)) >>> 0; b = (b + w(i + 4)) >>> 0; c = (c + w(i + 8)) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
    len -= 12; i += 12;
  }
  if (len === 0) return c;
  const byte = (o: number) => (o < len ? k[i + o] : 0);
  a = (a + (byte(0) | (byte(1) << 8) | (byte(2) << 16) | (byte(3) << 24))) >>> 0;
  b = (b + (byte(4) | (byte(5) << 8) | (byte(6) << 16) | (byte(7) << 24))) >>> 0;
  c = (c + (byte(8) | (byte(9) << 8) | (byte(10) << 16) | (byte(11) << 24))) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return c & 32767;
}

// ---- packing (the transmitter side, for the tests) ---------------------------------------------------------------------
const callCode = (ch: string) => ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : 36;
const isDigit = (ch: string | undefined) => !!ch && ch >= '0' && ch <= '9';
function packCall(call: string): number {
  if (call.length > 6) return -1;
  let c6 = call;
  if (isDigit(call[2])) c6 = call; else if (isDigit(call[1])) c6 = ` ${call}`; else return -1;
  c6 = c6.padEnd(6, ' ');
  const c = Array.from(c6, callCode);
  let n = c[0]; n = n * 36 + c[1]; n = n * 10 + c[2]; n = n * 27 + c[3] - 10; n = n * 27 + c[4] - 10; n = n * 27 + c[5] - 10;
  return n;
}
const NU = [0, -1, 1, 0, -1, 2, 1, 0, -1, 1];
const pc37 = (ch: string) => ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : 36;

/** A WSPR message ("K1ABC FN42 37", "PJ4/K1ABC 37", "<PJ4/K1ABC> FK52UD 37") → its 28-bit n and 22-bit m, or null. */
export function wsprPack(msg: string): { n: number; m: number } | null {
  const parts = msg.trim().toUpperCase().split(/\s+/);
  if (parts.length === 3 && !parts[0].includes('<') && !parts[0].includes('/')) {   // type 1
    const [call, grid, pw] = parts, n = packCall(call), p = Number(pw);
    if (n < 0 || !/^[A-R]{2}[0-9]{2}$/.test(grid) || !(p >= 0 && p <= 60) || ![0, 3, 7].includes(p % 10)) return null;
    const g = [grid.charCodeAt(0) - 65, grid.charCodeAt(1) - 65, grid.charCodeAt(2) - 48, grid.charCodeAt(3) - 48];
    return { n, m: ((179 - 10 * g[0] - g[2]) * 180 + 10 * g[1] + g[3]) * 128 + p + 64 };
  }
  if (parts.length === 3 && parts[0].startsWith('<') && parts[0].endsWith('>')) {   // type 3
    const call = parts[0].slice(1, -1), grid = parts[1];
    if (!/^[A-R]{2}[0-9]{2}[A-X]{2}$/.test(grid)) return null;
    let p = Math.max(0, Math.min(60, Number(parts[2]) || 0)); p += NU[p % 10];
    const n = packCall(grid.slice(1) + grid[0]); if (n < 0) return null;
    return { n, m: 128 * wsprHash(call) - (p + 1) + 64 };
  }
  if (parts.length === 2 && parts[0].includes('/')) {   // type 2
    const call = parts[0]; let p = Math.max(0, Math.min(60, Number(parts[1]) || 0)); p += NU[p % 10];
    const i1 = call.indexOf('/'), base = call.slice(0, i1), after = call.slice(i1 + 1);
    let n: number, m: number, nadd: number;
    if (after.length === 1) {   // one-character suffix
      n = packCall(base); nadd = 1; const ch = after;
      m = 60000 - 32768 + (isDigit(ch) ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : 38);
    } else if (after.length === 2 && isDigit(after[0]) && isDigit(after[1])) {   // two-digit suffix
      n = packCall(base); nadd = 1; m = 60000 + 26 + Number(after);
    } else {   // a prefix of 1-3 characters
      const pfx = base; n = packCall(after); if (pfx.length > 3) return null;
      m = pfx.length === 1 ? 37 * 36 + 36 : pfx.length === 2 ? 36 : 0;
      for (const ch of pfx) m = 37 * m + pc37(ch);
      nadd = 0; if (m > 32768) { m -= 32768; nadd = 1; }
    }
    if (n < 0) return null;
    return { n, m: 128 * m + p + 1 + nadd + 64 };
  }
  return null;
}

/** n, m → the 11 data bytes (50 bits, then the zero tail). */
export function wsprData(n: number, m: number): Uint8Array {
  const d = new Uint8Array(11);
  d[0] = (n >>> 20) & 0xFF; d[1] = (n >>> 12) & 0xFF; d[2] = (n >>> 4) & 0xFF;
  d[3] = ((n & 0x0F) << 4) | ((m >>> 18) & 0x0F); d[4] = (m >>> 10) & 0xFF; d[5] = (m >>> 2) & 0xFF; d[6] = (m & 3) << 6;
  return d;
}

/** The 162 coded bits (POLY1's bit first for each data bit), not yet interleaved. */
export function wsprEncode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(NSYM); let st = 0, o = 0;
  for (let i = 0; i < NBITS; i++) {
    st = ((st << 1) | ((data[i >> 3] >> (7 - (i & 7))) & 1)) >>> 0;
    out[o++] = parity(st & POLY1); out[o++] = parity(st & POLY2);
  }
  return out;
}

const rev8 = (i: number) => { let r = 0; for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b); return r; };
const PERM = (() => { const p: number[] = []; for (let i = 0; p.length < NSYM; i++) { const j = rev8(i); if (j < NSYM) p.push(j); } return p; })();
/** Coded bit p goes out as channel symbol PERM[p]. */
export function wsprInterleave<T extends ArrayLike<number>>(a: T): Uint8Array { const o = new Uint8Array(NSYM); for (let p = 0; p < NSYM; p++) o[PERM[p]] = a[p]; return o; }
export function wsprDeinterleave(a: ArrayLike<number>): Uint8Array { const o = new Uint8Array(NSYM); for (let p = 0; p < NSYM; p++) o[p] = a[PERM[p]]; return o; }

/** A message → its 162 tones (0-3), or null. */
export function wsprTones(msg: string): Uint8Array | null {
  const p = wsprPack(msg); if (!p) return null;
  const ch = wsprInterleave(wsprEncode(wsprData(p.n, p.m)));
  return ch.map((b, i) => 2 * b + WSPR_SYNC[i]);
}

/** Tones → real audio at [rate] (tests): [centreHz] is the middle of the four tones, [driftHz] a linear drift over the message. */
export function wsprAudio(tones: ArrayLike<number>, centreHz: number, rate: number, amp = 1, driftHz = 0): Float32Array {
  const ns = Math.round(rate * WSPR_SYMBOL_S), out = new Float32Array(ns * tones.length); let ph = 0;
  for (let i = 0; i < tones.length; i++) {
    const f = centreHz + driftHz / 2 * (i - 81) / 81 + (tones[i] - 1.5) * DF, dph = 2 * Math.PI * f / rate;
    for (let j = 0; j < ns; j++) { out[i * ns + j] = amp * Math.sin(ph); ph += dph; }
  }
  return out;
}

// ---- unpacking (as wsprd_utils.c) ---------------------------------------------------------------------------------------
function unpackCall(n: number): string | null {
  if (n >= 262177560) return null;
  const t: string[] = [];
  t[5] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
  t[4] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
  t[3] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
  t[2] = CHARS[n % 10]; n = Math.floor(n / 10);
  t[1] = CHARS[n % 36]; n = Math.floor(n / 36);
  if (n > 36) return null;
  t[0] = CHARS[n];
  return t.join('');   // six characters, spaces kept (a type 3 message needs the positions)
}
function unpackGrid(ng: number): string | null {
  ng >>= 7; if (ng >= 32400) return null;
  const dlat = (ng % 180) - 90; let dlong = Math.floor(ng / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360; if (dlong > 180) dlong += 360;
  const nlong = Math.trunc(60 * (180 - dlong) / 5), a1 = Math.trunc(nlong / 240), a2 = Math.trunc((nlong - 240 * a1) / 24);
  const nlat = Math.trunc(60 * (dlat + 90) / 2.5), b1 = Math.trunc(nlat / 240), b2 = Math.trunc((nlat - 240 * b1) / 24);
  return CHARS[10 + a1] + CHARS[10 + b1] + CHARS[a2] + CHARS[b2];
}
function unpackPfx(np: number, call: string): string | null {
  if (np < 60000) {
    let n = np; const p: string[] = [];
    for (let i = 2; i >= 0; i--) { const c = n % 37; p[i] = c <= 9 ? String.fromCharCode(c + 48) : c <= 35 ? String.fromCharCode(c + 55) : ' '; n = Math.floor(n / 37); }
    const s = p.join(''), sp = s.lastIndexOf(' ');
    return `${sp >= 0 ? s.slice(sp + 1) : s}/${call}`;
  }
  const c = np - 60000;
  if (c >= 0 && c <= 9) return `${call}/${c}`;
  if (c >= 10 && c <= 35) return `${call}/${String.fromCharCode(c + 55)}`;
  if (c >= 36 && c <= 125) return `${call}/${Math.floor((c - 26) / 10)}${(c - 26) % 10}`;
  return null;
}
const goodDbm = (d: number) => d >= 0 && d <= 60 && [0, 3, 7].includes(d % 10);

export interface WsprMessage { text: string; call: string; grid: string; dbm: number; type: 1 | 2 | 3 }
/** The 50 data bits (the first 7 bytes) → the message, learning calls for the hash table; null if it is not a valid one. */
export function wsprUnpack(d: ArrayLike<number>, hashes?: Map<number, string>): WsprMessage | null {
  const n1 = ((d[0] << 20) | (d[1] << 12) | (d[2] << 4) | ((d[3] >> 4) & 15)) >>> 0;
  const n2 = (((d[3] & 15) << 18) | (d[4] << 10) | (d[5] << 2) | ((d[6] >> 6) & 3)) >>> 0;
  const c6 = unpackCall(n1), grid = unpackGrid(n2); if (!c6 || !grid) return null;
  const call = c6.trim(), ntype = (n2 & 127) - 64;
  if (ntype >= 0 && ntype <= 62) {
    const nu = ntype % 10;
    if (nu === 0 || nu === 3 || nu === 7) {
      if (!call || call.includes(' ')) return null;
      hashes?.set(wsprHash(call), call);
      return { text: `${call} ${grid} ${ntype}`, call, grid, dbm: ntype, type: 1 };
    }
    let nadd = nu; if (nu > 3) nadd = nu - 3; if (nu > 7) nadd = nu - 7;
    const full = unpackPfx(Math.floor(n2 / 128) + 32768 * (nadd - 1), call), dbm = ntype - nadd;
    if (!full || !goodDbm(dbm)) return null;
    hashes?.set(wsprHash(full), full);
    return { text: `${full} ${dbm}`, call: full, grid: '', dbm, type: 2 };
  }
  if (ntype < 0 && ntype !== -64) {
    const dbm = -(ntype + 1), g6 = (c6[5] === ' ' ? '' : c6[5]) + c6.slice(0, 5).replace(/ +$/, '');
    if (!goodDbm(dbm) || !/^[A-R]{2}[0-9]{2}/.test(g6)) return null;
    const ih = Math.floor((n2 - ntype - 64) / 128), known = hashes?.get(ih);
    const who = known ? `<${known}>` : '<...>';
    return { text: `${who} ${g6} ${dbm}`, call: known ?? '', grid: g6, dbm, type: 3 };
  }
  return null;
}

// ---- the stack sequential decoder ---------------------------------------------------------------------------------------
/** Fano metric (×10, integer) of a received soft symbol (0-255, 128 = nothing) for a coded 0 / 1: a Gaussian channel
 *  whose signal and noise make the symbols' rms 50 (as the soft symbols are scaled), signal/noise amplitude 1.5. */
const METTAB: Int32Array[] = (() => {
  const A = 50 * 1.5 / Math.sqrt(1 + 1.5 * 1.5), s2 = (50 / Math.sqrt(1 + 1.5 * 1.5)) ** 2, bias = 0.45;
  const m0 = new Int32Array(256), m1 = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    const L = 2 * A * (i - 128) / s2;   // ln p(r|1)/p(r|0)
    const l1 = Math.log2(2 / (1 + Math.exp(-L))), l0 = Math.log2(2 / (1 + Math.exp(L)));
    m1[i] = Math.round(10 * (Math.max(l1, -10) - bias)); m0[i] = Math.round(10 * (Math.max(l0, -10) - bias));
  }
  return [m0, m1];
})();

const CAP = 1 << 19;
const nMetric = new Int32Array(CAP), nState = new Uint32Array(CAP), nParent = new Int32Array(CAP), nDepth = new Uint8Array(CAP);
const heap = new Int32Array(CAP);
/** Deinterleaved soft symbols (162, 0-255) → the 11 data bytes, or null when the search gives up. */
export function wsprStackDecode(sym: Uint8Array, maxPops = 120_000): Uint8Array | null {
  let nn = 0, hn = 0;
  const push = (x: number) => { let i = hn++; heap[i] = x; while (i > 0) { const p = (i - 1) >> 1; if (nMetric[heap[p]] >= nMetric[heap[i]]) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; } };
  const pop = () => {
    const top = heap[0]; heap[0] = heap[--hn]; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let b = i; if (l < hn && nMetric[heap[l]] > nMetric[heap[b]]) b = l; if (r < hn && nMetric[heap[r]] > nMetric[heap[b]]) b = r; if (b === i) break; const t = heap[b]; heap[b] = heap[i]; heap[i] = t; i = b; }
    return top;
  };
  nMetric[0] = 0; nState[0] = 0; nParent[0] = -1; nDepth[0] = 0; nn = 1; push(0);
  for (let pops = 0; pops < maxPops && hn > 0; pops++) {
    const x = pop(), d = nDepth[x];
    if (d === NBITS) {
      const bits = new Uint8Array(NBITS); for (let y = x; nParent[y] >= 0; y = nParent[y]) bits[nDepth[y] - 1] = nState[y] & 1;
      const out = new Uint8Array(11); for (let i = 0; i < NBITS; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
      return out;
    }
    if (nn + 2 >= CAP || hn + 2 >= CAP) return null;
    const r0 = sym[2 * d], r1 = sym[2 * d + 1];
    for (let bit = 0; bit <= (d >= 50 ? 0 : 1); bit++) {
      const st = ((nState[x] << 1) | bit) >>> 0, y = nn++;
      nState[y] = st; nParent[y] = x; nDepth[y] = d + 1;
      nMetric[y] = nMetric[x] + METTAB[parity(st & POLY1)][r0] + METTAB[parity(st & POLY2)][r1];
      push(y);
    }
  }
  return null;
}

// ---- the front end: 48 kHz (or 12 kHz) USB audio → 375 Hz complex around 1500 Hz ---------------------------------------
function lowpass(cutoff: number, n: number): Float32Array {
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) { const x = i - m, v = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x); h[i] = v * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1))); s += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}
class Stage {
  private readonly hi: Float32Array; private readonly hq: Float32Array; private p = 0; private ph = 0;
  constructor(private readonly taps: Float32Array, private readonly D: number) { this.hi = new Float32Array(2 * taps.length); this.hq = new Float32Array(2 * taps.length); }
  get delay(): number { return (this.taps.length - 1) / 2; }
  /** One complex input sample; calls out() at the decimated rate. */
  put(i: number, q: number, out: (i: number, q: number) => void): void {
    const T = this.taps.length;
    this.hi[this.p] = this.hi[this.p + T] = i; this.hq[this.p] = this.hq[this.p + T] = q; this.p = (this.p + 1) % T;
    if (++this.ph < this.D) return;
    this.ph = 0; let a = 0, b = 0;
    for (let t = 0; t < T; t++) { const h = this.taps[t]; a += h * this.hi[this.p + t]; b += h * this.hq[this.p + t]; }
    out(a, b);
  }
}
export class WsprFrontEnd {
  private cr = 1; private ci = 0; private readonly dr: number; private readonly di: number; private n = 0;
  private readonly s1: Stage; private readonly s2: Stage;
  /** The output's delay behind the input, seconds. */
  readonly delayS: number;
  constructor(readonly inRate = 48_000, private readonly out: (i: number, q: number) => void = () => undefined) {
    const D1 = inRate / 3000;
    this.dr = Math.cos(-2 * Math.PI * AUDIO_CENTRE / inRate); this.di = Math.sin(-2 * Math.PI * AUDIO_CENTRE / inRate);
    this.s1 = new Stage(lowpass(400 / inRate, Math.round(5 * D1) | 1), D1);
    this.s2 = new Stage(lowpass(190 / 3000, 161), 8);
    this.delayS = this.s1.delay / inRate + this.s2.delay / 3000;
  }
  push(a: ArrayLike<number>, n = a.length): void {
    const emit = (i: number, q: number) => this.s2.put(i, q, this.out);
    for (let k = 0; k < n; k++) {
      const x = a[k];
      this.s1.put(x * this.cr, x * this.ci, emit);
      const t = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = t;
      if (++this.n === 4096) { this.n = 0; const g = 1.5 - (this.cr * this.cr + this.ci * this.ci) / 2; this.cr *= g; this.ci *= g; }
    }
  }
}

// ---- the receiver -------------------------------------------------------------------------------------------------------
export interface WsprDecode { utc: string; snr: number; dt: number; hz: number; drift: number; text: string; msg: WsprMessage }
interface Cand { freq: number; snr: number; shift: number; drift: number; sync: number }

/** Per-symbol tone amplitudes at [f0] (Hz from 1500), [lag] samples in, linear [drift] (Hz over the message): the sync
 *  score, and when [soft] is given the soft symbols (0-255) written there. As wsprd's sync_and_demodulate. */
function demod(id: Float32Array, qd: Float32Array, f0: number, lag: number, drift: number, soft?: Uint8Array): number {
  const np = id.length, w = 2 * Math.PI / FS; let ss = 0, tot = 0;
  const fs = soft ? new Float32Array(NSYM) : null;
  for (let i = 0; i < NSYM; i++) {
    const fp = f0 + (drift / 2) * (i - 81) / 81, p = [0, 0, 0, 0];
    for (let t = 0; t < 4; t++) {
      const d = w * (fp + (t - 1.5) * DF), cd = Math.cos(d), sd = Math.sin(d);
      let c = 1, s = 0, re = 0, im = 0;
      const k0 = lag + i * SYM;
      for (let j = 0; j < SYM; j++) {
        const k = k0 + j;
        if (k > 0 && k < np) { re += id[k] * c + qd[k] * s; im += -id[k] * s + qd[k] * c; }
        const c2 = c * cd - s * sd; s = c * sd + s * cd; c = c2;
      }
      p[t] = Math.sqrt(re * re + im * im);
    }
    tot += p[0] + p[1] + p[2] + p[3];
    const cm = (p[1] + p[3]) - (p[0] + p[2]);
    ss += WSPR_SYNC[i] ? cm : -cm;
    if (fs) fs[i] = WSPR_SYNC[i] ? p[3] - p[1] : p[2] - p[0];
  }
  if (fs && soft) {
    let m = 0, m2 = 0; for (let i = 0; i < NSYM; i++) { m += fs[i] / NSYM; m2 += fs[i] * fs[i] / NSYM; }
    const fac = Math.sqrt(Math.max(1e-20, m2 - m * m));
    for (let i = 0; i < NSYM; i++) soft[i] = Math.max(0, Math.min(255, Math.round(Math.max(-128, Math.min(127, 50 * fs[i] / fac)) + 128)));
  }
  return tot > 0 ? ss / tot : 0;
}

/** The four searches of wsprd's refinement: best lag, best frequency (and drift), then the same on a finer grid. */
function refine(id: Float32Array, qd: Float32Array, c: Cand): void {
  const bestLag = (lo: number, hi: number, step: number) => { let b = c.shift, bs = -1e30; for (let l = lo; l <= hi; l += step) { const s = demod(id, qd, c.freq, l, c.drift); if (s > bs) { bs = s; b = l; } } c.shift = b; c.sync = bs; };
  const bestFreq = (step: number) => { let b = c.freq, bs = -1e30; for (let k = -2; k <= 2; k++) { const f = c.freq + k * step, s = demod(id, qd, f, c.shift, c.drift); if (s > bs) { bs = s; b = f; } } c.freq = b; c.sync = bs; };
  bestLag(c.shift - 128, c.shift + 128, 64);
  bestFreq(0.25);
  for (const dd of [0.5, -0.5]) { const s = demod(id, qd, c.freq, c.shift, c.drift + dd); if (s > c.sync) { c.drift += dd; c.sync = s; break; } }
  if (c.sync > 0.10) { bestLag(c.shift - 32, c.shift + 32, 16); bestFreq(0.05); }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export class WsprDecoder implements DigitalDecoder {
  readonly name = 'WSPR';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: WsprDecode[], slot: number) => void = () => {};
  /** Calls heard in full, for the hashed ones (type 3). */
  readonly hashes = new Map<number, string>();
  /** Milliseconds a slot's decoding may take (the worker does nothing else meanwhile). */
  budgetMs = 4000;
  private readonly RING = Math.ceil(FS * 130);
  private readonly ri = new Float32Array(this.RING); private readonly rq = new Float32Array(this.RING);
  private wpos = 0; private total = 0; private t0 = 0; private lastSlot = -1;
  private readonly fe = new WsprFrontEnd(48_000, (i, q) => { this.ri[this.wpos] = i; this.rq[this.wpos] = q; this.wpos = (this.wpos + 1) % this.RING; this.total++; });

  reset(): void { this.wpos = 0; this.total = 0; this.t0 = 0; this.lastSlot = -1; this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.fe.push(a, n);
    const now = Date.now(), est = now - (this.total / FS + this.fe.delayS) * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.02 * (est - this.t0);
    const slot = Math.floor(now / (WSPR_SLOT_S * 1000)), into = now - slot * WSPR_SLOT_S * 1000;
    if (slot === this.lastSlot || into < 114_500) return;
    this.lastSlot = slot;
    // the slot's first 114 s; whatever came before the receiver started is silence
    const first = Math.round((slot * WSPR_SLOT_S * 1000 - this.t0) / 1000 * FS), id = new Float32Array(NPOINTS), qd = new Float32Array(NPOINTS);
    let have = 0;
    for (let k = 0; k < NPOINTS; k++) { const s = first + k; if (s >= 0 && s < this.total && this.total - s <= this.RING) { id[k] = this.ri[s % this.RING]; qd[k] = this.rq[s % this.RING]; have++; } }
    if (have < NPOINTS / 2) return;
    const list = this.decodeBuffer(id, qd, slot * WSPR_SLOT_S * 1000);
    if (list.length) this.onDecodes(list, slot);
  }

  /** 114 s of 375 Hz complex baseband (1500 Hz audio at 0 Hz) starting on the even minute. */
  decodeBuffer(id: Float32Array, qd: Float32Array, slotMs = 0): WsprDecode[] {
    const started = Date.now(), np = id.length;
    // half-symbol-step spectra: 512-point FFTs (two symbols, sine window), bins of half a tone
    const nffts = 4 * Math.floor(np / 512) - 1, ps: Float32Array[] = [];
    const re = new Float32Array(512), im = new Float32Array(512), win = Float32Array.from({ length: 512 }, (_, i) => Math.sin(0.006147931 * i));
    for (let i = 0; i < nffts; i++) {
      for (let j = 0; j < 512; j++) { const k = i * 128 + j; re[j] = k < np ? id[k] * win[j] : 0; im[j] = k < np ? qd[k] * win[j] : 0; }
      fft(re, im);
      const row = new Float32Array(512);
      for (let j = 0; j < 512; j++) { let k = j + 256; if (k > 511) k -= 512; row[j] = re[k] * re[k] + im[k] * im[k]; }
      ps.push(row);
    }
    const df2 = FS / 512, avg = new Float32Array(512);
    for (const row of ps) for (let j = 0; j < 512; j++) avg[j] += row[j];
    const sm = new Float32Array(411);
    for (let i = 0; i < 411; i++) for (let j = -3; j <= 3; j++) sm[i] += avg[256 - 205 + i + j];
    const noise = Float32Array.from(sm).sort()[122] || 1e-20, minSnr = 10 ** (-8 / 10);
    for (let j = 0; j < 411; j++) { sm[j] = sm[j] / noise - 1; if (sm[j] < minSnr) sm[j] = 0.1 * minSnr; }
    let cands: Cand[] = [];
    for (let j = 1; j < 410 && cands.length < 200; j++) {
      if (sm[j] > sm[j - 1] && sm[j] > sm[j + 1]) { const f = (j - 205) * df2; if (f >= -110 && f <= 110) cands.push({ freq: f, snr: 10 * Math.log10(sm[j]) - 26.3, shift: 0, drift: 0, sync: 0 }); }
    }
    cands.sort((a, b) => b.snr - a.snr);
    // coarse: frequency ±2 bins, start -10..21 half symbols, drift ±4 Hz, against the sync vector on the spectra
    const amp = ps.map(r => r.map(Math.sqrt));
    for (const c of cands) {
      let smax = -1e30; const if0 = Math.round(c.freq / df2) + 256;
      for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) for (let k0 = -10; k0 < 22; k0++) for (let idrift = -4; idrift <= 4; idrift++) {
        let ss = 0, pw = 0;
        for (let k = 0; k < NSYM; k++) {
          const ifd = Math.trunc(ifr + (k - 81) / 81 * idrift / (2 * df2)), ki = k0 + 2 * k;
          if (ki < 0 || ki >= nffts || ifd < 3 || ifd > 508) continue;
          const r = amp[ki], p0 = r[ifd - 3], p1 = r[ifd - 1], p2 = r[ifd + 1], p3 = r[ifd + 3];
          ss += (2 * WSPR_SYNC[k] - 1) * ((p1 + p3) - (p0 + p2)); pw += p0 + p1 + p2 + p3;
        }
        const s = pw > 0 ? ss / pw : 0;
        if (s > smax) { smax = s; c.shift = 128 * (k0 + 1); c.drift = idrift; c.freq = (ifr - 256) * df2; c.sync = s; }
      }
    }
    for (const c of cands) { if (Date.now() - started > this.budgetMs) break; refine(id, qd, c); }
    // one per signal: the best of any two within 0.05 Hz and 16 samples of each other, above the sync threshold
    const keep: Cand[] = [];
    for (const c of cands) {
      const k = keep.findIndex(x => Math.abs(x.freq - c.freq) < 0.05 && Math.abs(x.shift - c.shift) < 16);
      if (k >= 0) { if (c.sync > keep[k].sync) keep[k] = c; } else if (c.sync > 0.12) keep.push(c);
    }
    cands = keep;
    const out: WsprDecode[] = [], soft = new Uint8Array(NSYM), d = new Date(slotMs);
    const utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
    for (const c of cands) {
      if (Date.now() - started > this.budgetMs) break;
      for (let idt = 0; idt <= 16; idt++) {
        let ii = (idt + 1) >> 1; if (idt % 2 === 1) ii = -ii; ii *= 8;
        demod(id, qd, c.freq, c.shift + ii, c.drift, soft);
        let sq = 0; for (let i = 0; i < NSYM; i++) { const y = soft[i] - 128; sq += y * y; }
        if (Math.sqrt(sq / NSYM) <= 52 * 50 / 64) continue;
        const data = wsprStackDecode(wsprDeinterleave(soft));
        const msg = data && wsprUnpack(data, this.hashes);
        if (!msg) { if (Date.now() - started > this.budgetMs) break; continue; }
        if (!out.some(o => o.msg.text === msg.text && Math.abs(o.hz - (AUDIO_CENTRE + c.freq)) < 4)) {
          const x: WsprDecode = { utc, snr: Math.round(c.snr), dt: Math.round((c.shift / FS - 1) * 10) / 10, hz: Math.round(AUDIO_CENTRE + c.freq), drift: Math.round(c.drift) || 0, text: msg.text, msg };
          out.push(x); this.onText(msg.text, `WSPR ${x.snr} dB ${x.hz} Hz`);
        }
        break;
      }
    }
    this.confidence = out.length ? 1 : this.confidence * 0.8;
    return out;
  }
}
