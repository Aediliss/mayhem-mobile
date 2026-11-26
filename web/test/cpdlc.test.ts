// FORK: FANS-1/A CPDLC bodies (dsp/cpdlc/): the schema read out of libacars' asn1c tables decodes messages that
// libacars 2.2 itself decoded to the values below (these exact ARINC 622 texts were built here and run through
// la_acars_decode_apps); each element is worded with its values; the encoder and decoder agree on every message; a cut
// message decodes to nothing; Flight Msgs reads a CPDLC uplink as CPDLC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arinc622Summary, parseArinc622 } from '../src/dsp/arinc622.js';
import { decodeCpdlc, encodeCpdlc, cpdlcRead } from '../src/dsp/cpdlc/cpdlc.js';
import { FANS_TEXT, FANS_TYPES } from '../src/dsp/cpdlc/fans.js';
import { msgInsight } from '../src/acars-insight.js';

const read = (label: string, text: string, down: boolean) => { const a = parseArinc622(label, text, down)!; assert.ok(a.crcOk, 'CRC'); return a; };

test('schema: both roots, every element worded', () => {
  const up = FANS_TYPES.find(t => t.n === 'FANSATCUplinkMsgElementId')!, dn = FANS_TYPES.find(t => t.n === 'FANSATCDownlinkMsgElementId')!;
  assert.equal(up.m!.length, 183); assert.equal(dn.m!.length, 129);
  assert.ok([...up.m!, ...dn.m!].every(m => FANS_TEXT[m[0]]));
  assert.equal(FANS_TEXT.uM20Altitude, 'CLIMB TO AND MAINTAIN [altitude]');
});

test('uplink: climb with free text (libacars: Msg ID 5, 12:34:56, FL350, WHEN ABLE)', () => {
  const a = read('AA', '/NYCODYA.AT1.N512UAA2B22E0532805484579116720830A645C03B', false);
  assert.deepEqual(a.cpdlc, { id: 5, ref: null, time: '12:34:56', elements: ['CLIMB TO AND MAINTAIN FL350', 'WHEN ABLE'], text: 'CLIMB TO AND MAINTAIN FL350 · WHEN ABLE' });
  assert.equal(arinc622Summary(a).summary, 'CPDLC message from NYCODYA #5: CLIMB TO AND MAINTAIN FL350 · WHEN ABLE');
});

test('uplink: at a position climb to a QNH altitude (libacars: 49 30.5 north, 050 west, 11000 ft)', () => {
  const a = read('AA', '/NYCODYA.AT1.N512UA030B3B14C432844C7E0D', false);
  assert.deepEqual(a.cpdlc!.elements, ["AT N49°30.5' W50° CLIMB TO AND MAINTAIN 11000 ft"]);
});

test('downlink: altitude request answering #5; position report (libacars: FL380; NATAM 03:07 FL370)', () => {
  const r = read('BA', '/NYCODYA.AT1.N512UA438A0D95E0257A', true);
  assert.deepEqual([r.cpdlc!.id, r.cpdlc!.ref, r.cpdlc!.text], [7, 5, 'REQUEST FL380']);
  const p = read('BA', '/NYCODYA.AT1.N512UA04180000012741A90668C7CAA03AAC', true);
  assert.equal(p.cpdlc!.text, 'POSITION REPORT NATAM 03:07 FL370');
});

test('encoder and decoder agree; a cut message decodes to nothing', () => {
  const msg = { aTCMessageheader: { msgIdentificationNumber: 63, msgReferenceNumber: 0 }, aTCuplinkmsgelementId: { uM30AltitudeAltitude: [{ altitudeFlightLevel: 330 }, { altitudeFlightLevel: 370 }] } };
  const b = encodeCpdlc(msg, false), v = decodeCpdlc(b, false)!;
  assert.deepEqual(cpdlcRead(v).elements, ['MAINTAIN BLOCK FL330 TO FL370']);
  assert.equal(decodeCpdlc(b.subarray(0, 2), false), null);
});

test('Flight Msgs: a CPDLC uplink is kind CPDLC with its clearance as the summary', () => {
  const i = msgInsight({ mhz: '8.912', down: false, reg: 'N512UA', label: 'AA', blk: 'A', ack: 'NAK', msn: '', flight: '', crcOk: true, mode: '2', text: '/NYCODYA.AT1.N512UAA2B22E0532805484579116720830A645C03B', ms: 0 });
  assert.equal(i.kind, 'cpdlc'); assert.match(i.summary, /CLIMB TO AND MAINTAIN FL350/);
});
