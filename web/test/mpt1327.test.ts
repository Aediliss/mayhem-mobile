// FORK: MPT1327: the codeword check against SDRTrunk's published table, message layouts, single-error correction, and
// the receiver on synthetic 1200 bit/s FFSK over FM (with noise, either slicer polarity), CCSC system identity included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MPT_CHECK_TABLE, MptRx, encodeMptSlot, mptAddress, mptCheckCodeword, mptCodeword, mptLine, parseMpt } from '../src/dsp/fleet/mpt1327.js';
import { afsk, awgn, concat, fmModulate, hold, silence } from './lib/iq.js';

test('check: the per-bit table derived from x^15+x^14+x^13+x^11+x^4+x^2+1 equals SDRTrunk\'s published one', () => {
  // SDRTrunk edac/CRCFleetsync.java, entries for bits 0..15 (GPL-3.0; used here as test vectors only)
  const sdrtrunk = [0x740a, 0x3a05, 0x6908, 0x3484, 0x1a42, 0x0d21, 0x729a, 0x394d, 0x68ac, 0x3456, 0x1a2b, 0x791f, 0x4885, 0x5048, 0x2824, 0x1412];
  assert.deepEqual(Array.from(MPT_CHECK_TABLE.subarray(0, 16)), sdrtrunk);
  assert.equal(MPT_CHECK_TABLE[47], 0x6815);
});

test('codewords: check + even parity; one flipped bit is corrected, two fail', () => {
  const w = mptCodeword(mptAddress({ pfix: 12, ident1: 345, type: 256 }));
  let ones = 0; for (const b of w) ones += b; assert.equal(ones % 2, 0);
  assert.equal(mptCheckCodeword(w.slice()), 'ok');
  const one = w.slice(); one[30] ^= 1; assert.equal(mptCheckCodeword(one), 'corrected'); assert.deepEqual(one, w);
  const two = w.slice(); two[3] ^= 1; two[40] ^= 1; assert.equal(mptCheckCodeword(two), 'bad');
});

test('messages: GTC, ALOHA, CLEAR, MOVE, ACK and BCAST layouts', () => {
  const gtc = mptAddress({ pfix: 12, ident1: 2001, type: 0, rest: [[23, 23, 0], [24, 33, 517], [34, 46, 345]] });
  assert.deepEqual(parseMpt(gtc), { kind: 'gtc', pfix: 12, ident1: 2001, ident2: 345, chan: 517, data: false });
  assert.match(mptLine(parseMpt(gtc)), /^GTC · 12\/2001 ← 12\/345 · CHAN 517$/);
  assert.deepEqual(parseMpt(mptAddress({ pfix: 0, ident1: 0, type: 256, rest: [[40, 44, 3], [45, 48, 2]] })), { kind: 'aloha', type: 256, pfix: 0, ident1: 0, m: 3, n: 2 });
  assert.deepEqual(parseMpt(mptAddress({ pfix: 0, ident1: 0, type: 282, rest: [[2, 11, 517]] })), { kind: 'clear', chan: 517 });
  assert.deepEqual(parseMpt(mptAddress({ pfix: 5, ident1: 0, type: 283, rest: [[16, 25, 600]] })), { kind: 'move', pfix: 5, chan: 600 });
  assert.deepEqual(parseMpt(mptAddress({ pfix: 5, ident1: 77, type: 266, rest: [[31, 43, 99]] })), { kind: 'ack', type: 266, pfix: 5, ident1: 77, ident2: 99 });
  assert.deepEqual(parseMpt(mptAddress({ pfix: 0, ident1: 0, type: 284, rest: [[2, 6, 3], [7, 21, 0x1234]] })), { kind: 'bcast', sysdef: 3, sys: 0x1234 });
  assert.match(mptLine(parseMpt(mptAddress({ pfix: 1, ident1: 8191, type: 264 }))), /ALLI \(all units\)/);
});

const RATE = 24_000;                                      // Dispatch's channel rate
/** A run of control-channel slots as FM IQ: 1200 bit/s FFSK (1200 Hz = 1, 1800 Hz = 0), ±2.5 kHz. */
function slots(sys: number, addrs: Uint8Array[], invert = false): Float32Array {
  const bits: boolean[] = [];
  for (let i = 0; i < 32; i++) bits.push(i % 2 === 0);      // REVS lead-in
  for (const a of addrs) for (const b of encodeMptSlot(sys, a)) bits.push((b === 1) !== invert);
  for (let i = 0; i < 32; i++) bits.push(i % 2 === 0);      // a site transmits continuously: no abrupt end after a codeword
  const audio = afsk(bits, 1200, 48_000, 1200, 1800);
  const iq = fmModulate(hold(audio, 1), 48_000, 2500);
  const out = new Float32Array(iq.length / 2);             // 48 k → 24 k
  for (let i = 0; i < out.length / 2; i++) { out[2 * i] = iq[4 * i]; out[2 * i + 1] = iq[4 * i + 1]; }
  return concat(silence(2000), out, silence(2000));
}
function receive(iq: Float32Array): { words: Uint8Array[]; sys: (number | null)[] } {
  const rx = new MptRx(RATE), words: Uint8Array[] = [], sys: (number | null)[] = [];
  rx.onCodeword = (w, s) => { words.push(w); sys.push(s); };
  const n = iq.length / 2, zi = new Float32Array(n), zq = new Float32Array(n);
  for (let i = 0; i < n; i++) { zi[i] = iq[2 * i]; zq[i] = iq[2 * i + 1]; }
  for (let o = 0; o < n; o += 2048) rx.push(zi.subarray(o, o + 2048), zq.subarray(o, o + 2048), Math.min(2048, n - o));
  return { words, sys };
}

test('receiver: control-channel slots decode at 24 kS/s with noise, in either slicer polarity; the CCSC gives the system', () => {
  const aloha = mptAddress({ pfix: 0, ident1: 0, type: 256, rest: [[40, 44, 3], [45, 48, 2]] });
  const gtc = mptAddress({ pfix: 12, ident1: 2001, type: 0, rest: [[24, 33, 517], [34, 46, 345]] });
  for (const invert of [false, true]) {
    const r = receive(awgn(slots(0x2a5b, [aloha, gtc, aloha, gtc, aloha], invert), 15, 2));
    assert.deepEqual(r.words.map(w => parseMpt(w).kind), ['aloha', 'gtc', 'aloha', 'gtc', 'aloha'], `invert ${invert}`);
    assert.equal(r.sys[0], null);                          // one sighting is not enough
    assert.deepEqual(r.sys.slice(1), [0x2a5b, 0x2a5b, 0x2a5b, 0x2a5b]);
  }
  const weak = receive(awgn(slots(0x2a5b, [aloha, gtc, aloha, gtc]), 9, 5));     // 9 dB still decodes every slot
  assert.deepEqual(weak.words.map(w => parseMpt(w).kind), ['aloha', 'gtc', 'aloha', 'gtc']);
});

test('receiver: noise finds nothing', () => {
  assert.deepEqual(receive(awgn(silence(240_000), 0, 8)).words, []);
});
