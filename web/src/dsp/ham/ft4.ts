/**
 * FORK: FT4 decoder, after ft8_lib by Kārlis Goba (MIT: constants.c kFT4_Costas_pattern, kFT4_Gray_map,
 * kFT4_XOR_sequence; encode.c ft4_encode; decode.c ft4_sync_score, ft4_extract_symbol) and WSJT-X's FT4 definition:
 * 7.5 s slots; 105 symbols of 48 ms (a ramp symbol, four 4-symbol Costas blocks with 29 data symbols between them, a
 * ramp symbol); 4-FSK at 20.833 Hz spacing, two bits a symbol Gray-mapped; the same LDPC(174,91), CRC-14 and 77-bit
 * messages as FT8, except that the payload is XORed with a fixed sequence before the CRC and the code. Shares FT8's
 * belief-propagation and OSD decoders, CRC and message unpacking (dsp/ham/ft8.ts). The audio is resampled to 10 2/3
 * kHz, where a symbol is exactly 512 samples: a two-symbol Hann window every half symbol gives half-tone bins; the
 * Costas blocks find candidates; each data symbol's four tone levels give its two bits' likelihoods. Receive only.
 */
import { Ft8Decoder, ftxShared, type Ft8Decode } from './ft8.js';
import { LDPC_GENERATOR } from './ft8-tables.js';
import { fft } from '../../fft.js';
import type { DigitalDecoder } from './digital.js';

export const FT4_COSTAS = [[0, 1, 3, 2], [1, 0, 2, 3], [2, 3, 1, 0], [3, 2, 0, 1]];
export const FT4_GRAY = [0, 1, 3, 2];
export const FT4_XOR = [0x4A, 0x5E, 0x89, 0xB4, 0xB0, 0x8A, 0x79, 0x55, 0xBE, 0x28];
const FS = 48_000 * 2 / 9, SYM = 512, NFFT = 2 * SYM, STEP = SYM / 2, TONE_HZ = FS / SYM;   // 10 666.67 Hz, 20.833 Hz
const SLOT_S = 7.5, LEAD_S = 1.0, SPAN_S = 7.5;   // decode from 1 s before the slot to 6.5 s into it
const FMIN = 200, FMAX = 3000, BIN0 = Math.floor(FMIN / (TONE_HZ / 2)), NBINS = Math.ceil((FMAX - FMIN) / (TONE_HZ / 2));
const NT = Math.floor((SPAN_S * FS - NFFT) / STEP) + 1;
const SYNC_AT = [1, 34, 67, 100], DATA_AT = (() => { const a: number[] = []; for (let s = 5; s < 34; s++) a.push(s); for (let s = 38; s < 67; s++) a.push(s); for (let s = 71; s < 100; s++) a.push(s); return a; })();
const MAX_CANDS = 80, MIN_SYNC = 2.0, N = 174, K = 91;

/** Transmitter side (tests): a 77-bit payload (10 bytes, FT8 packing) → 105 tones. */
export function ft4Tones(payload: Uint8Array): Uint8Array {
  const a91 = new Uint8Array(12);
  for (let i = 0; i < 10; i++) a91[i] = payload[i] ^ FT4_XOR[i];
  a91[9] &= 0xF8;
  const crc = ftxShared.crc14(a91, 82);
  a91[9] |= crc >> 11; a91[10] = (crc >> 3) & 0xFF; a91[11] = (crc << 5) & 0xFF;
  const cw = new Uint8Array(22); for (let j = 0; j < 12; j++) cw[j] = a91[j];
  let colMask = 0x80 >> (91 % 8), colIdx = 11;
  for (let i = 0; i < 83; i++) {
    let nsum = 0;
    for (let j = 0; j < 12; j++) { let b = a91[j] & LDPC_GENERATOR[i * 12 + j]; b ^= b >> 4; b ^= b >> 2; b ^= b >> 1; nsum ^= b & 1; }
    if (nsum) cw[colIdx] |= colMask;
    colMask >>= 1; if (colMask === 0) { colMask = 0x80; colIdx++; }
  }
  const tones = new Uint8Array(105);
  for (let m = 0; m < 4; m++) for (let k = 0; k < 4; k++) tones[SYNC_AT[m] + k] = FT4_COSTAS[m][k];
  let bit = 0;
  for (const s of DATA_AT) { const hi = (cw[bit >> 3] >> (7 - (bit & 7))) & 1; bit++; const lo = (cw[bit >> 3] >> (7 - (bit & 7))) & 1; bit++; tones[s] = FT4_GRAY[(hi << 1) | lo]; }
  return tones;
}

interface Cand { t: number; f: number; score: number }

export class Ft4Decoder implements DigitalDecoder {
  readonly name = 'FT4';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Ft8Decode[], slot: number) => void = () => {};
  /** For the unpacking and its callsign hash table. */
  private readonly unpacker = new Ft8Decoder();
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private readonly ring = new Float32Array(Math.ceil(FS * 10)); private wpos = 0; private total = 0; private t0 = 0;
  private lastSlot = -1; private busy = false;
  private readonly mag = new Float32Array(NT * 2 * NBINS);   // [time step][bin] in dB, bins of half a tone
  private readonly win = Float32Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));

  reset(): void { this.wpos = 0; this.total = 0; this.rs.reset(); this.lastSlot = -1; this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.ring[this.wpos] = v; this.wpos = (this.wpos + 1) % this.ring.length; this.total++; });
    const now = Date.now(), est = now - this.total / FS * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.05 * (est - this.t0);
    const slot = Math.floor(now / (SLOT_S * 1000));
    // decode slot k once 6.6 s of it have passed (a transmission ends 5.54 s in)
    const into = now - slot * SLOT_S * 1000;
    if (slot !== this.lastSlot && into > 6600 && this.total > FS * SPAN_S && !this.busy) {
      this.lastSlot = slot; this.busy = true;
      try {
        const startMs = slot * SLOT_S * 1000 - LEAD_S * 1000, first = Math.round((startMs - this.t0) / 1000 * FS);
        const buf = new Float32Array(Math.round(SPAN_S * FS)), L = this.ring.length;
        if (this.total - first <= L && first >= 0) {
          for (let i = 0; i < buf.length; i++) buf[i] = this.ring[(first + i) % L];
          const list = this.decodeBuffer(buf, slot * SLOT_S * 1000);
          if (list.length) this.onDecodes(list, slot);
        }
      } finally { this.busy = false; }
    }
  }

  /** Decode 7.5 s of 10 2/3 kHz audio that starts 1 s before the slot. */
  decodeBuffer(buf: Float32Array, slotMs = 0): Ft8Decode[] {
    this.waterfall(buf);
    const cands = this.candidates(), out: Ft8Decode[] = [], seen = new Set<string>();
    for (const c of cands) {
      const d = this.decode(c, slotMs);
      if (d && !seen.has(d.text)) { seen.add(d.text); out.push(d); this.onText(d.text, `FT4 ${d.snr} dB ${d.hz} Hz`); }
    }
    this.confidence = out.length ? 1 : this.confidence * 0.8;
    return out;
  }

  private waterfall(buf: Float32Array): void {
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT), W = 2 * NBINS;
    for (let t = 0; t < NT; t++) {
      const o = t * STEP;
      for (let i = 0; i < NFFT; i++) { re[i] = (buf[o + i] ?? 0) * this.win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < W; b++) { const k = BIN0 + b; this.mag[t * W + b] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12); }
    }
  }
  /** Level of tone `tone` of the symbol `sym` for a candidate (time step of symbol 0, bin of tone 0). */
  private lvl(c: { t: number; f: number }, sym: number, tone: number): number {
    const t = c.t + 2 * sym, b = c.f + 2 * tone, W = 2 * NBINS;
    return t >= 0 && t < NT && b >= 0 && b < W ? this.mag[t * W + b] : -120;
  }
  /** ft4_sync_score in spirit: each Costas tone against the other three tones of its symbol, averaged. */
  private sync(c: { t: number; f: number }): number {
    let s = 0, n = 0;
    for (let m = 0; m < 4; m++) for (let k = 0; k < 4; k++) {
      const sym = SYNC_AT[m] + k, want = FT4_COSTAS[m][k];
      if (c.t + 2 * sym >= NT) continue;
      let other = 0; for (let j = 0; j < 4; j++) if (j !== want) other += this.lvl(c, sym, j);
      s += this.lvl(c, sym, want) - other / 3; n++;
    }
    return n ? s / n : -99;
  }
  private candidates(): Cand[] {
    const list: Cand[] = [], W = 2 * NBINS;
    const tMax = NT - 2 * 104 - 1;
    for (let t = 0; t <= tMax; t++) for (let f = 0; f <= W - 8; f++) {
      const score = this.sync({ t, f });
      if (score >= MIN_SYNC) list.push({ t, f, score });
    }
    list.sort((a, b) => b.score - a.score);
    // one candidate per neighbourhood (a symbol in time, a tone in frequency)
    const kept: Cand[] = [];
    for (const c of list) { if (kept.length >= MAX_CANDS) break; if (!kept.some(k => Math.abs(k.t - c.t) <= 2 && Math.abs(k.f - c.f) <= 2)) kept.push(c); }
    return kept;
  }

  private decode(c: Cand, slotMs: number): Ft8Decode | null {
    const llr = new Float64Array(N);
    DATA_AT.forEach((sym, k) => {
      const s2 = [0, 1, 2, 3].map(j => this.lvl(c, sym, FT4_GRAY[j]));
      llr[2 * k] = Math.max(s2[2], s2[3]) - Math.max(s2[0], s2[1]);
      llr[2 * k + 1] = Math.max(s2[1], s2[3]) - Math.max(s2[0], s2[2]);
    });
    ftxShared.normalize(llr);
    const plain = new Uint8Array(N);
    let strict = false;
    const errors = ftxShared.bpDecode(llr, 30, plain);
    if (errors > 0) { if (errors > 20 || !ftxShared.osdDecode(llr, plain)) return null; strict = true; }
    const a91 = new Uint8Array(12);
    for (let i = 0; i < K; i++) if (plain[i]) a91[i >> 3] |= 0x80 >> (i & 7);
    const crc = ((a91[9] & 0x07) << 11) | (a91[10] << 3) | (a91[11] >> 5);
    a91[9] &= 0xF8; a91[10] = 0;
    if (ftxShared.crc14(a91, 82) !== crc) return null;
    const payload = new Uint8Array(10); for (let i = 0; i < 10; i++) payload[i] = a91[i] ^ FT4_XOR[i];
    payload[9] &= 0xF8;
    if (strict && !ftxShared.plausibleStd(payload)) return null;
    const text = this.unpacker.unpackPayload(payload);
    if (!text || (strict && text.includes('<'))) return null;
    // SNR: the sync tones against the rest, in 2500 Hz (a 20.8 Hz tone bin)
    const sig = this.sync(c), snr = Math.round(sig - 10 * Math.log10(2500 / TONE_HZ));
    const dt = +((c.t * STEP / FS) - LEAD_S - 0.5).toFixed(2), hz = Math.round((BIN0 + c.f) * TONE_HZ / 2);
    const d = new Date(slotMs), utc = `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
    return { utc, snr, dt, hz, text };
  }
}

/** Transmitter side (tests): real audio at `rate` for 105 tones, tone 0 at baseHz, phase-continuous. */
export function ft4Audio(tones: Uint8Array, baseHz: number, rate: number, amplitude = 0.5): Float32Array {
  const sl = rate * 0.048, n = Math.round(sl * 105), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const s = Math.min(104, Math.floor(i / sl)); ph += 2 * Math.PI * (baseHz + tones[s] * 48_000 / 2304) / rate; out[i] = amplitude * Math.sin(ph); }
  return out;
}
