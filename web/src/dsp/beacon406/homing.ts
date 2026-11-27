/**
 * FORK: the 121.5 MHz homing signal of an EPIRB, PLB or ELT, receive only: AM, its audio a tone swept downward (between
 * about 1600 and 300 Hz, two to four sweeps a second, per ICAO Annex 10 / C/S T.001's homing requirements). The
 * channel is cut out, the AM envelope taken to 8 kHz audio, and short spectra (32 ms) follow the strongest tone; a run
 * of downward sweeps covering at least 700 Hz, repeating every 0.2-0.6 s, is a homer (voice on 121.5 does not do
 * that). Reports the homer's audio sweep, its repetition rate and the signal level, for direction finding by ear or
 * by level. Receive only.
 */
import { fft } from '../../fft.js';

export const HOMING_HZ = 121_500_000;
export interface HomingState { on: boolean; sweepHz: [number, number]; perS: number; levelDb: number; snrDb: number }

function lowpass(cutoff: number, n: number): Float32Array {
  if (n <= 1) return Float32Array.of(1);
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) { const x = i - m, v = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x); h[i] = v * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))); s += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}

export class HomingDetector {
  onState: (s: HomingState) => void = () => undefined;
  private key = ''; private D = 1; private fs = 8000; private taps = new Float32Array(1);
  private hi = new Float32Array(0); private hq = new Float32Array(0); private next = 0;
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;
  private audio = new Float32Array(256); private an = 0; private dc = 0;
  /** The tone's frequency in each 32 ms frame (0 when no tone), and the frame's power. */
  private track: number[] = []; private pow: number[] = []; private noise = 0;
  private lastEmit = 0; private frames = 0;
  private state: HomingState = { on: false, sweepHz: [0, 0], perS: 0, levelDb: -99, snrDb: 0 };

  reset(): void { this.key = ''; }
  private setup(rate: number, off: number): void {
    this.D = Math.max(1, Math.round(rate / 8000)); this.fs = rate / this.D;
    this.taps = lowpass(Math.min(0.45, 4000 / rate), this.D === 1 ? 1 : (4 * this.D + 1) | 1);
    this.hi = new Float32Array(this.taps.length - 1); this.hq = new Float32Array(this.taps.length - 1); this.next = 0;
    this.cr = 1; this.ci = 0; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    this.an = 0; this.dc = 0; this.track = []; this.pow = []; this.noise = 0; this.frames = 0;
  }

  /** `offsetHz`: where 121.5 MHz is from the radio's centre. */
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
    const h = this.taps, T = h.length;
    let j = this.next;
    for (; j + T <= L; j += this.D) {
      let a = 0, b = 0; for (let t = 0; t < T; t++) { a += h[t] * xi[j + t]; b += h[t] * xq[j + t]; }
      const env = Math.hypot(a, b);
      this.dc += 0.002 * (env - this.dc);
      this.audio[this.an++] = env - this.dc;
      if (this.an === this.audio.length) { this.an = 0; this.frame(); }
    }
    this.next = j - (L - H);
  }

  private frame(): void {
    const N = this.audio.length, re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = this.audio[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fft(re, im);
    const hz = this.fs / N, lo = Math.floor(250 / hz), hi = Math.ceil(1800 / hz);
    let best = lo, bv = 0, tot = 0;
    for (let b = lo; b <= hi; b++) { const v = re[b] * re[b] + im[b] * im[b]; tot += v; if (v > bv) { bv = v; best = b; } }
    const mean = (tot - bv) / (hi - lo) || 1e-9;
    this.noise = this.noise ? this.noise + 0.02 * (mean - this.noise) : mean;
    const tone = bv > 12 * mean;   // a clear line, not voice spread over the band
    this.track.push(tone ? best * hz : 0); this.pow.push(bv);
    const keep = Math.round(2.5 * this.fs / N); if (this.track.length > keep) { this.track.shift(); this.pow.shift(); }
    if (++this.frames % 8 === 0) this.judge();
  }

  /** Downward sweeps in the last 2.5 s: runs of falling tone frequency, each ≥ 700 Hz, starting again every 0.2-0.6 s. */
  private judge(): void {
    const tr = this.track, dt = this.audio.length / this.fs, sweeps: { from: number; to: number; at: number }[] = [];
    let start = -1;
    for (let i = 1; i <= tr.length; i++) {
      const falling = i < tr.length && tr[i] > 0 && tr[i - 1] > 0 && tr[i] <= tr[i - 1] + 40;
      if (falling && start < 0) start = i - 1;
      if (!falling && start >= 0) {
        const from = tr[start], to = tr[i - 1];
        if (from - to >= 700) sweeps.push({ from, to, at: start * dt });
        start = -1;
      }
    }
    const gaps = sweeps.slice(1).map((s, i) => s.at - sweeps[i].at).filter(g => g >= 0.15 && g <= 0.7);
    const on = sweeps.length >= 3 && gaps.length >= 2;
    const strong = this.pow.reduce((a, b) => Math.max(a, b), 0);
    const st: HomingState = on
      ? { on, sweepHz: [Math.round(Math.max(...sweeps.map(s => s.from))), Math.round(Math.min(...sweeps.map(s => s.to)))], perS: +(1 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1), levelDb: 10 * Math.log10(strong + 1e-9), snrDb: 10 * Math.log10(strong / (this.noise || 1e-9)) }
      : { on: false, sweepHz: [0, 0], perS: 0, levelDb: 10 * Math.log10(strong + 1e-9), snrDb: 0 };
    const changed = st.on !== this.state.on;
    this.state = st;
    const now = this.frames;
    if (changed || (on && now - this.lastEmit >= 16)) { this.lastEmit = now; this.onState(st); }
  }
}
