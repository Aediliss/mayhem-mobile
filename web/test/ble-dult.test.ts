// FORK: the tracker alert listens to what a tracker says of its owner (ble-dult.ts): DULT's near-owner bit, Find My's
// payload length, Find Hub's unwanted-tracking frame. With its owner: no alert however long or far; separated: the alert
// says so; a tracker that says nothing (Tile) is judged by time and distance as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleTracker, parseAdv, TRACKER_ALERT_MS } from '../src/ble.js';
import { ownerState } from '../src/ble-dult.js';
import { ad, advPdu } from './lib/ble.js';

const adv = (data: number[], mac = 'C0:FF:EE:00:00:01') => parseAdv(advPdu(2, mac, data), -60, 37, '1M')!;
const dult = (near: boolean) => adv([...ad(0x16, [0xb2, 0xfc, 0x01, near ? 1 : 0])]);
const findMy = (long: boolean) => adv([...ad(0xff, [0x4c, 0x00, 0x12, long ? 0x19 : 0x02, 0x00, ...Array(long ? 25 : 2).fill(0)])]);
const findHub = (frame: number) => adv([...ad(0x16, [0xaa, 0xfe, frame, ...Array(20).fill(0)])]);
const tile = () => adv([...ad(0x03, [0xed, 0xfe])]);

test('owner state: DULT bit, Find My length, Find Hub frame; others say nothing', () => {
  assert.deepEqual([ownerState(dult(true)).state, ownerState(dult(false)).state, ownerState(dult(false)).network], ['near owner', 'separated', 1]);
  assert.deepEqual([ownerState(findMy(false)).state, ownerState(findMy(true)).state], ['near owner', 'separated']);
  assert.deepEqual([ownerState(findHub(0x41)).state, ownerState(findHub(0x40)).state], ['separated', 'not stated']);
  assert.equal(ownerState(tile()).state, 'not stated');
});

/** Hears one advertisement every minute for `mins` minutes while you walk north `walkM` meters in all. */
function follow(make: () => ReturnType<typeof adv>, mins: number, walkM = 0) {
  const t = new BleTracker(); let d;
  for (let i = 0; i <= mins; i++) d = t.add(make(), i * 60_000, { lat: 52 + (walkM * i / mins) / 111_000, lon: 4 });
  return d!;
}

test('alerts: a tracker with its owner never alerts; a separated one says so; one that says nothing is judged as before', () => {
  assert.equal(TRACKER_ALERT_MS, 20 * 60_000);
  assert.equal(follow(() => findMy(false), 40, 2000).alert, '');              // with its owner, 40 min, 2 km: not following you
  assert.equal(follow(() => dult(true), 40, 2000).alert, '');
  assert.match(follow(() => findMy(true), 25).alert, /NEAR YOU FOR 25 MIN · SEPARATED FROM ITS OWNER$/);
  assert.match(follow(() => dult(false), 10, 1000).alert, /MOVING WITH YOU .* · SEPARATED FROM ITS OWNER$/);
  assert.match(follow(() => tile(), 25).alert, /^TILE NEAR YOU FOR 25 MIN$/);
  assert.equal(follow(() => tile(), 10).alert, '');
  const d = follow(() => dult(false), 5);
  assert.deepEqual([d.kind, d.tracker, d.owner], ['dult', true, 'separated']);
  assert.match(d.fields.find(f => f.name === 'Owner')!.value, /^separated from its owner \(DULT near-owner bit\) · network 0x01$/);
});
