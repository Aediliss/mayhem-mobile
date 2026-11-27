/**
 * FORK: the 406 MHz beacon burst, receive only: 160 ms of unmodulated carrier, then 400 bit/s biphase-L phase
 * modulation of ±1.1 rad (a 1 is +1.1 rad then −1.1 rad), 112 or 144 bits (C/S T.001; Mayhem's proc_epirb (GPL-2.0-or-
 * later) works the same signal by its phase jumps). Here, every channel of the 406.0–406.1 MHz band at once: a short
 * spectrum every 40 ms finds a beacon's carrier as a line standing well above the noise; the next 700 ms are kept, the
 * carrier mixed to 0 Hz (its frequency refined from the phase slope over the carrier), and the phase read against
 * the carrier's own. The frame starts at the first jump to +1.1 rad; the bit rate (400 bit/s ± 1 %) and timing are the
 * ones that make the Manchester halves differ most; each bit is the first half's mean phase minus the second's.
 */
import { fft } from '../../fft.js';

export const B406_CENTRE_HZ = 406_045_000;
export interface Burst406 { bits: number[]; carrierHz: number; levelDb: number; /** Seconds since the stream began. */ t: number }

function lowpass(cutoff: number, n: number): Float32Array {
  if (n <= 1) return Float32Array.of(1);
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) { const x = i - m, v = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x); h[i] = v * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))); s += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}

export class Beacon406Rx {
  onBurst: (b: Burst406) => void = () => undefined;
  carriers = 0;
  private key = ''; private D = 1; private fs = 0; private taps = new Float32Array(1);
  private hi = new Float32Array(0); private hq = new Float32Array(0); private next = 0;
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;
  // the decimated stream (~96 kHz), a ring of the last second
  private ri = new Float32Array(0); private rq = new Float32Array(0); private n = 0;
  private sinceLook = 0; private looks = 0;
  /** Bins strong lately: bin → the look it was last strong in (a carrier already seen, or a birdie that never stops). */
  private recent = new Map<number, number>();
  private pending: { at: number; hz: number }[] = [];
  private readonly N = 4096;

  private setup(rate: number, off: number): void {
    this.D = Math.max(1, Math.round(rate / 96_000)); this.fs = rate / this.D;
    this.taps = lowpass(Math.min(0.45, 46_000 / rate), this.D === 1 ? 1 : (6 * this.D + 1) | 1);
    this.hi = new Float32Array(this.taps.length - 1); this.hq = new Float32Array(this.taps.length - 1); this.next = 0;
    this.cr = 1; this.ci = 0; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    const cap = 1 << Math.ceil(Math.log2(this.fs * 1.2));
    this.ri = new Float32Array(cap); this.rq = new Float32Array(cap); this.n = 0; this.sinceLook = 0; this.looks = 0; this.recent.clear(); this.pending = [];
  }
  reset(): void { this.key = ''; }

  /** `offsetHz`: where 406.045 MHz (the middle of the band) is from the radio's centre. */
  onIq(iq: Int8Array, rate: number, offsetHz = 0): void {
    const key = `${rate}|${offsetHz}`;
    if (key !== this.key) { this.key = key; this.setup(rate, offsetHz); }
    const m = iq.length >> 1, H = this.hi.length, L = H + m, xi = new Float32Array(L), xq = new Float32Array(L);
    xi.set(this.hi); xq.set(this.hq);
    let cr = this.cr, ci = this.ci;
    for (let k = 0; k < m; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1];
      xi[H + k] = a * cr - b * ci; xq[H + k] = a * ci + b * cr;
      const t = cr * this.cdr - ci * this.cdi; ci = cr * this.cdi + ci * this.cdr; cr = t;
    }
    const g = 1.5 - (cr * cr + ci * ci) / 2; this.cr = cr * g; this.ci = ci * g;
    this.hi = xi.slice(L - H); this.hq = xq.slice(L - H);
    const h = this.taps, T = h.length, mask = this.ri.length - 1;
    let j = this.next;
    for (; j + T <= L; j += this.D) {
      let a = 0, b = 0; for (let t = 0; t < T; t++) { a += h[t] * xi[j + t]; b += h[t] * xq[j + t]; }
      this.ri[this.n & mask] = a; this.rq[this.n & mask] = b; this.n++;
      if (++this.sinceLook >= Math.round(0.04 * this.fs) && this.n >= this.N) { this.sinceLook = 0; this.look(); }
      while (this.pending.length && this.n - this.pending[0].at >= Math.round(0.72 * this.fs)) this.burst(this.pending.shift()!);
    }
    this.next = j - (L - H);
  }

  /**
   * Carriers: bins of the last 4096 samples (~43 ms) far above the median. A beacon's is new (nothing there in the last
   * ~240 ms); one that has been there all along is a birdie, or a burst already taken.
   */
  private look(): void {
    this.looks++;
    const N = this.N, re = new Float32Array(N), im = new Float32Array(N), mask = this.ri.length - 1;
    for (let i = 0; i < N; i++) { const k = (this.n - N + i) & mask, w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = this.ri[k] * w; im[i] = this.rq[k] * w; }
    fft(re, im);
    const p = new Float32Array(N); for (let i = 0; i < N; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    const sorted = Float32Array.from(p).sort(), med = sorted[N >> 1] || 1;
    const lim = Math.floor(0.47 * N * 96_000 / this.fs), peaks: [number, number][] = [];
    for (let b = -lim; b <= lim; b++) {
      const v = p[(b + N) % N];
      if (v >= 400 * med && v >= p[(b - 1 + N) % N] && v >= p[(b + 1 + N) % N]) peaks.push([b, v]);   // ~26 dB over the median
    }
    peaks.sort((x, y) => y[1] - x[1]);
    for (const [b] of peaks.slice(0, 4)) {
      let seen = false;
      // the burst's own sidebands (±400 Hz and so on) are the same signal: channels are at least 3 kHz apart
      const span = Math.round(1500 * N / this.fs);
      for (let d = -span; d <= span; d++) { const t = this.recent.get(b + d); if (t !== undefined && this.looks - t <= 6) { seen = true; break; } }
      this.recent.set(b, this.looks);
      if (seen) continue;
      this.carriers++;
      // the carrier opens the burst: take it from 40 ms back
      this.pending.push({ at: this.n - N, hz: b * this.fs / N });
    }
    if (this.recent.size > 256) for (const [k, t] of this.recent) if (this.looks - t > 6) this.recent.delete(k);
  }

  private burst(p: { at: number; hz: number }): void {
    const fs = this.fs, len = Math.round(0.72 * fs), mask = this.ri.length - 1;
    if (this.n - p.at > this.ri.length) return;
    // mix to 0 Hz, low-pass ±3 kHz, down to ~12 kHz
    const D2 = Math.max(1, Math.round(fs / 12_000)), fs2 = fs / D2, h = lowpass(3000 / fs, (8 * D2 + 1) | 1), T = h.length;
    const w = -2 * Math.PI * p.hz / fs, mi = new Float32Array(len), mq = new Float32Array(len);
    let pw = 0;
    for (let i = 0; i < len; i++) { const k = (p.at + i) & mask, c = Math.cos(w * i), s = Math.sin(w * i); mi[i] = this.ri[k] * c - this.rq[k] * s; mq[i] = this.ri[k] * s + this.rq[k] * c; pw += mi[i] ** 2 + mq[i] ** 2; }
    const n2 = Math.floor((len - T) / D2), zi = new Float32Array(n2), zq = new Float32Array(n2);
    for (let o = 0; o < n2; o++) { let a = 0, b = 0; for (let t = 0; t < T; t++) { a += h[t] * mi[o * D2 + t]; b += h[t] * mq[o * D2 + t]; } zi[o] = a; zq[o] = b; }
    // the carrier's frequency and phase from 20-100 ms in (unmodulated): a line through its unwrapped phase
    const c0 = Math.round(0.02 * fs2), c1 = Math.round(0.1 * fs2);
    let prev = Math.atan2(zq[c0], zi[c0]), acc = prev, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = c0; i < c1; i++) {
      const a = Math.atan2(zq[i], zi[i]); let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI; acc += i === c0 ? 0 : d; prev = a;
      const x = i - c0; sx += x; sy += acc; sxx += x * x; sxy += x * acc;
    }
    const cn = c1 - c0, slope = (cn * sxy - sx * sy) / (cn * sxx - sx * sx || 1), icpt = (sy - slope * sx) / cn;
    // the phase against the carrier's
    const th = new Float32Array(n2);
    for (let i = 0; i < n2; i++) { const r = -(icpt + slope * (i - c0)), c = Math.cos(r), s = Math.sin(r), a = zi[i] * c - zq[i] * s, b = zi[i] * s + zq[i] * c; th[i] = Math.atan2(b, a); }
    // the frame starts at the first jump to +1.1 rad (or −1.1 if the spectrum is the other way round) after the carrier
    let t0 = -1, sign = 1;
    for (let i = Math.round(0.12 * fs2); i < n2 - 4; i++) { if (Math.abs(th[i]) > 0.55 && Math.abs(th[i + 1]) > 0.55 && Math.abs(th[i + 2]) > 0.55) { t0 = i; sign = th[i] > 0 ? 1 : -1; break; } }
    if (t0 < 0) return;
    // bit rate and timing: the pair that makes the halves differ most over the first 112 bits
    let bestS = -1, bestR = 400, bestOff = 0;
    for (let rate = 396; rate <= 404; rate += 0.5) for (let off = -0.6; off <= 0.6; off += 0.2) {
      const Tb = fs2 / rate, st = t0 + off * Tb * 0.25; let s = 0;
      for (let k = 0; k < 112; k++) s += Math.abs(this.half(th, st + k * Tb, Tb, n2));
      if (s > bestS) { bestS = s; bestR = rate; bestOff = off; }
    }
    const Tb = fs2 / bestR, st = t0 + bestOff * Tb * 0.25, out: number[] = [];
    for (let k = 0; k < 144 && st + (k + 1) * Tb < n2; k++) out.push(sign * this.half(th, st + k * Tb, Tb, n2) > 0 ? 1 : 0);
    this.onBurst({ bits: out, carrierHz: p.hz, levelDb: 10 * Math.log10(pw / len / 16384 + 1e-12), t: p.at / fs });
  }
  /** First half's mean phase minus the second half's, for the bit starting at sample t. */
  private half(th: Float32Array, t: number, Tb: number, n: number): number {
    const a0 = Math.round(t + 0.1 * Tb), a1 = Math.round(t + 0.45 * Tb), b0 = Math.round(t + 0.55 * Tb), b1 = Math.round(t + 0.9 * Tb);
    if (b1 >= n || a0 < 0) return 0;
    let a = 0, b = 0; for (let i = a0; i < a1; i++) a += th[i]; for (let i = b0; i < b1; i++) b += th[i];
    return a / Math.max(1, a1 - a0) - b / Math.max(1, b1 - b0);
  }
}
