/**
 * FORK: Q65 on the HAM receiver's USB audio, receive only. After WSJT-X (GPL-3.0-or-later): lib/qra/q65/q65.c and
 * qracodes.c by Nico Palermo IV3NWV (the codec: CRC-12, encoder, the MFSK Bessel metric, the message-passing decoder
 * over GF(64) with Walsh-Hadamard convolutions, MAP decision, the log-likelihood check), qra15_65_64_irr_e23.c (the
 * code's tables), genq65.f90 (77 bits → 13 symbols, the 22 sync positions, sync on tone 0 and data on tones 1-64) and
 * q65.f90 / q65_decode.f90 (the periods' samples a symbol and the submodes' tone spacing).
 *  - 85 symbols at 12 kHz: 1800, 3600, 7200, 16000 or 41472 samples a symbol for T/R 15, 30, 60, 120 and 300 s;
 *    the tone spacing is the baud × 1, 2, 4, 8 or 16 (submodes A-E);
 *  - the 77-bit message (FT8's packing) as 13 six-bit symbols, CRC-12 (two symbols, punctured), the (65,15) QRA code:
 *    63 symbols sent.
 * Receiver (written here): one-symbol spectra a quarter symbol apart over the slot; the sync tone's energy at the 22 sync
 * positions over every start and frequency gives candidates; each one's 63 data symbols as 64 tone energies (summed over
 * the submode's spacing), the Bessel metric, up to 100 message-passing iterations, the CRC and the log-likelihood check;
 * the payload unpacks with FT8's unpacker. No a-priori or list decoding (WSJT-X's deepest modes).
 */
import { fft } from '../../fft.js';
import { Ft8Decoder, ftxShared } from './ft8.js';
import { Q65_ACC_INPUT_IDX, Q65_ACC_INPUT_WLOG, Q65_LOG, Q65_EXP, Q65_MSGW, Q65_VDEG, Q65_CDEG, Q65_V2CMIDX, Q65_C2VMIDX, Q65_PMAT } from './q65-tables.js';
import type { DigitalDecoder } from './digital.js';

const FS = 12_000, M = 64, K = 15, N = 65, NC = 50, V = 65, C = 116, MAXVDEG = 5, MAXCDEG = 3;
export const Q65_SYNC = [1, 9, 12, 13, 15, 22, 23, 26, 27, 33, 35, 38, 46, 50, 55, 60, 62, 66, 69, 74, 76, 85];
const IS_SYNC = (() => { const a = new Uint8Array(85); for (const s of Q65_SYNC) a[s - 1] = 1; return a; })();
/** Samples a symbol (12 kHz) for each T/R period. */
export const Q65_NSPS: Record<number, number> = { 15: 1800, 30: 3600, 60: 7200, 120: 16000, 300: 41472 };

// ---- the codec (q65.c, qracodes.c) ----------------------------------------------------------------------------------
function crc12(x: ArrayLike<number>, n: number): [number, number] {
  let sr = 0;
  for (let k = 0; k < n; k++) { let t = x[k]; for (let j = 0; j < 6; j++) { sr = ((t ^ sr) & 1) ? (sr >> 1) ^ 0xF01 : sr >> 1; t >>= 1; } }
  return [sr & 0x3F, sr >> 6];
}
/** 15 information symbols → the 65-symbol codeword (qra_encode, grouping factor 1). */
function qraEncode(x: ArrayLike<number>): Int32Array {
  const y = new Int32Array(N); for (let k = 0; k < K; k++) y[k] = x[k];
  let chk = 0;
  for (let k = 0; k < NC; k++) { const t = x[Q65_ACC_INPUT_IDX[k]]; if (t) chk ^= Q65_EXP[(Q65_LOG[t] + Q65_ACC_INPUT_WLOG[k]) % (M - 1)]; y[K + k] = chk; }
  return y;
}
/** 13 message symbols → the 63 symbols sent (the two CRC symbols punctured). */
export function q65Encode(msg: ArrayLike<number>): Int32Array {
  const x = new Int32Array(K); for (let k = 0; k < 13; k++) x[k] = msg[k];
  const [c0, c1] = crc12(x, 13); x[13] = c0; x[14] = c1;
  const y = qraEncode(x), out = new Int32Array(63);
  for (let k = 0; k < 13; k++) out[k] = y[k];
  for (let k = 0; k < NC; k++) out[13 + k] = y[K + k];
  return out;
}
function fwht(v: Float32Array, o: number): void {
  for (let h = 1; h < M; h <<= 1) for (let i = 0; i < M; i += h << 1) for (let j = i; j < i + h; j++) { const a = v[o + j], b = v[o + j + h]; v[o + j] = a + b; v[o + j + h] = a - b; }
}
function norm(v: Float32Array, o: number): void {
  let t = 0; for (let i = 0; i < M; i++) t += v[o + i];
  if (t <= 0) { for (let i = 0; i < M; i++) v[o + i] = 1 / M; return; }
  t = 1 / t; for (let i = 0; i < M; i++) v[o + i] *= t;
}
/** 63 × 64 tone energies → symbol probabilities (qra_mfskbesselmetric at q65_init's Es/No). */
export function q65Intrinsics(e: Float32Array): Float32Array {
  const esno = 6 * (13 / 63) * 10 ** (2.8 / 10);   // q65_init: bits a symbol × the rate (13 / 63 sent) × Eb/No 2.8 dB
  const n = e.length, p = new Float32Array(n); let rsum = 0;
  for (let k = 0; k < n; k++) { rsum += e[k]; p[k] = Math.sqrt(e[k]); }
  rsum /= n;
  const sigma = Math.sqrt(rsum / (1 + esno / M) / 2), cm = Math.sqrt(2 * esno) / sigma;
  for (let s = 0; s < n / M; s++) {
    for (let i = 0; i < M; i++) { let v = p[s * M + i] * cm; const q = v * v; v = q * (v + 0.039) / (q * 0.9931 + v * 2.6936 + 0.5185); p[s * M + i] = Math.exp(Math.min(80, v)); }
    norm(p, s * M);
  }
  return p;
}
/** Decode 63 rows of symbol probabilities → the 13 message symbols, or null. */
export function q65Decode(pix63: Float32Array, maxIter = 100): Int32Array | null {
  const ix = new Float32Array(N * M);
  ix.set(pix63.subarray(0, 13 * M), 0); ix.fill(1 / M, 13 * M, 15 * M); ix.set(pix63.subarray(13 * M), 15 * M);
  const NMSG = 216, v2c = new Float32Array(NMSG * M), c2v = new Float32Array(NMSG * M), out = new Float32Array(M);
  c2v.set(ix.subarray(0, V * M), 0);
  for (let nv = 0; nv < V; nv++) for (let k = 1; k < Q65_VDEG[nv]; k++) v2c.set(ix.subarray(nv * M, nv * M + M), Q65_V2CMIDX[nv * MAXVDEG + k] * M);
  let ok = false;
  for (let it = 0; it < maxIter && !ok; it++) {
    for (let nc = V; nc < C; nc++) {
      const deg = Q65_CDEG[nc], base = nc * MAXCDEG;
      for (let k = 0; k < deg; k++) fwht(v2c, Q65_C2VMIDX[base + k] * M);
      for (let k = 0; k < deg; k++) {
        out.fill(1 / M);
        for (let kk = 0; kk < deg; kk++) if (kk !== k) { const o = Q65_C2VMIDX[base + kk] * M; for (let i = 0; i < M; i++) out[i] *= v2c[o + i]; }
        out[0] += 1e-7; fwht(out, 0);
        const im = Q65_C2VMIDX[base + k], w = Q65_MSGW[im], o = im * M;
        if (w === 0) c2v.set(out, o); else for (let i = 0; i < M; i++) c2v[o + Q65_PMAT[w * M + i]] = out[i];   // p(α^-w x)
      }
    }
    for (let nv = 0; nv < V; nv++) {
      const deg = Q65_VDEG[nv], base = nv * MAXVDEG;
      for (let k = 0; k < deg; k++) {
        out.fill(1 / M);
        for (let kk = 0; kk < deg; kk++) if (kk !== k) { const o = Q65_V2CMIDX[base + kk] * M; for (let i = 0; i < M; i++) out[i] *= c2v[o + i]; }
        norm(out, 0);
        const im = Q65_V2CMIDX[base + k], w = Q65_MSGW[im], o = im * M;
        if (w === 0) v2c.set(out, o); else for (let i = 0; i < M; i++) v2c[o + i] = out[Q65_PMAT[w * M + i]];   // p(α^w x)
      }
    }
    let tot = 0; for (let nv = 0; nv < V; nv++) { let mx = 0; for (let i = 0; i < M; i++) if (v2c[nv * M + i] > mx) mx = v2c[nv * M + i]; tot += mx; }
    if (tot > V - 0.01) ok = true;
  }
  if (!ok) return null;
  const x = new Int32Array(K);
  for (let k = 0; k < K; k++) { let b = 0, bv = -1; for (let i = 0; i < M; i++) { const v = v2c[k * M + i] * ix[k * M + i]; if (v >= bv) { bv = v; b = i; } } x[k] = b; }
  const [c0, c1] = crc12(x, 13); if (c0 !== x[13] || c1 !== x[14]) return null;
  // the codeword must be likely enough (q65_check_llh)
  const y = q65Encode(x); let llh = 0; for (let k = 0; k < 63; k++) llh += Math.log(Math.max(1e-36, pix63[k * M + y[k]]));
  if (llh < -260) return null;
  if (x.subarray(0, 13).every(v => v === 0)) return null;
  return x.slice(0, 13);
}

// ---- messages ---------------------------------------------------------------------------------------------------------
/** 10 payload bytes (77 bits, MSB first) → 13 symbols (the last 5 bits doubled, genq65's 78-bit payload). */
export function q65Symbols(p: Uint8Array): Int32Array {
  const bit = (i: number) => (p[i >> 3] >> (7 - (i & 7))) & 1, s = new Int32Array(13);
  for (let k = 0; k < 12; k++) { let v = 0; for (let j = 0; j < 6; j++) v = 2 * v + bit(6 * k + j); s[k] = v; }
  let v = 0; for (let j = 0; j < 5; j++) v = 2 * v + bit(72 + j); s[12] = 2 * v;
  return s;
}
function payloadOf(s: ArrayLike<number>): Uint8Array {
  const p = new Uint8Array(10), put = (i: number, b: number) => { if (b) p[i >> 3] |= 0x80 >> (i & 7); };
  for (let k = 0; k < 12; k++) for (let j = 0; j < 6; j++) put(6 * k + j, (s[k] >> (5 - j)) & 1);
  for (let j = 0; j < 5; j++) put(72 + j, (s[12] >> (5 - j)) & 1);
  return p;
}
/** The 85 tones of a message (0 = sync). */
export function q65Tones(p: Uint8Array): number[] {
  const sent = q65Encode(q65Symbols(p)), t: number[] = []; let k = 0;
  for (let i = 0; i < 85; i++) t.push(IS_SYNC[i] ? 0 : sent[k++] + 1);
  return t;
}
export function q65Audio(tones: number[], period: number, sub: number, f0: number, rate: number, amp = 1): Float32Array {
  const ns = Q65_NSPS[period] * rate / FS, step = FS / Q65_NSPS[period] * 2 ** sub, out = new Float32Array(Math.round(85 * ns)); let ph = 0;
  for (let k = 0; k < out.length; k++) { out[k] = amp * Math.cos(ph); ph += 2 * Math.PI * (f0 + step * tones[Math.min(84, Math.floor(k / ns))]) / rate; }
  return out;
}

export interface Q65Decode { utc: string; snr: number; dt: number; hz: number; text: string }
const pad2 = (n: number) => String(n).padStart(2, '0');

export class Q65Decoder implements DigitalDecoder {
  readonly name = 'Q65';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Q65Decode[], slot: number) => void = () => {};
  /** T/R period (s) and submode (0 = A … 4 = E). */
  period = 60; sub = 0;
  budgetMs = 5000;
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private ring = new Float32Array(FS * 70); private wpos = 0; private total = 0; private t0 = 0; private lastSlot = -1;
  private readonly unpacker = new Ft8Decoder();
  setPeriod(p: number): void { if (Q65_NSPS[p] && p !== this.period) { this.period = p; this.reset(); } }
  reset(): void { this.ring = new Float32Array(FS * (this.period + 10)); this.wpos = 0; this.total = 0; this.t0 = 0; this.lastSlot = -1; this.rs.reset(); this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.ring[this.wpos] = v; this.wpos = (this.wpos + 1) % this.ring.length; this.total++; });
    const now = Date.now(), est = now - this.total / FS * 1000, P = this.period * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.02 * (est - this.t0);
    const slot = Math.floor(now / P), into = now - slot * P, need = (85 * Q65_NSPS[this.period] / FS + 2) * 1000;
    if (slot === this.lastSlot || into < Math.min(need, P - 500)) return;
    this.lastSlot = slot;
    const n0 = Math.round(Math.min(need, P - 500) / 1000 * FS), first = Math.round((slot * P - this.t0) / 1000 * FS), buf = new Float32Array(n0), L = this.ring.length;
    let have = 0;
    for (let k = 0; k < n0; k++) { const s = first + k; if (s >= 0 && s < this.total && this.total - s <= L) { buf[k] = this.ring[s % L]; have++; } }
    if (have < n0 / 2) return;
    const list = this.decodeBuffer(buf, slot * P);
    if (list.length) { this.confidence = 1; this.onDecodes(list, slot); for (const d of list) this.onText(`${d.utc} ${d.snr} ${d.hz} ${d.text}\n`, `Q65-${this.period}${'ABCDE'[this.sub]}`); }
    else this.confidence = Math.max(0, this.confidence - 0.2);
  }

  /** A slot's audio (12 kHz) from its start → the decodes. */
  decodeBuffer(x: Float32Array, slotMs = 0): Q65Decode[] {
    const started = Date.now(), nsps = Q65_NSPS[this.period], step = nsps / 4, mode = 2 ** this.sub, df = FS / nsps;
    let NF = 1; while (NF < nsps) NF <<= 1;   // zero-padded: bins of FS / NF, resampled to the baud below
    const lo = Math.max(1, Math.round(200 / df)), hi = Math.min(Math.round(3000 / df) + 65 * mode, Math.floor(nsps / 2) - 1), W = hi - lo + 1;
    const nfr = Math.max(0, Math.floor((x.length - nsps) / step) + 1);
    const re = new Float32Array(NF), im = new Float32Array(NF), S: Float32Array[] = [];
    for (let j = 0; j < nfr; j++) {
      re.fill(0); im.fill(0); for (let i = 0; i < nsps; i++) re[i] = x[j * step + i];
      fft(re, im);
      const row = new Float32Array(W);
      for (let b = 0; b < W; b++) { const f = (lo + b) * df * NF / FS, i0 = Math.floor(f), u = f - i0, a = re[i0] * re[i0] + im[i0] * im[i0], c = re[i0 + 1] * re[i0 + 1] + im[i0 + 1] * im[i0 + 1]; row[b] = a + u * (c - a); }
      S.push(row);
    }
    if (nfr < 85 * 4 - 40) return [];
    // flatten each bin against its median over time
    for (let b = 0; b < W; b++) { const m = Float32Array.from(S, r => r[b]).sort()[nfr >> 1] || 1e-20; for (const r of S) r[b] /= m; }
    // sync: the sync tone at the 22 positions, for every start (−1 … +5.5 s) and frequency
    const j0 = -Math.round(1 * FS / step), j1 = Math.round(5.5 * FS / step);   // EME: echoes 2.5 s late
    const best = new Float32Array(W).fill(-1e9), bestJ = new Int32Array(W);
    for (let b = 0; b < W - 64 * mode; b++) for (let j = j0; j <= j1; j++) {
      let s = 0, n = 0; for (const q of Q65_SYNC) { const r = j + 4 * (q - 1); if (r >= 0 && r < nfr) { s += S[r][b]; n++; } }
      if (n < 16) continue;
      const v = s / n; if (v > best[b]) { best[b] = v; bestJ[b] = j; }
    }
    const srt = Float32Array.from(best.filter(v => v > -1e8)).sort(), med = srt[srt.length >> 1] ?? 0, spread = (srt[Math.floor(srt.length * 0.84)] - med) || 1e-6;
    const cands: { b: number; j: number; v: number }[] = [];
    for (let b = 1; b < W - 64 * mode - 1; b++) { const v = best[b]; if (v > med + 3 * spread && v > 1.5 && v >= best[b - 1] && v >= best[b + 1]) cands.push({ b, j: bestJ[b], v }); }
    cands.sort((a, c) => c.v - a.v); cands.length = Math.min(cands.length, 20);
    const out: Q65Decode[] = [], d = new Date(slotMs), utc = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${this.period < 60 ? pad2(d.getUTCSeconds()) : ''}`;
    for (const c of cands) {
      if (Date.now() - started > this.budgetMs) break;
      const hz = (lo + c.b) * df;
      if (out.some(o => Math.abs(o.hz - hz) < 65 * mode * df)) continue;
      // try the start around the sync peak (a quarter symbol either side)
      let got: Int32Array | null = null, eUsed: Float32Array | null = null, jUsed = c.j;
      for (const dj of [0, -1, 1]) {
        const e = new Float32Array(63 * M); let k = 0;
        for (let i = 0; i < 85; i++) {
          if (IS_SYNC[i]) continue;
          const r = c.j + dj + 4 * i;
          for (let t = 0; t < M; t++) { let v = 0; const b0 = c.b + mode * (t + 1); for (let q = 0; q < mode; q++) v += r >= 0 && r < nfr && b0 + q < W ? S[r][b0 + q] : 1; e[k * M + t] = v; }
          k++;
        }
        const dec = q65Decode(q65Intrinsics(e));
        if (dec) { got = dec; eUsed = e; jUsed = c.j + dj; break; }
      }
      if (!got || !eUsed) continue;
      const text = this.unpacker.unpackPayload(payloadOf(got)); if (!text) continue;
      // SNR in 2500 Hz from the decoded tones' energies over the others (q65_esnodb), as WSJT-X adjusts it
      const y = q65Encode(got); let sig = 0, noi = 0; for (let k = 0; k < 63; k++) for (let t = 0; t < M; t++) { if (t === y[k]) sig += eUsed[k * M + t]; else noi += eUsed[k * M + t]; }
      sig /= 63; noi /= 63 * 63; const esno = 10 * Math.log10(Math.max(0.316, sig / noi - 1));
      const snr = Math.round(esno - 10 * Math.log10(2500 / df) + 3 - 10 * Math.log10(mode));
      out.push({ utc, snr, dt: Math.round((jUsed * step / FS - (this.period >= 60 ? 1 : 0.5)) * 10) / 10, hz: Math.round(hz), text });
    }
    return out;
  }
}
