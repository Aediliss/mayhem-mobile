/**
 * FORK: DominoEX and Thor on the HAM receiver's USB audio, receive only. After fldigi (GPL-3.0-or-later):
 * src/dominoex/dominoex.cxx, dominovar.cxx, src/thor/thor.cxx, thorvaricode.cxx (and MFSK's varicode and interleaver):
 *  - 18 tones, (tone + ½) × spacing above (centre − bandwidth / 2), bandwidth = 18 × spacing; spacing = rate × [doubled]
 *    / symlen (the speeds: 4, 8, 16 at 8 kHz; 5, 11, 22 at 11025 Hz);
 *  - IFK+: each 4-bit symbol moves the tone up by symbol + 2 (mod 18), so the receiver needs only the difference between
 *    two tones and no exact tuning;
 *  - DominoEX: each character is 1-3 nibbles of its varicode (the first with its top bit clear) sent as symbols;
 *  - Thor: MFSK's varicode through the K=7 code (0x6d, 0x4f) and the 4×4×10 interleaver, 4 bits a symbol.
 * Receiver (written here): audio at 8 kHz; a one-symbol DFT on [P] bins per tone step, every quarter symbol; four symbol
 * phases decoded side by side (the tone step between symbols, a nibble; Thor: the reverse interleaver, Viterbi, varicode),
 * the text from the phase whose tones stand out most; squelched until they stand out above noise. Thor's secondary
 * characters (the idle station text) and DominoEX's are not shown.
 */
import { ftxShared } from './ft8.js';
import { MFSK_VARICODE } from './mfsk-varicode.js';
import { DOMINO_VARICODE } from './domino-varicode.js';
import { ConvViterbi, Interleaver } from './mfsk.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000, NT = 18, P = 3;
/** Speeds: [sample rate, samples a symbol, tone step in units of rate / symlen]. */
export const IFK_SPEEDS: Record<number, [number, number, number]> = {
  4: [8000, 2048, 2], 5: [11025, 2048, 2], 8: [8000, 1024, 2], 11: [11025, 1024, 1], 16: [8000, 512, 1], 22: [11025, 512, 1],
};
export type IfkKind = 'dominoex' | 'thor';
const MFSK_DEC = new Map<number, number>(MFSK_VARICODE.map((c, i) => [parseInt(c, 2), i]));
const DOMINO_DEC = new Map<number, number>(DOMINO_VARICODE.map((c, i) => [parseInt(c, 16), i]));

/** One symbol phase: its previous tone and the mode's decoding state. */
class Phase {
  prev = -1; peak = 0; private np = 0;
  // DominoEX
  private nib: number[] = [];
  // Thor
  private readonly inlv = new Interleaver(4, 10, false); private readonly vit = new ConvViterbi(7, 0x6d, 0x4f, 45);
  private half = 0; private pending = 0; private shreg = 1;
  constructor(private readonly kind: IfkKind, private readonly onChar: (c: number) => void) {}
  share(x: number): void { this.np++; this.peak += Math.max(0.03, 1 / this.np) * (x - this.peak); }
  /** The tone step to the next symbol, in tone steps (−16..17 valid), or NaN for a symbol to puncture. */
  step(raw: number): void {
    const ok = Number.isFinite(raw) && raw >= -16 && raw <= 17 && raw !== 0 && raw !== 1;
    let c = Math.round(raw) - 2; if (c < 0) c += NT;
    if (this.kind === 'dominoex') { if (ok && c < 16) this.domino(c); return; }
    const s = [0, 0, 0, 0];
    if (ok && c < 16) for (let k = 0; k < 4; k++) s[k] = (c >> (3 - k)) & 1 ? 127 : -127;
    const t = s.map(v => v + 128); this.inlv.symbols(t);
    for (const v of t) {
      if (!this.half) { this.pending = v - 128; this.half = 1; continue; }
      this.half = 0;
      const bit = this.vit.step(this.pending, v - 128); if (bit < 0) continue;
      this.shreg = ((this.shreg << 1) | bit) >>> 0;
      if ((this.shreg & 7) === 1) { const ch = this.shreg >>> 1 < 0xB80 ? MFSK_DEC.get(this.shreg >>> 1) : undefined; if (ch !== undefined) this.onChar(ch); this.shreg = 1; }
      if (this.shreg > 0xFFFFF) this.shreg = 1;
    }
  }
  private domino(c: number): void {
    if (!(c & 8)) {   // a new character starts: finish the last
      if (this.nib.length && this.nib.length <= 3) { const ch = DOMINO_DEC.get(this.nib.reduce((a, n) => a * 16 + n, 0)); if (ch !== undefined) this.onChar(ch); }
      this.nib = [];
    }
    this.nib.push(c); if (this.nib.length > 3) this.nib = [];
  }
}

export class IfkDecoder implements DigitalDecoder {
  name: string;
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  speed = 11;
  private rs = new ftxShared.SincResampler(48_000, FS, 32);
  private L = 0; private S = 0; private step = 0; private nb = 0; private f0 = 0;
  private buf = new Float32Array(1); private bn = 0; private tick = 0; private ph = 0;
  private cosT: Float32Array[] = []; private sinT: Float32Array[] = [];
  private phases: Phase[] = []; private best = 0;
  constructor(readonly kind: IfkKind, speed = 11, public center = 1500) { this.name = kind.toUpperCase(); this.speed = speed; this.setup(); }
  setCenter(hz: number): void { if (hz !== this.center) { this.center = hz; this.setup(); } }
  setSpeed(s: number): void { if (IFK_SPEEDS[s] && s !== this.speed) { this.speed = s; this.setup(); } }
  reset(): void { this.rs.reset(); this.setup(); }
  private setup(): void {
    const [sr, symlen, ds] = IFK_SPEEDS[this.speed] ?? IFK_SPEEDS[11];
    const unit = sr / symlen, spacing = unit * ds, bw = NT * spacing;
    this.S = symlen * FS / sr; this.L = Math.round(this.S); this.step = ds * P;
    // bins every unit / P from 6 tones below the lowest to 6 above the highest (tuning need not be exact)
    this.f0 = this.center - bw / 2 + spacing / 2 - 6 * spacing; this.nb = (NT + 12) * this.step;
    this.cosT = []; this.sinT = [];
    for (let b = 0; b < this.nb; b++) {
      const w = 2 * Math.PI * (this.f0 + b * unit / P) / FS, c = new Float32Array(this.L), s = new Float32Array(this.L);
      for (let j = 0; j < this.L; j++) { c[j] = Math.cos(w * j); s[j] = Math.sin(w * j); }
      this.cosT.push(c); this.sinT.push(s);
    }
    this.buf = new Float32Array(this.L); this.bn = 0; this.tick = 0; this.ph = 0;
    this.phases = Array.from({ length: 4 }, (_, i) => new Phase(this.kind, c => { if (i === this.best && this.open()) this.char(c); }));
    this.best = 0; this.confidence = 0;
  }
  /** Squelch: the tone stands out (noise alone ≈ 0.07 of the band; a signal at −8 dB in 2500 Hz well above). */
  private open(): boolean { return this.phases[this.best].peak > 0.11; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => {
      this.buf[this.bn] = v; this.bn = (this.bn + 1) % this.L;
      if (++this.tick >= this.S / 4) { this.tick -= this.S / 4; this.slice(); }
    });
  }

  private slice(): void {
    const L = this.L, x = new Float32Array(L);
    for (let j = 0; j < L; j++) x[j] = this.buf[(this.bn + j) % L];
    let mx = 0, at = 0, sum = 0;
    for (let b = 0; b < this.nb; b++) {
      const c = this.cosT[b], s = this.sinT[b]; let re = 0, im = 0;
      for (let j = 0; j < L; j++) { re += x[j] * c[j]; im += x[j] * s[j]; }
      const m = re * re + im * im; sum += m; if (m > mx) { mx = m; at = b; }
    }
    const p = this.phases[this.ph]; this.ph = (this.ph + 1) % 4;
    p.share(mx / (sum || 1));
    if (p.prev >= 0) p.step((at - p.prev) / this.step);
    p.prev = at;
    // the phase on the symbols (its tones concentrated in one bin) leads; another only when clearly better
    let bi = this.best; for (let i = 0; i < 4; i++) if (this.phases[i].peak > this.phases[bi].peak * 1.15) bi = i;
    this.best = bi;
    this.confidence = Math.max(0, Math.min(1, (this.phases[bi].peak - 0.08) / 0.1));
  }

  private char(c: number): void {
    if (c === 13 || c === 10) this.onText('\n');
    else if (c >= 32 && c < 127) this.onText(String.fromCharCode(c), `${this.name} ${this.speed} ${this.center} Hz`);
  }
}

// ---- test signal ------------------------------------------------------------------------------------------------------
/** Text → symbols (0..15) as fldigi sends them, idle (NUL) characters before and after. */
export function ifkSymbols(kind: IfkKind, text: string, idle = 12): number[] {
  const chars = [...new Array(idle).fill(0), 13, ...[...text].map(c => c.charCodeAt(0)), 13, ...new Array(idle).fill(0)];
  if (kind === 'dominoex') return chars.flatMap(c => [...DOMINO_VARICODE[c]].map(h => parseInt(h, 16)));
  const enc = new ConvViterbi(7, 0x6d, 0x4f), inlv = new Interleaver(4, 10, true), out: number[] = [];
  let reg = 0, sh: number[] = [];
  for (const c of chars) for (const b of MFSK_VARICODE[c]) {
    reg = ((reg << 1) | (b === '1' ? 1 : 0)) & 127; const d = enc.outOf(reg);
    for (let i = 0; i < 2; i++) { sh.push((d >> i) & 1); if (sh.length === 4) { inlv.symbols(sh); out.push(sh.reduce((a, v) => 2 * a + v, 0)); sh = []; } }
  }
  return out;
}
/** Symbols → audio at [rate] (IFK+: each symbol moves the tone up by symbol + 2, mod 18). */
export function ifkAudio(symbols: number[], speed: number, centreHz: number, rate: number, amp = 1): Float32Array {
  const [sr, symlen, ds] = IFK_SPEEDS[speed], spacing = sr * ds / symlen, ns = symlen * rate / sr, bw = NT * spacing;
  const tones: number[] = []; let t = 0; for (const s of symbols) { t = (t + 2 + s) % NT; tones.push(t); }
  const out = new Float32Array(Math.round(tones.length * ns)); let ph = 0;
  for (let k = 0; k < out.length; k++) { out[k] = amp * Math.cos(ph); ph += 2 * Math.PI * ((tones[Math.min(tones.length - 1, Math.floor(k / ns))] + 0.5) * spacing + centreHz - bw / 2) / rate; }
  return out;
}
