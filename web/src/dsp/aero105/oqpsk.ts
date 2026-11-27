/**
 * FORK: an OQPSK receiver for the Inmarsat Aero 10.5 kbps P-channel (5250 symbols a second on each rail, the Q rail
 * half a symbol late, root raised cosine with roll-off 1, as JAERO's oqpskdemodulator (MIT) shapes it). The channel is
 * cut down to ~125 kHz; the carrier is found as JAERO finds it, from the pair of lines the squared signal puts one symbol
 * rate (5250 Hz) either side of twice the carrier; then down to ~42 kHz, the matched filter, a Gardner clock on strobes
 * half a symbol apart (I symbol, then Q symbol), and a Costas loop. Out comes one soft bit a strobe, rails interleaved.
 */
import { fft } from '../../fft.js';

export const SYMBOL_RATE = 5250;
const ACQ_BLOCKS = 4;

function lowpass(cutoff: number, n: number): Float32Array {
  if (n <= 1) return Float32Array.of(1);
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m, sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1))); s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}
/** Root raised cosine, roll-off 1, `sps` samples a symbol, ±`span` symbols. */
export function rrc(sps: number, span = 4, beta = 1): Float32Array {
  const n = 2 * Math.round(span * sps) + 1, h = new Float32Array(n), m = (n - 1) / 2; let e = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - m) / sps; let v: number;
    if (Math.abs(t) < 1e-9) v = 1 - beta + 4 * beta / Math.PI;
    else if (Math.abs(Math.abs(4 * beta * t) - 1) < 1e-9) v = beta / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
    else v = (Math.sin(Math.PI * t * (1 - beta)) + 4 * beta * t * Math.cos(Math.PI * t * (1 + beta))) / (Math.PI * t * (1 - (4 * beta * t) ** 2));
    h[i] = v; e += v * v;
  }
  const g = 1 / Math.sqrt(e * 1); for (let i = 0; i < n; i++) h[i] *= g;
  return h;
}

/** A decimating complex FIR with its own history. */
class Decim {
  private hi: Float32Array; private hq: Float32Array; private next = 0;
  constructor(private readonly h: Float32Array, private readonly D: number) { this.hi = new Float32Array(h.length - 1); this.hq = new Float32Array(h.length - 1); }
  run(xi: Float32Array, xq: Float32Array, n: number, oi: Float32Array, oq: Float32Array): number {
    const H = this.hi.length, L = H + n, ai = new Float32Array(L), aq = new Float32Array(L);
    ai.set(this.hi); aq.set(this.hq); ai.set(xi.subarray(0, n), H); aq.set(xq.subarray(0, n), H);
    const h = this.h, T = h.length; let k = 0, j = this.next;
    for (; j + T <= L; j += this.D) { let a = 0, b = 0; for (let t = 0; t < T; t++) { a += h[t] * ai[j + t]; b += h[t] * aq[j + t]; } oi[k] = a; oq[k++] = b; }
    this.next = j - (L - H); this.hi = ai.slice(L - H); this.hq = aq.slice(L - H);
    return k;
  }
}

export class OqpskRx {
  /** The carrier found, Hz from the channel's frequency (NaN before). */
  carrierHz = NaN;
  /** Lines of the squared signal over its mean, dB. */
  lineDb = 0;
  /** 0..1: how well the strobes sit on ±1 (≈1 when locked). */
  lock = 0;
  onBits: (soft: Float32Array, n: number) => void = () => undefined;
  private key = '';
  private d1: Decim | null = null; private d2: Decim | null = null; private mf: Float32Array = new Float32Array(1);
  private fs1 = 0; private fs2 = 0; private sps = 0;
  private cr = 1; private ci = 0; private cdr = 1; private cdi = 0;            // channel mixer (input rate)
  private acqR = new Float32Array(8192); private acqI = new Float32Array(8192); private acqP = new Float32Array(8192); private acqN = 0; private acqB = 0; private ACQ_N = 8192;
  private ph = 0; private fr = 0;                                              // carrier NCO at fs2 (rad, rad/sample)
  private yi = new Float32Array(0); private yq = new Float32Array(0);   // matched-filter history at fs2
  private mfI = new Float32Array(0); private mfQ = new Float32Array(0);
  private tau = 0; private strobe = 0; private r: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  private amp = 1; private out = new Float32Array(4096);
  private lockAcc = 0; private lockN = 0; private sinceAcq = 0;

  reset(): void { this.key = ''; this.carrierHz = NaN; this.lock = 0; }

  private setup(rate: number, off: number): void {
    const D1 = Math.max(1, Math.round(rate / 125_000)); this.fs1 = rate / D1;
    const D2 = Math.max(1, Math.round(this.fs1 / (8 * SYMBOL_RATE))); this.fs2 = this.fs1 / D2; this.sps = this.fs2 / SYMBOL_RATE;
    this.d1 = new Decim(lowpass(Math.min(0.45, 0.42 * this.fs1 / rate), D1 === 1 ? 1 : (8 * D1 + 1) | 1), D1);
    this.d2 = new Decim(lowpass(Math.min(0.45, 11_500 / this.fs1), D2 === 1 ? 1 : (10 * D2 + 1) | 1), D2);
    this.mf = rrc(this.sps);
    this.cr = 1; this.ci = 0; this.cdr = Math.cos(-2 * Math.PI * off / rate); this.cdi = Math.sin(-2 * Math.PI * off / rate);
    // ~15 Hz bins in the squared signal (about 7.5 Hz of carrier), whatever the rate
    this.ACQ_N = Math.max(1024, Math.min(8192, 2 ** Math.round(Math.log2(this.fs1 / 15))));
    this.acqR = new Float32Array(this.ACQ_N); this.acqI = new Float32Array(this.ACQ_N); this.acqP = new Float32Array(this.ACQ_N);
    this.acqN = 0; this.acqB = 0; this.carrierHz = NaN; this.ph = 0; this.fr = 0;
    this.yi = new Float32Array(this.mf.length); this.yq = new Float32Array(this.mf.length);
    this.tau = 0; this.strobe = 0; this.amp = 1; this.lock = 0; this.sinceAcq = 0;
  }

  onIq(iq: Int8Array, rate: number, offsetHz: number): void {
    const key = `${rate}|${offsetHz}`;
    if (key !== this.key) { this.key = key; this.setup(rate, offsetHz); }
    const n = iq.length >> 1, xi = new Float32Array(n), xq = new Float32Array(n);
    let cr = this.cr, ci = this.ci;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1];
      xi[k] = a * cr - b * ci; xq[k] = a * ci + b * cr;
      const t = cr * this.cdr - ci * this.cdi; ci = cr * this.cdi + ci * this.cdr; cr = t;
    }
    const g = 1.5 - (cr * cr + ci * ci) / 2; this.cr = cr * g; this.ci = ci * g;
    const o1i = new Float32Array(n), o1q = new Float32Array(n), m1 = this.d1!.run(xi, xq, n, o1i, o1q);
    this.acquire(o1i, o1q, m1);
    if (!Number.isFinite(this.carrierHz)) return;
    const o2i = new Float32Array(m1), o2q = new Float32Array(m1), m2 = this.d2!.run(o1i, o1q, m1, o2i, o2q);
    this.track(o2i, o2q, m2);
  }

  /** The carrier from the squared signal: lines at 2·fc ± Rs (JAERO CoarseFreqEstimate: fb/2 = 5250 Hz). */
  private acquire(xi: Float32Array, xq: Float32Array, n: number): void {
    // re-acquire now and then while not locked
    if (Number.isFinite(this.carrierHz) && (this.lock > 0.5 || this.sinceAcq < 4 * this.fs1)) { this.sinceAcq += n; return; }
    for (let k = 0; k < n; k++) {
      const a = xi[k], b = xq[k];
      this.acqR[this.acqN] = a * a - b * b; this.acqI[this.acqN] = 2 * a * b;
      if (++this.acqN === this.ACQ_N) {
        this.acqN = 0;
        const re = this.acqR.slice(), im = this.acqI.slice(); fft(re, im);
        for (let i = 0; i < this.ACQ_N; i++) this.acqP[i] += re[i] * re[i] + im[i] * im[i];
        if (++this.acqB < ACQ_BLOCKS) continue;
        this.acqB = 0;
        const hz = this.fs1 / this.ACQ_N, half = Math.round(SYMBOL_RATE / hz), lim = Math.floor(Math.min(0.4 * this.fs1, 2 * 60_000) / hz);
        let mean = 0; for (let i = 0; i < this.ACQ_N; i++) mean += this.acqP[i]; mean /= this.ACQ_N;
        const P = (b: number) => { let s = 0; for (let j = -1; j <= 1; j++) s += this.acqP[((b + j) % this.ACQ_N + this.ACQ_N) % this.ACQ_N]; return s; };
        let best = 0, bv = -1;
        for (let c = -lim + half; c <= lim - half; c++) { const v = P(c - half) + P(c + half); if (v > bv) { bv = v; best = c; } }
        this.lineDb = 10 * Math.log10(bv / 6 / (mean || 1));
        this.acqP.fill(0);
        if (this.lineDb > 8) {
          const was = this.carrierHz; this.carrierHz = best * hz / 2; this.sinceAcq = 0;
          if (was !== this.carrierHz) { this.fr = 2 * Math.PI * this.carrierHz / this.fs2; this.ph = 0; }
        }
      }
    }
  }

  private track(xi: Float32Array, xq: Float32Array, n: number): void {
    const h = this.mf, T = h.length, sps = this.sps, half = sps / 2;
    if (this.mfI.length < n + T) { this.mfI = new Float32Array(n + T); this.mfQ = new Float32Array(n + T); }
    // derotate and keep a line of the last T samples for the matched filter, filtering as we go
    let outN = 0;
    const lw = 2 * Math.PI * 60 / (SYMBOL_RATE * 2), damp = 0.707;   // loop: ~60 Hz, per strobe
    const ka = 4 * damp * lw / (1 + 2 * damp * lw + lw * lw), kb = 4 * lw * lw / (1 + 2 * damp * lw + lw * lw);
    for (let k = 0; k < n; k++) {
      const c = Math.cos(this.ph), s = Math.sin(this.ph);
      const a = xi[k] * c + xq[k] * s, b = xq[k] * c - xi[k] * s;
      this.ph += this.fr; if (this.ph > Math.PI) this.ph -= 2 * Math.PI; else if (this.ph < -Math.PI) this.ph += 2 * Math.PI;
      this.yi.copyWithin(0, 1); this.yq.copyWithin(0, 1); this.yi[T - 1] = a; this.yq[T - 1] = b;
      let fi = 0, fq = 0; for (let t = 0; t < T; t++) { fi += h[t] * this.yi[t]; fq += h[t] * this.yq[t]; }
      // strobes: linear interpolation between the last two filtered samples
      const pi = this.mfI[0], pq = this.mfQ[0]; this.mfI[0] = fi; this.mfQ[0] = fq;
      this.tau -= 1;
      while (this.tau <= 0) {
        const f = 1 + this.tau;   // the strobe lies between the previous sample (0) and this one (1)
        const ri = pi + f * (fi - pi), rq = pq + f * (fq - pq);
        this.r.shift(); this.r.push([ri, rq]);
        const isI = (this.strobe & 1) === 0, [r0, r1, r2] = this.r;
        // Gardner on the rail whose symbol this strobe is; the strobe between carries the other rail's symbol
        const eT = isI ? r1[0] * (r0[0] - r2[0]) : r1[1] * (r0[1] - r2[1]);
        const sym = isI ? ri : rq, other = isI ? rq : ri;
        this.amp += 0.002 * (Math.abs(sym) - this.amp);
        const A = this.amp || 1;
        // Costas: the symbol's rail decided, the error is the other component turned by the phase
        const eP = isI ? Math.sign(ri) * rq / A : -Math.sign(rq) * ri / A;
        void other;
        this.ph += ka * eP * 0.25; this.fr += kb * eP * 0.25 / (sps / 2);
        // Gardner: a positive error means the strobes are late
        this.tau += half + Math.max(-0.5, Math.min(0.5, 0.15 * eT / (A * A))) * 0.05 * sps;
        if (this.out.length <= outN) { const o = new Float32Array(2 * this.out.length); o.set(this.out); this.out = o; }
        this.out[outN++] = sym / A;
        this.lockAcc += Math.min(1, Math.abs(sym) / A); this.lockN++;
        if (this.lockN >= 2000) { this.lock = Math.max(0, (this.lockAcc / this.lockN - 0.637) / (1 - 0.637)); this.lockAcc = 0; this.lockN = 0; }
        this.strobe++;
      }
    }
    if (outN) this.onBits(this.out, outN);
  }
}
