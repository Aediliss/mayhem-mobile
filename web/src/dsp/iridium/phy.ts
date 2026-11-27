/**
 * FORK: Iridium (1616–1626.5 MHz) bursts, receive only, after gr-iridium (GPL-3.0-or-later: fft_burst_tagger,
 * burst_downmix, iridium_qpsk_demod). Every burst in the sampled span is found by its power in a short-time spectrum,
 * cut out of a ring buffer, mixed to 0 Hz and brought to 10 samples a symbol (25 000 symbols a second). Then as in
 * gr-iridium: the frequency error from the squared preamble (a tone at twice the error), a root raised cosine (0.4),
 * the 16-symbol preamble and 12-symbol unique word found by correlation (downlink or uplink) for timing and phase, one
 * sample a symbol, a first-order PLL, quadrant decisions, the unique word checked (two symbols' worth of error
 * allowed), and the differential QPSK undone into bits (the unique word's 24 bits first, as iridium-toolkit expects).
 * No DOM.
 */
import { ChannelDecimator, ComplexFirDecimator, fftInPlace, lowpassTaps } from '../ham/filters.js';
import { rrcTaps } from '../hamid/symbols.js';

export const IRIDIUM_BAUD = 25_000;
const SPS = 10, FS2 = IRIDIUM_BAUD * SPS;
/** Above this, simplex (ring alert, messaging) channels: longer frames. */
export const IRIDIUM_SIMPLEX_HZ = 1_626_000_000;
const PRE = 16, UW_LEN = 12;
export const UW_DL = [0, 2, 2, 2, 2, 0, 0, 0, 2, 0, 0, 2];
export const UW_UL = [2, 2, 0, 0, 0, 2, 0, 0, 2, 0, 2, 2];
const MAX_SYM_NORMAL = 191, MAX_SYM_SIMPLEX = 444, MIN_SYM_NORMAL = 131, MIN_SYM_SIMPLEX = 80;

export interface IridiumBurst {
  /** Bits after the differential decoding, the unique word's 24 first (iridium-toolkit's RAW line). */
  bits: string; down: boolean;
  /** Where it was (Hz, absolute) and when (ms since the first sample pushed). */
  freqHz: number; ms: number;
  /** Symbols demodulated, the share of them within 22° of a constellation point, and the level (dB, relative). */
  symbols: number; confidence: number; levelDb: number;
}

const S0: [number, number] = [1, 1], S1: [number, number] = [-1, -1];
const symOf = (v: number) => v === 0 ? S0 : S1;
/** The 28 symbols the correlation looks for: 16 of preamble, then the unique word. */
const SYNC_DL = [...Array(PRE).fill(S0), ...UW_DL.map(symOf)];
const SYNC_UL = [...Array.from({ length: PRE }, (_, i) => i % 2 ? S0 : S1), ...UW_UL.map(symOf)];

/** One burst's samples at FS2, the carrier near 0 Hz: bits, or null. */
export function demodBurst(x: Float32Array, n: number, simplex: boolean): { bits: string; down: boolean; symbols: number; confidence: number; cfoHz: number; level: number } | null {
  // where it starts: the first sample above a quarter of the burst's peak magnitude (smoothed over a symbol)
  let peak = 0; const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(x[2 * i], x[2 * i + 1]);
  const sm = new Float32Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += mag[i] - (i >= SPS ? mag[i - SPS] : 0); sm[i] = acc / SPS; if (sm[i] > peak) peak = sm[i]; }
  let start = 0; while (start < n && sm[start] < peak / 4) start++;
  start = Math.max(0, start - SPS);
  const minSym = simplex ? MIN_SYM_SIMPLEX : MIN_SYM_NORMAL;
  if (n - start < (minSym + PRE) * SPS) return null;
  // the frequency error: the preamble and the first symbols of the unique word squared (BPSK gone) are a tone at 2·cfo
  const F = 256, OV = 16, re = new Float32Array(F * OV), im = new Float32Array(F * OV);
  for (let i = 0; i < F && start + i < n; i++) {
    const a = x[2 * (start + i)], b = x[2 * (start + i) + 1], w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (F - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (F - 1));
    re[i] = (a * a - b * b) * w; im[i] = 2 * a * b * w;
  }
  fftInPlace(re, im, false);
  const N = F * OV, pw = (k: number) => { const j = (k + N) % N; return re[j] * re[j] + im[j] * im[j]; };
  let kb = 0, kv = -1; for (let k = 0; k < N; k++) { const p = pw(k); if (p > kv) { kv = p; kb = k; } }
  const a0 = pw(kb - 1), c0 = pw(kb + 1), den = a0 - 2 * kv + c0, frac = den ? 0.5 * (a0 - c0) / den : 0;
  const kk = (kb > N / 2 ? kb - N : kb) + frac, cfo = kk / N * FS2 / 2;
  // turn it back, then the root raised cosine
  const h = rrcTaps(SPS, 0.4, 2.5), L = h.length, half = (L - 1) / 2, m = n - start, y = new Float32Array(2 * m), z = new Float32Array(2 * m);
  for (let i = 0; i < m; i++) { const ph = -2 * Math.PI * cfo * i / FS2, c = Math.cos(ph), s = Math.sin(ph), a = x[2 * (start + i)], b = x[2 * (start + i) + 1]; y[2 * i] = a * c - b * s; y[2 * i + 1] = a * s + b * c; }
  for (let i = 0; i < m; i++) { let sr = 0, si = 0; for (let k = 0; k < L; k++) { const j = i + k - half; if (j < 0 || j >= m) continue; sr += h[k] * y[2 * j]; si += h[k] * y[2 * j + 1]; } z[2 * i] = sr; z[2 * i + 1] = si; }
  // the sync word: correlation at symbol spacing, downlink and uplink, over the first (64+12+8) symbols
  const search = Math.min(m - (PRE + UW_LEN) * SPS, (64 + UW_LEN + 8) * SPS);
  if (search < 1) return null;
  let best = { v: -1, t: 0, re: 0, im: 0, down: true };
  const corr = (t: number, sync: [number, number][]) => { let cr = 0, ci = 0; for (let k = 0; k < sync.length; k++) { const p = 2 * (t + k * SPS), sr = sync[k][0], si = -sync[k][1]; cr += z[p] * sr - z[p + 1] * si; ci += z[p] * si + z[p + 1] * sr; } return [cr, ci]; };
  const mags: Float64Array[] = [new Float64Array(search), new Float64Array(search)];
  for (const [di, sync] of [[0, SYNC_DL], [1, SYNC_UL]] as [number, [number, number][]][]) for (let t = 0; t < search; t++) {
    const [cr, ci] = corr(t, sync), v = cr * cr + ci * ci; mags[di][t] = v;
    if (v > best.v) best = { v, t, re: cr, im: ci, down: di === 0 };
  }
  const mg = mags[best.down ? 0 : 1], t0 = best.t, am = mg[t0 - 1] ?? best.v, cm = mg[t0 + 1] ?? best.v, d2 = am - 2 * best.v + cm;
  const tf = d2 < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (am - cm) / d2)) : 0;
  const uw0 = t0 + tf + PRE * SPS;
  // phase from the correlation; symbols at one sample each from the unique word on
  const g = Math.hypot(best.re, best.im) || 1, pr = best.re / g, pi = -best.im / g;
  const maxSym = Math.min(Math.floor((m - 2 - uw0) / SPS), simplex ? MAX_SYM_SIMPLEX : MAX_SYM_NORMAL);
  if (maxSym < UW_LEN + 8) return null;
  const sr = new Float32Array(maxSym), si = new Float32Array(maxSym);
  for (let k = 0; k < maxSym; k++) {
    const t = uw0 + k * SPS, i = Math.floor(t), u = t - i;
    const ar = z[2 * i] + (z[2 * i + 2] - z[2 * i]) * u, ai = z[2 * i + 1] + (z[2 * i + 3] - z[2 * i + 1]) * u;
    sr[k] = ar * pr - ai * pi; si[k] = ar * pi + ai * pr;
  }
  // first-order PLL (gr-burst's, as gr-iridium uses it), decisions, the burst's end where the level falls away
  const alpha = 0.2, out = new Uint8Array(maxSym), Q = Math.SQRT1_2;
  let phR = 1, phI = 0, top = 0, low = 0, ns = 0, ok = 0, lvl = 0;
  for (let k = 0; k < maxSym; k++) {
    const yr = sr[k] * phR - si[k] * phI, yi = sr[k] * phI + si[k] * phR;
    const xr = yr >= 0 ? Q : -Q, xi = yi >= 0 ? Q : -Q;
    const er = xr * yr + xi * yi, ei = xr * yi - xi * yr, ea = Math.atan2(ei, er) * alpha;
    const nr = phR * Math.cos(ea) + phI * Math.sin(ea), ni = phI * Math.cos(ea) - phR * Math.sin(ea), gn = Math.hypot(nr, ni) || 1;
    phR = nr / gn; phI = ni / gn;
    out[k] = yr >= 0 ? (yi >= 0 ? 0 : 3) : (yi >= 0 ? 1 : 2);
    const mg2 = Math.hypot(yr, yi); if (mg2 > top) top = mg2;
    const deg = ((Math.atan2(yi, yr) + Math.PI) * 180 / Math.PI) % 90;
    if (Math.abs(45 - deg) <= 22) ok++;
    lvl += mg2; ns++;
    if (mg2 < top / 8) { if (++low === 3) { ns -= 3; break; } } else low = 0;
  }
  const uwOk = (uw: number[]) => { let d = 0; for (let i = 0; i < UW_LEN; i++) { let e = Math.abs(out[i] - uw[i]); if (e === 3) e = 1; d += e; } return d <= 2; };
  const down = uwOk(UW_DL) ? true : uwOk(UW_UL) ? false : null;
  if (down === null || ns < UW_LEN) return null;
  // differential: the change from the symbol before, 0/1/2/3 quarter turns → 00, 10, 11, 01
  const MAP = [0, 2, 3, 1]; let prev = 0, bits = '';
  for (let k = 0; k < ns; k++) { const d = MAP[(out[k] - prev + 4) % 4]; prev = out[k]; bits += (d & 2 ? '1' : '0') + (d & 1 ? '1' : '0'); }
  return { bits, down, symbols: ns, confidence: Math.round(100 * ok / ns), cfoHz: cfo, level: lvl / ns };
}

/** Bursts in a stream of int8 I/Q at `rate` around `centreHz`. */
export class IridiumRx {
  onBurst: (b: IridiumBurst) => void = () => undefined;
  /** Bursts seen in the spectrum, and those whose unique word checked. */
  detected = 0; demodulated = 0;
  private readonly N: number; private readonly hop: number;
  private readonly floor: Float32Array; private readonly busy: Int32Array;
  private ring: Int8Array; private written = 0;
  private pending: { at: number; until: number; hz: number }[] = [];
  private frames = 0;
  private recent: { bits: string; ms: number }[] = [];
  private readonly win: Float32Array;
  constructor(readonly rate: number, readonly centreHz: number, private readonly thresholdDb = 12) {
    // bins of about 8 kHz (a burst spans four or five); a look every 0.5 ms (the shortest burst lasts over 3 ms)
    this.N = 2 ** Math.ceil(Math.log2(rate / 8000)); this.hop = Math.max(this.N, Math.round(rate * 5e-4));
    this.floor = new Float32Array(this.N); this.busy = new Int32Array(this.N);
    this.ring = new Int8Array(2 * 2 ** Math.ceil(Math.log2(rate * 0.06)));
    this.win = Float32Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N));
  }
  push(iq: Int8Array): void {
    const n = iq.length >> 1, R = this.ring, mask = R.length - 1;
    for (let i = 0; i < n; i++) {
      const p = (2 * (this.written + i)) & mask; R[p] = iq[2 * i]; R[p + 1] = iq[2 * i + 1];
      if ((this.written + i + 1) % this.hop === 0 && this.written + i + 1 >= this.N) this.look(this.written + i + 1);
    }
    this.written += n;
    // cut out the bursts whose samples are all in
    const done = this.pending.filter(p => p.until <= this.written);
    this.pending = this.pending.filter(p => p.until > this.written);
    for (const p of done) this.cut(p);
  }
  private look(end: number): void {
    const N = this.N, R = this.ring, mask = R.length - 1, re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) { const p = (2 * (end - N + i)) & mask; re[i] = R[p] * this.win[i]; im[i] = R[p + 1] * this.win[i]; }
    fftInPlace(re, im, false);
    const f = this.frames++, thr = 10 ** (this.thresholdDb / 10), on = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (f < 8) { this.floor[k] += p / 8; continue; }   // the first looks' mean (a minimum would sit 9 dB low)
      if (p > this.floor[k] * thr) on[k] = 1;
      else this.floor[k] += 0.02 * (p - this.floor[k]);   // the floor follows only where nothing is
    }
    if (f < 8) return;
    // groups of lit bins (in frequency order, so a burst across 0 Hz is one group); a new burst where a group
    // lights up that was dark the look before
    const B = (j: number) => (j + N / 2) % N;   // position j (0 = lowest frequency) → FFT bin
    for (let k = 1; k < N - 1; k++) {
      if (!on[B(k)]) { if (this.busy[k] > 0) this.busy[k]--; continue; }
      if (this.busy[k] > 0) { this.busy[k] = 4; continue; }
      let a = k; while (a + 1 < N - 1 && on[B(a + 1)]) a++;
      let pk = k, pv = 0; for (let j = k; j <= a; j++) { const b = B(j), p = re[b] * re[b] + im[b] * im[b]; if (p > pv) { pv = p; pk = j; } }
      // the whole width a burst can take (its preamble is a tone: narrow at first, ±17 kHz once modulated)
      const wide = Math.ceil(35e3 / (this.rate / N));
      for (let j = Math.max(0, Math.min(k, pk - wide)); j <= Math.min(N - 1, Math.max(a, pk + wide)); j++) this.busy[j] = 4;
      if (a - k + 1 < 2) { k = a; continue; }   // one bin: a carrier or a spike, not a 35 kHz burst
      const off = (pk - N / 2) * this.rate / N, hz = this.centreHz + off, simplex = hz >= IRIDIUM_SIMPLEX_HZ - 20e3;
      const len = ((simplex ? MAX_SYM_SIMPLEX : MAX_SYM_NORMAL) + 64 + 30) / IRIDIUM_BAUD;
      const at = Math.max(0, end - N - Math.round(this.rate * 1e-3));
      this.pending.push({ at, until: at + Math.round(this.rate * len), hz: off });
      this.detected++;
      k = a;
    }
  }
  private cut(p: { at: number; until: number; hz: number }): void {
    const R = this.ring, mask = R.length - 1, n = p.until - p.at;
    if (this.written - p.at > R.length / 2) return;   // overwritten already
    // mix to 0 Hz and decimate to about twice FS2, low-pass at 40 kHz, then exactly FS2
    const D = Math.max(1, Math.floor(this.rate / (2 * FS2))), chan = new ChannelDecimator(D), fs1 = this.rate / chan.total;
    const mixed = new Float32Array(2 * n), w = -2 * Math.PI * p.hz / this.rate;
    let cr = Math.cos(w * p.at), ci = Math.sin(w * p.at); const dr = Math.cos(w), di = Math.sin(w);
    for (let i = 0; i < n; i++) {
      const q = (2 * (p.at + i)) & mask, a = R[q], b = R[q + 1];
      mixed[2 * i] = a * cr - b * ci; mixed[2 * i + 1] = a * ci + b * cr;
      const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
    }
    const d = chan.process(mixed, n), lp = new ComplexFirDecimator(lowpassTaps(40_000 / fs1, 63), 1), f1 = new Float32Array(2 * d.n + 4);
    const c = lp.process(d.out, d.n, f1), step = fs1 / FS2, m = Math.floor((c - 2) / step), x = new Float32Array(2 * m);
    for (let i = 0; i < m; i++) { const t = i * step, j = Math.floor(t), u = t - j; x[2 * i] = f1[2 * j] + (f1[2 * j + 2] - f1[2 * j]) * u; x[2 * i + 1] = f1[2 * j + 1] + (f1[2 * j + 3] - f1[2 * j + 1]) * u; }
    const hz = this.centreHz + p.hz, r = demodBurst(x, m, hz >= IRIDIUM_SIMPLEX_HZ - 20e3);
    if (!r) return;
    // the same burst found twice (cut twice from overlapping detections): once
    const ms = p.at / this.rate * 1000;
    if (this.recent.some(q => q.bits === r.bits && Math.abs(q.ms - ms) < 50)) return;
    this.recent.push({ bits: r.bits, ms }); if (this.recent.length > 32) this.recent.shift();
    this.demodulated++;
    this.onBurst({ bits: r.bits, down: r.down, freqHz: Math.round(hz + r.cfoHz), ms, symbols: r.symbols, confidence: r.confidence, levelDb: Math.round(20 * Math.log10(r.level + 1e-9) * 10) / 10 });
  }
}
