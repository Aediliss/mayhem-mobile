// FORK: LTR through Dispatch's real engine: a busy repeater in a span is found and classed by the data under its voice,
// its own LCN learned from the calls it names, the plan proved by that LCN sitting on its frequency, and the call listed
// on the repeater itself with its FM voice followed there. Without a plan the repeater is listed by its frequency and
// the call still sits on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetProcessor } from '../src/dsp/fleet/fleet.js';
import { setPlans, parsePlans } from '../src/dsp/fleet/plugins.js';
import { encodeLtr } from '../src/dsp/fleet/ltr.js';
import { fmModulate, toInt8 } from './lib/iq.js';

const RATE = 960_000, CENTER = 461_100_000, REP = 461_037_500;   // repeater 3 of the plan below

function run(plan: string): ReturnType<FleetProcessor['snapshot']> {
  setPlans(parsePlans(plan).plans);
  // repeater 3 carries group 0-03-045 for 7 s: 300 bit/s data at ±1 kHz under a 1 kHz voice tone at 2.5 kHz
  const words: number[] = [];
  while (words.length < 7 * 300) for (const b of encodeLtr({ area: 0, chan: 3, home: 3, group: 45, free: 4 })) words.push(b);
  const n = Math.round(words.length / 300 * RATE), m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (words[Math.floor(i * 300 / RATE)] ? 1 : -1) + 2.5 * Math.sin(2 * Math.PI * 1000 * i / RATE);
  const iq = fmModulate(m, RATE, 1000, REP - CENTER);
  let seed = 3; for (let k = 0; k < iq.length; k++) { seed = (seed * 1103515245 + 12345) >>> 0; iq[k] = iq[k] * 0.6 + 0.02 * (seed / 2 ** 32 - 0.5); }
  const fleet = new FleetProcessor(null);
  const t0 = Date.UTC(2026, 10, 26, 12); let sent = 0;
  fleet.now = () => t0 + (sent / RATE) * 1000;
  fleet.centerHz = CENTER; fleet.reset(RATE);
  const i8 = toInt8(iq, 100), BUF = 131072;
  for (let o = 0; o < i8.length; o += BUF) { const b = i8.subarray(o, Math.min(i8.length, o + BUF)); fleet.onIq(b, RATE); sent += b.length / 2; }
  return fleet.snapshot();
}

test('Dispatch finds a busy LTR repeater, proves the plan by its own LCN and follows the voice on it', { timeout: 120_000 }, () => {
  const snap = run('LTR Shop net: 461.0125 461.0250 461.0375 461.0500 461.0625');
  const car = snap.carriers.find(c => Math.abs(c.hz - REP) < 5_000);
  assert.ok(car, `carriers: ${snap.carriers.map(c => (c.hz / 1e6).toFixed(4) + ' ' + c.cls).join(', ')}`);
  assert.equal(car!.cls, 'LTR');
  const sys = snap.systems.find(s => s.proto === 'LTR');
  assert.ok(sys); assert.equal(sys!.label, 'LTR · Shop net');
  assert.deepEqual([sys!.sites[0].label, sys!.sites[0].time], ['REPEATER 3', 'Shop net']);
  const call = snap.calls.find(c => c.tg === 3045);                        // 0-03-045
  assert.ok(call, `calls: ${JSON.stringify(snap.calls.map(c => [c.tg, c.hz]))}`);
  assert.deepEqual([call!.proto, call!.hz, call!.codec], ['LTR', 461_037_500, 'fm']);
  assert.ok((call as unknown as { voiceMs: number }).voiceMs > 1000, `voice ${(call as unknown as { voiceMs: number }).voiceMs} ms`);
});

test('without a plan the repeater is listed by its frequency and its call still sits on it', { timeout: 120_000 }, () => {
  const snap = run('');
  const sys = snap.systems.find(s => s.proto === 'LTR');
  assert.ok(sys); assert.equal(sys!.label, `LTR · ${(snap.carriers.find(c => c.cls === 'LTR')!.hz / 1e6).toFixed(4)} MHz`);
  const call = snap.calls.find(c => c.tg === 3045);
  assert.ok(call); assert.ok(Math.abs(call!.hz - REP) < 5_000, `call at ${call!.hz}`);
});
