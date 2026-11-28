/**
 * FORK: JT9 (JT9-1, the HF submode) on the HAM receiver's USB audio, receive only. After WSJT-X (GPL-3.0): lib/gen9.f90,
 * jt9sync.f90, entail.f90, encode232.f90 / conv232.f90 (the K=32 r=1/2 code, the same polynomials as WSPR's),
 * interleave9.f90, symspec2.f90 (the bits' soft values) and jt9fano.f90:
 *  - 60 s slots, the transmission 1 s in; 85 symbols of 6912/12000 s (0.576 s), 9-FSK at 1.736 Hz: tone 0 is sync (16 of
 *    the symbols), tones 1-8 carry three bits each (69 data symbols, Gray-coded);
 *  - packjt's 72-bit messages (as JT65) + a 31-bit zero tail → 206 code bits (+1 pad) → bit-reversal interleaving.
 * Receiver: audio at 7111 Hz (a symbol is 4096 samples); half-symbol spectra with half-tone bins; the sync tone found
 * against the 16 sync symbols over 200-2700 Hz and DT −2.5..+5 s; refined; each data symbol's 8 tone powers give its 3
 * bits' soft values (max over the tones with the bit set minus max over the others, as symspec2); the code is decoded
 * by the sequential stack decoder written for WSPR; the message unpacked by the JT65 code.
 */
import { fft } from '../../fft.js';
import { ftxShared } from './ft8.js';
import { wsprStackDecode } from './wspr.js';
import { jt65Pack, jt65Unpack } from './jt65.js';
import type { DigitalDecoder } from './digital.js';

export const JT9_SYNC = Uint8Array.from([
  1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 1, 0, 1]);
const DATA_AT = (() => { const a: number[] = []; JT9_SYNC.forEach((v, i) => { if (!v) a.push(i); }); return a; })();
export const JT9_SYMBOL_S = 6912 / 12000, JT9_TONE_HZ = 12000 / 6912;
const gray = (n: number) => n ^ (n >> 1);
// interleave9: J0[i] = the bit reversal of the i-th 8-bit number whose reversal is ≤ 205
const J0 = (() => { const j: number[] = []; for (let i = 0; i < 256; i++) { let n = 0; for (let b = 0; b < 8; b++) n = 2 * n + ((i >> b) & 1); if (n <= 205) j.push(n); } return j; })();

/** 12 six-bit message words → the 13 bytes (72 bits, then zeros), as entail. */
function entail(dgen: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(13); let bit = 0;
  for (let i = 0; i < 12; i++) for (let j = 5; j >= 0; j--) { if ((dgen[i] >> j) & 1) out[bit >> 3] |= 0x80 >> (bit & 7); bit++; }
  return out;
}
/** A message → the 85 tones (0 = sync, 1-8 data), as gen9. */
export function jt9Tones(msg: string): Uint8Array {
  const coded = encode206(entail(jt65Pack(msg))), scr = new Uint8Array(207);
  for (let i = 0; i < 206; i++) scr[J0[i]] = coded[i];
  const t = new Uint8Array(85); let k = 0;
  for (let i = 0; i < 85; i++) { if (JT9_SYNC[i]) { t[i] = 0; continue; } const d = (scr[3 * k] << 2) | (scr[3 * k + 1] << 1) | scr[3 * k + 2]; t[i] = gray(d) + 1; k++; }
  return t;
}
/** The K=32 code over 103 bits (72 + the 31-bit tail): 206 bits, POLY1's first for each input bit. */
function encode206(dat: Uint8Array): Uint8Array {
  const P1 = 0xF2D05351, P2 = 0xE4613C47, par = (x: number) => { x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };
  const out = new Uint8Array(206); let st = 0, o = 0;
  for (let i = 0; i < 103; i++) { st = ((st << 1) | ((dat[i >> 3] >> (7 - (i & 7))) & 1)) >>> 0; out[o++] = par(st & P1); out[o++] = par(st & P2); }
  return out;
}
/** Tones → real audio at [rate] (tests): [baseHz] is the sync tone's frequency. */
export function jt9Audio(tones: ArrayLike<number>, baseHz: number, rate: number, amp = 1): Float32Array {
  const out = new Float32Array(Math.round(tones.length * JT9_SYMBOL_S * rate)); let ph = 0;
  for (let k = 0; k < out.length; k++) { const s = Math.min(tones.length - 1, Math.floor(k / (JT9_SYMBOL_S * rate))); out[k] = amp * Math.sin(ph); ph += 2 * Math.PI * (baseHz + tones[s] * JT9_TONE_HZ) / rate; }
  return out;
}

const FS = 4096 / JT9_SYMBOL_S, SYM = 4096, NF = 8192, HALF = SYM / 2;   // 7111.1 Hz; bins of half a tone
export interface Jt9Decode { utc: string; snr: number; dt: number; hz: number; text: string }
const pad2 = (n: number) => String(n).padStart(2, '0');
function tonePow(x: Float32Array, t0: number, f: number): number {
  let re = 0, im = 0; const w = 2 * Math.PI * f / FS, cw = Math.cos(w), sw = Math.sin(w); let c = 1, s = 0;
  for (let j = 0; j < SYM; j++) { const v = x[t0 + j] ?? 0; re += v * c; im -= v * s; const c2 = c * cw - s * sw; s = c * sw + s * cw; c = c2; }
  return re * re + im * im;
}

export class Jt9Decoder implements DigitalDecoder {
  readonly name = 'JT9';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Jt9Decode[], slot: number) => void = () => {};
  budgetMs = 4000;
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private readonly ring = new Float32Array(Math.ceil(FS * 70)); private wpos = 0; private total = 0; private t0 = 0; private lastSlot = -1;

  reset(): void { this.wpos = 0; this.total = 0; this.t0 = 0; this.lastSlot = -1; this.rs.reset(); this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.ring[this.wpos] = v; this.wpos = (this.wpos + 1) % this.ring.length; this.total++; });
    const now = Date.now(), est = now - this.total / FS * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.02 * (est - this.t0);
    const slot = Math.floor(now / 60_000), into = now - slot * 60_000;
    if (slot === this.lastSlot || into < 53_000) return;
    this.lastSlot = slot;
    const n0 = Math.round(53 * FS), first = Math.round((slot * 60_000 - this.t0) / 1000 * FS), buf = new Float32Array(n0), L = this.ring.length;
    let have = 0;
    for (let k = 0; k < n0; k++) { const s = first + k; if (s >= 0 && s < this.total && this.total - s <= L) { buf[k] = this.ring[s % L]; have++; } }
    if (have < n0 / 2) return;
    const list = this.decodeBuffer(buf, slot * 60_000);
    if (list.length) this.onDecodes(list, slot);
  }

  /** 53 s of 7111 Hz audio from the start of the minute. */
  decodeBuffer(x: Float32Array, slotMs = 0): Jt9Decode[] {
    const started = Date.now(), nfr = Math.floor((x.length - SYM) / HALF) + 1, BIN = FS / NF;   // 0.868 Hz
    const lo = Math.round(200 / BIN), hi = Math.round(2700 / BIN), W = hi - lo + 1;
    const P: Float32Array[] = [], re = new Float32Array(NF), im = new Float32Array(NF), win = Float32Array.from({ length: SYM }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / SYM));
    for (let k = 0; k < nfr; k++) {
      re.fill(0); im.fill(0); for (let j = 0; j < SYM; j++) re[j] = x[k * HALF + j] * win[j];
      fft(re, im);
      const row = new Float32Array(W); for (let b = 0; b < W; b++) { const j = lo + b; row[b] = re[j] * re[j] + im[j] * im[j]; }
      P.push(row);
    }
    // each bin against its median over time (the waterfall flattened); bins far below the band's typical level (outside
    // the receiver's audio filter, or empty) are left out rather than blown up
    const meds = Float32Array.from({ length: W }, (_, b) => Float32Array.from(P, r => r[b]).sort()[P.length >> 1]);
    const typical = Float32Array.from(meds).sort()[W >> 1] || 1e-20;
    for (let b = 0; b < W; b++) { const m = meds[b]; for (const r of P) r[b] = m > 1e-3 * typical ? r[b] / m : 0; }
    // sync: the sync tone on in the 16 sync symbols, off (data tones are above it) in the 69 others
    const lag0 = Math.round((1 - 2.5) * FS / HALF), lag1 = Math.round((1 + 5) * FS / HALF);
    const best = new Float32Array(W), bestLag = new Int32Array(W);
    for (let b = 0; b < W; b++) {
      let bv = -1e9, bl = 0;
      for (let lag = lag0; lag <= lag1; lag++) {
        let s1 = 0, s0 = 0, n1 = 0, n0 = 0;
        for (let i = 0; i < 85; i++) { const fr = lag + 2 * i; if (fr < 0 || fr >= nfr) continue; const v = P[fr][b]; if (JT9_SYNC[i]) { s1 += v; n1++; } else { s0 += v; n0++; } }
        if (n1 < 8 || !n0) continue;
        const v = s1 / n1 - s0 / n0; if (v > bv) { bv = v; bl = lag; }
      }
      best[b] = bv; bestLag[b] = bl;
    }
    const sorted = Float32Array.from(best).sort(), med = sorted[W >> 1], mad = (sorted[Math.floor(W * 0.84)] - med) || 1e-6;
    const cands: { b: number; lag: number; v: number }[] = [];
    for (let b = 2; b < W - 2; b++) {
      const v = best[b]; if (v < med + 4 * mad || v < 0.4) continue;
      if (v < best[b - 1] || v < best[b + 1] || v < best[b - 2] || v < best[b + 2]) continue;
      cands.push({ b, lag: bestLag[b], v });
    }
    cands.sort((a, c) => c.v - a.v); cands.length = Math.min(cands.length, 40);
    const out: Jt9Decode[] = [], d = new Date(slotMs), utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
    for (const c of cands) {
      if (Date.now() - started > this.budgetMs) break;
      let f = (lo + c.b) * BIN, t = c.lag * HALF;
      if (out.some(o => f > o.hz - 2 * JT9_TONE_HZ && f < o.hz + 10 * JT9_TONE_HZ)) continue;
      const syncPow = (ff: number, tt: number) => { let s = 0; for (let i = 0; i < 85; i++) if (JT9_SYNC[i]) s += tonePow(x, tt + i * SYM, ff); return s; };
      let bp = syncPow(f, t);
      for (const [df, dt] of [[0.3, 0], [-0.3, 0], [0, 512], [0, -512], [0, 256], [0, -256], [0.15, 0], [-0.15, 0], [0, 128], [0, -128]]) {
        const v = syncPow(f + df * JT9_TONE_HZ, t + dt); if (v > bp) { bp = v; f += df * JT9_TONE_HZ; t += dt; }
      }
      // the sync tone on in the sync symbols and off in the data ones
      let on = 0, off = 0; for (let i = 0; i < 85; i++) { const p = tonePow(x, t + i * SYM, f); if (JT9_SYNC[i]) on += p / 16; else off += p / 69; }
      if (on / Math.max(1e-30, off) < 2) continue;
      // data symbols: 8 tone powers (index = Gray-coded value), three bits each as symspec2
      const ss = DATA_AT.map(at => Float32Array.from({ length: 8 }, (_, g) => tonePow(x, t + at * SYM, f + (g + 1) * JT9_TONE_HZ)));
      const mx = (row: Float32Array, set: number[]) => Math.max(...set.map(i => row[i]));
      const soft = new Float32Array(207);
      ss.forEach((row, j) => {
        soft[3 * j] = mx(row, [4, 5, 6, 7]) - mx(row, [0, 1, 2, 3]);
        soft[3 * j + 1] = mx(row, [2, 3, 4, 5]) - mx(row, [0, 1, 6, 7]);
        soft[3 * j + 2] = mx(row, [1, 2, 4, 7]) - mx(row, [0, 3, 5, 6]);
      });
      let m2 = 0; for (let i = 0; i < 207; i++) m2 += soft[i] * soft[i];
      const sc = 50 / Math.sqrt(m2 / 207 || 1e-30), sym = new Uint8Array(206);
      for (let i = 0; i < 206; i++) sym[i] = Math.max(0, Math.min(255, Math.round(128 + sc * soft[J0[i]])));   // de-interleaved
      const dat = wsprStackDecode(sym, 200_000, 103, 72); if (!dat) continue;
      const words = Array.from({ length: 12 }, (_, i) => { let v = 0; for (let b = 0; b < 6; b++) { const k = 6 * i + b; v = 2 * v + ((dat[k >> 3] >> (7 - (k & 7))) & 1); } return v; });
      const text = jt65Unpack(words); if (!text || text.includes('000AAA')) continue;
      if (out.some(o => o.text === text)) continue;   // a strong signal's weaker copies elsewhere in the passband: one line each
      // SNR in 2500 Hz from the decoded tones (as JT65): power above the noise in the symbol's own bandwidth
      const tones = jt9Tones(text); let ratio = 0, n = 0;
      DATA_AT.forEach((at, j) => { const row = ss[j], srt = Float32Array.from(row).sort(), pn = (srt[2] + srt[3]) / 2 / Math.LN2; ratio += Math.max(0, row[tones[at] - 1] - pn) / pn; n++; });
      const snr = Math.round(10 * Math.log10(Math.max(1e-3, ratio / n)) - 10 * Math.log10(2500 * JT9_SYMBOL_S));
      const r: Jt9Decode = { utc, snr, dt: Math.round((t / FS - 1) * 10) / 10, hz: Math.round(f), text };
      out.push(r); this.onText(text, `JT9 ${r.hz} Hz`);
    }
    this.confidence = out.length ? 1 : this.confidence * 0.8;
    return out;
  }
}
