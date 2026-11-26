// FORK: the test harness checks itself, so a decoder test that fails points at the decoder, not the signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activePower, addNoise, awgn, concat, fsk, ook, psk, silence, toCs16, toCs8, toCu8, toInt8, toWavIq, tone } from './lib/iq.js';

/** Power (dB) of one frequency in a complex signal, by direct DFT. */
function dftDb(iq: Float32Array, rate: number, hz: number): number {
  let re = 0, im = 0; const n = iq.length / 2, w = -2 * Math.PI * hz / rate;
  for (let i = 0; i < n; i++) { const c = Math.cos(w * i), s = Math.sin(w * i); re += iq[2 * i] * c - iq[2 * i + 1] * s; im += iq[2 * i] * s + iq[2 * i + 1] * c; }
  return 10 * Math.log10((re * re + im * im) / (n * n) + 1e-20);
}
/** Instantaneous frequency (Hz) at sample i. */
function instHz(iq: Float32Array, i: number, rate: number): number {
  const a = Math.atan2(iq[2 * i + 1], iq[2 * i]), b = Math.atan2(iq[2 * i + 3], iq[2 * i + 2]);
  let d = b - a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
  return d * rate / (2 * Math.PI);
}

test('tone: energy sits at the requested offset, not its mirror', () => {
  const x = tone(4096, 1e6, -125_000);
  assert.ok(dftDb(x, 1e6, -125_000) > -0.1);
  assert.ok(dftDb(x, 1e6, 125_000) < -40);
});

test('fsk: 2-FSK symbol centres sit at ±dev; GFSK never overshoots dev', () => {
  const rate = 4e6, baud = 1e6, dev = 250_000, bits = [true, false, true, true, false, false, true, false];
  const x = fsk(bits, baud, rate, dev, { offsetHz: 10_000 });
  bits.forEach((b, k) => assert.ok(Math.abs(instHz(x, k * 4 + 1, rate) - (10_000 + (b ? dev : -dev))) < 1, `symbol ${k}`));
  const g = fsk(bits, baud, rate, dev, { bt: 0.5 });
  for (let i = 0; i < g.length / 2 - 1; i++) assert.ok(Math.abs(instHz(g, i, rate)) <= dev + 1);
  // after a run of identical symbols GFSK settles onto full deviation
  assert.ok(Math.abs(instHz(g, 4 * 4 + 2, rate) + dev) < 0.15 * dev);
});

test('ook: on and off times match the pulse list to the sample', () => {
  const rate = 1e6, x = ook([[400, 600], [1200, 300]], rate, 20_000);
  const env = (i: number) => Math.hypot(x[2 * i], x[2 * i + 1]);
  assert.equal(x.length / 2, 2500);
  assert.ok(env(0) > 0.99 && env(399) > 0.99 && env(400) === 0 && env(999) === 0 && env(1000) > 0.99 && env(2199) > 0.99 && env(2200) === 0);
});

test('psk: QPSK symbols land on their phases', () => {
  const syms = [0, 1, 2, 3, 2], x = psk(syms, 4, 1000, 8000, Math.PI / 4);
  syms.forEach((s, k) => {
    const p = Math.atan2(x[2 * (k * 8 + 4) + 1], x[2 * (k * 8 + 4)]);
    const want = Math.PI / 4 + s * Math.PI / 2, d = Math.atan2(Math.sin(p - want), Math.cos(p - want));
    assert.ok(Math.abs(d) < 1e-6, `symbol ${k}`);
  });
});

test('awgn: measured SNR is within 0.2 dB of what was asked, and seeded noise repeats', () => {
  const sig = concat(silence(1000), tone(200_000, 1e6, 1000, 3), silence(1000));
  for (const snr of [0, 10, 20]) {
    const y = awgn(sig, snr, 5);
    const norm = Math.sqrt(activePower(sig));
    let noiseP = 0; for (let i = 2000; i < sig.length - 2000; i++) noiseP += (y[i] - sig[i] / norm) ** 2;
    const got = 10 * Math.log10(1 / (noiseP / ((sig.length - 4000) / 2)));
    assert.ok(Math.abs(got - snr) < 0.2, `asked ${snr}, got ${got.toFixed(2)}`);
  }
  assert.deepEqual(addNoise(silence(10), 0, 9), addNoise(silence(10), 0, 9));
});

test('writers: cs8, cu8, cs16 and WAV byte layouts', () => {
  const x = new Float32Array([1, -1, 0.5, 0]);
  assert.deepEqual(Array.from(toInt8(x, 100)), [100, -100, 50, 0]);
  assert.deepEqual(Array.from(toCs8(x, 100)), [100, 156, 50, 0]);
  assert.deepEqual(Array.from(toCu8(x, 100)), [228, 28, 178, 128]);
  const c16 = new DataView(toCs16(x, 1000).buffer);
  assert.deepEqual([0, 1, 2, 3].map(i => c16.getInt16(2 * i, true)), [1000, -1000, 500, 0]);
  const w = toWavIq(x, 2_000_000, 1000), dv = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), 'RIFF');
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(24, true), 2_000_000);
  assert.equal(dv.getUint32(40, true), 8);
  assert.equal(dv.getInt16(46, true), -1000);
});
