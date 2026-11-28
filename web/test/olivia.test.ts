import test from 'node:test';
import assert from 'node:assert/strict';
import { OliviaDecoder, oliviaAudio, oliviaTones, type OliviaConfig } from '../src/dsp/ham/olivia.js';

function run(c: OliviaConfig, text: string, snr: number, offHz = 0, seed = 1, lead = 0.37): string {
  const R = 48000, sig = oliviaAudio(oliviaTones(text, c), c, 1500 + offHz, R, 0.1), a = new Float32Array(Math.round(lead * R) + sig.length);
  a.set(sig, Math.round(lead * R));
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new OliviaDecoder(c, 1500); let out = ''; d.onText = t => { out += t; };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return out;
}
const TEXT = 'CQ CQ DE K1ABC K1ABC PSE K ';

for (const c of [{ tones: 32, bandwidth: 1000 }, { tones: 8, bandwidth: 250 }, { tones: 16, bandwidth: 500 }]) {
  test(`Olivia ${c.tones}/${c.bandwidth}: clean, and at −10 dB in 2500 Hz 7 Hz off`, () => {
    const cfg = { ...c, contestia: false };
    assert.ok(run(cfg, TEXT, 20).includes(TEXT.trim()), run(cfg, TEXT, 20));
    assert.ok(run(cfg, TEXT, -10, 7).includes('DE K1ABC'), run(cfg, TEXT, -10, 7));
  });
}
test('Contestia 8/250: clean, upper case (its character set)', () => {
  const cfg = { tones: 8, bandwidth: 250, contestia: true };
  const out = run(cfg, 'cq de k1abc pse k ', 20);
  assert.ok(out.includes('CQ DE K1ABC PSE K'), out);
});
test('noise alone prints nothing', () => {
  const d = new OliviaDecoder({ tones: 32, bandwidth: 1000, contestia: false }, 1500); let out = ''; d.onText = t => { out += t; };
  const a = new Float32Array(48000 * 20); let s = 5; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] = (s / 2 ** 32 - 0.5) * 0.2; }
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), 4800);
  assert.equal(out, '');
});
