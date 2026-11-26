/**
 * FORK: DJI DroneID (OcuSync), receive only. A drone sends a short burst about every 600 ms, 10 MHz wide in the 2.4 GHz
 * band: nine OFDM symbols on a 1024-point FFT at 15.36 MS/s (15 kHz carriers), 600 used carriers around an empty DC,
 * cyclic prefixes of 80 samples on the first and last symbol and 72 on the others. Symbols 4 and 6 are Zadoff-Chu
 * sequences (roots 600 and 147) that give the timing, the frequency offset and the channel; symbol 1 carries the bare
 * scrambling sequence; the other six carry 7200 QPSK bits, scrambled by the LTE Gold sequence (c_init 0x12345678),
 * which are an LTE rate-matched turbo code (lte-turbo.ts, K = 1408) of 176 bytes: the frame, zero padding, CRC-24A.
 * The frame: length, type 16, version, sequence, state, serial number, the drone's longitude / latitude (radians ×
 * 1e7), height, altitude, velocities north / east / up, yaw, the pilot app's GPS time, the pilot's latitude / longitude,
 * the home point's longitude / latitude, product type, UUID, then a CRC-16 (reflected 0x8408, initial 0x3692).
 *
 * After proto17/dji_droneid (David Protzman, MIT), the burst structure and frame layout; the receiver here (burst
 * detection, timing, frequency offset, equalization) and all the code are written for this app. No DOM.
 */
import type { Emit, IqProcessor } from './core.js';
import { fftInPlace } from './ham/filters.js';
import { crc24a, rateDematch, rateMatch, toBits, toBytes, turboDecode, turboEncode, QPP_PARAMS } from './lte-turbo.js';

export const DRONEID_RATE = 15_360_000;
const N = 1024, LONG_CP = 80, SHORT_CP = 72, CARRIERS = 600;
const CP = [LONG_CP, SHORT_CP, SHORT_CP, SHORT_CP, SHORT_CP, SHORT_CP, SHORT_CP, SHORT_CP, LONG_CP];
/** Sample where each symbol's CP starts, from the start of the burst. */
const SYM_START: number[] = []; { let t = 0; for (const c of CP) { SYM_START.push(t); t += c + N; } }
export const BURST_LEN = SYM_START[8] + LONG_CP + N;   // 9880
/** The FFT bin (natural order) of used carrier i: -300..-1, then 1..300. */
const BIN = Array.from({ length: CARRIERS }, (_, i) => ((i < 300 ? i - 300 : i - 299) + N) % N);
const DATA_SYMBOLS = [1, 2, 4, 6, 7, 8];               // 0-based symbols carrying the coded bits (2, 3, 5, 7, 8, 9)

/** The Zadoff-Chu carriers of symbol 4 (root 600) or 6 (root 147). */
export function zcCarriers(root: number): Float64Array {
  const out = new Float64Array(2 * CARRIERS); let k = 0;
  for (let n = 0; n <= 600; n++) { if (n === 300) continue; const ph = -Math.PI * root * n * (n + 1) / 601; out[2 * k] = Math.cos(ph); out[2 * k + 1] = Math.sin(ph); k++; }
  return out;
}
const ZC4 = zcCarriers(600), ZC6 = zcCarriers(147);

/** The LTE Gold sequence c(n) for c_init (36.211 7.2), n bits. */
export function goldSequence(cinit: number, n: number): Uint8Array {
  const Nc = 1600, L = Nc + n + 31, x1 = new Uint8Array(L), x2 = new Uint8Array(L), c = new Uint8Array(n);
  x1[0] = 1; for (let i = 0; i < 31; i++) x2[i] = (cinit >>> i) & 1;
  for (let i = 0; i + 31 < L; i++) { x1[i + 31] = x1[i + 3] ^ x1[i]; x2[i + 31] = x2[i + 3] ^ x2[i + 2] ^ x2[i + 1] ^ x2[i]; }
  for (let i = 0; i < n; i++) c[i] = x1[i + Nc] ^ x2[i + Nc];
  return c;
}
const SCRAMBLE = goldSequence(0x12345678, 7200);

/** The frame's CRC-16 (reflected 0x8408, initial 0x3692). */
export function frameCrc(b: ArrayLike<number>, n = b.length): number {
  let c = 0x3692;
  for (let i = 0; i < n; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return c & 0xffff;
}

export interface DroneIdFrame {
  serial: string; seq: number; state: number; version: number;
  lat?: number; lon?: number; height: number; altitude: number;
  vNorth: number; vEast: number; vUp: number; yaw: number;
  appTime: number; pilotLat?: number; pilotLon?: number; homeLat?: number; homeLon?: number;
  productType: number; uuid: string; crcOk: boolean;
}

const RAD = 180 / Math.PI;
/**
 * Reads a frame (the length byte first). Offsets: 0 length, 1 type, 2 version, 3 sequence, 5 state, 7 serial (16),
 * 23 longitude, 27 latitude, 31 height, 33 altitude, 35 / 37 / 39 velocity north / east / up, 41 yaw, 43 app GPS time
 * (8), 51 / 55 pilot latitude / longitude, 59 / 63 home longitude / latitude, 67 product type, 68 UUID length, 69 UUID
 * (19), 88 a zero, 89 CRC-16.
 */
export function parseFrame(b: Uint8Array): DroneIdFrame | null {
  const len = b[0]; if (len < 60 || len + 3 > b.length || b[1] !== 0x10) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const i16 = (o: number) => dv.getInt16(o, true), i32 = (o: number) => dv.getInt32(o, true);
  const coord = (o: number, lim: number) => { const v = i32(o); if (v === 0) return undefined; const d = v / 1e7 * RAD; return Math.abs(d) <= lim ? Math.round(d * 1e7) / 1e7 : undefined; };
  const text = (a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n).filter(c => c >= 0x20 && c < 0x7f)).trim();
  const lon = coord(23, 180), lat = coord(27, 90), both = lat !== undefined && lon !== undefined;
  return {
    serial: text(7, 16), seq: dv.getUint16(3, true), state: dv.getUint16(5, true), version: b[2],
    lat: both ? lat : undefined, lon: both ? lon : undefined,
    height: i16(31), altitude: i16(33), vNorth: i16(35), vEast: i16(37), vUp: i16(39), yaw: i16(41),
    appTime: Number(dv.getBigUint64(43, true)), pilotLat: coord(51, 90), pilotLon: coord(55, 180), homeLon: coord(59, 180), homeLat: coord(63, 90),
    productType: b[67], uuid: text(69, Math.min(b[68], 19)), crcOk: frameCrc(b, len + 1) === dv.getUint16(len + 1, true),
  };
}

// ---------------------------------------------------------------------------------------------------- receiver

/** One burst's samples (interleaved I/Q, at 15.36 MS/s) → the 176 decoded bytes (CRC-24A good), or null. */
export function decodeBurst(x: Float32Array, start: number, cfoHz: number): Uint8Array | null {
  const re = new Float32Array(N), im = new Float32Array(N), Y: Float64Array[] = [];
  const w = -2 * Math.PI * cfoHz / DRONEID_RATE;
  for (let s = 0; s < 9; s++) {
    const o = start + SYM_START[s] + CP[s] - 4;            // a few samples into the CP: a small linear phase, which the channel takes up
    for (let n = 0; n < N; n++) {
      const k = o + n, a = x[2 * k], b = x[2 * k + 1], ph = w * k, c = Math.cos(ph), sn = Math.sin(ph);
      re[n] = a * c - b * sn; im[n] = a * sn + b * c;
    }
    fftInPlace(re, im, false);
    const y = new Float64Array(2 * CARRIERS); for (let i = 0; i < CARRIERS; i++) { y[2 * i] = re[BIN[i]]; y[2 * i + 1] = im[BIN[i]]; }
    Y.push(y);
  }
  // the channel at symbols 4 and 6 (index 3 and 5), smoothed over 9 carriers, and drawn as a line through the others
  const chan = (y: Float64Array, z: Float64Array) => {
    const h = new Float64Array(2 * CARRIERS);
    for (let i = 0; i < CARRIERS; i++) { h[2 * i] = y[2 * i] * z[2 * i] + y[2 * i + 1] * z[2 * i + 1]; h[2 * i + 1] = y[2 * i + 1] * z[2 * i] - y[2 * i] * z[2 * i + 1]; }
    const sm = new Float64Array(2 * CARRIERS);
    for (let i = 0; i < CARRIERS; i++) { let r = 0, q = 0, n = 0; for (let j = Math.max(0, i - 4); j <= Math.min(CARRIERS - 1, i + 4); j++) { r += h[2 * j]; q += h[2 * j + 1]; n++; } sm[2 * i] = r / n; sm[2 * i + 1] = q / n; }
    return sm;
  };
  const H4 = chan(Y[3], ZC4), H6 = chan(Y[5], ZC6);
  const llr = new Float32Array(7200);
  DATA_SYMBOLS.forEach((s, row) => {
    const t = (s - 3) / 2, y = Y[s];
    for (let i = 0; i < CARRIERS; i++) {
      const hr = H4[2 * i] + (H6[2 * i] - H4[2 * i]) * t, hi = H4[2 * i + 1] + (H6[2 * i + 1] - H4[2 * i + 1]) * t, m = hr * hr + hi * hi || 1e-12;
      const er = (y[2 * i] * hr + y[2 * i + 1] * hi) / m, ei = (y[2 * i + 1] * hr - y[2 * i] * hi) / m;
      const k = row * 1200 + 2 * i, rel = Math.sqrt(m);
      // LLR = ln P(0)/P(1): a 0 sits on +1/√2; weighted by the channel's strength there
      llr[k] = (SCRAMBLE[k] ? -1 : 1) * er * rel * 4; llr[k + 1] = (SCRAMBLE[k + 1] ? -1 : 1) * ei * rel * 4;
    }
  });
  const [f1, f2] = QPP_PARAMS[1408], d = rateDematch(llr, 1412, 0), bits = turboDecode(d, 1408, f1, f2, 8), bytes = toBytes(bits);
  return crc24a(bytes) === 0 ? bytes : null;
}

/** Correlation of a window with symbol 4's time-domain samples, by FFT: its peak is where symbol 4's FFT window starts. */
let zc4Time: Float32Array | null = null;
function zc4Samples(): Float32Array {
  if (zc4Time) return zc4Time;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < CARRIERS; i++) { re[BIN[i]] = ZC4[2 * i]; im[BIN[i]] = ZC4[2 * i + 1]; }
  fftInPlace(re, im, true);
  zc4Time = new Float32Array(2 * N); for (let n = 0; n < N; n++) { zc4Time[2 * n] = re[n]; zc4Time[2 * n + 1] = im[n]; }
  return zc4Time;
}
export function findBurst(x: Float32Array, from: number, to: number): { start: number; score: number } | null {
  const L = 16384, z = zc4Samples(), sre = new Float32Array(L), sim = new Float32Array(L), zre = new Float32Array(L), zim = new Float32Array(L);
  const n = Math.min(L, to - from);
  for (let i = 0; i < n; i++) { sre[i] = x[2 * (from + i)]; sim[i] = x[2 * (from + i) + 1]; }
  for (let i = 0; i < N; i++) { zre[i] = z[2 * i]; zim[i] = z[2 * i + 1]; }
  fftInPlace(sre, sim, false); fftInPlace(zre, zim, false);
  for (let i = 0; i < L; i++) { const a = sre[i], b = sim[i], c = zre[i], d = -zim[i]; sre[i] = a * c - b * d; sim[i] = a * d + b * c; }
  fftInPlace(sre, sim, true);
  let best = -1, bv = 0, sum = 0;
  for (let i = 0; i + N <= n; i++) { const v = sre[i] * sre[i] + sim[i] * sim[i]; sum += v; if (v > bv) { bv = v; best = i; } }
  const mean = sum / Math.max(1, n - N);
  if (best < 0 || bv < 30 * mean) return null;
  const start = from + best - (SYM_START[3] + CP[3]);
  return start >= 0 ? { start, score: bv / mean } : null;
}
/** The frequency offset from the cyclic prefixes (±7.5 kHz), then a whole number of 15 kHz carriers from symbol 4. */
export function estimateCfo(x: Float32Array, start: number): number {
  let r = 0, q = 0;
  for (let s = 0; s < 9; s++) for (let n = 0; n < CP[s] - 8; n++) {
    const a = start + SYM_START[s] + 4 + n, b = a + N, ar = x[2 * a], ai = x[2 * a + 1], br = x[2 * b], bi = x[2 * b + 1];
    r += ar * br + ai * bi; q += ar * bi - ai * br;
  }
  const frac = Math.atan2(q, r) * DRONEID_RATE / (2 * Math.PI * N);
  // whole carriers: symbol 4 after the fractional correction, against the Zadoff-Chu sequence shifted by -8..8 carriers
  const re = new Float32Array(N), im = new Float32Array(N), w = -2 * Math.PI * frac / DRONEID_RATE, o = start + SYM_START[3] + CP[3] - 4;
  for (let n = 0; n < N; n++) { const k = o + n, ph = w * k, c = Math.cos(ph), sn = Math.sin(ph); re[n] = x[2 * k] * c - x[2 * k + 1] * sn; im[n] = x[2 * k] * sn + x[2 * k + 1] * c; }
  fftInPlace(re, im, false);
  let bestS = 0, bestV = -1;
  for (let sh = -8; sh <= 8; sh++) {
    let ar = 0, ai = 0, prevr = 0, previ = 0;
    // differential across neighbouring carriers, so a timing offset's phase slope does not matter
    for (let i = 0; i < CARRIERS; i++) {
      const bin = (BIN[i] + sh + N) % N, yr = re[bin], yi = im[bin], pr = yr * ZC4[2 * i] + yi * ZC4[2 * i + 1], pi = yi * ZC4[2 * i] - yr * ZC4[2 * i + 1];
      if (i) { ar += pr * prevr + pi * previ; ai += pi * prevr - pr * previ; }
      prevr = pr; previ = pi;
    }
    const v = ar * ar + ai * ai; if (v > bestV) { bestV = v; bestS = sh; }
  }
  return frac + bestS * 15_000;
}

/**
 * The receiver on a stream of int8 I/Q at 15.36 MS/s: a burst is a rise in power for about 0.64 ms; each one is
 * located by its Zadoff-Chu symbol, corrected for frequency and decoded.
 */
export class DroneIdRx {
  onFrame: (f: DroneIdFrame, raw: Uint8Array, info: { cfoHz: number; score: number }) => void = () => undefined;
  bursts = 0; decoded = 0;
  private buf = new Float32Array(2 * 65536); private len = 0; private floor = 0; private hold = 0;
  push(iq: Int8Array): void {
    const n = iq.length >> 1;
    if (2 * (this.len + n) > this.buf.length) { const b = new Float32Array(Math.max(this.buf.length * 2, 2 * (this.len + n))); b.set(this.buf.subarray(0, 2 * this.len)); this.buf = b; }
    for (let i = 0; i < 2 * n; i++) this.buf[2 * this.len + i] = iq[i] / 128;
    this.len += n;
    this.scan();
  }
  private scan(): void {
    const B = 256, x = this.buf;
    let i = this.hold;
    for (; i + B <= this.len; i += B) {
      let p = 0; for (let k = i; k < i + B; k++) p += x[2 * k] * x[2 * k] + x[2 * k + 1] * x[2 * k + 1];
      p /= B;
      if (!this.floor) this.floor = p;
      if (p > 2 * this.floor) {   // 3 dB over the floor (a 256-sample average of noise varies by about 1/16)
        // a burst: wait for all of it (and a margin), then look for it
        const from = Math.max(0, i - 2048), to = i + BURST_LEN + 4096;
        if (to > this.len) break;
        this.bursts++;
        const f = findBurst(x, from, to);
        if (f) {
          const cfo = estimateCfo(x, f.start), bytes = decodeBurst(x, f.start, cfo);
          if (bytes) { const fr = parseFrame(bytes); if (fr) { this.decoded++; this.onFrame(fr, bytes, { cfoHz: cfo, score: f.score }); } }
        }
        i = to - B; continue;
      }
      this.floor += 0.02 * (p - this.floor);
    }
    // keep the tail that has not been looked at
    const keep = Math.max(0, i - 4096);
    x.copyWithin(0, 2 * keep, 2 * this.len); this.len -= keep; this.hold = i - keep;
  }
}

// ---------------------------------------------------------------------------------------------------- test transmitter

/** A frame as a drone builds it (the length byte, the fields, a zero, the CRC-16), 91 bytes (offsets as parseFrame). */
export function buildFrame(f: { serial: string; seq?: number; state?: number; lat: number; lon: number; height: number; altitude: number; vNorth?: number; vEast?: number; vUp?: number; yaw?: number; appTime?: number; pilotLat: number; pilotLon: number; homeLat: number; homeLon: number; productType?: number; uuid?: string }): Uint8Array {
  const b = new Uint8Array(91), dv = new DataView(b.buffer), rad = (d: number) => Math.round(d / RAD * 1e7);
  b[0] = 88; b[1] = 0x10; b[2] = 2; dv.setUint16(3, f.seq ?? 0, true); dv.setUint16(5, f.state ?? 0, true);
  for (let i = 0; i < 16; i++) b[7 + i] = i < f.serial.length ? f.serial.charCodeAt(i) : 0;
  dv.setInt32(23, rad(f.lon), true); dv.setInt32(27, rad(f.lat), true);
  dv.setInt16(31, f.height, true); dv.setInt16(33, f.altitude, true); dv.setInt16(35, f.vNorth ?? 0, true); dv.setInt16(37, f.vEast ?? 0, true); dv.setInt16(39, f.vUp ?? 0, true); dv.setInt16(41, f.yaw ?? 0, true);
  dv.setBigUint64(43, BigInt(f.appTime ?? 0), true);
  dv.setInt32(51, rad(f.pilotLat), true); dv.setInt32(55, rad(f.pilotLon), true); dv.setInt32(59, rad(f.homeLon), true); dv.setInt32(63, rad(f.homeLat), true);
  b[67] = f.productType ?? 0; const u = f.uuid ?? ''; b[68] = u.length; for (let i = 0; i < 19; i++) b[69 + i] = i < u.length ? u.charCodeAt(i) : 0;
  dv.setUint16(89, frameCrc(b, 89), true);
  return b;
}
/** The burst's complex samples (interleaved, unit power) for a frame, at 15.36 MS/s. */
export function buildBurst(frame: Uint8Array): Float32Array {
  const block = new Uint8Array(176); block.set(frame.subarray(0, 91)); const c = crc24a(block, 173); block[173] = c >> 16; block[174] = (c >> 8) & 255; block[175] = c & 255;
  const [f1, f2] = QPP_PARAMS[1408], e = rateMatch(turboEncode(toBits(block), 1408, f1, f2), 7200, 0);
  const rows: Uint8Array[] = [SCRAMBLE.subarray(0, 1200)];
  for (let r = 0; r < 6; r++) { const v = new Uint8Array(1200); for (let i = 0; i < 1200; i++) v[i] = e[r * 1200 + i] ^ SCRAMBLE[r * 1200 + i]; rows.push(v); }
  const out = new Float32Array(2 * BURST_LEN), a = Math.SQRT1_2;
  let row = 0;
  for (let s = 0; s < 9; s++) {
    const re = new Float32Array(N), im = new Float32Array(N);
    if (s === 3 || s === 5) { const z = s === 3 ? ZC4 : ZC6; for (let i = 0; i < CARRIERS; i++) { re[BIN[i]] = z[2 * i]; im[BIN[i]] = z[2 * i + 1]; } }
    else { const v = rows[row++]; for (let i = 0; i < CARRIERS; i++) { re[BIN[i]] = v[2 * i] ? -a : a; im[BIN[i]] = v[2 * i + 1] ? -a : a; } }
    fftInPlace(re, im, true);
    const scale = Math.sqrt(N * N / CARRIERS), o = SYM_START[s];
    for (let n = 0; n < CP[s]; n++) { out[2 * (o + n)] = re[N - CP[s] + n] * scale; out[2 * (o + n) + 1] = im[N - CP[s] + n] * scale; }
    for (let n = 0; n < N; n++) { out[2 * (o + CP[s] + n)] = re[n] * scale; out[2 * (o + CP[s] + n) + 1] = im[n] * scale; }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- worker processor

/** The Drones app's processor: frames to the page as 'droneid', a log line each, and a warning at the wrong rate. */
export class DroneIdProcessor implements IqProcessor {
  private rx = new DroneIdRx(); private warned = false;
  constructor(private readonly emit: Emit) { this.wire(); }
  private wire(): void {
    this.rx.onFrame = (f, raw, info) => {
      this.emit({ type: 'droneid', frame: f, cfoHz: Math.round(info.cfoHz), bursts: this.rx.bursts, decoded: this.rx.decoded });
      this.emit({ type: 'packet', line: `DroneID ${f.serial || '(no serial)'} seq ${f.seq}${f.lat !== undefined ? ` · ${f.lat.toFixed(5)}, ${f.lon!.toFixed(5)}` : ' · no position'} · height ${f.height} · ${Array.from(raw.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('')}…` });
    };
  }
  reset(): void { this.rx = new DroneIdRx(); this.wire(); this.warned = false; }
  clear(): void { this.rx = new DroneIdRx(); this.wire(); }
  onIq(iq: Int8Array, rate: number): void {
    if (Math.abs(rate - DRONEID_RATE) > 1000) {
      if (!this.warned) { this.warned = true; this.emit({ type: 'log', line: `DroneID needs ${DRONEID_RATE / 1e6} MS/s; this stream is ${(rate / 1e6).toFixed(2)} MS/s` }); }
      return;
    }
    const before = this.rx.bursts;
    this.rx.push(iq);
    if (this.rx.bursts !== before) this.emit({ type: 'droneidStats', bursts: this.rx.bursts, decoded: this.rx.decoded });
  }
}
