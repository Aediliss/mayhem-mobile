// FORK: HF packet: the Transmit app's AX.25 encoder -> 300 Bd AFSK (1600 / 1800 Hz) -> USB audio -> HfPacketDecoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HfPacketDecoder } from '../src/dsp/ham/hfpacket.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { afsk } from './lib/iq.js';

const R = 48000;
function run(frames: number[][], snr: number, offHz = 0, seed = 1): { text: string; frames: number[][] } {
  const parts = frames.map(f => afsk(ax25Bits(f), 300, R, 1600 + offHz, 1800 + offHz));
  const gap = R / 2, a = new Float32Array(gap + parts.reduce((n, p) => n + p.length + gap, 0)); let o = gap;
  for (const p of parts) { for (let k = 0; k < p.length; k++) a[o + k] = 0.1 * p[k]; o += p.length + gap; }
  const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const d = new HfPacketDecoder(); let text = ''; const got: number[][] = [];
  d.onText = t => { text += t; }; d.onFrame = f => got.push(f);
  for (let k = 0; k < a.length; k += 4800) d.push(a.subarray(k, k + 4800), Math.min(4800, a.length - k));
  return { text, frames: got };
}

test('HF packet: two frames decode to TNC2 text and to the AX.25 bytes for the export bus (KISS / TNC2)', () => {
  const f1 = ax25Aprs('N0CALL-9', '!4903.50N/07201.75W-HF test'), f2 = ax25Aprs('K1ABC', '>status on 30 m');
  const r = run([f1, f2], 30);
  assert.equal(r.frames.length, 2, r.text);
  assert.match(r.text, /^N0CALL-9>APZMHM.*:!4903\.50N\/07201\.75W-HF test\n/);
  assert.ok(r.text.includes('K1ABC>'), r.text);
  assert.deepEqual(r.frames[0], f1.slice(0, -2));
});
test('HF packet: 45 Hz off tune and through noise (6 dB in 2500 Hz)', () => {
  const r = run([ax25Aprs('N0CALL-9', '>mistuned')], 6, 45, 3);
  assert.ok(r.text.includes('>mistuned'), r.text);
});
test('HF packet: noise alone and a corrupted frame give nothing', () => {
  assert.equal(run([], 0).text, '');
  const f = ax25Aprs('N0CALL-9', '>corrupt me'); f[20] ^= 4;
  assert.equal(run([f], 30).text, '');
});
