// FORK: alias import: RadioReference talkgroup CSV, OP25 tag files and SDRTrunk playlist XML parsed (made-up names in each
// format's layout), and the book's lookups by protocol scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AliasBook, parseAliasText, parseId, protoOfSys } from '../src/aliases.js';

const RR = `Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category
1001,3e9,FD Dispatch,D,Fire Dispatch Main,Fire Dispatch,County Fire
1002,3ea,"PD Ops, North",DE,"Police Operations, North",Law Tac,County Police
1003,3eb,,D,EMS Talk 3,EMS-Talk,County EMS
abc,zz,Broken,D,not a number,,
`;

test('RadioReference CSV: by header, quoted commas, description when no alpha tag, encrypted mode noted', () => {
  const r = parseAliasText(RR);
  assert.equal(r.format, 'RadioReference CSV'); assert.equal(r.errors, 1);
  assert.deepEqual(r.entries.map(e => [e.kind, e.id, e.name]), [['tg', 1001, 'FD Dispatch'], ['tg', 1002, 'PD Ops, North'], ['tg', 1003, 'EMS Talk 3']]);
  assert.equal(r.entries[1].note, 'Police Operations, North · Law Tac · County Police · encrypted');
  // column order does not matter
  const swapped = parseAliasText('Alpha Tag,Decimal\nTac 2,2002\n');
  assert.deepEqual(swapped.entries.map(e => [e.id, e.name]), [[2002, 'Tac 2']]);
});

test('OP25 tag files: talkgroups or radio IDs as the import says; priority column ignored; comments skipped', () => {
  const r = parseAliasText('# talkgroups\n1001\tFD Dispatch\t2\n1002\tPD Ops\n\nbad line\n', 'tg');
  assert.equal(r.format, 'OP25 tags'); assert.equal(r.errors, 1);
  assert.deepEqual(r.entries.map(e => [e.kind, e.id, e.name]), [['tg', 1001, 'FD Dispatch'], ['tg', 1002, 'PD Ops']]);
  assert.deepEqual(parseAliasText('1234567\tEngine 7\n', 'unit').entries.map(e => [e.kind, e.id]), [['unit', 1234567]]);
});

test('SDRTrunk XML: talkgroups, radios, ranges, protocols mapped, LTR ids converted, entities decoded', () => {
  const xml = `<?xml version="1.0"?><playlist><alias color="0" list="County" name="Fire &amp; Rescue">
      <id type="talkgroup" value="1001" protocol="APCO25"/><id type="priority" priority="1"/></alias>
    <alias name="Unit 12" list="County"><id type="radio" value="4512" protocol="DMR"/></alias>
    <alias name="Interop"><id type="talkgroupRange" min="2000" max="2002" protocol="APCO25"/></alias>
    <alias name="Shop"><id type="talkgroup" value="${(0 << 13) | (3 << 8) | 45}" protocol="LTR"/></alias>
    <alias name="Empty"/></playlist>`;
  const r = parseAliasText(xml);
  assert.equal(r.format, 'SDRTrunk XML');
  assert.deepEqual(r.entries.map(e => [e.kind, e.id, e.name, e.proto]), [
    ['tg', 1001, 'Fire & Rescue', 'P25'], ['unit', 4512, 'Unit 12', 'DMR'],
    ['tg', 2000, 'Interop', 'P25'], ['tg', 2001, 'Interop', 'P25'], ['tg', 2002, 'Interop', 'P25'],
    ['tg', 3045, 'Shop', 'LTR'],                               // area 0, home 3, group 45 as Dispatch lists LTR groups
  ]);
});

test('ids: decimal, hex, LTR A-HH-GGG', () => {
  assert.deepEqual(['1001', '0x3E9', '1-03-045', '0-3-45', 'x'].map(parseId), [1001, 1001, 103045, 3045, null]);
});

test('the book: a list scoped to a protocol wins over an ALL list; other protocols fall back to ALL', () => {
  const book = new AliasBook([
    { name: 'all.tsv', format: 'OP25 tags', proto: 'ALL', entries: [{ kind: 'tg', id: 1001, name: 'Generic 1001' }, { kind: 'unit', id: 7, name: 'Seven' }] },
    { name: 'p25.csv', format: 'RadioReference CSV', proto: 'P25', entries: [{ kind: 'tg', id: 1001, name: 'FD Dispatch' }] },
  ]);
  assert.equal(protoOfSys('P25 WACN BEE00 SYS 3A1'), 'P25');
  assert.equal(book.name('P25 BEE00-3A1', 'tg', 1001), 'FD Dispatch');
  assert.equal(book.name('DMR CC1 FID 06', 'tg', 1001), 'Generic 1001');
  assert.equal(book.name('DMR CC1 FID 06', 'unit', 7), 'Seven');
  assert.equal(book.name('DMR CC1 FID 06', 'tg', 7), '');      // a unit name is not a talkgroup name
  assert.equal(book.size, 3);
});
