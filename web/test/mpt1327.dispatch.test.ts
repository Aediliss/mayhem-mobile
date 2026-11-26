// FORK: MPT1327 through Dispatch's real engine: a control channel in a span is found and classed, the system identity
// read from its CCSC, a linear band plan proved by the control channel sitting on its grid, and a GTC listed as a call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetProcessor } from '../src/dsp/fleet/fleet.js';
import { setPlans, parsePlans } from '../src/dsp/fleet/plugins.js';
import { encodeMptSlot, mptAddress } from '../src/dsp/fleet/mpt1327.js';
import { afsk, fmModulate, hold, toInt8 } from './lib/iq.js';

const RATE = 960_000, CENTER = 169_400_000, CC = 169_487_500;   // channel 40 on ch0 168.9875 / 12.5 kHz

test('Dispatch finds an MPT1327 site, proves a linear band plan and lists its calls', { timeout: 120_000 }, () => {
  const { plans, errors } = parsePlans('MPT1327 Taxi net: ch0=168.9875 step=12.5');
  assert.deepEqual(errors, []); assert.deepEqual([plans[0].base, plans[0].step], [168_987_500, 12_500]);
  setPlans(plans);
  const aloha = mptAddress({ pfix: 0, ident1: 0, type: 256, rest: [[40, 44, 3], [45, 48, 2]] });
  const gtc = mptAddress({ pfix: 12, ident1: 2001, type: 0, rest: [[24, 33, 52], [34, 46, 345]] });
  const bits: boolean[] = []; for (let i = 0; i < 32; i++) bits.push(i % 2 === 0);
  while (bits.length < 7 * 1200) for (const a of [aloha, gtc, aloha, aloha]) for (const b of encodeMptSlot(0x2a5b, a)) bits.push(b === 1);
  const iq = fmModulate(hold(afsk(bits, 1200, 48_000, 1200, 1800), RATE / 48_000), RATE, 2500, CC - CENTER);
  let seed = 3; for (let k = 0; k < iq.length; k++) { seed = (seed * 1103515245 + 12345) >>> 0; iq[k] = iq[k] * 0.6 + 0.02 * (seed / 2 ** 32 - 0.5); }
  const fleet = new FleetProcessor(null);
  const t0 = Date.UTC(2026, 10, 26, 12); let sent = 0;
  fleet.now = () => t0 + (sent / RATE) * 1000;
  fleet.centerHz = CENTER; fleet.reset(RATE);
  const i8 = toInt8(iq, 100), BUF = 131072;
  for (let o = 0; o < i8.length; o += BUF) { const b = i8.subarray(o, Math.min(i8.length, o + BUF)); fleet.onIq(b, RATE); sent += b.length / 2; }
  const snap = fleet.snapshot();
  const car = snap.carriers.find(c => Math.abs(c.hz - CC) < 5_000);
  assert.ok(car, `carriers: ${snap.carriers.map(c => (c.hz / 1e6).toFixed(4) + ' ' + c.cls).join(', ')}`);
  assert.deepEqual([car!.cls, car!.role], ['MPT1327', 'control']);
  const sys = snap.systems.find(s => s.proto === 'MPT1327');
  assert.ok(sys); assert.equal(sys!.label, 'MPT1327 · SYS 2A5B');
  assert.equal(sys!.sites[0].time, 'Taxi net');
  const call = snap.calls.find(c => c.tg === 2001);
  assert.ok(call, `calls: ${JSON.stringify(snap.calls.map(c => [c.tg, c.hz]))}`);
  assert.deepEqual([call!.proto, call!.hz, call!.codec, call!.src], ['MPT1327', 169_637_500, 'fm', 345]);   // channel 52
});
