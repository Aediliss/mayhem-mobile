// FORK: D-STAR / Fusion positions from HAM+ snapshots onto Ham Map (dv-spots.ts, ham-spots.ts's DV mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dvSpots } from '../src/dv-spots.js';
import { hamSpots, spotLayer, visibleSpots } from '../src/ham-spots.js';
import { blankIdent } from '../src/dsp/hamid/ident.js';

const talker = (mode: string, call: string, lat: number, lon: number, source = 'd-prs') => ({ ident: { ...blankIdent(mode), callsign: call, position: { lat, lon, source } } });

test('D-STAR and Fusion talkers with positions become DV spots at their exact position, on the APRS layer', () => {
  hamSpots.clear();
  const snap = { tiles: [{ hz: 145_670_000, talkers: [talker('D-STAR', 'K1ABC', 42.3601, -71.0589), talker('YSF', 'W2XYZ', 40.7128, -74.006, 'nmea'), talker('DMR', 'N0DMR', 1, 1), { ident: blankIdent('D-STAR') }] }] };
  assert.equal(dvSpots(snap, 1_000), 2);
  const s = hamSpots.get('dv:K1ABC')!;
  assert.deepEqual([s.mode, s.lat, s.lon, s.grid, s.text], ['DV', 42.3601, -71.0589, 'FN42li', 'D-STAR D-PRS']);
  assert.equal(hamSpots.get('dv:W2XYZ')!.text, 'Fusion GPS');
  assert.equal(spotLayer('DV'), 'aprs');
  assert.equal(visibleSpots(hamSpots.list(1_000), { aprs: false, ft8: true, js8: true }).length, 0);
  // the same position again within a minute does not count; a move does
  assert.equal(dvSpots(snap, 2_000), 0);
  assert.equal(hamSpots.get('dv:K1ABC')!.heard, 1);
  snap.tiles[0].talkers[0] = talker('D-STAR', 'K1ABC', 42.37, -71.05);
  assert.equal(dvSpots(snap, 3_000), 1);
  assert.deepEqual([hamSpots.get('dv:K1ABC')!.lat, hamSpots.get('dv:K1ABC')!.heard], [42.37, 2]);
  assert.match(hamSpots.logLines(3_000)[0].line, /^DV K1ABC FN42\w\w · 2 m · D-STAR D-PRS$/);
  hamSpots.clear();
});
