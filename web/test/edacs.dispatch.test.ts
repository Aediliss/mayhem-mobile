// FORK: EDACS through Dispatch's real engine (FleetProcessor): a control channel in a span is found and classed, its
// site identified, the typed LCN plan proved against it, and its calls listed with frequencies, analog vs ProVoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetProcessor } from '../src/dsp/fleet/fleet.js';
import { setPlans, parsePlans } from '../src/dsp/fleet/plugins.js';
import { encodeEdacsFrame } from '../src/dsp/fleet/edacs.js';
import { fsk, toInt8 } from './lib/iq.js';

const RATE = 1_000_000, CENTER = 851_200_000, CC = 851_012_500;   // the control channel well inside the span
const mt7 = (mtB: number, rest: number) => (7 << 25) | (mtB << 22) | rest;
const site = (id: number, ccLcn: number): [number, number] => [mt7(7, (0x08 << 17) | (ccLcn << 12) | (1 << 9) | id), 0];
const group = (mtA: number, lid: number, lcn: number, grp: number): [number, number] => [(mtA << 25) | (((lid >> 7) & 0x7f) << 18) | (lcn << 12) | (1 << 11) | grp, (lid & 0x7f) << 17];

/** Seconds of an EDACS control channel at `offsetHz` in the span: 9600 bd FSK, the given messages in turn. */
function controlChannel(seconds: number, msgs: [number, number][], offsetHz: number): Float32Array {
  const bits: boolean[] = []; let i = 0;
  while (bits.length < seconds * 9600) { for (const b of encodeEdacsFrame(...msgs[i % msgs.length])) bits.push(b === 1); i++; }
  return fsk(bits, 9600, RATE, 2400, { offsetHz, amp: 0.6 });
}

test('Dispatch finds an EDACS site, proves the typed plan and lists its calls (analog and ProVoice)', { timeout: 120_000 }, () => {
  const { plans, errors } = parsePlans('EDACS Test site 21: 851.0125 851.5125 852.0125 852.5125  # LCN 1-4\nnot a plan line');
  assert.equal(plans.length, 1); assert.equal(errors.length, 1);
  setPlans(plans);
  const iq = controlChannel(6, [site(21, 1), group(0, 4242, 3, 1234), site(21, 1), group(2, 99, 2, 777)], CC - CENTER);
  // a little noise so the carrier finder has a floor to measure against
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  for (let k = 0; k < iq.length; k++) iq[k] += 0.02 * rnd();
  const fleet = new FleetProcessor(null);
  let t = Date.UTC(2026, 10, 26, 12), sent = 0;
  fleet.now = () => t + (sent / RATE) * 1000;               // simulated time: the radio's samples, not the wall clock
  fleet.centerHz = CENTER; fleet.reset(RATE);
  const i8 = toInt8(iq, 100), BUF = 131072;
  for (let o = 0; o < i8.length; o += BUF) { const b = i8.subarray(o, Math.min(i8.length, o + BUF)); fleet.onIq(b, RATE); sent += b.length / 2; }
  const snap = fleet.snapshot();
  const car = snap.carriers.find(c => Math.abs(c.hz - CC) < 5_000);
  assert.ok(car, `carriers: ${snap.carriers.map(c => (c.hz / 1e6).toFixed(4) + ' ' + c.cls).join(', ')}`);
  assert.equal(car!.cls, 'EDACS'); assert.equal(car!.role, 'control');
  const sys = snap.systems.find(s => s.proto === 'EDACS');
  assert.ok(sys); assert.equal(sys!.label, 'EDACS · SITE 21');
  assert.equal(sys!.sites[0].time, 'Test site 21');
  assert.deepEqual(sys!.sites[0].lcns.map(l => l.hz), [851_012_500, 851_512_500, 852_012_500, 852_512_500]);
  const analog = snap.calls.find(c => c.tg === 1234), digital = snap.calls.find(c => c.tg === 777);
  assert.ok(analog && digital, `calls: ${JSON.stringify(snap.calls.map(c => [c.tg, c.hz, c.codec]))}`);
  assert.deepEqual([analog!.proto, analog!.hz, analog!.codec, analog!.group, analog!.src], ['EDACS', 852_012_500, 'fm', true, 4242]);
  assert.deepEqual([digital!.proto, digital!.hz, digital!.codec], ['EDACS', 851_512_500, 'provoice']);   // listed, never voiced
  assert.ok(snap.units.some(u => u.id === 4242));
});
