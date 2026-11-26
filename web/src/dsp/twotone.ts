/**
 * FORK: two-tone sequential paging, identified (receive only). The upstream analog reader (dsp/hamid/analog.ts) finds
 * a page as tone A then tone B and gives their frequencies; this names them the way a dispatch card does:
 *
 *  · Motorola Quick Call II: 80 reed tones in groups 1-6, 10 and 11 (reed code = group digits + tone number, tone 0 is
 *    x10). The 3-digit cap code of groups 1-5 follows Motorola's general encoding plan: its first digit says the
 *    groups of tone A and tone B, the second the number of tone A, the third of tone B. Timings: individual call
 *    A 1 s + B 3 s, tone only A 0.4 s + B 0.8 s, battery save A 2.7 s + B 0.8 s, group call one tone for 8 s.
 *  · GE Type 99: three groups A, B, C of ten tones; its 3-digit code's hundreds digit gives the groups of the two
 *    tones, then their numbers. Timing A 1 s + B 1.5 s.
 *
 * Tables and timings from Midian Electronics' tone signaling charts (cross-checked for Quick Call II against the
 * PGHscanner / qsl.net k3fs table; the one difference, reed code 109, is 313.0 Hz in Midian's and 313.8 in the other:
 * either is matched). GE "Star" is a different (digital) format with no published description found: not read.
 */

/** Quick Call II reed groups: tones 1..9 then 0, Hz. */
const QC2: Record<string, number[]> = {
  '1': [349.0, 368.5, 389.0, 410.8, 433.7, 457.9, 483.5, 510.5, 539.0, 330.5],
  '2': [600.9, 634.5, 669.9, 707.3, 746.8, 788.5, 832.5, 879.0, 928.1, 569.1],
  '3': [296.5, 304.7, 313.0, 953.7, 979.9, 1006.9, 1034.7, 1063.2, 1092.4, 288.5],
  '4': [339.6, 358.6, 378.6, 399.8, 422.1, 445.7, 470.5, 496.8, 524.6, 321.7],
  '5': [584.8, 617.4, 651.9, 688.3, 726.8, 767.4, 810.2, 855.5, 903.2, 553.9],
  '6': [1153.4, 1185.2, 1217.8, 1251.4, 1285.8, 1321.2, 1357.6, 1395.0, 1433.4, 1122.5],
  '10': [1513.5, 1555.2, 1598.0, 1642.0, 1687.2, 1733.7, 1781.5, 1830.5, 1881.0, 1472.9],
  '11': [1989.0, 2043.8, 2094.5, 2155.6, 2212.2, 2271.7, 2334.6, 2401.0, 2468.2, 1930.2],
};
/** Reed codes per group, tones 1..9 then 0 (group 3's are not in order). */
const QC2_CODES: Record<string, number[]> = {
  '1': [111, 112, 113, 114, 115, 116, 117, 118, 119, 110], '2': [121, 122, 123, 124, 125, 126, 127, 128, 129, 120],
  '3': [108, 139, 109, 160, 130, 161, 131, 162, 189, 138], '4': [141, 142, 143, 144, 145, 146, 147, 148, 149, 140],
  '5': [151, 152, 153, 154, 155, 156, 157, 158, 159, 150], '6': [191, 192, 193, 194, 195, 196, 197, 198, 199, 190],
  '10': [171, 172, 173, 174, 175, 176, 177, 178, 179, 170], '11': [201, 202, 203, 204, 205, 206, 207, 208, 209, 200],
};
/** Motorola general encoding plan: first digit → [group of tone A, group of tone B]. */
const QC2_PLAN: Record<string, [string, string]> = {
  '1': ['1', '1'], '2': ['2', '2'], '3': ['1', '2'], '4': ['4', '4'], '5': ['5', '5'], '6': ['2', '1'], '7': ['4', '5'], '8': ['5', '4'], '9': ['2', '4'], '0': ['4', '2'], 'A': ['3', '3'],
};
/** GE Type 99 groups: tones 1..9 then 0, Hz. */
const GE99: Record<string, number[]> = {
  A: [592.5, 757.5, 802.5, 847.5, 892.5, 937.5, 547.5, 727.5, 637.5, 682.5],
  B: [607.5, 787.5, 832.5, 877.5, 922.5, 967.5, 517.5, 562.5, 697.5, 652.5],
  C: [712.5, 772.5, 817.5, 862.5, 907.5, 952.5, 532.5, 577.5, 622.5, 667.5],
};
/** GE Type 99: hundreds digit → [group of the first tone, of the second]. */
const GE99_PLAN: [string, string][] = [['A', 'A'], ['B', 'A'], ['B', 'B'], ['A', 'B'], ['C', 'C'], ['C', 'A'], ['C', 'B'], ['A', 'C'], ['B', 'C']];

/** How far a heard tone may be from the table: reed decoders are within about 1 %, the analog reader's estimate too. */
const TOL = 0.012;
const tone = (n: number) => String((n + 1) % 10);   // index 0..9 → tone number 1..9, 0

interface Hit { group: string; idx: number; hz: number; err: number }
function find(table: Record<string, number[]>, hz: number): Hit | null {
  let best: Hit | null = null;
  for (const [group, list] of Object.entries(table)) list.forEach((f, idx) => {
    const err = Math.abs(hz - f) / f;
    if (err <= TOL && (!best || err < best.err)) best = { group, idx, hz: f, err };
  });
  // reed code 109 is 313.0 Hz in one table and 313.8 in another
  if (!best && table === QC2 && Math.abs(hz - 313.8) / 313.8 <= TOL) best = { group: '3', idx: 2, hz: 313.0, err: 0 };
  return best;
}

export interface TwoToneId {
  system: 'Motorola QC-II' | 'GE Type 99';
  /** Individual call, tone only, battery save, or group call (one long tone). */
  kind: string;
  /** Motorola reed codes (A/B), or GE groups and tone numbers. */
  tones: string;
  /** The 3-digit code where the plan gives one. */
  code: string;
  /** One line for the log. */
  text: string;
}

const near = (ms: number, want: number, tol = 0.35) => Math.abs(ms - want) <= tol * want;
function qc2Kind(aMs: number, bMs: number): string {
  if (near(aMs, 1000) && near(bMs, 3000)) return 'individual call';
  if (near(aMs, 400, 0.5) && near(bMs, 800)) return 'tone only';
  if (near(aMs, 2700) && near(bMs, 800)) return 'battery save';
  return 'page';
}

/** Names a page of tone A then tone B (Hz, ms), or null when no table fits both tones. */
export function identifyTwoTone(aHz: number, bHz: number, aMs: number, bMs: number): TwoToneId | null {
  const qa = find(QC2, aHz), qb = find(QC2, bHz), ga = find(GE99, aHz), gb = find(GE99, bHz);
  const qcOk = !!(qa && qb), geOk = !!(ga && gb);
  // both tables can fit (their tones lie close in 550-970 Hz): GE's timing (A 1 s, B 1.5 s) decides, else the closer
  const useGe = geOk && (!qcOk || (near(aMs, 1000) && near(bMs, 1500, 0.2)) || (ga!.err + gb!.err < qa!.err + qb!.err && !near(bMs, 3000)));
  if (useGe) {
    const d = GE99_PLAN.findIndex(([x, y]) => x === ga!.group && y === gb!.group);
    const code = d >= 0 ? `${d}${tone(ga!.idx)}${tone(gb!.idx)}` : '';
    const tones = `${ga!.group}${tone(ga!.idx)}/${gb!.group}${tone(gb!.idx)}`;
    return { system: 'GE Type 99', kind: 'page', tones, code, text: `GE Type 99${code ? ` code ${code}` : ''} (tones ${tones})` };
  }
  if (!qcOk) return null;
  const ca = QC2_CODES[qa!.group][qa!.idx], cb = QC2_CODES[qb!.group][qb!.idx];
  const first = Object.entries(QC2_PLAN).find(([, [x, y]]) => x === qa!.group && y === qb!.group)?.[0];
  const code = first ? `${first}${tone(qa!.idx)}${tone(qb!.idx)}` : '';
  const kind = qc2Kind(aMs, bMs), tones = `${ca}/${cb}`;
  return { system: 'Motorola QC-II', kind, tones, code, text: `Motorola QC-II ${kind}${code ? ` cap code ${code}` : ''} (reeds ${tones})` };
}

/** A single tone held 6 s or more on a Quick Call II reed: the group call (8 s of one tone). */
export function identifyLongTone(hz: number, ms: number): TwoToneId | null {
  if (ms < 6000) return null;
  const q = find(QC2, hz); if (!q) return null;
  const reed = `${QC2_CODES[q.group][q.idx]}`;
  return { system: 'Motorola QC-II', kind: 'group call', tones: reed, code: '', text: `Motorola QC-II group call (reed ${reed}, ${(ms / 1000).toFixed(1)} s)` };
}

/** The Quick Call II tones of a cap code (test transmitter, and a lookup for the UI). */
export function qc2CapTones(code: string): [number, number] | null {
  const m = /^([0-9A])([0-9])([0-9])$/.exec(code.toUpperCase()); if (!m) return null;
  const [ga, gb] = QC2_PLAN[m[1]], ix = (d: string) => (Number(d) + 9) % 10;
  return [QC2[ga][ix(m[2])], QC2[gb][ix(m[3])]];
}
/** The GE Type 99 tones of a code (test transmitter). */
export function ge99Tones(code: string): [number, number] | null {
  const m = /^([0-8])([0-9])([0-9])$/.exec(code); if (!m) return null;
  const [ga, gb] = GE99_PLAN[Number(m[1])], ix = (d: string) => (Number(d) + 9) % 10;
  return [GE99[ga][ix(m[2])], GE99[gb][ix(m[3])]];
}
