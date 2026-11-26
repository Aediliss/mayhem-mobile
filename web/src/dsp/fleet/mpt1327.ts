/**
 * FORK: MPT1327 control channels (the UK Radiocommunications Agency's trunking standard, used across Europe, Asia,
 * Australia and Africa): receive only, identity and call metadata only. No DOM.
 *
 * Air interface:
 *  - 1200 bit/s FFSK on an FM channel: 1200 Hz = 1, 1800 Hz = 0;
 *  - 64-bit codewords: bit 1 says address (1) or data (0) codeword, bits 1-48 information, bits 49-63 a 15-bit check
 *    (generator x^15 + x^14 + x^13 + x^11 + x^4 + x^2 + 1, i.e. 0x6815, with the last check bit inverted), bit 64 even
 *    parity over the codeword;
 *  - a forward control channel slot is 128 bits: the control channel system codeword (CCSC: bit 1 = 0, bits 2-16 the
 *    system identity SYS, then 16 bits, then 16 REVS bits 1010… and the 16-bit SYNC 0xC4D7), then an address codeword;
 *    traffic channels use SYNT 0x3B28; the French variant SYNC 0xB433 / SYNT 0x4BCC.
 *  - address codeword: PFIX bits 2-8, IDENT1 bits 9-21, then bits 22-30 the message type (bit 22 = 0: GTC, go to
 *    channel), with type-specific fields after.
 *
 * Reference (license checked 2026-11-26): SDRTrunk by Dennis Sheirer, `module/decode/mpt1327/` and `edac/CRCFleetsync`
 * (GPL-3.0-or-later). Field positions follow its MPT1327Message (frame index − 19 = codeword bit). The check is built
 * here from its generator; SDRTrunk's per-bit table is used only as a test vector. The CCSC's own check is not
 * verified (it is not in the reference): a system identity is believed once the same one is seen twice in a row.
 */

// ---------------------------------------------------------------------------------------------------- check

const G = 0xe815;                                         // x^15 + 0x6815
/** Contribution of information bit i (0 = codeword bit 1) to the check: x^(15 + 47 - i) mod g. */
export const MPT_CHECK_TABLE = (() => {
  const t = new Uint16Array(48);
  for (let i = 0; i < 48; i++) { let r = 1; for (let k = 0; k < 15 + 47 - i; k++) { r <<= 1; if (r & 0x8000) r ^= G; } t[i] = r & 0x7fff; }
  return t;
})();

/** The 15 check bits for 48 information bits (MSB = codeword bit 1), the last one inverted. */
export function mptCheck(info: ArrayLike<number>): number {
  let c = 1;                                               // the inverted last check bit
  for (let i = 0; i < 48; i++) if (info[i]) c ^= MPT_CHECK_TABLE[i];
  return c;
}

/** A whole 64-bit codeword (0/1 per bit) from its 48 information bits. */
export function mptCodeword(info: ArrayLike<number>): Uint8Array {
  const w = new Uint8Array(64);
  for (let i = 0; i < 48; i++) w[i] = info[i] ? 1 : 0;
  const c = mptCheck(w);
  for (let k = 0; k < 15; k++) w[48 + k] = (c >> (14 - k)) & 1;
  let p = 0; for (let i = 0; i < 63; i++) p ^= w[i];
  w[63] = p;                                               // even parity over all 64
  return w;
}

/** Whether a 64-bit codeword passes its check and parity; if not, a single bit error is corrected when one explains it. */
export function mptCheckCodeword(w: Uint8Array): 'ok' | 'corrected' | 'bad' {
  const good = () => { let p = 0; for (let i = 0; i < 64; i++) p ^= w[i]; if (p) return false; let c = 0; for (let k = 0; k < 15; k++) c = (c << 1) | w[48 + k]; return c === mptCheck(w); };
  if (good()) return 'ok';
  for (let b = 0; b < 63; b++) { w[b] ^= 1; if (good()) return 'corrected'; w[b] ^= 1; }
  return 'bad';
}

// ---------------------------------------------------------------------------------------------------- messages

/** Bits a..b (1-based codeword bits, inclusive), MSB first. */
const field = (w: ArrayLike<number>, a: number, b: number) => { let v = 0; for (let k = a; k <= b; k++) v = v * 2 + (w[k - 1] ? 1 : 0); return v; };

/** MPT1327 addresses are written prefix/ident (PFIX 0-127, IDENT 1-8100); 8101-8191 are special identities. */
export const mptAddr = (pfix: number, ident: number) => `${pfix}/${ident}`;
const SPECIAL: Record<number, string> = { 8101: 'IPFIXI', 8102: 'LINEI', 8103: 'PSTNGI', 8121: 'PABXI', 8181: 'DIVERTI', 8190: 'REGI', 8191: 'ALLI' };
export const mptIdent = (pfix: number, ident: number) => (ident === 0 ? 'none' : SPECIAL[ident] ? `${SPECIAL[ident]}${ident === 8191 ? ' (all units)' : ''}` : mptAddr(pfix, ident));

export type MptMsg =
  | { kind: 'gtc'; pfix: number; ident1: number; ident2: number; chan: number; data: boolean }       // go to channel: a call
  | { kind: 'aloha'; type: number; pfix: number; ident1: number; m: number; n: number }              // random access invitation
  | { kind: 'clear'; chan: number }                                                                   // down from an allocated channel
  | { kind: 'move'; pfix: number; chan: number }   // its channel field (bits 16-25) overlaps IDENT1: no identity read
  | { kind: 'ack'; type: number; pfix: number; ident1: number; ident2: number }
  | { kind: 'ahoy'; type: number; pfix: number; ident1: number; ident2: number }
  | { kind: 'maint'; pfix: number; ident1: number }
  | { kind: 'bcast'; sysdef: number; sys: number }
  | { kind: 'other'; type: number; pfix: number; ident1: number };

const NAMES: Record<number, string> = {
  256: 'ALH', 257: 'ALHS', 258: 'ALHD', 259: 'ALHE', 260: 'ALHR', 261: 'ALHX', 262: 'ALHF',
  264: 'ACK', 265: 'ACKI', 266: 'ACKQ', 267: 'ACKX', 268: 'ACKV', 269: 'ACKE', 270: 'ACKT', 271: 'ACKB',
  272: 'AHOY', 274: 'AHYX', 277: 'AHYP', 278: 'AHYQ', 279: 'AHYC', 280: 'MARK', 281: 'MAINT', 282: 'CLEAR', 283: 'MOVE', 284: 'BCAST',
};
export const mptTypeName = (t: number) => (t < 256 ? 'GTC' : NAMES[t] ?? `type ${t}`);

/** An address codeword (64 bits, checked) to what it says. */
export function parseMpt(w: ArrayLike<number>): MptMsg {
  const pfix = field(w, 2, 8), ident1 = field(w, 9, 21), type = field(w, 22, 30);
  if (type < 256) return { kind: 'gtc', pfix, ident1, ident2: field(w, 34, 46), chan: field(w, 24, 33), data: field(w, 23, 23) === 1 };
  if (type >= 256 && type <= 263) return { kind: 'aloha', type, pfix, ident1, m: field(w, 40, 44), n: field(w, 45, 48) };
  if (type === 282) return { kind: 'clear', chan: field(w, 2, 11) };
  if (type === 283) return { kind: 'move', pfix, chan: field(w, 16, 25) };
  if (type >= 264 && type <= 271) return { kind: 'ack', type, pfix, ident1, ident2: field(w, 31, 43) };
  if (type >= 272 && type <= 279) return { kind: 'ahoy', type, pfix, ident1, ident2: field(w, 31, 43) };
  if (type === 281) return { kind: 'maint', pfix, ident1 };
  if (type === 284) return { kind: 'bcast', sysdef: field(w, 2, 6), sys: field(w, 7, 21) };
  return { kind: 'other', type, pfix, ident1 };
}

export function mptLine(m: MptMsg): string {
  switch (m.kind) {
    case 'gtc': return `GTC · ${mptIdent(m.pfix, m.ident1)} ← ${mptIdent(m.pfix, m.ident2)} · CHAN ${m.chan}${m.data ? ' · data' : ''}`;
    case 'aloha': return `${mptTypeName(m.type)} · ${m.ident1 ? mptIdent(m.pfix, m.ident1) : 'all'} · M ${m.m} N ${m.n}`;
    case 'clear': return `CLEAR · CHAN ${m.chan}`;
    case 'move': return `MOVE · prefix ${m.pfix} → CHAN ${m.chan}`;
    case 'ack': case 'ahoy': return `${mptTypeName(m.type)} · ${mptIdent(m.pfix, m.ident1)} · ${mptIdent(m.pfix, m.ident2)}`;
    case 'maint': return `MAINT · ${mptIdent(m.pfix, m.ident1)}`;
    case 'bcast': return `BCAST · SYS ${m.sys.toString(16).toUpperCase().padStart(4, '0')} · SYSDEF ${m.sysdef}`;
    case 'other': return `${mptTypeName(m.type)} · ${mptIdent(m.pfix, m.ident1)}`;
  }
}

// ---------------------------------------------------------------------------------------------------- framing

export const MPT_SYNC = 0xc4d7, MPT_SYNT = 0x3b28, MPT_SYNC_FR = 0xb433, MPT_SYNT_FR = 0x4bcc;

/** A forward control channel slot (test transmitter): CCSC (0, SYS, 16 spare, REVS, SYNC) then an address codeword. */
export function encodeMptSlot(sys: number, address: ArrayLike<number>, sync = MPT_SYNC): Uint8Array {
  const out = new Uint8Array(128);
  out[0] = 0;
  for (let k = 0; k < 15; k++) out[1 + k] = (sys >> (14 - k)) & 1;
  for (let k = 0; k < 16; k++) out[32 + k] = k % 2 === 0 ? 1 : 0;     // REVS 1010…
  for (let k = 0; k < 16; k++) out[48 + k] = (sync >> (15 - k)) & 1;
  out.set(mptCodeword(address), 64);
  return out;
}
/** 48 information bits of an address codeword from fields (test transmitter for parseMpt). */
export function mptAddress(f: { pfix: number; ident1: number; type: number; rest?: [number, number, number][] }): Uint8Array {
  const w = new Uint8Array(48), put = (a: number, b: number, v: number) => { for (let k = b; k >= a; k--) { w[k - 1] = v & 1; v = Math.floor(v / 2); } };
  w[0] = 1; put(2, 8, f.pfix); put(9, 21, f.ident1); put(22, 30, f.type);
  for (const [a, b, v] of f.rest ?? []) put(a, b, v);
  return w;
}

// ---------------------------------------------------------------------------------------------------- receiver

/**
 * The control-channel receiver on a channel's complex baseband at `fs`: FM discriminator, the two FFSK tones measured
 * over a sliding bit-length window (1200 Hz = 1, 1800 Hz = 0), a bit clock on the tone decision, REVS+SYNC searched at
 * every bit in either polarity of the slicer, then the address codeword checked and the CCSC's system identity read.
 */
export class MptRx {
  onCodeword: (w: Uint8Array, sys: number | null) => void = () => undefined;
  frames = 0; good = 0;
  private pi = 0; private pq = 0;
  private readonly spb: number;
  private readonly hist: Float32Array; private hp = 0;
  private c1r = 0; private c1i = 0; private c2r = 0; private c2i = 0; private ph = 0;
  private readonly w1: number; private readonly w2: number;
  private bitPh = 0; private last = 0;
  private readonly ring = new Uint8Array(512); private n = 0; private hold = 0;
  private lastSys = -1; private sysRepeat = 0;

  constructor(readonly fs: number) {
    this.spb = fs / 1200;
    this.hist = new Float32Array(Math.max(4, Math.round(this.spb)));
    this.w1 = (2 * Math.PI * 1200) / fs; this.w2 = (2 * Math.PI * 1800) / fs;
  }

  push(zi: Float32Array, zq: Float32Array, m: number): void {
    const L = this.hist.length, half = this.spb / 2;
    for (let k = 0; k < m; k++) {
      const i = zi[k], q = zq[k];
      const a = Math.atan2(q * this.pi - i * this.pq, i * this.pi + q * this.pq); this.pi = i; this.pq = q;
      // sliding single-bin DFTs at 1200 and 1800 Hz over one bit (recursive: add the new term, drop the oldest)
      const old = this.hist[this.hp]; this.hist[this.hp] = a; this.hp = (this.hp + 1) % L;
      const t = this.ph, tOld = t - L;
      this.c1r += a * Math.cos(this.w1 * t) - old * Math.cos(this.w1 * tOld); this.c1i += a * Math.sin(this.w1 * t) - old * Math.sin(this.w1 * tOld);
      this.c2r += a * Math.cos(this.w2 * t) - old * Math.cos(this.w2 * tOld); this.c2i += a * Math.sin(this.w2 * t) - old * Math.sin(this.w2 * tOld);
      this.ph++; if (this.ph > 1e6) { this.ph = 0; this.c1r = this.c1i = this.c2r = this.c2i = 0; this.hist.fill(0); }
      const d = (this.c1r * this.c1r + this.c1i * this.c1i) - (this.c2r * this.c2r + this.c2i * this.c2i);   // >0: 1200 Hz (a 1)
      const sg = d > 0 ? 1 : -1;
      // the decision crosses zero when the bit-long window straddles a boundary; the window sits inside one bit half a
      // bit later, which is when to sample: pull the clock so crossings land at half a bit
      if (sg !== this.last) { let e = this.bitPh - half; if (e > half) e -= this.spb; else if (e < -half) e += this.spb; this.bitPh -= 0.15 * e; this.last = sg; }
      this.bitPh += 1;
      if (this.bitPh >= this.spb) { this.bitPh -= this.spb; this.bit(d > 0 ? 1 : 0); }
    }
  }

  private bit(b: number): void {
    const R = this.ring.length; this.ring[this.n % R] = b; this.n++;
    // REVS (last 4) + SYNC, then the 64-bit address codeword: the search runs 84 bits behind
    if (this.n < 84 + 48 || this.n - 84 < this.hold) return;
    const s0 = this.n - 84;
    const at = (k: number) => this.ring[(s0 + k) % R];
    let v = 0; for (let k = 0; k < 20; k++) v = v * 2 + at(k);
    const want = (0xa << 16) | MPT_SYNC, wantFr = (0xa << 16) | MPT_SYNC_FR;
    const inv = (~v) & 0xfffff;
    const pol = v === want || v === wantFr ? 0 : inv === want || inv === wantFr ? 1 : -1;
    if (pol < 0) return;
    const w = new Uint8Array(64); for (let k = 0; k < 64; k++) w[k] = at(20 + k) ^ pol;
    this.frames++;
    this.hold = this.n - 2;
    if (w[0] !== 1 || mptCheckCodeword(w) === 'bad') return;
    this.good++;
    // the CCSC this sync ended: bit 1 at 48 + 4 bits before the REVS we matched; SYS is its bits 2-16
    let sys: number | null = null;
    const c0 = s0 - 44;
    if (this.ring[c0 % R] ^ pol ? false : true) {
      let s = 0; for (let k = 1; k <= 15; k++) s = s * 2 + (this.ring[(c0 + k) % R] ^ pol);
      this.sysRepeat = s === this.lastSys ? this.sysRepeat + 1 : 0; this.lastSys = s;
      if (this.sysRepeat >= 1) sys = s;                     // the same identity twice running: believed
    }
    this.onCodeword(w, sys);
  }
}
