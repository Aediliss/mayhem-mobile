// FORK: radio navigation aids (dsp/navaid.ts), against ICAO Annex 10's signal parameters: a VOR's radial read back from
// its 30 Hz variable AM and 30 Hz reference FM on 9960 Hz, at several bearings and through noise; ILS 90/150 Hz depths
// into DDM and SDM; the published frequency pairings (localizer ↔ glide path ↔ DME channel, as the FAA/RadioReference
// table lists them); end to end, a VOR with its Morse ident on 1020 Hz and a DME beacon's pulse pairs with its 1350 pair/s
// ident; noise gives no bearing and no ident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavaidProcessor, dmeFor, ilsReading, morseTimeline, navKind, pairedIls, vorBearing } from '../src/dsp/navaid.js';

let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
/** A VOR's AM envelope: carrier, 30 Hz variable (30%) lagging the reference by the bearing, 9960 Hz subcarrier
 *  (30%) frequency-modulated ±480 Hz by the 30 Hz reference, and a 1020 Hz ident keyed by `key(t)` (10%). */
const vorEnv = (t: number, bearing: number, key = (_t: number) => false) => {
  const w = 2 * Math.PI * 30 * t;
  return 1 + 0.3 * Math.cos(w - bearing * Math.PI / 180) + 0.3 * Math.cos(2 * Math.PI * 9960 * t + 16 * Math.sin(w)) + (key(t) ? 0.1 * Math.cos(2 * Math.PI * 1020 * t) : 0);
};

test('VOR: the radial read back at several bearings, and through noise', () => {
  const fs = 40_000, n = fs;
  for (const b of [0, 45, 137.5, 270, 359]) {
    const env = Float32Array.from({ length: n }, (_, i) => vorEnv(i / fs, b) + 0.05 * g());
    const r = vorBearing(env, n, fs), err = Math.abs(((r.bearingDeg - b + 540) % 360) - 180);
    assert.ok(r.ok && err < 1, `${b}° read ${r.bearingDeg}° (err ${err.toFixed(2)})`);
    assert.ok(Math.abs(r.varDepth - 0.3) < 0.02 && Math.abs(r.refDevHz - 480) < 30, `${r.varDepth} ${r.refDevHz}`);
  }
  const noise = Float32Array.from({ length: n }, () => 1 + 0.3 * g());
  assert.equal(vorBearing(noise, n, fs).ok, false);
});

test('ILS: 90 and 150 Hz depths into DDM and SDM (localizer 20% + 20%; 2% off course)', () => {
  const fs = 40_000, n = fs;
  const env = Float32Array.from({ length: n }, (_, i) => { const t = i / fs; return 1 + 0.21 * Math.cos(2 * Math.PI * 90 * t) + 0.19 * Math.cos(2 * Math.PI * 150 * t + 1); });
  const r = ilsReading(env, n, fs);
  assert.ok(Math.abs(r.m90 - 0.21) < 0.002 && Math.abs(r.m150 - 0.19) < 0.002, JSON.stringify(r));
  assert.ok(Math.abs(r.ddm - 0.02) < 0.002 && Math.abs(r.sdm - 0.4) < 0.003);
});

test('channels: what a frequency is, the paired glide path and DME channel (ICAO pairing)', () => {
  assert.deepEqual([navKind(108.1e6), navKind(334.7e6), navKind(113.9e6), navKind(1101e6), navKind(121.5e6)], ['LOC', 'GS', 'VOR', 'DME', null]);
  assert.deepEqual([pairedIls(108.1e6), pairedIls(111.95e6), pairedIls(335e6)], [334.7e6, 330.95e6, 110.3e6]);
  // 108.10 → 18X (reply 979 MHz), 108.15 → 18Y (1105), 112.30 → 70X (1157), 117.95 → 126Y (1087)
  assert.deepEqual([dmeFor(108.1e6), dmeFor(108.15e6), dmeFor(112.3e6), dmeFor(117.95e6), dmeFor(334.7e6)],
    [{ ch: '18X', replyHz: 979e6 }, { ch: '18Y', replyHz: 1105e6 }, { ch: '70X', replyHz: 1157e6 }, { ch: '126Y', replyHz: 1087e6 }, { ch: '18X', replyHz: 979e6 }]);
});

/** Key function from a Morse timeline that starts at `t0` seconds. */
function keyer(text: string, dotS: number, t0: number): (t: number) => boolean {
  const tl = morseTimeline(text, dotS), edges: [number, number][] = []; let t = t0;
  for (const [on, d] of tl) { if (on) edges.push([t, t + d]); t += d; }
  return (x: number) => edges.some(([a, b]) => x >= a && x < b);
}

test('end to end: a VOR at 113.90 MHz, 150 kHz off centre, bearing 211°, ident SFO', () => {
  const rate = 1e6, centre = 113_750_000, off = 150_000, secs = 5.2, n = Math.round(rate * secs);
  const key = keyer('SFO', 0.09, 0.4), iq = new Int8Array(2 * n);
  for (let i = 0; i < n; i++) {
    const t = i / rate, a = 40 * vorEnv(t, 211, key), ph = 2 * Math.PI * off * t;
    iq[2 * i] = Math.round(a * Math.cos(ph) + 2 * g()); iq[2 * i + 1] = Math.round(a * Math.sin(ph) + 2 * g());
  }
  const msgs: Record<string, unknown>[] = [], p = new NavaidProcessor(m => msgs.push(m));
  p.centerHz = centre; p.tunedHz = centre + off; p.reset(rate);
  for (let o = 0; o < iq.length; o += 131072) p.onIq(iq.subarray(o, o + 131072), rate);
  const nav = msgs.filter(m => m.type === 'navaid') as { kind: string; vor?: { bearingDeg: number; ok: boolean }; ident?: string }[];
  assert.ok(nav.length >= 8 && nav.every(m => m.kind === 'VOR'));
  const good = nav.filter(m => m.vor?.ok).map(m => m.vor!.bearingDeg);
  assert.ok(good.length >= 6 && good.every(b => Math.abs(b - 211) < 2), `${good}`);
  assert.equal(nav[nav.length - 1].ident, 'SFO');
});

test('end to end: a DME beacon (X pairs, 12 µs) — pulse pairs, rate, ident; noise: nothing', () => {
  const rate = 2e6, centre = 1_100_800_000, off = 200_000, secs = 5.2, n = Math.round(rate * secs), x = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) x[i] = 2 * g();
  const key = keyer('ABC', 0.1, 0.3);
  const pulse = (tUs: number) => { const c = Math.round(tUs * 2); for (let k = -8; k <= 8; k++) { const i = c + k; if (i < 0 || i >= n) continue; const a = 60 * Math.exp(-((k / 2) ** 2) / (2 * 1.5 ** 2)), ph = 2 * Math.PI * off * i / rate; x[2 * i] += a * Math.cos(ph); x[2 * i + 1] += a * Math.sin(ph); } };
  // squitter: random pairs, about 2000 a second; ident: pairs 740.7 µs apart while the key is down
  for (let t = 50; t < secs * 1e6 - 100; t += -Math.log(rnd() || 1e-9) * 500) { pulse(t); pulse(t + 12); }
  for (let t = 0; t < secs * 1e6; t += 1e6 / 1350) if (key(t / 1e6)) { pulse(t + 3); pulse(t + 15); }
  const iq = Int8Array.from(x, v => Math.max(-127, Math.min(127, Math.round(v))));
  const msgs: Record<string, unknown>[] = [], p = new NavaidProcessor(m => msgs.push(m));
  p.centerHz = centre; p.tunedHz = centre + off; p.reset(rate);
  for (let o = 0; o < iq.length; o += 262144) p.onIq(iq.subarray(o, o + 262144), rate);
  const nav = msgs.filter(m => m.type === 'navaid') as { kind: string; dme?: { mode: string; pairsPerS: number }; ident?: string }[];
  assert.ok(nav.length >= 6 && nav.every(m => m.kind === 'DME'));
  const last = nav[nav.length - 1];
  assert.equal(last.dme!.mode, 'X'); assert.ok(last.dme!.pairsPerS > 1500 && last.dme!.pairsPerS < 3500, `${last.dme!.pairsPerS}`);
  assert.equal(last.ident, 'ABC');
  // noise only: no pairs to speak of, no ident
  const q: Record<string, unknown>[] = [], p2 = new NavaidProcessor(m => q.push(m)); p2.centerHz = centre; p2.tunedHz = centre + off; p2.reset(rate);
  const nz = Int8Array.from({ length: 2 * rate }, () => Math.round(2 * g()));
  for (let o = 0; o < nz.length; o += 262144) p2.onIq(nz.subarray(o, o + 262144), rate);
  const nq = q.filter(m => m.type === 'navaid') as { dme?: { pairsPerS: number; mode: string }; ident?: string }[];
  assert.ok(nq.every(m => (m.dme?.pairsPerS ?? 0) < 50 && !m.ident));
});
