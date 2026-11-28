/**
 * FORK: MFSK16 and MFSK32 on the HAM receiver's USB audio, receive only. After fldigi (GPL-3.0-or-later):
 * src/mfsk/mfsk.cxx (sendbit / sendsymbol, softdecode, decodesymbol, recvbit), src/mfsk/interleave.cxx,
 * src/include/mfsk.h (the K=7 code, polynomials 0x6d and 0x4f) and src/mfsk/mfskvaricode.cxx (IZ8BLY's varicode):
 *  - 16 tones, Gray-coded, 8 kHz with 512 (MFSK16: 15.625 baud and Hz) or 256 (MFSK32: 31.25) samples a symbol, the
 *    lowest tone (bandwidth / 2) below the centre;
 *  - text → varicode bits → the K=7 rate-1/2 code (each input bit gives the first then the second polynomial's bit) →
 *    4 bits a symbol through a diagonal interleaver (4×4, 10 deep) → the symbol's tone.
 * Receiver: audio at 8 kHz; one-symbol spectra (zero-padded to half-tone bins) every quarter symbol; four symbol phases
 * × ±2 tones of offset decoded side by side, each as fldigi does (soft bits from the tones' magnitudes by their Gray-
 * decoded bits, the reverse interleaver, pairs of soft bits into a Viterbi decoder, varicode); the text comes from the
 * stream whose soft bits fit the code best (a steady choice: another must lead clearly before it changes), squelched
 * until the strongest tone's share of the 16 is clearly above what noise gives.
 */
import { fft } from '../../fft.js';
import { ftxShared } from './ft8.js';
import { MFSK_VARICODE } from './mfsk-varicode.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000, NT = 16, BITS = 4, DEPTH = 10;
const parity = (x: number) => { x ^= x >> 16; x ^= x >> 8; x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
const gray = (x: number) => x ^ (x >> 1);
const ungray = (g: number) => { let x = g; for (let s = g >> 1; s; s >>= 1) x ^= s; return x; };
const VARIDEC = new Map<number, number>(MFSK_VARICODE.map((c, i) => [parseInt(c, 2), i]));

/** A rate-1/2 convolutional code's Viterbi decoder (soft values: + means 1), [trace] pairs of delay. */
export class ConvViterbi {
  private readonly ns: number; private readonly out: number[];
  private metric: Float64Array; private next: Float64Array; private readonly hist: Uint8Array[] = []; private n = 0;
  /** How well the soft values fit the code (running mean of the best path's gain over the most it could gain, −1..1). */
  fit = 0; private nf = 0;
  constructor(readonly k: number, p1: number, p2: number, readonly trace = 5 * k * 2) {
    this.ns = 1 << (k - 1);
    this.out = Array.from({ length: 1 << k }, (_, r) => parity(r & p1) | (parity(r & p2) << 1));
    this.metric = new Float64Array(this.ns); this.next = new Float64Array(this.ns);
  }
  reset(): void { this.metric.fill(0); this.hist.length = 0; this.n = 0; this.fit = 0; this.nf = 0; }
  /** Output pair bits of a register state (for the encoder). */
  outOf(reg: number): number { return this.out[reg & ((1 << this.k) - 1)]; }
  /** One pair in; the bit decided [trace] pairs ago out, or -1. */
  step(s0: number, s1: number): number {
    const prev = new Uint8Array(this.ns); this.next.fill(-1e300);
    for (let st = 0; st < this.ns; st++) for (let b = 0; b <= 1; b++) {
      const reg = (st << 1) | b, nx = reg & (this.ns - 1), o = this.out[reg];
      const m = this.metric[st] + ((o & 1) ? s0 : -s0) + ((o & 2) ? s1 : -s1);
      if (m > this.next[nx]) { this.next[nx] = m; prev[nx] = st; }
    }
    [this.metric, this.next] = [this.next, this.metric];
    let mx = -1e300; for (const v of this.metric) if (v > mx) mx = v; for (let i = 0; i < this.ns; i++) this.metric[i] -= mx;
    const w = Math.abs(s0) + Math.abs(s1);
    if (w > 1e-6) { this.nf++; this.fit += Math.max(0.02, 1 / this.nf) * (mx / w - this.fit); }   // a plain mean at first
    this.hist.push(prev); if (this.hist.length > this.trace + 1) this.hist.shift();
    if (++this.n <= this.trace) return -1;
    let st = 0; for (let i = 1; i < this.ns; i++) if (this.metric[i] > this.metric[st]) st = i;
    for (let i = this.hist.length - 1; i > 0; i--) st = this.hist[i][st];
    return st & 1;
  }
}

/** fldigi's diagonal interleaver (size × size, [depth] deep): FWD at the transmitter, REV at the receiver. */
export class Interleaver {
  private readonly t: Float32Array;
  constructor(readonly size: number, readonly depth: number, readonly fwd: boolean) { this.t = new Float32Array(size * size * depth).fill(fwd ? 0 : 128); }
  private at(k: number, i: number, j: number): number { return this.size * this.size * k + this.size * i + j; }
  symbols(s: Float32Array | number[]): void {
    const n = this.size;
    for (let k = 0; k < this.depth; k++) {
      for (let i = 0; i < n; i++) for (let j = 0; j < n - 1; j++) this.t[this.at(k, i, j)] = this.t[this.at(k, i, j + 1)];
      for (let i = 0; i < n; i++) this.t[this.at(k, i, n - 1)] = s[i];
      for (let i = 0; i < n; i++) s[i] = this.fwd ? this.t[this.at(k, i, n - i - 1)] : this.t[this.at(k, i, i)];
    }
  }
}

/** One receive stream: a symbol phase and frequency offset, with its own interleaver, decoder and varicode state. */
class Stream {
  readonly inlv = new Interleaver(BITS, DEPTH, false);
  readonly vit = new ConvViterbi(7, 0x6d, 0x4f, 45);
  private pair: number[] = []; private shreg = 1;
  get quality(): number { return this.vit.fit; }
  /** How much the strongest tone stands out (running mean of its share of the 16; noise ≈ 0.15). */
  peak = 0; private np = 0;
  constructor(private readonly onChar: (c: number) => void) {}
  /** A symbol's 16 tone magnitudes (index = tone). */
  symbol(mag: Float32Array): void {
    let sum = 0, mx = 0; for (const m of mag) { sum += m; if (m > mx) mx = m; }
    this.np++; this.peak += Math.max(0.03, 1 / this.np) * (mx / (sum || 1) - this.peak);
    const b = new Float32Array(BITS);
    for (let i = 0; i < NT; i++) { const j = ungray(i); for (let k = 0; k < BITS; k++) b[k] += (j >> (BITS - k - 1)) & 1 ? mag[i] : -mag[i]; }
    const soft = Array.from(b, v => Math.max(0, Math.min(255, 128 + v / (sum || 1e-10) * 256)));
    this.inlv.symbols(soft);
    for (const s of soft) {
      this.pair.push(s - 128);
      if (this.pair.length < 2) continue;
      const bit = this.vit.step(this.pair[0], this.pair[1]); this.pair = [];
      if (bit < 0) continue;
      this.shreg = ((this.shreg << 1) | bit) >>> 0;
      if ((this.shreg & 7) === 1) { const c = VARIDEC.get(this.shreg >>> 1); if (c !== undefined) this.onChar(c); this.shreg = 1; }
      if (this.shreg > 0xFFFFF) this.shreg = 1;
    }
  }
}

export class MfskDecoder implements DigitalDecoder {
  readonly name: string;
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  private readonly symlen: number; private readonly NF: number; private readonly spacing: number;
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private readonly buf: Float32Array; private bn = 0; private tick = 0; private phase = 0;
  private streams: Stream[] = []; private best = 0;
  private readonly offsets = [-4, -3, -2, -1, 0, 1, 2, 3, 4];   // half tones
  private readonly re: Float32Array; private readonly im: Float32Array;
  /** [baud]: 15.625 (MFSK16) or 31.25 (MFSK32). */
  constructor(readonly baud: number, public center = 1500) {
    this.name = baud < 20 ? 'MFSK16' : 'MFSK32';
    this.symlen = Math.round(FS / baud); this.spacing = FS / this.symlen; this.NF = 2 * this.symlen;
    this.buf = new Float32Array(this.symlen); this.re = new Float32Array(this.NF); this.im = new Float32Array(this.NF);
    this.setup();
  }
  setCenter(hz: number): void { this.center = hz; this.setup(); }
  private setup(): void {
    this.streams = Array.from({ length: 4 * this.offsets.length }, (_, i) => new Stream(c => { if (i === this.best && this.open()) this.char(c); }));
    this.best = 4 * Math.floor(this.offsets.length / 2); this.confidence = 0;
  }
  reset(): void { this.rs.reset(); this.setup(); }
  /** Squelch: one tone stands out (noise alone ≈ 0.13 of the 16; a signal at −10 dB in 2500 Hz ≈ 0.2). */
  private open(): boolean { return this.streams[this.best].peak > 0.16; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => {
      this.buf[this.bn] = v; this.bn = (this.bn + 1) % this.buf.length;
      if (++this.tick >= this.symlen / 4) { this.tick -= this.symlen / 4; this.slice(); }
    });
  }

  private slice(): void {
    const re = this.re, im = this.im, L = this.symlen; re.fill(0); im.fill(0);
    for (let j = 0; j < L; j++) re[j] = this.buf[(this.bn + j) % L];
    fft(re, im);
    const ph = this.phase; this.phase = (this.phase + 1) % 4;
    const bw = (NT - 1) * this.spacing, f0 = this.center - bw / 2, bin0 = f0 / FS * this.NF;   // 2 bins a tone
    this.offsets.forEach((o, oi) => {
      const mag = new Float32Array(NT);
      for (let t = 0; t < NT; t++) { const b = Math.round(bin0 + 2 * t + o); if (b > 0 && b < this.NF / 2) mag[t] = Math.hypot(re[b], im[b]); }
      this.streams[oi * 4 + ph].symbol(mag);
    });
    // the stream the code fits best leads (a stream a whole tone off sees clean tones but the wrong symbols, and the
    // wrong phase blurred ones; neither fits the code); another takes over only when clearly better
    let bi = this.best; for (let i = 0; i < this.streams.length; i++) if (this.streams[i].quality > this.streams[bi].quality + 0.08) bi = i;
    this.best = bi;
    this.confidence = Math.max(0, Math.min(1, (this.streams[bi].peak - 0.14) / 0.1));
  }

  private char(c: number): void {
    if (c === 13 || c === 10) this.onText('\n');
    else if (c >= 32 && c < 127) this.onText(String.fromCharCode(c), `${this.name} ${this.center} Hz`);
  }
}

// ---- test signal ------------------------------------------------------------------------------------------------------
/** Text → tones as fldigi sends them: varicode bits (idle zeros either side) through the code and the interleaver. */
export function mfskTones(text: string, idleBits = 200): number[] {
  const bits: number[] = new Array(idleBits).fill(0);
  for (const ch of text) for (const c of MFSK_VARICODE[ch.charCodeAt(0)]) bits.push(c === '1' ? 1 : 0);
  bits.push(1, ...new Array(idleBits).fill(0));   // a 1 after the last character's 00 frames it
  const enc = new ConvViterbi(7, 0x6d, 0x4f), inlv = new Interleaver(BITS, DEPTH, true), tones: number[] = [];
  let reg = 0, sh: number[] = [];
  for (const bit of bits) {
    reg = ((reg << 1) | bit) & 127; const d = enc.outOf(reg);
    for (let i = 0; i < 2; i++) {
      sh.push((d >> i) & 1);
      if (sh.length === BITS) { inlv.symbols(sh); tones.push(gray(sh.reduce((a, b) => 2 * a + b, 0))); sh = []; }
    }
  }
  return tones;
}
/** Tones → audio at [rate], continuous phase, the lowest tone bandwidth/2 below [centreHz]. */
export function mfskAudio(tones: number[], baud: number, centreHz: number, rate: number, amp = 1): Float32Array {
  const symlen = Math.round(FS / baud), spacing = FS / symlen, f0 = centreHz - (NT - 1) * spacing / 2, ns = rate / spacing;
  const out = new Float32Array(Math.round(tones.length * ns)); let ph = 0;
  for (let k = 0; k < out.length; k++) { out[k] = amp * Math.cos(ph); ph += 2 * Math.PI * (f0 + tones[Math.min(tones.length - 1, Math.floor(k / ns))] * spacing) / rate; }
  return out;
}
