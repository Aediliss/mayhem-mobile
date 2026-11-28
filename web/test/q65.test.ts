// FORK: Q65 (dsp/ham/q65.ts): the codec against WSJT-X's own generator matrix, decoding, and slots end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Q65Decoder, q65Audio, q65Decode, q65Encode, q65Intrinsics, q65Symbols, q65Tones } from '../src/dsp/ham/q65.js';
import { packStandard } from '../src/dsp/ham/ft8-encode.js';
import { readFileSync } from 'node:fs';

// q65_encoding_modules.f90: generator(15,50) (Fortran order) over GF(64), x^6 + x + 1
const GEN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1, 1, 0, 0, 0, 10, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1, 1, 0, 0, 0, 10, 0, 0, 0, 44, 1, 0, 0, 20, 0, 1, 1, 0, 0, 0, 10, 1, 0, 0, 44, 1, 0, 0, 20, 0, 1, 1, 0, 0, 0, 10, 1, 0, 0, 44, 1, 14, 0, 20, 0, 1, 1, 0, 0, 0, 10, 1, 31, 0, 44, 1, 14, 0, 20, 0, 1, 1, 33, 0, 0, 10, 1, 31, 0, 44, 1, 14, 56, 20, 0, 1, 1, 33, 0, 0, 10, 1, 31, 0, 44, 1, 14, 56, 20, 0, 1, 1, 33, 0, 1, 10, 1, 31, 0, 44, 1, 14, 56, 1, 0, 1, 1, 33, 0, 1, 10, 1, 31, 0, 44, 1, 14, 56, 1, 0, 1, 1, 33, 0, 1, 10, 1, 31, 36, 44, 1, 14, 56, 1, 0, 1, 1, 33, 0, 1, 43, 1, 31, 36, 44, 1, 14, 56, 1, 0, 1, 1, 33, 0, 1, 43, 17, 31, 36, 44, 1, 14, 56, 1, 0, 1, 1, 33, 0, 1, 43, 17, 31, 36, 36, 1, 14, 56, 1, 0, 1, 1, 33, 53, 1, 43, 17, 31, 36, 36, 1, 14, 56, 1, 0, 35, 1, 33, 53, 1, 43, 17, 31, 36, 36, 1, 14, 56, 1, 0, 35, 1, 33, 53, 1, 43, 17, 30, 36, 36, 1, 14, 56, 1, 0, 35, 1, 33, 53, 52, 43, 17, 30, 36, 36, 1, 14, 56, 1, 0, 35, 1, 32, 53, 52, 43, 17, 30, 36, 36, 1, 14, 56, 1, 60, 35, 1, 32, 53, 52, 43, 17, 30, 36, 36, 1, 14, 56, 1, 60, 35, 1, 32, 53, 52, 43, 17, 30, 36, 36, 49, 14, 56, 1, 60, 35, 1, 32, 53, 52, 43, 17, 30, 36, 37, 49, 14, 56, 1, 60, 35, 54, 32, 53, 52, 43, 17, 30, 36, 37, 49, 14, 56, 1, 60, 35, 54, 32, 53, 52, 1, 17, 30, 36, 37, 49, 14, 1, 1, 60, 35, 54, 32, 53, 52, 1, 17, 30, 36, 37, 49, 14, 1, 0, 60, 35, 54, 32, 53, 52, 1, 17, 30, 36, 37, 49, 14, 1, 0, 60, 35, 54, 32, 53, 52, 1, 17, 30, 37, 37, 49, 14, 1, 0, 61, 35, 54, 32, 53, 52, 1, 17, 30, 37, 37, 49, 14, 1, 0, 61, 35, 54, 32, 53, 52, 1, 48, 30, 37, 37, 49, 14, 1, 0, 61, 35, 54, 32, 53, 52, 1, 48, 30, 37, 37, 49, 15, 1, 0, 61, 35, 54, 0, 53, 52, 1, 48, 30, 37, 37, 49, 15, 1, 0, 61, 35, 54, 0, 52, 52, 1, 48, 30, 37, 37, 49, 15, 1, 0, 61, 35, 54, 0, 52, 52, 1, 48, 30, 37, 37, 0, 15, 1, 0, 61, 35, 54, 0, 52, 34, 1, 48, 30, 37, 37, 0, 15, 1, 0, 61, 35, 54, 0, 52, 34, 1, 48, 30, 37, 0, 0, 15, 1, 0, 61, 35, 54, 0, 52, 34, 1, 48, 30, 20, 0, 0, 15, 1, 0, 0, 35, 54, 0, 52, 34, 1, 48, 30, 20, 0, 0, 15, 1, 0, 0, 35, 54, 0, 52, 34, 1, 0, 30, 20, 0, 0, 15, 0, 0, 0, 35, 54, 0, 52, 34, 1, 0, 30, 20, 0, 0, 15, 0, 0, 0, 35, 54, 0, 52, 34, 1, 0, 38, 20, 0, 0, 15, 0, 0, 0, 35, 0, 0, 52, 34, 1, 0, 38, 20, 0, 0, 15, 0, 0, 0, 35, 0, 0, 52, 0, 1, 0, 38, 20, 0, 0, 15, 0, 0, 0, 35, 0, 0, 52, 0, 1, 0, 38, 20, 0, 0, 0, 0, 0, 0, 35, 0, 0, 52, 0, 0, 0, 38, 20, 0, 0, 0, 0, 0, 0, 35, 0, 0, 52, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 52, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 0, 0];
const gfMul = (a: number, b: number) => { let r = 0; while (b) { if (b & 1) r ^= a; b >>= 1; a <<= 1; if (a & 64) a ^= 0x43; } return r; };
function crc12(x: number[]): [number, number] { let sr = 0; for (const s of x) { let t = s; for (let j = 0; j < 6; j++) { sr = ((t ^ sr) & 1) ? (sr >> 1) ^ 0xF01 : sr >> 1; t >>= 1; } } return [sr & 63, sr >> 6]; }

test('the encoder (qra_encode with the code tables) matches q65_encode\'s generator matrix', () => {
  let s = 7;
  for (let n = 0; n < 50; n++) {
    const msg = Array.from({ length: 13 }, () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 16) & 63; });
    const m15 = [...msg, ...crc12(msg)], cw = new Array(50).fill(0);
    for (let i = 0; i < 15; i++) for (let j = 0; j < 50; j++) cw[j] ^= gfMul(m15[i], GEN[j * 15 + i]);
    assert.deepEqual(Array.from(q65Encode(msg)), [...msg, ...cw]);
  }
});

test('decoding: clean and noisy tone energies give the message back; random energies give nothing', () => {
  const msg = Array.from(q65Symbols(packStandard('CQ K1ABC FN42')!)), sent = q65Encode(msg);
  let s = 3; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const energies = (snr: number) => { const e = new Float32Array(63 * 64); for (let k = 0; k < 63; k++) for (let t = 0; t < 64; t++) { const a = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()), b = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()), sig = t === sent[k] ? Math.sqrt(snr) : 0; e[k * 64 + t] = (a + sig) ** 2 + b ** 2; } return e; };
  assert.deepEqual(Array.from(q65Decode(q65Intrinsics(energies(100)))!), msg);
  assert.deepEqual(Array.from(q65Decode(q65Intrinsics(energies(8)))!), msg);
  assert.equal(q65Decode(q65Intrinsics(energies(0))), null);
});

function slot(texts: [string, number][], period: number, sub: number, snr: number, seed = 1, lead = period >= 60 ? 1 : 0.5): Float32Array {
  const R = 12000, n = Math.round((85 * ({ 15: 1800, 30: 3600, 60: 7200, 120: 16000 } as Record<number, number>)[period] / R + 2) * R), x = new Float32Array(n);
  for (const [t, f] of texts) { const a = q65Audio(q65Tones(packStandard(t)!), period, sub, f, R, 0.1); x.set(a.map((v, i) => v + x[Math.round(lead * R) + i]), Math.round(lead * R)); }
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < n; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; x[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  return x;
}

test('Q65-60A: two stations in one slot, at −12 dB in 2500 Hz', () => {
  const d = new Q65Decoder(); d.setPeriod(60);
  const got = d.decodeBuffer(slot([['CQ K1ABC FN42', 1000], ['K1ABC W9XYZ EN52', 1600]], 60, 0, -12));
  assert.deepEqual(got.map(g => g.text).sort(), ['CQ K1ABC FN42', 'K1ABC W9XYZ EN52']);
  assert.ok(got.every(g => Math.abs(g.dt) <= 0.2), JSON.stringify(got));
});
test('Q65-15C and Q65-30B decode; noise alone decodes nothing', () => {
  const d = new Q65Decoder(); d.setPeriod(15); d.sub = 2;
  assert.deepEqual(d.decodeBuffer(slot([['W9XYZ K1ABC R-15', 1200]], 15, 2, -6)).map(g => g.text), ['W9XYZ K1ABC R-15']);
  d.setPeriod(30); d.sub = 1;
  assert.deepEqual(d.decodeBuffer(slot([['K1ABC W9XYZ RR73', 1500]], 30, 1, -8)).map(g => g.text), ['K1ABC W9XYZ RR73']);
  d.setPeriod(60); d.sub = 0;
  assert.deepEqual(d.decodeBuffer(slot([], 60, 0, 0)), []);
});

// fixtures/wsjtx-q65-60a-210106_1621-4000sps.wav: WSJT-X's samples/Q65/60A_EME_6m/210106_1621.wav (WSJT-X, GPL-3.0;
// real 6 m EME, W7GJ's callers), low-passed and resampled from 12 kHz to 4000 Hz (every signal is below 1.8 kHz).
// Source: https://sourceforge.net/p/wsjt/wsjtx/ (samples/Q65).
test('WSJT-X\'s Q65-60A EME sample: four callers, about 2.8 s late (the echo)', () => {
  const b = readFileSync(new URL('../test/fixtures/wsjtx-q65-60a-210106_1621-4000sps.wav', import.meta.url));
  const n = (b.length - 44) >> 1, a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = b.readInt16LE(44 + 2 * k) / 32768;
  const x = new Float32Array(n * 3);
  for (let k = 0; k < x.length; k++) {
    const t = k / 3, i0 = Math.floor(t); let v = 0;
    for (let j = i0 - 15; j <= i0 + 16; j++) { if (j < 0 || j >= n) continue; const u = t - j, w = 0.5 + 0.5 * Math.cos(Math.PI * u / 16); v += a[j] * (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w; }
    x[k] = v;
  }
  const d = new Q65Decoder(); d.setPeriod(60); d.budgetMs = 60_000;
  const got = d.decodeBuffer(x);
  assert.deepEqual(got.map(g => g.text).sort(), ['W7GJ N0TB -15', 'W7GJ N8JX EN73', 'W7GJ VE1JF RRR', 'W7GJ W1VD FN31']);
  const v = got.find(g => g.text === 'W7GJ VE1JF RRR')!;
  assert.ok(Math.abs(v.hz - 1620) <= 2 && Math.abs(v.dt - 2.8) <= 0.2, JSON.stringify(v));
});
