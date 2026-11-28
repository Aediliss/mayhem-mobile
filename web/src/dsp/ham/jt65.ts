/**
 * FORK: JT65 (A, B and C) on the HAM receiver's USB audio, receive only. After WSJT-X (GPL-3.0): lib/gen65.f90 and
 * setup65.f90 (the 126-symbol frame and its pseudo-random sync pattern), interleave63.f90, igray.c, wrapkarn.c (the
 * RS(63,12) code's symbol order), lib/packjt.f90 (the 72-bit messages: two 28-bit calls and a 15-bit grid / report, or
 * 13 characters of free text); the Reed-Solomon codec is Phil Karn's (KA9Q, init_rs / encode_rs / decode_rs, "may be
 * used under the terms of the GNU General Public License"), ported here.
 *  - 60 s slots, the transmission 1 s in: 126 symbols of 4096/11025 s (0.3715 s); a symbol is the sync tone (63 of them,
 *    at the pattern's 1s) or one of 64 data tones 2 to 65 spacings above it (spacing 2.69 Hz for A, ×2 for B, ×4 for C);
 *  - 12 six-bit symbols of message → RS(63,12) over GF(64) (x^6+x+1, first root α^3) → 7×9 interleaver → Gray code.
 * Receiver: audio resampled to 5512.5 Hz (a symbol is 2048 samples); spectra every half symbol with half-tone bins; the
 * sync tone found against the pattern over 200-2700 Hz and DT −2..+4 s; each candidate's 63 data symbols measured on
 * their 64 tones at the refined frequency and time; hard decisions, ranked by how far the best tone stands above the
 * second; RS decoded by Berlekamp-Massey with the least reliable symbols erased (none, then more and more, then random
 * reliability-weighted sets, after the idea of K9AN's stochastic erasures); a decode must agree with the received tones
 * well enough to rule out a false one. EME shorthands (RO / RRR / 73 as tone pairs) and the type-1 prefix table are not
 * handled.
 */
import { fft } from '../../fft.js';
import { ftxShared } from './ft8.js';
import type { DigitalDecoder } from './digital.js';

// ---- Reed-Solomon (Karn), GF(64) ------------------------------------------------------------------------------------------
const MM = 6, NN = 63, NROOTS = 51, FCR = 3, PRIM = 1, A0 = NN, KK = NN - NROOTS;
const ALPHA = new Int32Array(NN + 1), INDEX = new Int32Array(NN + 1), GENPOLY = new Int32Array(NROOTS + 1);
const modnn = (x: number) => { while (x >= NN) { x -= NN; x = (x >> MM) + (x & NN); } return x; };
(() => {
  INDEX[0] = A0; ALPHA[A0] = 0; let sr = 1;
  for (let i = 0; i < NN; i++) { INDEX[sr] = i; ALPHA[i] = sr; sr <<= 1; if (sr & (1 << MM)) sr ^= 0x43; sr &= NN; }
  GENPOLY[0] = 1;
  for (let i = 0, root = FCR * PRIM; i < NROOTS; i++, root += PRIM) {
    GENPOLY[i + 1] = 1;
    for (let j = i; j > 0; j--) GENPOLY[j] = GENPOLY[j] !== 0 ? GENPOLY[j - 1] ^ ALPHA[modnn(INDEX[GENPOLY[j]] + root)] : GENPOLY[j - 1];
    GENPOLY[0] = ALPHA[modnn(INDEX[GENPOLY[0]] + root)];
  }
  for (let i = 0; i <= NROOTS; i++) GENPOLY[i] = INDEX[GENPOLY[i]];
})();
function encodeRs(data: ArrayLike<number>): Int32Array {
  const bb = new Int32Array(NROOTS);
  for (let i = 0; i < KK; i++) {
    const fb = INDEX[data[i] ^ bb[0]];
    if (fb !== A0) for (let j = 1; j < NROOTS; j++) bb[j] ^= ALPHA[modnn(fb + GENPOLY[NROOTS - j])];
    bb.copyWithin(0, 1); bb[NROOTS - 1] = fb !== A0 ? ALPHA[modnn(fb + GENPOLY[0])] : 0;
  }
  return bb;
}
/** Karn's decode_rs: [data] (63 symbols, data then parity) corrected in place; [eras] erasure positions. Returns the
 *  number of symbols corrected, or -1. */
function decodeRs(data: Int32Array, eras: number[]): number {
  const s = new Int32Array(NROOTS), lambda = new Int32Array(NROOTS + 1), b = new Int32Array(NROOTS + 1), t = new Int32Array(NROOTS + 1);
  const omega = new Int32Array(NROOTS + 1), root = new Int32Array(NROOTS), reg = new Int32Array(NROOTS + 1), loc = new Int32Array(NROOTS);
  for (let i = 0; i < NROOTS; i++) s[i] = data[0];
  for (let j = 1; j < NN; j++) for (let i = 0; i < NROOTS; i++) s[i] = s[i] === 0 ? data[j] : data[j] ^ ALPHA[modnn(INDEX[s[i]] + (FCR + i) * PRIM)];
  let synErr = 0; for (let i = 0; i < NROOTS; i++) { synErr |= s[i]; s[i] = INDEX[s[i]]; }
  if (!synErr) return 0;
  lambda[0] = 1; const ne = eras.length;
  if (ne > 0) {
    lambda[1] = ALPHA[modnn(PRIM * (NN - 1 - eras[0]))];
    for (let i = 1; i < ne; i++) { const u = modnn(PRIM * (NN - 1 - eras[i])); for (let j = i + 1; j > 0; j--) { const tmp = INDEX[lambda[j - 1]]; if (tmp !== A0) lambda[j] ^= ALPHA[modnn(u + tmp)]; } }
  }
  for (let i = 0; i < NROOTS + 1; i++) b[i] = INDEX[lambda[i]];
  let r = ne, el = ne;
  while (++r <= NROOTS) {
    let d = 0; for (let i = 0; i < r; i++) if (lambda[i] !== 0 && s[r - i - 1] !== A0) d ^= ALPHA[modnn(INDEX[lambda[i]] + s[r - i - 1])];
    d = INDEX[d];
    if (d === A0) { b.copyWithin(1, 0, NROOTS); b[0] = A0; continue; }
    t[0] = lambda[0];
    for (let i = 0; i < NROOTS; i++) t[i + 1] = b[i] !== A0 ? lambda[i + 1] ^ ALPHA[modnn(d + b[i])] : lambda[i + 1];
    if (2 * el <= r + ne - 1) { el = r + ne - el; for (let i = 0; i <= NROOTS; i++) b[i] = lambda[i] === 0 ? A0 : modnn(INDEX[lambda[i]] - d + NN); }
    else { b.copyWithin(1, 0, NROOTS); b[0] = A0; }
    lambda.set(t);
  }
  let degL = 0; for (let i = 0; i < NROOTS + 1; i++) { lambda[i] = INDEX[lambda[i]]; if (lambda[i] !== A0) degL = i; }
  for (let i = 1; i <= NROOTS; i++) reg[i] = lambda[i];
  let count = 0;
  for (let i = 1, k = 0; i <= NN; i++, k = modnn(k + 1)) {   // IPRIM = 1 for prim = 1, so k starts at IPRIM-1 = 0
    let q = 1;
    for (let j = degL; j > 0; j--) if (reg[j] !== A0) { reg[j] = modnn(reg[j] + j); q ^= ALPHA[reg[j]]; }
    if (q !== 0) continue;
    root[count] = i; loc[count] = k;
    if (++count === degL) break;
  }
  if (degL !== count) return -1;
  const degO = degL - 1;
  for (let i = 0; i <= degO; i++) { let tmp = 0; for (let j = i; j >= 0; j--) if (s[i - j] !== A0 && lambda[j] !== A0) tmp ^= ALPHA[modnn(s[i - j] + lambda[j])]; omega[i] = INDEX[tmp]; }
  for (let j = count - 1; j >= 0; j--) {
    let num1 = 0; for (let i = degO; i >= 0; i--) if (omega[i] !== A0) num1 ^= ALPHA[modnn(omega[i] + i * root[j])];
    const num2 = ALPHA[modnn(root[j] * (FCR - 1) + NN)];
    let den = 0; for (let i = Math.min(degL, NROOTS - 1) & ~1; i >= 0; i -= 2) if (lambda[i + 1] !== A0) den ^= ALPHA[modnn(lambda[i + 1] + i * root[j])];
    if (den === 0) return -1;
    if (num1 !== 0) data[loc[j]] ^= ALPHA[modnn(INDEX[num1] + INDEX[num2] + NN - INDEX[den])];
  }
  return count;
}

/** 12 message symbols (dgen, 6 bits each) → the 63 transmitted RS symbols in WSJT-X's order (parity reversed, then
 *  the message), as wrapkarn's rs_encode. */
export function jt65RsEncode(dgen: ArrayLike<number>): Int32Array {
  const dat1 = Int32Array.from({ length: 12 }, (_, i) => dgen[11 - i]), b = encodeRs(dat1), sent = new Int32Array(63);
  for (let i = 0; i < 51; i++) sent[50 - i] = b[i];
  for (let i = 0; i < 12; i++) sent[i + 51] = dat1[11 - i];
  return sent;
}
/** 63 received symbols (WSJT-X's order) and erasures (positions in it) → the 12 message symbols, or null. */
export function jt65RsDecode(recd0: ArrayLike<number>, eras: number[] = []): { dgen: Int32Array; nerr: number } | null {
  const recd = new Int32Array(63);
  for (let i = 0; i < 12; i++) recd[i] = recd0[62 - i];
  for (let i = 0; i < 51; i++) recd[12 + i] = recd0[50 - i];
  const n = decodeRs(recd, eras.map(p => 62 - p));
  if (n < 0) return null;
  return { dgen: Int32Array.from({ length: 12 }, (_, i) => recd[11 - i]), nerr: n };
}

// ---- interleaving, Gray code, the sync pattern ----------------------------------------------------------------------------
export function jt65Interleave(d: ArrayLike<number>): Int32Array { const o = new Int32Array(63); for (let i = 0; i < 7; i++) for (let j = 0; j < 9; j++) o[j + 9 * i] = d[i + 7 * j]; return o; }
export function jt65Deinterleave(d: ArrayLike<number>): Int32Array { const o = new Int32Array(63); for (let i = 0; i < 7; i++) for (let j = 0; j < 9; j++) o[i + 7 * j] = d[j + 9 * i]; return o; }
const gray = (n: number) => n ^ (n >> 1);
const ungray = (n: number) => { let x = n; for (let s = n >> 1; s; s >>= 1) x ^= s; return x; };
export const JT65_SYNC = Uint8Array.from([
  1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1,
  0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1,
  1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1,
  1, 1, 1, 1, 1, 1]);
const DATA_AT = (() => { const a: number[] = []; JT65_SYNC.forEach((v, i) => { if (!v) a.push(i); }); return a; })();

/** 12 message symbols → 126 tones (0 = sync, 2..65 = data), as gen65. */
export function jt65Tones(dgen: ArrayLike<number>): Uint8Array {
  const sent = jt65Interleave(jt65RsEncode(dgen)).map(gray), t = new Uint8Array(126);
  DATA_AT.forEach((at, k) => { t[at] = sent[k] + 2; });
  return t;
}

// ---- messages (packjt.f90) ------------------------------------------------------------------------------------------------
const NBASE = 37 * 36 * 10 * 27 * 27 * 27, NGBASE = 180 * 180;
const C37 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
const nchar = (c: string) => c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : 36;
function packCall(call: string): number {
  if (call === 'CQ') return NBASE + 1;
  if (call === 'QRZ') return NBASE + 2;
  if (call === 'DE') return 267796945;
  let c = call; if (c.startsWith('3DA0')) c = '3D0' + c.slice(4); if (/^3X[A-Z]/.test(c)) c = 'Q' + c.slice(2);
  let tmp: string;
  if (/[0-9]/.test(c[2] ?? '')) tmp = c.padEnd(6); else if (/[0-9]/.test(c[1] ?? '') && c.length <= 5) tmp = ` ${c}`.padEnd(6); else return -1;
  if (tmp.length > 6 || !/^[A-Z0-9 ][A-Z0-9][0-9][A-Z ][A-Z ][A-Z ]$/.test(tmp)) return -1;
  let n = nchar(tmp[0]); n = 36 * n + nchar(tmp[1]); n = 10 * n + nchar(tmp[2]);
  n = 27 * n + nchar(tmp[3]) - 10; n = 27 * n + nchar(tmp[4]) - 10; n = 27 * n + nchar(tmp[5]) - 10;
  return n;
}
function unpackCall(n: number): { word: string; iv2: number; psfx: string } {
  if (n < 262177560) {
    const w: string[] = [];
    w[5] = C37[n % 27 + 10]; n = Math.floor(n / 27); w[4] = C37[n % 27 + 10]; n = Math.floor(n / 27); w[3] = C37[n % 27 + 10]; n = Math.floor(n / 27);
    w[2] = C37[n % 10]; n = Math.floor(n / 10); w[1] = C37[n % 36]; n = Math.floor(n / 36); w[0] = C37[n] ?? ' ';
    let word = w.join('').trim();
    if (word.startsWith('3D0')) word = '3DA0' + word.slice(3); else if (/^Q[A-Z]/.test(word)) word = '3X' + word.slice(1);
    return { word, iv2: 0, psfx: '' };
  }
  const p4 = (m: number) => { let s = ''; for (let i = 0; i < 3; i++) { s = C37[m % 37] + s; m = Math.floor(m / 37); } return (C37[m] + s).trim(); };
  const p3 = (m: number) => { let s = ''; for (let i = 0; i < 2; i++) { s = C37[m % 37] + s; m = Math.floor(m / 37); } return (C37[m] + s).trim(); };
  if (n >= 262178563 && n <= 264002071) return { word: '', iv2: 1, psfx: p4(n - 262178563) };
  if (n >= 264002072 && n <= 265825580) return { word: '', iv2: 2, psfx: p4(n - 264002072) };
  if (n >= 265825581 && n <= 267649089) return { word: '', iv2: 3, psfx: p4(n - 265825581) };
  if (n >= 267649090 && n <= 267698374) return { word: '', iv2: 4, psfx: p3(n - 267649090) };
  if (n >= 267698375 && n <= 267747659) return { word: '', iv2: 5, psfx: p3(n - 267698375) };
  if (n >= 267747660 && n <= 267796944) return { word: '', iv2: 6, psfx: p3(n - 267747660) };
  if (n === 267796945) return { word: '', iv2: 7, psfx: '' };
  return { word: '......', iv2: -1, psfx: '' };
}
function deg2grid4(dlong: number, dlat: number): string {   // west-positive longitude, as WSJT-X
  const nlong = Math.trunc(60 * (180 - dlong) / 5), a1 = Math.trunc(nlong / 240), a2 = Math.trunc((nlong - 240 * a1) / 24);
  const nlat = Math.trunc(60 * (dlat + 90) / 2.5), b1 = Math.trunc(nlat / 240), b2 = Math.trunc((nlat - 240 * b1) / 24);
  return String.fromCharCode(65 + a1, 65 + b1) + a2 + b2;
}
function unpackGrid(ng: number): string {
  if (ng < NGBASE) {
    const dlat = ng % 180 - 90, dlong = Math.floor(ng / 180) * 2 - 180 + 2, g = deg2grid4(dlong, dlat);
    if (g.startsWith('KA')) { const n = Number(g.slice(2)) - 50; return `${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`; }
    if (g.startsWith('LA')) { const n = Number(g.slice(2)) - 50; return `R${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`; }
    return g;
  }
  const n = ng - NGBASE - 1;
  if (n >= 1 && n <= 30) return `-${String(n).padStart(2, '0')}`;
  if (n >= 31 && n <= 60) return `R-${String(n - 30).padStart(2, '0')}`;
  return n === 61 ? 'RO' : n === 62 ? 'RRR' : n === 63 ? '73' : '';
}
const GRID_NG = (() => { const m = new Map<string, number>(); for (let ng = 0; ng < NGBASE; ng++) { const g = unpackGrid(ng); if (!m.has(g)) m.set(g, ng); } return m; })();
function packGrid(g: string): number {
  if (!g) return NGBASE + 1;
  let m: RegExpExecArray | null;
  if ((m = /^-(\d\d)$/.exec(g)) && +m[1] >= 1 && +m[1] <= 30) return NGBASE + 1 + +m[1];
  if ((m = /^R-(\d\d)$/.exec(g)) && +m[1] >= 1 && +m[1] <= 30) return NGBASE + 31 + +m[1];
  if (g === 'RO') return NGBASE + 62; if (g === 'RRR') return NGBASE + 63; if (g === '73') return NGBASE + 64;
  return GRID_NG.get(g) ?? -1;
}
const TXT = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?';
function packText(msg: string): [number, number, number] {
  const code = (c: string | undefined) => { const j = TXT.indexOf(c ?? ' '); return j < 0 ? 36 : j; };
  let a = 0, b = 0, c = 0; const m = msg.padEnd(13);
  for (let i = 0; i < 5; i++) a = 42 * a + code(m[i]);
  for (let i = 5; i < 10; i++) b = 42 * b + code(m[i]);
  for (let i = 10; i < 13; i++) c = 42 * c + code(m[i]);
  a = 2 * a + ((c & 32768) ? 1 : 0); b = 2 * b + ((c & 65536) ? 1 : 0); c &= 32767;
  return [a, b, c + 32768];
}
function unpackText(a: number, b: number, c: number): string {
  c &= 32767; if (a & 1) c += 32768; a = Math.floor(a / 2); if (b & 1) c += 65536; b = Math.floor(b / 2);
  const out: string[] = [];
  for (let i = 4; i >= 0; i--) { out[i] = TXT[a % 42]; a = Math.floor(a / 42); }
  for (let i = 9; i >= 5; i--) { out[i] = TXT[b % 42]; b = Math.floor(b / 42); }
  for (let i = 12; i >= 10; i--) { out[i] = TXT[c % 42]; c = Math.floor(c / 42); }
  return out.join('').trimEnd();
}
function toSymbols(nc1: number, nc2: number, ng: number): Int32Array {
  const d = new Int32Array(12);
  d[0] = (nc1 >>> 22) & 63; d[1] = (nc1 >>> 16) & 63; d[2] = (nc1 >>> 10) & 63; d[3] = (nc1 >>> 4) & 63;
  d[4] = 4 * (nc1 & 15) + ((nc2 >>> 26) & 3); d[5] = (nc2 >>> 20) & 63; d[6] = (nc2 >>> 14) & 63; d[7] = (nc2 >>> 8) & 63;
  d[8] = (nc2 >>> 2) & 63; d[9] = 16 * (nc2 & 3) + ((ng >>> 12) & 15); d[10] = (ng >>> 6) & 63; d[11] = ng & 63;
  return d;
}
/** A message ("CQ K1ABC FN42", "K1ABC W9XYZ -15", "W9XYZ K1ABC RRR", or free text up to 13 characters) → the 12
 *  message symbols. Standard messages only take plain calls (no prefixes / suffixes). */
export function jt65Pack(msg: string): Int32Array {
  const m = msg.trim().toUpperCase().replace(/\s+/g, ' '), w = m.split(' ');
  let cq = w[0] === 'CQ' && w.length >= 2 && /^\d{3}$/.test(w[1]) ? NBASE + 3 + Number(w[1]) : -1;
  const parts = cq >= 0 ? [w[2], w[3] ?? ''] : [w[1], w[2] ?? ''];
  if (w.length >= 2 && w.length <= (cq >= 0 ? 4 : 3)) {
    const nc1 = cq >= 0 ? cq : packCall(w[0]), nc2 = packCall(parts[0] ?? ''), ng = packGrid(parts[1]);
    if (nc1 >= 0 && nc2 >= 0 && ng >= 0) return toSymbols(nc1, nc2, ng);
  }
  cq = 0;
  const [a, b, c] = packText(m.slice(0, 13));
  return toSymbols(a, b, c);
}
/** The 12 message symbols → the message, as unpackmsg (null for a type-1 prefix / suffix it cannot spell). */
export function jt65Unpack(d: ArrayLike<number>): string | null {
  const nc1 = d[0] * 2 ** 22 + d[1] * 2 ** 16 + d[2] * 2 ** 10 + d[3] * 16 + ((d[4] >> 2) & 15);
  const nc2 = (d[4] & 3) * 2 ** 26 + d[5] * 2 ** 20 + d[6] * 2 ** 14 + d[7] * 256 + d[8] * 4 + ((d[9] >> 4) & 3);
  const ng = (d[9] & 15) * 4096 + d[10] * 64 + d[11];
  if (ng >= 32768) return unpackText(nc1, nc2, ng);
  const special = nc1 >= NBASE && nc1 <= NBASE + 1002;   // CQ, QRZ, CQ nnn: past the calls, below the v2 range
  const a = special ? { word: '', iv2: 0, psfx: '' } : unpackCall(nc1), b = unpackCall(nc2), grid = unpackGrid(ng);
  if (b.iv2 !== 0 || b.word === '......') return null;
  if (a.iv2 > 0) {
    const g = grid ? ` ${grid}` : '';
    return [`CQ ${a.psfx}/${b.word}`, `QRZ ${a.psfx}/${b.word}`, `DE ${a.psfx}/${b.word}`, `CQ ${b.word}/${a.psfx}`, `QRZ ${b.word}/${a.psfx}`, `DE ${b.word}/${a.psfx}`, `DE ${b.word}`][a.iv2 - 1] + g;
  }
  if (!special && (a.iv2 < 0 || a.word === '......')) return null;
  let c1 = a.word;
  if (nc1 === NBASE + 1) c1 = 'CQ'; else if (nc1 === NBASE + 2) c1 = 'QRZ';
  else if (special && nc1 - NBASE - 3 >= 0 && nc1 - NBASE - 3 <= 999) c1 = `CQ ${String(nc1 - NBASE - 3).padStart(3, '0')}`;
  else if (special) return null;
  if (/^[A-R]R[5-9]\d$/.test(grid)) return null;   // a type-1 prefix / suffix in the polar grid rows (not handled)
  let msg = `${c1} ${b.word}${grid ? ` ${grid}` : ''}`;
  if (msg.startsWith('CQ9DX ')) msg = 'CQ DX ' + msg.slice(6);
  if (/^E9[A-Z]{2} /.test(msg)) msg = 'CQ ' + msg.slice(2);
  if (/^CQ 00\d/.test(msg)) msg = 'CQ ' + msg.slice(5);
  return msg;
}

// ---- test signal ----------------------------------------------------------------------------------------------------------
export const JT65_SYMBOL_S = 4096 / 11025;
export const JT65_SPACING = 11025 / 4096;
/** Tones → real audio at [rate] (tests): [syncHz] is the sync tone, data tones (n+2)·spacing·[sub] above it. */
export function jt65Audio(tones: ArrayLike<number>, syncHz: number, rate: number, sub = 1, amp = 1): Float32Array {
  const out = new Float32Array(Math.round(tones.length * JT65_SYMBOL_S * rate)); let ph = 0;
  for (let k = 0; k < out.length; k++) { const s = Math.min(tones.length - 1, Math.floor(k / (JT65_SYMBOL_S * rate))); out[k] = amp * Math.sin(ph); ph += 2 * Math.PI * (syncHz + tones[s] * JT65_SPACING * sub) / rate; }
  return out;
}

// ---- the receiver ---------------------------------------------------------------------------------------------------------
const FS = 11025 / 2, SYM = 2048, NF = 4096, HALF = SYM / 2;   // 5512.5 Hz; bins of half a spacing
export interface Jt65Decode { utc: string; snr: number; dt: number; hz: number; text: string }
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Power of tone frequency [f] (Hz) in the symbol starting at sample [t0], by direct correlation. */
function tonePow(x: Float32Array, t0: number, f: number): number {
  let re = 0, im = 0; const w = 2 * Math.PI * f / FS, cw = Math.cos(w), sw = Math.sin(w); let c = 1, s = 0;
  for (let j = 0; j < SYM; j++) { const v = x[t0 + j] ?? 0; re += v * c; im -= v * s; const c2 = c * cw - s * sw; s = c * sw + s * cw; c = c2; }
  return re * re + im * im;
}

export class Jt65Decoder implements DigitalDecoder {
  readonly name = 'JT65';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Jt65Decode[], slot: number) => void = () => {};
  /** Submode: 1 (A), 2 (B), 4 (C): the data tones' spacing in 2.69 Hz steps. */
  sub = 1;
  budgetMs = 4000;
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private readonly ring = new Float32Array(Math.ceil(FS * 70)); private wpos = 0; private total = 0; private t0 = 0; private lastSlot = -1;

  reset(): void { this.wpos = 0; this.total = 0; this.t0 = 0; this.lastSlot = -1; this.rs.reset(); this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.ring[this.wpos] = v; this.wpos = (this.wpos + 1) % this.ring.length; this.total++; });
    const now = Date.now(), est = now - this.total / FS * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.02 * (est - this.t0);
    const slot = Math.floor(now / 60_000), into = now - slot * 60_000;
    if (slot === this.lastSlot || into < 52_000) return;
    this.lastSlot = slot;
    const n0 = Math.round(52 * FS), first = Math.round((slot * 60_000 - this.t0) / 1000 * FS), buf = new Float32Array(n0), L = this.ring.length;
    let have = 0;
    for (let k = 0; k < n0; k++) { const s = first + k; if (s >= 0 && s < this.total && this.total - s <= L) { buf[k] = this.ring[s % L]; have++; } }
    if (have < n0 / 2) return;
    const list = this.decodeBuffer(buf, slot * 60_000);
    if (list.length) this.onDecodes(list, slot);
  }

  /** 52 s of 5512.5 Hz audio from the start of the minute. */
  decodeBuffer(x: Float32Array, slotMs = 0): Jt65Decode[] {
    const started = Date.now(), nfr = Math.floor((x.length - SYM) / HALF) + 1, BIN = FS / NF;   // 1.346 Hz
    const lo = Math.round(200 / BIN), hi = Math.round(2700 / BIN), W = hi - lo + 1;
    // spectra every half symbol, Hann, zero-padded to two symbols: half-spacing bins
    const P: Float32Array[] = [], re = new Float32Array(NF), im = new Float32Array(NF), win = Float32Array.from({ length: SYM }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / SYM));
    for (let k = 0; k < nfr; k++) {
      re.fill(0); im.fill(0); for (let j = 0; j < SYM; j++) re[j] = x[k * HALF + j] * win[j];
      fft(re, im);
      const row = new Float32Array(W); for (let b = 0; b < W; b++) { const j = lo + b; row[b] = re[j] * re[j] + im[j] * im[j]; }
      P.push(row);
    }
    // each bin against its median over time (the waterfall flattened)
    // each bin against its median over time (the waterfall flattened); bins far below the band's typical level (outside
    // the receiver's audio filter, or empty) are left out rather than blown up
    const meds = Float32Array.from({ length: W }, (_, b) => Float32Array.from(P, r => r[b]).sort()[P.length >> 1]);
    const typical = Float32Array.from(meds).sort()[W >> 1] || 1e-20;
    for (let b = 0; b < W; b++) { const m = meds[b]; for (const r of P) r[b] = m > 1e-3 * typical ? r[b] / m : 0; }
    // sync: the pattern's 1s against its 0s, symbol i at frame t0 + 2i, for DT −2..+4 s
    const lag0 = Math.round((1 - 2) * FS / HALF), lag1 = Math.round((1 + 4) * FS / HALF);
    const best = new Float32Array(W), bestLag = new Int32Array(W);
    for (let b = 0; b < W; b++) {
      let bv = -1e9, bl = 0;
      for (let lag = lag0; lag <= lag1; lag++) {
        let s1 = 0, s0 = 0, n1 = 0, n0 = 0;
        for (let i = 0; i < 126; i++) { const fr = lag + 2 * i; if (fr < 0 || fr >= nfr) continue; const v = P[fr][b]; if (JT65_SYNC[i]) { s1 += v; n1++; } else { s0 += v; n0++; } }
        if (!n1 || !n0) continue;
        const v = s1 / n1 - s0 / n0; if (v > bv) { bv = v; bl = lag; }
      }
      best[b] = bv; bestLag[b] = bl;
    }
    const sorted = Float32Array.from(best).sort(), med = sorted[W >> 1], mad = (sorted[Math.floor(W * 0.84)] - med) || 1e-6;
    const cands: { b: number; lag: number; v: number }[] = [];
    for (let b = 2; b < W - 2; b++) {
      const v = best[b]; if (v < med + 4 * mad || v < 0.5) continue;
      if (v < best[b - 1] || v < best[b + 1] || v < best[b - 2] || v < best[b + 2]) continue;
      cands.push({ b, lag: bestLag[b], v });
    }
    cands.sort((a, c) => c.v - a.v); cands.length = Math.min(cands.length, 30);
    const out: Jt65Decode[] = [], d = new Date(slotMs), utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`, sp = JT65_SPACING * this.sub;
    for (const c of cands) {
      if (Date.now() - started > this.budgetMs) break;
      // refine: sync tone frequency ±0.5 bin, start ±half a symbol, on the sync symbols' power
      let f = (lo + c.b) * BIN, t = c.lag * HALF;
      // nothing inside a decoded signal's band (its sync tone up to its top data tone): a strong signal's data tones look like sync
      if (out.some(o => f > o.hz - 2 * sp && f < o.hz + 66 * sp)) continue;
      const syncPow = (ff: number, tt: number) => { let s = 0; for (let i = 0; i < 126; i++) if (JT65_SYNC[i] && tt + i * SYM >= 0) s += tonePow(x, tt + i * SYM, ff); return s; };
      let bp = syncPow(f, t);
      for (const [df, dt] of [[0.33, 0], [-0.33, 0], [0, 256], [0, -256], [0, 128], [0, -128], [0.17, 0], [-0.17, 0], [0, 64], [0, -64]]) {
        const v = syncPow(f + df * BIN * 2, t + dt); if (v > bp) { bp = v; f += df * BIN * 2; t += dt; }
      }
      // the sync tone must follow the pattern: on in the sync symbols, off in the data ones (a carrier or another mode's
      // tones sit there throughout: ~1; JT65 at the decode limit: ~4)
      let on = 0, off = 0; for (let i = 0; i < 126; i++) { const p = tonePow(x, t + i * SYM, f); if (JT65_SYNC[i]) on += p; else off += p; }
      if (on / Math.max(1e-30, off) < 2) continue;
      // data symbols: 64 tone powers each
      const s = DATA_AT.map(at => Float32Array.from({ length: 64 }, (_, n) => tonePow(x, t + at * SYM, f + (n + 2) * sp)));
      const hard = new Int32Array(63), rel: { i: number; r: number }[] = [];
      s.forEach((row, k) => { let b1 = 0; for (let n = 1; n < 64; n++) if (row[n] > row[b1]) b1 = n; let p2 = 0; for (let n = 0; n < 64; n++) if (n !== b1 && row[n] > p2) p2 = row[n]; hard[k] = ungray(b1); rel.push({ i: k, r: row[b1] / (p2 || 1e-20) }); });
      // tone index k (data order) → the de-interleaved RS position
      const pos = jt65Deinterleave(Int32Array.from({ length: 63 }, (_, k) => k));   // pos[j] = which received symbol is RS symbol j
      const recd = new Int32Array(63), rsRel = new Float32Array(63);
      for (let j = 0; j < 63; j++) { recd[j] = hard[pos[j]]; rsRel[j] = rel[pos[j]].r; }
      const order = Array.from({ length: 63 }, (_, j) => j).sort((a, b2) => rsRel[a] - rsRel[b2]);
      const tryEras = (eras: number[]) => { const r = jt65RsDecode(recd, eras); if (!r) return null; return r; };
      // a decode must be the received tones: each decoded tone's power against its symbol's median (noise alone gives
      // ~1.4 on average, a false decode found through erasures ~2.6, a signal at the decode limit ~5): at least 3.5
      const med = s.map(row => Float32Array.from(row).sort()[32] || 1e-20);
      const accept = (dgen: Int32Array) => {
        const cw = jt65Interleave(jt65RsEncode(dgen)).map(gray); let z = 0;
        // a codeword with one tone far more often than chance (e.g. the near-all-zero message: a steady tone) is what a
        // carrier or another mode's tones can fake: messages give scattered tones
        const cnt = new Int32Array(64); for (const v of cw) cnt[v]++; if (Math.max(...cnt) > 12) return null;
        cw.forEach((v, k) => { z += s[k][v] / med[k]; });
        return z / 63 >= 3.5 ? cw : null;
      };
      const isText = (dgen: Int32Array) => ((dgen[9] & 15) * 4096 + dgen[10] * 64 + dgen[11]) >= 32768;
      const zOf = (cw: Int32Array) => { let z = 0; cw.forEach((v, k) => { z += s[k][v] / med[k]; }); return z / 63; };
      let msg: string | null = null;
      let okCw: Int32Array | null = null;
      const attempt = (eras: number[]) => { const r = tryEras(eras); if (!r) return false; const cw = accept(r.dgen); if (!cw) return false; if (isText(r.dgen) && zOf(cw) < 5) return false; /* free text: where false decodes land */ const m = jt65Unpack(r.dgen); if (!m) return false; msg = m; okCw = cw; return true; };
      let ok = attempt([]);
      for (let ne = 4; !ok && ne <= 48; ne += 4) ok = attempt(order.slice(0, ne).sort((a, b2) => a - b2));
      // stochastic erasures: each symbol erased with a probability that falls with its reliability rank
      let seed = c.b * 7919 + c.lag; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let trial = 0; !ok && trial < 1500 && Date.now() - started < this.budgetMs; trial++) {
        const eras: number[] = [];
        order.forEach((j, rank) => { const p = rank < 20 ? 0.75 : rank < 40 ? 0.45 : 0.1; if (rnd() < p && eras.length < 50) eras.push(j); });
        ok = attempt(eras.sort((a, b2) => a - b2));
      }
      if (!ok || !msg || !okCw) continue;
      // SNR in 2500 Hz: each decoded tone's power above its symbol's noise (median / ln 2 of a bin), as a ratio in the
      // symbol's own bandwidth (1 / 0.3715 s = 2.69 Hz), then −10·log10(2500 / 2.69) = −29.7 dB to 2500 Hz
      let ratio = 0; okCw!.forEach((v, k) => { const pn = med[k] / Math.LN2; ratio += Math.max(0, s[k][v] - pn) / pn; });
      const snr = Math.round(10 * Math.log10(Math.max(1e-3, ratio / 63)) - 10 * Math.log10(2500 * JT65_SYMBOL_S));
      const x0: Jt65Decode = { utc, snr, dt: Math.round((t / FS - 1) * 10) / 10, hz: Math.round(f), text: msg };
      // a decode inside a stronger one's band, found before it, is that one's echo: drop it
      for (let i = out.length - 1; i >= 0; i--) if (out[i].hz > f && out[i].hz < f + 66 * sp && out[i].snr < snr - 3) out.splice(i, 1);
      out.push(x0); this.onText(msg, `JT65 ${x0.hz} Hz`);
    }
    this.confidence = out.length ? 1 : this.confidence * 0.8;
    return out;
  }
}
