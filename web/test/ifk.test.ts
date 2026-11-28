import test from 'node:test';
import assert from 'node:assert/strict';
import { IfkDecoder, ifkAudio, ifkSymbols, type IfkKind } from '../src/dsp/ham/ifk.js';

function run(kind: IfkKind, speed: number, text: string, snr: number, offHz = 0, seed = 1, lead = 0.31): string {
  const R = 48000, sig = ifkAudio(ifkSymbols(kind, text), speed, 1500 + offHz, R, 0.1), a = new Float32Array(Math.round(lead * R) + sig.length);
  a.set(sig, Math.round(lead * R));
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new IfkDecoder(kind, speed, 1500); let out = ''; d.onText = t => { out += t; };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return out;
}
const TEXT = 'CQ CQ DE K1ABC K1ABC pse k';

for (const [kind, speed, snr] of [['dominoex', 11, -6], ['dominoex', 22, -3], ['dominoex', 8, -9], ['thor', 11, -8], ['thor', 22, -5], ['thor', 16, -7]] as const) {
  test(`${kind} ${speed}: clean, and through noise (${snr} dB in 2500 Hz) 47 Hz off (no exact tuning needed)`, () => {
    const clean = run(kind, speed, TEXT, 30);
    assert.ok(clean.includes(TEXT), clean);
    const noisy = run(kind, speed, TEXT, snr, 47, 5);
    assert.ok(noisy.includes('DE K1ABC'), noisy);
  });
}
test('noise alone prints (almost) nothing', () => {
  for (const kind of ['dominoex', 'thor'] as const) for (const sp of [11, 22]) {
    const d = new IfkDecoder(kind, sp, 1500); let out = ''; d.onText = t => { out += t; };
    const a = new Float32Array(48000 * 20); let s = 7; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] = (s / 2 ** 32 - 0.5) * 0.2; }
    for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), 4800);
    assert.ok(out.replace(/\s/g, '').length < 4, `${kind} ${sp}: ${JSON.stringify(out)}`);
  }
});
