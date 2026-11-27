// FORK: marine DSC (dsp/dsc.ts), against ITU-R M.493-16: the 10-bit code (every symbol in Table A1-1 that the PDF prints
// is checked against dscBits), MMSI/position/time/channel coding, the ECC, and calls end to end as 1300/2100 Hz AFSK
// on the FM discriminator: a distress alert, a distress relay and acknowledgement from a coast station, a routine
// individual call proposing a working channel, a position reply; bit errors the RX copies mend; noise and a wrong
// ECC give nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DscDecoder, dscBits, dscCallBits, dscInfo, dscLine, dscSymbol, mmsiChars, parseDsc, type DscCall } from '../src/dsp/dsc.js';
import { afsk } from './lib/iq.js';

// Table A1-1 rows as M.493-16 prints them (B = 0, Y = 1, bit 1 first)
const TABLE: [number, string][] = [[0, 'BBBBBBBYYY'], [1, 'YBBBBBBYYB'], [3, 'YYBBBBBYBY'], [15, 'YYYYBBBBYY'], [43, 'YYBYBYBBYY'], [63, 'YYYYYYBBBY'],
  [99, 'YYBBBYYBYY'], [104, 'BBBYBYYYBB'], [117, 'YBYBYYYBYB'], [122, 'BYBYYYYBYB'], [125, 'YBYYYYYBBY'], [126, 'BYYYYYYBBY'], [127, 'YYYYYYYBBB']];

test('the ten-bit code: Table A1-1 rows, and a single bit error is caught', () => {
  for (const [sym, row] of TABLE) {
    assert.equal(dscBits(sym).map(b => (b ? 'Y' : 'B')).join(''), row, `symbol ${sym}`);
  }
  for (let s = 0; s < 128; s++) {
    const b = dscBits(s); assert.equal(dscSymbol(b), s);
    for (let i = 0; i < 10; i++) { const c = b.slice(); c[i] ^= 1; assert.equal(dscSymbol(c), -1, `${s} bit ${i}`); }
  }
});

test('fields: MMSI, position, time; the ECC (even vertical parity, one format specifier, the EOS)', () => {
  assert.deepEqual(mmsiChars('366123450'), [36, 61, 23, 45, 0]);
  // distress alert: sinking at 37°48'N 122°25'W, 14:32 UTC
  const info = dscInfo(112, [...mmsiChars('366123450'), 105, 13, 74, 81, 22, 25, 14, 32, 100], 127);
  const c = parseDsc(info)!;
  assert.deepEqual([c.formatName, c.from, c.natureName, c.utc, c.eccOk], ['Distress', '366123450', 'Sinking', '14:32', true]);
  assert.ok(Math.abs(c.pos!.lat - 37.8) < 1e-9 && Math.abs(c.pos!.lon + (122 + 25 / 60)) < 1e-9, JSON.stringify(c.pos));
  assert.equal(dscLine(c), "DSC DISTRESS ALERT · from 366123450 · Sinking · 37°48'N 122°25'W · at 14:32 UTC");
  const bad = info.slice(); bad[bad.length - 1] ^= 1;
  assert.equal(parseDsc(bad)!.eccOk, false);
});

/** A call's audio as the FM discriminator gives it: 1300 Hz for a 1, 2100 Hz for a 0, 1200 baud. */
function audio(info: number[], rate = 48_000, flip: number[] = []): Float32Array {
  const bits = dscCallBits(info); for (const i of flip) bits[i] ^= 1;
  const pad = new Array(240).fill(0).map((_, i) => i & 1);   // more dot pattern before, carrier after
  return afsk([...pad, ...bits, ...pad].map(b => !!b), 1200, rate, 1300, 2100);
}
function run(x: Float32Array, rate = 48_000): DscCall[] {
  const out: DscCall[] = [], d = new DscDecoder(m => { if (m.type === 'dsc') out.push(m.call as DscCall); });
  d.reset(rate); for (let o = 0; o < x.length; o += 4096) d.onFm(x.subarray(o, o + 4096), Math.min(4096, x.length - o), rate);
  return out;
}

test('end to end: distress alert, relay and acknowledgement from a coast station, an individual call, a position reply', () => {
  const ship = '366123450', coast = '003669999';
  const alert = dscInfo(112, [...mmsiChars(ship), 105, 13, 74, 81, 22, 25, 14, 32, 100], 127);
  const relay = dscInfo(116, [112, ...mmsiChars(coast), 112, ...mmsiChars(ship), 105, 13, 74, 81, 22, 25, 14, 32, 100], 127);
  const ack = dscInfo(116, [112, ...mmsiChars(coast), 110, ...mmsiChars(ship), 105, 13, 74, 81, 22, 25, 14, 32, 100], 127);
  // routine individual call to the ship: all modes TP, working channel 72 (HM 9, M 0, H 0, T 7, U 2 → 90 00 72)
  const call = dscInfo(120, [...mmsiChars(ship), 100, ...mmsiChars('338765430'), 100, 126, 90, 0, 72, 126, 126, 126], 117);
  // position reply (VHF Table A1-4.7): category safety, telecommand 121, Pos4 = position + 126, then UTC
  const posr = dscInfo(120, [...mmsiChars('338765430'), 108, ...mmsiChars(ship), 121, 126, 13, 74, 81, 22, 25, 126, 14, 40], 122);
  const got = run(Float32Array.from([...audio(alert), ...audio(relay), ...audio(ack), ...audio(call), ...audio(posr)]));
  assert.equal(got.length, 5);
  assert.deepEqual(got.map(dscLine), [
    "DSC DISTRESS ALERT · from 366123450 · Sinking · 37°48'N 122°25'W · at 14:32 UTC",
    "DSC DISTRESS RELAY · from 003669999 · about 366123450 · Sinking · 37°48'N 122°25'W · at 14:32 UTC",
    "DSC DISTRESS ACKNOWLEDGEMENT · from 003669999 · about 366123450 · Sinking · 37°48'N 122°25'W · at 14:32 UTC",
    'DSC ROUTINE INDIVIDUAL · from 338765430 · to 366123450 · F3E/G3E all modes TP · channel 72 · acknowledgement requested',
    "DSC SAFETY INDIVIDUAL · from 366123450 · to 338765430 · 37°48'N 122°25'W · at 14:40 UTC · Ship position or location registration updating · acknowledgement",
  ]);
});

test('time diversity: a damaged DX copy is read from its RX copy; noise and a broken call give nothing', () => {
  const info = dscInfo(112, [...mmsiChars('235009876'), 101, 5, 3, 0, 0, 30, 10, 5, 100], 127);
  // hit one bit in several DX characters (20 dot bits, then 2 × 10 per DX/RX pair; DX slot j starts at 20 + 20j)
  const dxHits = [6, 8, 11, 14, 17].map(j => 20 + 20 * j + 3);
  const got = run(audio(info, 48_000, dxHits));
  assert.equal(got.length, 1); assert.equal(got[0].natureName, 'Flooding'); assert.equal(got[0].from, '235009876');
  // the same characters hit in both copies: unrecoverable, nothing reported
  const both = [8, 11].flatMap(j => [20 + 20 * j + 3, 20 + 20 * (j + 2) + 10 + 3]);
  assert.equal(run(audio(info, 48_000, both)).length, 0);
  let seed = 5; const noise = Float32Array.from({ length: 48_000 * 3 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 - 0.5; });
  assert.equal(run(noise).length, 0);
});
