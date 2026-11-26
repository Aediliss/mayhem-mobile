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
