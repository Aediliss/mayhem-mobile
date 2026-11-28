import test from 'node:test';
import assert from 'node:assert/strict';
import { MfskDecoder, mfskAudio, mfskTones } from '../src/dsp/ham/mfsk.js';

function run(baud: number, text: string, snr: number, offHz = 0, seed = 1, lead = 0.23): string {
  const R = 48000, sig = mfskAudio(mfskTones(text), baud, 1500 + offHz, R, 0.1), a = new Float32Array(Math.round(lead * R) + sig.length);
  a.set(sig, Math.round(lead * R));
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new MfskDecoder(baud, 1500); let out = ''; d.onText = t => { out += t; };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return out;
}
const TEXT = 'CQ CQ DE K1ABC K1ABC pse k';

for (const [baud, name, snr] of [[15.625, 'MFSK16', -10], [31.25, 'MFSK32', -8]] as const) {
  test(`${name}: clean text, and through noise (${snr} dB in 2500 Hz) 4 Hz off`, () => {
    const clean = run(baud, TEXT, 20);
    assert.ok(clean.includes(TEXT), clean);
    const noisy = run(baud, TEXT, snr, 4, 9);
    assert.ok(noisy.includes('DE K1ABC'), noisy);
  });
}
test('noise alone prints (almost) nothing', () => {
  for (const b of [15.625, 31.25]) {
    const d = new MfskDecoder(b, 1500); let out = ''; d.onText = t => { out += t; };
    const a = new Float32Array(48000 * 20); let s = 7; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] = (s / 2 ** 32 - 0.5) * 0.2; }
    for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), 4800);
    assert.ok(out.replace(/\s/g, '').length < 4, `${b}: ${JSON.stringify(out)}`);
  }
});
