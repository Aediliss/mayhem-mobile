/**
 * FORK: Olivia and Contestia on the HAM receiver's USB audio, receive only. After fldigi's src/include/jalocha/pj_mfsk.h
 * (Pawel Jalocha's MFSK encoder and soft decoder; no header of its own, fldigi's COPYING: GPL-3.0), pj_fht.h, pj_gray.h
 * and src/olivia/olivia.cxx (the tones' placement):
 *  - N tones (2^b), B Hz wide; tone spacing = baud = B / N; tone k at centre − B(1 − 1/(2N))/2 + k·B/N; symbols Gray-coded;
 *  - each block carries b characters (7 bits for Olivia, 6 for Contestia's reduced set) over 64 (Contestia 32) symbols:
 *    a character is a ±1 Walsh-Hadamard row (Jalocha's inverse transform of a ±delta), scrambled by a fixed code
 *    (Olivia 0xE257E6D0291574EC, Contestia 0xEDB88320) shifted 13 (Contestia 5) places a character, its chips spread
 *    over the block's symbols with the bit position rotating by one each symbol.
 * Receiver: audio at 8 kHz; spectra one symbol long (zero-padded to half-tone bins) every quarter symbol; four symbol
 * phases × a spread of frequency offsets kept as hypotheses, each with its symbols' soft bits (energy-weighted, as
 * pj_mfsk's SoftDecode); for each, the block ending now is decoded (de-scramble, forward Hadamard transform, the peak is
 * the character) and scored by how far the peaks stand above the rest; the best hypothesis's blocks are printed once
 * each, at its own block alignment.
 */
import { fft } from '../../fft.js';
import { ftxShared } from './ft8.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000;
const CODE_OLIVIA = 0xE257E6D0291574ECn, CODE_CONTESTIA = 0xEDB88320n;

/** Jalocha's forward transform: (a, b) → (a + b, b − a). */
function fht(d: Float32Array | Int8Array): void {
  for (let step = 1; step < d.length; step *= 2) for (let p = 0; p < d.length; p += 2 * step) for (let q = p; q - p < step; q++) { const a = d[q], b = d[q + step]; d[q] = b + a; d[q + step] = b - a; }
}
/** Jalocha's inverse: (a, b) → (a − b, a + b). */
function ifht(d: Int8Array): void {
  for (let step = d.length / 2; step; step >>= 1) for (let p = 0; p < d.length; p += 2 * step) for (let q = p; q - p < step; q++) { const a = d[q], b = d[q + step]; d[q] = a - b; d[q + step] = a + b; }
}
const grayCode = (x: number) => x ^ (x >> 1);
const binaryCode = (g: number) => { g ^= g >> 4; g ^= g >> 2; g ^= g >> 1; return g; };

export interface OliviaConfig { tones: number; bandwidth: number; contestia: boolean }
interface Geo { bps: number; bpc: number; spb: number; code: bigint; shift: number; sep: number; spacing: number; first: number }
function geo(c: OliviaConfig, centre: number): Geo {
  const bps = Math.round(Math.log2(c.tones)), bpc = c.contestia ? 6 : 7, spacing = c.bandwidth / c.tones;
  return { bps, bpc, spb: 1 << (bpc - 1), code: c.contestia ? CODE_CONTESTIA : CODE_OLIVIA, shift: c.contestia ? 5 : 13, sep: Math.round(FS / spacing), spacing, first: centre - c.bandwidth * (1 - 0.5 / c.tones) / 2 };
}
const codeBit = (code: bigint, i: number) => Number((code >> BigInt(i)) & 1n);

/** Contestia's character set (pj_mfsk's mapping both ways). */
function contestiaIn(ch: number): number {
  if (ch >= 97 && ch <= 122) ch -= 32;
  if (ch === 32) return 59; if (ch === 13) return 60; if (ch === 10) return 0; if (ch === 8) return 61; if (ch === 0) return 0;
  if (ch >= 33 && ch <= 90) return ch - 32;
  return 63 - 32;
}
function contestiaOut(c: number): number { return c === 0 ? 0 : c === 59 ? 32 : c === 60 ? 13 : c === 61 ? 8 : c + 32; }

/** b characters → one block of symbols (tone numbers, Gray-coded), as MFSK_Encoder.EncodeBlock. */
export function oliviaBlock(chars: number[], c: OliviaConfig): number[] {
  const g = geo(c, 0), out = new Array<number>(g.spb).fill(0), buf = new Int8Array(g.spb);
  for (let fb = 0; fb < g.bps; fb++) {
    let ch = chars[fb] ?? 0; ch = c.contestia ? contestiaIn(ch) : ch & ((g.spb << 1) - 1);
    buf.fill(0); if (ch < g.spb) buf[ch] = 1; else buf[ch - g.spb] = -1;
    ifht(buf);
    let cb = (fb * g.shift) & (g.spb - 1);
    for (let t = 0; t < g.spb; t++) { if (codeBit(g.code, cb)) buf[t] = -buf[t]; cb = (cb + 1) & (g.spb - 1); }
    let rot = 0;
    for (let t = 0; t < g.spb; t++) { if (buf[t] < 0) { let bit = fb + rot; if (bit >= g.bps) bit -= g.bps; out[t] |= 1 << bit; } if (++rot >= g.bps) rot -= g.bps; }
  }
  return out.map(grayCode);
}
/** Text → tone numbers, blocks of b characters (nulls before and after, as an idle transmitter). */
export function oliviaTones(text: string, c: OliviaConfig, idleBlocks = 2): number[] {
  const bps = Math.round(Math.log2(c.tones)), chars = [...new Array(idleBlocks * bps).fill(0), ...Array.from(text, ch => ch.charCodeAt(0))];
  while (chars.length % bps) chars.push(0);
  for (let i = 0; i < idleBlocks * bps; i++) chars.push(0);
  const t: number[] = []; for (let i = 0; i < chars.length; i += bps) t.push(...oliviaBlock(chars.slice(i, i + bps), c));
  return t;
}
/** Tones → audio at [rate] (tests), continuous phase, tone k at the mode's place around [centreHz]. */
export function oliviaAudio(tones: number[], c: OliviaConfig, centreHz: number, rate: number, amp = 1): Float32Array {
  const g = geo(c, centreHz), ns = rate / g.spacing, out = new Float32Array(Math.round(tones.length * ns)); let ph = 0;
  for (let k = 0; k < out.length; k++) { const s = Math.min(tones.length - 1, Math.floor(k / ns)); out[k] = amp * Math.sin(ph); ph += 2 * Math.PI * (g.first + tones[s] * g.spacing) / rate; }
  return out;
}

/** One hypothesis (a symbol phase and a frequency offset): its recent symbols' soft bits and block scores. */
interface Hyp { soft: Float32Array[]; n: number; score: Float32Array }

export class OliviaDecoder implements DigitalDecoder {
  readonly name: string;
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  private g!: Geo; private NF = 0; private offsets: number[] = [];
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private buf = new Float32Array(0); private bn = 0; private tick = 0;
  private hyps: Hyp[] = [];
  private re = new Float32Array(0); private im = new Float32Array(0);
  constructor(public config: OliviaConfig, public center = 1500) { this.name = config.contestia ? 'CONTESTIA' : 'OLIVIA'; this.setup(); }
  setCenter(hz: number): void { this.center = hz; this.setup(); }
  setConfig(c: OliviaConfig): void { this.config = c; this.setup(); }
  private setup(): void {
    this.g = geo(this.config, this.center);
    this.NF = 1; while (this.NF < 2 * this.g.sep) this.NF *= 2;
    this.re = new Float32Array(this.NF); this.im = new Float32Array(this.NF);
    this.buf = new Float32Array(this.g.sep); this.bn = 0; this.tick = 0;
    const span = Math.min(4, Math.max(1, Math.round(60 / this.g.spacing)));   // a few tones, at least ±60 Hz either way
    this.offsets = []; for (let o = -2 * span; o <= 2 * span; o++) this.offsets.push(o);   // in half tones
    this.hyps = Array.from({ length: 4 * this.offsets.length }, () => ({ soft: [], n: 0, score: new Float32Array(this.g.spb) }));
    this.confidence = 0;
  }
  reset(): void { this.setup(); this.rs.reset(); }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => {
      this.buf[this.bn] = v; this.bn = (this.bn + 1) % this.buf.length;
      if (++this.tick >= this.g.sep / 4) { this.tick -= this.g.sep / 4; this.slice(); }
    });
  }

  private phase = 0;
  /** A quarter symbol has gone by: the spectrum of the last symbol's worth of audio, as a symbol of this phase. */
  private slice(): void {
    const g = this.g, re = this.re, im = this.im, L = this.buf.length; re.fill(0); im.fill(0);
    for (let j = 0; j < L; j++) re[j] = this.buf[(this.bn + j) % L];
    fft(re, im);
    const half = this.NF / (2 * g.sep);   // FFT bins a half tone (1 when NF = 2·sep)
    const ph = this.phase; this.phase = (this.phase + 1) % 4; this.slices++;
    const tones = 1 << g.bps, firstBin = g.first / FS * this.NF;
    this.offsets.forEach((o, oi) => {
      const h = this.hyps[ph * this.offsets.length + oi];
      // soft bits as pj_mfsk's SoftDecode: each tone's energy² towards its (Gray-decoded) bits, over the total
      const soft = new Float32Array(g.bps); let tot = 0;
      for (let t = 0; t < tones; t++) {
        const bin = Math.round(firstBin + (2 * t + o) * half); if (bin < 1 || bin >= this.NF / 2) continue;
        let e = re[bin] * re[bin] + im[bin] * im[bin]; e *= e; tot += e;
        const idx = binaryCode(t);
        for (let b = 0; b < g.bps; b++) soft[b] += (idx >> b) & 1 ? -e : e;
      }
      if (tot > 0) for (let b = 0; b < g.bps; b++) soft[b] /= tot;
      h.soft.push(soft); if (h.soft.length > g.spb) h.soft.shift();
      h.n++;
      if (h.soft.length === g.spb) this.block(h, ph * this.offsets.length + oi);
    });
  }

  private lastEmit = -1e9; private emitted = 0; private slices = 0;
  /** The block ending with this hypothesis's newest symbol: decode its characters, score it, print it if it is the best. */
  private block(h: Hyp, hi: number): void {
    const g = this.g, spb = g.spb, fh = new Float32Array(spb), chars: number[] = [];
    let score = 0;
    for (let fb = 0; fb < g.bps; fb++) {
      let rot = fb, cb = (fb * g.shift) & (spb - 1);
      for (let t = 0; t < spb; t++) { let bit = h.soft[t][rot]; if (codeBit(g.code, cb)) bit = -bit; fh[t] = bit; cb = (cb + 1) & (spb - 1); if (++rot >= g.bps) rot -= g.bps; }
      fht(fh);
      let peak = 0, pos = 0, sq = 0; for (let t = 0; t < spb; t++) { sq += fh[t] * fh[t]; if (Math.abs(fh[t]) > Math.abs(peak)) { peak = fh[t]; pos = t; } }
      const noise = Math.sqrt(Math.max(1e-30, (sq - peak * peak) / (spb - 1)));
      score += Math.abs(peak) / noise / g.bps;
      chars.push(pos + (peak < 0 ? spb : 0));
    }
    const align = h.n % spb;
    h.score[align] = 0.5 * h.score[align] + 0.5 * score;
    // print a block when its hypothesis and alignment score near the best overall and the block itself is clean; one
    // print per block period (neighbouring phases and offsets of the same signal complete the same block together)
    let best = 0; for (const x of this.hyps) for (const v of x.score) if (v > best) best = v;
    this.confidence = Math.max(0, Math.min(1, (best - 3) / 4));
    if (h.score[align] < 0.9 * best || score < 4.2) return;
    if (this.slices - this.lastEmit < 2 * spb) return;   // within half a block (in quarter symbols) of the last print
    this.lastEmit = this.slices;
    void hi;
    let text = '';
    for (const c of chars) { const ch = this.config.contestia ? contestiaOut(c) : c; if (ch === 13 || ch === 10) text += '\n'; else if (ch >= 32 && ch < 127) text += String.fromCharCode(ch); }
    if (text) { this.emitted++; this.onText(text, `${this.name} ${this.config.tones}/${this.config.bandwidth}`); }
  }
}
