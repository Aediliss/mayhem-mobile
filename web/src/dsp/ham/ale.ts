/**
 * FORK: 2G ALE (MIL-STD-188-141A / FED-STD-1045 automatic link establishment) on the HAM receiver's USB audio, receive
 * only. Written from the standard as NTIA/ITS's HF ALE simulator (a US Government work, public domain:
 * "HF ALE Simulator", fec.c / golay.c / ALEmodem.c and its test output) implements it:
 *  - 8-FSK, tones 750-2500 Hz every 250 Hz, 125 baud (8 ms), 3 bits a tone;
 *  - a 24-bit word: a 3-bit preamble (DATA 0, THRU 1, TO 2, TWAS 3, FROM 4, TIS 5, CMD 6, REP 7) and three 7-bit
 *    characters (the basic set: A-Z, 0-9, @ and ?);
 *  - each 12-bit half through the (24,12) extended Golay code (its generator matrix from golay.c), the second word's 12
 *    check bits inverted, the two interleaved bit by bit (A first, MSB first) with a stuff bit after: 49 bits, sent three
 *    times (147 bits, 49 tones, 392 ms) for a majority vote.
 * Receiver: 8 kHz; one-symbol Goertzel filters at the 8 tones every quarter symbol (four symbol phases), each phase's
 * tones as bits under both tone maps (natural and Gray, since the table is not in the simulator); at every symbol the last
 * 147 bits voted, de-interleaved and Golay-decoded; a word counts when both halves decode with at most one error, most
 * votes were unanimous, the preamble is one a call uses and the characters are in the basic set. Words are joined into
 * calls ("TO SAM / TIS JOE", soundings "TWAS JOE") and printed once.
 */
import { ftxShared } from './ft8.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000, SPS = 64, NT = 8;
export const ALE_PRE = { DATA: 0, THRU: 1, TO: 2, TWAS: 3, FROM: 4, TIS: 5, CMD: 6, REP: 7 } as const;
const PRE_NAME = ['DATA', 'THRU', 'TO', 'TWAS', 'FROM', 'TIS', 'CMD', 'REP'];
const BASIC = /^[A-Z0-9@?]{3}$/;

// ---- (24,12) extended Golay, golay.c's generator (one OCR slip in the scanned listing, the tenth row, fixed against the cyclic code x^11+x^9+x^7+x^6+x^5+x+1): row i is data bit 11 - i, parity in the low 12 bits ----
const GEN = [0o40005343, 0o20007622, 0o10006453, 0o4006166, 0o2006331, 0o1003155, 0o401467, 0o205570, 0o102674, 0o41336, 0o25615, 0o12707];
export function golayEncode(d: number): number { let w = 0; for (let i = 0; i < 12; i++) if ((d >> (11 - i)) & 1) w ^= GEN[i]; return w; }
/** Syndrome → (error pattern, weight) for every pattern of weight ≤ 3 (the code corrects 3). */
const SYN = (() => {
  const pat = new Int32Array(4096).fill(-1), wt = new Uint8Array(4096).fill(9);
  const put = (p: number, w: number) => { const s = (golayEncode(p >>> 12) ^ p) & 0xfff; if (w < wt[s]) { wt[s] = w; pat[s] = p; } };
  put(0, 0);
  for (let a = 0; a < 24; a++) { put(1 << a, 1); for (let b = a + 1; b < 24; b++) { put((1 << a) | (1 << b), 2); for (let c = b + 1; c < 24; c++) put((1 << a) | (1 << b) | (1 << c), 3); } }
  return { pat, wt };
})();
/** A received 24-bit Golay word → its 12 data bits, or -1 when it needs more than [maxErr] corrections. */
export function golayDecode(w: number, maxErr = 3): number {
  const s = (golayEncode(w >>> 12) ^ w) & 0xfff;
  if (SYN.wt[s] > maxErr) return -1;
  return ((w ^ SYN.pat[s]) >>> 12) & 0xfff;
}

export function aleWord(pre: number, chars: string): number {
  let w = pre & 7; for (let i = 0; i < 3; i++) w = (w << 7) | ((chars.charCodeAt(i) || 64) & 127);
  return w;
}
/** A 24-bit word → its 49 transmitted bits (A and B interleaved, the stuff bit last). */
export function aleBits49(word: number): number[] {
  const a = golayEncode(word >>> 12), b = golayEncode(word & 0xfff) ^ 0xfff, out: number[] = [];
  for (let i = 23; i >= 0; i--) out.push((a >> i) & 1, (b >> i) & 1);
  out.push(0);
  return out;
}
const gray = (n: number) => n ^ (n >> 1);
const UNGRAY = Array.from({ length: 8 }, (_, t) => [0, 1, 2, 3, 4, 5, 6, 7].find(n => gray(n) === t)!);
/** Words → tone indexes (0 = 750 Hz), each word's 49 bits three times. [grayMap]: tone n carries the tribit gray(n). */
export function aleTones(words: number[], grayMap = true): number[] {
  const tones: number[] = [];
  for (const w of words) {
    const b = aleBits49(w), bits = [...b, ...b, ...b];
    for (let i = 0; i < 147; i += 3) { const t = (bits[i] << 2) | (bits[i + 1] << 1) | bits[i + 2]; tones.push(grayMap ? UNGRAY[t] : t); }
  }
  return tones;
}
export function aleAudio(tones: number[], rate: number, amp = 1): Float32Array {
  const ns = rate / 125, out = new Float32Array(Math.round(tones.length * ns)); let ph = 0;
  for (let k = 0; k < out.length; k++) { out[k] = amp * Math.sin(ph); ph += 2 * Math.PI * (750 + 250 * tones[Math.min(tones.length - 1, Math.floor(k / ns))]) / rate; }
  return out;
}

/** Vote and decode 147 bits (oldest first) → the 24-bit word, or -1. */
export function aleDecode147(bits: ArrayLike<number>, minUnanimous = 40): number {
  let a = 0, b = 0, un = 0;
  for (let i = 0; i < 48; i++) {
    const s = bits[i] + bits[i + 49] + bits[i + 98];
    if (s === 0 || s === 3) un++;
    const m = s >= 2 ? 1 : 0;
    if (i & 1) b = (b << 1) | m; else a = (a << 1) | m;
  }
  if (un < minUnanimous) return -1;
  const ha = golayDecode(a, 1), hb = golayDecode(b ^ 0xfff, 1);
  return ha < 0 || hb < 0 ? -1 : (ha << 12) | hb;
}
const charsOf = (w: number) => String.fromCharCode((w >> 14) & 127, (w >> 7) & 127, w & 127);

/** One symbol phase under one tone map: its bits and when it last took a word (word sync). */
class Stream {
  readonly bits = new Uint8Array(147); n = 0; skip = 0;
  constructor(readonly grayMap: boolean) {}
}

export class AleDecoder implements DigitalDecoder {
  readonly name = 'ALE';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  /** Each word as it is taken (tests, and the log): preamble, characters, symbol time. */
  onWord: (pre: string, chars: string, at: number) => void = () => {};
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private readonly buf = new Float32Array(SPS); private bn = 0; private tick = 0; private ph = 0; private sym = 0;
  private readonly coef = Array.from({ length: NT }, (_, t) => 2 * Math.cos(2 * Math.PI * (750 + 250 * t) / FS));
  private streams: Stream[] = [];
  private lastWord = -1; private lastAt = -1e9;
  private call: { to: string[][]; from: string[]; how: string; at: number; cur: string[] | null; pos: number } | null = null;
  constructor() { this.reset(); }
  reset(): void { this.rs.reset(); this.streams = [0, 1, 2, 3].flatMap(() => [new Stream(false), new Stream(true)]); this.call = null; this.lastWord = -1; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => {
      this.buf[this.bn] = v; this.bn = (this.bn + 1) % SPS;
      if (++this.tick >= SPS / 4) { this.tick = 0; this.slice(); }
    });
    this.confidence = Math.max(0, this.confidence - n / 48_000 / 20);
    if (this.call && this.sym - this.call.at > 125 * 2) this.flush();
  }

  private slice(): void {
    let best = 0, bm = -1;
    for (let t = 0; t < NT; t++) {
      const c = this.coef[t]; let s1 = 0, s2 = 0;
      for (let j = 0; j < SPS; j++) { const s0 = this.buf[(this.bn + j) % SPS] + c * s1 - s2; s2 = s1; s1 = s0; }
      const m = s1 * s1 + s2 * s2 - c * s1 * s2; if (m > bm) { bm = m; best = t; }
    }
    const p = this.ph; this.ph = (this.ph + 1) % 4; if (p === 0) this.sym++;
    for (const s of [this.streams[2 * p], this.streams[2 * p + 1]]) {
      const tri = s.grayMap ? gray(best) : best;
      s.bits.copyWithin(0, 3); s.bits[144] = (tri >> 2) & 1; s.bits[145] = (tri >> 1) & 1; s.bits[146] = tri & 1;
      if (s.n < 49) { s.n++; continue; }
      if (s.skip > 0) { s.skip--; continue; }
      const w = aleDecode147(s.bits);
      if (w < 0) continue;
      const pre = w >>> 21, ch = charsOf(w);
      if (!BASIC.test(ch) || pre === ALE_PRE.CMD) continue;   // CMD words (LQA, AMD) use other sets: not read
      s.skip = 48;   // word sync: the next word starts 49 symbols on
      this.word(w, pre, ch);
    }
  }

  private word(w: number, pre: number, ch: string): void {
    const at = this.sym;
    if (w === this.lastWord && at - this.lastAt < 20) return;   // the same word from another phase or tone map
    this.lastWord = w; this.lastAt = at; this.confidence = 1;
    this.onWord(PRE_NAME[pre], ch, at);
    // an address is its first word's 3 characters plus DATA / REP words (longer addresses); a repeated call rewrites it
    const c = this.call;
    if (pre === ALE_PRE.TO || pre === ALE_PRE.THRU) {
      if (c && c.from.length) this.flush();
      const cc = this.call ?? (this.call = { to: [], from: [], how: '', at, cur: null, pos: 0 });
      let addr = cc.to.find(t => t[0] === ch); if (!addr) { addr = [ch]; cc.to.push(addr); }
      cc.cur = addr; cc.pos = 1; cc.at = at;
    } else if (pre === ALE_PRE.DATA || pre === ALE_PRE.REP) {
      if (c?.cur) { c.cur[c.pos++] = ch; c.at = at; }
    } else if (pre === ALE_PRE.TIS || pre === ALE_PRE.TWAS || pre === ALE_PRE.FROM) {
      const cc = this.call ?? (this.call = { to: [], from: [], how: '', at, cur: null, pos: 0 });
      if (cc.from.length && cc.from[0] !== ch) { this.flush(); this.word(w, pre, ch); return; }
      if (!cc.from.length) cc.from.push(ch);
      cc.how = PRE_NAME[pre]; cc.cur = cc.from; cc.pos = 1; cc.at = at;
    }
  }

  private flush(): void {
    const c = this.call; this.call = null; if (!c) return;
    const name = (parts: string[]) => parts.join('').replace(/@+$/, '');
    const to = c.to.map(name).join(' '), from = name(c.from);
    const line = from && !to ? `SOUNDING ${c.how} ${from}` : `TO ${to}${from ? ` ${c.how} ${from}` : ''}`;
    this.onText(line + '\n', 'ALE 2G');
  }
}
