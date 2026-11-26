// FORK: HFDL (dsp/hfdl/): the interleaver is a permutation; bursts at every rate decoded back to their octets through
// noise, a frequency error and an unknown phase and timing; the squitter, a downlink with ACARS, a performance report
// and a logon read; a corrupted burst and noise give nothing; the decoder finds a channel in a 2 MS/s span and feeds
// the ACARS line the Flight Msgs screens read. A burst built here was also decoded by dumphfdl 1.7 itself (see the
// note at the end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HFDL_FS, HFDL_RATES, HfdlRx, hfdlBurstSymbols, hfdlCapacity, hfdlShape, popOrder, type HfdlBurst } from '../src/dsp/hfdl/phy.js';
import { HFDL_FREQS, acarsLine, buildDownlink, buildSquitter, crcHfdl, lpduAcars, lpduLogon, lpduPerformance, parseHfdl } from '../src/dsp/hfdl/pdu.js';
import { HfdlDecoder } from '../src/dsp/hfdl/hfdl.js';
import { parseAcarsLine } from '../src/acars-planes.js';

let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
function noisy(x: Float32Array, snrDb: number): Float32Array { const s = Math.sqrt(Math.pow(10, -snrDb / 10) / 2); return x.map(v => v + s * g()); }
function hear(x: Float32Array): HfdlBurst[] {
  const rx = new HfdlRx(), out: HfdlBurst[] = []; rx.onBurst = b => out.push(b);
  for (let o = 0; o < x.length; o += 8192) rx.push(x.subarray(o, Math.min(x.length, o + 8192)));
  return out;
}

test('interleaver: every rate reads each code bit exactly once', () => {
  for (let r = 0; r < 8; r++) {
    const o = popOrder(r), seen = new Uint8Array(o.length);
    for (const i of o) seen[i]++;
    assert.ok(seen.every(v => v === 1), `rate ${r}`);
  }
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(hfdlCapacity), [68, 135, 270, 405, 158, 945]);
});

test('CRC: the X.25 check value', () => {
  assert.equal(crcHfdl(Array.from('123456789', c => c.charCodeAt(0))), 0x906E);
});

test('every rate round trips through 15 dB of noise, 37 Hz off and an unknown phase', () => {
  for (let r = 0; r < 8; r++) {
    const cap = hfdlCapacity(r), data = Array.from({ length: Math.min(cap - 2, 200) }, (_, i) => (i * 37 + r) & 0xff);
    const x = noisy(hfdlShape(hfdlBurstSymbols(data, r), { cfoHz: 37, phase: 1 + r, lead: 900 + 3 * r }), 15);
    const b = hear(x);
    assert.equal(b.length, 1, `rate ${r}: ${b.length} bursts`);
    assert.equal(b[0].rate, r); assert.equal(b[0].bps, HFDL_RATES[r].bps);
    assert.deepEqual(Array.from(b[0].bytes.subarray(0, data.length)), data, `rate ${r} octets`);
    assert.ok(Math.abs(b[0].cfoHz - 37) < 2, `cfo ${b[0].cfoHz}`);
  }
});

test('300 bps survives 3 dB; 1800 bps does not need more than 18', () => {
  const sq = buildSquitter(7, 0b111);
  assert.ok(parseHfdl(hear(noisy(hfdlShape(hfdlBurstSymbols(sq, 0), { cfoHz: -120, phase: 2 }), 3))[0]?.bytes ?? new Uint8Array()));
  const d = Array.from({ length: 300 }, (_, i) => (i * 11) & 0xff);
  assert.deepEqual(Array.from(hear(noisy(hfdlShape(hfdlBurstSymbols(d, 3), { cfoHz: 210 }), 18))[0].bytes.subarray(0, 300)), d);
});

test('PDUs: squitter, downlink with ACARS and a position report, logon', () => {
  const sq = parseHfdl(Uint8Array.from(buildSquitter(7, 0b1010_0001, 1234, 5)))!;
  assert.equal(sq.kind, 'squitter'); assert.equal(sq.gs, 7);
  assert.deepEqual([sq.squitter!.frameIndex, sq.squitter!.slot], [1234, 5]);
  assert.deepEqual(sq.squitter!.stations[0].freqs, [11384, 5547, 2998]);
  const dn = parseHfdl(Uint8Array.from(buildDownlink(4, 17, [
    lpduAcars({ reg: 'N123AB', label: 'H1', blk: '2', msn: 'D45A', flight: 'UA0901', text: 'POSN40W070', down: true }),
    lpduPerformance('UA901', 40.5, -70.25, 3 * 3600 + 25 * 60 + 10, 4),
    lpduLogon(0xA1B2C3),
  ])))!;
  assert.equal(dn.kind, 'mpdu'); assert.ok(dn.down); assert.deepEqual([dn.gs, dn.acId, dn.lpdus.length], [4, 17, 3]);
  const a = dn.lpdus[0].acars!;
  assert.deepEqual([a.reg, a.label, a.blk, a.msn, a.flight, a.text], ['N123AB', 'H1', '2', 'D45A', 'UA0901', 'POSN40W070']);
  const p = dn.lpdus[1].report!;
  assert.equal(p.flight, 'UA901'); assert.ok(Math.abs(p.lat - 40.5) < 1e-3 && Math.abs(p.lon + 70.25) < 1e-3); assert.equal(p.utc, '03:25:10');
  assert.equal(dn.lpdus[2].icao, 0xA1B2C3);
  // the line the Flight Msgs screens read
  const m = parseAcarsLine(acarsLine(a, 8912), 0)!;
  assert.deepEqual([m.mhz, m.down, m.reg, m.label, m.flight, m.text], ['8.912', true, 'N123AB', 'H1', 'UA0901', 'POSN40W070']);
});

test('nothing from noise, a plain carrier, or a burst with its CRC broken', () => {
  assert.equal(hear(new Float32Array(2 * HFDL_FS * 3).map(() => 0.3 * g())).length, 0);
  const tone = new Float32Array(2 * HFDL_FS * 3); for (let i = 0; i < tone.length / 2; i++) { tone[2 * i] = Math.cos(0.01 * i); tone[2 * i + 1] = Math.sin(0.01 * i); }
  assert.equal(hear(noisy(tone, 20)).length, 0);
  const sq = buildSquitter(3, 1); sq[20] ^= 0x10;
  const b = hear(noisy(hfdlShape(hfdlBurstSymbols(sq, 0)), 20));
  assert.equal(b.length, 1); assert.equal(parseHfdl(b[0].bytes), null);
});

test('decoder: channels in a 2 MS/s span; a downlink at 8.912 MHz comes out as an ACARS line', () => {
  const rate = 2e6, centre = 8_700_000, dial = 8_912_000, msgs: Record<string, unknown>[] = [];
  const d = new HfdlDecoder(m => msgs.push(m)); d.centerHz = centre; d.reset(rate);
  // baseband at 7200 S/s, up to 2 MS/s by linear interpolation, moved to where the carrier sits in the span
  const bb = hfdlShape(hfdlBurstSymbols(buildDownlink(4, 9, [lpduAcars({ reg: 'G-ABCD', label: '5Z', blk: '3', flight: 'BA0117', text: 'HELLO HFDL', down: true })]), 2), { cfoHz: 15, lead: 3000 });
  const n = Math.floor((bb.length / 2 - 2) * rate / HFDL_FS), iq = new Int8Array(2 * n), off = dial + 1440 - centre;
  for (let i = 0; i < n; i++) {
    const t = i * HFDL_FS / rate, k = Math.floor(t), u = t - k;
    const re = bb[2 * k] + (bb[2 * k + 2] - bb[2 * k]) * u, im = bb[2 * k + 1] + (bb[2 * k + 3] - bb[2 * k + 1]) * u;
    const a = 2 * Math.PI * off * i / rate, c = Math.cos(a), s = Math.sin(a);
    iq[2 * i] = Math.round(30 * (re * c - im * s) + 3 * g()); iq[2 * i + 1] = Math.round(30 * (re * s + im * c) + 3 * g());
  }
  for (let o = 0; o < iq.length; o += 262144) d.onIq(iq.subarray(o, o + 262144), rate);
  assert.ok(d.channels().includes(dial) && d.channels().every(h => HFDL_FREQS.includes(h)));
  const pk = msgs.filter(m => m.type === 'packet');
  assert.equal(pk.length, 1, JSON.stringify(msgs.filter(m => m.type === 'log').map(m => m.line)));
  const m = parseAcarsLine(pk[0].line as string, 0)!;
  assert.deepEqual([m.mhz, m.reg, m.label, m.flight, m.text], ['8.912', 'G-ABCD', '5Z', 'BA0117', 'HELLO HFDL']);
  assert.ok(msgs.some(x => x.type === 'hfdl'));
});

test('decoder: one burst heard on two channels (a copy 20 dB down on 8.921) is sent once, from the stronger', () => {
  const rate = 2e6, centre = 8_700_000, msgs: Record<string, unknown>[] = [];
  const d = new HfdlDecoder(m => msgs.push(m)); d.centerHz = centre; d.reset(rate);
  const bb = hfdlShape(hfdlBurstSymbols(buildSquitter(1, 0b100000), 0), { lead: 3000 });
  const n = Math.floor((bb.length / 2 - 2) * rate / HFDL_FS), iq = new Int8Array(2 * n);
  const offs: [number, number][] = [[8_927_000 + 1440 - centre, 90], [8_921_000 + 1440 - centre, 9]];
  for (let i = 0; i < n; i++) {
    const t = i * HFDL_FS / rate, k = Math.floor(t), u = t - k;
    const re = bb[2 * k] + (bb[2 * k + 2] - bb[2 * k]) * u, im = bb[2 * k + 1] + (bb[2 * k + 3] - bb[2 * k + 1]) * u;
    let xr = 0, xi = 0;
    for (const [off, g] of offs) { const a = 2 * Math.PI * off * i / rate, c = Math.cos(a), s = Math.sin(a); xr += g * (re * c - im * s); xi += g * (re * s + im * c); }
    iq[2 * i] = Math.round(xr); iq[2 * i + 1] = Math.round(xi);
  }
  for (let o = 0; o < iq.length; o += 133332) d.onIq(iq.subarray(o, o + 133332), rate);
  const h = msgs.filter(m => m.type === 'hfdl');
  assert.equal(d.heard, 2, 'both channels heard it');
  assert.equal(h.length, 1, JSON.stringify(msgs.filter(m => m.type === 'log').map(m => m.line)));
  assert.equal(h[0].khz, 8927);
});
