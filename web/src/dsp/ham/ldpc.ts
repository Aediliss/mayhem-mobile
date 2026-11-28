/**
 * FORK: a sparse LDPC code from WSJT-X's tables, and its belief-propagation decoder (log-domain sum-product, as WSJT-X's
 * bpdecode128_90 / decode240_74). Shared by FST4W (240,74) and MSK144 (128,90).
 */
export interface LdpcCode {
  /** Code length and number of checks. */
  n: number; m: number;
  /** The checks of each bit (MN, [colw] a bit, 1-based) and the bits of each check (NM, [roww] slots a check, 1-based). */
  mn: Uint8Array; nm: Uint8Array; nrw: Uint8Array; colw: number; roww: number;
}

/** How many parity checks [cw] fails. */
export function ldpcChecks(code: LdpcCode, cw: ArrayLike<number>): number {
  let bad = 0;
  for (let j = 0; j < code.m; j++) { let s = 0; for (let i = 0; i < code.nrw[j]; i++) s ^= cw[code.nm[j * code.roww + i] - 1]; bad += s; }
  return bad;
}

/** LLRs (> 0 means 1) → a codeword that passes every check (and [accept], if given), or null. With [earlyStop], gives
 *  up as bpdecode128_90 does: after 5 iterations, when 3 in a row did not lower the failed checks and more than 10 fail. */
export function ldpcBp(code: LdpcCode, llr: Float32Array, iters = 30, accept?: (cw: Uint8Array) => boolean, earlyStop = false): Uint8Array | null {
  const { n: N, m: M, mn, nm, nrw, colw: C, roww: R } = code;
  const tov = new Float32Array(C * N), th = new Float32Array(R * M), zn = new Float32Array(N), cw = new Uint8Array(N);
  let last = 0, still = 0;
  for (let iter = 0; iter <= iters; iter++) {
    for (let i = 0; i < N; i++) { let z = llr[i]; for (let k = 0; k < C; k++) z += tov[C * i + k]; zn[i] = z; cw[i] = z > 0 ? 1 : 0; }
    const bad = ldpcChecks(code, cw);
    if (bad === 0 && (!accept || accept(cw))) return cw;
    if (earlyStop && iter > 0) { still = bad - last < 0 ? 0 : still + 1; if (still >= 3 && iter >= 5 && bad > 10) return null; }
    last = bad;
    // messages to checks: the bit's total without what this check said
    for (let j = 0; j < M; j++) for (let i = 0; i < nrw[j]; i++) {
      const ib = nm[j * R + i] - 1; let t = zn[ib];
      for (let k = 0; k < C; k++) if (mn[C * ib + k] - 1 === j) t -= tov[C * ib + k];
      th[j * R + i] = Math.tanh(-t / 2);
    }
    // messages to bits: the product over the check's other bits
    for (let ib = 0; ib < N; ib++) for (let k = 0; k < C; k++) {
      const j = mn[C * ib + k] - 1; let p = 1;
      for (let i = 0; i < nrw[j]; i++) if (nm[j * R + i] - 1 !== ib) p *= th[j * R + i];
      tov[C * ib + k] = 2 * Math.atanh(Math.max(-0.999999, Math.min(0.999999, -p)));
    }
  }
  return null;
}

/** WSJT-X's generator hex rows (each [k] bits, MSB first in each hex digit) → rows of bits. */
export function ldpcGen(rows: readonly string[], k: number): Uint8Array[] {
  return rows.map(h => {
    const row = new Uint8Array(k);
    for (let j = 0; j < h.length; j++) { const v = parseInt(h[j], 16); for (let b = 0; b < 4; b++) { const col = 4 * j + b; if (col < k && (v >> (3 - b)) & 1) row[col] = 1; } }
    return row;
  });
}
/** Systematic encode: the [k] message bits, then one parity bit per generator row. */
export function ldpcEncode(gen: Uint8Array[], msg: ArrayLike<number>, k: number): Uint8Array {
  const cw = new Uint8Array(k + gen.length); for (let i = 0; i < k; i++) cw[i] = msg[i];
  gen.forEach((g, r) => { let s = 0; for (let j = 0; j < k; j++) s ^= g[j] & msg[j]; cw[k + r] = s; });
  return cw;
}
