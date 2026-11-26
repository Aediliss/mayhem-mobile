/**
 * FORK: Mode-S beyond extended squitter, receive only. Upstream's ADS-B decoder (adsb.ts) reads DF17/18 whose CRC is
 * exactly right. This module checks and reads every downlink format:
 *
 *  · DF17/18 (extended squitter): CRC; a frame off by one bit is repaired, by two bits only for an aircraft already heard.
 *  · DF11 (all-call reply): its parity carries the interrogator's code (II / SI, the low 7 bits), so the syndrome's top
 *    17 bits must be zero; one bit is repaired when the interrogator code is 0. Gives the aircraft's address.
 *  · DF0, 4, 5, 16, 20, 21 (surveillance and Comm-B replies): their parity is the CRC XOR the aircraft's address
 *    (address / parity), so the syndrome IS the address: taken only when it is an aircraft already heard (DF11/17/18).
 *
 * Fields: altitude (AC13: 25 ft when Q is set, Gillham 100 ft otherwise), squawk (ID13), flight status (alert, SPI, on
 * the ground), and in DF20/21 the 56-bit Comm-B register, whose number is not sent: BDS 1,0 / 2,0 / 4,0 / 5,0 / 6,0
 * are inferred as pyModeS does, from their fixed bits, status bits and value ranges, and a register is named only when
 * exactly one of them fits. Layouts from ICAO Annex 10 Vol IV and Doc 9871; inference after pyModeS (Junzi Sun,
 * GPL-3.0). The CRC (generator 0x1FFF409) and its syndrome tables are built here.
 */

const POLY = 0xfff409;

/** The 24-bit remainder of the first `nbits - 24` bits (times x^24) XOR the frame's last 24 bits: 0 for a clean frame. */
export function syndrome(b: ArrayLike<number>, nbits: number): number {
  let r = 0;
  for (let i = 0; i < nbits - 24; i++) {
    const bit = (b[i >> 3] >> (7 - (i & 7))) & 1, fb = ((r >> 23) & 1) ^ bit;
    r = (r << 1) & 0xffffff; if (fb) r ^= POLY;
  }
  const n = nbits >> 3;
  return (r ^ ((b[n - 3] << 16) | (b[n - 2] << 8) | b[n - 1])) & 0xffffff;
}

/** What flipping bit i of an `nbits` frame does to its syndrome. */
function bitSyndromes(nbits: number): number[] {
  const out: number[] = [], b = new Uint8Array(nbits >> 3);
  for (let i = 0; i < nbits; i++) { b.fill(0); b[i >> 3] = 0x80 >> (i & 7); out.push(syndrome(b, nbits)); }
  return out;
}
export const SYN112 = bitSyndromes(112), SYN56 = bitSyndromes(56);
/** Syndrome → the bit (or two bits) to flip; the DF field (bits 0-4) is never changed. Syndromes two patterns share are left out. */
function fixTable(syn: number[], two: boolean): Map<number, number[]> {
  const m = new Map<number, number[]>(), dup = new Set<number>();
  const add = (s: number, v: number[]) => { if (m.has(s)) dup.add(s); else m.set(s, v); };
  for (let i = 5; i < syn.length; i++) add(syn[i], [i]);
  if (two) for (let i = 5; i < syn.length; i++) for (let j = i + 1; j < syn.length; j++) add(syn[i] ^ syn[j], [i, j]);
  for (const s of dup) m.delete(s);
  return m;
}
const FIX112_1 = fixTable(SYN112, false), FIX112_2 = fixTable(SYN112, true), FIX56_1 = fixTable(SYN56, false);

const bitsOf = (b: ArrayLike<number>, from: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) { const p = from + i; v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1); } return v; };
const hex6 = (v: number) => v.toString(16).padStart(6, '0');

// ---------------------------------------------------------------------------------------------------- fields

/** Gray code to binary. */
const gray = (n: number) => { n ^= n >> 8; n ^= n >> 4; n ^= n >> 2; n ^= n >> 1; return n; };
/**
 * AC13 (C1 A1 C2 A2 C4 A4 M B1 Q B2 D2 B4 D4) → feet, or undefined. Q set: 11 bits of 25 ft from -1000. Q clear: the
 * Gillham code, a 500 ft Gray code (D2 D4 A1 A2 A4 B1 B2 B4) and a 100 ft step (C1 C2 C4) from -1200.
 */
export function ac13(v: number): number | undefined {
  if (!v) return undefined;
  const c = (k: number) => (v >> (12 - k)) & 1;
  if (c(6)) return undefined;                                  // M: metric, not used in practice
  if (c(8)) { const n = (c(0) << 10) | (c(1) << 9) | (c(2) << 8) | (c(3) << 7) | (c(4) << 6) | (c(5) << 5) | (c(7) << 4) | (c(9) << 3) | (c(10) << 2) | (c(11) << 1) | c(12); return n * 25 - 1000; }
  const n500 = gray((c(10) << 7) | (c(12) << 6) | (c(1) << 5) | (c(3) << 4) | (c(5) << 3) | (c(7) << 2) | (c(9) << 1) | c(11));
  let n100 = gray((c(0) << 2) | (c(2) << 1) | c(4));
  if (n100 === 0 || n100 === 5 || n100 === 6) return undefined;
  if (n100 === 7) n100 = 5;
  if (n500 % 2) n100 = 6 - n100;
  return n500 * 500 + n100 * 100 - 1300;
}
/** ID13 (C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4) → the squawk as four octal digits. */
export function id13(v: number): string {
  const c = (k: number) => (v >> (12 - k)) & 1;
  const a = c(5) * 4 + c(3) * 2 + c(1), b = c(11) * 4 + c(9) * 2 + c(7), cc = c(4) * 4 + c(2) * 2 + c(0), d = c(12) * 4 + c(10) * 2 + c(8);
  return `${a}${b}${cc}${d}`;
}

const CHARS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';

export interface CommB {
  bds: '1,0' | '2,0' | '4,0' | '5,0' | '6,0';
  /** 2,0 */ callsign?: string;
  /** 1,0: Mode S subnetwork version. */ version?: number;
  /** 4,0 */ selAlt?: number; fmsAlt?: number; qnh?: number;
  /** 5,0 */ roll?: number; trueTrack?: number; gs?: number; trackRate?: number; tas?: number;
  /** 6,0 */ hdg?: number; ias?: number; mach?: number; baroRate?: number; ivv?: number;
}
/** MB bit k (1..56) of a 7-byte register, and runs of them. */
const mb = (r: Uint8Array) => ({ b: (k: number) => bitsOf(r, k - 1, 1), v: (k: number, n: number) => bitsOf(r, k - 1, n) });
const signed = (sign: number, mag: number, n: number) => (sign ? mag - (1 << n) : mag);

/** Each candidate register: its reading if the bits fit it, else null. */
function bds10(r: Uint8Array): CommB | null {
  const { v } = mb(r);
  if (v(1, 8) !== 0x10 || v(10, 5) !== 0) return null;
  return { bds: '1,0', version: v(17, 7) };
}
function bds20(r: Uint8Array): CommB | null {
  const { v } = mb(r);
  if (v(1, 8) !== 0x20) return null;
  let cs = ''; for (let i = 0; i < 8; i++) cs += CHARS[v(9 + 6 * i, 6)];
  if (cs.includes('#')) return null;
  cs = cs.trim(); return cs ? { bds: '2,0', callsign: cs } : null;
}
/** A field with a status bit: when the status is 0 the value bits must be 0. */
const statusOk = (r: Uint8Array, s: number, from: number, n: number) => { const { b, v } = mb(r); return b(s) === 1 || v(from, n) === 0; };
function bds40(r: Uint8Array): CommB | null {
  const { b, v } = mb(r);
  if (!statusOk(r, 1, 2, 12) || !statusOk(r, 14, 15, 12) || !statusOk(r, 27, 28, 12) || !statusOk(r, 48, 49, 3) || !statusOk(r, 54, 55, 2)) return null;
  if (v(40, 8) !== 0 || v(52, 2) !== 0) return null;
  const out: CommB = { bds: '4,0' };
  if (b(1)) { out.selAlt = v(2, 12) * 16; if (out.selAlt > 50_000) return null; }
  if (b(14)) { out.fmsAlt = v(15, 12) * 16; if (out.fmsAlt > 50_000) return null; }
  if (b(27)) { out.qnh = Math.round((v(28, 12) * 0.1 + 800) * 10) / 10; if (out.qnh < 900 || out.qnh > 1100) return null; }
  return b(1) || b(14) || b(27) ? out : null;
}
function bds50(r: Uint8Array): CommB | null {
  const { b, v } = mb(r);
  if (!statusOk(r, 1, 2, 10) || !statusOk(r, 12, 13, 11) || !statusOk(r, 24, 25, 10) || !statusOk(r, 35, 36, 10) || !statusOk(r, 46, 47, 10)) return null;
  const out: CommB = { bds: '5,0' };
  if (b(1)) { out.roll = Math.round(signed(b(2), v(3, 9), 9) * 45 / 256 * 10) / 10; if (Math.abs(out.roll) > 50) return null; }
  if (b(12)) { let t = signed(b(13), v(14, 10), 10) * 90 / 512; if (t < 0) t += 360; out.trueTrack = Math.round(t * 10) / 10; }
  if (b(24)) { out.gs = v(25, 10) * 2; if (out.gs > 600) return null; }
  if (b(35)) { out.trackRate = Math.round(signed(b(36), v(37, 9), 9) * 8 / 256 * 100) / 100; }
  if (b(46)) { out.tas = v(47, 10) * 2; if (out.tas > 500) return null; }
  if (out.gs !== undefined && out.tas !== undefined && Math.abs(out.gs - out.tas) > 200) return null;
  return b(1) || b(12) || b(24) || b(46) ? out : null;
}
function bds60(r: Uint8Array): CommB | null {
  const { b, v } = mb(r);
  if (!statusOk(r, 1, 2, 11) || !statusOk(r, 13, 14, 10) || !statusOk(r, 24, 25, 10) || !statusOk(r, 35, 36, 10) || !statusOk(r, 46, 47, 10)) return null;
  const out: CommB = { bds: '6,0' };
  if (b(1)) { let h = signed(b(2), v(3, 10), 10) * 90 / 512; if (h < 0) h += 360; out.hdg = Math.round(h * 10) / 10; }
  if (b(13)) { out.ias = v(14, 10); if (out.ias > 500) return null; }
  if (b(24)) { out.mach = Math.round(v(25, 10) * 2.048 / 512 * 1000) / 1000; if (out.mach > 1) return null; }
  if (b(35)) { out.baroRate = signed(b(36), v(37, 9), 9) * 32; if (Math.abs(out.baroRate) > 6000) return null; }
  if (b(46)) { out.ivv = signed(b(47), v(48, 9), 9) * 32; if (Math.abs(out.ivv) > 6000) return null; }
  if (out.ias !== undefined && out.mach !== undefined && (out.ias > 250 ? out.mach < 0.4 : out.mach > 0.6 && out.ias < 150)) return null;
  return b(1) || b(13) || b(24) ? out : null;
}
/** The Comm-B register's reading, when exactly one of the five fits (else null: not named). */
export function inferCommB(r: Uint8Array): CommB | null {
  if (r.every(x => x === 0)) return null;
  const fits = [bds10, bds20, bds40, bds50, bds60].map(f => f(r)).filter((x): x is CommB => !!x);
  return fits.length === 1 ? fits[0] : null;
}

// ---------------------------------------------------------------------------------------------------- frames

export type Via = 'crc' | 'fixed1' | 'fixed2' | 'iid' | 'ap';
export interface ModeSFrame {
  df: number; icao: string; via: Via;
  /** The frame with any repaired bits, 7 or 14 bytes. */
  bytes: Uint8Array;
  /** DF11: the interrogator code; else -1. */
  iid: number;
  alt?: number; squawk?: string; ground?: boolean; alert?: boolean; spi?: boolean;
  commB?: CommB;
}

/** Checks and reads Mode-S frames, keeping the addresses heard so far (address / parity needs them). */
export class ModeS {
  /** Addresses confirmed by a DF11/17/18 that passed its check, and when last heard. */
  readonly known = new Map<string, number>();
  constructor(readonly keepMs = 60_000) {}

  frame(raw: ArrayLike<number>, now: number): ModeSFrame | null {
    const df = raw[0] >> 3, long = df >= 16, nbits = long ? 112 : 56;
    if (raw.length < nbits / 8) return null;
    const bytes = Uint8Array.from(Array.from(raw).slice(0, nbits / 8));
    const s = syndrome(bytes, nbits);
    const flip = (bits: number[]) => { for (const i of bits) bytes[i >> 3] ^= 0x80 >> (i & 7); };
    let via: Via, iid = -1, icao: string;
    if (df === 17 || df === 18) {
      if (s === 0) via = 'crc';
      else {
        const f1 = FIX112_1.get(s), f2 = f1 ? undefined : FIX112_2.get(s);
        if (f1) { flip(f1); via = 'fixed1'; }
        else if (f2) { flip(f2); if (!this.isKnown(hex6(bitsOf(bytes, 8, 24)), now)) return null; via = 'fixed2'; }
        else return null;
      }
      icao = hex6(bitsOf(bytes, 8, 24));
      this.known.set(icao, now);
    } else if (df === 11) {
      if ((s & 0xffff80) === 0) { via = s ? 'iid' : 'crc'; iid = s; }
      else { const f1 = FIX56_1.get(s); if (!f1) return null; flip(f1); via = 'fixed1'; iid = 0; }
      icao = hex6(bitsOf(bytes, 8, 24));
      if (via !== 'fixed1' || this.isKnown(icao, now)) this.known.set(icao, now);
      else return null;                                         // a repaired all-call for an unknown address: not trusted
    } else if (df === 0 || df === 4 || df === 5 || df === 16 || df === 20 || df === 21) {
      icao = hex6(s);
      if (!this.isKnown(icao, now)) return null;
      via = 'ap'; this.known.set(icao, now);
    } else return null;
    const out: ModeSFrame = { df, icao, via, bytes, iid };
    if (df === 0 || df === 16) { out.ground = bitsOf(bytes, 5, 1) === 1; out.alt = ac13(bitsOf(bytes, 19, 13)); }
    if (df === 4 || df === 5 || df === 20 || df === 21) {
      const fs = bitsOf(bytes, 5, 3);
      out.ground = fs === 1 || fs === 3; out.alert = fs >= 2 && fs <= 4; out.spi = fs === 4 || fs === 5;
      if (df === 4 || df === 20) out.alt = ac13(bitsOf(bytes, 19, 13));
      else out.squawk = id13(bitsOf(bytes, 19, 13));
      if (df === 20 || df === 21) { const cb = inferCommB(bytes.slice(4, 11)); if (cb) out.commB = cb; }
    }
    return out;
  }
  private isKnown(icao: string, now: number): boolean {
    const t = this.known.get(icao);
    if (t !== undefined && now - t <= this.keepMs) return true;
    if (this.known.size > 4096) for (const [k, v] of this.known) if (now - v > this.keepMs) this.known.delete(k);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------- test transmitter

/** A frame with its parity: CRC (DF11 with an interrogator code, DF17/18 with 0), or CRC XOR address (address / parity). */
export function withParity(body: ArrayLike<number>, nbits: 56 | 112, ap = 0): Uint8Array {
  const b = new Uint8Array(nbits / 8); b.set(Array.from(body).slice(0, nbits / 8 - 3));
  const s = syndrome(b, nbits) ^ ap;
  b[nbits / 8 - 3] = s >> 16; b[nbits / 8 - 2] = (s >> 8) & 255; b[nbits / 8 - 1] = s & 255;
  return b;
}
