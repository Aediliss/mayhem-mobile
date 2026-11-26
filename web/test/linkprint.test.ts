// FORK: drone control links and digital video, told by how they look (dsp/linkprint.ts, lookForOfdm in dsp/fpv.ts):
// LoRa packets found with their bandwidth and spreading factor; links that fit ExpressLRS's published 2.4 GHz and
// 900 MHz parameters named so, with their rate; an off-grid LoRa link not; noise, OFDM and FM video are not LoRa; OFDM's
// carrier spacing and symbol time measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkPrinter, LinkTracker, loraPacket, type LinkSeen } from '../src/dsp/linkprint.js';
import { compositeFm, lookForOfdm } from '../src/dsp/fpv.js';
import { buildBurst, buildFrame } from '../src/dsp/droneid.js';
import { fftInPlace } from '../src/dsp/ham/filters.js';

const FS = 15.36e6;
let seed = 2; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };

/** A hopping LoRa link heard for `secs` around `centre`: packets every `ivUs`, each on a random grid channel. */
function link(o: { centre: number; start: number; step: number; count: number; bw: number; sf: number; ivUs: number; secs: number; symbols?: number }): Int8Array {
  const n = Math.round(o.secs * FS), x = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) x[i] = 0.02 * g();
  let k = 0;
  for (let t = 0.01; t < o.secs - 0.02; t += o.ivUs / 1e6, k++) {
    const fc = o.start + Math.floor(rnd() * o.count) * o.step, off = fc - o.centre;
    if (Math.abs(off) > FS / 2 - o.bw) continue;
    const p = loraPacket(FS, o.bw, o.sf, off, o.symbols ?? 20, k + 1), at = Math.round(t * FS);
    for (let i = 0; i < p.length / 2 && at + i < n; i++) { x[2 * (at + i)] += 0.3 * p[2 * i]; x[2 * (at + i) + 1] += 0.3 * p[2 * i + 1]; }
  }
  return Int8Array.from(x, v => Math.max(-127, Math.min(127, Math.round(v * 128))));
}
function hear(iq: Int8Array, centre: number): LinkSeen[] {
  const lp = new LinkPrinter(FS, centre), tr = new LinkTracker();
  lp.onBurst = b => tr.add(b);
  for (let o = 0; o < iq.length; o += 262144) lp.push(iq.subarray(o, o + 262144));
  return [...tr.links.values()].filter(l => l.sure);
}

test('ExpressLRS 2.4 GHz: SF5 / 500 Hz, SF6 / 250 Hz, SF7 / 150 Hz on its grid', () => {
  for (const [sf, iv, rate] of [[5, 2000, 500], [6, 4000, 250], [7, 6666, 150]]) {
    const l = hear(link({ centre: 2440e6, start: 2400.4e6, step: 1e6, count: 80, bw: 812_500, sf, ivUs: iv, secs: 0.4 }), 2440e6);
    assert.equal(l.length, 1, `SF${sf}: ${JSON.stringify(l.map(x => x.key))}`);
    assert.deepEqual([l[0].sf, l[0].bwHz, l[0].fits, l[0].rateHz], [sf, 812_500, 'ExpressLRS 2.4 GHz', rate]);
    assert.ok(l[0].channels.length >= 4);
  }
});

test('ExpressLRS 900 MHz (FCC915): SF7 at 500 kHz, 100 Hz', () => {
  const l = hear(link({ centre: 915e6, start: 903.5e6, step: (926.9e6 - 903.5e6) / 39, count: 40, bw: 500_000, sf: 7, ivUs: 10_000, secs: 0.8, symbols: 14 }), 915e6);
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].sf, l[0].bwHz, l[0].fits, l[0].rateHz], [7, 500_000, 'ExpressLRS 900 MHz (FCC915)', 100]);
});

test('a LoRa link off every ExpressLRS grid is found but not named', () => {
  const l = hear(link({ centre: 2440e6, start: 2437.25e6, step: 2.5e6, count: 3, bw: 812_500, sf: 6, ivUs: 4000, secs: 0.4 }), 2440e6);
  assert.equal(l.length, 1); assert.equal(l[0].fits, '');
});

test('not LoRa: noise, DroneID OFDM bursts, analog FM video', () => {
  const noise = Int8Array.from({ length: 2 * 1_000_000 }, () => Math.round(3 * g()));
  assert.deepEqual(hear(noise, 2440e6), []);
  const b = buildBurst(buildFrame({ serial: 'X', lat: 1, lon: 1, height: 1, altitude: 1, pilotLat: 1, pilotLon: 1, homeLat: 1, homeLon: 1 }));
  const ofdm = new Float32Array(2 * 1_000_000).map(() => 0.02 * g());
  for (let k = 0; k < 20; k++) { const at = 20_000 + k * 45_000; for (let i = 0; i < b.length / 2; i++) { ofdm[2 * (at + i)] += 0.3 * b[2 * i]; ofdm[2 * (at + i) + 1] += 0.3 * b[2 * i + 1]; } }
  assert.deepEqual(hear(Int8Array.from(ofdm, v => Math.round(v * 128)), 2440e6), []);
  const fm = compositeFm('NTSC', FS, 0.05);
  assert.deepEqual(hear(Int8Array.from(fm, v => Math.round(v * 60)), 2440e6), []);
});

test('digital video (OFDM): carrier spacing and symbol time measured; noise is not OFDM', () => {
  // mulberry32: an LCG's repeating low bits would make the content itself repeat, which this measure would rightly find
  let m = 0x9e3779b9; const mb = () => { m = (m + 0x6d2b79f5) >>> 0; let t = m; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 - 0.5; };
  // the numerology DJI's OFDM uses: 1024 points at 15.36 MS/s (15 kHz carriers, 66.7 µs symbols), a 72-sample CP,
  // 600 carriers (about 9 MHz occupied), random QPSK in every symbol
  const N = 1024, CPL = 72, x = new Float32Array(2 * 65536);
  for (let at = 0; at + N + CPL <= 65536; at += N + CPL) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < 600; i++) { const k = ((i < 300 ? i - 300 : i - 299) + N) % N; re[k] = mb() < 0 ? -1 : 1; im[k] = mb() < 0 ? -1 : 1; }
    fftInPlace(re, im, true);
    for (let n = 0; n < N + CPL; n++) { const m = (n + N - CPL) % N; x[2 * (at + n)] = re[m] * 30; x[2 * (at + n) + 1] = im[m] * 30; }
  }
  const o = lookForOfdm(x.map(v => v + 0.05 * mb()), FS)!;
  assert.ok(o, 'OFDM found');
  assert.deepEqual([o.spacingKHz, o.usefulUs], [15, 66.7]);
  assert.ok(o.bwMHz > 8 && o.bwMHz < 10.5, `${o.bwMHz} MHz`);
  assert.equal(lookForOfdm(new Float32Array(2 * 65536).map(() => mb()), FS), null);
});
