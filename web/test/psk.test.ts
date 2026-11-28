import test from 'node:test';
import assert from 'node:assert/strict';
import { PskDecoder, pskAudio, pskBits } from '../src/dsp/ham/psk.js';

function run(baud: number, qpsk: boolean, text: string, snr: number, offHz = 0, seed = 1): string {
  const R = 48000, a = pskAudio(pskBits(text), baud, qpsk, 1000 + offHz, R, 0.1);
  // noise: [snr] dB in 2500 Hz
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / (10 ** (snr / 10)) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new PskDecoder(baud, qpsk, 1000); let out = '';
  d.onText = t => { out += t; };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return out;
}
const TEXT = 'CQ CQ DE K1ABC K1ABC PSE K';

for (const [baud, name] of [[62.5, 'PSK63'], [125, 'PSK125']] as const) {
  test(`${name}: clean text, and through noise (${baud > 100 ? -1 : -4} dB in 2500 Hz) 3 Hz off`, () => {
    assert.equal(run(baud, false, TEXT, 20), TEXT);
    assert.ok(run(baud, false, TEXT, baud > 100 ? -1 : -4, 3).includes(TEXT), name);
  });
}

test('QPSK31: the K=5 code and fldigi\'s phase mapping round trip; through noise (−6 dB) and 2 Hz off', () => {
  assert.equal(run(31.25, true, TEXT, 20), TEXT);
  assert.ok(run(31.25, true, TEXT, -6, 2).includes(TEXT));
});

test('noise alone and a plain carrier give no text', () => {
  for (const [b, q] of [[62.5, false], [125, false], [31.25, true]] as const) {
    const d = new PskDecoder(b, q, 1000); let out = '';
    d.onText = t => { out += t; };
    const R = 48000, a = new Float32Array(R * 8); let s = 3; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] = 0.2 * Math.sin(2 * Math.PI * 1000 * k / R) + (s / 2 ** 32 - 0.5) * 0.01; }
    d.push(a, a.length);
    assert.equal(out.replace(/\s/g, ''), '', `${b} ${q}`);
  }
});
