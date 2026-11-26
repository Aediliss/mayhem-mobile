// FORK: drone Remote ID (dsp/remoteid.ts): each message type built the way a drone builds it and read back, unknown
// values left out, a Message Pack, the drone record put together from Bluetooth 4 advertisements one message at a time,
// and a Remote ID advertisement through the BLE receiver over GFSK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRid, readRidServiceData, ridEncode, ridFields, type RidState } from '../src/dsp/remoteid.js';
import { BleTracker, parseAdv } from '../src/ble.js';
import { BtleDecoder } from '../src/dsp/btle.js';
import { ad, advBits, advPdu } from './lib/ble.js';
import { concat, feed, fsk, silence, toInt8 } from './lib/iq.js';

const LOC = { status: 2, dir: 237, speed: 12.5, vspeed: -1.5, lat: 52.3676543, lon: 4.9041234, altBaro: 145.5, altGeo: 160, height: 120, tenths: 18_123 };

test('messages: Basic ID, Location, Self-ID, System, Operator ID read back', () => {
  const s: RidState = { types: [] };
  assert.deepEqual(readRid(ridEncode.basicId(1, 2, '1581F5FKD229400B0JZM'), s), [0]);
  assert.deepEqual([s.uasId, s.idType, s.uaType], ['1581F5FKD229400B0JZM', 'serial number', 'multirotor / helicopter']);
  readRid(ridEncode.location(LOC), s);
  assert.deepEqual([s.status, s.direction, s.speed, s.vspeed, s.lat, s.lon, s.altBaro, s.altGeo, s.height, s.heightRef, s.hAcc, s.vAcc, s.time],
    ['airborne', 237, 12.5, -1.5, 52.3676543, 4.9041234, 145.5, 160, 120, 'above take-off', '< 10 m', '< 10 m', '30:12.3 past the hour']);
  readRid(ridEncode.selfId('Roof survey, block 7'), s);
  readRid(ridEncode.system({ lat: 52.3671, lon: 4.9035, alt: 2, category: 1, cls: 1 }), s);
  readRid(ridEncode.operatorId('NLD87astrdge12k8-xyz'), s);
  assert.deepEqual([s.selfId, s.opLat, s.opLon, s.opAlt, s.opLocType, s.category, s.uaClass, s.operatorId], ['Roof survey, block 7', 52.3671, 4.9035, 2, 'live GNSS', 'open', 'C1', 'NLD87astrdge12k8-xyz']);
  assert.deepEqual(s.types.sort(), [0, 1, 3, 4, 5]);
  // fast: the speed multiplier
  const f: RidState = { types: [] }; readRid(ridEncode.location({ ...LOC, speed: 90 }), f); assert.equal(f.speed, 90);
});

test('unknown values are left out; a bad pack or a foreign message reads nothing', () => {
  const s: RidState = { types: [] };
  const m = ridEncode.location({ ...LOC, lat: 0, lon: 0, altBaro: -1000, altGeo: -1000, height: -1000 });
  readRid(m, s);
  assert.deepEqual([s.lat, s.altBaro, s.altGeo, s.height], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(readRid([0xf2, 24, 1, ...Array(25).fill(0)], { types: [] }), []);
  assert.deepEqual(readRid([0x72, ...Array(24).fill(0)], { types: [] }), []);
  assert.deepEqual(readRidServiceData([0x0c, 0, ...ridEncode.selfId('x')], { types: [] }), []);   // not application code 0x0D
});

test('a Message Pack (Bluetooth 5 / Wi-Fi) carries several at once', () => {
  const s: RidState = { types: [] };
  assert.deepEqual(readRid(ridEncode.pack([ridEncode.basicId(1, 2, 'ABC123'), ridEncode.location(LOC), ridEncode.operatorId('OP-1')]), s), [0, 1, 5]);
  assert.deepEqual([s.uasId, s.lat, s.operatorId], ['ABC123', 52.3676543, 'OP-1']);
});

const advOf = (counter: number, msg: number[]) => advPdu(2, 'E8:12:34:56:78:9A', ad(0x16, ridEncode.serviceData(counter, msg).slice(0)));

test('Bluetooth 4: one message per advertisement, put together on one drone card', () => {
  const t = new BleTracker();
  const msgs = [ridEncode.basicId(1, 2, '1581F5FKD229400B0JZM'), ridEncode.location(LOC), ridEncode.system({ lat: 52.3671, lon: 4.9035, alt: 2, category: 1, cls: 1 }), ridEncode.operatorId('NLD87astrdge12k8-xyz')];
  let d; msgs.forEach((m, i) => { d = t.add(parseAdv(advOf(i, m), -55, 37, '1M')!, i * 1000); });
  assert.equal(t.devices.size, 1);
  assert.deepEqual([d!.kind, d!.tracker, d!.why], ['drone', false, 'ASTM F3411 Remote ID']);
  const f = Object.fromEntries(d!.fields.map(x => [x.name, x.value]));
  assert.equal(f['UAS ID'], '1581F5FKD229400B0JZM · serial number');
  assert.equal(f['Drone position'], '52.367654, 4.904123 · < 10 m');
  assert.equal(f['Operator position'], '52.367100, 4.903500 · live GNSS');
  assert.equal(f['Altitude'], '160 m geodetic · 145.5 m pressure · 120 m above take-off');
  assert.equal(f['EU category'], 'open · class C1');
  assert.ok(ridFields(d!.rid!).length >= 8);
});

test('over the air: a Remote ID advertisement through the BLE receiver', () => {
  const RATE = 4_000_000, pdu = advOf(7, ridEncode.location(LOC)), pdus: number[][] = [];
  const dec = new BtleDecoder(m => { if (m.type === 'ble') pdus.push(m.pdu as number[]); });
  dec.channel = 39; dec.reset(RATE);
  feed(dec, toInt8(concat(silence(4000), fsk(advBits(pdu, 39), 1e6, RATE, 250_000, { bt: 0.5 }), silence(4000)), 100), RATE);
  assert.deepEqual(pdus, [pdu]);
  const s: RidState = { types: [] }; readRidServiceData(parseAdv(pdus[0], -50, 39)!.svc[0].data, s);
  assert.equal(s.lat, 52.3676543);
});
