import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Jt9Decoder, JT9_SYNC, JT9_SYMBOL_S, jt9Audio, jt9Tones } from '../src/dsp/ham/jt9.js';

const FS = 4096 / JT9_SYMBOL_S;
function slot(sigs: { msg: string; hz: number; dt: number; snr: number }[], seed = 1): Float32Array {
  const x = new Float32Array(Math.round(53 * FS)), noise = 0.1;
  for (const g of sigs) {
    const A = Math.sqrt(2 * 10 ** (g.snr / 10) * noise * noise * 2500 / (FS / 2)), s = jt9Audio(jt9Tones(g.msg), g.hz, FS, A), at = Math.round((1 + g.dt) * FS);
    for (let k = 0; k < s.length; k++) x[at + k] += s[k];
  }
  let s = seed; for (let k = 0; k < x.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; x[k] += noise * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  return x;
}

test('frame: 16 sync symbols on tone 0, 69 data symbols on tones 1-8', () => {
  const t = jt9Tones('CQ K1ABC FN42');
  assert.equal(JT9_SYNC.reduce((a, b) => a + b, 0), 16);
  JT9_SYNC.forEach((s, i) => { if (s) assert.equal(t[i], 0); else assert.ok(t[i] >= 1 && t[i] <= 8); });
});

test('three stations (−10, −18, −24 dB) decode with frequency, DT and SNR; noise gives nothing', () => {
  const sigs = [{ msg: 'CQ K1ABC FN42', hz: 900, dt: 0, snr: -10 }, { msg: 'K1ABC W9XYZ -15', hz: 1400, dt: 0.5, snr: -18 }, { msg: 'W9XYZ K1ABC RRR', hz: 2100, dt: -0.4, snr: -24 }];
  const d = new Jt9Decoder(); d.budgetMs = 60_000;
  const got = d.decodeBuffer(slot(sigs), Date.UTC(2026, 10, 28, 8, 1));
  assert.equal(got.length, 3, JSON.stringify(got));
  for (const s of sigs) {
    const g = got.find(x => x.text === s.msg)!; assert.ok(g, s.msg);
    assert.ok(Math.abs(g.hz - s.hz) <= 1, `${g.hz}`); assert.ok(Math.abs(g.dt - s.dt) <= 0.1, `DT ${g.dt}`); assert.ok(Math.abs(g.snr - s.snr) <= 3, `SNR ${g.snr}`);
  }
  const n = new Jt9Decoder(); n.budgetMs = 60_000;
  assert.deepEqual(n.decodeBuffer(slot([], 7)), []);
});

// fixtures/wsjtx-jt9-130418_1742-4000sps.wav: WSJT-X's samples/JT9/130418_1742.wav (WSJT-X, GPL-3.0; real off-air 20 m
// JT9), resampled from 12 kHz to 4000 Hz (every station in it is below 1.6 kHz), the first 53 s. Source:
// https://sourceforge.net/p/wsjt/wsjtx/ (samples/JT9).
test('WSJT-X\'s JT9 sample recording: seven stations', () => {
  const b = readFileSync(new URL('../test/fixtures/wsjtx-jt9-130418_1742-4000sps.wav', import.meta.url));
  const n = (b.length - 44) >> 1, a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = b.readInt16LE(44 + 2 * k) / 32768;
  // up to the decoder's rate by windowed-sinc interpolation (the shared resampler only goes down)
  const x = new Float32Array(Math.round(53 * FS)), r = 4000 / FS;
  for (let k = 0; k < x.length; k++) {
    const t = k * r, i0 = Math.floor(t); let v = 0;
    for (let j = i0 - 15; j <= i0 + 16; j++) { if (j < 0 || j >= n) continue; const u = t - j, w = 0.5 + 0.5 * Math.cos(Math.PI * u / 16); v += a[j] * (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w; }
    x[k] = v;
  }
  const d = new Jt9Decoder(); d.budgetMs = 60_000;
  const got = d.decodeBuffer(x);
  assert.deepEqual(got.map(g => g.text).sort(), ['CQ GM7GAX IO75', 'CQ M0WAY IO82', 'G7CNF N4HFA EL89', 'JA1KAU PD0JAC -23', 'K1JT KF4RWA 73', 'K1JT N5KDV EM41', 'TF3G N7MQ CN84']);
  assert.deepEqual(got.find(g => g.text === 'K1JT N5KDV EM41')!.hz, 1346);
});
