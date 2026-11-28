/**
 * FORK: Feld Hell on the HAM receiver's USB audio, receive only. Written from the mode's definition (as fldigi and the
 * Feld Hell Club describe it): on-off keying of one tone, 2.5 characters a second, each character 7 columns of 14 half-
 * pixels (7 pixels drawn twice as tall), so 17.5 columns and 245 pixels a second. Hell is a facsimile of text: the
 * receiver needs no font, it draws what it hears. The tone's envelope (mixer at the centre frequency, low-pass) is
 * sampled 245 times a second against a slowly decaying peak; every 14 samples make a column, and the strip shows two
 * copies of the column stacked, the Hell display, so the text reads whatever the column phase is (a small timing error
 * only slants it).
 */
import type { DigitalDecoder } from './digital.js';
import type { SstvRows } from './sstv.js';

const RATE = 48_000;
export const HELL_PIXELS_PER_S = 245, HELL_ROWS = 14;
const SPP = RATE / HELL_PIXELS_PER_S;   // 195.9 samples a pixel

export class HellDecoder implements DigitalDecoder {
  readonly name = 'HELL';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onImage: (img: SstvRows) => void = () => {};
  /** Columns the strip holds (17 s at 17.5 a second: big enough to read on a phone). */
  width = 300;
  private cr = 1; private ci = 0; private dr = 1; private di = 0; private a = 0;
  private i1 = 0; private i2 = 0; private q1 = 0; private q2 = 0;
  private acc = 0; private sum = 0; private cnt = 0; private peak = 1e-9; private floor = 0; private tick = 0;
  private col: number[] = [];
  private cols: Float32Array[] = [];
  private sinceEmit = 0;
  constructor(public center = 1000) { this.setup(); }
  setCenter(hz: number): void { this.center = hz; this.setup(); }
  private setup(): void {
    const w = -2 * Math.PI * this.center / RATE; this.dr = Math.cos(w); this.di = Math.sin(w);
    this.a = 1 - Math.exp(-2 * Math.PI * 180 / RATE);   // passes the keying (245 pixels a second), not the neighbours
    this.cols = []; this.col = []; this.peak = 1e-9; this.floor = 0; this.confidence = 0;
  }
  reset(): void { this.setup(); }

  push(x: Float32Array, n: number): void {
    for (let k = 0; k < n; k++) {
      const v = x[k], i = v * this.cr, q = v * this.ci;
      const nr = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = nr;
      if (++this.tick === 4096) { this.tick = 0; const g = 1.5 - (this.cr * this.cr + this.ci * this.ci) / 2; this.cr *= g; this.ci *= g; }
      this.i1 += this.a * (i - this.i1); this.i2 += this.a * (this.i1 - this.i2);
      this.q1 += this.a * (q - this.q1); this.q2 += this.a * (this.q1 - this.q2);
      this.sum += Math.hypot(this.i2, this.q2); this.cnt++;
      if (++this.acc >= SPP) { this.acc -= SPP; this.pixel(this.sum / this.cnt); this.sum = 0; this.cnt = 0; }
    }
  }

  private pixel(env: number): void {
    // black-to-white between a slow noise floor and a decaying peak
    this.peak = Math.max(env, this.peak * 0.9995); this.floor = this.floor === 0 ? env : this.floor + (env < this.floor ? 0.05 : 0.0005) * (env - this.floor);
    const v = Math.max(0, Math.min(1, (env - this.floor) / Math.max(1e-12, this.peak - this.floor)));
    this.col.push(v);
    if (this.col.length < HELL_ROWS) return;
    this.cols.push(Float32Array.from(this.col)); this.col = [];
    if (this.cols.length > this.width) this.cols.shift();
    const mean = this.cols.slice(-20).reduce((a, c) => a + c.reduce((x, y) => x + y, 0), 0) / (20 * HELL_ROWS);
    this.confidence = mean > 0.08 && mean < 0.6 ? Math.min(1, this.confidence + 0.05) : Math.max(0, this.confidence - 0.05);
    if (++this.sinceEmit >= 4) { this.sinceEmit = 0; this.emit(); }
  }

  /** The strip: [width] columns, each column's 14 pixels drawn twice (the Hell display), each pixel two rows tall (56 rows). */
  private emit(): void {
    const W = this.width, H = 4 * HELL_ROWS, rgba = new Uint8ClampedArray(W * H * 4), off = W - this.cols.length;
    for (let c = 0; c < this.cols.length; c++) for (let r = 0; r < H; r++) {
      const g = Math.round(255 * (1 - this.cols[c][(HELL_ROWS - 1) - ((r >> 1) % HELL_ROWS)])), o = 4 * (r * W + off + c);   // the bottom pixel is sent first
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255;
    }
    for (let c = 0; c < off; c++) for (let r = 0; r < H; r++) { const o = 4 * (r * W + c); rgba[o] = rgba[o + 1] = rgba[o + 2] = 255; rgba[o + 3] = 255; }
    this.onImage({ mode: 'Feld Hell', width: W, height: H, line: 0, count: H, rows: rgba });
  }

  /** The last [n] columns (tests). */
  columns(n: number): Float32Array[] { return this.cols.slice(-n); }
}

/** Test signal: columns of 14 on/off pixels (the first pixel at the bottom, sent first), keyed at [hz]. */
export function hellAudio(columns: ArrayLike<number>[], hz: number, rate: number, amp = 1): Float32Array {
  const spp = rate / HELL_PIXELS_PER_S, n = Math.round(columns.length * HELL_ROWS * spp), out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = Math.floor(k / spp), on = columns[Math.floor(p / HELL_ROWS)]?.[p % HELL_ROWS] ? 1 : 0;
    out[k] = on * amp * Math.sin(2 * Math.PI * hz * k / rate);
  }
  return out;
}
