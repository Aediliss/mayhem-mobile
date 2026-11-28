import test from 'node:test';
import assert from 'node:assert/strict';
import { Fst4wDecoder, fst4Crc24, fst4wAudio, fst4wBp, fst4wChecks, fst4wEncode, fst4wPack, fst4wTones, fst4wUnpack } from '../src/dsp/ham/fst4w.js';
import { WsprFrontEnd } from '../src/dsp/ham/wspr.js';
import { packStandard } from '../src/dsp/ham/ft8-encode.js';

const crcd = (msg: string) => { const b = fst4wPack(msg)!, m = new Uint8Array(74); m.set(b); const c = fst4Crc24(m, 74); for (let i = 0; i < 24; i++) m[50 + i] = (c >> (23 - i)) & 1; return m; };

test('the generator matrix and the parity checks (two WSJT-X tables) agree; the CRC checks to zero', () => {
  for (const msg of ['K1ABC FN42 37', 'G4JNT IO90 23', 'PJ4/K1ABC 37', 'K1ABC/7 30', '<PJ4/K1ABC> FK52UD']) {
    const m = crcd(msg), cw = fst4wEncode(m);
    assert.equal(fst4wChecks(cw), 0, msg);
    assert.equal(fst4Crc24(cw, 74), 0, msg);
    const bad = Uint8Array.from(cw); bad[3] ^= 1; assert.notEqual(fst4Crc24(bad, 74), 0);
  }
});

test('a call packs to the same 28 bits as FT8 (packjt77 pack28, both)', () => {
  for (const call of ['K1ABC', 'W9XYZ', 'G4JNT', 'DJ6OL', 'KI7CI', 'PA3ABC']) {
    const ft8 = packStandard(`${call} K1ABC FN42`)!; let n29 = 0; for (let i = 0; i < 29; i++) n29 = n29 * 2 + ((ft8[i >> 3] >> (7 - (i & 7))) & 1);
    const b = fst4wPack(`${call} FN42 37`)!; let n28 = 0; for (let i = 0; i < 28; i++) n28 = n28 * 2 + b[i];
    assert.equal(n28, Math.floor(n29 / 2), call);
  }
});

test('all three message types unpack back; a hashed call shows once heard in full; the frame has its sync blocks', () => {
  const h = new Map<number, string>(), un = (m: string) => fst4wUnpack(fst4wPack(m)!, h)?.text;
  assert.equal(un('<PJ4/K1ABC> FK52UD'), '<...> FK52UD');
  for (const m of ['K1ABC FN42 37', 'G4JNT IO90 23', 'PJ4/K1ABC 37', 'K1ABC/7 30', 'W1AW/MM 10', 'K1ABC/A12 0']) assert.equal(un(m), m);
  assert.equal(un('<PJ4/K1ABC> FK52UD'), '<PJ4/K1ABC> FK52UD');
  assert.equal(un('<K1ABC> FN42'), '<K1ABC> FN42');
  const t = fst4wTones('K1ABC FN42 37')!;
  assert.equal(t.length, 160);
  assert.deepEqual(Array.from(t.slice(0, 8)), [0, 1, 3, 2, 1, 0, 2, 3]);
  assert.deepEqual(Array.from(t.slice(38, 46)), [2, 3, 1, 0, 3, 2, 0, 1]);
  assert.deepEqual(Array.from(t.slice(152)), [0, 1, 3, 2, 1, 0, 2, 3]);
});

test('belief propagation corrects noisy likelihoods and gives up on noise', () => {
  const cw = fst4wEncode(crcd('K1ABC FN42 37'));
  let s = 3; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const llr = Float32Array.from(cw, b => 2 * ((b ? 1 : -1) + 0.8 * g()) / 0.64);
  let errs = 0; for (let i = 0; i < 240; i++) if ((llr[i] > 0 ? 1 : 0) !== cw[i]) errs++;
  assert.ok(errs >= 15, `${errs} errors`);
  assert.deepEqual(fst4wBp(llr), cw);
  assert.equal(fst4wBp(Float32Array.from({ length: 240 }, () => 2 * g())), null);
});

function baseband(audio: Float32Array, rate = 12_000): [Float32Array, Float32Array] {
  const i: number[] = [], q: number[] = [];
  const fe = new WsprFrontEnd(rate, (a, b) => { i.push(a); q.push(b); }, 300);
  fe.push(audio); fe.push(new Float32Array(rate));
  const skip = Math.round(fe.delayS * 300);
  return [Float32Array.from(i.slice(skip, skip + 112 * 300)), Float32Array.from(q.slice(skip, skip + 112 * 300))];
}
function slotAudio(sigs: { msg: string; hz: number; dt?: number; amp: number }[], noise: number, seed = 1): Float32Array {
  const R = 12_000, a = new Float32Array(R * 112);
  for (const g of sigs) { const x = fst4wAudio(fst4wTones(g.msg)!, g.hz, R, g.amp), at = Math.round((1 + (g.dt ?? 0)) * R); for (let k = 0; k < x.length && at + k < a.length; k++) a[at + k] += x[k]; }
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let k = 0; k < a.length; k += 2) { const r = Math.sqrt(-2 * Math.log(rnd() + 1e-12)), t = 2 * Math.PI * rnd(); a[k] += noise * r * Math.cos(t); a[k + 1] += noise * r * Math.sin(t); }
  return a;
}
const snr2500 = (A: number, s: number) => 10 * Math.log10((A * A / 2) / (s * s * 2500 / 6000));
const ampFor = (snr: number, s: number) => Math.sqrt(2 * 10 ** (snr / 10) * s * s * 2500 / 6000);

test('three stations in one slot, the weakest at -28 dB, decode with frequency, DT and a fair SNR', () => {
  const sigs = [
    { msg: 'K1ABC FN42 37', hz: 1440, amp: ampFor(-18, 0.1) },
    { msg: 'G4JNT IO90 23', hz: 1530, dt: 0.6, amp: ampFor(-24, 0.1) },
    { msg: 'PJ4/K1ABC 37', hz: 1580, dt: -0.4, amp: ampFor(-28, 0.1) },
  ];
  const [id, qd] = baseband(slotAudio(sigs, 0.1));
  const d = new Fst4wDecoder(); d.budgetMs = 60_000;
  const got = d.decodeBuffer(id, qd, Date.UTC(2026, 10, 28, 3, 10));
  const by = new Map(got.map(g => [g.text, g]));
  for (const s of sigs) {
    const g = by.get(s.msg); assert.ok(g, `${s.msg} missing; got ${JSON.stringify(got.map(x => x.text))}`);
    assert.ok(Math.abs(g.hz - s.hz) <= 1, `${s.msg} ${g.hz} Hz`);
    assert.ok(Math.abs(g.dt - (s.dt ?? 0)) <= 0.2, `${s.msg} DT ${g.dt}`);
    assert.equal(g.utc, '0310');
  }
  assert.ok(Math.abs(by.get('K1ABC FN42 37')!.snr - -18) <= 3, `SNR ${by.get('K1ABC FN42 37')!.snr}`);
  assert.equal(got.length, 3);
  assert.ok(snr2500(sigs[2].amp, 0.1) < -27.9);
});

test('noise alone decodes nothing', () => {
  const [id, qd] = baseband(slotAudio([], 0.1, 7));
  const d = new Fst4wDecoder(); d.budgetMs = 60_000;
  assert.deepEqual(d.decodeBuffer(id, qd).map(g => g.text), []);
});

test('live: 48 kHz audio pushed as it comes decodes at the end of its slot (the clock stubbed)', () => {
  const R = 48_000, slotMs = 1_800_000_000_000 - (1_800_000_000_000 % 120_000), a = new Float32Array(R * 118);
  const x = fst4wAudio(fst4wTones('K1ABC FN42 37')!, 1500, R, 0.05);
  for (let k = 0; k < x.length; k++) a[R + k] += x[k];
  let s = 9; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] += (s / 2 ** 32 - 0.5) * 0.3; }
  const d = new Fst4wDecoder(), got: { slot: number; text: string; dt: number }[] = [];
  d.onDecodes = (list, slot) => { for (const g of list) got.push({ slot, text: g.text, dt: g.dt }); };
  let now = slotMs; const real = Date.now; Date.now = () => now;
  try { for (let o = 0; o < a.length; o += 4800) { now = slotMs + (o + 4800) / R * 1000; d.push(a.subarray(o, o + 4800), 4800); } }
  finally { Date.now = real; }
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].slot * 120_000, got[0].text], [slotMs, 'K1ABC FN42 37']);
  assert.ok(Math.abs(got[0].dt) <= 0.2, `DT ${got[0].dt}`);
});

// ---- FST4 and the other periods -------------------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { Fst4Decoder, fst4Checks, fst4Encode, fst4Geo, fst4TonesOf, FST4W_PERIODS } from '../src/dsp/ham/fst4w.js';
import { packStandard as pack77 } from '../src/dsp/ham/ft8-encode.js';

test('FST4: the (240,101) generator and parity checks agree; the 101-bit CRC checks', () => {
  for (const m of ['CQ K9KFR EN71', 'K1ABC W9XYZ -11', 'W9XYZ K1ABC RR73']) {
    const cw = fst4Encode(pack77(m)!);
    assert.equal(fst4Checks(cw), 0, m);
    assert.equal(fst4Crc24(cw, 101), 0, m);
  }
});

/** The period's baseband directly (continuous-phase 4-FSK at [offHz] from the centre, starting [dtS] after the
 *  nominal start) plus complex noise of variance 1, the signal [snr] dB in 2500 Hz of audio (2A² against 5000/FS). */
function baseband4(tones: ArrayLike<number>, period: number, offHz: number, dtS: number, snr: number, seed = 1): [Float32Array, Float32Array] {
  const g = fst4Geo(period), n = Math.ceil((g.startS + g.durS + 1) * g.FS), I = new Float32Array(n), Q = new Float32Array(n);
  const A = Math.sqrt(10 ** (snr / 10) * 5000 / g.FS / 2), at = Math.round((g.startS + dtS) * g.FS); let ph = 0.7;
  for (let k = 0; k < 160 * g.NSS; k++) {
    const j = at + k; if (j >= 0 && j < n) { I[j] += A * Math.cos(ph); Q[j] += A * Math.sin(ph); }
    ph += 2 * Math.PI * (offHz + (tones[Math.floor(k / g.NSS)] - 1.5) * g.DF) / g.FS;
  }
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let j = 0; j < n; j++) { const r = Math.sqrt(-2 * Math.log(rnd() + 1e-12)), t = 2 * Math.PI * rnd(); I[j] += r * Math.cos(t) / Math.SQRT2; Q[j] += r * Math.sin(t) / Math.SQRT2; }
  return [I, Q];
}

for (const period of FST4W_PERIODS.filter(p => p !== 120)) {
  test(`FST4W-${period}: a station 40 Hz off at -${period >= 900 ? 38 : 34} dB decodes with its frequency and DT; noise does not`, () => {
    const snr = period >= 900 ? -38 : -34, [I, Q] = baseband4(fst4wTones('G4JNT IO90 23')!, period, 40, 0.3, snr);
    const d = new Fst4Decoder(true, period); d.budgetMs = 60_000;
    const got = d.decodeBuffer(I, Q);
    assert.equal(got.length, 1, JSON.stringify(got.map(g => g.text)));
    assert.equal(got[0].text, 'G4JNT IO90 23');
    assert.ok(Math.abs(got[0].hz - 1540) <= 1, `${got[0].hz} Hz`);
    assert.ok(Math.abs(got[0].dt - 0.3) <= 0.15 + fst4Geo(period).NSS / fst4Geo(period).FS / 10, `DT ${got[0].dt}`);
    const [nI, nQ] = baseband4(fst4wTones('G4JNT IO90 23')!, period, 40, 0.3, -99, 9);
    assert.deepEqual(new Fst4Decoder(true, period).decodeBuffer(nI, nQ), []);
  });
}

test('FST4-15 through 12 kHz audio and the front end: a standard message, 60 Hz off at -16 dB', () => {
  const g = fst4Geo(15), tones = fst4TonesOf(fst4Encode(pack77('K1ABC W9XYZ -11')!)), R = 12_000;
  const sig = fst4wAudio(tones, 1560, R, Math.sqrt(2 * 10 ** (-16 / 10) * 0.01 * 2500 / 6000), g.NSS / g.FS), a = new Float32Array(R * 15);
  for (let k = 0; k < sig.length; k++) a[Math.round(0.5 * R) + k] += sig[k];
  let s = 4; for (let k = 0; k < a.length; k += 2) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; const r = Math.sqrt(-2 * Math.log(u + 1e-12)), t = 2 * Math.PI * s / 2 ** 32; a[k] += 0.1 * r * Math.cos(t); a[k + 1] += 0.1 * r * Math.sin(t); }
  const I: number[] = [], Q: number[] = [], fe = new WsprFrontEnd(R, (p, q) => { I.push(p); Q.push(q); }, g.FS);
  fe.push(a); fe.push(new Float32Array(R));
  const sk = Math.round(fe.delayS * g.FS), d = new Fst4Decoder(false, 15); d.budgetMs = 60_000;
  const got = d.decodeBuffer(Float32Array.from(I.slice(sk, sk + d.spanSamples)), Float32Array.from(Q.slice(sk, sk + d.spanSamples)), Date.UTC(2026, 10, 28, 6, 0, 45));
  assert.deepEqual(got.map(x => [x.text, x.hz, x.utc]), [['K1ABC W9XYZ -11', 1560, '060045']]);
  assert.ok(Math.abs(got[0].dt) <= 0.1);
});

// fixtures/wsjtx-fst4-60-210115_0058-250sps-1335hz.ci16: WSJT-X's samples/FST4+FST4W/210115_0058.wav (WSJT-X, GPL-3.0;
// a real FST4-60 transmission) put through WsprFrontEnd centred on 1335 Hz to the decoder's 250 Hz baseband, 60 s,
// int16 I/Q. Source: https://sourceforge.net/p/wsjt/wsjtx/ (samples/FST4+FST4W).
test('FST4-60: WSJT-X\'s sample recording decodes CQ K9KFR EN71 at 1335 Hz', () => {
  const b = readFileSync(new URL('../test/fixtures/wsjtx-fst4-60-210115_0058-250sps-1335hz.ci16', import.meta.url));
  const n = b.length / 4, I = new Float32Array(n), Q = new Float32Array(n);
  for (let k = 0; k < n; k++) { I[k] = b.readInt16LE(4 * k) / 32768; Q[k] = b.readInt16LE(4 * k + 2) / 32768; }
  const d = new Fst4Decoder(false, 60, 1335); d.budgetMs = 60_000;
  const got = d.decodeBuffer(I.subarray(0, d.spanSamples), Q.subarray(0, d.spanSamples));
  assert.deepEqual(got.map(x => [x.text, x.hz]), [['CQ K9KFR EN71', 1335]]);
  assert.ok(got[0].snr > 0 && Math.abs(got[0].dt) < 1);
});
