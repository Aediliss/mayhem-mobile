// FORK: 2G ALE: words → Golay, interleave, triple redundancy → 8-FSK audio → AleDecoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AleDecoder, ALE_PRE, aleAudio, aleTones, aleWord, golayDecode, golayEncode } from '../src/dsp/ham/ale.js';

test('Golay (24,12) from golay.c: minimum distance 8, corrects three errors', () => {
  let dmin = 99;
  for (let d = 1; d < 4096; d++) { let w = golayEncode(d), c = 0; while (w) { c += w & 1; w >>>= 1; } dmin = Math.min(dmin, c); }
  assert.equal(dmin, 8);
  const w = golayEncode(0xA5C); assert.equal(golayDecode(w ^ 0x800021), 0xA5C); assert.equal(golayDecode(w ^ 0x000003, 1), -1);
});
test('the NTIA simulator\'s words: TO SAM = 25160315, TO JOE = 24523705 (octal)', () => {
  assert.equal(aleWord(ALE_PRE.TO, 'SAM'), 0o25160315);
  assert.equal(aleWord(ALE_PRE.TO, 'JOE'), 0o24523705);
});

function run(words: number[], snr: number, grayMap: boolean, seed = 1, lead = 0.137): { text: string; words: string[] } {
  const R = 48000, sig = aleAudio(aleTones(words, grayMap), R, 0.1), a = new Float32Array(Math.round(lead * R) + sig.length + R);
  a.set(sig, Math.round(lead * R));
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new AleDecoder(); let text = ''; const got: string[] = [];
  d.onText = t => { text += t; }; d.onWord = (p, c) => got.push(`${p} ${c}`);
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  for (let i = 0; i < 6; i++) d.push(new Float32Array(48000), 48000);   // quiet after: the call is printed
  return { text, words: got };
}
const W = (p: number, c: string) => aleWord(p, c);

test('an individual call (scanning TO SAM ×4, TO SAM, TIS JOE) in either tone map, and through noise', () => {
  const call = [W(2, 'SAM'), W(2, 'SAM'), W(2, 'SAM'), W(2, 'SAM'), W(2, 'SAM'), W(5, 'JOE')];
  for (const g of [true, false]) {
    const r = run(call, 30, g);
    assert.equal(r.words.length, 6, JSON.stringify(r.words));
    assert.equal(r.text, 'TO SAM TIS JOE\n');
  }
  assert.equal(run(call, 3, true, 4).text, 'TO SAM TIS JOE\n');
});
test('a sounding with a long address (TWAS + DATA continuation)', () => {
  const r = run([W(3, 'KAR'), W(0, 'L1@'), W(3, 'KAR'), W(0, 'L1@')], 30, true);
  assert.equal(r.text, 'SOUNDING TWAS KARL1\n', JSON.stringify(r));
});
test('noise alone gives no words', () => {
  const d = new AleDecoder(); let n = 0; d.onWord = () => n++;
  const a = new Float32Array(48000 * 30); let s = 9; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; a[k] = (s / 2 ** 32 - 0.5) * 0.2; }
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), 4800);
  assert.equal(n, 0);
});
