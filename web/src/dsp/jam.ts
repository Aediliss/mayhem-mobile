/**
 * FORK: jamming detection, receive only. Our own design (no code ported). A jammer is a transmitter that stays on:
 * the security bands it targets (319.5 MHz Interlogix / GE / 2GIG, 345 MHz Honeywell 5800, 433.92 MHz, 902-928 MHz
 * alarm and IoT radios, GPS L1 at 1575.42 MHz) otherwise carry short bursts — a sensor's packet, a key fob — and
 * noise. Three kinds are told apart against a baseline the detector learns first (10 s by default):
 *   - BARRAGE: the noise floor (the median of the spectrum) sustained well above its learned level (wideband noise);
 *   - CARRIER: one narrow carrier far above the floor, at the same frequency, sustained (CW, or a stuck transmitter);
 *     carriers already there while learning (a site's own beacons, a birdie) are left alone;
 *   - SWEEP: a narrow signal that is in a different place each moment but covers much of the band within a second
 *     (the chirp of a cheap jammer).
 * A legitimate burst lasts well under a second and never qualifies. Each one opens an alert when sustained (2-4 s) and
 * closes it after 2 s without it. Time is the sample clock, so a recording gives the same answers as live.
 */
import { fft } from '../fft.js';
import type { Emit, IqProcessor } from './core.js';

export type JamKind = 'barrage' | 'carrier' | 'sweep';
export interface JamAlert { id: number; kind: JamKind; startS: number; endS: number | null; hz: number; riseDb: number; peakDb: number; spanHz?: [number, number] }
export interface JamStatus { learning: boolean; learnLeftS: number; floorDb: number; baseDb: number; riseDb: number; carrierDb: number; sweepPct: number; active: JamKind[]; spectrum: number[] }

const N = 1024, FRAMES = 16, TICK_S = 0.1, BUCKETS = 64;
const HOLD: Record<JamKind, number> = { barrage: 2, carrier: 4, sweep: 2 };   // seconds sustained before an alert
const GRACE_S = 2;

export class JamDetector {
  /** dB the floor must rise; dB a carrier must stand over the floor; share of the band a sweep must cover in a second. */
  riseDb = 8; carrierDb = 20; sweepShare = 0.3; learnS = 10;
  onAlert: (a: JamAlert) => void = () => {};
  onStatus: (s: JamStatus) => void = () => {};
  private rate = 0; private centreHz = 0;
  private readonly win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N));
  private readonly re = new Float32Array(N); private readonly im = new Float32Array(N);
  private readonly acc = new Float64Array(N); private frames = 0; private every = N; private pos = 0;
  private samples = 0; private ticks = 0;
  private valid = new Uint8Array(N); private known = new Uint8Array(N); private learnSum = new Float64Array(N); private learnFloors: number[] = [];
  private baseDb = NaN;
  private run: Record<JamKind, number> = { barrage: 0, carrier: 0, sweep: 0 };
  private quiet: Record<JamKind, number> = { barrage: 0, carrier: 0, sweep: 0 };
  private open: Partial<Record<JamKind, JamAlert>> = {};
  private nextId = 1;
  private carrierBin = -1;
  /** Each frame's strongest narrow signal's bucket (-1: none) over the last second: a sweep is narrow at each moment. */
  private hits: number[] = [];

  /** [rate]: samples a second; [centreHz]: the tuned frequency (for the alerts' frequencies). */
  reset(rate: number, centreHz = this.centreHz): void {
    this.rate = rate; this.centreHz = centreHz;
    this.every = Math.max(N, Math.floor(rate * TICK_S / FRAMES));
    this.acc.fill(0); this.frames = 0; this.pos = 0; this.samples = 0; this.ticks = 0;
    // bins used: not the 5 % at each edge (the filter's roll-off) nor the centre (the radio's DC spike)
    const edge = Math.ceil(N * 0.05), dc = Math.max(2, Math.ceil(N * 0.004));
    for (let k = 0; k < N; k++) this.valid[k] = k >= edge && k < N - edge && Math.abs(k - N / 2) > dc ? 1 : 0;
    this.known.fill(0); this.learnSum.fill(0); this.learnFloors = []; this.baseDb = NaN;
    for (const k of ['barrage', 'carrier', 'sweep'] as JamKind[]) { this.run[k] = 0; this.quiet[k] = 0; }
    for (const a of Object.values(this.open)) if (a) { a.endS = this.timeS(); this.onAlert({ ...a }); }
    this.open = {}; this.carrierBin = -1; this.hits = [];
  }
  /** The learned baseline, to keep while another band is watched (SCAN ALL), or null while still learning. */
  snapshot(): { baseDb: number; known: Uint8Array; rate: number } | null { return Number.isFinite(this.baseDb) ? { baseDb: this.baseDb, known: this.known.slice(), rate: this.rate } : null; }
  /** Back on a band already learned at this rate: watch at once instead of learning again. */
  restore(b: { baseDb: number; known: Uint8Array; rate: number }): void {
    if (b.rate !== this.rate) return;
    this.baseDb = b.baseDb; this.known.set(b.known); this.ticks = Math.ceil(this.learnS / TICK_S) + 1;
  }
  /** Seconds of signal so far (the sample clock). */
  timeS(): number { return this.samples / (this.rate || 1); }
  /** Bin [k] (after the shift) → Hz. */
  hzOf(k: number): number { return this.centreHz + (k - N / 2) * this.rate / N; }

  /** Complex samples: interleaved I, Q (any scale). */
  push(iq: ArrayLike<number>, n = iq.length >> 1): void {
    for (let i = 0; i < n; i++) {
      this.samples++;
      if (this.pos < N) { this.re[this.pos] = iq[2 * i] * this.win[this.pos]; this.im[this.pos] = iq[2 * i + 1] * this.win[this.pos]; }
      if (++this.pos === N) this.frame();
      if (this.pos >= this.every) this.pos = 0;
    }
  }

  private frame(): void {
    fft(this.re, this.im);
    let sum = 0, nv = 0, pk = -1, pv = 0;
    for (let k = 0; k < N; k++) {
      const j = (k + N / 2) % N, p = this.re[j] * this.re[j] + this.im[j] * this.im[j]; this.acc[k] += p;
      if (this.valid[k]) { sum += p; nv++; if (!this.known[k] && p > pv) { pv = p; pk = k; } }
    }
    // narrow at this moment: the peak far above the frame's mean (noise alone: the largest of ~900 bins, under 10×)
    if (nv) this.hits.push(pk >= 0 && pv > 30 * sum / nv ? Math.floor(pk * BUCKETS / N) : -1);
    if (this.hits.length > FRAMES / TICK_S) this.hits.shift();
    if (++this.frames >= FRAMES) { this.tick(); this.acc.fill(0); this.frames = 0; }
  }

  private tick(): void {
    this.ticks++;
    const db = new Float32Array(N), vals: number[] = [];
    for (let k = 0; k < N; k++) { db[k] = 10 * Math.log10(this.acc[k] / this.frames + 1e-20); if (this.valid[k]) vals.push(db[k]); }
    vals.sort((a, b) => a - b);
    const floor = vals[vals.length >> 1], t = this.timeS();
    const learning = this.ticks * TICK_S <= this.learnS;
    if (learning) {
      this.learnFloors.push(floor); for (let k = 0; k < N; k++) this.learnSum[k] += db[k];
      if (this.ticks * TICK_S + 1e-9 >= this.learnS) {   // the baseline: the median floor; bins persistently strong are known
        const f = [...this.learnFloors].sort((a, b) => a - b); this.baseDb = f[f.length >> 1];
        for (let k = 0; k < N; k++) { const m = this.learnSum[k] / this.learnFloors.length; if (m > this.baseDb + 10) for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < N) this.known[j] = 1; }
      }
      this.status(floor, 0, 0, 0, db, true);
      return;
    }
    const rise = floor - this.baseDb;
    // the strongest narrow signal not already known, against the floor of the moment
    let pk = -1, pv = -1e9; for (let k = 0; k < N; k++) if (this.valid[k] && !this.known[k] && db[k] > pv) { pv = db[k]; pk = k; }
    const over = pv - floor;
    const used = new Set(this.hits.filter(h => h >= 0)), validBuckets = Math.round(BUCKETS * 0.9);
    // the share of the band it reached: the buckets hit, or (frames are a fixed time apart and can alias with a sweep's
    // period, landing on the same few places each pass) the span between the lowest and highest once ten or more differ
    const share = used.size >= 10 ? Math.max(used.size, Math.max(...used) - Math.min(...used) + 1) / validBuckets : used.size / validBuckets;
    // a carrier stays put: within a few bins of where it was
    const steady = over >= this.carrierDb && (this.carrierBin < 0 || Math.abs(pk - this.carrierBin) <= 3);
    const now: Record<JamKind, boolean> = {
      sweep: share >= this.sweepShare && this.hits.length >= FRAMES / TICK_S * 0.9 && this.hits.filter(h => h >= 0).length >= this.hits.length * 0.7,
      barrage: false, carrier: false,
    };
    now.barrage = rise >= this.riseDb && !now.sweep;   // a sweep spread over a tick also lifts the floor: it is a sweep
    now.carrier = steady && !now.sweep;
    if (now.carrier) this.carrierBin = pk; else if (!this.open.carrier) this.carrierBin = -1;
    // the baseline follows slow change (temperature, a band getting busier) only while nothing is happening
    if (!now.barrage && !this.open.barrage && Math.abs(rise) < 3) this.baseDb += 0.002 * rise;
    for (const k of ['barrage', 'carrier', 'sweep'] as JamKind[]) {
      if (now[k]) { this.run[k] += TICK_S; this.quiet[k] = 0; } else { this.run[k] = 0; this.quiet[k] += TICK_S; }
      const a = this.open[k];
      if (!a && this.run[k] + 1e-9 >= HOLD[k]) {
        const al: JamAlert = { id: this.nextId++, kind: k, startS: t - this.run[k], endS: null, hz: k === 'barrage' ? this.centreHz : this.hzOf(pk), riseDb: Math.round(rise * 10) / 10, peakDb: Math.round(over * 10) / 10 };
        if (k === 'sweep') { const b = [...used]; al.spanHz = [this.hzOf(Math.min(...b) * N / BUCKETS), this.hzOf((Math.max(...b) + 1) * N / BUCKETS)]; }
        this.open[k] = al; this.onAlert({ ...al });
      } else if (a) {
        if (now[k]) { a.riseDb = Math.max(a.riseDb, Math.round(rise * 10) / 10); a.peakDb = Math.max(a.peakDb, Math.round(over * 10) / 10); }
        if (this.quiet[k] + 1e-9 >= GRACE_S) { a.endS = t - this.quiet[k]; this.onAlert({ ...a }); delete this.open[k]; }
      }
    }
    this.status(floor, rise, over, share, db, false);
  }

  private status(floor: number, rise: number, over: number, share: number, db: Float32Array, learning: boolean): void {
    if (this.ticks % 3) return;   // ~3 a second
    const spec: number[] = []; for (let i = 0; i < 128; i++) { let m = -1e9; for (let k = i * 8; k < i * 8 + 8; k++) if (db[k] > m) m = db[k]; spec.push(Math.round(m * 10) / 10); }
    this.onStatus({ learning, learnLeftS: Math.max(0, this.learnS - this.ticks * TICK_S), floorDb: Math.round(floor * 10) / 10, baseDb: Math.round((Number.isFinite(this.baseDb) ? this.baseDb : floor) * 10) / 10,
      riseDb: Math.round(rise * 10) / 10, carrierDb: Math.round(over * 10) / 10, sweepPct: Math.round(share * 100), active: (Object.keys(this.open) as JamKind[]), spectrum: spec });
  }
}

/** The worker's processor: int8 IQ → the detector → 'jam' status, 'jamAlert' and a log line for each alert. */
export class JamProcessor implements IqProcessor {
  readonly det = new JamDetector();
  centerHz = 0; band = '';
  private rate = 0;
  /** Each band's learned baseline, so SCAN ALL does not learn again on every visit. */
  private readonly learned = new Map<string, NonNullable<ReturnType<JamDetector['snapshot']>>>();
  constructor(private readonly emit: Emit) {
    this.det.onAlert = a => {
      this.emit({ type: 'jamAlert', band: this.band, alert: a });
      this.emit({ type: 'packet', line: jamLine(this.band, a) });
    };
    this.det.onStatus = s => this.emit({ type: 'jam', band: this.band, ...s });
  }
  private key(): string { return `${this.band}@${this.centerHz}`; }
  private save(): void { const s = this.det.snapshot(); if (s && this.band) this.learned.set(this.key(), s); }
  private apply(): void { this.det.reset(this.rate, this.centerHz); const b = this.learned.get(this.key()); if (b) this.det.restore(b); }
  reset(rate: number): void { this.save(); this.rate = rate; if (rate) this.apply(); }
  /** A band (and its tuning): its baseline if learned before, else learn. */
  retune(centerHz: number, band: string): void { this.save(); this.centerHz = centerHz; this.band = band; if (this.rate) this.apply(); }
  /** Forget every band's baseline (CLEAR). */
  clear(): void { this.forget(); }
  forget(): void { this.learned.clear(); if (this.rate) this.det.reset(this.rate, this.centerHz); }
  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    this.det.push(iq, iq.length >> 1);
  }
}

const KIND_TEXT: Record<JamKind, string> = { barrage: 'BARRAGE (noise floor up)', carrier: 'CARRIER (steady signal)', sweep: 'SWEEP (swept signal)' };
/** The log line for an alert opening (endS null) or closing. */
export function jamLine(band: string, a: JamAlert): string {
  const mhz = (h: number) => (h / 1e6).toFixed(3);
  const where = a.kind === 'sweep' && a.spanHz ? `${mhz(a.spanHz[0])}–${mhz(a.spanHz[1])} MHz` : a.kind === 'barrage' ? `${band || mhz(a.hz) + ' MHz'}` : `${mhz(a.hz)} MHz`;
  const level = a.kind === 'barrage' ? `floor +${a.riseDb.toFixed(0)} dB` : `${a.peakDb.toFixed(0)} dB over the floor`;
  return a.endS === null ? `JAMMING ${KIND_TEXT[a.kind]} · ${where} · ${level}` : `jamming ended: ${a.kind} · ${where} · lasted ${(a.endS - a.startS).toFixed(0)} s · ${level}`;
}
