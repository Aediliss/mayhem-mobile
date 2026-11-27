/**
 * FORK: the ADS-L M-band receiver (EASA ADS-L 4 SRD-860 Issue 2, subpart C.2): 2-GFSK, ±50 kHz, 100 000 chips a
 * second, BT 0.5, Manchester ('1' = chips 01, '0' = chips 10) over the sync word 0x72 0x4B and the whole packet. One
 * channel: mixed to 0 Hz, low-passed and brought to about 4 samples a chip, an FM discriminator, then each bit is the
 * second chip's frequency minus the first's (so a carrier offset cancels). The sync word is searched at every sample;
 * the length byte says how many bytes follow. Also spotted, by their published sync word (OGN wiki, CC BY-SA 3.0),
 * OGN tracker packets: counted, not read (their LDPC code and whitening are not published).
 */

const CHIP = 100_000;
const SYNC = [0x72, 0x4B].flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1 ? 1 : -1));
const OGN_SYNC = [0x0A, 0xF3, 0x65, 0x6C].flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1 ? 1 : -1));
/** Longest packet read (length byte), in bytes after it. Traffic is 24, Status 16; bigger ones are uplinks or FEC. */
export const ADSL_MAX_LEN = 64;
const OGN_BYTES = 26;

export interface AdslBurst { bytes: Uint8Array; levelDb: number; offsetHz: number; ms: number }

/** Windowed-sinc low-pass taps, unit DC gain. */
function lowpass(cutoff: number, n: number): Float32Array {
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m, sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1))); s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}

export class AdslRx {
  /** A packet that passed `accept` (the caller checks its CRC); return true to skip past it. */
  accept: (b: AdslBurst) => boolean = () => false;
  onOgn: (levelDb: number) => void = () => undefined;
  readonly fs: number; readonly sps: number;
  private readonly D: number; private readonly taps: Float32Array;
  private readonly cd: number; private readonly sd: number; private c = 1; private s = 0;
  private hi: Float32Array; private hq: Float32Array; private next = 0;
  private pi = 0; private pq = 0;
  private f = new Float32Array(0); private pw = new Float32Array(0); private n = 0;
  private cs = new Float64Array(1);
  private scan = 0; private base = 0;   // base: decimated samples dropped from the front so far
  private readonly look: number; private readonly w: number;

  constructor(readonly rate: number, offsetHz: number) {
    this.D = Math.max(1, Math.round(rate / (4 * CHIP)));
    this.fs = rate / this.D; this.sps = this.fs / CHIP; this.w = Math.max(1, Math.round(this.sps));
    this.taps = lowpass(Math.min(0.45, 125_000 / rate), (8 * this.D + 1) | 1);
    this.cd = Math.cos(-2 * Math.PI * offsetHz / rate); this.sd = Math.sin(-2 * Math.PI * offsetHz / rate);
    this.hi = new Float32Array(this.taps.length - 1); this.hq = new Float32Array(this.taps.length - 1);
    this.look = Math.ceil((2 * (16 + 8 + 8 * ADSL_MAX_LEN) + 4) * this.sps) + 2 * this.w;
  }

  push(iq: Int8Array): void {
    const m = iq.length >> 1, H = this.hi.length, L = H + m, xi = new Float32Array(L), xq = new Float32Array(L);
    xi.set(this.hi); xq.set(this.hq);
    let c = this.c, s = this.s;
    for (let k = 0; k < m; k++) {
      const i = iq[2 * k], q = iq[2 * k + 1];
      xi[H + k] = i * c - q * s; xq[H + k] = i * s + q * c;
      const nc = c * this.cd - s * this.sd; s = c * this.sd + s * this.cd; c = nc;
    }
    const g = 1.5 - (c * c + s * s) / 2; this.c = c * g; this.s = s * g;
    this.hi = xi.slice(L - H); this.hq = xq.slice(L - H);
    // decimate
    const out = Math.max(0, Math.ceil((L - this.taps.length + 1 - this.next) / this.D));
    this.grow(out);
    const h = this.taps, T = h.length;
    let j = this.next;
    for (; j + T <= L; j += this.D) {
      let a = 0, b = 0;
      for (let k = 0; k < T; k++) { a += h[k] * xi[j + k]; b += h[k] * xq[j + k]; }
      this.f[this.n] = Math.atan2(b * this.pi - a * this.pq, a * this.pi + b * this.pq);
      this.pw[this.n++] = a * a + b * b; this.pi = a; this.pq = b;
    }
    this.next = j - (L - H);
    this.run();
  }

  private grow(extra: number): void {
    if (this.n + extra <= this.f.length) return;
    const cap = Math.max(2 * (this.n + extra), 4096), f = new Float32Array(cap), pw = new Float32Array(cap);
    f.set(this.f.subarray(0, this.n)); pw.set(this.pw.subarray(0, this.n)); this.f = f; this.pw = pw;
  }

  /** Sum of the discriminator over one chip starting at (fractional) sample t. */
  private chip(t: number): number { const a = Math.round(t); return this.cs[a + this.w] - this.cs[a]; }
  /** The Manchester bit at t (start of its first chip): > 0 for '1' (chips 01: low, then high). */
  private bit(t: number): number { return this.chip(t + this.sps) - this.chip(t); }
  private score(t: number, pat: number[]): [number, number, number] {
    let sum = 0, abs = 0, err = 0; const step = 2 * this.sps;
    for (let j = 0; j < pat.length; j++) { const d = this.bit(t + j * step); sum += pat[j] * d; abs += Math.abs(d); if (pat[j] * d <= 0) err++; }
    return [sum, abs, err];
  }
  private byteAt(t: number): number {
    let v = 0; const step = 2 * this.sps;
    for (let i = 0; i < 8; i++) v = v << 1 | (this.bit(t + i * step) > 0 ? 1 : 0);
    return v;
  }

  private run(): void {
    const n = this.n, cs = this.cs.length >= n + 1 ? this.cs : (this.cs = new Float64Array(2 * n + 1));
    cs[0] = 0; for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + this.f[i];
    const sps = this.sps, step = 2 * sps, end = n - this.look;
    let t = this.scan;
    while (t < end) {
      // cheap reject on the first four sync bits
      let ok = true;
      for (let j = 0; j < 4 && ok; j++) if (SYNC[j] * this.bit(t + j * step) <= 0) ok = false;
      if (ok) {
        const [sum, abs, err] = this.score(t, SYNC);
        if (err <= 1 && sum > 0.6 * abs) {
          let best = t, bs = sum;
          for (let k = 1; k <= Math.ceil(sps); k++) { const [s2] = this.score(t + k, SYNC); if (s2 > bs) { bs = s2; best = t + k; } }
          const p0 = best + 16 * step, len = this.byteAt(p0);
          if (len >= 8 && len <= ADSL_MAX_LEN) {
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = this.byteAt(p0 + (1 + i) * 8 * step);
            const span = Math.round((16 + 8 + 8 * len) * step), a = Math.round(best);
            let p = 0, fo = 0;
            for (let i = a; i < a + span; i++) { p += this.pw[i]; fo += this.f[i]; }
            const burst: AdslBurst = { bytes, levelDb: 10 * Math.log10(p / span / 16384 + 1e-12), offsetHz: fo / span * this.fs / (2 * Math.PI), ms: (this.base + a) / this.fs * 1000 };
            if (this.accept(burst)) { t = best + span; continue; }
          }
        }
      }
      let og = true;
      for (let j = 0; j < 4 && og; j++) if (OGN_SYNC[j] * this.bit(t + j * step) <= 0) og = false;
      if (og && this.ogn(t)) { t += Math.round((32 + 8 * OGN_BYTES) * step); continue; }
      t += 1;
    }
    this.scan = t;
    // drop what has been scanned, keeping one chip of history
    const drop = Math.max(0, Math.floor(this.scan) - 2 * this.w);
    if (drop > 0) {
      this.f.copyWithin(0, drop, n); this.pw.copyWithin(0, drop, n);
      this.n = n - drop; this.scan -= drop; this.base += drop;
    }
  }

  /** An OGN tracker's sync word at t. */
  private ogn(t: number): boolean {
    const [sum, abs, err] = this.score(t, OGN_SYNC);
    if (err > 2 || sum < 0.6 * abs) return false;
    const span = Math.round(32 * 2 * this.sps), a = Math.round(t); let p = 0;
    for (let i = a; i < a + span; i++) p += this.pw[i];
    this.onOgn(10 * Math.log10(p / span / 16384 + 1e-12));
    return true;
  }
}
