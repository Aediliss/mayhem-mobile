/**
 * FORK: PSK63, PSK125 and QPSK31 on the HAM receiver's audio, receive only, beside the upstream PSK31 decoder (whose
 * approach this follows: a complex mixer at the centre frequency, a two-pole low-pass, 16 samples a symbol, the symbol
 * clock from the amplitude dips, differential detection, varicode with "00" between characters). BPSK at 62.5 and 125
 * baud is PSK31 faster. QPSK31 after fldigi (src/psk/psk.cxx, src/filters/viterbi.cxx; GPL-3.0-or-later): the text's
 * bits go through a K=5 rate-1/2 convolutional code (polynomials 0x17, 0x19, the first in the low bit of the output pair),
 * and each pair selects the phase change: 0 → 180°, 1 → +90°, 2 → 0°, 3 → 270° (tx_carriers' (4 − sym) & 3 then ×90°
 * from 180°); the receiver turns the phase change into two soft bits and a Viterbi decoder recovers the text bits.
 */
import { VARICODE } from './varicode.js';
import type { DigitalDecoder } from './digital.js';

const RATE = 48_000;
const POLY1 = 0x17, POLY2 = 0x19, K = 5, NSTATE = 1 << (K - 1), TRACE = 30;   // six constraint lengths
const parity = (x: number) => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
/** The code's output pair for a 5-bit register (the newest bit lowest): POLY1 in bit 0, POLY2 in bit 1. */
const OUT = Array.from({ length: 1 << K }, (_, r) => parity(r & POLY1) | (parity(r & POLY2) << 1));
/** Encoder output pair → phase change in quarter turns (fldigi: 0 → 180°, 1 → 90°, 2 → 0°, 3 → 270°). */
const PH = [2, 1, 0, 3];

/** Soft-decision Viterbi for the K=5 code; one decoded bit out per pair in, [TRACE] pairs late. */
class Viterbi {
  private metric = new Float32Array(NSTATE); private next = new Float32Array(NSTATE);
  private readonly hist: Int8Array[] = []; private n = 0;
  reset(): void { this.metric.fill(0); this.hist.length = 0; this.n = 0; }
  /** [s0], [s1]: soft values for the pair's bits (+ = 1). Returns the bit decided TRACE steps ago, or -1. */
  step(s0: number, s1: number): number {
    const prevOf = new Int8Array(NSTATE);
    this.next.fill(-1e30);
    for (let st = 0; st < NSTATE; st++) for (let b = 0; b <= 1; b++) {
      const reg = (st << 1) | b, ns = reg & (NSTATE - 1), o = OUT[reg];
      const m = this.metric[st] + ((o & 1) ? s0 : -s0) + ((o & 2) ? s1 : -s1);
      if (m > this.next[ns]) { this.next[ns] = m; prevOf[ns] = st; }
    }
    [this.metric, this.next] = [this.next, this.metric];
    let mx = -1e30; for (const v of this.metric) if (v > mx) mx = v; for (let i = 0; i < NSTATE; i++) this.metric[i] -= mx;
    this.hist.push(prevOf); if (this.hist.length > TRACE + 1) this.hist.shift();
    if (++this.n <= TRACE) return -1;
    let st = 0; for (let i = 1; i < NSTATE; i++) if (this.metric[i] > this.metric[st]) st = i;
    for (let i = this.hist.length - 1; i > 0; i--) st = this.hist[i][st];
    return st & 1;   // the newest bit of the oldest state on the path
  }
}

export class PskDecoder implements DigitalDecoder {
  readonly name: string;
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  private decim: number; private readonly spb = 16;
  private cr = 1; private ci = 0; private dr = 1; private di = 0; private a = 0;
  private i1 = 0; private i2 = 0; private q1 = 0; private q2 = 0; private n = 0;
  private readonly energy = new Float32Array(16); private phase = 0; private nsym = 0; private centre = 0;
  private readonly ri = new Float32Array(16); private readonly rq = new Float32Array(16); private rp = 0;
  private lastI = 0; private lastQ = 0; private fq = 0; private acc = 0;
  private code = ''; private zeros = 0; private dips = 0; private samples = 0;
  private readonly vit = new Viterbi();

  /** [baud]: 31.25, 62.5 or 125; [qpsk]: QPSK with the K=5 code (else BPSK). */
  constructor(readonly baud: number, readonly qpsk: boolean, public center = 1000) {
    this.name = `${qpsk ? 'QPSK' : 'PSK'}${baud < 40 ? 31 : Math.round(baud)}`;
    this.decim = Math.round(RATE / (baud * this.spb));
    this.setup();
  }
  setCenter(hz: number): void { this.center = hz; this.setup(); }
  private setup(): void {
    const w = -2 * Math.PI * this.center / RATE; this.dr = Math.cos(w); this.di = Math.sin(w);
    this.a = 1 - Math.exp(-2 * Math.PI * 2.5 * this.baud / RATE);   // wide: the matched filter below does the work
    this.energy.fill(0); this.phase = 0; this.nsym = 0; this.code = ''; this.zeros = 0; this.fq = 0; this.acc = 0; this.confidence = 0; this.vit.reset();
  }
  reset(): void { this.setup(); }

  push(x: Float32Array, nIn: number): void {
    for (let k = 0; k < nIn; k++) {
      const v = x[k], i = v * this.cr, q = v * this.ci;
      const nr = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = nr;
      this.i1 += this.a * (i - this.i1); this.i2 += this.a * (this.i1 - this.i2);
      this.q1 += this.a * (q - this.q1); this.q2 += this.a * (this.q1 - this.q2);
      if (++this.n < this.decim) continue;
      this.n = 0;
      const g = 1.5 - (this.cr * this.cr + this.ci * this.ci) / 2; this.cr *= g; this.ci *= g;
      const I = this.i2, Q = this.q2, e = I * I + Q * Q;
      this.ri[this.rp] = I; this.rq[this.rp] = Q; this.rp = (this.rp + 1) % this.spb;
      const al = this.nsym < 32 * this.spb ? 0.15 : 0.03; this.nsym++;   // a quick start, then steady
      this.energy[this.phase] = this.energy[this.phase] * (1 - al) + e * al;
      // the symbol centre is where the envelope peaks (it dips at each phase change); half a symbol after it, sum the
      // symbol around it weighted by the pulse shape (a matched filter)
      if (this.phase === 0) { let best = 0; for (let j = 1; j < this.spb; j++) if (this.energy[j] > this.energy[best]) best = j; this.centre = best; }
      if (this.phase === (this.centre + this.spb / 2) % this.spb) {
        let sI = 0, sQ = 0;
        for (let j = 0; j < this.spb; j++) { const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * (j + 0.5 - this.spb / 2) / this.spb), k2 = (this.rp + j) % this.spb; sI += w * this.ri[k2]; sQ += w * this.rq[k2]; }
        this.symbol(sI, sQ);
      }
      this.phase = (this.phase + 1) % this.spb;
    }
  }

  private symbol(I: number, Q: number): void {
    // AFC: the tracked offset [fq] (radians a symbol) turns each symbol back by its running total
    this.acc = (this.acc + this.fq) % (2 * Math.PI);
    const c = Math.cos(this.acc), s = Math.sin(this.acc), ri = I * c + Q * s, rq = Q * c - I * s;
    const dre = ri * this.lastI + rq * this.lastQ, dim = rq * this.lastI - ri * this.lastQ;   // cur · conj(prev)
    const mag = Math.hypot(dre, dim) + 1e-12;
    this.lastI = ri; this.lastQ = rq;
    if (!this.qpsk) {
      const bit = dre > 0 ? 1 : 0;
      if (bit === 1) this.fq += this.afcGain() * Math.atan2(dim, dre);
      this.tally(bit === 0, mag); this.bit(bit);
      return;
    }
    // QPSK: four-fold phase error for the AFC; the phase change as two soft bits
    const ph = Math.atan2(dim, dre), err = Math.atan2(Math.sin(4 * ph), Math.cos(4 * ph)) / 4;
    this.fq += this.afcGain() * err;
    const cs = dre / mag, sn = dim / mag;
    const s0 = Math.abs(sn) - Math.abs(cs);            // pair bit 0 set: ±90°
    const s1 = (cs - sn) / Math.SQRT2;                 // pair bit 1 set: 0° or 270°
    const q = Math.round(((ph % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 2)) & 3;
    this.tally(q === 2, mag);
    const b = this.vit.step(s0, s1);
    if (b >= 0) this.bit(b);
  }

  /** AFC loop gain: fast for the first symbols (a transmission's idle preamble), then slow. */
  private afcGain(): number { return this.nsym < 64 * this.spb ? 0.12 : 0.02; }

  private tally(reversal: boolean, mag: number): void {
    this.samples++; if (reversal) this.dips++;
    if (this.samples >= 64) { const r = this.dips / this.samples; this.confidence = r > 0.1 && r < 0.8 && mag > 1e-10 ? Math.min(1, this.confidence + 0.1) : Math.max(0, this.confidence - 0.15); this.samples = 0; this.dips = 0; }
  }

  /** Varicode: characters never hold "00"; "00" is the gap between them. */
  private bit(bit: number): void {
    if (bit === 0) {
      if (this.zeros === 1) {
        const code = this.code.slice(0, -1);
        if (code) { const idx = VARICODE.indexOf(code); if (idx >= 32 && idx < 127) this.onText(String.fromCharCode(idx), `${this.name} ${this.center} Hz`); else if (idx === 10 || idx === 13) this.onText('\n'); }
        this.code = ''; this.zeros = 0;
      } else { this.zeros = 1; this.code += '0'; }
    } else { this.zeros = 0; this.code += '1'; }
    if (this.code.length > 12) this.code = '';
  }
}

// ---- test signal ------------------------------------------------------------------------------------------------------
/** Text → the varicode bit stream (idle zeros before and after, "00" after each character). */
export function pskBits(text: string, idle = 40): number[] {
  const b: number[] = new Array(idle).fill(0);
  for (const ch of text) { for (const c of VARICODE[ch.charCodeAt(0)] ?? '') b.push(c === '1' ? 1 : 0); b.push(0, 0); }
  for (let i = 0; i < idle; i++) b.push(0);
  return b;
}
/** Bits → real audio at [rate]: BPSK (0 = phase reversal) or QPSK through the K=5 code; cosine-shaped transitions. */
export function pskAudio(bits: number[], baud: number, qpsk: boolean, centreHz: number, rate: number, amp = 1): Float32Array {
  const pts: [number, number][] = [[1, 0]]; let reg = 0;
  for (const bit of bits) {
    let quarter: number;
    if (qpsk) { reg = ((reg << 1) | bit) & 31; quarter = PH[OUT[reg]]; } else quarter = bit ? 0 : 2;
    const [x, y] = pts[pts.length - 1], c = Math.cos(quarter * Math.PI / 2), s = Math.sin(quarter * Math.PI / 2);
    pts.push([x * c - y * s, x * s + y * c]);
  }
  const ns = rate / baud, out = new Float32Array(Math.round(pts.length * ns));
  for (let k = 0; k < out.length; k++) {
    const t = k / ns, i = Math.min(pts.length - 1, Math.floor(t)), f = t - i, p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
    const w = 0.5 - 0.5 * Math.cos(Math.PI * f), re = p0[0] * (1 - w) + p1[0] * w, im = p0[1] * (1 - w) + p1[1] * w, ph = 2 * Math.PI * centreHz * k / rate;
    out[k] = amp * (re * Math.cos(ph) - im * Math.sin(ph));
  }
  return out;
}
