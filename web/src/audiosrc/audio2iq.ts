/**
 * FORK: audio → IQ, so audio from a microphone, a line-in, another radio's discriminator output or an audio file can
 * feed any app as if a radio had received it. The audio is modulated back onto a carrier the way the app's own
 * demodulator expects, at the app's channel inside its span:
 *
 *   fm   NFM apps and the packet / pager decoders (APRS, AIS, POCSAG / FLEX, SAME): frequency = devHz × audio
 *   am   ACARS and AM listening: (1 + 0.8 × audio)
 *   usb  SSB, CW and the HF digital modes (FT8, RTTY, PSK, SSTV): the audio's analytic signal, upper sideband
 *   lsb  the same, lower sideband
 *
 * The decoders then run on it unchanged. Pure code (no DOM), tested in Node.
 */

export type AudioMod = 'fm' | 'am' | 'usb' | 'lsb';

/** Odd-length Hilbert transformer, Blackman-windowed: h[n] = 2/(πn) for odd n, 0 for even n. */
export function hilbertTaps(n = 127): Float32Array {
  const h = new Float32Array(n), mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const k = i - mid;
    if (k % 2 === 0) continue;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = (2 / (Math.PI * k)) * w;
  }
  return h;
}

export interface AudioToIqOptions {
  mod: AudioMod;
  /** IQ sample rate to produce. */
  rate: number;
  /** Where the signal sits from the span centre (the app's channel minus its LO), Hz. */
  offsetHz?: number;
  /** FM deviation for full-scale audio, Hz (NFM ~3 kHz; WFM 75 kHz). */
  devHz?: number;
}

/**
 * Stateful converter: push() audio blocks at the audio rate, get int8 IQ blocks at `rate` back, continuous across
 * calls. Audio is levelled by a slow peak follower so a quiet line-in and a hot one decode alike, without lifting
 * silence into noise (the follower never drops below FLOOR).
 */
export class AudioToIq {
  private o: Required<AudioToIqOptions>;
  private readonly hil = hilbertTaps();
  private readonly hist = new Float32Array(127);
  private hi = 0;
  /** Last two levelled audio samples (and their Hilbert pair) for interpolation. */
  private a0 = 0; private a1 = 0; private q0 = 0; private q1 = 0;
  /** Output position in audio samples (fractional), relative to a1. */
  private frac = 0;
  private fmPh = 0;
  private ncoR = 1; private ncoI = 0;
  private peak = 0.05;
  private static readonly FLOOR = 0.02;

  constructor(o: AudioToIqOptions) { this.o = { offsetHz: 0, devHz: 3000, ...o }; }

  set(o: Partial<AudioToIqOptions>): void { this.o = { ...this.o, ...o }; }
  get options(): Readonly<Required<AudioToIqOptions>> { return this.o; }

  /** Audio in (any length, at `audioRate`) → int8 I,Q out. */
  push(audio: Float32Array, audioRate: number): Int8Array {
    const { rate, mod, devHz, offsetHz } = this.o;
    const step = audioRate / rate;                            // audio samples per IQ sample
    const cap = Math.ceil(audio.length / step) + 2;          // an upper bound; exactly what was made is returned
    const out = new Int8Array(2 * cap);
    const dPh = 2 * Math.PI * devHz / rate;
    const wOff = 2 * Math.PI * offsetHz / rate, cw = Math.cos(wOff), sw = Math.sin(wOff);
    const ssb = mod === 'usb' || mod === 'lsb', sgn = mod === 'lsb' ? -1 : 1;
    const H = this.hil, N = H.length, D = (N - 1) >> 1;
    let k = 0, j = 0;
    const clip = (v: number) => (v > 127 ? 127 : v < -127 ? -127 : Math.round(v));
    for (let i = 0; i < audio.length; i++) {
      // level, then (for SSB) the Hilbert pair, delay-matched
      const x = audio[i];
      const ax = Math.abs(x);
      this.peak = ax > this.peak ? ax : Math.max(AudioToIq.FLOOR, this.peak * 0.99995);
      const v = x / this.peak;
      this.hist[this.hi] = v; this.hi = (this.hi + 1) % N;
      let re = v, im = 0;
      if (ssb) {
        let acc = 0; for (let t = 0; t < N; t++) acc += H[t] * this.hist[(this.hi + t) % N];
        // the history is walked oldest-first, which runs the (antisymmetric) kernel backwards: hence the minus
        re = this.hist[(this.hi + D) % N]; im = -sgn * acc;
      }
      this.a0 = this.a1; this.a1 = re; this.q0 = this.q1; this.q1 = im;
      // every IQ sample whose time falls between the last audio sample and this one
      while (this.frac < 1 && k < cap) {
        const f = this.frac, m = this.a0 + (this.a1 - this.a0) * f, mq = this.q0 + (this.q1 - this.q0) * f;
        let I: number, Q: number;
        if (mod === 'fm') { this.fmPh += dPh * Math.max(-1, Math.min(1, m)); if (this.fmPh > Math.PI) this.fmPh -= 2 * Math.PI; else if (this.fmPh < -Math.PI) this.fmPh += 2 * Math.PI; I = Math.cos(this.fmPh) * 70; Q = Math.sin(this.fmPh) * 70; }
        else if (mod === 'am') { I = (1 + 0.8 * Math.max(-1, Math.min(1, m))) * 50; Q = 0; }
        else { I = m * 90; Q = mq * 90; }
        // move to the app's channel
        const r = I * this.ncoR - Q * this.ncoI, s = I * this.ncoI + Q * this.ncoR;
        out[2 * k] = clip(r); out[2 * k + 1] = clip(s);
        const nr = this.ncoR * cw - this.ncoI * sw; this.ncoI = this.ncoR * sw + this.ncoI * cw; this.ncoR = nr;
        if ((++j & 4095) === 0) { const g = 1 / Math.hypot(this.ncoR, this.ncoI); this.ncoR *= g; this.ncoI *= g; }
        k++; this.frac += step;
      }
      this.frac -= 1;
    }
    return out.subarray(0, 2 * k);
  }
}

/** The modulation an app's demodulator expects, from the worker mode it set ('USB', 'NFM' …). */
export function modForMode(mode: string): { mod: AudioMod; devHz: number } {
  switch (mode) {
    case 'USB': case 'CW': case 'DIGU': return { mod: 'usb', devHz: 0 };
    case 'LSB': return { mod: 'lsb', devHz: 0 };
    case 'AM': return { mod: 'am', devHz: 0 };
    case 'WFM': return { mod: 'fm', devHz: 75_000 };
    default: return { mod: 'fm', devHz: 3_000 };          // NFM, and the apps with their own IQ decoders
  }
}
