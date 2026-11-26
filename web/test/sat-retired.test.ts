// FORK: NOAA 15/18/19 are kept in the satellite list but marked decommissioned (NOAA OSPO dates); the live weather
// satellites are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SATS, retiredText } from '../src/sat.js';

test('NOAA 15, 18 and 19 are retired on the NOAA OSPO dates; Meteor and the amateur birds are not', () => {
  const by = (n: string) => SATS.find(s => s.name === n)!;
  assert.deepEqual(['NOAA 15', 'NOAA 18', 'NOAA 19'].map(n => retiredText(by(n))), ['Decommissioned 19 Aug 2025', 'Decommissioned 6 Jun 2025', 'Decommissioned 13 Aug 2025']);
  assert.deepEqual(SATS.filter(s => s.retired).map(s => s.name), ['NOAA 15', 'NOAA 18', 'NOAA 19']);
  for (const n of ['METEOR M2-3', 'METEOR M2-4', 'ISS']) assert.equal(retiredText(by(n)), '');
  // still tunable: the services stay
  assert.ok(by('NOAA 19').services.some(v => v.down === 137_100_000));
});
