/**
 * FORK: NAVTEX (518 kHz international, 490 kHz national), receive only, written from ITU-R M.625-4 (mode B, FEC) and
 * M.540-2 (the NAVTEX format); no code ported. FSK at 100 Bd, 170 Hz shift, the higher frequency B (0), the lower Y (1)
 * (M.625 §1.2-1.3, Table 1 note 2). Each signal is 7 bits, first bit first, always four B and three Y (the constant
 * ratio that tells a mutilated one; the selective mode's inverted signals are the 3B/4Y ones, §4.5.2). Every signal is sent twice, DX and RX four signals later (§4.2); phasing puts
 * phasing signal 2 (RQ: YBBYYBB) in the DX positions and phasing signal 1 (α: BBBBYYY) in the RX positions
 * (§4.4). The receiver prints the unmutilated copy (both good but different: mutilated, §4.3). A message: ZCZC B1B2B3B4,
 * where B1 is the transmitter's coverage area, B2 the kind of message, B3B4 its serial number, then the text and NNNN
 * (M.540 Annex II). Both channels are decoded at once from one span.
 */
import { BitSync, type Emit, type IqProcessor } from './core.js';

/** M.625 Table 1: letter case, figure case, the 7-unit signal (B = 0, Y = 1, bit 1 first). */
const TABLE: [string, string, string][] = [
  // figure case D (who are you), F, G, H (unassigned) and J (the bell) print nothing
  ['A', '-', 'BBBYYYB'], ['B', '?', 'YBYYBBB'], ['C', ':', 'BYBBBYY'], ['D', '', 'BBYYBYB'], ['E', '3', 'YBBYBYB'], ['F', '', 'BBYBBYY'],
  ['G', '', 'BYBYBBY'], ['H', '', 'BYYBYBB'], ['I', '8', 'BYBBYYB'], ['J', '', 'BBBYBYY'], ['K', '(', 'YBBBBYY'], ['L', ')', 'BYBYYBB'],
  ['M', '.', 'BYYBBBY'], ['N', ',', 'BYYBBYB'], ['O', '9', 'BYYYBBB'], ['P', '0', 'BYBBYBY'], ['Q', '1', 'YBBBYBY'], ['R', '4', 'BYBYBYB'],
  ['S', "'", 'BBYBYYB'], ['T', '5', 'YYBYBBB'], ['U', '7', 'YBBBYYB'], ['V', '=', 'YYBBBBY'], ['W', '2', 'BBBYYBY'], ['X', '/', 'YBYBBBY'],
  ['Y', '6', 'BBYBYBY'], ['Z', '+', 'BBYYYBB'], ['\r', '\r', 'YYYBBBB'], ['\n', '\n', 'YYBBYBB'], ['LTRS', 'LTRS', 'YBYBBYB'], ['FIGS', 'FIGS', 'YBBYBBY'],
  [' ', ' ', 'YYBBBYB'], ['', '', 'YBYBYBB'],
];
const bitsOf = (s: string) => [...s].reduce((v, c, i) => v | ((c === 'Y' ? 1 : 0) << i), 0);
/** 7-bit value (bit 1 in bit 0) → index into TABLE; specials below. */
const BY_CODE = new Map<number, number>(TABLE.map((t, i) => [bitsOf(t[2]), i]));
export const ALPHA = bitsOf('BBBBYYY'), RQ = bitsOf('YBBYYBB'), BETA = bitsOf('BBYYBBY');
/** A signal is good when it has three Y (1) bits and four B. */
export const navtexGood = (v: number) => { let n = 0; for (let i = 0; i < 7; i++) n += (v >> i) & 1; return n === 3; };

export const NAVTEX_SUBJECT: Record<string, string> = {
  A: 'Navigational warning', B: 'Meteorological warning', C: 'Ice report', D: 'Search and rescue / piracy', E: 'Meteorological forecast',
  F: 'Pilot / VTS service', G: 'AIS', H: 'LORAN', I: 'Not used', J: 'SATNAV', K: 'Other electronic navaids', L: 'Navigational warning (additional)',
  V: 'Special service', W: 'Special service', X: 'Special service', Y: 'Special service', Z: 'No messages on hand',
};
export interface NavtexMessage { khz: number; id: string; b1: string; b2: string; serial: string; subject: string; text: string; errors: number; complete: boolean }

/** Transmitter side (tests): text → the 7-bit signals, with letter/figure shifts as needed. */
export function navtexEncode(text: string): number[] {
  const out: number[] = []; let figs = false;
  const code = (i: number) => bitsOf(TABLE[i][2]);
  out.push(code(TABLE.findIndex(t => t[0] === 'LTRS')));
  for (const ch of text.toUpperCase()) {
    const li = TABLE.findIndex(t => t[0] === ch), fi = TABLE.findIndex(t => t[1] === ch && t[1] !== '' && t[0] !== ch);
    if (li >= 0 && (li >= 26 || !figs || fi < 0)) { if (li < 26 && figs) { out.push(code(28)); figs = false; } out.push(code(li)); }
    else if (fi >= 0) { if (!figs) { out.push(code(29)); figs = true; } out.push(code(fi)); }
  }
  return out;
}
/** Transmitter side (tests): signals → the bit stream with phasing, DX/RX interleave, and idle α at the end. */
export function navtexBits(signals: number[], phasingPairs = 20): number[] {
  const dx: number[] = [], rx: number[] = [];
  for (let i = 0; i < phasingPairs; i++) { dx.push(RQ); rx.push(ALPHA); }
  const s0 = dx.length;
  for (const s of signals) dx.push(s);
  for (let i = 0; i < 6; i++) dx.push(ALPHA);
  // RX slot j carries DX slot j-2's signal once the message runs; phasing α before that
  for (let j = 0; j < dx.length; j++) rx[j] = j - 2 >= s0 ? dx[j - 2] : ALPHA;
  const bits: number[] = [];
  for (let j = 0; j < dx.length; j++) for (const v of [dx[j], rx[j]]) for (let i = 0; i < 7; i++) bits.push((v >> i) & 1);
  return bits;
}

/** Bits → signals → text → messages, for one channel. */
export class NavtexFramer {
  onMessage: (m: NavtexMessage) => void = () => undefined;
  onText: (s: string) => void = () => undefined;
  constructor(readonly khz: number) {}
  private sr = 0; private nbits = 0; private locked = false; private cur = 0; private nb = 0;
  private stream: number[] = []; private base = 0; private next = 0;   // stream[k]: slot base + (k >> 1), DX when k even
  private figs = false; private text = ''; private bad = 0; private recentBad: number[] = []; private alphas = 0;
  private msg: { id: string; start: number; errors: number } | null = null;

  push(bit: number): void {
    this.sr = ((this.sr << 1) | bit) & ((1 << 28) - 1); this.nbits++;
    if (!this.locked) {
      // the last four signals are RQ, α, RQ, α (DX, RX, DX, RX of the phasing): the next signal is in a DX position
      if (this.nbits >= 28) {
        const sig = (k: number) => { let v = 0; for (let i = 0; i < 7; i++) v |= ((this.sr >> (27 - 7 * k - i)) & 1) << i; return v; };
        if (sig(0) === RQ && sig(1) === ALPHA && sig(2) === RQ && sig(3) === ALPHA) {
          this.locked = true; this.cur = 0; this.nb = 0; this.stream = []; this.base = 0; this.next = 0; this.figs = false; this.recentBad = []; this.alphas = 0;
        }
      }
      return;
    }
    this.cur |= bit << this.nb;
    if (++this.nb < 7) return;
    this.stream.push(this.cur); this.cur = 0; this.nb = 0;
    this.drain();
  }

  /** Decode every DX slot whose RX copy (two slots on) has arrived. */
  private drain(): void {
    for (;;) {
      const j = this.next, kd = 2 * (j - this.base), kr = 2 * (j + 2 - this.base) + 1;
      if (kr >= this.stream.length) break;
      const d = this.stream[kd], r = this.stream[kr], dg = navtexGood(d), rg = navtexGood(r);
      // during phasing a DX slot holds phasing signal 2 while its RX copy's slot still holds α: that is phasing, not damage
      const v = d === RQ && r === ALPHA ? RQ : dg && rg ? (d === r ? d : -1) : dg ? d : rg ? r : -1;
      this.next++;
      this.signal(v);
      if (!this.locked) return;
    }
    // keep the stream short
    if (this.next - this.base > 64) { const drop = this.next - this.base - 4; this.stream.splice(0, 2 * drop); this.base += drop; }
  }

  private signal(v: number): void {
    this.recentBad.push(v < 0 ? 1 : 0); if (this.recentBad.length > 30) this.recentBad.shift();
    // too many mutilated signals: back to stand-by (§4.6.6)
    if (this.recentBad.length >= 30 && this.recentBad.reduce((a, b) => a + b, 0) > 15) { this.end(); return; }
    if (v === ALPHA) { if (++this.alphas >= 2) this.end(); return; }   // idle α in the DX position: end of transmission (§4.6.7.2)
    this.alphas = 0;
    if (v === RQ || v === BETA) return;   // phasing / idle during traffic
    if (v < 0) { this.bad++; if (this.msg) this.msg.errors++; this.out('*'); return; }
    const i = BY_CODE.get(v); if (i === undefined) { this.out('*'); return; }
    const [l, f] = TABLE[i];
    if (l === 'LTRS') { this.figs = false; return; }
    if (l === 'FIGS') { this.figs = true; return; }
    this.out(this.figs ? f : l);
  }

  private out(ch: string): void {
    if (ch === '\r') return;
    this.text += ch;
    if (this.text.length > 8000) this.text = this.text.slice(-4000);
    const t = this.text;
    if (!this.msg) {
      // the preamble must be read without errors (M.540 Annex II §3)
      const m = /ZCZC ([A-Z])([A-Z])(\d\d)$/.exec(t);
      if (m) this.msg = { id: `${m[1]}${m[2]}${m[3]}`, start: t.length, errors: 0 };
      return;
    }
    if (t.endsWith('NNNN')) { this.finish(true); return; }
  }
  private finish(complete: boolean): void {
    const m = this.msg; if (!m) return;
    this.msg = null;
    const body = this.text.slice(m.start, complete ? this.text.length - 4 : this.text.length).replace(/^\s+|\s+$/g, '');
    const [b1, b2] = m.id;
    this.onMessage({ khz: this.khz, id: m.id, b1, b2, serial: m.id.slice(2), subject: NAVTEX_SUBJECT[b2] ?? 'Unknown', text: body, errors: m.errors, complete });
  }
  private end(): void { if (this.msg) this.finish(false); this.locked = false; this.nbits = 0; this.sr = 0; this.text = ''; }
}

export const NAVTEX_CENTRE_HZ = 1_000_000;
export const NAVTEX_CHANNELS = [518_000, 490_000];

/** One channel: mixed to 0 Hz, a boxcar then a FIR down to 2 kHz, FM discriminator (lower = Y = 1), bit clock. */
class Channel {
  readonly framer: NavtexFramer;
  private D1 = 1; private D2 = 1; private fs2 = 2000; private taps = new Float32Array(1);
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;
  private ai = 0; private aq = 0; private an = 0;
  private bi = new Float32Array(0); private bq = new Float32Array(0); private bn = 0; private since = 0;
  private pi = 0; private pq = 0; private dc = 0; private sync = new BitSync(100, 2000, 0.15);
  constructor(readonly hz: number, rate: number, centre: number) {
    this.framer = new NavtexFramer(hz / 1000);
    this.D1 = Math.max(1, Math.round(rate / 50_000)); const fs1 = rate / this.D1;
    this.D2 = Math.max(1, Math.round(fs1 / 2000)); this.fs2 = fs1 / this.D2;
    const n = (8 * this.D2 + 1) | 1, h = new Float32Array(n), m = (n - 1) / 2, c = 250 / fs1; let s = 0;
    for (let i = 0; i < n; i++) { const x = i - m, v = x === 0 ? 2 * c : Math.sin(2 * Math.PI * c * x) / (Math.PI * x); h[i] = v * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1 || 1))); s += h[i]; }
    for (let i = 0; i < n; i++) h[i] /= s;
    this.taps = h; this.bi = new Float32Array(n); this.bq = new Float32Array(n);
    const off = hz - centre; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    this.sync = new BitSync(100, this.fs2, 0.15);
  }
  push(iq: Int8Array): void {
    let cr = this.cr, ci = this.ci;
    const n = iq.length >> 1, h = this.taps, T = h.length;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1];
      this.ai += a * cr - b * ci; this.aq += a * ci + b * cr;
      const t = cr * this.cdr - ci * this.cdi; ci = cr * this.cdi + ci * this.cdr; cr = t;
      if (++this.an < this.D1) continue;
      this.an = 0;
      this.bi[this.bn] = this.ai; this.bq[this.bn] = this.aq; this.ai = 0; this.aq = 0;
      this.bn = (this.bn + 1) % T;
      if (++this.since < this.D2) continue;
      this.since = 0;
      let x = 0, y = 0; for (let t2 = 0; t2 < T; t2++) { const v = (this.bn + t2) % T; x += h[t2] * this.bi[v]; y += h[t2] * this.bq[v]; }
      const f = Math.atan2(y * this.pi - x * this.pq, x * this.pi + y * this.pq); this.pi = x; this.pq = y;
      // the carrier's error is the mean of mark and space: a slow average of the discriminator
      this.dc += 0.002 * (f - this.dc);
      const bit = this.sync.push(this.dc - f);   // lower frequency → positive → Y (1)
      if (bit >= 0) this.framer.push(bit);
    }
    const g = 1.5 - (cr * cr + ci * ci) / 2; this.cr = cr * g; this.ci = ci * g;
  }
}

/** The NAVTEX app's processor: both channels from one span (the radio at 1 MHz, 2 MS/s, reaches 490 and 518 kHz). */
export class NavtexDecoder implements IqProcessor {
  centerHz = NAVTEX_CENTRE_HZ;
  private key = ''; private chans: Channel[] = [];
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${rate}`;
    if (key !== this.key) {
      this.key = key;
      this.chans = NAVTEX_CHANNELS.filter(f => Math.abs(f - this.centerHz) < rate / 2 - 5000).map(f => {
        const c = new Channel(f, rate, this.centerHz);
        c.framer.onMessage = m => { this.emit({ type: 'packet', line: navtexLine(m) }); this.emit({ type: 'navtex', m }); };
        return c;
      });
      this.emit({ type: 'log', line: this.chans.length ? `NAVTEX: listening on ${this.chans.map(c => c.hz / 1000).join(' and ')} kHz` : 'NAVTEX: 490/518 kHz are not in this span' });
    }
    for (const c of this.chans) c.push(iq);
  }
}

/** The message-log line. */
export function navtexLine(m: NavtexMessage): string {
  const head = `NAVTEX ${m.khz} kHz ${m.id} · ${m.subject}${m.complete ? '' : ' (incomplete)'}${m.errors ? ` · ${m.errors} unreadable` : ''}`;
  return m.text ? `${head}\n${m.text}` : head;
}
