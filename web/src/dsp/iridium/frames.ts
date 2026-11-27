/**
 * FORK: Iridium frames, receive only, after iridium-toolkit (Sec & schneider, BSD-2-Clause: bitsparser.py, bch.py,
 * util.py, iridiumtk/reassembler/ida.py and sbd.py). A burst's bits (unique word first) are classified as iridium-toolkit
 * does (by frequency band and by which block code checks) and read:
 *  - IRA, ring alert (simplex band): the satellite and beam, the satellite's position, how many terminals are paged;
 *  - IBC, broadcast: the satellite and beam, Iridium time (era 3), channel assignments counted;
 *  - LCW frames (duplex band) by their frame type; IDA data fragments with their CRC, put back together into SBD
 *    messages and the ACARS inside them;
 *  - voice, IP, messaging (pager) and the rest are named and counted only: their content is not read.
 * BCH(31,21) with an overall parity bit, repaired by syndrome tables of one or two errors as bch.py builds them.
 * No DOM.
 */

const UW_BITS_DL = '001100000011000011110011', UW_BITS_UL = '110011000011110011111100';
const HEADER_MESSAGING = '00110011111100110011001111110011', HEADER_TL = '11' + '0'.repeat(94);
const RA_POLY = 1207, ACCH_POLY = 3545, HDR_POLY = 29;
/** Band edges iridium-toolkit uses to say which frames can be where (doppler, extractor error and SDR ppm allowed). */
const F_SIMPLEX = (1626104e3 - 36e3 - 1e3) * (1 - 100e-6), F_DUPLEX = (1625979e3 + 36e3 + 1e3) * (1 + 100e-6);
/** ERA3: Iridium time 0 is 2025-02-14T18:14:17Z (in use since 2026-01-14), counted in 90 ms frames. */
export const IRIDIUM_EPOCH_S = 1739556857;

/** The spans the app offers: the simplex band (ring alerts) at 2 MS/s, or the whole band at 10 MS/s (HackRF). */
export const IRIDIUM_SPANS: { name: string; centreHz: number; rateHz: number }[] = [
  { name: 'Ring alerts · 2 MS/s', centreHz: 1_625_800_000, rateHz: 2_000_000 },
  { name: 'Whole band · 10 MS/s', centreHz: 1_621_250_000, rateHz: 10_000_000 },
];

// ------------------------------------------------------------------------------------------------------------- BCH

const bitLen = (v: number) => v ? 32 - Math.clz32(v) : 0;
/** Remainder of `num` divided by `poly` over GF(2) (bch.py nndivide); both fit in 32 bits here. */
export function gfMod(poly: number, num: number): number {
  const pl = bitLen(poly);
  for (let b = bitLen(num); b >= pl; b = bitLen(num)) num ^= poly << (b - pl);
  return num >>> 0;
}
const syndromes = new Map<number, Map<number, [number, number]>>();
function synTable(poly: number, bits: number, errors: number): Map<number, [number, number]> {
  let t = syndromes.get(poly); if (t) return t;
  t = new Map();
  for (let a = 0; a < bits; a++) t.set(gfMod(poly, 1 << a), [1, 1 << a]);
  if (errors >= 2) for (let a = 0; a < bits; a++) for (let b = a + 1; b < bits; b++) { const v = (1 << a) | (1 << b), r = gfMod(poly, v); if (!t.has(r)) t.set(r, [2, v]); }
  syndromes.set(poly, t); return t;
}
const TABLES: Record<number, [number, number]> = { 29: [7, 1], 465: [14, 2], 41: [26, 1], 1897: [31, 2], 1207: [31, 2], 3545: [31, 2] };
/** Repair a codeword (bit string): [errors (−1 if beyond repair), data bits, check bits]. */
export function bchRepair(poly: number, bits: string): [number, string, string] {
  const deg = bitLen(poly) - 1, v = parseInt(bits, 2), r = gfMod(poly, v);
  let errs = 0, fixed = v;
  if (r) { const [w, e] = TABLES[poly] ?? [bits.length, 1], s = synTable(poly, w, e).get(r); if (!s) return [-1, bits.slice(0, -deg), bits.slice(-deg)]; errs = s[0]; fixed = (v ^ s[1]) >>> 0; }
  const out = fixed.toString(2).padStart(bits.length, '0');
  return [errs, out.slice(0, -deg), out.slice(-deg)];
}
/** One error by trying each bit (bch.py nrepair1), for the 6-bit broadcast header. */
function bchRepair1(poly: number, bits: string): [number, string] {
  const deg = bitLen(poly) - 1, v = parseInt(bits, 2);
  if (!gfMod(poly, v)) return [0, bits.slice(0, -deg)];
  for (let i = 0; i < bits.length; i++) if (!gfMod(poly, v ^ (1 << i))) return [1, (v ^ (1 << i)).toString(2).padStart(bits.length, '0').slice(0, -deg)];
  return [-1, bits.slice(0, -deg)];
}
const divides = (poly: number, bits: string) => gfMod(poly, parseInt(bits, 2)) === 0;
const ones = (s: string) => { let n = 0; for (const c of s) if (c === '1') n++; return n; };

// -------------------------------------------------------------------------------------------------- interleaving

const pairs = (g: string) => { const s: string[] = []; for (let z = 0; z + 1 < g.length; z += 2) s.push(g[z + 1] + g[z]); return s; };
export function deInterleave(g: string): [string, string] {
  const s = pairs(g); let even = '', odd = '';
  for (let x = s.length - 2; x >= 0; x -= 2) even += s[x];
  for (let x = s.length - 1; x >= 0; x -= 2) odd += s[x];
  return [odd, even];
}
export function deInterleave3(g: string): [string, string, string] {
  const s = pairs(g); let a = '', b = '', c = '';
  for (let x = s.length - 3; x >= 0; x -= 3) c += s[x];
  for (let x = s.length - 2; x >= 0; x -= 3) b += s[x];
  for (let x = s.length - 1; x >= 0; x -= 3) a += s[x];
  return [a, b, c];
}
const LCW_TBL = [40, 39, 36, 35, 32, 31, 28, 27, 24, 23, 20, 19, 16, 15, 12, 11, 8, 7, 4, 3, 41, 38, 37, 34, 33, 30, 29, 26, 25, 22, 21, 18, 17, 14, 13, 10, 9, 6, 5, 2, 1, 46, 45, 44, 43, 42];
export function deInterleaveLcw(bits: string): [string, string, string] {
  const l = LCW_TBL.map(x => bits[x - 1] ?? ''); return [l.slice(0, 7).join(''), l.slice(7, 20).join(''), l.slice(20).join('')];
}
const sliceExtra = (s: string, n: number): [string[], string] => { const b: string[] = []; for (let x = 0; x <= s.length; x += n) b.push(s.slice(x, x + n)); const extra = b.pop() ?? ''; return [b, extra]; };

// ------------------------------------------------------------------------------------------------------- frames

export type IridiumKind = 'IRA' | 'IBC' | 'IDA' | 'VOC' | 'IIP' | 'ISY' | 'IU3' | 'ILW' | 'IMS' | 'ITL' | 'IAQ';
export interface IridiumFrame {
  kind: IridiumKind; down: boolean; freqHz: number; ms: number;
  /** Satellite and beam (IRA, IBC). */
  sat?: number; beam?: number;
  /** The satellite's position (IRA): lat/lon (°) and height above the Earth (km); how many pages it carries. */
  lat?: number; lon?: number; altKm?: number; pages?: number;
  /** Iridium time (IBC type 1) as Unix seconds, and assignments in the broadcast. */
  timeS?: number; assignments?: number;
  /** IDA: continuation flag, counter, length, the data bytes, CRC result. */
  cont?: boolean; ctr?: number; len?: number; data?: number[]; crcOk?: boolean;
  /** LCW frame type (0 voice, 1 IP, 2 data, 3 in-band, 7 sync …). */
  ft?: number;
  /** Blocks repaired by the code. */
  fixed: number;
}

/** Each symbol's two bits the other way round: the demodulator's (gr-iridium's RAW) order ↔ iridium-toolkit's. */
export function symbolReverse(bits: string): string { let o = ''; for (let i = 0; i + 1 < bits.length; i += 2) o += bits[i + 1] + bits[i]; return bits.length % 2 ? o + bits[bits.length - 1] : o; }

/** Classify and read a burst's bits as the demodulator gives them (unique word first); null when nothing checks. */
export function parseIridium(raw: string, freqHz: number, down: boolean, ms = 0): IridiumFrame | null {
  const bits = symbolReverse(raw), uw = down ? UW_BITS_DL : UW_BITS_UL;
  if (bits.slice(0, 24) !== uw) return null;
  const data = bits.slice(24), base = { down, freqHz, ms, fixed: 0 };
  const simplexOk = freqHz > F_SIMPLEX && down, duplexOk = freqHz < F_DUPLEX;
  if (simplexOk && data.slice(0, 32) === HEADER_MESSAGING) return { ...base, kind: 'IMS' };
  if (simplexOk && data.slice(0, 96) === HEADER_TL) return { ...base, kind: 'ITL' };
  if (duplexOk && down && data.length > 70) {
    const [o1, o2] = deInterleave(data.slice(6, 70));
    if (divides(HDR_POLY, data.slice(0, 6)) && divides(RA_POLY, o1.slice(0, 31)) && divides(RA_POLY, o2.slice(0, 31))) return ibc(data, base);
  }
  if (duplexOk && data.length > 64) {
    const [l1, l2, l3] = deInterleaveLcw(data.slice(0, 46));
    if (divides(29, l1) && divides(41, l3) && (bchRepair(465, l2 + '0')[0] === 0 || bchRepair(465, l2 + '1')[0] === 0)) return lcw(data, base);
  }
  if (simplexOk && data.length >= 96) {
    const [r1, r2, r3] = deInterleave3(data.slice(0, 96));
    if (divides(RA_POLY, r1.slice(0, 31)) && divides(RA_POLY, r2.slice(0, 31)) && divides(RA_POLY, r3.slice(0, 31))) return ira(data, base);
  }
  if (duplexOk && !down && data.length >= 52 && data.length <= 60) return { ...base, kind: 'IAQ' };
  return null;
}

/** 32-bit blocks: BCH(31,21) and the overall parity; data bits until one cannot be repaired. */
function eccBlocks(blocks: string[], poly: number): { bits: string; fixed: number } {
  let bits = '', fixed = 0;
  for (const b of blocks) {
    const [e, d, c] = bchRepair(poly, b.slice(0, 31));
    if (e < 0) break;
    if (ones(d + c + b[31]) % 2 === 1 && e > 0) break;
    if (e > 0) fixed++;
    bits += d;
  }
  return { bits, fixed };
}
const FILL = '1010001001110011101111110110110101010100010001011100001011100110';

function ira(data: string, base: Omit<IridiumFrame, 'kind'>): IridiumFrame | null {
  const blocks: string[] = [...deInterleave3(data.slice(0, 96))];
  const [rest] = sliceExtra(data.slice(96), 64);
  for (const x of rest) blocks.push(...deInterleave(x));
  while (blocks.length >= 2 && blocks.slice(-2).join('') === FILL) blocks.splice(-2, 2);
  const { bits: b, fixed } = eccBlocks(blocks, RA_POLY);
  if (b.length < 63) return null;
  const sx = (s: string, sign: string) => parseInt(s, 2) - (sign === '1' ? 1 << 11 : 0);
  const x = sx(b.slice(14, 25), b[13]), y = sx(b.slice(26, 37), b[25]), z = sx(b.slice(38, 49), b[37]);
  const pagesBits = b.slice(63); let pages = 0;
  for (let i = 0; i + 42 <= pagesBits.length; i += 42) { if (pagesBits.slice(i, i + 42) === '1'.repeat(42)) break; pages++; }
  return { ...base, kind: 'IRA', fixed, sat: parseInt(b.slice(0, 7), 2), beam: parseInt(b.slice(7, 13), 2),
    lat: Math.round(Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI * 100) / 100, lon: Math.round(Math.atan2(y, x) * 180 / Math.PI * 100) / 100,
    altKm: Math.round(Math.hypot(x, y, z) * 4 - 6378 + 23), pages };
}

function ibc(data: string, base: Omit<IridiumFrame, 'kind'>): IridiumFrame | null {
  const [e, hd] = bchRepair1(HDR_POLY, data.slice(0, 6));
  if (e < 0) return null;
  const type = parseInt(hd, 2), [blocks] = sliceExtra(data.slice(6, 262), 64), sub: string[] = [];
  for (const x of blocks) sub.push(...deInterleave(x));
  const { bits: b, fixed } = eccBlocks(sub, RA_POLY);
  const f: IridiumFrame = { ...base, kind: 'IBC', fixed };
  if (type !== 0 || b.length < 42) return f;
  f.sat = parseInt(b.slice(0, 7), 2); f.beam = parseInt(b.slice(7, 13), 2);
  if (b.length >= 84) {
    const t = b.slice(42, 84);
    if (parseInt(t.slice(0, 6), 2) === 1) f.timeS = Math.round((parseInt(t.slice(10, 42), 2) * 90 / 1000 + IRIDIUM_EPOCH_S) * 100) / 100;
    let n = 0; for (let i = 84; i + 42 <= b.length && i < 168; i += 42) if (b.slice(i, i + 42) !== '111' + '0'.repeat(39)) n++;
    f.assignments = n;
  }
  return f;
}

/** CRC-16/CCITT-FALSE (init 0xFFFF, not reflected), over bit-string bytes. */
function crcCcittFalse(bytes: number[]): number {
  let c = 0xffff;
  for (const v of bytes) { c ^= v << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
  return c;
}
const toBytes = (bits: string) => { const o: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return o; };

function lcw(data: string, base: Omit<IridiumFrame, 'kind'>): IridiumFrame | null {
  const [l1] = deInterleaveLcw(data.slice(0, 46)), [e1, ftBits] = bchRepair(29, l1);
  if (e1 < 0) return null;
  const ft = parseInt(ftBits, 2), body = data.slice(46, 46 + 312);
  const named: Record<number, IridiumKind> = { 0: 'VOC', 1: 'IIP', 3: 'IU3', 7: 'ISY' };
  if (ft !== 2) return { ...base, kind: named[ft] ?? 'ILW', ft };
  if (body.length < 312) return { ...base, kind: 'IDA', ft, crcOk: false };
  const [blocks, end] = sliceExtra(body, 124), cw: string[] = [];
  for (const x of blocks) { const [b1, b2] = deInterleave(x), all = b1 + b2; const q = [all.slice(0, 31), all.slice(31, 62), all.slice(62, 93), all.slice(93, 124)]; cw.push(q[3], q[1], q[2], q[0]); }
  const e = end.length % 2 ? end.slice(0, -1) : end, [b1, b2] = deInterleave(e); cw.push(b2.slice(1), b1.slice(1));
  let b = '', fixed = 0;
  for (const c of cw) { if (c.length !== 31) break; const [er, d] = bchRepair(ACCH_POLY, c); if (er < 0) break; if (er > 0) fixed++; b += d; }
  if (b.length < 9 * 20 + 16) return { ...base, kind: 'IDA', ft, fixed, crcOk: false };
  const len = parseInt(b.slice(11, 16), 2), bytes = toBytes(b.slice(20, 180));
  const crcOk = len > 0 && crcCcittFalse(toBytes(b.slice(0, 20) + '0'.repeat(12) + b.slice(20, b.length - 4))) === 0;
  return { ...base, kind: 'IDA', ft, fixed, cont: b[3] === '1', ctr: parseInt(b.slice(5, 8), 2), len, data: bytes.slice(0, len), crcOk };
}

// ------------------------------------------------------------------------------------- IDA → SBD → ACARS

export interface IridiumAcars { down: boolean; reg: string; label: string; blk: string; msn: string; flight: string; text: string; crcOk: boolean; ms: number; freqHz: number }

/** IDA fragments put back together (by frequency, counter and time), the SBD messages they make, the ACARS in them. */
export class IdaReassembler {
  onSbd: ((d: { data: number[]; down: boolean; ms: number; freqHz: number }) => void) | null = null;
  onAcars: ((a: IridiumAcars) => void) | null = null;
  private buf: { freq: number; times: number[]; ctr: number; data: number[]; down: boolean }[] = [];
  private multi: { no: number; cnt: number; data: number[]; down: boolean; ms: number }[] = [];
  private last: { ms: number; key: string } | null = null;
  add(f: IridiumFrame): void {
    if (f.kind !== 'IDA' || !f.crcOk || f.data === undefined || f.ctr === undefined) return;
    const key = `${f.data.join(',')}|${Math.round(f.freqHz / 200)}`;
    if (this.last && Math.abs(f.ms - this.last.ms) <= 1 && this.last.key === key) return;   // a duplicate
    this.last = { ms: f.ms, key };
    for (let i = 0; i < this.buf.length; i++) {
      const b = this.buf[i], t = b.times[b.times.length - 1];
      if (Math.abs(b.freq - f.freqHz) < 260 && f.ms >= t && f.ms <= t + 280 && (b.ctr + 1) % 8 === f.ctr && b.down === f.down) {
        this.buf.splice(i, 1);
        const data = [...b.data, ...f.data];
        if (f.cont) this.buf.push({ freq: b.freq, times: [...b.times, f.ms], ctr: f.ctr, data, down: f.down });
        else this.packet(data, f.down, f.ms, b.freq);
        return;
      }
    }
    if (f.ctr === 0 && !f.cont) this.packet(f.data, f.down, f.ms, f.freqHz);
    else if (f.ctr === 0) this.buf.push({ freq: f.freqHz, times: [f.ms], ctr: 0, data: [...f.data], down: f.down });
    this.buf = this.buf.filter(b => b.times[b.times.length - 1] + 1000 > f.ms);
  }
  /** One reassembled packet: SBD (iridiumtk/reassembler/sbd.py process_l2). */
  private packet(d: number[], down: boolean, ms: number, freqHz: number): void {
    if (d.length < 5) return;
    const ul = !down;
    if (d[0] === 0x76) { if (d[1] === 5) return; if (ul ? d[1] < 0x0c || d[1] > 0x0e : d[1] < 0x08 || d[1] > 0x0b) return; }
    else if (!(d[0] === 0x06 && d[1] === 0 && [0x00, 0x10, 0x20, 0x40, 0x50, 0x70].includes(d[2]))) return;
    const typ = (d[0] << 8) | d[1]; let data = d.slice(2), msgcnt: number, msgno: number;
    if (typ === 0x0600) {
      if (data[0] !== 0x20) return;
      const pre = data.slice(0, 29); data = data.slice(29); msgcnt = pre[15]; msgno = msgcnt === 0 ? 0 : 1;
    } else {
      if (typ === 0x7608) {
        if (data[0] === 0x26) { msgcnt = data[3]; data = data.slice(7); }
        else if (data[0] === 0x20) { msgcnt = data[3]; data = data.slice(5); if (data.length >= 2 && data[2] === 0x10) data = data.slice(2); }
        else { msgcnt = data[3]; data = data.slice(7); }
      } else msgcnt = -1;
      if (ul && data.length >= 3 && (data[0] === 0x50 || data[0] === 0x51)) data = data.slice(3);
      if (!data.length) msgno = 0;
      else if (data.length > 3 && data[0] === 0x10) { const n = data[1]; msgno = data[2]; data = data.slice(3); if (data.length < n) return; data = data.slice(0, n); }
      else msgno = 0;
    }
    this.multi = this.multi.filter(m => m.ms + 5000 >= ms);
    let done: number[] | null = null;
    if (msgno === 0 || (msgcnt === 1 && msgno === 1)) done = data;
    else if (msgcnt > 1) { this.multi.push({ no: msgno, cnt: msgcnt, data, down, ms }); return; }
    else if (msgno > 1) {
      for (let i = this.multi.length - 1; i >= 0; i--) {
        const m = this.multi[i];
        if (msgno === m.no + 1 && m.down === down) { m.data = [...m.data, ...data]; m.no++; if (msgno === m.cnt) { this.multi.splice(i, 1); done = m.data; } break; }
      }
      if (!done) return;
    }
    if (!done) return;
    this.onSbd?.({ data: done, down, ms, freqHz });
    const a = sbdAcars(done, down);
    if (a) this.onAcars?.({ ...a, ms, freqHz });
  }
}

/** ACARS in an SBD message (iridiumtk/reassembler/sbd.py): SOH, an optional 8-byte header, the block, CRC, DEL. */
export function sbdAcars(raw: number[], down: boolean): Omit<IridiumAcars, 'ms' | 'freqHz'> | null {
  if (raw.length <= 2 || raw[0] !== 1) return null;
  let d = raw.slice(1), csum: number[] = [];
  if (d[d.length - 1] === 0x7f) { csum = d.slice(-3, -1); d = d.slice(0, -3); }
  if (d[0] === 0x03) d = d.slice(8);
  let c = 0; for (const v of [...d, ...csum]) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  const crcOk = csum.length > 0 && c === 0;
  if (d.length < 13) return null;
  const B = d.map(v => v & 0x7f), ch = (i: number) => String.fromCharCode(B[i]);
  let reg = ''; for (let i = 1; i < 8; i++) reg += ch(i);
  const label = ch(9) + ch(10), blk = ch(11);
  let body = B.slice(12); if (body[body.length - 1] === 0x03 || body[body.length - 1] === 0x17) body = body.slice(0, -1);
  let msn = '', flight = '', text = '';
  if (body[0] === 2) {
    // the aircraft (uplink on Iridium) sends a sequence number and its flight first
    if (!down) { msn = String.fromCharCode(...body.slice(1, 5)); flight = String.fromCharCode(...body.slice(5, 11)).trim(); body = body.slice(11); }
    else body = body.slice(1);
    text = body.map(v => v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : v === 0x0a || v === 0x0d ? ' ' : '·').join('').trim();
  }
  return { down, reg: reg.replace(/^\.+/, ''), label, blk, msn, flight, text, crcOk };
}

// ------------------------------------------------------------------------------------------------ test encoders

const bin = (v: number, n: number) => (v >>> 0).toString(2).padStart(n, '0').slice(-n);
/** BCH codeword: data then the remainder (bch.py's form). */
export function bchEncode(poly: number, data: string): string { const deg = bitLen(poly) - 1; return data + bin(gfMod(poly, parseInt(data + '0'.repeat(deg), 2)), deg); }
const ecc32 = (d21: string) => { const c = bchEncode(RA_POLY, d21); return c + (ones(c) % 2 ? '1' : '0'); };
const unpairs = (s: string[]) => s.map(p => p[1] + p[0]).join('');
/** Inverses of deInterleave / deInterleave3 (tests only). */
export function interleave(odd: string, even: string): string {
  const n = odd.length / 2 + even.length / 2, s: string[] = new Array(n);
  for (let i = 0; i < even.length / 2; i++) s[n - 2 - 2 * i] = even.slice(2 * i, 2 * i + 2);
  for (let i = 0; i < odd.length / 2; i++) s[n - 1 - 2 * i] = odd.slice(2 * i, 2 * i + 2);
  return unpairs(s);
}
export function interleave3(a: string, b: string, c: string): string {
  const n = 48, s: string[] = new Array(n);
  for (let i = 0; i < 16; i++) { s[n - 3 - 3 * i] = c.slice(2 * i, 2 * i + 2); s[n - 2 - 3 * i] = b.slice(2 * i, 2 * i + 2); s[n - 1 - 3 * i] = a.slice(2 * i, 2 * i + 2); }
  return unpairs(s);
}
/** A ring alert's bits as the demodulator gives them (unique word first): satellite, beam, position (x, y, z in units of 4 km), pages. */
export function buildIra(sat: number, beam: number, x: number, y: number, z: number, pages = 0): string {
  const sx = (v: number) => (v < 0 ? '1' : '0') + bin(v < 0 ? v + (1 << 11) : v, 11);
  let p = bin(sat, 7) + bin(beam, 6) + sx(x) + sx(y) + sx(z) + bin(5, 7) + '0' + '0' + bin(3, 5);
  for (let i = 0; i < pages; i++) p += bin(0x1234567 + i, 32) + '00' + bin(i, 5) + '000';
  p += '1'.repeat(42);
  while (p.length % 21) p += '0';
  const blocks = p.match(/.{21}/g)!.map(ecc32);
  while (blocks.length < 3 || (blocks.length - 3) % 2) blocks.push(ecc32('0'.repeat(21)));
  let out = interleave3(blocks[0], blocks[1], blocks[2]);
  for (let i = 3; i < blocks.length; i += 2) out += interleave(blocks[i], blocks[i + 1]);
  return symbolReverse(UW_BITS_DL + out);
}
/** A broadcast frame's bits: satellite, beam, Iridium time (90 ms frames since the era 3 epoch). */
export function buildIbc(sat: number, beam: number, iriTime: number): string {
  const b0 = bin(sat, 7) + bin(beam, 6) + '0' + '1' + '0' + '0'.repeat(16) + bin(2, 5) + bin(1, 3) + '00';
  const b1 = bin(1, 6) + '0000' + bin(iriTime, 32), empty = '111' + '0'.repeat(39);
  const d = b0 + b1 + empty + empty, blocks = d.match(/.{21}/g)!.map(ecc32);
  let out = bchEncode(HDR_POLY, '00');
  for (let i = 0; i < 8; i += 2) out += interleave(blocks[i], blocks[i + 1]);
  return symbolReverse(UW_BITS_DL + out);
}
const LCW_ORDER = LCW_TBL;
/** An IDA frame's bits: counter, continuation, the data bytes (≤ 20), CRC; frame type 2 in the LCW. */
export function buildIda(ctr: number, cont: boolean, bytes: number[], down = true): string {
  const head = '000' + (cont ? '1' : '0') + '0' + bin(ctr, 3) + '000' + bin(bytes.length, 5) + '0' + '000';
  const body = bytes.map(v => bin(v, 8)).join('').padEnd(160, '0');
  const crc = crcCcittFalse(toBytes(head + '0'.repeat(12) + body));
  const b = head + body + bin(crc, 16) + '0000';
  const cw = b.match(/.{20}/g)!.map(d => bchEncode(ACCH_POLY, d));
  let payload = '';
  for (let i = 0; i < 8; i += 4) { const [q0, q1, q2, q3] = [cw[i + 3], cw[i + 1], cw[i + 2], cw[i]]; const all = q0 + q1 + q2 + q3; payload += interleave(all.slice(0, 62), all.slice(62)); }
  payload += interleave('0' + cw[9], '0' + cw[8]);
  const l1 = bchEncode(29, '010'), l2 = bchEncode(465, '000000').slice(0, 13), l3 = bchEncode(41, '0'.repeat(21)), lcw = l1 + l2 + l3, w = new Array(46).fill('0');
  LCW_ORDER.forEach((pos, i) => { w[pos - 1] = lcw[i]; });
  return symbolReverse((down ? UW_BITS_DL : UW_BITS_UL) + w.join('') + payload);
}
/** An ACARS block as SBD carries it (SOH, block with odd parity, ETX, CRC, DEL), in an SBD 0x7608-style wrapper. */
export function buildSbdAcars(o: { reg: string; label: string; blk: string; text: string; msn?: string; flight?: string; fromAircraft: boolean }): number[] {
  const odd = (c: number) => ones(c.toString(2)) % 2 ? c : c | 0x80;
  const body = `2${o.reg.padStart(7, '.')}\x15${o.label}${o.blk}\x02${o.fromAircraft ? `${o.msn ?? 'M01A'}${(o.flight ?? '').padEnd(6, ' ')}` : ''}${o.text}\x03`;
  const blk = Array.from(body, c => odd(c.charCodeAt(0)));
  let c = 0; for (const v of blk) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  const acars = [0x01, ...blk, c & 0xff, c >> 8, 0x7f];
  // from the ground: 0x7608 with the 5-byte pre-header (one message of one); from the aircraft: 0x760c, message 0
  return o.fromAircraft ? [0x76, 0x0c, 0x10, acars.length, 0, ...acars] : [0x76, 0x08, 0x20, 0, 0, 1, 0, 0x10, acars.length, 1, ...acars];
}
