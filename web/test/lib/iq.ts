/**
 * FORK: synthetic IQ for decoder tests. Everything here is deterministic (seeded noise), so a failing test fails
 * the same way every run.
 */

/** Mulberry32: a small seeded PRNG, so noise is repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples (Box-Muller) from a seeded source. */
export function gauss(r: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Phase-continuous FSK baseband: one audio-rate sample per output sample, tone chosen per symbol. */
export function afsk(bits: ArrayLike<boolean>, baud: number, rate: number, markHz: number, spaceHz: number): Float32Array {
  const spb = rate / baud, n = Math.ceil(bits.length * spb), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = bits[Math.min(bits.length - 1, Math.floor(i / spb))] ? markHz : spaceHz;
    ph += 2 * Math.PI * f / rate; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
    out[i] = Math.sin(ph);
  }
  return out;
}

/** Frequency-modulate an audio-rate message (-1..1) onto complex baseband: instantaneous frequency = offset + dev * m. */
export function fmModulate(msg: Float32Array, rate: number, devHz: number, offsetHz = 0): Float32Array {
  const out = new Float32Array(2 * msg.length);
  let ph = 0;
  for (let i = 0; i < msg.length; i++) {
    ph += 2 * Math.PI * (offsetHz + devHz * msg[i]) / rate;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    out[2 * i] = Math.cos(ph); out[2 * i + 1] = Math.sin(ph);
  }
  return out;
}

/** Repeat an audio-rate signal so each sample lasts `factor` output samples (zero-order hold up-sampling). */
export function hold(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(x.length * factor);
  for (let i = 0; i < out.length; i++) out[i] = x[Math.floor(i / factor)];
  return out;
}

/** Add complex white Gaussian noise for a given per-sample SNR (dB), relative to unit signal power. */
export function addNoise(iq: Float32Array, snrDb: number, seed = 1): Float32Array {
  const g = gauss(rng(seed)), sigma = Math.sqrt(Math.pow(10, -snrDb / 10) / 2);
  const out = new Float32Array(iq.length);
  for (let i = 0; i < iq.length; i++) out[i] = iq[i] + sigma * g();
  return out;
}

/** Quantize float IQ to the signed int8 the radios deliver. `scale` maps 1.0 to that many counts. */
export function toInt8(iq: Float32Array, scale = 90): Int8Array {
  const out = new Int8Array(iq.length);
  for (let i = 0; i < iq.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(iq[i] * scale)));
  return out;
}

/** Complex silence (zeros), `n` samples, for lead-in and tail. */
export function silence(n: number): Float32Array { return new Float32Array(2 * n); }

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Feed IQ to a processor in radio-sized buffers (default 128 KiB like the HackRF's transfers). */
export function feed(p: { onIq(iq: Int8Array, rate: number): void }, iq: Int8Array, rate: number, bufBytes = 131072): void {
  for (let o = 0; o < iq.length; o += bufBytes) p.onIq(iq.subarray(o, Math.min(iq.length, o + bufBytes)), rate);
}

// ---------------------------------------------------------------------------------------------------------------
// Modulators. All return interleaved complex float IQ (I,Q,I,Q…) at `rate`, unit amplitude unless stated.

/** A complex tone at `hz` from the centre (negative = below), `n` samples. */
export function tone(n: number, rate: number, hz: number, amp = 1, phase = 0): Float32Array {
  const out = new Float32Array(2 * n), w = 2 * Math.PI * hz / rate;
  for (let i = 0; i < n; i++) { const p = phase + w * i; out[2 * i] = amp * Math.cos(p); out[2 * i + 1] = amp * Math.sin(p); }
  return out;
}

/** Gaussian pulse-shaping taps for GFSK with bandwidth-time product `bt`, `sps` samples per symbol, unit DC gain. */
export function gaussianTaps(bt: number, sps: number, spanSymbols = 4): Float32Array {
  const n = Math.max(1, Math.round(spanSymbols * sps)) | 1, h = new Float32Array(n), mid = (n - 1) / 2;
  const sigma = Math.sqrt(Math.log(2)) / (2 * Math.PI * bt);       // in symbols
  let sum = 0;
  for (let i = 0; i < n; i++) { const t = (i - mid) / sps; h[i] = Math.exp(-(t * t) / (2 * sigma * sigma)); sum += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

export interface FskOptions {
  /** Gaussian BT (0.5 for BLE, 0.3 for GMSK); omit for plain FSK. */
  bt?: number;
  /** Carrier offset from the centre in Hz. */
  offsetHz?: number;
  amp?: number;
}

/**
 * Continuous-phase FSK straight at baseband. `symbols` are frequency levels in units of `devHz`: ±1 for 2-FSK
 * (or booleans: true = +dev), ±1 and ±1/3 for 4-FSK. With `bt` the frequency pulse train is Gaussian-filtered (GFSK/GMSK).
 */
export function fsk(symbols: ArrayLike<number | boolean>, baud: number, rate: number, devHz: number, o: FskOptions = {}): Float32Array {
  const sps = rate / baud, n = Math.ceil(symbols.length * sps);
  let f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = symbols[Math.min(symbols.length - 1, Math.floor(i / sps))];
    f[i] = typeof s === 'boolean' ? (s ? 1 : -1) : s;
  }
  if (o.bt !== undefined) {
    const h = gaussianTaps(o.bt, sps), half = (h.length - 1) >> 1, g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < h.length; k++) { const j = Math.min(n - 1, Math.max(0, i + k - half)); acc += h[k] * f[j]; }
      g[i] = acc;
    }
    f = g;
  }
  const out = new Float32Array(2 * n), amp = o.amp ?? 1, off = o.offsetHz ?? 0;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (off + devHz * f[i]) / rate;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    out[2 * i] = amp * Math.cos(ph); out[2 * i + 1] = amp * Math.sin(ph);
  }
  return out;
}

/**
 * On-off keying from a pulse list in microseconds, rtl_433 style: each entry is [on µs, off µs]. The carrier sits at
 * `carrierHz` from the centre (an OOK remote is rarely exactly on the tuned frequency).
 */
export function ook(pulsesUs: [number, number][], rate: number, carrierHz = 0, amp = 1): Float32Array {
  const parts: Float32Array[] = [];
  let t = 0;
  for (const [on, off] of pulsesUs) {
    const nOn = Math.round(on * 1e-6 * rate), nOff = Math.round(off * 1e-6 * rate);
    parts.push(tone(nOn, rate, carrierHz, amp, 2 * Math.PI * carrierHz * t / rate), silence(nOff));
    t += nOn + nOff;
  }
  return concat(...parts);
}

/** M-PSK with rectangular pulses: symbol k has phase 2πk/M (+ `phase0`). Gray coding is the caller's business. */
export function psk(symbols: ArrayLike<number>, order: number, baud: number, rate: number, phase0 = 0, amp = 1): Float32Array {
  const sps = rate / baud, n = Math.ceil(symbols.length * sps), out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const p = phase0 + 2 * Math.PI * symbols[Math.min(symbols.length - 1, Math.floor(i / sps))] / order;
    out[2 * i] = amp * Math.cos(p); out[2 * i + 1] = amp * Math.sin(p);
  }
  return out;
}

/** Mean power of the samples that are not exactly zero (so silence around a burst does not dilute it). */
export function activePower(iq: Float32Array): number {
  let s = 0, k = 0;
  for (let i = 0; i < iq.length; i += 2) { const p = iq[i] * iq[i] + iq[i + 1] * iq[i + 1]; if (p > 0) { s += p; k++; } }
  return k ? s / k : 0;
}

/** Complex AWGN at an SNR (dB) measured against the signal's own active power, in the full sample bandwidth. */
export function awgn(iq: Float32Array, snrDb: number, seed = 1): Float32Array {
  const g = 1 / Math.sqrt(activePower(iq) || 1);   // measured once, not per sample
  return addNoise(iq.map(v => v * g), snrDb, seed);
}

/** Bits (MSB first) of a byte array. */
export function bitsMsb(bytes: ArrayLike<number>): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < bytes.length; i++) for (let b = 7; b >= 0; b--) out.push(((bytes[i] >> b) & 1) === 1);
  return out;
}
/** Bits (LSB first) of a byte array, the order BLE and AX.25 send them. */
export function bitsLsb(bytes: ArrayLike<number>): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) out.push(((bytes[i] >> b) & 1) === 1);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// File writers, for FileRadio and format tests. Float IQ in, raw file bytes out.

/** Signed 8-bit interleaved (.cs8 / .c8, hackrf_transfer). */
export function toCs8(iq: Float32Array, scale = 90): Uint8Array { const s = toInt8(iq, scale); return new Uint8Array(s.buffer, s.byteOffset, s.length); }
/** Unsigned 8-bit offset-128 interleaved (.cu8, rtl_sdr). */
export function toCu8(iq: Float32Array, scale = 90): Uint8Array { const s = toInt8(iq, scale), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s[i] + 128; return out; }
/** Signed 16-bit little-endian interleaved (.cs16 / Mayhem .C16). */
export function toCs16(iq: Float32Array, scale = 23000): Uint8Array {
  const out = new Uint8Array(iq.length * 2), dv = new DataView(out.buffer);
  for (let i = 0; i < iq.length; i++) dv.setInt16(2 * i, Math.max(-32767, Math.min(32767, Math.round(iq[i] * scale))), true);
  return out;
}
/** A 2-channel 16-bit PCM WAV (I = left, Q = right), as SDR# / SDRuno / HDSDR write IQ. */
export function toWavIq(iq: Float32Array, rate: number, scale = 23000): Uint8Array {
  const data = toCs16(iq, scale), out = new Uint8Array(44 + data.length), dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + data.length, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, data.length, true); out.set(data, 44);
  return out;
}
