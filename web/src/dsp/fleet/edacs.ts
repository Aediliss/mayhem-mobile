/**
 * FORK: EDACS (Enhanced Digital Access Communications System) control channels, standard and networked: receive only,
 * identity and call metadata only. ProVoice (digital voice) calls are identified, never voiced. No DOM.
 *
 * Air interface, as TIA/EIA TSB-69.3 (April 1998) and the open decoders describe it:
 *  - two-level FSK at 9600 bd (wideband) or 4800 bd (narrowband);
 *  - a frame is the 48-bit sync 0x555557125555 then two 40-bit messages, each sent three times with the middle copy
 *    inverted (288 bits);
 *  - a message is 28 data bits then a 12-bit BCH check: the shortened binary BCH(63,51) double-error-correcting code
 *    over GF(64) built on x^6 + x + 1, i.e. generator g(x) = m1(x)·m3(x); parity = data·x^12 mod g(x); bits MSB first.
 *  - message layouts below carry TSB-69.3's section numbers.
 *
 * References (licenses checked 2026-11-26): DSD-FME `src/edacs-fme.c` by lwvmobile and ilyacodes (ISC; "All other
 * code is under the following license: ISC" in the repository's COPYRIGHT), whose standard parsing follows TSB-69.3;
 * edacs-fm (GPL-3.0) and ledacs by SP5WWP (Unlicense) before it. The BCH routine those use (R. Morelos-Zaragoza,
 * "free for non-commercial purposes") is NOT used here: the code is built from its definition below.
 */

// ---------------------------------------------------------------------------------------------------- BCH(40,28)

/** GF(64) on x^6 + x + 1: log and antilog tables. */
const EXP = new Uint8Array(126), LOG = new Int16Array(64).fill(-1);
{ let x = 1; for (let i = 0; i < 63; i++) { EXP[i] = EXP[i + 63] = x; LOG[x] = i; x <<= 1; if (x & 0x40) x ^= 0x43; } }
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The minimal polynomial over GF(2) of α^e: the product of (x + β) over β's conjugates α^e, α^2e, α^4e … */
function minimalPoly(e: number): number {
  const roots: number[] = []; let k = e % 63;
  do { roots.push(EXP[k]); k = (k * 2) % 63; } while (k !== e % 63);
  let poly = [1];                                        // coefficients in GF(64), lowest power first
  for (const r of roots) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) { next[i + 1] ^= poly[i]; next[i] ^= gmul(poly[i], r); }
    poly = next;
  }
  return poly.reduce((acc, c, i) => acc | ((c & 1) << i), 0);   // all coefficients are 0 or 1 by construction
}
const clmul = (a: number, b: number) => { let r = 0; for (let i = 0; b >> i; i++) if ((b >> i) & 1) r ^= a << i; return r; };

/** g(x) = m1(x)·m3(x), degree 12 (bit i = coefficient of x^i). */
export const EDACS_BCH_G = clmul(minimalPoly(1), minimalPoly(3));

/** The 12-bit BCH check of 28 data bits. */
export function edacsParity(data: number): number {
  let r = (data & 0xfffffff) * 4096;                      // data · x^12, up to 40 bits: stay in doubles, not int32
  for (let b = 39; b >= 12; b--) if (Math.floor(r / 2 ** b) % 2) r = xor40(r, EDACS_BCH_G * 2 ** (b - 12));
  return r;
}
/** XOR of two non-negative integers below 2^40 (JS bit operators are 32-bit). */
function xor40(a: number, b: number): number {
  const ah = Math.floor(a / 2 ** 20), al = a % 2 ** 20, bh = Math.floor(b / 2 ** 20), bl = b % 2 ** 20;
  return (ah ^ bh) * 2 ** 20 + (al ^ bl);
}
/** A full 40-bit message: data · 2^12 + check. */
export const edacsWord = (data: number) => (data & 0xfffffff) * 4096 + edacsParity(data);
/** Whether a 40-bit word's check matches its data. */
export const edacsCheckOk = (word: number) => word % 4096 === edacsParity(Math.floor(word / 4096));

// ---------------------------------------------------------------------------------------------------- frames

export const EDACS_SYNC_HI = 0x5555, EDACS_SYNC_LO = 0x57125555;   // 0x555557125555
export const EDACS_FRAME_BITS = 288;

/** The on-air bits of one frame (test transmitter): sync, then each message as copy, inverted copy, copy. */
export function encodeEdacsFrame(data1: number, data2: number): Uint8Array {
  const out = new Uint8Array(EDACS_FRAME_BITS); let o = 0;
  for (let b = 15; b >= 0; b--) out[o++] = (EDACS_SYNC_HI >> b) & 1;
  for (let b = 31; b >= 0; b--) out[o++] = (EDACS_SYNC_LO >>> b) & 1;
  for (const d of [data1, data2]) {
    const w = edacsWord(d);
    for (const inv of [0, 1, 0]) for (let b = 39; b >= 0; b--) out[o++] = (Math.floor(w / 2 ** b) % 2) ^ inv;
  }
  return out;
}

/**
 * The 240 bits after a sync (polarity applied, positive = 1) to the two messages' data, each null when its vote still
 * fails the check. Soft values vote better than hard bits: the three copies' values are summed (middle one negated).
 */
export function decodeEdacsFrame(soft: ArrayLike<number>): [number | null, number | null] {
  const msg = (base: number): number | null => {
    let w = 0;
    for (let b = 0; b < 40; b++) { const v = soft[base + b] - soft[base + 40 + b] + soft[base + 80 + b]; w = w * 2 + (v > 0 ? 1 : 0); }
    return edacsCheckOk(w) ? Math.floor(w / 4096) : null;
  };
  return [msg(0), msg(120)];
}

// ---------------------------------------------------------------------------------------------------- messages

export type EdacsMsg =
  | { kind: 'group'; digital: boolean; emergency: boolean; lid: number; lcn: number; txTrunk: boolean; group: number }   // 6.2.4.1/2
  | { kind: 'data'; individual: boolean; fromLid: boolean; port: number; lcn: number; target: number; targetIsLid: boolean }   // 6.2.4.3
  | { kind: 'login'; group: number; lid: number }                                                                       // 6.2.4.4
  | { kind: 'status'; status: number; lid: number; request: boolean }                                                   // 6.2.4.5
  | { kind: 'interconnect'; digital: boolean; lcn: number; target: number; targetIsLid: boolean }                      // 6.2.4.6
  | { kind: 'update'; digital: boolean; txTrunk: boolean; lcn: number; individual: boolean; emergency: boolean; target: number; source: number; test: boolean }   // 6.2.4.7
  | { kind: 'sgid'; sgid: number; group: number }                                                                       // 6.2.4.8
  | { kind: 'individual'; digital: boolean; txTrunk: boolean; lcn: number; target: number; source: number; test: boolean }   // 6.2.4.9
  | { kind: 'unkey'; drop: boolean; lcn: number; lid: number }                                                          // 6.2.4.10
  | { kind: 'adjacent'; ccLcn: number; index: number; siteId: number }                                                  // 6.2.4.12
  | { kind: 'allcall'; digital: boolean; update: boolean; txTrunk: boolean; lcn: number; lid: number }                  // 6.2.4.19
  | { kind: 'site'; siteId: number; ccLcn: number; priority: number; scat: boolean; failsoft: boolean; auxiliary: boolean }   // 6.2.4.18
  | { kind: 'other'; mtA: number; mtB: number; mtD: number; msg1: number; msg2: number };

/** LCNs from 26 up are not channels: they report a call's state. */
export const lcnStatus = (lcn: number) => (lcn >= 26 ? ['queued', 'system busy', 'denied', 'reserved', 'reserved', 'reserved'][lcn - 26] ?? 'status' : '');

/**
 * Two messages' data (as decoded) to what they say. `esk` is the optional ESK mask (e.g. 0xA0) some systems XOR into
 * bits 27..20 of both messages; 0 for none.
 */
export function parseEdacs(m1: number, m2: number, esk = 0): EdacsMsg {
  if (esk) { m1 ^= (esk & 0xff) << 20; m2 ^= (esk & 0xff) << 20; }
  const mtA = (m1 >>> 25) & 7, mtB = (m1 >>> 22) & 7, mtD = (m1 >>> 17) & 0x1f;
  const lcn15 = (m1 >>> 15) & 0x1f, lcn12 = (m1 >>> 12) & 0x1f, lid14 = m1 & 0x3fff, group11 = m1 & 0x7ff;
  if (mtA <= 3) return { kind: 'group', digital: mtA >= 2, emergency: (mtA & 1) === 1, lid: (((m1 >>> 18) & 0x7f) << 7) | ((m2 >>> 17) & 0x7f), lcn: lcn12, txTrunk: ((m1 >>> 11) & 1) === 1, group: group11 };
  if (mtA === 5) { const idLid = ((m1 >>> 14) & 1) === 1; return { kind: 'data', individual: ((m1 >>> 24) & 1) === 1, fromLid: ((m1 >>> 23) & 1) === 1, port: (((m1 >>> 20) & 7) << 3) | ((m2 >>> 20) & 7), lcn: lcn15, target: idLid ? lid14 : group11, targetIsLid: idLid }; }
  if (mtA === 6) return { kind: 'login', group: (m1 >>> 14) & 0x7ff, lid: lid14 };
  if (mtA === 7) {
    const mtC = (m1 >>> 20) & 3;
    switch (mtB) {
      case 0: { const status = (m1 >>> 14) & 0xff; return { kind: 'status', status, lid: lid14, request: status === 248 }; }
      case 1: { const idLid = ((m1 >>> 14) & 1) === 1; return { kind: 'interconnect', digital: mtC >= 2, lcn: lcn15, target: idLid ? lid14 : group11, targetIsLid: idLid }; }
      case 3: {
        const individual = ((m1 >>> 14) & 1) === 1, target = individual ? lid14 : group11, source = individual ? m2 & 0x3fff : 0;
        return { kind: 'update', digital: mtC === 1 || mtC === 3, txTrunk: mtC >= 2, lcn: lcn15, individual, emergency: !individual && ((m1 >>> 13) & 1) === 1, target, source, test: individual && target === 0 && source === 0 };
      }
      case 4: return { kind: 'sgid', sgid: (m1 >>> 11) & 0x7ff, group: group11 };
      case 5: { const target = lid14, source = m2 & 0x3fff; return { kind: 'individual', digital: ((m1 >>> 14) & 1) === 1, txTrunk: ((m1 >>> 21) & 1) === 1, lcn: lcn15, target, source, test: target === 0 && source === 0 }; }
      case 6: return { kind: 'unkey', drop: ((m1 >>> 19) & 1) === 1, lcn: (m1 >>> 14) & 0x1f, lid: lid14 };
      case 7:
        if (mtD === 0x01) return { kind: 'adjacent', ccLcn: lcn12, index: (m1 >>> 9) & 7, siteId: (m1 >>> 4) & 0x1f };
        if (mtD >= 0x08 && mtD <= 0x0b) return { kind: 'site', siteId: m1 & 0x1f, ccLcn: lcn12, priority: (m1 >>> 9) & 7, scat: ((m1 >>> 7) & 1) === 1, failsoft: ((m1 >>> 6) & 1) === 1, auxiliary: ((m1 >>> 5) & 1) === 1 };
        if (mtD === 0x0f) return { kind: 'allcall', digital: ((m1 >>> 11) & 1) === 1, update: ((m1 >>> 10) & 1) === 1, txTrunk: ((m1 >>> 9) & 1) === 1, lcn: lcn12, lid: (m1 & 0x7f) | ((m2 & 0xfe) << 6) };
    }
  }
  return { kind: 'other', mtA, mtB, mtD, msg1: m1, msg2: m2 };
}

/** One line for the log. Agency/fleet/subfleet splits are system configuration, so groups are shown as numbers. */
export function edacsLine(m: EdacsMsg): string {
  const lc = (n: number) => `LCN ${n}${lcnStatus(n) ? ` (${lcnStatus(n)})` : ''}`;
  const mode = (d: boolean) => (d ? 'PROVOICE (digital, not voiced)' : 'analog');
  switch (m.kind) {
    case 'group': return `GROUP CALL · group ${m.group} · LID ${m.lid} · ${lc(m.lcn)} · ${mode(m.digital)}${m.emergency ? ' · EMERGENCY' : ''}${m.txTrunk ? '' : ' · message trunked'}`;
    case 'update': return `${m.individual ? (m.test ? 'TEST CALL' : `INDIVIDUAL UPDATE · LID ${m.source} → ${m.target}`) : `GROUP UPDATE · group ${m.target}`} · ${lc(m.lcn)} · ${mode(m.digital)}${m.emergency ? ' · EMERGENCY' : ''}`;
    case 'individual': return m.test ? `TEST CALL · ${lc(m.lcn)}` : `INDIVIDUAL CALL · LID ${m.source} → ${m.target} · ${lc(m.lcn)} · ${mode(m.digital)}`;
    case 'data': return `DATA CALL · ${m.individual ? 'individual' : 'group'} ${m.targetIsLid ? 'LID' : 'group'} ${m.target} ${m.fromLid ? '→' : '←'} port ${m.port} · ${lc(m.lcn)}`;
    case 'interconnect': return `INTERCONNECT · ${m.targetIsLid ? 'LID' : 'group'} ${m.target} · ${lc(m.lcn)} · ${mode(m.digital)}`;
    case 'login': return `LOGIN · LID ${m.lid} · group ${m.group}`;
    case 'status': return m.request ? `STATUS REQUEST · LID ${m.lid}` : `MESSAGE ACK · status ${m.status} · LID ${m.lid}`;
    case 'sgid': return `SYSTEM ASSIGNED ID · SGID ${m.sgid} · group ${m.group}`;
    case 'unkey': return `${m.drop ? 'CHANNEL DROP' : 'UNKEY'} · LID ${m.lid} · ${lc(m.lcn)}`;
    case 'adjacent': return `ADJACENT SITE · site ${m.siteId} · CC ${lc(m.ccLcn)} · #${m.index}`;
    case 'allcall': return `SYSTEM ALL-CALL${m.update ? ' UPDATE' : ''} · LID ${m.lid} · ${lc(m.lcn)} · ${mode(m.digital)}`;
    case 'site': return `SITE ID · site ${m.siteId} · CC ${lc(m.ccLcn)} · priority ${m.priority}${m.failsoft ? ' · FAILSOFT' : ''}${m.scat ? ' · SCAT' : ''}${m.auxiliary ? ' · auxiliary CC' : ''}`;
    case 'other': return `MT-A ${m.mtA}${m.mtA === 7 ? ` MT-B ${m.mtB}${m.mtB === 7 ? ` MT-D ${m.mtD.toString(16)}` : ''}` : ''} · ${m.msg1.toString(16).padStart(7, '0')} ${m.msg2.toString(16).padStart(7, '0')}`;
  }
}

// ---------------------------------------------------------------------------------------------------- receiver

/**
 * The control-channel receiver on a channel's complex baseband at `fs` (at least ~2.5× the baud rate; a 25 kHz
 * channel for 9600 bd): FM discriminator, a moving average a symbol long, a bit clock pulled to the zero crossings,
 * the 48-bit sync searched at every bit in either polarity, and a frame's 240 bits voted and checked.
 */
export class EdacsRx {
  onFrame: (m1: number | null, m2: number | null) => void = () => undefined;
  /** Frames found, and messages that passed their check. */
  frames = 0; good = 0;
  private pi = 0; private pq = 0; private dc = 0; private ph = 0; private last = 0; private center = 0;
  private readonly sps: number; private readonly hist: Float32Array; private hp = 0; private hs = 0;
  private readonly ring = new Float32Array(512); private n = 0; private hold = 0;

  constructor(readonly fs: number, readonly baud = 9600) {
    this.sps = fs / baud;
    this.hist = new Float32Array(Math.max(1, Math.round(this.sps * 0.75)));
  }

  push(zi: Float32Array, zq: Float32Array, m: number): void {
    const L = this.hist.length, sps = this.sps, half = sps / 2;
    for (let k = 0; k < m; k++) {
      const i = zi[k], q = zq[k];
      const f = Math.atan2(q * this.pi - i * this.pq, i * this.pi + q * this.pq); this.pi = i; this.pq = q;
      this.hs += f - this.hist[this.hp]; this.hist[this.hp] = f; if (++this.hp >= L) this.hp = 0;
      const v = this.hs / L; this.dc += (v - this.dc) / (sps * 400); const x = v - this.dc;
      const sg = x > 0 ? 1 : -1;
      if (sg !== this.last) { let e = this.ph; if (e > half) e -= sps; this.ph -= 0.1 * e; this.last = sg; }
      const was = this.ph; this.ph += 1;
      if (was < half && this.ph >= half) this.center = x;
      if (this.ph >= sps) { this.ph -= sps; this.bit(this.center); }
    }
  }

  private bit(x: number): void {
    const R = this.ring.length; this.ring[this.n % R] = x; this.n++;
    if (this.n < EDACS_FRAME_BITS || this.n - EDACS_FRAME_BITS < this.hold) return;
    const s0 = this.n - EDACS_FRAME_BITS;
    let hi = 0, lo = 0;
    for (let b = 0; b < 16; b++) hi = (hi << 1) | (this.ring[(s0 + b) % R] > 0 ? 1 : 0);
    for (let b = 16; b < 48; b++) lo = ((lo << 1) | (this.ring[(s0 + b) % R] > 0 ? 1 : 0)) >>> 0;
    const pol = hi === EDACS_SYNC_HI && lo === EDACS_SYNC_LO ? 1 : hi === (~EDACS_SYNC_HI & 0xffff) && lo === (~EDACS_SYNC_LO >>> 0) ? -1 : 0;
    if (!pol) return;
    const soft = new Float32Array(240);
    for (let b = 0; b < 240; b++) soft[b] = pol * this.ring[(s0 + 48 + b) % R];
    const [m1, m2] = decodeEdacsFrame(soft);
    this.frames++; if (m1 !== null) this.good++; if (m2 !== null) this.good++;
    this.hold = this.n - 2;                               // the sync pattern can recur inside a frame's data
    this.onFrame(m1, m2);
  }
}
