/**
 * FORK: radio navigation aids, receive only. From ICAO Annex 10 Vol. I's published signal parameters; the VOR bearing as
 * PortaPack Mayhem's proc_vor_rx (GPL-3.0) measures it (the 30 Hz reference from the FM on the 9960 Hz subcarrier,
 * against the 30 Hz variable AM).
 *  - VOR (108–117.95 MHz): the radial (bearing from the station) and the Morse ident on 1020 Hz.
 *  - ILS localizer (108.10–111.95, odd tenths) and glide path (329.15–335.00, paired): the 90 Hz and 150 Hz depths, their
 *    difference (DDM, which side of the course) and sum (SDM); the localizer's ident.
 *  - DME (962–1213 MHz ground replies): pulse pairs (12 µs X, 30 µs Y), their rate, the ident sent as 1350 pairs a second
 *    keyed in Morse. Range needs an interrogation (a transmitter): not here.
 * Frequency pairings (localizer ↔ glide path ↔ DME channel) are ICAO's (checked against the FAA/RadioReference table).
 * No DOM.
 */
import { type Emit, type IqProcessor } from './core.js';
import { ChannelDecimator, ComplexFirDecimator, lowpassTaps } from './ham/filters.js';

// ------------------------------------------------------------------------------------------------------ channels

/** Localizer (MHz × 100) → glide path (MHz × 100). */
const LOC_GS: [number, number][] = [
  [10810, 33470], [10815, 33455], [10830, 33410], [10835, 33395], [10850, 32990], [10855, 32975], [10870, 33050], [10875, 33035],
  [10890, 32930], [10895, 32915], [10910, 33140], [10915, 33125], [10930, 33200], [10935, 33185], [10950, 33260], [10955, 33245],
  [10970, 33320], [10975, 33305], [10990, 33380], [10995, 33365], [11010, 33440], [11015, 33425], [11030, 33500], [11035, 33485],
  [11050, 32960], [11055, 32945], [11070, 33020], [11075, 33005], [11090, 33080], [11095, 33065], [11110, 33170], [11115, 33155],
  [11130, 33230], [11135, 33215], [11150, 33290], [11155, 33275], [11170, 33350], [11175, 33335], [11190, 33110], [11195, 33095],
];
const r2 = (hz: number) => Math.round(hz / 1e4);
export type NavKind = 'VOR' | 'LOC' | 'GS' | 'DME';
/** What a frequency is: VOR, localizer, glide path, DME reply; null outside the bands. */
export function navKind(hz: number): NavKind | null {
  const c = r2(hz);
  if (LOC_GS.some(p => p[0] === c)) return 'LOC';
  if (LOC_GS.some(p => p[1] === c)) return 'GS';
  if (c >= 10800 && c <= 11795 && c % 5 === 0) return 'VOR';
  if (hz >= 961.5e6 && hz <= 1213.5e6) return 'DME';
  return null;
}
/** The glide path paired with a localizer, or the localizer with a glide path (Hz). */
export function pairedIls(hz: number): number | null {
  const c = r2(hz), p = LOC_GS.find(x => x[0] === c || x[1] === c);
  return p ? (p[0] === c ? p[1] : p[0]) * 1e4 : null;
}
/** The DME channel paired with a VOR or localizer (or glide path), and its ground reply frequency. */
export function dmeFor(hz: number): { ch: string; replyHz: number } | null {
  let c = r2(hz);
  const loc = LOC_GS.find(x => x[1] === c); if (loc) c = loc[0];
  if (c < 10800 || c > 11795) return null;
  const y = c % 10 === 5, base = c - (y ? 5 : 0);
  const n = base <= 11220 ? 17 + (base - 10800) / 10 : 70 + (base - 11230) / 10;
  if (!Number.isInteger(n)) return null;
  // X: replies 962-1024 (1-63) and 1151-1213 (64-126); Y: 1088-1150 (1-63) and 1025-1087 (64-126)
  const reply = n <= 63 ? (y ? 1088 + n - 1 : 962 + n - 1) : (y ? 1025 + n - 64 : 1151 + n - 64);
  return { ch: `${n}${y ? 'Y' : 'X'}`, replyHz: reply * 1e6 };
}

// ------------------------------------------------------------------------------------------------ measurements

/** Σ x·e^{-j2πft/fs} over the window, as [re, im]. */
function tone(x: Float32Array, n: number, f: number, fs: number, delay = 0): [number, number] {
  let re = 0, im = 0; const w = 2 * Math.PI * f / fs;
  for (let i = 0; i < n; i++) { const a = w * (i - delay); re += x[i] * Math.cos(a); im -= x[i] * Math.sin(a); }
  return [re, im];
}
const mean = (x: Float32Array, n: number) => { let s = 0; for (let i = 0; i < n; i++) s += x[i]; return s / n; };
/** Depth of an AM tone (0-1) in an envelope: twice its amplitude over the carrier. */
export function amDepth(x: Float32Array, n: number, f: number, fs: number): number {
  const m = mean(x, n), [re, im] = tone(x, n, f, fs); return m > 0 ? 2 * Math.hypot(re, im) / n / m : 0;
}

export interface VorReading { bearingDeg: number; varDepth: number; refDevHz: number; ok: boolean }
/** A VOR's radial from an AM envelope (a whole number of 30 Hz periods is best). */
export function vorBearing(env: Float32Array, n: number, fs: number): VorReading {
  // the 9960 Hz subcarrier: down to 0 Hz, a linear-phase low-pass, its instantaneous frequency
  const taps = lowpassTaps(900 / fs, 2 * Math.round(fs / 300) + 1), half = (taps.length - 1) / 2, w = 2 * Math.PI * 9960 / fs;
  const m = mean(env, n), sr = new Float32Array(n), si = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = env[i] - m; sr[i] = v * Math.cos(w * i); si[i] = -v * Math.sin(w * i); }
  const fr = new Float32Array(n), fi = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0, b = 0; for (let k = 0; k < taps.length; k++) { const j = i + k - half; if (j < 0 || j >= n) continue; a += taps[k] * sr[j]; b += taps[k] * si[j]; } fr[i] = a; fi[i] = b; }
  const fm = new Float32Array(n);
  for (let i = 1; i < n; i++) fm[i] = Math.atan2(fi[i] * fr[i - 1] - fr[i] * fi[i - 1], fr[i] * fr[i - 1] + fi[i] * fi[i - 1]) * fs / (2 * Math.PI);
  // the discriminator lags half a sample; skip the filter's edges (a whole number of 30 Hz periods kept)
  const per = fs / 30, skip = Math.ceil(half / per) * per, cnt = Math.floor((n - 2 * skip) / per) * per;
  if (cnt < per * 3) return { bearingDeg: 0, varDepth: 0, refDevHz: 0, ok: false };
  const a0 = Math.round(skip), N = Math.round(cnt);
  const ref = tone(fm.subarray(a0, a0 + N), N, 30, fs, -a0 + 0.5), vr = tone(env.subarray(a0, a0 + N), N, 30, fs, -a0);
  const varDepth = 2 * Math.hypot(...vr) / N / (m || 1), refDevHz = 2 * Math.hypot(...ref) / N;
  let deg = (Math.atan2(ref[1], ref[0]) - Math.atan2(vr[1], vr[0])) * 180 / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return { bearingDeg: Math.round(deg * 10) / 10, varDepth: Math.round(varDepth * 1000) / 1000, refDevHz: Math.round(refDevHz), ok: varDepth > 0.15 && refDevHz > 250 };
}

export interface IlsReading { m90: number; m150: number; ddm: number; sdm: number }
/** ILS: 90 and 150 Hz depths, DDM = m90 − m150, SDM = m90 + m150. */
export function ilsReading(env: Float32Array, n: number, fs: number): IlsReading {
  const m90 = amDepth(env, n, 90, fs), m150 = amDepth(env, n, 150, fs), r = (v: number) => Math.round(v * 10000) / 10000;
  return { m90: r(m90), m150: r(m150), ddm: r(m90 - m150), sdm: r(m90 + m150) };
}

// ----------------------------------------------------------------------------------------------------- ident

const MORSE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M',
  '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
};
/** Morse from an on/off key sampled at `rate` per second: idents (2-5 characters) between long silences. */
export class MorseKey {
  onIdent: (text: string) => void = () => undefined;
  private runs: [boolean, number][] = []; private state = false; private len = 0;
  constructor(private readonly rate: number) {}
  push(on: boolean): void {
    if (on === this.state) { this.len++; if (!on && this.len === Math.round(this.rate * 1.2) && this.runs.length) this.flush(); return; }
    this.runs.push([this.state, this.len]); this.state = on; this.len = 1;
  }
  private flush(): void {
    const runs = this.runs; this.runs = [];
    const marks = runs.filter(r => r[0]).map(r => r[1]);
    if (marks.length < 2) return;
    // the dot: the shorter of the two mark lengths (all of them when every mark is the same)
    const lo = Math.min(...marks), short = marks.filter(m => m < 2 * lo), dot = short.reduce((a, b) => a + b, 0) / short.length;
    let sym = '', text = '';
    for (const [on, l] of runs) {
      if (on) sym += l > 2 * dot ? '-' : '.';
      else if (l > 2 * dot && sym) { text += MORSE[sym] ?? '?'; sym = ''; }
    }
    if (sym) text += MORSE[sym] ?? '?';
    if (text.length >= 2 && text.length <= 5 && !text.includes('?')) this.onIdent(text);
  }
}

/** The ident tone's key from an AM envelope: 1020 Hz power against its own floor and peak, 100 decisions a second. */
export class IdentTone {
  readonly key: MorseKey; private readonly step: number; private hi = 0; private lo = 0;
  private ph = 0; private cr = 0; private ci = 0; private k = 0; private readonly w: number; private dc = 0; private readonly dcA: number;
  constructor(fs: number, toneHz = 1020) { this.step = Math.round(fs / 100); this.w = 2 * Math.PI * toneHz / fs; this.key = new MorseKey(100); this.dcA = 1 / (fs * 0.02); }
  push(env: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      // the carrier's level taken off first: left in, it leaks into every 10 ms sum at a phase that turns 0.2 of a cycle
      // each time, and beats with the tone
      this.dc += (env[i] - this.dc) * this.dcA; const v = env[i] - this.dc;
      this.cr += v * Math.cos(this.ph); this.ci -= v * Math.sin(this.ph); this.ph += this.w; if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
      if (++this.k < this.step) continue;
      const p = Math.hypot(this.cr, this.ci) / this.step; this.cr = this.ci = 0; this.k = 0;
      this.hi = Math.max(p, this.hi * 0.995); this.lo = this.lo ? Math.min(p, this.lo * 1.002 + 1e-9) : p;
      this.key.push(this.hi > 4 * this.lo && p > (this.hi + this.lo) / 2);
    }
  }
}

// -------------------------------------------------------------------------------------------------------- DME

export interface DmeReading { pairsPerS: number; mode: 'X' | 'Y' | ''; spacingUs: number; identOn: boolean }
/** DME ground replies in |IQ|² at fs: pulses, pairs (12 µs X, 30 µs Y), and 1350 pair/s ident keying. */
export class DmeRx {
  readonly key = new MorseKey(100);
  private floor = 0; private seen = 0; private last = -1e9; private pk = 0; private pkAt = -1; private above = false;
  private pulses: number[] = []; private pairs: number[] = []; private nx = 0; private ny = 0;
  private win = 0; private winPairs: number[] = [];
  constructor(private readonly fs: number) {}
  push(p: Float32Array, n: number): void {
    const fs = this.fs, us = fs / 1e6;
    for (let i = 0; i < n; i++, this.seen++) {
      const v = p[i];
      // the noise: the first 2000 samples' mean, then a slow average that pulses cannot pull up (clipped at 3× floor)
      if (this.seen < 2000) { this.floor += v / 2000; if (this.seen < 1999) continue; }
      this.floor += 1e-4 * (Math.min(v, 3 * this.floor) - this.floor);
      const on = v > this.floor * 20;
      if (on) { if (!this.above || v > this.pk) { this.pk = v; this.pkAt = this.seen; } this.above = true; }
      else if (this.above) { this.above = false; this.pulse(this.pkAt / us); this.pk = 0; }
      if (++this.win >= fs / 100) { this.win = 0; this.tick(); }
    }
  }
  private pulse(tUs: number): void {
    // a pair: this pulse 12 or 30 µs after the one before
    const d = tUs - this.last; this.last = tUs;
    if (Math.abs(d - 12) <= 1.5) { this.nx++; this.pairs.push(tUs); this.winPairs.push(tUs); }
    else if (Math.abs(d - 30) <= 1.5) { this.ny++; this.pairs.push(tUs); this.winPairs.push(tUs); }
    this.pulses.push(tUs); if (this.pulses.length > 4000) this.pulses.splice(0, 2000);
    if (this.pairs.length > 8000) this.pairs.splice(0, 4000);
  }
  /** Every 10 ms: is the ident's regular 1350 pairs/s there? (pairs 740.7 µs apart, beside the random squitter) */
  private tick(): void {
    const t = this.winPairs; let reg = 0;
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length && t[j] - t[i] < 1600; j++) if (Math.abs(t[j] - t[i] - 740.74) < 3) { reg++; break; }
    this.key.push(t.length >= 6 && reg >= 0.6 * Math.min(t.length, 13));
    this.winPairs = [];
  }
  reading(sinceUs: number): DmeReading {
    const now = this.seen / (this.fs / 1e6), recent = this.pairs.filter(t => t > now - sinceUs).length;
    const mode = this.nx + this.ny < 5 ? '' : this.nx >= this.ny ? 'X' : 'Y';
    return { pairsPerS: Math.round(recent / (sinceUs / 1e6)), mode, spacingUs: mode === 'X' ? 12 : mode === 'Y' ? 30 : 0, identOn: false };
  }
}

// --------------------------------------------------------------------------------------------------- processor

export interface NavaidMsg { [k: string]: unknown; type: 'navaid'; kind: NavKind | null; hz: number; levelDb: number; vor?: VorReading; ils?: IlsReading; dme?: DmeReading; ident?: string }

/** The Navaids app: the tuned channel's envelope (VOR, localizer, glide path) or pulses (DME), read twice a second. */
export class NavaidProcessor implements IqProcessor {
  centerHz = 0; tunedHz = 0;
  private key = ''; private chan: ChannelDecimator | null = null; private lp: ComplexFirDecimator | null = null;
  private fsA = 0; private env = new Float32Array(0); private envN = 0; private ident: IdentTone | null = null; private dme: DmeRx | null = null;
  private cr = 1; private ci = 0; private dr = 1; private di = 0; private mixed = new Float32Array(0); private flt = new Float32Array(0);
  private since = 0; private lastIdent = ''; private kind: NavKind | null = null; private level = 0;
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${this.tunedHz}|${rate}`;
    if (key !== this.key) this.setup(key, rate);
    const n = iq.length >> 1;
    if (this.mixed.length < 2 * n) this.mixed = new Float32Array(2 * n);
    let r = this.cr, s = this.ci; const m = this.mixed;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1]; m[2 * k] = a * r - b * s; m[2 * k + 1] = a * s + b * r;
      const t = r * this.dr - s * this.di; s = r * this.di + s * this.dr; r = t;
      if ((k & 1023) === 0) { const g = 1 / Math.hypot(r, s); r *= g; s *= g; }
    }
    this.cr = r; this.ci = s;
    if (this.kind === 'DME') {
      // pulses 3.5 µs wide: a ±600 kHz low-pass at the full rate, then power
      const c = this.lp!.process(m, n, this.flt.length >= 2 * n ? this.flt : (this.flt = new Float32Array(2 * n)));
      const p = new Float32Array(c); let lv = 0;
      for (let i = 0; i < c; i++) { p[i] = this.flt[2 * i] ** 2 + this.flt[2 * i + 1] ** 2; lv += p[i]; }
      this.level = lv / Math.max(1, c);
      this.dme!.push(p, c); this.since += n / rate;
      if (this.since >= 0.5) { this.since = 0; this.emit({ type: 'navaid', kind: 'DME', hz: this.tunedHz, levelDb: this.db(), dme: this.dme!.reading(1e6), ident: this.lastIdent || undefined } satisfies NavaidMsg); }
      return;
    }
    const d = this.chan!.process(m, n), c = this.lp!.process(d.out, d.n, this.flt.length >= 2 * (d.n + 2) ? this.flt : (this.flt = new Float32Array(2 * (d.n + 2))));
    for (let i = 0; i < c; i++) {
      const e = Math.hypot(this.flt[2 * i], this.flt[2 * i + 1]);
      if (this.envN < this.env.length) this.env[this.envN++] = e;
    }
    this.ident!.push(this.env.subarray(this.envN - c, this.envN), c);
    if (this.envN >= this.env.length) {
      // one second read; the next window starts half a second on
      const N = this.envN, msg: NavaidMsg = { type: 'navaid', kind: this.kind, hz: this.tunedHz, levelDb: 0 };
      this.level = mean(this.env, N) ** 2; msg.levelDb = this.db();
      if (this.kind === 'VOR') msg.vor = vorBearing(this.env, N, this.fsA);
      if (this.kind === 'LOC' || this.kind === 'GS') msg.ils = ilsReading(this.env, N, this.fsA);
      if (this.lastIdent) msg.ident = this.lastIdent;
      this.emit(msg);
      const keep = Math.floor(N / 2); this.env.copyWithin(0, N - keep, N); this.envN = keep;
    }
  }
  private db(): number { return Math.round(10 * Math.log10(this.level + 1e-9) * 10) / 10; }
  private setup(key: string, rate: number): void {
    this.key = key; this.kind = navKind(this.tunedHz); this.lastIdent = '';
    const off = this.tunedHz - this.centerHz, w = -2 * Math.PI * off / rate; this.dr = Math.cos(w); this.di = Math.sin(w); this.cr = 1; this.ci = 0;
    if (this.kind === 'DME') {
      this.lp = new ComplexFirDecimator(lowpassTaps(Math.min(0.45, 600e3 / rate), 31), 1); this.dme = new DmeRx(rate); this.chan = null;
      this.dme.key.onIdent = t => { this.lastIdent = t; this.emit({ type: 'packet', line: `DME ${(this.tunedHz / 1e6).toFixed(0)} MHz ident ${t}` }); };
    } else {
      this.chan = new ChannelDecimator(Math.max(1, Math.floor(rate / 40_000))); this.fsA = rate / this.chan.total;
      this.lp = new ComplexFirDecimator(lowpassTaps(12_000 / this.fsA, 63), 1);
      this.env = new Float32Array(Math.round(this.fsA)); this.envN = 0;
      this.ident = new IdentTone(this.fsA);
      this.ident.key.onIdent = t => { this.lastIdent = t; this.emit({ type: 'packet', line: `${this.kind ?? 'NAV'} ${(this.tunedHz / 1e6).toFixed(2)} MHz ident ${t}` }); };
    }
    this.emit({ type: 'log', line: `Navaids: ${(this.tunedHz / 1e6).toFixed(3)} MHz is ${this.kind ?? 'not a navaid frequency'}` });
  }
}

// ------------------------------------------------------------------------------------------------ test signals

/** Morse key timeline for text at `dotS` per dot: [on, seconds][]. */
export function morseTimeline(text: string, dotS: number): [boolean, number][] {
  const inv = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k])), out: [boolean, number][] = [];
  [...text].forEach((ch, ci) => { const code = inv[ch]; [...code].forEach((s, si) => { out.push([true, (s === '-' ? 3 : 1) * dotS]); if (si < code.length - 1) out.push([false, dotS]); }); if (ci < text.length - 1) out.push([false, 3 * dotS]); });
  return out;
}
