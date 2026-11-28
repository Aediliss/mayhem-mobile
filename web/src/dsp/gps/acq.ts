/**
 * FORK: a GPS L1 C/A monitor, receive only. Written from IS-GPS-200 (no code ported): the C/A codes (G1 = 1 + x^3 +
 * x^10, G2 = 1 + x^2 + x^3 + x^6 + x^8 + x^9 + x^10, both from all ones; each PRN's code is G1 xor G2 taken through its
 * pair of G2 taps, Table 3-Ia), 1023 chips a millisecond at 1.023 MHz on 1575.42 MHz.
 *
 * Acquisition (the textbook parallel code-phase search): 2.048 MS/s, so a millisecond is 2048 samples; for each
 * Doppler bin the snapshot's milliseconds are wiped of that frequency and transformed once, then for every PRN
 * multiplied by its code's conjugate spectrum and transformed back: the squared correlation at every code phase,
 * summed over 20 ms. A satellite is the peak far above the mean; C/N0 from the peak over the mean (coherent 1 ms).
 * An SDR's clock is ±20 ppm (±30 kHz at L1): the first rounds search ±40 kHz, then the common offset (the median of
 * the satellites found) is taken out and ±6 kHz around it searched, so Dopplers are the satellites' own.
 *
 * Jamming: the jamming detector (dsp/jam.ts) runs on the same IQ. Spoofing (heuristics, flags not proof): four or more
 * satellites at nearly the same C/N0; C/N0 above what the sky gives (51 dB-Hz as measured); one PRN at two code phases (a spoofer
 * over the real signal).
 */
import { fft } from '../../fft.js';
import { JamDetector, type JamStatus } from '../jam.js';
import type { Emit, IqProcessor } from '../core.js';

export const GPS_L1_HZ = 1_575_420_000, GPS_FS = 2_048_000;
const N = 2048, MS = 20, CHIPS = 1023;
/** IS-GPS-200 Table 3-Ia: the G2 taps (1-based) for PRN 1-32. */
const G2_TAPS: [number, number][] = [[2, 6], [3, 7], [4, 8], [5, 9], [1, 9], [2, 10], [1, 8], [2, 9], [3, 10], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10],
  [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [6, 9], [1, 3], [4, 6], [5, 7], [6, 8], [7, 9], [8, 10], [1, 6], [2, 7], [3, 8], [4, 9]];

/** PRN [prn]'s 1023 chips (0 / 1). */
export function caCode(prn: number): Uint8Array {
  const g1 = new Uint8Array(10).fill(1), g2 = new Uint8Array(10).fill(1), [a, b] = G2_TAPS[prn - 1], out = new Uint8Array(CHIPS);
  for (let i = 0; i < CHIPS; i++) {
    out[i] = g1[9] ^ g2[a - 1] ^ g2[b - 1];
    const f1 = g1[2] ^ g1[9], f2 = g2[1] ^ g2[2] ^ g2[5] ^ g2[7] ^ g2[8] ^ g2[9];
    g1.copyWithin(1, 0, 9); g1[0] = f1; g2.copyWithin(1, 0, 9); g2[0] = f2;
  }
  return out;
}
/** A code sampled at 2.048 MS/s (one millisecond, ±1), starting [phase] chips in. */
function sampled(code: Uint8Array, phase = 0): Float32Array {
  const s = new Float32Array(N); for (let i = 0; i < N; i++) s[i] = code[Math.floor(phase + i * 1.023e6 / GPS_FS) % CHIPS] ? -1 : 1; return s;
}
/** The codes' conjugate spectra, made once. */
let CODE_FFT: { re: Float32Array; im: Float32Array }[] | null = null;
function codeFfts(): { re: Float32Array; im: Float32Array }[] {
  if (CODE_FFT) return CODE_FFT;
  CODE_FFT = [];
  for (let p = 1; p <= 32; p++) { const re = sampled(caCode(p)), im = new Float32Array(N); fft(re, im); for (let i = 0; i < N; i++) im[i] = -im[i]; CODE_FFT.push({ re, im }); }
  return CODE_FFT;
}

export interface GpsSat { prn: number; cn0: number; dopplerHz: number; codeChips: number; ratio: number; second?: { codeChips: number; dopplerHz: number; cn0: number } }
export interface GpsResult { sats: GpsSat[]; clockHz: number; wide: boolean; flags: string[] }

/** One search over a snapshot of 20 ms (2.048 MS/s complex), stepped a Doppler bin at a time. */
export class GpsSearch {
  private readonly best: { v: number; mean: number; code: number; dop: number; v2: number; code2: number; dop2: number; mean2: number }[] = [];
  private bins: number[] = []; private bi = 0;
  constructor(private readonly x: Float32Array, readonly clockHz: number, readonly wide: boolean) {
    const span = wide ? 40_000 : 6_000, step = 500;
    for (let d = -span; d <= span; d += step) this.bins.push(clockHz + d);
    for (let p = 0; p < 32; p++) this.best.push({ v: 0, mean: 1, code: 0, dop: 0, v2: 0, code2: 0, dop2: 0, mean2: 1 });
  }
  get done(): boolean { return this.bi >= this.bins.length; }
  get progress(): number { return this.bi / this.bins.length; }
  private k = 0; private acc: Float32Array[] = [];
  private readonly re = new Float32Array(N); private readonly im = new Float32Array(N);
  private readonly pr = new Float32Array(N); private readonly pi = new Float32Array(N);
  /** Search the next [n] Doppler bins. */
  step(n = 1): void { const end = Math.min(this.bins.length, this.bi + n); while (this.bi < end) this.unit(); }
  /** Search for about [ms] milliseconds of CPU (a millisecond of signal against all 32 codes at a time). */
  stepFor(ms: number): void { const t0 = Date.now(); while (!this.done && Date.now() - t0 < ms) this.unit(); }
  /** One millisecond of the snapshot at the current Doppler bin, against every code; the bin's results after the last. */
  private unit(): void {
    const codes = codeFfts(), re = this.re, im = this.im, pr = this.pr, pi = this.pi, f = this.bins[this.bi], k = this.k;
    if (k === 0) { if (this.acc.length !== 32) this.acc = Array.from({ length: 32 }, () => new Float32Array(N)); for (const a of this.acc) a.fill(0); }
    for (let i = 0; i < N; i++) { const t = k * N + i, w = -2 * Math.PI * f * t / GPS_FS, c = Math.cos(w), sn = Math.sin(w), xr = this.x[2 * t], xi = this.x[2 * t + 1]; re[i] = xr * c - xi * sn; im[i] = xr * sn + xi * c; }
    fft(re, im);
    for (let p = 0; p < 32; p++) {
      const C = codes[p];
      // X·conj(C), then the inverse transform as the conjugate of the forward one of the conjugate
      for (let i = 0; i < N; i++) { pr[i] = re[i] * C.re[i] - im[i] * C.im[i]; pi[i] = -(re[i] * C.im[i] + im[i] * C.re[i]); }
      fft(pr, pi);
      const a = this.acc[p]; for (let i = 0; i < N; i++) a[i] += pr[i] * pr[i] + pi[i] * pi[i];
    }
    if (++this.k < MS) return;
    this.k = 0;
    for (let p = 0; p < 32; p++) this.take(p, this.acc[p], f);
    this.bi++;
  }
  private take(p: number, a: Float32Array, f: number): void {
    let pk = 0, pv = 0, sum = 0; for (let i = 0; i < N; i++) { sum += a[i]; if (a[i] > pv) { pv = a[i]; pk = i; } }
    // the mean without the peak's neighbourhood (a chip is two samples)
    let ex = 0; for (let d = -3; d <= 3; d++) ex += a[(pk + d + N) % N];
    const mean = (sum - ex) / (N - 7), b = this.best[p];
    // a second, separate peak at this Doppler (another signal of the same PRN)
    let p2 = 0, v2 = 0; for (let i = 0; i < N; i++) { const dd = Math.min(Math.abs(i - pk), N - Math.abs(i - pk)); if (dd > 6 && a[i] > v2) { v2 = a[i]; p2 = i; } }
    const chips = (i: number) => (i * 1.023e6 / GPS_FS) % CHIPS, apart = (c: number) => Math.min(Math.abs(chips(pk) - c), CHIPS - Math.abs(chips(pk) - c)) > 3;
    if (pv / mean > b.v / b.mean) {
      // the old best becomes the runner-up only if it sat elsewhere in code phase
      if (b.v > 0 && apart(b.code) && b.v / b.mean > b.v2 / b.mean2) { b.v2 = b.v; b.mean2 = b.mean; b.code2 = b.code; b.dop2 = b.dop; }
      b.v = pv; b.mean = mean; b.code = chips(pk); b.dop = f;
      if (v2 / mean > b.v2 / b.mean2) { b.v2 = v2; b.mean2 = mean; b.code2 = chips(p2); b.dop2 = f; }
    } else if (apart(b.code) && pv / mean > b.v2 / b.mean2) { b.v2 = pv; b.mean2 = mean; b.code2 = chips(pk); b.dop2 = f; }
  }
  /** The satellites found: the peak at least [minRatio] × the mean (about 35 dB-Hz; noise alone, over the wide
   *  search's 161 Doppler bins and 32 PRNs, stayed under 3 in every trial). */
  result(minRatio = 4): GpsResult {
    const cn0 = (r: number) => 10 * Math.log10(Math.max(1e-3, r - 1) * 1000);
    const sats: GpsSat[] = [];
    this.best.forEach((b, i) => {
      const r = b.v / b.mean; if (r < minRatio) return;
      const s: GpsSat = { prn: i + 1, cn0: Math.round(cn0(r) * 10) / 10, dopplerHz: b.dop, codeChips: Math.round(b.code * 10) / 10, ratio: Math.round(r * 10) / 10 };
      const c2 = cn0(b.v2 / b.mean2);
      if (b.v2 > 0 && c2 >= 36.5 && c2 >= s.cn0 - 17) s.second = { codeChips: Math.round(b.code2 * 10) / 10, dopplerHz: b.dop2, cn0: Math.round(c2 * 10) / 10 };
      sats.push(s);
    });
    // a strong signal leaks into every other PRN's correlation (the codes' cross-correlation, about −24 dB, less what
    // it adds to the noise): a PRN more than 15 dB under the strongest is that leak, not a satellite (the sky's span
    // about 35-50 dB-Hz); a second peak of a PRN (it must also reach 36.5 dB-Hz) may be 17 dB under
    const top = Math.max(0, ...sats.map(s => s.cn0));
    for (let i = sats.length - 1; i >= 0; i--) if (sats[i].cn0 < top - 15) sats.splice(i, 1);
    for (const s of sats) if (s.second && s.second.cn0 < top - 17) delete s.second;
    // the clock: the median Doppler of what was found (satellites' own Dopplers average near zero)
    const ds = sats.map(s => s.dopplerHz).sort((a, b) => a - b), clockHz = ds.length >= 2 ? ds[ds.length >> 1] : this.clockHz;
    for (const s of sats) { s.dopplerHz -= clockHz; if (s.second) s.second.dopplerHz -= clockHz; }
    return { sats: sats.sort((a, b) => b.cn0 - a.cn0), clockHz, wide: this.wide, flags: spoofFlags(sats) };
  }
}

/** Spoofing heuristics (flags, not proof). */
export function spoofFlags(sats: GpsSat[]): string[] {
  const f: string[] = [];
  if (sats.length >= 4) {
    const m = sats.reduce((a, s) => a + s.cn0, 0) / sats.length, sd = Math.sqrt(sats.reduce((a, s) => a + (s.cn0 - m) ** 2, 0) / sats.length);
    if (sd < 1.5) f.push(`UNIFORM: ${sats.length} satellites within ${sd.toFixed(1)} dB of each other (the sky's differ by elevation)`);
  }
  // C/N0 as measured here (a strong signal also raises the noise every PRN sees, so it reads low): the open sky gives
  // up to about 50 dB-Hz
  const strong = sats.filter(s => s.cn0 > 51);
  if (strong.length) f.push(`STRONG: PRN ${strong.map(s => s.prn).join(', ')} above 51 dB-Hz (more than the sky gives)`);
  const dbl = sats.filter(s => s.second);
  if (dbl.length) f.push(`DOUBLE: PRN ${dbl.map(s => s.prn).join(', ')} at two code phases (a second signal of the same satellite)`);
  return f;
}

/** The worker's processor: snapshots every few seconds, searched a Doppler bin per buffer; the jamming detector on all. */
export class GpsProcessor implements IqProcessor {
  readonly jam = new JamDetector();
  centerHz = GPS_L1_HZ;
  private rate = 0; private snap: Float32Array | null = null; private fill = 0; private search: GpsSearch | null = null;
  private clockHz = 0; private haveClock = false; private nextAt = 0; private samples = 0;
  private jamStatus: JamStatus | null = null;
  /** Seconds between searches. */
  everyS = 5;
  constructor(private readonly emit: Emit) {
    this.jam.onStatus = s => { this.jamStatus = s; };
    this.jam.onAlert = a => { this.emit({ type: 'jamAlert', band: 'GPS L1', alert: a }); this.emit({ type: 'packet', line: `GPS L1 ${a.endS === null ? 'JAMMING' : 'jamming ended'}: ${a.kind}` }); };
  }
  reset(rate: number): void { this.rate = rate; this.jam.reset(rate, this.centerHz); this.snap = null; this.search = null; this.samples = 0; this.nextAt = 0; }
  /** A known clock offset (Hz at L1, e.g. from the radio's ppm): search narrow around it straight away. */
  setClock(hz: number): void { this.clockHz = hz; this.haveClock = true; }
  /** CLEAR: forget the clock estimate and search wide again. */
  clear(): void { this.haveClock = false; this.clockHz = 0; this.search = null; this.snap = null; }
  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const n = iq.length >> 1;
    this.jam.push(iq, n);
    this.samples += n;
    if (Math.abs(rate - GPS_FS) > 1) { if (this.samples % (rate * 2) < n) this.emit({ type: 'gps', error: `needs ${GPS_FS / 1e6} MS/s`, jam: this.jamStatus }); return; }
    if (!this.search && !this.snap && this.samples / rate >= this.nextAt) { this.snap = new Float32Array(2 * N * MS); this.fill = 0; }
    if (this.snap) {
      // the snapshot without the radio's DC offset
      const take = Math.min(n, N * MS - this.fill);
      for (let i = 0; i < take; i++) { this.snap[2 * (this.fill + i)] = iq[2 * i]; this.snap[2 * (this.fill + i) + 1] = iq[2 * i + 1]; }
      this.fill += take;
      if (this.fill === N * MS) {
        let mr = 0, mi = 0; for (let i = 0; i < N * MS; i++) { mr += this.snap[2 * i]; mi += this.snap[2 * i + 1]; } mr /= N * MS; mi /= N * MS;
        for (let i = 0; i < N * MS; i++) { this.snap[2 * i] -= mr; this.snap[2 * i + 1] -= mi; }
        this.search = new GpsSearch(this.snap, this.clockHz, !this.haveClock); this.snap = null;
      }
      return;
    }
    if (this.search) {
      this.search.stepFor(12);   // a slice per buffer, so the radio's IQ keep flowing
      this.emit({ type: 'gps', progress: this.search.progress, wide: this.search.wide, jam: this.jamStatus });
      if (this.search.done) {
        const r = this.search.result(); this.search = null; this.nextAt = this.samples / rate + this.everyS;
        if (r.sats.length >= 3) { this.clockHz = r.clockHz; this.haveClock = true; }
        else if (!r.wide) this.haveClock = false;   // lost them: search wide again
        this.emit({ type: 'gps', result: r, jam: this.jamStatus });
        this.emit({ type: 'packet', line: `GPS: ${r.sats.length} satellite${r.sats.length === 1 ? '' : 's'}${r.sats.length ? ` (${r.sats.map(s => `${s.prn} ${s.cn0.toFixed(0)}`).join(', ')} dB-Hz)` : ''} · clock ${(r.clockHz / 1000).toFixed(1)} kHz${r.flags.length ? ` · ${r.flags.map(x => x.split(':')[0]).join(', ')}` : ''}` });
      }
    }
  }
}
