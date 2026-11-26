// FORK: the Analyzer protocol library: a JSON round trip, untrusted files checked field by field, merging into the
// saved protocols, and an imported protocol recognizing a frame the way a saved one does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_FORMAT, cleanProtocol, libraryJson, mergeProtocols, readLibrary } from '../src/dsp/analyzer/library.js';
import { recognize, type Protocol } from '../src/dsp/analyzer/fields.js';

const remote: Protocol = {
  name: 'Gate remote', sync: '10110010', mod: 'OOK', coding: 'PWM', symUs: 400,
  fields: [{ name: 'sync', kind: 'sync', from: 0, to: 8 }, { name: 'id', kind: 'id', from: 8, to: 28 }, { name: 'button', kind: 'data', from: 28, to: 32 }],
  check: { name: 'CRC-8 (poly 0x07, init 0x00)', spec: { kind: 'crc', width: 8, poly: 7, init: 0, refl: false, xorout: 0 }, from: 0, to: 4, at: 4, little: false },
};
const tpms: Protocol = { name: 'Tyre sensor', sync: '0101011001', mod: 'FSK', coding: 'Manchester', symUs: 52, fields: [{ name: 'id', kind: 'id', from: 0, to: 32 }] };

test('round trip: the file carries the protocols as they were', () => {
  const text = libraryJson([remote, tpms], 'Mad Mobile Analyzer', new Date(Date.UTC(2026, 10, 26)));
  const v = JSON.parse(text);
  assert.deepEqual([v.format, v.version, v.saved], [LIBRARY_FORMAT, 1, '2026-11-26T00:00:00.000Z']);
  assert.deepEqual(readLibrary(text), { protocols: [remote, tpms], skipped: 0 });
  // a bare array, or an upstream session's JSON part, reads too
  assert.equal(readLibrary(JSON.stringify([tpms])).protocols.length, 1);
  assert.equal(readLibrary(JSON.stringify({ version: 1, app: 'Mayhem Analyzer', protocols: [tpms], bursts: [] })).protocols.length, 1);
});

test('untrusted files: malformed protocols are skipped and counted; only checked values are kept', () => {
  const bad: unknown[] = [
    { ...tpms, sync: '012' },                                   // not bits
    { ...tpms, sync: '' },
    { ...tpms, name: '' },
    { ...tpms, symUs: -1 },
    { ...tpms, fields: [{ name: 'x', kind: 'evil', from: 0, to: 4 }] },
    { ...tpms, fields: [{ name: 'x', kind: 'id', from: 8, to: 4 }] },
    { ...tpms, check: { ...remote.check, spec: { ...remote.check!.spec, kind: 'md5' } } },
    { ...tpms, fields: Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, kind: 'data', from: i, to: i + 1 })) },
    'not an object', null, 42,
  ];
  const r = readLibrary(JSON.stringify({ protocols: [...bad, tpms] }));
  assert.deepEqual([r.protocols.length, r.skipped], [1, bad.length]);
  // extra keys (including a __proto__ key) are dropped, not carried into the saved protocol
  const extra = cleanProtocol(JSON.parse(`{"name":"x","sync":"1","mod":"OOK","coding":"PWM","symUs":1,"fields":[],"__proto__":{"polluted":true},"onclick":"alert(1)"}`));
  assert.deepEqual(extra, { name: 'x', sync: '1', mod: 'OOK', coding: 'PWM', symUs: 1, fields: [] });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(readLibrary('not json').error, 'not JSON');
  assert.equal(readLibrary('{"hello":1}').error, 'no protocols in it');
});

test('merge: identical protocols are skipped, a taken name gets a number', () => {
  const saved: Protocol[] = [{ ...remote }];
  const other = { ...remote, sync: '11110000' };                  // same name, different protocol
  assert.deepEqual(mergeProtocols(saved, [remote, other, tpms, other]), { added: 2, same: 2, renamed: 1 });
  assert.deepEqual(saved.map(p => p.name), ['Gate remote', 'Gate remote (2)', 'Tyre sensor']);
});

test('an imported protocol recognizes a frame carrying its sync word', () => {
  const [p] = readLibrary(libraryJson([remote], 'x')).protocols;
  const bits = '1111' + remote.sync + '0110100111010101101011101001';
  const r = recognize([p], bits, 'OOK', 'PWM');
  assert.equal(r?.protocol.name, 'Gate remote');
  assert.equal(recognize([p], bits, 'FSK', 'PWM'), null);           // another modulation is not it
});
