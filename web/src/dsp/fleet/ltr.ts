/**
 * FORK: LTR (Logic Trunked Radio) Standard and LTR Passport, receive only. Neither has a control channel: every
 * repeater sends 300 bit/s sub-audible data under its own voice (NRZ, frequency-shifting the FM carrier by about a
 * kilohertz), naming the call it carries, the group's home repeater and a free repeater. Field layout and sync after
 * SDRTrunk by Dennis Sheirer (GPL-3.0-or-later, module/decode/ltrstandard and module/decode/passport); both checks are
 * built here from the generators their published per-bit tables follow (the tests compare them).
 *
 * LTR Standard word, 40 bits: SYNC 101011000 · AREA 1 · CHANNEL 5 (the repeater the call is on; 31 = call over) ·
 * HOME 5 · GROUP 8 · FREE 5 · CHECK 7. A group is written A-HH-GGG (area, home repeater, group).
 * Passport word, 68 bits: SYNC 101011000 · DCC 2 · LCN 11 · SITE 7 · GROUP 16 · TYPE 4 · FREE 11 · CHECK 8. The radio id
 * of a type-6 word spans SITE and GROUP (23 bits).
 */

export const LTR_SYNC = 0x158;            // 101011000
const parity = (v: number) => { let p = 0; while (v) { p ^= v & 1; v >>>= 1; } return p; };

/**
 * LTR Standard check: 7 bits over bits 9-32, a 6-bit shift register (each step back from the last data bit shifts left
 * and feeds the XOR of its top two stages into the bottom) plus a parity bit that makes the data bit, the six register
 * bits and itself even. Entry k is what data bit 9 + k adds to the check.
 */
export const LTR_CHECK_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(24); let s = 0x21;
  for (let k = 23; k >= 0; k--) { t[k] = (s << 1) | (1 ^ parity(s)); s = ((s << 1) & 63) | (((s >> 5) ^ (s >> 4)) & 1); }
  return t;
})();

/**
 * Passport check: 8 bits over bits 9-59, a CRC-7 with generator x^7 + x^3 + 1 (entry k is x^(7 + 50 - k) mod the
 * generator) and an even-parity bit, as for LTR.
 */
export const PASSPORT_CHECK_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(51); let c = 0x09;            // x^7 mod g
  for (let k = 50; k >= 0; k--) { t[k] = (c << 1) | (1 ^ parity(c)); c <<= 1; if (c & 0x80) c ^= 0x89; }
  return t;
})();

const field = (w: Uint8Array, a: number, b: number) => { let v = 0; for (let k = a; k <= b; k++) v = v * 2 + w[k]; return v; };
const checkOf = (w: Uint8Array, table: Uint8Array, from: number) => { let c = 0; for (let k = 0; k < table.length; k++) if (w[from + k]) c ^= table[k]; return c; };

/** A 40-bit LTR word (sync first, normal polarity) passes its check. No correction: a 7-bit check has none to spare. */
export const ltrCheck = (w: Uint8Array): boolean => checkOf(w, LTR_CHECK_TABLE, 9) === field(w, 33, 39);
/** A 68-bit Passport word passes its check. */
export const passportCheck = (w: Uint8Array): boolean => checkOf(w, PASSPORT_CHECK_TABLE, 9) === field(w, 60, 67);

export interface LtrWord { std: 'ltr'; kind: 'call' | 'end' | 'idle' | 'other'; area: number; chan: number; home: number; group: number; free: number }
export interface PassportWord {
  std: 'passport'; kind: 'call' | 'end' | 'idle' | 'page' | 'unit' | 'data' | 'assign' | 'register' | 'other';
  dcc: number; lcn: number; site: number; group: number; type: number; free: number; radio: number;
}
export type LtrMsg = LtrWord | PassportWord;

const repeater = (n: number) => n >= 1 && n <= 20;
export function parseLtr(w: Uint8Array): LtrWord {
  const area = w[9], chan = field(w, 10, 14), home = field(w, 15, 19), group = field(w, 20, 27), free = field(w, 28, 32);
  const kind = repeater(chan) && repeater(home) && free <= 20 ? (chan === free && group === 255 ? 'idle' : 'call')
    : chan === 31 && repeater(home) && free <= 20 ? 'end' : 'other';
  return { std: 'ltr', kind, area, chan, home, group, free };
}
export function parsePassport(w: Uint8Array): PassportWord {
  const lcn = field(w, 11, 21), type = field(w, 45, 48), free = field(w, 49, 59);
  const kind: PassportWord['kind'] = type === 0 || type === 2 ? 'call'
    : type === 1 ? (free === 2042 ? 'assign' : lcn < 1792 ? 'call' : lcn === 1792 || lcn === 1793 ? 'idle' : lcn === 2047 ? 'end' : 'other')
    : type === 5 ? 'page' : type === 6 ? 'unit' : type === 9 ? 'data' : type === 11 ? 'register' : 'other';
  return { std: 'passport', kind, dcc: field(w, 9, 10), lcn, site: field(w, 22, 28), group: field(w, 29, 44), type, free, radio: field(w, 22, 44) };
}

/** An LTR group as one number: A-HH-GGG reads as A·100000 + HH·1000 + GGG (0-05-123 → 5123). */
export const ltrTg = (m: { area: number; home: number; group: number }) => m.area * 100_000 + m.home * 1000 + m.group;
export const ltrTgText = (m: { area: number; home: number; group: number }) => `${m.area}-${String(m.home).padStart(2, '0')}-${String(m.group).padStart(3, '0')}`;

export function ltrLine(m: LtrMsg): string {
  if (m.std === 'ltr') {
    const tg = ltrTgText(m);
    switch (m.kind) {
      case 'call': return `CALL ${tg} · REPEATER ${m.chan} · FREE ${m.free}`;
      case 'end': return `CALL END ${tg} · FREE ${m.free}`;
      case 'idle': return `IDLE · AREA ${m.area} · HOME ${m.home} · FREE ${m.free}`;
      default: return `UNKNOWN · AREA ${m.area} · CHANNEL ${m.chan} · HOME ${m.home} · GROUP ${m.group} · FREE ${m.free}`;
    }
  }
  const site = `SITE ${m.site}`;
  switch (m.kind) {
    case 'call': return `CALL TG ${m.group} · ${site} · LCN ${m.lcn} · FREE ${m.free}`;
    case 'end': return `CALL END TG ${m.group} · ${site}`;
    case 'idle': return `IDLE · ${site} · DCC ${m.dcc} · NEIGHBOR ${m.free}`;
    case 'page': return `PAGE TG ${m.group} · ${site} · LCN ${m.lcn}`;
    case 'unit': return `RADIO ${m.radio} · FREE ${m.free}`;
    case 'data': return `DATA TG ${m.group} · ${site} · LCN ${m.lcn}`;
    case 'assign': return `ASSIGN TG ${m.group} · ${site} · LCN ${m.lcn}`;
    case 'register': return `REGISTER TG ${m.group}`;
    default: return `TYPE ${m.type} · TG ${m.group} · ${site} · LCN ${m.lcn} · FREE ${m.free}`;
  }
}

// ---------------------------------------------------------------------------------------------------- test transmitter

const put = (w: Uint8Array, a: number, b: number, v: number) => { for (let k = b; k >= a; k--) { w[k] = v & 1; v = Math.floor(v / 2); } };
/** A 40-bit LTR Standard word with its sync and check (test transmitter). */
export function encodeLtr(f: { area: number; chan: number; home: number; group: number; free: number }): Uint8Array {
  const w = new Uint8Array(40);
  put(w, 0, 8, LTR_SYNC); put(w, 9, 9, f.area); put(w, 10, 14, f.chan); put(w, 15, 19, f.home); put(w, 20, 27, f.group); put(w, 28, 32, f.free);
  put(w, 33, 39, checkOf(w, LTR_CHECK_TABLE, 9));
  return w;
}
/** A 68-bit Passport word with its sync and check (test transmitter). `radio` (type 6) overwrites SITE and GROUP. */
export function encodePassport(f: { dcc?: number; lcn: number; site: number; group: number; type: number; free: number; radio?: number }): Uint8Array {
  const w = new Uint8Array(68);
  put(w, 0, 8, LTR_SYNC); put(w, 9, 10, f.dcc ?? 0); put(w, 11, 21, f.lcn); put(w, 22, 28, f.site); put(w, 29, 44, f.group);
  if (f.radio !== undefined) put(w, 22, 44, f.radio);
  put(w, 45, 48, f.type); put(w, 49, 59, f.free);
  put(w, 60, 67, checkOf(w, PASSPORT_CHECK_TABLE, 9));
  return w;
}

// ---------------------------------------------------------------------------------------------------- receiver

/**
 * The receiver on a channel's complex baseband at `fs`: FM discriminator, averaged down to about 2400 S/s, two
 * bit-long moving averages (a matched filter that also takes the voice out: its first null is at 300 Hz), sliced at
 * the middle of the recent highs and lows (the carrier's own frequency offset is whatever the middle is), a bit clock
 * pulled by the slicer's crossings, then the sync looked for at every bit in either polarity and the 40-bit LTR and
 * 68-bit Passport words behind it checked.
 */
export class LtrRx {
  onWord: (m: LtrMsg, w: Uint8Array) => void = () => undefined;
  /** Syncs found and words through their check (both decay, so a carrier heard as noise first is not held back). */
  frames = 0; good = 0;
  private pi = 0; private pq = 0;
  private readonly dec: number; private acc = 0; private na = 0;
  private readonly spb: number;
  private readonly ma1: Float32Array; private readonly ma2: Float32Array; private p1 = 0; private p2 = 0; private s1 = 0; private s2 = 0;
  private hi = 0; private lo = 0; private readonly fast = 0.3; private readonly slow: number;
  private bitPh = 0; private last = 0;
  private readonly ring = new Uint8Array(256); private n = 0; private doneTo = 0;

  constructor(readonly fs: number) {
    this.dec = Math.max(1, Math.round(fs / 2400));
    const fs2 = fs / this.dec;
    this.spb = fs2 / 300;
    const L = Math.max(2, Math.round(this.spb));
    this.ma1 = new Float32Array(L); this.ma2 = new Float32Array(L);
    this.slow = 1 / (fs2 * 0.15);                        // the highs and lows forget in about 0.15 s (a word's longest run is far shorter)
  }

  push(zi: Float32Array, zq: Float32Array, m: number): void {
    const toHz = this.fs / (2 * Math.PI), L = this.ma1.length, half = this.spb / 2;
    for (let k = 0; k < m; k++) {
      const i = zi[k], q = zq[k];
      this.acc += Math.atan2(q * this.pi - i * this.pq, i * this.pi + q * this.pq) * toHz; this.pi = i; this.pq = q;
      if (++this.na < this.dec) continue;
      const x = this.acc / this.dec; this.acc = 0; this.na = 0;
      // two bit-long moving averages
      this.s1 += x - this.ma1[this.p1]; this.ma1[this.p1] = x; this.p1 = (this.p1 + 1) % L;
      const y1 = this.s1 / L;
      this.s2 += y1 - this.ma2[this.p2]; this.ma2[this.p2] = y1; this.p2 = (this.p2 + 1) % L;
      const y = this.s2 / L;
      // the slicer level: the middle of the highs and lows, each following a new extreme fast and forgetting slowly
      this.hi += (y > this.hi ? this.fast : this.slow) * (y - this.hi);
      this.lo += (y < this.lo ? this.fast : this.slow) * (y - this.lo);
      const sg = y > (this.hi + this.lo) / 2 ? 1 : -1;
      if (sg !== this.last) { let e = this.bitPh - half; if (e > half) e -= this.spb; else if (e < -half) e += this.spb; this.bitPh -= 0.2 * e; this.last = sg; }
      this.bitPh += 1;
      if (this.bitPh >= this.spb) { this.bitPh -= this.spb; this.bit(sg > 0 ? 1 : 0); }
    }
  }

  private bit(b: number): void {
    const R = this.ring.length; this.ring[this.n % R] = b; this.n++;
    this.tryAt(this.n - 40, 40);
    this.tryAt(this.n - 68, 68);
  }

  /** A word of `len` bits starting at bit `s0`, if a sync starts it and it was not already read as part of another. */
  private tryAt(s0: number, len: 40 | 68): void {
    if (s0 < 0 || s0 < this.doneTo) return;
    const R = this.ring.length;
    let v = 0; for (let k = 0; k < 9; k++) v = v * 2 + this.ring[(s0 + k) % R];
    const pol = v === LTR_SYNC ? 0 : (v ^ 0x1ff) === LTR_SYNC ? 1 : -1;
    if (pol < 0) return;
    if (len === 40) { this.frames++; if (this.frames > 32) { this.frames /= 2; this.good /= 2; } }
    const w = new Uint8Array(len); for (let k = 0; k < len; k++) w[k] = this.ring[(s0 + k) % R] ^ pol;
    let m: LtrMsg | null = null;
    if (len === 40) { if (ltrCheck(w)) { const x = parseLtr(w); if (x.kind !== 'other') m = x; } }
    else if (passportCheck(w)) { const x = parsePassport(w); if (x.kind !== 'other') m = x; }
    if (!m) return;
    this.good++; this.doneTo = s0 + len;
    this.onWord(m, w);
  }
}
