// FORK: EDACS control channel: the BCH code against the textbook generator, frames through the vote, every TSB-69.3
// message layout through the parser, and the receiver on synthetic 9600 / 4800 bd FSK with noise and either polarity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDACS_BCH_G, EdacsRx, decodeEdacsFrame, edacsCheckOk, edacsLine, edacsParity, edacsWord, encodeEdacsFrame, parseEdacs } from '../src/dsp/fleet/edacs.js';
import { awgn, concat, fsk, silence } from './lib/iq.js';

test('BCH: g(x) is the textbook BCH(63,51) t=2 generator for x^6+x+1 (Lin & Costello: octal 12471)', () => {
  assert.equal(EDACS_BCH_G, 0o12471);
  // g divides x^63 + 1, as any cyclic code's generator must
  let r = 1; for (let i = 0; i < 63; i++) { r <<= 1; if (r & 0x1000) r ^= EDACS_BCH_G; } r ^= 1;
  assert.equal(r & 0xfff, 0);
});

test('BCH: every 1-, 2-, 3- and 4-bit error in a 40-bit message is detected (minimum distance 5)', () => {
  const w = edacsWord(0xabcdef1), flip = (x: number, b: number) => (Math.floor(x / 2 ** b) % 2 ? x - 2 ** b : x + 2 ** b);
  assert.ok(edacsCheckOk(w));
  let missed = 0;
  for (let a = 0; a < 40; a++) { if (edacsCheckOk(flip(w, a))) missed++; for (let b = a + 1; b < 40; b++) { const w2 = flip(flip(w, a), b); if (edacsCheckOk(w2)) missed++; } }
  for (let t = 0; t < 3000; t++) { const bits = new Set<number>(); while (bits.size < 3 + (t & 1)) bits.add((t * 7919 + bits.size * 104729) % 40 + 0); let x = w; for (const b of bits) x = flip(x, b); if (edacsCheckOk(x)) missed++; }
  assert.equal(missed, 0);
  assert.equal(edacsParity(0), 0);
});

test('frames: three copies (middle inverted) vote out an error in any one copy; two bad copies fail the check', () => {
  const bits = encodeEdacsFrame(0x1234567, 0x7654321);
  assert.equal(bits.length, 288);
  assert.equal(Array.from(bits.subarray(0, 48)).join(''), (0x555557125555).toString(2).padStart(48, '0'));
  const soft = Float32Array.from(bits.subarray(48), b => (b ? 1 : -1));
  assert.deepEqual(decodeEdacsFrame(soft), [0x1234567, 0x7654321]);
  for (const k of [3, 41, 99]) soft[k] = -soft[k];                     // one error in each copy of message 1, different bits
  assert.deepEqual(decodeEdacsFrame(soft), [0x1234567, 0x7654321]);
  soft[120 + 5] = -soft[120 + 5]; soft[120 + 40 + 5] = -soft[120 + 40 + 5];   // the same bit wrong in two copies of message 2
  assert.equal(decodeEdacsFrame(soft)[1], null);
});

// Build messages from TSB-69.3 fields (the transmitter side of the parser)
const groupMsg = (mtA: number, lid: number, lcn: number, txTrunk: boolean, group: number): [number, number] =>
  [(mtA << 25) | (((lid >> 7) & 0x7f) << 18) | (lcn << 12) | ((txTrunk ? 1 : 0) << 11) | group, (lid & 0x7f) << 17];
const mt7 = (mtB: number, rest: number): number => (7 << 25) | (mtB << 22) | rest;

test('messages: every standard layout parses to its fields', () => {
  let [a, b] = groupMsg(2, 9876, 7, true, 1234);
  assert.deepEqual(parseEdacs(a, b), { kind: 'group', digital: true, emergency: false, lid: 9876, lcn: 7, txTrunk: true, group: 1234 });
  [a, b] = groupMsg(1, 1, 26, false, 2047);
  const em = parseEdacs(a, b); assert.ok(em.kind === 'group' && em.emergency && !em.digital && em.lcn === 26);
  assert.match(edacsLine(em), /EMERGENCY/); assert.match(edacsLine(em), /LCN 26 \(queued\)/);
  assert.deepEqual(parseEdacs(mt7(3, (3 << 20) | (12 << 15) | (0 << 14) | (1 << 13) | 777), 0), { kind: 'update', digital: true, txTrunk: true, lcn: 12, individual: false, emergency: true, target: 777, source: 0, test: false });
  assert.deepEqual(parseEdacs(mt7(5, (1 << 21) | (4 << 15) | (1 << 14) | 4321), 1234), { kind: 'individual', digital: true, txTrunk: true, lcn: 4, target: 4321, source: 1234, test: false });
  assert.deepEqual(parseEdacs((6 << 25) | (55 << 14) | 3000, 0), { kind: 'login', group: 55, lid: 3000 });
  assert.deepEqual(parseEdacs(mt7(0, (248 << 14) | 42), 0), { kind: 'status', status: 248, lid: 42, request: true });
  assert.deepEqual(parseEdacs(mt7(6, (1 << 19) | (9 << 14) | 77), 0), { kind: 'unkey', drop: true, lcn: 9, lid: 77 });
  assert.deepEqual(parseEdacs(mt7(7, (0x09 << 17) | (1 << 12) | (3 << 9) | (1 << 6) | 21), 0), { kind: 'site', siteId: 21, ccLcn: 1, priority: 3, scat: false, failsoft: true, auxiliary: false });
  assert.deepEqual(parseEdacs(mt7(7, (0x01 << 17) | (5 << 12) | (2 << 9) | (17 << 4)), 0), { kind: 'adjacent', ccLcn: 5, index: 2, siteId: 17 });
  assert.equal(parseEdacs(mt7(5, 0), 0).kind === 'individual' && (parseEdacs(mt7(5, 0), 0) as { test: boolean }).test, true);
  assert.equal(parseEdacs(mt7(2, 5), 9).kind, 'other');
  // the ESK mask some systems XOR into the top byte undoes itself
  [a, b] = groupMsg(0, 100, 3, true, 50);
  assert.deepEqual(parseEdacs(a ^ (0xa0 << 20), b ^ (0xa0 << 20), 0xa0), parseEdacs(a, b));
});

/** FSK baseband for a run of frames at `baud`, ±deviation, at `rate`. */
function frames(datas: [number, number][], baud: number, rate: number, devHz: number, invert = false): Float32Array {
  const bits: boolean[] = [];
  for (let i = 0; i < 64; i++) bits.push(i % 2 === 0);                // dotting
  for (const [d1, d2] of datas) for (const b of encodeEdacsFrame(d1, d2)) bits.push((b === 1) !== invert);
  return concat(silence(2000), fsk(bits, baud, rate, devHz), silence(2000));
}
function receive(iq: Float32Array, rate: number, baud: number): (number | null)[][] {
  const rx = new EdacsRx(rate, baud), out: (number | null)[][] = [];
  rx.onFrame = (a, b) => out.push([a, b]);
  const n = iq.length / 2, zi = new Float32Array(n), zq = new Float32Array(n);
  for (let i = 0; i < n; i++) { zi[i] = iq[2 * i]; zq[i] = iq[2 * i + 1]; }
  for (let o = 0; o < n; o += 4096) rx.push(zi.subarray(o, o + 4096), zq.subarray(o, o + 4096), Math.min(4096, n - o));
  return out;
}

test('receiver: 9600 bd frames at 48 ksps with noise decode, in either polarity; 4800 bd narrowband too', () => {
  const [g1, g2] = groupMsg(0, 4242, 5, true, 321);
  const site = mt7(7, (0x08 << 17) | (1 << 12) | (1 << 9) | 7);
  const datas: [number, number][] = [[g1, g2], [site, 0], [g1, g2]];
  for (const invert of [false, true]) {
    const got = receive(awgn(frames(datas, 9600, 48_000, 2400, invert), 18, 3), 48_000, 9600);
    assert.deepEqual(got, datas, `polarity ${invert ? 'inverted' : 'normal'}`);
  }
  assert.deepEqual(receive(awgn(frames(datas, 4800, 24_000, 1200), 18, 4), 24_000, 4800), datas);
  assert.match(edacsLine(parseEdacs(g1, g2)), /GROUP CALL · group 321 · LID 4242 · LCN 5 · analog/);
});

test('receiver: noise alone finds no frames', () => {
  assert.deepEqual(receive(awgn(silence(200_000), 0, 9), 48_000, 9600), []);
});
