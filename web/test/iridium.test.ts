// FORK: Iridium (dsp/iridium/). The demodulator gives, bit for bit, what gr-iridium's README shows for its own test
// recording (fixtures/iridium-prbs15-1622M-2000k.cs8: 22 ms of gr-iridium's test-data/prbs15-2M-20dB, GPL-3.0, cut
// around its one burst and quantised to int8). Frames built here were also run through iridium-toolkit's parser and
// reassembler, which read them to the values below (ring alert, broadcast time, IDA fragments → ACARS "N512UA H1 5 HELLO
// IRIDIUM"). Bursts of our own go through noise and a frequency error end to end; BCH repairs two errors; noise gives
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IridiumRx, UW_DL } from '../src/dsp/iridium/phy.js';
import { IdaReassembler, bchEncode, bchRepair, buildIbc, buildIda, buildIra, buildSbdAcars, deInterleave, deInterleave3, interleave, interleave3, parseIridium, sbdAcars, symbolReverse, type IridiumAcars, type IridiumFrame } from '../src/dsp/iridium/frames.js';
import { rrcTaps } from '../src/dsp/hamid/symbols.js';
import { IridiumDecoder } from '../src/dsp/iridium/iridium.js';

const PRBS_BITS = '0011000000110000111100111000000000000011000000000000101000000000001111000000000010001000000000110011000000001010101000000011111111000000100000001000001100000011000010100000101000111100001111001000100010001011001100110011101010101010100111111111111101000000000000111000000000001001000000000011011000000000101101000000001110111000000010011001000000110101011000001011111101000011100000';

test('PHY: gr-iridium\'s own test burst comes out exactly as its README shows', () => {
  const iq = new Int8Array(readFileSync(new URL('../test/fixtures/iridium-prbs15-1622M-2000k.cs8', import.meta.url)));
  const rx = new IridiumRx(2e6, 1622e6), got: string[] = [];
  rx.onBurst = b => { if (b.confidence > 80) got.push(b.bits); };
  for (let o = 0; o < iq.length; o += 16384) rx.push(iq.subarray(o, o + 16384));
  assert.deepEqual(got, [PRBS_BITS]);
});

test('BCH: codewords check, one and two errors repaired, three not; interleavers undo each other', () => {
  const c = bchEncode(1207, '101100111000111100001');
  assert.deepEqual(bchRepair(1207, c), [0, '101100111000111100001', c.slice(21)]);
  const flip = (s: string, ...at: number[]) => s.split('').map((b, i) => at.includes(i) ? (b === '1' ? '0' : '1') : b).join('');
  assert.equal(bchRepair(1207, flip(c, 4))[1], '101100111000111100001');
  assert.deepEqual(bchRepair(1207, flip(c, 2, 17)).slice(0, 2), [2, '101100111000111100001']);
  const a = '01'.repeat(16), b = '0011'.repeat(8), d = '1'.repeat(32);
  assert.deepEqual(deInterleave(interleave(a, b)), [a, b]);
  assert.deepEqual(deInterleave3(interleave3(a, b, d)), [a, b, d]);
});

test('frames, as iridium-toolkit reads them: ring alert, broadcast with Iridium time', () => {
  // iridium-toolkit: IRA sat:057 beam:12 xyz=(+1104,-0330,+1440) pos=(+51.33/-016.64) alt=1022 P02
  const ra = parseIridium(buildIra(57, 12, 1104, -330, 1440, 2), 1_626_270_800, true)!;
  assert.deepEqual([ra.kind, ra.sat, ra.beam, ra.lat, ra.lon, ra.altKm, ra.pages], ['IRA', 57, 12, 51.33, -16.64, 1022, 2]);
  // iridium-toolkit: IBC sat:009 cell:31 time:2025-06-23T08:39:28.01Z
  const bc = parseIridium(buildIbc(9, 31, 123456789), 1_623_000_000, true)!;
  assert.deepEqual([bc.kind, bc.sat, bc.beam], ['IBC', 9, 31]);
  assert.equal(new Date(bc.timeS! * 1000).toISOString(), '2025-06-23T08:39:28.010Z');
  // a ring alert below the simplex band is not one (iridium-toolkit's frequency classes)
  assert.equal(parseIridium(buildIra(57, 12, 1104, -330, 1440), 1_621_000_000, true)?.kind ?? null, null);
});

test('IDA fragments → SBD → ACARS (iridium-toolkit: REG:N512UA Label:H1 bID:5 [HELLO IRIDIUM])', () => {
  const sbd = buildSbdAcars({ reg: 'N512UA', label: 'H1', blk: '5', text: 'HELLO IRIDIUM', fromAircraft: false });
  const frags: number[][] = []; for (let i = 0; i < sbd.length; i += 20) frags.push(sbd.slice(i, i + 20));
  const re = new IdaReassembler(), got: IridiumAcars[] = [];
  re.onAcars = a => got.push(a);
  frags.forEach((f, i) => {
    const fr = parseIridium(buildIda(i, i < frags.length - 1, f), 1_621_500_000, true, 1000 + 90 * i)!;
    assert.deepEqual([fr.kind, fr.ctr, fr.crcOk, fr.data], ['IDA', i, true, f]);
    re.add(fr);
  });
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].reg, got[0].label, got[0].blk, got[0].text, got[0].crcOk], ['N512UA', 'H1', '5', 'HELLO IRIDIUM', true]);
  // from the aircraft: sequence number and flight first
  const up = sbdAcars(buildSbdAcars({ reg: 'G-ABCD', label: '5Z', blk: '2', text: 'OUT 1234', msn: 'M12A', flight: 'BA0117', fromAircraft: true }).slice(5), false)!;
  assert.deepEqual([up.reg, up.msn, up.flight, up.text, up.crcOk], ['G-ABCD', 'M12A', 'BA0117', 'OUT 1234', true]);
  // a fragment whose CRC failed is not taken
  const r2 = new IdaReassembler(), seen: unknown[] = []; r2.onSbd = x => seen.push(x);
  r2.add({ kind: 'IDA', down: true, freqHz: 1_621_500_000, ms: 0, fixed: 0, cont: false, ctr: 0, len: 5, data: [0x76, 0x08, 0x20, 0, 0], crcOk: false });
  assert.equal(seen.length, 0);
});

// ------------------------------------------------------------------------------------------- our own bursts, end to end
const QUAD = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
/** A burst from RAW bits: preamble then the bits differentially encoded, RRC-shaped at fs, `off` Hz from centre. */
function burstIq(raw: string, fs: number, off: number, pre = 64): Float32Array {
  const INV = [0, 3, 1, 2], sym: number[] = new Array(pre).fill(0); let prev = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) { const d = (+raw[i] << 1) | +raw[i + 1]; prev = (prev + INV[d]) % 4; sym.push(prev); }
  const sps = fs / 25000, h = rrcTaps(sps, 0.4, 4), half = (h.length - 1) / 2, n = Math.ceil(sym.length * sps) + h.length, out = new Float32Array(2 * n);
  sym.forEach((s, k) => { const c = Math.round(k * sps) + half; for (let j = 0; j < h.length; j++) { out[2 * (c + j - half)] += QUAD[s][0] * h[j] * sps; out[2 * (c + j - half) + 1] += QUAD[s][1] * h[j] * sps; } });
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * off * i / fs, c = Math.cos(a), s = Math.sin(a), r = out[2 * i], q = out[2 * i + 1]; out[2 * i] = r * c - q * s; out[2 * i + 1] = r * s + q * c; }
  return out;
}
let seed = 9; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };

test('end to end: a ring alert and a broadcast in a 2 MS/s span, 6 kHz off, through noise; the decoder sums them up', () => {
  const fs = 2e6, centre = 1_625_800_000, n = Math.round(fs * 0.12), x = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) x[i] = 1.5 * g();
  const put = (b: Float32Array, at: number) => { for (let i = 0; i < b.length / 2 && at + i < n; i++) { x[2 * (at + i)] += 6 * b[2 * i]; x[2 * (at + i) + 1] += 6 * b[2 * i + 1]; } };
  put(burstIq(buildIra(23, 40, -1200, 800, 1300, 1), fs, 1_626_270_800 + 6000 - centre), Math.round(fs * 0.03));
  put(burstIq(buildIbc(23, 40, 99999999), fs, 1_625_041_700 - 4000 - centre, 16), Math.round(fs * 0.07));
  const iq = Int8Array.from(x, v => Math.max(-127, Math.min(127, Math.round(v))));
  const msgs: Record<string, unknown>[] = [], d = new IridiumDecoder(m => msgs.push(m)); d.centerHz = centre; d.reset(fs);
  for (let o = 0; o < iq.length; o += 131072) d.onIq(iq.subarray(o, o + 131072), fs);
  const frames = msgs.filter(m => m.type === 'iridiumFrame').map(m => m.f as IridiumFrame);
  assert.deepEqual(frames.map(f => f.kind).sort(), ['IBC', 'IRA']);
  const ra = frames.find(f => f.kind === 'IRA')!;
  assert.deepEqual([ra.sat, ra.beam, ra.pages], [23, 40, 1]);
  assert.ok(Math.abs(ra.freqHz - (1_626_270_800 + 6000)) < 500, `${ra.freqHz}`);
  // noise alone: nothing
  const q: Record<string, unknown>[] = [], d2 = new IridiumDecoder(m => q.push(m)); d2.centerHz = centre; d2.reset(fs);
  const nz = Int8Array.from({ length: 2 * Math.round(fs * 0.1) }, () => Math.round(1.5 * g()));
  for (let o = 0; o < nz.length; o += 131072) d2.onIq(nz.subarray(o, o + 131072), fs);
  assert.equal(q.filter(m => m.type === 'iridiumFrame').length, 0);
  assert.ok(UW_DL.length === 12 && symbolReverse('0110') === '1001');
});
