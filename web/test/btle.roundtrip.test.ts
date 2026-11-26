// FORK: BLE round trip: test transmitter (lib/ble.ts) -> GFSK BT 0.5, ±250 kHz at 4 Msps -> int8 -> BtleDecoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BtleDecoder } from '../src/dsp/btle.js';
import { adName, ad, advBits, advPdu } from './lib/ble.js';
import { awgn, concat, feed, fsk, silence, toInt8 } from './lib/iq.js';

const RATE = 4_000_000;

function run(bits: boolean[], channel: number, snrDb: number | null, decoderChannel = channel): { lines: string[]; pdus: number[][] } {
  const lines: string[] = [], pdus: number[][] = [];
  const d = new BtleDecoder(m => { if (m.type === 'packet') lines.push(m.line as string); if (m.type === 'ble') pdus.push(m.pdu as number[]); });
  d.channel = decoderChannel; d.reset(RATE);
  let iq = concat(silence(4000), fsk(bits, 1e6, RATE, 250_000, { bt: 0.5 }), silence(4000));
  if (snrDb !== null) iq = awgn(iq, snrDb, 3);
  feed(d, toInt8(iq, snrDb === null ? 100 : 40), RATE);
  return { lines, pdus };
}

const PDU = advPdu(2, 'C0:FF:EE:12:34:56', [...ad(0x01, [0x06]), ...adName('MadTest')]);   // ADV_NONCONN_IND

test('BLE: an advertisement decodes with its MAC, address type and name', () => {
  const { lines, pdus } = run(advBits(PDU, 37), 37, null);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0], /^ADV_NONCONN_IND\s+C0:FF:EE:12:34:56 rnd/);
  assert.ok(lines[0].includes("name 'MadTest'") && lines[0].includes('flags 0x06'), lines[0]);
  assert.deepEqual(pdus[0], PDU);
});

test('BLE: decodes on channels 38 and 39 at 15 dB SNR', () => {
  for (const ch of [38, 39]) assert.equal(run(advBits(PDU, ch), ch, 15).lines.length, 1, `channel ${ch}`);
});

test('BLE: wrong whitening channel or a flipped bit fails the CRC', () => {
  assert.equal(run(advBits(PDU, 37), 37, null, 38).lines.length, 0);
  const bits = advBits(PDU, 37); bits[40 + 8 * 10 + 3] = !bits[40 + 8 * 10 + 3];
  assert.equal(run(bits, 37, null).lines.length, 0);
});

test('BLE: noise alone decodes nothing', () => {
  const lines: string[] = [];
  const d = new BtleDecoder(m => { if (m.type === 'packet') lines.push(m.line as string); });
  d.reset(RATE); feed(d, toInt8(awgn(silence(400_000).map(() => 1), 0, 11), 40), RATE);
  assert.deepEqual(lines, []);
});
