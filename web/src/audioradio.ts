/**
 * FORK: audio in, as a radio. Audio from a microphone, a line-in (another radio's discriminator or speaker output, a
 * virtual audio cable) or an audio file is modulated onto IQ (audiosrc/audio2iq.ts) at the channel and in the way the
 * open app's demodulator expects, then sent down the same `{type:'iq'}` path a radio uses. No decoder knows.
 *
 * What it suits: anything decoded from audio — FT8 / RTTY / PSK / SSTV / CW (USB), APRS, POCSAG / FLEX, SAME (FM),
 * ACARS (AM). A discriminator ("9600 baud" / flat) output is best for packet and pagers; a speaker output is
 * de-emphasised and band-limited, which upsets 9600-baud and FLEX 3200. Wideband apps (ADS-B, BLE, LoRa, TV …) have
 * nothing to gain: their signals never were audio.
 */
import type { Radio, RadioCaps, RadioLimits } from './radio.js';
import { AudioToIq, modForMode } from './audiosrc/audio2iq.js';
import type { FileRadioEvents, WorkerLike } from './fileradio.js';

/** What the page tells the source before each block: the app's demodulator mode and its channel frequency. */
export interface AudioHooks { mode(): string; channelHz(): number }

export type AudioSource =
  | { kind: 'live'; ctx: AudioContext; stream: MediaStream; label: string }
  | { kind: 'file'; buffer: AudioBuffer; name: string };

const NO_CAPS: RadioCaps = { stagedGain: false, tunerGain: false, amp: false, biasT: false, biasVolts: 0, tunerAgc: false, rtlAgc: false, ppm: false, directSampling: false, bbFilters: [] };
const IN_FLIGHT = 3;

/** One channel of mono audio from any number of channels (averaged). */
export function mixDown(b: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }): Float32Array {
  if (b.numberOfChannels === 1) return b.getChannelData(0);
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += d[i] / b.numberOfChannels; }
  return out;
}

export class AudioRadio implements Radio {
  readonly kind = 'audio' as const;
  readonly caps = NO_CAPS;
  readonly limits: RadioLimits = { minHz: 0, maxHz: 7_250_000_000, rates: [[240_000, 2_400_000]], canTransmit: false, cleanRate: 2_000_000 };
  targetFreqHz = 0;
  targetRateHz = 2_000_000;
  running = false;
  /** Files only: 1 = real time, Infinity = as fast as the decoders keep up. */
  speed = 1;
  paused = false;
  /** Files only: position in audio samples. */
  position = 0;

  private conv: AudioToIq | null = null;
  private node: AudioWorkletNode | null = null;
  private stopWanted = false;
  private wake: (() => void) | null = null;
  private inFlight = 0;
  private readonly mono: Float32Array | null;
  private readonly onMessage = (e: MessageEvent) => { if ((e.data as { type?: string } | null)?.type === 'iqAck') { this.inFlight = Math.max(0, this.inFlight - 1); this.poke(); } };

  constructor(readonly src: AudioSource, private readonly worker: WorkerLike, private readonly ev: FileRadioEvents, private readonly hooks: AudioHooks) {
    this.mono = src.kind === 'file' ? mixDown(src.buffer) : null;
  }

  get label(): string { return labelOf(this.src); }
  get audioRate(): number { return this.src.kind === 'file' ? this.src.buffer.sampleRate : this.src.ctx.sampleRate; }
  get durationS(): number { return this.mono ? this.mono.length / this.audioRate : Infinity; }
  setGain(): void { /* the level is the audio's; the converter levels it */ }

  /** The converter, re-aimed at the app's current mode, channel and rate. */
  private converter(): AudioToIq {
    const { mod, devHz } = modForMode(this.hooks.mode());
    const offsetHz = this.targetFreqHz ? this.hooks.channelHz() - this.targetFreqHz : 0;
    const rate = this.targetRateHz;
    if (!this.conv || this.conv.options.rate !== rate) this.conv = new AudioToIq({ mod, devHz, rate, offsetHz });
    else this.conv.set({ mod, devHz, offsetHz });
    return this.conv;
  }

  private send(audio: Float32Array): void {
    const iq = this.converter().push(audio, this.audioRate);
    if (!iq.length) return;
    const copy = iq.slice();                                  // a buffer of its own to transfer
    this.inFlight++;
    this.worker.postMessage({ type: 'iq', buf: copy.buffer, ack: true }, [copy.buffer]);
  }

  async open(): Promise<void> {
    this.worker.addEventListener('message', this.onMessage);
    const { mod } = modForMode(this.hooks.mode());
    this.ev.onLog(`audio in: ${this.label} · ${this.audioRate} Hz${this.mono ? ` · ${this.durationS.toFixed(1)} s` : ''} · modulated ${mod.toUpperCase()} for this app (follows the app's mode)`);
    if (this.src.kind === 'live') {
      const { ctx, stream } = this.src;
      await ctx.audioWorklet.addModule('./mic-worklet.js');
      const node = new AudioWorkletNode(ctx, 'mayhem-mic', { numberOfOutputs: 0 });
      // live audio arrives in 128-sample blocks; gather ~20 ms so the worker gets buffers, not crumbs
      let acc = new Float32Array(0);
      node.port.onmessage = e => {
        if (this.paused || this.stopWanted) return;
        const a = e.data as Float32Array, n = new Float32Array(acc.length + a.length); n.set(acc); n.set(a, acc.length); acc = n;
        if (acc.length >= this.audioRate / 50) { this.inFlight = 0; this.send(acc); acc = new Float32Array(0); }   // live: real time by nature
      };
      ctx.createMediaStreamSource(stream).connect(node);
      this.node = node;
    }
  }

  async run(): Promise<void> {
    this.running = true; this.stopWanted = false;
    let lastStatus = 0;
    try {
      if (this.src.kind === 'live') {
        while (!this.stopWanted) { await this.waitFor(500); if (performance.now() - lastStatus > 1000) { lastStatus = performance.now(); this.ev.onStatus(this.statusLine()); } }
        return;
      }
      const mono = this.mono!, rate = this.audioRate, block = Math.round(rate / 20);   // 50 ms of audio per buffer
      let t0 = performance.now(), p0 = this.position, s0 = this.speed;
      while (!this.stopWanted && this.position < mono.length) {
        if (this.paused) { await this.waitFor(250); t0 = performance.now(); p0 = this.position; continue; }
        if (this.speed !== s0) { s0 = this.speed; t0 = performance.now(); p0 = this.position; }
        while (this.inFlight >= IN_FLIGHT && !this.stopWanted) await this.waitFor(2000).then(() => { if (this.inFlight >= IN_FLIGHT) this.inFlight = 0; });
        if (Number.isFinite(this.speed)) {
          const due = t0 + ((this.position - p0) / rate / this.speed) * 1000;
          for (let w = due - performance.now(); w > 1 && !this.stopWanted && !this.paused && this.speed === s0; w = due - performance.now()) await this.waitFor(w);
          if (this.stopWanted || this.paused || this.speed !== s0) continue;
        }
        const end = Math.min(mono.length, this.position + block);
        this.send(mono.subarray(this.position, end)); this.position = end;
        if (performance.now() - lastStatus > 500) { lastStatus = performance.now(); this.ev.onStatus(this.statusLine()); }
        if (!Number.isFinite(this.speed)) await this.waitFor(0);
      }
      const drain = performance.now();
      while (this.inFlight > 0 && !this.stopWanted && performance.now() - drain < 2000) await this.waitFor(100);
    } finally {
      this.running = false;
      this.node?.disconnect(); this.node = null;
      if (this.src.kind === 'live') for (const t of this.src.stream.getTracks()) t.stop();
      this.worker.removeEventListener('message', this.onMessage);
      this.ev.onStatus(`${this.label} · ${this.mono && this.position >= this.mono.length ? 'end of audio' : 'stopped'}`);
    }
  }

  stop(): void { this.stopWanted = true; this.poke(); }
  cycleSpeed(): number { this.speed = this.speed === 1 ? 4 : this.speed === 4 ? Infinity : 1; this.poke(); return this.speed; }

  statusLine(): string {
    const { mod } = modForMode(this.hooks.mode());
    if (!this.mono) return `${this.label} · live · ${mod.toUpperCase()}${this.paused ? ' · paused' : ''}`;
    const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `${this.label} · ${secs(this.position / this.audioRate)} / ${secs(this.durationS)} · ${mod.toUpperCase()} · ${this.paused ? 'paused' : this.speed === Infinity ? 'MAX' : `${this.speed}×`}`;
  }

  private poke(): void { const w = this.wake; this.wake = null; w?.(); }
  private waitFor(ms: number): Promise<void> {
    return new Promise(res => { const t = setTimeout(() => { if (this.wake === done) this.wake = null; res(); }, ms); const done = () => { clearTimeout(t); res(); }; this.wake = done; });
  }
}

const labelOf = (s: AudioSource) => (s.kind === 'live' ? `Audio in · ${s.label}` : `Audio file · ${s.name}`);
