// FORK: BLE 5 extended advertising on the primary channels (dsp/ble-ext.ts): the extended header's fields, ADV_EXT_IND
// through the receiver over GFSK (a long one too, past the old 48-byte buffer), the device record with its PHY, and
// malformed or over-long legacy PDUs rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extAdvPdu, extLine, parseExtHeader } from '../src/dsp/ble-ext.js';
import { BtleDecoder } from '../src/dsp/btle.js';
import { parseAdv } from '../src/ble.js';
import { adName, advBits, advPdu } from './lib/ble.js';
import { concat, feed, fsk, silence, toInt8 } from './lib/iq.js';

const EXT = extAdvPdu({ advA: 'C0:FF:EE:00:11:22', mode: 0, adi: { did: 0x123, sid: 3 }, aux: { channel: 12, offset: 100, phy: 1 }, txPower: -8 });

test('extended header: AdvA, ADI, AuxPtr (channel, offset, PHY), TX power, mode', () => {
  const h = parseExtHeader(EXT)!;
  assert.deepEqual(h, { advMode: 'non-connectable', advA: 'C0:FF:EE:00:11:22', advARandom: true, adi: { did: 0x123, sid: 3 }, aux: { channel: 12, ca: 'up to 500 ppm', offsetUs: 3000, phy: '2M' }, txPower: -8, adData: [] });
  assert.equal(extLine(h), 'C0:FF:EE:00:11:22 rnd · non-connectable · set 3 data 291 · aux ch 12 2M +3000 µs · tx -8dBm');
  const coded = parseExtHeader(extAdvPdu({ adi: { did: 1, sid: 0 }, aux: { channel: 3, units300: true, offset: 20, phy: 2 } }))!;
  assert.deepEqual([coded.advA, coded.aux?.phy, coded.aux?.offsetUs], [undefined, 'Coded', 6000]);
  // a header that claims more than the PDU holds
  const bad = EXT.slice(); bad[2] = 0x3f; assert.equal(parseExtHeader(bad), null);
});

const RATE = 4_000_000;
function run(pdu: number[], ch = 37): { lines: string[]; msgs: { pdu: number[]; phy?: string }[] } {
  const lines: string[] = [], msgs: { pdu: number[]; phy?: string }[] = [];
  const d = new BtleDecoder(m => { if (m.type === 'packet') lines.push(m.line as string); if (m.type === 'ble') msgs.push(m as never); });
  d.channel = ch; d.reset(RATE);
  feed(d, toInt8(concat(silence(4000), fsk(advBits(pdu, ch), 1e6, RATE, 250_000, { bt: 0.5 }), silence(4000)), 100), RATE);
  return { lines, msgs };
}

test('receiver: ADV_EXT_IND decodes with its header line and PHY; one with 80 bytes of data too', () => {
  const r = run(EXT, 38);
  assert.equal(r.lines.length, 1); assert.match(r.lines[0], /^ADV_EXT_IND\s+C0:FF:EE:00:11:22 rnd · non-connectable · set 3 data 291 · aux ch 12 2M/);
  assert.deepEqual([r.msgs[0].pdu, r.msgs[0].phy], [EXT, '1M']);
  const long = extAdvPdu({ advA: '11:22:33:44:55:66', adi: { did: 7, sid: 1 }, adData: [...adName('A long extended name'), ...Array.from({ length: 58 }, (_, i) => i)] });
  assert.ok(long.length > 48);
  const r2 = run(long);
  assert.deepEqual(r2.msgs.map(m => m.pdu), [long]);
});

test('device record: AdvA as the address, the set for an anonymous one, the extended fields and the PHY', () => {
  const a = parseAdv(EXT, -50, 38, '1M')!;
  assert.deepEqual([a.pduType, a.mac, a.txPower, a.phy, a.ext?.aux?.channel], ['ADV_EXT_IND', 'C0:FF:EE:00:11:22', -8, '1M', 12]);
  const anon = parseAdv(extAdvPdu({ adi: { did: 5, sid: 9 }, aux: { channel: 1, offset: 10, phy: 0 } }), -60, 37, '1M')!;
  assert.equal(anon.mac, 'ANON SET 9');
  const named = parseAdv(extAdvPdu({ advA: '11:22:33:44:55:66', adData: adName('Sensor') }), -60, 37)!;
  assert.equal(named.name, 'Sensor');
  // legacy PDUs still parse as before
  assert.equal(parseAdv(advPdu(2, 'C0:FF:EE:12:34:56', adName('Old')), -40, 37, '1M')!.name, 'Old');
});

test('receiver: a legacy PDU claiming more than 37 bytes is still refused', () => {
  const p = advPdu(2, 'C0:FF:EE:12:34:56', Array.from({ length: 40 }, () => 0));
  assert.equal(run(p).lines.length, 0);
});
