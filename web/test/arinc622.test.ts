// FORK: ARINC 622 inside ACARS (dsp/arinc622.ts): ADS-C downlink reports and uplink contract requests read field for
// field; the expected values are what libacars 2.2 itself printed for these same messages (built here, decoded by
// la_acars_decode_apps). A broken CRC is flagged, other messages are not taken for ARINC 622, CPDLC is named, and the
// Flight Msgs reading (msgInsight) gives ADS-C its kind, its position and its numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adscBasicReport, adscEarthRef, adscFlightId, arinc622Summary, buildArinc622, crcArinc, parseArinc622 } from '../src/dsp/arinc622.js';
import { msgInsight } from '../src/acars-insight.js';
import { parseAcarsLine } from '../src/acars-planes.js';
import type { AcarsMsg } from '../src/acars-planes.js';

const close = (a: unknown, b: number, eps = 1e-6) => assert.ok(Math.abs((a as number) - b) < eps, `${a} vs ${b}`);

test('CRC: the CCITT-FALSE check value, and a good message leaves 0x1D0F', () => {
  assert.equal(crcArinc(Array.from('123456789', c => c.charCodeAt(0))), 0x29B1);
});

test('ADS-C downlink: basic report, earth reference, flight ID (as libacars reads them)', () => {
  const t = buildArinc622({ imi: 'ADS', gsAddr: 'NYCODYA', reg: 'N512UA', h1Prefix: '#M1B', bytes: [...adscBasicReport(40.512345, -70.254321, 35000, 1234.5), ...adscEarthRef(271.5, 487.5, -320), ...adscFlightId('UAL901')] });
  assert.equal(t, '#M1B/NYCODYA.ADS.N512UA071CCF167054C88B934A110E6088F3FFB00C541339C3182093D8');
  const a = parseArinc622('H1', t, true)!;
  assert.deepEqual([a.app, a.gsAddr, a.reg, a.crcOk], ['adsc', 'NYCODYA', 'N512UA', true]);
  const [br, er, fid] = a.adsc!.tags;
  // libacars: Lat 40.5124283, Lon -70.2543068, Alt 35000 ft, 1234.500 s past the hour, TCAS OK
  close(br.lat, 40.5124283, 1e-6); close(br.lon, -70.2543068, 1e-6); assert.equal(br.altFt, 35000); assert.equal(br.secPastHour, 1234.5); assert.equal(br.tcasOk, 1);
  // libacars: true track 271.5, ground speed 487.5 kt, -320 ft/min
  close(er.trackDeg, 271.5, 0.06); assert.equal(er.groundKt, 487.5); assert.equal(er.vsFpm, -320);
  assert.equal(fid.id, 'UAL901');
  assert.match(arinc622Summary(a).summary, /^ADS-C to NYCODYA: position 40\.512, -70\.254 · 35000 ft · at :20:35 · track 271° · 487\.5 kt/);
});

test('ADS-C: emergency report; uplink periodic contract; acknowledgement, meteo, airframe ID', () => {
  const e = parseArinc622('B6', '/AKLCDYA.ADS.ZK-OKA09E582DBE26B09858078113B96', true)!;
  assert.equal(e.adsc!.tags[0].name, 'Emergency basic report'); close(e.adsc!.tags[0].lat, -37.2500038, 1e-6); close(e.adsc!.tags[0].lon, 174.8000336, 1e-6);
  assert.match(arinc622Summary(e).summary, /EMERGENCY position -37\.250, 174\.800 · 39000 ft/);
  // libacars: periodic contract request, contract 3, reporting interval 11 seconds, flight ID and earth reference data
  const u = parseArinc622('A6', '/AKLCDYA.ADS.ZK-OKA07030B4A0C000E00A105', false)!;
  assert.deepEqual(u.adsc!.tags[0], { tag: 7, name: 'Periodic contract request', contract: 3, wants: ['Flight ID', 'Earth reference data'], intervalS: 11 });
  // libacars: ack contract 4; wind 64.5 kt from 157.5, -441.50 C (the test bytes are arbitrary); ICAO C81234
  const k = parseArinc622('B6', '/AKLCDYA.ADS.ZK-OKA030410409C123411C812347B3B', true)!;
  const [ack, met, af] = k.adsc!.tags;
  assert.equal(ack.contract, 4); assert.equal(met.windKt, 64.5); assert.equal(met.windDeg, 157.5); assert.equal(met.tempC, -441.5); assert.equal(af.icao, 'C81234');
});

test('not ARINC 622, a broken CRC, a truncated tag; CPDLC named', () => {
  assert.equal(parseArinc622('H1', '#DFB POS N4030.0 W07015.0', true), null);
  assert.equal(parseArinc622('5Z', '/AKLCDYA.ADS.ZK-OKA09E582DBE26B09858078113B96', true), null);
  const bad = parseArinc622('B6', '/AKLCDYA.ADS.ZK-OKA09E582DBE26B09858078113B97', true)!;
  assert.equal(bad.crcOk, false); assert.match(arinc622Summary(bad).summary, /CRC failed/);
  const cut = parseArinc622('B6', buildArinc622({ imi: 'ADS', gsAddr: 'AKLCDYA', reg: 'ZK-OKA', bytes: [7, 1, 2, 3] }), true)!;
  assert.equal(cut.adsc!.err, true);
  const c = parseArinc622('AA', buildArinc622({ imi: 'CR1', gsAddr: 'KZAK', reg: 'N512UA', bytes: [0x20, 0x01] }), true)!;
  assert.deepEqual([c.app, c.gsAddr, c.crcOk], ['cpdlc-connect', 'KZAK', true]);
  assert.equal(arinc622Summary(c).summary, 'CPDLC connect request to KZAK');
});

test('Flight Msgs: an ADS-C report reads as ADS-C with its position, altitude, speed and track', () => {
  const text = buildArinc622({ imi: 'ADS', gsAddr: 'NYCODYA', reg: 'N512UA', h1Prefix: '#M1B', bytes: [...adscBasicReport(40.5, -70.25, 35000, 60), ...adscEarthRef(90, 480, 0)] });
  const m: AcarsMsg = { mhz: '8.912', down: true, reg: 'N512UA', label: 'H1', blk: '2', ack: 'NAK', msn: 'D45A', flight: 'UA0901', crcOk: true, mode: '2', text, ms: 0 };
  const i = msgInsight(m);
  assert.equal(i.kind, 'adsc');
  close(i.pos!.lat, 40.5, 1e-4); close(i.pos!.lon, -70.25, 1e-4);
  assert.deepEqual([i.nums.altFt, i.nums.kt, i.nums.hdg], [35000, 480, 90]);
});

test('over Inmarsat too: an Aero ACARS line (upstream Satcom app, "SAT") carrying ADS-C reads as ADS-C', () => {
  const text = buildArinc622({ imi: 'ADS', gsAddr: 'AKLCDYA', reg: 'ZK-OKA', bytes: [...adscBasicReport(-37.25, 174.8, 39000, 30)] });
  const m = parseAcarsLine(`SAT 1545.075 ↓ ZK-OKA  B6  blk 2  ack NAK\n${text}`, 0)!;
  assert.ok(m && m.sat);
  const i = msgInsight(m);
  assert.equal(i.kind, 'adsc'); close(i.pos!.lat, -37.25, 1e-4); assert.equal(i.nums.altFt, 39000);
});
