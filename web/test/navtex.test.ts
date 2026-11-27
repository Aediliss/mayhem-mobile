// FORK: NAVTEX (dsp/navtex.ts), against ITU-R M.625-4 and M.540-2: the 7-unit table (every signal four B and three Y,
// all 32 distinct), letters and figures, the DX/RX time diversity and phasing, the ZCZC B1B2B3B4 … NNNN format; end to
// end as 100 Bd FSK (170 Hz shift) on 518 and 490 kHz at once, through noise and a carrier error; damaged DX copies read
// from their RX copies; a damaged preamble is not taken for a message; noise gives nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALPHA, NavtexDecoder, NavtexFramer, RQ, navtexBits, navtexEncode, navtexGood, navtexLine, type NavtexMessage } from '../src/dsp/navtex.js';
import { fsk, addNoise, toInt8, concat, silence, feed } from './lib/iq.js';

const MSG = '\r\nZCZC GB42\r\n271200 UTC NOV\r\nNEW YORK NAVTEX\r\nGALE WARNING 23\r\nWINDS NW 35 KT SEAS 4.5 M\r\nNNNN';

test('the 7-unit table: 32 distinct signals, each four B and three Y; phasing signals are good too', () => {
  const codes = navtexEncode('ABCDEFGHIJKLMNOPQRSTUVWXYZ \n');
  assert.ok(codes.every(navtexGood));
  assert.ok(navtexGood(ALPHA) && navtexGood(RQ));
  assert.equal(new Set(codes).size, codes.length - 0);
});

function framer(bits: number[]): NavtexMessage[] { const out: NavtexMessage[] = [], f = new NavtexFramer(518); f.onMessage = m => out.push(m); for (const b of bits) f.push(b); return out; }

test('bits: a message read back; damaged DX signals mended from their RX copies; a bad preamble is no message', () => {
  const bits = navtexBits(navtexEncode(MSG));
  const [m] = framer(bits);
  assert.deepEqual([m.id, m.b1, m.subject, m.serial, m.complete, m.errors], ['GB42', 'G', 'Meteorological warning', '42', true, 0]);
  assert.equal(m.text, '271200 UTC NOV\nNEW YORK NAVTEX\nGALE WARNING 23\nWINDS NW 35 KT SEAS 4.5 M');
  // hit one bit in every third DX signal of the message (DX slot j's bits start at 14·j)
  const hit = bits.slice(); for (let j = 22; j < bits.length / 14 - 8; j += 3) hit[14 * j + 2] ^= 1;
  assert.equal(framer(hit)[0].text, m.text);
  // the same signal hit in both copies: unreadable ('*'); in the preamble it means no message at all
  const pre = bits.slice(); const j0 = 20 + 4;   // DX slot of 'Z' in ZCZC (after LTRS, CR, LF)
  pre[14 * j0 + 1] ^= 1; pre[14 * (j0 + 2) + 7 + 1] ^= 1;
  assert.equal(framer(pre).length, 0);
});

test('end to end: two messages on 518 and 490 kHz at once, 100 Bd FSK through noise with a 40 Hz carrier error', () => {
  const rate = 200_000, centre = 504_000;
  const sig = (text: string, khz: number, err: number) => {
    const b = navtexBits(navtexEncode(text));
    // B (0) is the higher frequency: +85 Hz; Y (1) −85 Hz
    return fsk(b.map(x => x === 0), 100, rate, 85, { offsetHz: khz * 1000 - centre + err, amp: 0.5 });
  };
  const a = sig(MSG, 518, 40), b = sig('\r\nZCZC NA07\r\nUS NATIONAL TEST 490\r\nNNNN', 490, -25);
  const n = Math.max(a.length, b.length), mix = new Float32Array(n + 2 * rate);
  for (let i = 0; i < a.length; i++) mix[i] += a[i]; for (let i = 0; i < b.length; i++) mix[i] += b[i];
  const iq = toInt8(addNoise(mix, 6, 4), 40);
  const out: NavtexMessage[] = [], d = new NavtexDecoder(m => { if (m.type === 'navtex') out.push(m.m as NavtexMessage); });
  d.centerHz = centre; feed(d, iq, rate, 65536);
  const by = Object.fromEntries(out.map(m => [m.khz, m]));
  assert.equal(by[518]?.text, '271200 UTC NOV\nNEW YORK NAVTEX\nGALE WARNING 23\nWINDS NW 35 KT SEAS 4.5 M', JSON.stringify(out));
  assert.equal(by[490]?.text, 'US NATIONAL TEST 490');
  assert.match(navtexLine(by[518]), /^NAVTEX 518 kHz GB42 · Meteorological warning\n/);
  const q: NavtexMessage[] = [], d2 = new NavtexDecoder(m => { if (m.type === 'navtex') q.push(m.m as NavtexMessage); });
  d2.centerHz = centre; feed(d2, toInt8(addNoise(silence(rate * 3), 0, 9), 40), rate, 65536);
  assert.equal(q.length, 0);
  void concat;
});
