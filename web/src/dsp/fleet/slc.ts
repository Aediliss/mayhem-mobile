/**
 * FORK: DMR short link control, receive only. Every base-station burst starts with a 24-bit CACH: 7 TACT bits
 * (access type, slot, LCSS, Hamming(7,4)) and a 17-bit fragment. Four fragments (LCSS first, continuation,
 * continuation, last) make 68 bits: a BPTC(68,36) product code (ETSI TS 102 361-1): three rows of Hamming(17,12,3)
 * and a row of column parity, interleaved by 17 mod 67. The 36 bits are SLCO (4), 24 data bits, CRC-8 (x^8+x^2+x+1).
 *
 * Opcodes read here (layouts after SDRTrunk by Dennis Sheirer, GPL-3.0-or-later, module/decode/dmr/.../lc/shorty):
 * 2 / 3 control / traffic channel system parameters (system identity code), 8 Hytera XPT channel (free repeater,
 * priority call), 9 / 10 Connect Plus traffic / control channel (network, site), 15 Capacity Plus rest channel.
 * Both codes are built here from their definitions: Hamming(17,12) is the cyclic code with generator x^5+x^2+1.
 */

/** Positions of the 17 fragment bits inside the 24-bit CACH (the other seven are the TACT). */
const PAYLOAD_POS = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 15, 16, 17, 19, 20, 21, 23];
const TACT_POS = [0, 4, 8, 12, 14, 18, 22];

/** What each Hamming(17,12) data bit adds to the five parity bits: x^(5 + 11 - k) mod x^5+x^2+1. */
export const H17_TABLE: number[] = (() => { const t: number[] = []; let c = 0x05; for (let k = 11; k >= 0; k--) { t[k] = c; c <<= 1; if (c & 0x20) c ^= 0x25; } return t; })();
const h17Syndrome = (r: Uint8Array, o: number) => { let s = 0; for (let k = 0; k < 12; k++) if (r[o + k]) s ^= H17_TABLE[k]; for (let k = 0; k < 5; k++) if (r[o + 12 + k]) s ^= 1 << (4 - k); return s; };

/** The first n bits times x^8, mod x^8+x^2+x+1 (zero over a whole short LC that carries its CRC). */
function crc8(bits: Uint8Array, n: number): number {
  let r = 0;
  for (let i = 0; i < n; i++) { const fb = ((r >> 7) & 1) ^ bits[i]; r = (r << 1) & 0xff; if (fb) r ^= 0x07; }
  return r;
}

export interface Tact { busy: number; slot: number; lcss: number; ok: boolean; hyteraScrambled: boolean }
/** The TACT of a CACH: checked by its Hamming(7,4); Hytera XPT flips the access-type bit, which is accepted too. */
export function readTact(cach: ArrayLike<number>): Tact {
  const t = TACT_POS.map(p => cach[p] & 1);
  const good = (d0: number) => (t[4] === (d0 ^ t[1] ^ t[2])) && (t[5] === (t[1] ^ t[2] ^ t[3])) && (t[6] === (d0 ^ t[1] ^ t[3]));
  const ok = good(t[0]), hyt = !ok && good(t[0] ^ 1);
  return { busy: t[0], slot: t[1], lcss: (t[2] << 1) | t[3], ok: ok || hyt, hyteraScrambled: hyt };
}

export type Slc =
  | { kind: 'params'; op: number; sysCode: number; text: string }
  | { kind: 'xpt'; free: number; prioRepeater: number; text: string }
  | { kind: 'conplus'; control: boolean; net: number; site: number; text: string }
  | { kind: 'caprest'; restLsn: number; site: number; text: string }
  | { kind: 'other'; op: number; text: string };

const field = (b: Uint8Array, a: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + b[a + i]; return v; };
/** The 36 decoded bits → a short LC. */
export function parseSlc(b: Uint8Array): Slc {
  const op = field(b, 0, 4), hex = Array.from({ length: 7 }, (_, i) => field(b, i * 4, 4).toString(16)).join('').toUpperCase();
  switch (op) {
    case 2: case 3: { const sc = field(b, 4, 16); return { kind: 'params', op, sysCode: sc, text: `${op === 2 ? 'CONTROL' : 'TRAFFIC'} CHANNEL SYSTEM PARAMETERS · SYSTEM CODE ${sc.toString(16).toUpperCase().padStart(4, '0')}` }; }
    case 8:
      if (field(b, 4, 8) === 0x68) { const free = field(b, 12, 4), prio = field(b, 16, 4); return { kind: 'xpt', free, prioRepeater: prio, text: `HYTERA XPT · ${free ? `FREE REPEATER ${free}` : 'ALL REPEATERS BUSY'}${prio ? ` · PRIORITY CALL ON REPEATER ${prio}` : ''}` }; }
      break;
    case 9: case 10: { const net = field(b, 4, 12), site = field(b, 16, 8); return { kind: 'conplus', control: op === 10, net, site, text: `CONNECT PLUS ${op === 10 ? 'CONTROL' : 'TRAFFIC'} CHANNEL · NETWORK ${net} · SITE ${site}` }; }
    case 15: if (field(b, 4, 8) === 0x10) { const rest = field(b, 15, 5), site = field(b, 20, 5); return { kind: 'caprest', restLsn: rest, site, text: `CAPACITY PLUS REST CHANNEL · LSN ${rest} · SITE ${site}` }; } break;
  }
  return { kind: 'other', op, text: `SHORT LC ${op} · ${hex}` };
}

/** 68 received (interleaved) bits → the 36 bits, or null: rows corrected by Hamming, columns and CRC-8 must then agree. */
export function bptc6836(rx: Uint8Array): Uint8Array | null {
  const m = new Uint8Array(68);
  for (let i = 0; i < 67; i++) m[(i * 17) % 67] = rx[i];
  m[67] = rx[67];
  for (let r = 0; r < 3; r++) {
    const s = h17Syndrome(m, r * 17); if (!s) continue;
    let at = H17_TABLE.indexOf(s); if (at < 0) { const p = [16, 8, 4, 2, 1].indexOf(s); if (p < 0) return null; at = 12 + p; }
    m[r * 17 + at] ^= 1;
  }
  // the parity row has no code of its own: one column off is a wrong bit there (the data rows are already clean)
  let off = 0; for (let c = 0; c < 17; c++) if (m[c] ^ m[17 + c] ^ m[34 + c] ^ m[51 + c]) off++;
  if (off > 1) return null;
  const out = new Uint8Array(36);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) out[r * 12 + c] = m[r * 17 + c];
  return crc8(out, 36) === 0 ? out : null;
}

/** Puts four fragments back together, as their LCSS says, and hands on each short LC that passes its checks. */
export class SlcAssembler {
  onSlc: (s: Slc, bits: Uint8Array) => void = () => undefined;
  good = 0; bad = 0;
  private buf = new Uint8Array(68); private n = -1;
  push(cach: ArrayLike<number>): void {
    const t = readTact(cach);
    if (!t.ok) { this.n = -1; return; }
    const frag = PAYLOAD_POS.map(p => cach[p] & 1);
    if (t.lcss === 1) { this.n = 0; }                         // first fragment
    else if (t.lcss === 0) { this.n = -1; return; }           // a single fragment (no CRC to check it by): not read
    else if (this.n < 0 || this.n > 3) { this.n = -1; return; }
    if ((t.lcss === 3 && (this.n < 1 || this.n > 2)) || (t.lcss === 2 && this.n !== 3)) { this.n = -1; return; }
    this.buf.set(frag, this.n * 17); this.n++;
    if (t.lcss !== 2) return;
    this.n = -1;
    const b = bptc6836(this.buf);
    if (!b) { this.bad++; return; }
    this.good++; this.onSlc(parseSlc(b), b);
  }
}

// ---------------------------------------------------------------------------------------------------- test transmitter

/** 36 bits from an opcode and 24 data bits, CRC-8 appended (test transmitter). */
export function slcBits(op: number, data24: number): Uint8Array {
  const b = new Uint8Array(36);
  for (let i = 0; i < 4; i++) b[i] = (op >> (3 - i)) & 1;
  for (let i = 0; i < 24; i++) b[4 + i] = Math.floor(data24 / 2 ** (23 - i)) & 1;
  const r = crc8(b, 28);                                     // the 28 bits times x^8, mod the generator
  for (let i = 0; i < 8; i++) b[28 + i] = (r >> (7 - i)) & 1;
  return b;
}
/** 36 bits → the four 24-bit CACHs that carry them (slot alternating, busy access type), as transmitted. */
export function slcCachs(b36: Uint8Array, hyteraScramble = false): Uint8Array[] {
  const m = new Uint8Array(68);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 12; c++) m[r * 17 + c] = b36[r * 12 + c];
    let s = 0; for (let k = 0; k < 12; k++) if (m[r * 17 + k]) s ^= H17_TABLE[k];
    for (let k = 0; k < 5; k++) m[r * 17 + 12 + k] = (s >> (4 - k)) & 1;
  }
  for (let c = 0; c < 17; c++) m[51 + c] = m[c] ^ m[17 + c] ^ m[34 + c];
  const tx = new Uint8Array(68);
  for (let i = 0; i < 67; i++) tx[i] = m[(i * 17) % 67];
  tx[67] = m[67];
  return [1, 3, 3, 2].map((lcss, k) => {
    const cach = new Uint8Array(24), d = [1, k & 1, lcss >> 1, lcss & 1];
    const t = [...d, d[0] ^ d[1] ^ d[2], d[1] ^ d[2] ^ d[3], d[0] ^ d[1] ^ d[3]];
    if (hyteraScramble) t[0] ^= 1;
    TACT_POS.forEach((p, i) => { cach[p] = t[i]; });
    PAYLOAD_POS.forEach((p, i) => { cach[p] = tx[k * 17 + i]; });
    return cach;
  });
}
