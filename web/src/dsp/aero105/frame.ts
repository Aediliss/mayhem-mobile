/**
 * FORK: the Inmarsat Aero 10.5 kbps P-channel (ground to aircraft), framing and decoding, after JAERO by Jonathan Olds
 * (MIT; aerol.cpp/aerol.h). A frame is 5250 bits (half a second): a 16-bit header (format ID, superframe marker, frame
 * counters), 178 dummy bits, 4992 coded bits, then the unique word 0xE15AE893 sent on both OQPSK rails (64 bits,
 * the two rails interleaved). The 4992 bits are a 64-row × 78-column block interleaver's output (rows permuted by
 * 27·i mod 64); the code is rate 1/2, K = 7 (polynomials 109 and 79, newest bit in the lowest place), running on from
 * frame to frame without flushing. The 2496 data bits are scrambled by a 15-bit LFSR (x^15 + x^14 + 1, JAERO's seed),
 * restarted each frame, then packed least significant bit first into 26 signal units of 12 bytes: ten bytes and a
 * CRC-16 (reflected 0x8408 from 0xFFFF, inverted; low byte first). User data comes as an initial signal unit (0x71:
 * aircraft (AES) ID, ground station (GES) ID, queue and reference numbers, how many units follow, the octets in the
 * last one) and continuation units (0xC0 | sequence); an ACARS block inside is read as upstream's Satcom app reads its
 * 600/1200 bps ACARS (acarsLine in dsp/lband/aero.ts). Receive only.
 */
import { acarsLine } from '../lband/aero.js';

export const UW = 0xE15AE893;
export const FRAME_BITS = 5250, HEADER_BITS = 16, DUMMY_BITS = 178, CODED_BITS = 4992, UW_BITS = 64;
export const DATA_OFFSET = HEADER_BITS + DUMMY_BITS;
export const ROWS = 64, COLS = 78, DATA_BITS = CODED_BITS / 2, SU_BYTES = 12, SUS = DATA_BITS / 8 / SU_BYTES;   // 26
const POLY0 = 109, POLY1 = 79, K = 7, NSTATES = 1 << (K - 1);

const depermute = Array.from({ length: ROWS }, (_, i) => (i * 27) % ROWS);
/** Received order → coded order (JAERO deinterleave_ba with 78 columns). */
export function deinterleave(block: ArrayLike<number>, out: Float32Array): void {
  let k = 0;
  for (let j = 0; j < COLS; j++) for (let i = 0; i < ROWS; i++) out[k++] = block[depermute[i] * COLS + j];
}
export function interleave(coded: ArrayLike<number>, out: Float32Array | Uint8Array): void {
  let k = 0;
  for (let j = 0; j < COLS; j++) for (let i = 0; i < ROWS; i++) out[depermute[i] * COLS + j] = coded[k++];
}

const parity = (x: number) => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
/** The coder, carrying its state from frame to frame. */
export class ConvEncoder {
  private reg = 0;
  encode(bits: ArrayLike<number>): Uint8Array {
    const out = new Uint8Array(2 * bits.length);
    for (let i = 0; i < bits.length; i++) {
      this.reg = ((this.reg << 1) | bits[i]) & ((1 << K) - 1);
      out[2 * i] = parity(this.reg & POLY0); out[2 * i + 1] = parity(this.reg & POLY1);
    }
    return out;
  }
}
// branch outputs: for state s (the 6 previous bits, newest lowest) and input b, the register is (s << 1 | b)
const OUT0 = new Uint8Array(2 * NSTATES), OUT1 = new Uint8Array(2 * NSTATES);
for (let s = 0; s < NSTATES; s++) for (let b = 0; b < 2; b++) { const r = (s << 1) | b; OUT0[2 * s + b] = parity(r & POLY0); OUT1[2 * s + b] = parity(r & POLY1); }
/**
 * Soft Viterbi over `pairs` coded pairs (soft > 0 = 1), starting from any state, ending in the best one. Returns the
 * decoded bits and the share of hard coded bits the chosen path disagrees with.
 */
export function viterbi(soft: Float32Array, pairs: number): { bits: Uint8Array; ber: number } {
  let m = new Float64Array(NSTATES), m2 = new Float64Array(NSTATES);
  const from = new Uint8Array(pairs * NSTATES);   // the predecessor's dropped (oldest) bit
  for (let t = 0; t < pairs; t++) {
    const a = soft[2 * t], b = soft[2 * t + 1];
    m2.fill(-Infinity);
    for (let s = 0; s < NSTATES; s++) {
      const ms = m[s];
      for (let bit = 0; bit < 2; bit++) {
        const ns = ((s << 1) | bit) & (NSTATES - 1);
        const v = ms + (OUT0[2 * s + bit] ? a : -a) + (OUT1[2 * s + bit] ? b : -b);
        if (v > m2[ns]) { m2[ns] = v; from[t * NSTATES + ns] = (s >> (K - 2)) & 1; }
      }
    }
    const tmp = m; m = m2; m2 = tmp;
  }
  let s = 0; for (let i = 1; i < NSTATES; i++) if (m[i] > m[s]) s = i;
  const bits = new Uint8Array(pairs);
  let err = 0;
  for (let t = pairs - 1; t >= 0; t--) {
    const bit = s & 1, prev = (s >> 1) | (from[t * NSTATES + s] << (K - 2));
    bits[t] = bit;
    if ((OUT0[2 * prev + bit] ? 1 : -1) * soft[2 * t] < 0) err++;
    if ((OUT1[2 * prev + bit] ? 1 : -1) * soft[2 * t + 1] < 0) err++;
    s = prev;
  }
  return { bits, ber: err / (2 * pairs) };
}

/** The scrambler's bits for one frame (JAERO AeroLScrambler). */
export const SCRAMBLE = (() => {
  const st = [1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1], out = new Uint8Array(DATA_BITS);
  for (let a = 0; a < DATA_BITS; a++) { const v = st[0] ^ st[14]; out[a] = v; for (let i = 14; i > 0; i--) st[i] = st[i - 1]; st[0] = v; }
  return out;
})();

/** The signal units' CRC (JAERO AeroLcrc16.calcusingbytes): reflected 0x8408 from 0xFFFF, inverted. */
export function suCrc(b: ArrayLike<number>, at = 0, n = 10): number {
  let c = 0xFFFF;
  for (let i = 0; i < n; i++) { let x = b[at + i]; for (let k = 0; k < 8; k++) { const f = (c ^ x) & 1; c >>= 1; x >>= 1; if (f) c ^= 0x8408; } }
  return ~c & 0xFFFF;
}
export function signalUnit(ten: number[]): number[] {
  const u = ten.slice(0, 10); while (u.length < 10) u.push(0);
  const c = suCrc(u);
  return [...u, c & 0xFF, c >> 8];
}

/** Data bits (descrambled) → bytes, least significant bit first. */
export function packLsb(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v |= bits[8 * i + j] << j; out[i] = v; }
  return out;
}

const oddOk = (c: number) => { let n = 0; for (let i = 0; i < 8; i++) n += (c >> i) & 1; return (n & 1) === 1; };
interface Isu { aes: number; ges: number; q: number; ref: number; left: number; last: number; data: number[]; age: number }
export interface Aero105Stats { frames: number; units: number; badUnits: number; messages: number; ges: number; score: number; ber: number }

/** Signal units in, ACARS lines out (JAERO ISUData / ParserISU). */
export class SuReader {
  hz = 0;
  onAcars: ((line: string, aes: number) => void) | null = null;
  readonly stats: Aero105Stats = { frames: 0, units: 0, badUnits: 0, messages: 0, ges: -1, score: 0, ber: 0 };
  private isus: Isu[] = [];
  reset(): void { this.isus = []; }
  /** One frame's 312 data bytes. */
  frame(d: Uint8Array): void {
    for (let u = 0; u < SUS; u++) {
      const at = u * SU_BYTES, rec = d[at + 10] | (d[at + 11] << 8);
      let ok = suCrc(d, at) === rec;
      if (!ok && rec === 0) { let z = 0; for (let i = 0; i < 10; i++) z |= d[at + i]; ok = z === 0; }   // all-zero units
      if (!ok) { this.stats.badUnits++; continue; }
      this.stats.units++;
      this.unit(Array.from(d.subarray(at, at + 10)));
    }
  }
  private unit(b: number[]): void {
    const t = b[0];
    if (t === 0x71) {
      for (const x of this.isus) x.age++;
      this.isus = this.isus.filter(x => x.age <= 10);
      const it: Isu = { aes: (b[1] << 16) | (b[2] << 8) | b[3], ges: b[4], q: b[5] >> 4, ref: b[5] & 15, left: b[6] & 0x3F, last: b[7] >> 4, data: [b[8], b[9]], age: 0 };
      this.stats.ges = it.ges;
      const i = this.isus.findIndex(x => x.aes === it.aes && x.ges === it.ges && x.q === it.q && x.ref === it.ref);
      if (i >= 0) this.isus[i] = it; else this.isus.push(it);
      return;
    }
    if ((t & 0xC0) !== 0xC0) return;
    const seq = t & 0x3F, q = b[1] >> 4, ref = b[1] & 15;
    const it = this.isus.find(x => x.q === q && x.ref === ref && x.left === seq + 1 && x.last <= 8);
    if (!it) return;
    it.left--;
    if (it.left > 0) { it.data.push(...b.slice(2, 10)); return; }
    it.data.push(...b.slice(2, 2 + it.last));
    this.isus = this.isus.filter(x => x !== it);
    this.acars(it);
  }
  private acars(it: Isu): void {
    const u = it.data;
    if (it.aes === 0 || u.length <= 16 || u[0] !== 0xFF || u[1] !== 0xFF || (u[15] !== 0x83 && u[15] !== 0x02)) return;
    // the registration and the text carry odd parity: a unit that slipped through with a wrong byte is dropped
    for (let k = 4; k < 11; k++) if (!oddOk(u[k])) return;
    if (u[15] === 0x02) for (let k = 16; k < u.length - 4; k++) if (!oddOk(u[k])) return;
    const line = acarsLine((this.hz / 1e6).toFixed(3), u.slice(3));
    if (!line) return;
    this.stats.messages++;
    this.onAcars?.(line, it.aes);
  }
}

/** Transmitter side (tests): an ACARS uplink block as JAERO's parser expects it, in signal units. */
export function acarsSus(aes: number, ges: number, q: number, ref: number, reg: string, label: string, blk: string, text: string): number[][] {
  const odd = (c: number) => { let n = 0; for (let i = 0; i < 7; i++) n += (c >> i) & 1; return n % 2 === 0 ? c | 0x80 : c; };
  const body = [0xFF, 0xFF, 0x01, ...[..."2", ...reg.padStart(7, '.'), '\x15', ...label, blk, '\x02', ...text].map(c => odd(c.charCodeAt(0))), 0x83, 0x00, 0x00, 0x7F];
  const rest = body.slice(2), n = Math.max(1, Math.ceil(rest.length / 8)), last = rest.length - 8 * (n - 1);
  const out = [signalUnit([0x71, aes >> 16, (aes >> 8) & 255, aes & 255, ges, (q << 4) | ref, n, last << 4, body[0], body[1]])];
  for (let k = 0; k < n; k++) out.push(signalUnit([0xC0 | (n - 1 - k), (q << 4) | ref, ...rest.slice(8 * k, 8 * k + 8)]));
  return out;
}

/**
 * Transmitter side (tests): frames' bits (5250 each, as sent: rails interleaved, I first) from each frame's 26 signal
 * units (fill units added); the coder runs on across frames.
 */
export function buildFrames(frames: number[][][]): Uint8Array {
  const enc = new ConvEncoder(), out = new Uint8Array(frames.length * FRAME_BITS);
  frames.forEach((sus, f) => {
    const bytes: number[] = [];
    for (let u = 0; u < SUS; u++) bytes.push(...(sus[u] ?? signalUnit([0x01])));
    const bits = new Uint8Array(DATA_BITS);
    for (let i = 0; i < DATA_BITS; i++) bits[i] = ((bytes[i >> 3] >> (i & 7)) & 1) ^ SCRAMBLE[i];
    const coded = enc.encode(bits), block = new Uint8Array(CODED_BITS);
    interleave(coded, block);
    const o = f * FRAME_BITS, hdr = (1 << 12) | ((f & 15) << 4) | (f & 15);
    for (let i = 0; i < HEADER_BITS; i++) out[o + i] = (hdr >> (15 - i)) & 1;
    for (let i = 0; i < DUMMY_BITS; i++) out[o + HEADER_BITS + i] = i & 1;
    out.set(block, o + DATA_OFFSET);
    for (let m = 0; m < 32; m++) { const v = (UW >>> (31 - m)) & 1; out[o + DATA_OFFSET + CODED_BITS + 2 * m] = v; out[o + DATA_OFFSET + CODED_BITS + 2 * m + 1] = v; }
  });
  return out;
}

const UWS = Array.from({ length: 32 }, (_, m) => ((UW >>> (31 - m)) & 1) ? 1 : -1);
/**
 * Finds frames in the stream of soft bits (rails interleaved; > 0 = 1) by the unique word at their end, each rail with
 * its own polarity, and decodes each one once the next frame's start is in (the code runs on across frames).
 */
export class Aero105Sync {
  readonly reader = new SuReader();
  frames = 0; lastSync = -1e9;
  private buf = new Float32Array(4 * FRAME_BITS); private n = 0; private pos = 0;   // pos: absolute index of buf[0]
  private next = -1;   // absolute index where the next frame's UW is expected to end
  private pending: { start: number; inv: [number, number]; score: number }[] = [];
  private prevTail: Float32Array | null = null;
  private readonly co = new Float32Array(CODED_BITS);

  reset(): void { this.n = 0; this.pos = 0; this.next = -1; this.pending = []; this.prevTail = null; this.reader.reset(); }

  push(soft: Float32Array, count = soft.length): void {
    if (this.n + count > this.buf.length) {
      const keep = Math.min(this.n, 3 * FRAME_BITS), drop = this.n - keep;
      this.buf.copyWithin(0, drop, this.n); this.n = keep; this.pos += drop;
      if (this.n + count > this.buf.length) { const b = new Float32Array(this.n + count + FRAME_BITS); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
    }
    this.buf.set(soft.subarray(0, count), this.n); this.n += count;
    this.scan();
  }

  /** UW match ending at absolute bit e (inclusive): [score 0..1, rail-A sign, rail-B sign] (rail A holds bit e-63). */
  private uwAt(e: number): [number, number, number] {
    const s = e - UW_BITS + 1 - this.pos; if (s < 0) return [0, 1, 1];
    let ca = 0, cb = 0, aa = 0;
    for (let m = 0; m < 32; m++) { const x = this.buf[s + 2 * m], y = this.buf[s + 2 * m + 1]; ca += UWS[m] * x; cb += UWS[m] * y; aa += Math.abs(x) + Math.abs(y); }
    return [aa > 0 ? (Math.abs(ca) + Math.abs(cb)) / aa : 0, ca < 0 ? -1 : 1, cb < 0 ? -1 : 1];
  }

  private scan(): void {
    const end = this.pos + this.n - 1;
    for (;;) {
      // a frame waiting for the start of the next one (for the code's tail)
      while (this.pending.length && end >= this.pending[0].start + FRAME_BITS + DATA_OFFSET + CODED_BITS) this.decode(this.pending.shift()!, true);
      if (this.next >= 0) {
        if (end < this.next + 2) return;
        let best = this.next, bs = this.uwAt(this.next);
        for (const d of [-2, -1, 1, 2]) { const r = this.uwAt(this.next + d); if (r[0] > bs[0]) { bs = r; best = this.next + d; } }
        if (bs[0] < 0.55) { this.next = -1; while (this.pending.length) this.decode(this.pending.shift()!, false); continue; }
        this.found(best, bs);
        continue;
      }
      // search: every position not yet looked at
      const from = Math.max(this.pos + UW_BITS - 1, this.searchFrom);
      let hit = -1, hs: [number, number, number] = [0, 1, 1];
      for (let e = from; e <= end; e++) { const r = this.uwAt(e); if (r[0] >= 0.8) { hit = e; hs = r; break; } }
      if (hit < 0) { this.searchFrom = end + 1; return; }
      // the best of the next few positions
      if (end < hit + 2) { this.searchFrom = hit; return; }
      for (let e = hit + 1; e <= hit + 2; e++) { const r = this.uwAt(e); if (r[0] > hs[0]) { hs = r; hit = e; } }
      this.found(hit, hs);
    }
  }
  private searchFrom = 0;

  private found(e: number, [score, sa, sb]: [number, number, number]): void {
    this.lastSync = e; this.reader.stats.score = score;
    const start = e + 1;   // the next frame starts right after its predecessor's UW
    // rail A of the UW is at e-63 (odd distance from e): the frame's bit i is on rail A when (i - (e - 63 - start)) is even
    const aPar = ((e - 63) - start) & 1;
    this.pending.push({ start, inv: aPar === 0 ? [sa, sb] : [sb, sa], score });
    this.next = start + FRAME_BITS - 1;
    this.searchFrom = this.next + 1;
  }

  private lastStart = -1e9;
  private decode(p: { start: number; inv: [number, number] }, withNext: boolean): void {
    const b = this.buf, o = p.start - this.pos; if (o < 0) return;
    const block = new Float32Array(CODED_BITS);
    // normalise to a mean size of 1 and undo each rail's polarity
    let a = 0; for (let i = 0; i < CODED_BITS; i++) a += Math.abs(b[o + DATA_OFFSET + i]);
    const g = CODED_BITS / (a || 1);
    for (let i = 0; i < CODED_BITS; i++) { const k = DATA_OFFSET + i; block[i] = b[o + k] * p.inv[k & 1] * g; }
    deinterleave(block, this.co);
    // the next frame's first coded bits, de-interleaved, settle the end of the path
    const PRE = 48, POST = 48, tail = p.start === this.lastStart + FRAME_BITS ? this.prevTail : null;
    const soft = new Float32Array(2 * (PRE + DATA_BITS + POST));
    if (tail) soft.set(tail, 0);
    soft.set(this.co, 2 * PRE);
    const no = o + FRAME_BITS;
    if (withNext && no + DATA_OFFSET + CODED_BITS <= this.n) {
      // the rails keep their polarity from frame to frame (the next UW says so too, but this frame's is as good)
      const nb = new Float32Array(CODED_BITS), nco = new Float32Array(CODED_BITS);
      for (let i = 0; i < CODED_BITS; i++) { const k = DATA_OFFSET + i; nb[i] = b[no + k] * p.inv[k & 1] * g; }
      deinterleave(nb, nco);
      soft.set(nco.subarray(0, 2 * POST), 2 * (PRE + DATA_BITS));
    }
    this.prevTail = this.co.slice(CODED_BITS - 2 * PRE); this.lastStart = p.start;
    const { bits, ber } = viterbi(soft, PRE + DATA_BITS + POST);
    const data = new Uint8Array(DATA_BITS);
    for (let i = 0; i < DATA_BITS; i++) data[i] = bits[PRE + i] ^ SCRAMBLE[i];
    this.frames++; this.reader.stats.frames++; this.reader.stats.ber = ber;
    this.reader.frame(packLsb(data));
  }
}
