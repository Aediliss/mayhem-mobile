// FORK: HF DSC / CCIR 493-4 selcall: M.493 characters at 100 baud, 1615 (Y, 1) / 1785 Hz (B, 0) → SelcallDecoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SelcallDecoder } from '../src/dsp/ham/selcall.js';
import { dscCallBits, dscInfo, mmsiChars } from '../src/dsp/dsc.js';
import { afsk } from './lib/iq.js';

function audio(info: number[]): Float32Array {
  const pad = new Array(120).fill(0).map((_, i) => i & 1);
  return afsk([...pad, ...dscCallBits(info), ...pad].map(b => !!b), 100, 48_000, 1615, 1785);
}
function run(x: Float32Array, snr = 99, seed = 2): string {
  const a = Float32Array.from(x, v => 0.1 * v), R = 48000, sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new SelcallDecoder(); let out = ''; d.onText = t => { out += t; };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return out;
}

test('a 4-digit and a 6-digit selcall, and an HF DSC call, through noise', () => {
  const sel4 = dscInfo(120, [12, 34, 100, 56, 78], 117), sel6 = dscInfo(123, [12, 34, 56, 108, 65, 43, 21], 127);
  const dsc = dscInfo(120, [...mmsiChars('366123450'), 100, ...mmsiChars('338765430'), 100, 109, 126, 126, 126, 126, 126, 126], 117);
  const x = Float32Array.from([...audio(sel4), ...audio(sel6), ...audio(dsc)]);
  const want = 'SELCALL to 1234 from 5678 · Routine · Individual · ack requested\nSELCALL to 123456 from 654321 · Safety · Individual (automatic)\n';
  const clean = run(x);
  assert.ok(clean.startsWith(want), clean);
  assert.match(clean.split('\n')[2], /366123450|338765430/);
  assert.ok(run(x, 8).startsWith(want));
});
test('noise and a call with a bad ECC give nothing', () => {
  const bad = dscInfo(120, [12, 34, 100, 56, 78], 117); bad[bad.length - 1] ^= 1;
  assert.equal(run(audio(bad)), '');
  assert.equal(run(new Float32Array(48000 * 10), 0), '');
});
