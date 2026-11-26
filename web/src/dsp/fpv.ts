/**
 * FORK: analog FPV video at 5.8 GHz, receive only. An analog FPV transmitter frequency-modulates composite video (NTSC
 * or PAL) onto one channel of a fixed grid (bands A, B, E, F / IRC, R raceband, L lowband). Here, on a channel's complex
 * baseband (a HackRF at up to 20 MS/s takes in most of the ~18 MHz such a channel occupies):
 *
 *  · the FM discriminator gives the composite video;
 *  · video is told from anything else by its line rate: the discriminator correlates with itself one line later,
 *    15.734 kHz for NTSC (63.556 µs) or 15.625 kHz for PAL (64 µs), far more than at other lags;
 *  · the sync pulses (4.7 µs at the sync tip, the extreme the averaged line sits at for that long) give the polarity and
 *    the start of each line, the broad pulses of vertical sync the start of each field;
 *  · each field becomes a grayscale picture (black at the blanking level, white at the brightest), line by line.
 *
 * Channel frequencies are the published FPV band tables (facts). No DOM.
 */

import type { Emit, IqProcessor } from './core.js';

/** The FPV channel grid, MHz, by band. */
export const FPV_BANDS: Record<string, number[]> = {
  A: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  B: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  E: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  F: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  R: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
  L: [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621],
};
/** Every channel as "A1".."L8" with its frequency in Hz. */
export const FPV_CHANNELS: { name: string; hz: number }[] = Object.entries(FPV_BANDS).flatMap(([b, fs]) => fs.map((f, i) => ({ name: `${b}${i + 1}`, hz: f * 1e6 })));

export const STANDARDS = { NTSC: { line: 63.556e-6, lines: 525, field: 262.5 }, PAL: { line: 64e-6, lines: 625, field: 312.5 } } as const;
export type Standard = keyof typeof STANDARDS;

export interface FpvLook {
  /** Video found: its standard, how clearly (the line correlation, 0..1), and the sync polarity (+1: sync tip high). */
  standard: Standard | null; score: number; polarity: number;
  /** The discriminator's spread (Hz): an FM video carrier swings several MHz. */
  deviationHz: number;
}

/** FM discriminator over interleaved I/Q (Float32): instantaneous frequency in Hz. */
export function discriminate(x: Float32Array, fs: number): Float32Array {
  const n = x.length / 2, out = new Float32Array(n), k = fs / (2 * Math.PI);
  let pr = x[0], pi = x[1];
  for (let i = 1; i < n; i++) { const r = x[2 * i], q = x[2 * i + 1]; out[i] = Math.atan2(q * pr - r * pi, r * pr + q * pi) * k; pr = r; pi = q; }
  out[0] = out[1];
  // video is under about 5 MHz: a moving average over the samples that span 0.2 µs takes the noise above it out
  const w = Math.max(1, Math.round(0.2e-6 * fs));
  if (w > 1) { let acc = 0; const sm = new Float32Array(n); for (let i = 0; i < n; i++) { acc += out[i] - (i >= w ? out[i - w] : 0); sm[i] = acc / Math.min(i + 1, w); } return sm; }
  return out;
}

/** Correlation of v with itself `lag` samples later (fractional lag by interpolation), normalized: 1 for a perfect repeat. */
function lagCorr(v: Float32Array, lag: number, mean: number): number {
  const L = Math.floor(lag), f = lag - L, n = v.length - L - 1;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 2) { const a = v[i] - mean, b = v[i + L] * (1 - f) + v[i + L + 1] * f - mean; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy || 1);
}

/** Is it video, which standard, which way up. `v` is the discriminator output at fs (a few lines at least). */
export function lookForVideo(v: Float32Array, fs: number): FpvLook {
  let mean = 0; for (let i = 0; i < v.length; i++) mean += v[i]; mean /= v.length || 1;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < v.length; i += 3) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  // the two standards' lines differ by 0.7 %: over 16 lines that is 7 µs, which tells them apart (one line does not)
  const K = 16, nt = lagCorr(v, K * STANDARDS.NTSC.line * fs, mean), pal = lagCorr(v, K * STANDARDS.PAL.line * fs, mean);
  // a line-rate repeat must stand out from lags that are no whole number of lines
  const ref = Math.max(lagCorr(v, (K + 0.5) * STANDARDS.PAL.line * fs, mean), lagCorr(v, (K + 0.37) * STANDARDS.NTSC.line * fs, mean), 0);
  const best = Math.max(nt, pal), cand: Standard = nt >= pal ? 'NTSC' : 'PAL';
  // and video repeats line to line, which a tone whose period happens to fit 16 lines does not
  const one = lagCorr(v, STANDARDS[cand].line * fs, mean);
  const standard: Standard | null = best > 0.4 && best - ref > 0.2 && one > 0.4 ? cand : null;
  let polarity = 1;
  if (standard) {
    // the averaged line: the sync tip is the extreme it holds for about 4.7 µs
    const P = STANDARDS[standard].line * fs, L = Math.round(P), avg = new Float64Array(L), cnt = new Uint32Array(L);
    for (let i = 0; i < v.length; i++) { const k = Math.floor(i % P); if (k < L) { avg[k] += v[i]; cnt[k]++; } }
    for (let k = 0; k < L; k++) avg[k] /= cnt[k] || 1;
    const w = Math.max(2, Math.round(4.7e-6 * fs));
    let maxRun = -Infinity, minRun = Infinity, med = 0; const sorted = Float64Array.from(avg).sort(); med = sorted[sorted.length >> 1];
    for (let k = 0; k < L; k++) { let s = 0; for (let j = 0; j < w; j++) s += avg[(k + j) % L]; s /= w; if (s > maxRun) maxRun = s; if (s < minRun) minRun = s; }
    polarity = maxRun - med > med - minRun ? 1 : -1;
  }
  return { standard, score: Math.max(0, Math.round(best * 100) / 100), polarity, deviationHz: Math.round(hi - lo) };
}

/**
 * One field as a picture: the discriminator output (polarity applied so the sync tip is low), cut at each line sync
 * and sampled across the active part of the line (from 10.9 µs after the sync's leading edge, 52.6 µs wide). Returns
 * `width` × lines grayscale bytes and the number of lines.
 */
export function buildField(v: Float32Array, fs: number, look: FpvLook, width = 320): { pixels: Uint8ClampedArray; lines: number; width: number } | null {
  if (!look.standard) return null;
  const P = STANDARDS[look.standard].line * fs, sgn = -look.polarity, n = v.length;   // turned so the sync tip is low
  // levels: the sync tip (low after polarity) and the brightest, from the 1st and 99.5th percentiles
  const sample = new Float32Array(Math.min(n, 20000)); for (let i = 0; i < sample.length; i++) sample[i] = sgn * v[Math.floor(i * n / sample.length)];
  sample.sort();
  const tip = sample[Math.floor(sample.length * 0.01)], white = sample[Math.floor(sample.length * 0.995)], thr = tip + 0.25 * (white - tip);
  // sync leading edges: crossing below the threshold, held for 3 µs; a line apart (half a line in the vertical interval)
  const edges: number[] = [], hold = Math.round(3e-6 * fs);
  for (let i = 1; i + hold < n; i++) {
    if (sgn * v[i] < thr && sgn * v[i - 1] >= thr) {
      let ok = true; for (let j = 1; j < hold; j += Math.max(1, hold >> 3)) if (sgn * v[i + j] >= thr) { ok = false; break; }
      if (ok && (!edges.length || i - edges[edges.length - 1] > 0.8 * P)) edges.push(i);
    }
  }
  if (edges.length < 20) return null;
  const blank = tip + 0.3 * (white - tip);   // the blanking level sits about 0.3 of the way from the tip to peak white
  const lines = edges.length - 1, px = new Uint8ClampedArray(width * lines), a0 = 10.9e-6 * fs, aw = 52.6e-6 * fs;
  for (let l = 0; l < lines; l++) for (let x = 0; x < width; x++) {
    const t = edges[l] + a0 + (x + 0.5) * aw / width, i = Math.floor(t);
    if (i + 1 >= n) continue;
    const val = sgn * (v[i] + (v[i + 1] - v[i]) * (t - i));
    px[l * width + x] = Math.round(255 * (val - blank) / (white - blank || 1));
  }
  return { pixels: px, lines, width };
}

// ---------------------------------------------------------------------------------------------------- test transmitter

/**
 * Composite video of `seconds` with vertical bars (levels 0..1 across the line, `bars` of them) as FM IQ at fs:
 * sync tip at -1 (scaled), blanking 0, white 1; `dev` Hz per unit; frames from the standard's line count, with
 * a run of broad pulses each field for vertical sync. `invert` puts the sync tip at high frequency.
 */
export function compositeFm(std: Standard, fs: number, seconds: number, opts: { dev?: number; bars?: number; invert?: boolean; offsetHz?: number } = {}): Float32Array {
  const s = STANDARDS[std], P = s.line * fs, n = Math.round(seconds * fs), dev = opts.dev ?? 3e6, bars = opts.bars ?? 8;
  const out = new Float32Array(2 * n), fieldLines = Math.round(s.field);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const line = Math.floor(i / P), t = (i - line * P) / fs, inField = line % fieldLines;
    let level: number;
    if (inField < 3) level = t < 27e-6 ? -0.4 : 0;                  // broad pulses: vertical sync
    else if (t < 4.7e-6) level = -0.4;                               // line sync tip
    else if (t < 10.9e-6 || t > 10.9e-6 + 52.6e-6) level = 0;         // blanking
    else level = Math.floor((t - 10.9e-6) / 52.6e-6 * bars) / (bars - 1) * 0.7 + 0.0;   // bars from black to white
    const f = (opts.offsetHz ?? 0) + (opts.invert ? -1 : 1) * dev * level;
    ph += 2 * Math.PI * f / fs; if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    out[2 * i] = Math.cos(ph); out[2 * i + 1] = Math.sin(ph);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- worker processor

/**
 * The FPV app's processor: about every 250 ms, 20 ms of the channel are looked at (power, video or not, standard), and
 * when watching a channel its picture is sent too. After a retune ('fpvTune') the first 50 ms are dropped.
 */
export class FpvProcessor implements IqProcessor {
  private ch = ''; private watch = false; private skip = 0; private gap = 0; private buf = new Float32Array(0); private len = 0; private rate = 20e6;
  constructor(private readonly emit: Emit) {}
  tune(ch: string, watch: boolean): void { this.ch = ch; this.watch = watch; this.skip = Math.round(0.05 * this.rate); this.len = 0; this.gap = 0; }
  reset(rate: number): void { this.rate = rate; this.len = 0; this.gap = 0; this.skip = Math.round(0.05 * rate); }
  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const need = Math.round(0.02 * rate);
    if (this.buf.length !== 2 * need) this.buf = new Float32Array(2 * need);
    let i = 0; const n = iq.length >> 1;
    if (this.skip > 0) { const d = Math.min(this.skip, n); this.skip -= d; i = d; }
    for (; i < n; i++) {
      if (this.gap > 0) { this.gap--; continue; }
      this.buf[2 * this.len] = iq[2 * i] / 128; this.buf[2 * this.len + 1] = iq[2 * i + 1] / 128; this.len++;
      if (this.len === need) { this.look(rate); this.len = 0; this.gap = Math.round(0.23 * rate); }
    }
  }
  private look(fs: number): void {
    let p = 0; for (let i = 0; i < this.buf.length; i++) p += this.buf[i] * this.buf[i];
    const powerDb = Math.round(10 * Math.log10(p / (this.buf.length / 2) + 1e-12) * 10) / 10;
    const v = discriminate(this.buf, fs), look = lookForVideo(v, fs);
    this.emit({ type: 'fpvLook', ch: this.ch, powerDb, ...look });
    if (this.watch && look.standard) {
      const f = buildField(v, fs, look, 320);
      if (f) this.emit({ type: 'fpvField', ch: this.ch, width: f.width, lines: f.lines, pixels: f.pixels, standard: look.standard }, [f.pixels.buffer]);
    }
  }
}
