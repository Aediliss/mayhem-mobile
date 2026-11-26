/**
 * FORK: the LTE turbo code and its rate matching (3GPP TS 36.212 5.1.3.2 and 5.1.4.1), written from the specification;
 * DJI DroneID uses them as LTE does. Receive side: a max-log-MAP turbo decoder. The encoder and the rate matcher are here
 * for the tests (and are what the decoder undoes). The one table value used, the QPP interleaver for K = 1408
 * (f1 = 43, f2 = 88, Table 5.1.3-3), was checked against turbofec (GPL-3.0-or-later). No DOM.
 *
 * Bits are 0/1 numbers; soft values are log-likelihood ratios L = ln P(0) / P(1) (positive: a 0).
 */

/** CRC-24A (generator 0x864CFB, no initial value, no reflection) over bytes; 0 over a block that carries its CRC. */
export function crc24a(b: ArrayLike<number>, n = b.length): number {
  let r = 0;
  for (let i = 0; i < n; i++) { r ^= b[i] << 16; for (let k = 0; k < 8; k++) { r <<= 1; if (r & 0x1000000) r ^= 0x1864cfb; } }
  return r & 0xffffff;
}

/** The QPP interleaver Π(i) = (f1·i + f2·i²) mod K. */
export function qpp(K: number, f1: number, f2: number): Int32Array {
  const p = new Int32Array(K);
  for (let i = 0; i < K; i++) p[i] = Number((BigInt(f1) * BigInt(i) + BigInt(f2) * BigInt(i) * BigInt(i)) % BigInt(K));
  return p;
}
/** Table 5.1.3-3 entries in use. */
export const QPP_PARAMS: Record<number, [number, number]> = { 1408: [43, 88], 40: [3, 10] };

// one constituent encoder: g0 = 1 + D² + D³ (feedback), g1 = 1 + D + D³; state (s1 s2 s3) as s1·4 + s2·2 + s3
const NEXT = new Int8Array(16), PAR = new Int8Array(16);
for (let s = 0; s < 8; s++) for (let u = 0; u < 2; u++) {
  const s1 = (s >> 2) & 1, s2 = (s >> 1) & 1, s3 = s & 1, a = u ^ s2 ^ s3;
  NEXT[s * 2 + u] = (a << 2) | (s1 << 1) | s2; PAR[s * 2 + u] = a ^ s1 ^ s3;
}
/** The input that drives the register to zero from state s (termination), and the parity it gives. */
const tailIn = (s: number) => ((s >> 1) & 1) ^ (s & 1);

function rsc(c: ArrayLike<number>): { z: Uint8Array; tail: number[] } {
  const z = new Uint8Array(c.length); let s = 0;
  for (let i = 0; i < c.length; i++) { z[i] = PAR[s * 2 + c[i]]; s = NEXT[s * 2 + c[i]]; }
  const tail: number[] = [];
  for (let k = 0; k < 3; k++) { const u = tailIn(s); tail.push(u, PAR[s * 2 + u]); s = NEXT[s * 2 + u]; }
  return { z, tail };   // tail: x_K, z_K, x_K+1, z_K+1, x_K+2, z_K+2
}

/** Turbo encoding of K bits into the three streams d0, d1, d2 of K + 4 bits (with the 36.212 tail arrangement). */
export function turboEncode(c: ArrayLike<number>, K: number, f1: number, f2: number): [Uint8Array, Uint8Array, Uint8Array] {
  const pi = qpp(K, f1, f2), ci = new Uint8Array(K); for (let i = 0; i < K; i++) ci[i] = c[pi[i]];
  const e1 = rsc(c), e2 = rsc(ci), D = K + 4;
  const d0 = new Uint8Array(D), d1 = new Uint8Array(D), d2 = new Uint8Array(D);
  for (let k = 0; k < K; k++) { d0[k] = c[k]; d1[k] = e1.z[k]; d2[k] = e2.z[k]; }
  const [x0, z0, x1, z1, x2, z2] = e1.tail, [y0, w0, y1, w1, y2, w2] = e2.tail;
  d0.set([x0, z1, y0, w1], K); d1.set([z0, x2, w0, y2], K); d2.set([x1, z2, y1, w2], K);
  return [d0, d1, d2];
}

// ---------------------------------------------------------------------------------------------------- rate matching

const PERM = [0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30, 1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31];
/** Where each bit of the circular buffer w comes from: [stream, index in d] or [-1, -1] for a dummy bit. */
function bufferMap(D: number): { map: Int32Array; R: number } {
  const R = Math.ceil(D / 32), Kp = R * 32, nd = Kp - D, map = new Int32Array(3 * Kp * 2).fill(-1);
  const at = (stream: number, k: number) => {
    const y = stream === 2 ? (PERM[Math.floor(k / R)] + 32 * (k % R) + 1) % Kp : PERM[Math.floor(k / R)] + 32 * (k % R);
    return y < nd ? -1 : y - nd;
  };
  for (let k = 0; k < Kp; k++) {
    const p0 = at(0, k); if (p0 >= 0) { map[2 * k] = 0; map[2 * k + 1] = p0; }
    const p1 = at(1, k), p2 = at(2, k), w1 = Kp + 2 * k, w2 = w1 + 1;
    if (p1 >= 0) { map[2 * w1] = 1; map[2 * w1 + 1] = p1; }
    if (p2 >= 0) { map[2 * w2] = 2; map[2 * w2 + 1] = p2; }
  }
  return { map, R };
}
/** The E bits sent from the three streams (redundancy version rv, the whole circular buffer). */
export function rateMatch(d: [Uint8Array, Uint8Array, Uint8Array], E: number, rv = 0): Uint8Array {
  const D = d[0].length, { map, R } = bufferMap(D), Ncb = map.length / 2, k0 = R * (2 * Math.ceil(Ncb / (8 * R)) * rv + 2), e = new Uint8Array(E);
  for (let k = 0, j = 0; k < E; j++) { const w = (k0 + j) % Ncb, s = map[2 * w]; if (s >= 0) e[k++] = d[s][map[2 * w + 1]]; }
  return e;
}
/** E soft values back onto the three streams (repeats added up). */
export function rateDematch(e: ArrayLike<number>, D: number, rv = 0): [Float32Array, Float32Array, Float32Array] {
  const { map, R } = bufferMap(D), Ncb = map.length / 2, k0 = R * (2 * Math.ceil(Ncb / (8 * R)) * rv + 2);
  const d: [Float32Array, Float32Array, Float32Array] = [new Float32Array(D), new Float32Array(D), new Float32Array(D)];
  for (let k = 0, j = 0; k < e.length; j++) { const w = (k0 + j) % Ncb, s = map[2 * w]; if (s >= 0) d[s][map[2 * w + 1]] += e[k++]; }
  return d;
}

// ---------------------------------------------------------------------------------------------------- decoding

/** Max-log-MAP over one constituent code: a-posteriori LLRs of the K inputs (with the 3 tail steps). */
function bcjr(sys: Float32Array, par: Float32Array, la: Float32Array, tailSys: number[], tailPar: number[], K: number): Float32Array {
  const N = K + 3, NEG = -1e9, alpha = new Float32Array((N + 1) * 8).fill(NEG), beta = new Float32Array((N + 1) * 8).fill(NEG);
  const ls = (i: number) => (i < K ? sys[i] + la[i] : tailSys[i - K]), lp = (i: number) => (i < K ? par[i] : tailPar[i - K]);
  // branch metric for input u and parity p: half of (±L_s ± L_p), + for a 0
  const g = (i: number, u: number, p: number) => 0.5 * ((u ? -1 : 1) * ls(i) + (p ? -1 : 1) * lp(i));
  alpha[0] = 0;
  for (let i = 0; i < N; i++) for (let s = 0; s < 8; s++) {
    const a = alpha[i * 8 + s]; if (a <= NEG / 2) continue;
    for (let u = 0; u < 2; u++) { if (i >= K && u !== tailIn(s)) continue; const t = s * 2 + u, n = NEXT[t], v = a + g(i, u, PAR[t]); if (v > alpha[(i + 1) * 8 + n]) alpha[(i + 1) * 8 + n] = v; }
  }
  beta[N * 8] = 0;
  for (let i = N - 1; i >= 0; i--) for (let s = 0; s < 8; s++) {
    let best = NEG;
    for (let u = 0; u < 2; u++) { if (i >= K && u !== tailIn(s)) continue; const t = s * 2 + u, v = beta[(i + 1) * 8 + NEXT[t]] + g(i, u, PAR[t]); if (v > best) best = v; }
    beta[i * 8 + s] = best;
  }
  const out = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    let m0 = NEG, m1 = NEG;
    for (let s = 0; s < 8; s++) {
      const a = alpha[i * 8 + s]; if (a <= NEG / 2) continue;
      for (let u = 0; u < 2; u++) { const t = s * 2 + u, v = a + g(i, u, PAR[t]) + beta[(i + 1) * 8 + NEXT[t]]; if (u) { if (v > m1) m1 = v; } else if (v > m0) m0 = v; }
    }
    out[i] = m0 - m1;
  }
  return out;
}

/** Turbo decoding of the three soft streams (K + 4 each) into K bits. */
export function turboDecode(d: [Float32Array, Float32Array, Float32Array], K: number, f1: number, f2: number, iterations = 8): Uint8Array {
  const pi = qpp(K, f1, f2), [d0, d1, d2] = d;
  const sys = d0.subarray(0, K), p1 = d1.subarray(0, K), p2 = d2.subarray(0, K);
  // the tail, undone from the 36.212 arrangement: [x_K, x_K+1, x_K+2] and parities, for each encoder
  const t1s = [d0[K], d2[K], d1[K + 1]], t1p = [d1[K], d0[K + 1], d2[K + 1]];
  const t2s = [d0[K + 2], d2[K + 2], d1[K + 3]], t2p = [d1[K + 2], d0[K + 3], d2[K + 3]];
  const sysI = new Float32Array(K); for (let i = 0; i < K; i++) sysI[i] = sys[pi[i]];
  let la1 = new Float32Array(K), app1 = new Float32Array(K);
  const la2 = new Float32Array(K);
  for (let it = 0; it < iterations; it++) {
    app1 = bcjr(sys, p1, la1, t1s, t1p, K);
    for (let i = 0; i < K; i++) la2[i] = app1[pi[i]] - sys[pi[i]] - la1[pi[i]];
    const app2 = bcjr(sysI, p2, la2, t2s, t2p, K);
    const next = new Float32Array(K);
    for (let i = 0; i < K; i++) next[pi[i]] = app2[i] - sysI[i] - la2[i];
    la1 = next;
  }
  // the final decision: the first decoder once more, with the latest a-priori from the second
  const out = new Uint8Array(K), last = bcjr(sys, p1, la1, t1s, t1p, K);
  for (let i = 0; i < K; i++) out[i] = last[i] < 0 ? 1 : 0;
  return out;
}

/** Bytes to bits, MSB first, and back. */
export const toBits = (b: ArrayLike<number>) => { const o = new Uint8Array(b.length * 8); for (let i = 0; i < b.length; i++) for (let k = 0; k < 8; k++) o[i * 8 + k] = (b[i] >> (7 - k)) & 1; return o; };
export const toBytes = (bits: ArrayLike<number>) => { const o = new Uint8Array(bits.length >> 3); for (let i = 0; i < o.length; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; o[i] = v; } return o; };
