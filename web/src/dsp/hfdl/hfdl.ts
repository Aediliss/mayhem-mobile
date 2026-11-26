/**
 * FORK: HFDL in the Flight Msgs app: every published HFDL frequency inside the sampled span decoded at once (each its
 * own mixer, decimator and burst receiver, dsp/hfdl/phy.ts), the PDUs read (pdu.ts). ACARS inside goes out as the
 * same message lines ACARS and VDL2 use, so the aircraft cards come for free; everything else (squitters, logons,
 * position reports) as log lines and an 'hfdl' message. Receive only. No DOM.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { ChannelDecimator, ComplexFirDecimator, lowpassTaps } from '../ham/filters.js';
import { HFDL_CARRIER_HZ, HFDL_FS, HfdlRx, type HfdlBurst } from './phy.js';
import { HFDL_FREQS, acarsLine, hfdlSummary, parseHfdl, type HfdlPdu } from './pdu.js';

/** Most channels one span decodes (each costs a mixer at the full sample rate). */
const MAX_CHANNELS = 16;

/** Mixer then decimator, int8 units in, float out at rate / total (shared by the band and by each channel). */
class Stage {
  private cr = 1; private ci = 0; private readonly dr: number; private readonly di: number;
  private readonly chan: ChannelDecimator; private mixed = new Float32Array(0);
  readonly fs: number;
  constructor(offsetHz: number, rate: number, decim: number) {
    const w = -2 * Math.PI * offsetHz / rate; this.dr = Math.cos(w); this.di = Math.sin(w);
    this.chan = new ChannelDecimator(Math.max(1, decim)); this.fs = rate / this.chan.total;
  }
  run(x: ArrayLike<number>, n: number): { out: Float32Array; n: number } {
    if (this.mixed.length < 2 * n) this.mixed = new Float32Array(2 * n);
    let r = this.cr, s = this.ci; const m = this.mixed, dr = this.dr, di = this.di;
    for (let k = 0; k < n; k++) {
      const xi = x[2 * k], xq = x[2 * k + 1];
      m[2 * k] = xi * r - xq * s; m[2 * k + 1] = xi * s + xq * r;
      const t = r * dr - s * di; s = r * di + s * dr; r = t;
      if ((k & 1023) === 0) { const g = 1 / Math.sqrt(r * r + s * s); r *= g; s *= g; }
    }
    this.cr = r; this.ci = s;
    return this.chan.process(m, n);
  }
}

/** One frequency: its own stage down to about twice HFDL_FS, a 1.5 kHz low-pass, then HFDL_FS exactly. */
class HfdlChannel {
  private readonly st: Stage; private readonly lp: ComplexFirDecimator;
  private readonly step: number; private t = 0; private pr = 0; private pi = 0;
  private flt = new Float32Array(0); private out = new Float32Array(0);
  readonly rx = new HfdlRx();
  constructor(readonly dialHz: number, offsetHz: number, rate: number) {
    this.st = new Stage(offsetHz, rate, Math.floor(rate / (2 * HFDL_FS)));
    this.lp = new ComplexFirDecimator(lowpassTaps(1500 / this.st.fs, 63), 1);
    this.step = this.st.fs / HFDL_FS;
  }
  onIq(x: ArrayLike<number>, n: number): void {
    const d = this.st.run(x, n);
    if (this.flt.length < 2 * (d.n + 2)) this.flt = new Float32Array(2 * (d.n + 2));
    const c = this.lp.process(d.out, d.n, this.flt), z = this.flt;
    // to HFDL_FS exactly: linear interpolation (the signal is five times oversampled here)
    const want = Math.ceil(c / this.step) + 2;
    if (this.out.length < 2 * want) this.out = new Float32Array(2 * want);
    let o = 0, t = this.t;
    for (let k = 0; k < c; k++) {
      const xr = z[2 * k], xi = z[2 * k + 1];
      while (t < 1) { this.out[2 * o] = this.pr + (xr - this.pr) * t; this.out[2 * o + 1] = this.pi + (xi - this.pi) * t; o++; t += this.step; }
      t -= 1; this.pr = xr; this.pi = xi;
    }
    this.t = t;
    if (o) this.rx.push(this.out, o);
  }
}

export interface HfdlHeard { khz: number; burst: HfdlBurst; pdu: HfdlPdu | null }

export class HfdlDecoder implements IqProcessor {
  centerHz = 0;
  /** Every burst, read or not (tests and tools). */
  onHeard: ((h: HfdlHeard) => void) | null = null;
  /** Bursts sent on (after one heard on two channels is kept once), those whose CRC held, all heard. */
  bursts = 0; good = 0; heard = 0;
  private key = ''; private rx: HfdlChannel[] = []; private band: Stage | null = null;
  /** Bursts decoded during this buffer, sent once every channel has had it (one burst heard on two channels is sent once, from the stronger). */
  private pending: { hz: number; b: HfdlBurst }[] = [];
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; this.rx = []; this.band = null; this.pending = []; this.bursts = 0; this.good = 0; this.heard = 0; }
  channels(): number[] { return this.rx.map(r => r.dialHz); }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${rate}`;
    if (key !== this.key) {
      this.key = key;
      const reach = rate / 2 - 20_000;
      // the carrier is 1440 Hz above the dial; keep clear of the DC spike
      const want = HFDL_FREQS.filter(hz => Math.abs(hz + HFDL_CARRIER_HZ - this.centerHz) < reach && Math.abs(hz + HFDL_CARRIER_HZ - this.centerHz) > 8_000).slice(0, MAX_CHANNELS);
      // the band first, as one: mixed to its middle and decimated as far as its width allows (an FIR leaves the inner
      // third of its output rate clean), so each channel works at that lower rate
      const offs = want.map(hz => hz + HFDL_CARRIER_HZ - this.centerHz), mid = offs.length ? (Math.min(...offs) + Math.max(...offs)) / 2 : 0;
      const half = offs.length ? (Math.max(...offs) - Math.min(...offs)) / 2 + 6_000 : rate;
      this.band = new Stage(mid, rate, Math.floor(rate / (3 * half)));
      const fs1 = this.band.fs;
      this.rx = want.map((hz, i) => { const c = new HfdlChannel(hz, offs[i] - mid, fs1); c.rx.onBurst = b => { this.heard++; this.pending.push({ hz, b }); }; return c; });
      this.emit({ type: 'log', line: want.length ? `HFDL: decoding ${want.map(h => (h / 1e6).toFixed(3)).join(', ')} MHz` : `HFDL: no HFDL frequency within ${(rate / 2e6).toFixed(1)} MHz of ${(this.centerHz / 1e6).toFixed(3)} MHz` });
    }
    if (!this.band || !this.rx.length) return;
    const d = this.band.run(iq, iq.length >> 1);
    for (const r of this.rx) r.onIq(d.out, d.n);
    if (!this.pending.length) return;
    const got = this.pending; this.pending = [];
    const sig = (b: HfdlBurst) => Array.from(b.bytes.subarray(0, 96)).join(',');
    for (const p of got) if (!got.some(q => q !== p && sig(q.b) === sig(p.b) && (q.b.snrDb > p.b.snrDb || (q.b.snrDb === p.b.snrDb && q.hz < p.hz)))) this.burst(p.hz, p.b);
  }
  private burst(hz: number, b: HfdlBurst): void {
    this.bursts++;
    const khz = Math.round(hz / 1000), pdu = parseHfdl(b.bytes);
    this.onHeard?.({ khz, burst: b, pdu });
    const tail = `${b.bps} bps ${b.slot} · ${b.snrDb >= 0 ? '+' : ''}${b.snrDb} dB · ${b.cfoHz >= 0 ? '+' : ''}${b.cfoHz} Hz`;
    if (!pdu) { this.emit({ type: 'log', line: `HFDL ${(khz / 1000).toFixed(3)}: a ${tail} burst failed its CRC` }); return; }
    this.good++;
    for (const l of pdu.lpdus) if (l.acars) this.emit({ type: 'packet', line: acarsLine(l.acars, khz) });
    this.emit({ type: 'log', line: `${hfdlSummary(pdu, khz)} · ${tail}` });
    this.emit({ type: 'hfdl', khz, snrDb: b.snrDb, bps: b.bps, pdu });
  }
}
