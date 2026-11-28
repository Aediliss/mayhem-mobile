import test from 'node:test';
import assert from 'node:assert/strict';
import { WefaxDecoder, wefaxAudio } from '../src/dsp/ham/wefax.js';

/** A chart: smooth bands across (period 300 of 905 columns) that drift down the lines, so a wrong line start or a
 *  wrong row shows as a large error. */
const chart = (n: number, w = 905) => Array.from({ length: n }, (_, r) => Float32Array.from({ length: w }, (_, c) => 0.5 + 0.45 * Math.sin(2 * Math.PI * (c / 300 + r / 40))));

function run(audio: Float32Array, dec = new WefaxDecoder()) {
  const rows = new Map<string, Map<number, Uint8ClampedArray>>(), text: string[] = [], states: string[] = [];
  dec.onImage = img => { if (!rows.has(img.mode)) rows.set(img.mode, new Map()); rows.get(img.mode)!.set(img.line, img.rows); };
  dec.onText = t => text.push(t.trim());
  dec.onStatus = s => { if (states[states.length - 1] !== s.state) states.push(s.state); };
  for (let o = 0; o < audio.length; o += 4800) dec.push(audio.subarray(o, o + 4800), Math.min(4800, audio.length - o));
  return { rows, text, states, dec };
}
function withNoise(sig: Float32Array, leadS: number, noise: number, seed = 1): Float32Array {
  const lead = Math.round(leadS * 48_000), a = new Float32Array(lead + sig.length);
  a.set(sig, lead);
  let s = seed; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[i] += noise * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  return a;
}

test('a chart: start signal heard, line start found from the phasing, the picture matches, the stop signal ends it', () => {
  const src = chart(120);
  // 3.37 s of noise first, so the receiver's lines start at an arbitrary point; noise ~20 dB under the signal
  const { rows, text, states } = run(withNoise(wefaxAudio(src, { phasingS: 20 }), 3.37, 0.07));
  assert.ok(text.some(t => t.startsWith('WEFAX start · IOC 576 · 120 LPM')), text.join(' | '));
  assert.ok(text.some(t => t.includes('line start found')));
  assert.ok(text.some(t => /^WEFAX stop · 1[12]\d lines$/.test(t)), text.join(' | '));
  assert.deepEqual(states.filter(s => s !== 'free'), ['start', 'phasing', 'image', 'stop']);
  const img = [...rows.entries()].find(([k]) => !k.includes('free-running'))!;
  assert.ok(img, [...rows.keys()].join());
  const lines = img[1]; assert.ok(lines.size >= 118 && lines.size <= 123, `${lines.size} lines (the stop signal takes a second to be sure of)`);
  // decoded line L against chart row L (1810 pixels back to 905), away from the first and last few lines
  let err = 0, n = 0;
  for (let L = 3; L < 115; L++) {
    const got = lines.get(L)!, want = src[L];
    for (let c = 20; c < 885; c++) { err += Math.abs(got[4 * 2 * c] / 255 - want[c]); n++; }
  }
  assert.ok(err / n < 0.08, `mean error ${(err / n).toFixed(3)}`);
});

test('IOC 288 is told by its 675 Hz start signal (half the pixels a line)', () => {
  const { text, rows } = run(withNoise(wefaxAudio(chart(30), { ioc: 288, phasingS: 10 }), 1.1, 0.05));
  assert.ok(text.some(t => t.startsWith('WEFAX start · IOC 288')), text.join(' | '));
  const img = [...rows.entries()].find(([k]) => k.includes('/288'))!;
  assert.equal(img[1].get(5)!.length, Math.round(Math.PI * 288) * 4);
});

test('noise alone: no start or stop heard, lines run free', () => {
  const { text, states, rows } = run(withNoise(new Float32Array(48_000 * 20), 0, 0.3, 4));
  assert.deepEqual(text, []);
  assert.deepEqual(states.filter(s => s !== 'free'), []);
  assert.ok([...rows.keys()].every(k => k.includes('free-running')));
});
