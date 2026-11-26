/**
 * FORK: a recording played as if it were a radio. It implements the same [Radio] interface as the HackRF and RTL-SDR
 * drivers and feeds the same worker message (`{type:'iq', buf}`, signed int8 I,Q), so every app and decoder works
 * on it unchanged.
 *
 * Pacing: `speed` 1 is real time (the waterfall and audio run as they did on the air); 2, 4, 8 … run faster; Infinity
 * runs as fast as the decoders keep up. Either way at most [IN_FLIGHT] buffers are queued at the worker: it answers
 * each `ack: true` buffer with `{type:'iqAck'}` once processed, so a slow decoder slows playback instead of
 * piling up memory.
 *
 * Tuning: the player is a radio fixed at the recording's centre with a digital LO. When an app tunes anywhere inside
 * the recorded span (Ships and Ham Map park their LO 250 kHz off the channel, Audio tunes around), the samples are
 * shifted by (recording centre - requested LO), so the decoder finds the signal where a live radio would have put it.
 * Outside the span, and for the sample rate, the recording plays as recorded and the player says so once.
 */
import type { Radio, RadioCaps, RadioLimits } from './radio.js';
import { BYTES_PER_SAMPLE, toInt8Iq } from './filesrc/formats.js';
import type { IqSource } from './filesrc/open.js';

/** What the player needs from the DSP worker (a real Worker, or a stand-in in tests). */
export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

export interface FileRadioEvents {
  onLog: (line: string) => void;
  onStatus: (line: string) => void;
}

/** Buffers allowed at the worker before the player waits for an ack. */
export const IN_FLIGHT = 3;
/** After this long without an ack, carry on anyway (an older worker that does not ack must not hang playback). */
const ACK_GIVE_UP_MS = 2000;
export const SPEEDS = [1, 2, 4, 8, Infinity];

const NO_CAPS: RadioCaps = { stagedGain: false, tunerGain: false, amp: false, biasT: false, biasVolts: 0, tunerAgc: false, rtlAgc: false, ppm: false, directSampling: false, bbFilters: [] };

export const speedLabel = (s: number) => (s === Infinity ? 'MAX' : `${s}×`);

export class FileRadio implements Radio {
  readonly kind = 'file' as const;
  readonly caps = NO_CAPS;
  readonly limits: RadioLimits;
  running = false;
  /** Playback speed: 1 = real time, Infinity = as fast as the worker keeps up. */
  speed = 1;
  loop = false;
  paused = false;
  /** Read position in complex samples. */
  position = 0;
  /** Buffers sent, for tests and the status line. */
  sent = 0;

  private freqAsked = 0;
  /** Digital LO: the shift applied to every sample (Hz), and its running phase. */
  mixHz = 0;
  private mixPhase = 0;
  private rateAsked = 0;
  private inFlight = 0;
  private wake: (() => void) | null = null;
  private stopWanted = false;
  private noAckWarned = false;
  private readonly onMessage = (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type !== 'iqAck') return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.poke();
  };

  constructor(readonly src: IqSource, private readonly worker: WorkerLike, private readonly ev: FileRadioEvents) {
    const r = src.meta.rate;
    this.limits = { minHz: 0, maxHz: 7_250_000_000, rates: [[r, r]], canTransmit: false, cleanRate: r };
  }

  get label(): string { return `File · ${this.src.name}`; }
  get rate(): number { return this.src.meta.rate; }
  get centerHz(): number { return this.src.meta.centerHz; }

  /** Apps set these; a recording keeps its own. Said once per new value, so the log is not flooded. */
  get targetFreqHz(): number { return this.centerHz ? this.centerHz - this.mixHz : 0; }
  set targetFreqHz(hz: number) {
    if (!hz || hz === this.freqAsked) return;
    this.freqAsked = hz;
    if (!this.centerHz) return;
    const shift = this.centerHz - hz;
    if (Math.abs(shift) < this.rate / 2) { this.mixHz = shift; return; }
    this.mixHz = 0;
    this.ev.onLog(`recording: this app tunes ${(hz / 1e6).toFixed(3)} MHz but ${this.src.name} was recorded at ${(this.centerHz / 1e6).toFixed(3)} MHz ±${(this.rate / 2e6).toFixed(2)} MHz; it plays as recorded`);
  }
  get targetRateHz(): number { return this.rate; }
  set targetRateHz(hz: number) {
    if (!hz || hz === this.rateAsked) return;
    this.rateAsked = hz;
    if (Math.abs(hz - this.rate) > 1) this.ev.onLog(`recording: this app would sample at ${(hz / 1e6).toFixed(3)} Msps; the recording is ${(this.rate / 1e6).toFixed(3)} Msps and plays at that`);
  }
  setGain(): void { /* a recording's level is what was recorded */ }

  async open(): Promise<void> {
    const m = this.src.meta;
    this.ev.onLog(`recording: ${this.src.name} · ${m.format}${m.bigEndian ? ' (big-endian)' : ''} · ${(m.rate / 1e6).toFixed(3)} Msps · ${m.centerHz ? (m.centerHz / 1e6).toFixed(4) + ' MHz' : 'centre unknown'} · ${(this.src.samples / m.rate).toFixed(1)} s${m.datetime ? ' · ' + m.datetime : ''}`);
    for (const n of m.notes) this.ev.onLog(`recording: ${n}`);
    if (m.format === 'cs16' || m.format === 'cf32') this.ev.onLog(`recording: ${m.format} scaled ×${this.src.scale.toPrecision(3)} to 8-bit, as a radio would deliver it`);
    this.worker.addEventListener('message', this.onMessage);
  }

  /** Samples per buffer: about 30 per second of recording, like the radios' own transfers. */
  get chunkSamples(): number { return Math.max(4096, Math.min(131072, Math.round(this.rate / 30))); }

  /** Play until the end (or stop()). Resolves when playback is over, as the radio drivers' run() does. */
  async run(): Promise<void> {
    this.running = true; this.stopWanted = false;
    const m = this.src.meta, bps = BYTES_PER_SAMPLE[m.format];
    let t0 = now(), p0 = this.position, speed0 = this.speed, lastStatus = 0;
    try {
      while (!this.stopWanted) {
        if (this.paused) { await this.waitFor(250); t0 = now(); p0 = this.position; continue; }
        if (this.position >= this.src.samples) {
          if (!this.loop) break;
          this.position = 0; t0 = now(); p0 = 0;
          this.ev.onLog(`recording: looped ${this.src.name}`);
        }
        if (this.speed !== speed0) { speed0 = this.speed; t0 = now(); p0 = this.position; }
        // back-pressure: the worker acks each buffer once it has run the decoders on it
        const waitStart = now();
        while (this.inFlight >= IN_FLIGHT && !this.stopWanted) {
          await this.waitFor(ACK_GIVE_UP_MS);
          if (this.inFlight >= IN_FLIGHT && now() - waitStart >= ACK_GIVE_UP_MS) {
            if (!this.noAckWarned) { this.noAckWarned = true; this.ev.onLog('recording: the DSP worker is not acknowledging buffers; pacing by time only'); }
            this.inFlight = 0;
          }
        }
        if (this.stopWanted) break;
        // real-time (or N×) pacing against the wall clock
        if (Number.isFinite(this.speed)) {
          const due = t0 + ((this.position - p0) / this.rate / this.speed) * 1000;
          // loop: an ack (or a speed change) wakes the sleep early, and that must not send a buffer early
          for (let wait = due - now(); wait > 1 && !this.stopWanted && this.speed === speed0 && !this.paused; wait = due - now()) await this.waitFor(wait);
          if (this.stopWanted) break;
          if (this.speed !== speed0 || this.paused) continue;
        }
        const n = Math.min(this.chunkSamples, this.src.samples - this.position);
        const start = m.dataOffset + this.position * bps;
        const raw = new Uint8Array(await this.src.data.slice(start, start + n * bps).arrayBuffer());
        const iq = toInt8Iq(raw, m.format, m.bigEndian, this.src.scale);
        if (this.mixHz) this.mix(iq);
        this.position += n; this.sent++; this.inFlight++;
        this.worker.postMessage({ type: 'iq', buf: iq.buffer, ack: true }, [iq.buffer]);
        if (now() - lastStatus > 500) { lastStatus = now(); this.ev.onStatus(this.statusLine()); }
        // as-fast-as-possible still yields, so the page stays responsive
        if (!Number.isFinite(this.speed)) await this.waitFor(0);
      }
    } finally {
      this.running = false;
      this.worker.removeEventListener('message', this.onMessage);
      this.ev.onStatus(this.position >= this.src.samples ? `${this.src.name} · end of recording` : `${this.src.name} · stopped`);
    }
  }

  stop(): void { this.stopWanted = true; this.poke(); }

  /** Move to a fraction (0-1) of the recording. */
  seek(fraction: number): void {
    this.position = Math.max(0, Math.min(this.src.samples, Math.round(fraction * this.src.samples)));
    this.poke();
  }

  /** Next speed in [SPEEDS]; returns it. */
  cycleSpeed(): number { this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length]; this.poke(); return this.speed; }

  statusLine(): string {
    const pct = this.src.samples ? Math.floor(100 * this.position / this.src.samples) : 100;
    const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `${this.src.name} · ${this.centerHz ? (this.centerHz / 1e6).toFixed(3) + ' MHz · ' : ''}${(this.rate / 1e6).toFixed(2)} Msps · ${secs(this.position / this.rate)} / ${secs(this.src.samples / this.rate)} (${pct}%) · ${this.paused ? 'paused' : speedLabel(this.speed)}`;
  }

  /** Rotate int8 IQ in place by mixHz (phase-continuous across buffers). */
  private mix(iq: Int8Array): void {
    const w = 2 * Math.PI * this.mixHz / this.rate, n = iq.length >> 1;
    let c = Math.cos(this.mixPhase), s = Math.sin(this.mixPhase);
    const cw = Math.cos(w), sw = Math.sin(w);
    for (let i = 0; i < n; i++) {
      const a = iq[2 * i], b = iq[2 * i + 1];
      const re = a * c - b * s, im = a * s + b * c;
      iq[2 * i] = re > 127 ? 127 : re < -127 ? -127 : Math.round(re);
      iq[2 * i + 1] = im > 127 ? 127 : im < -127 ? -127 : Math.round(im);
      const c2 = c * cw - s * sw; s = c * sw + s * cw; c = c2;
    }
    this.mixPhase = (this.mixPhase + w * n) % (2 * Math.PI);
  }

  private poke(): void { const w = this.wake; this.wake = null; w?.(); }
  private waitFor(ms: number): Promise<void> {
    return new Promise(res => {
      const t = setTimeout(() => { if (this.wake === done) this.wake = null; res(); }, ms);
      const done = () => { clearTimeout(t); res(); };
      this.wake = done;
    });
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
