// FORK: the decode export bus: wire formats against published examples, the worker-message adapter, the sinks,
// and decoders' real output going out in each domain format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aisArmor, aisUnarmor, aivdm, ax25ToTnc2, beastFrame, hex, kissFrame, nmeaChecksum, rtl433Json, sbsLine, SbsEncoder, unhex } from '../src/export/formats.js';
import { EventAdapter, type DecodeEvent } from '../src/export/event.js';
import { ExportBus, DEFAULT_CONFIG, type ExportConfig } from '../src/export/bus.js';
import { formatEvent, WebhookSink, WsSink, type WsLike } from '../src/export/sinks.js';
import { AisDecoder } from '../src/dsp/ais.js';
import { AprsDecoder } from '../src/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { afsk, concat, feed, fmModulate, hold, silence, toInt8 } from './lib/iq.js';

const CTX = { app: 'ais', centerHz: 162_000_000, now: new Date('2026-11-26T10:15:00Z') };
const cfg = (over: Partial<ExportConfig>): ExportConfig => ({ ...structuredClone(DEFAULT_CONFIG), enabled: true, ...over });

// ---- NMEA ----

test('NMEA: checksums of published AIVDM sentences', () => {
  // Eric S. Raymond, "AIVDM/AIVDO protocol decoding" (gpsd), worked examples
  assert.equal(nmeaChecksum('AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0'), '5C');
  assert.equal(nmeaChecksum('AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0'), '1C');
  assert.equal(nmeaChecksum('AIVDM,2,2,1,A,88888888880,2'), '25');
});

/** Append the HDLC FCS the AIS / APRS framers check (CRC-16/X.25, low byte first). */
function withFcs(b: Uint8Array): Uint8Array {
  let crc = 0xffff;
  for (const x of b) { crc ^= x; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1; }
  crc = ~crc & 0xffff;
  return Uint8Array.from([...b, crc & 0xff, crc >> 8]);
}

test('NMEA: a published sentence → bytes → the real AIS decoder → !AIVDM again, character for character', () => {
  const sentence = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C';
  const { bytes, bits } = aisUnarmor('177KQJ5000G?tO`K>RA1wUbN0TKH', 0);
  assert.equal(bits, 168);
  const out: Record<string, unknown>[] = [];
  const d = new AisDecoder(m => out.push(m));
  (d as unknown as { onFrame(f: Uint8Array): void }).onFrame(withFcs(bytes));
  const raw = out.find(m => m.type === 'aisRaw')!, line = out.find(m => m.type === 'packet')!;
  assert.ok(raw && line, JSON.stringify(out.map(m => m.type)));
  assert.match(line.line as string, /MMSI 477553000/);           // the decoder reads the same bits the sentence carries
  assert.deepEqual(aivdm(raw.bytes as number[], raw.bits as number, 'B'), [sentence]);
});

test('NMEA: a long message is split under the 82-character limit and reassembles to the same bits', () => {
  const p1 = '55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8', p2 = '88888888880';
  const { bytes, bits } = aisUnarmor(p1 + p2, 2);
  assert.equal(bits, 424);                                          // type 5
  const s = aivdm(bytes, bits, 'A');
  assert.equal(s.length, 2);
  for (const x of s) { assert.ok(x.length <= 82, x); const [body, cs] = x.slice(1).split('*'); assert.equal(nmeaChecksum(body), cs); }
  const f = s.map(x => x.split(','));
  assert.equal(f[0][3], f[1][3]); assert.notEqual(f[0][3], '');      // a shared sequence id
  assert.equal(f[0][6].split('*')[0], '0'); assert.equal(f[1][6].split('*')[0], '2');
  assert.equal(f[0][5] + f[1][5], p1 + p2);
  assert.deepEqual(aisArmor(bytes, bits), { payload: p1 + p2, fill: 2 });
});

// ---- Beast, SBS ----

test('Beast: a DF17 frame, and 0x1a escaping', () => {
  const f = unhex('8d4840d6202cc371c32ce0576098');                  // the dump1090 / "1090 MHz riddle" example, KLM1023
  assert.equal(hex(beastFrame(f)), '1a33' + '000000000000' + '00' + '8d4840d6202cc371c32ce0576098');
  const withEsc = beastFrame(unhex('8d1a40d6202cc371c32ce0576098'), 0x1a);
  assert.equal(hex(withEsc), '1a33000000000000' + '1a1a' + '8d1a1a40d6202cc371c32ce0576098');
  assert.equal(hex(beastFrame(unhex('5d4840d6123456'))).slice(0, 4), '1a32');
  assert.throws(() => beastFrame(new Uint8Array(10)), /7 or 14/);
});

test('SBS: 22 fields, and only the messages for what changed', () => {
  const when = new Date(2026, 10, 26, 10, 15, 0, 250);
  const l = sbsLine(3, { icao: '4840d6', alt: 38000, lat: 52.25720, lon: 3.91937 }, when);
  assert.equal(l, 'MSG,3,1,1,4840D6,1,2026/11/26,10:15:00.250,2026/11/26,10:15:00.250,,38000,,,52.25720,3.91937,,,0,0,0,0');
  assert.equal(l.split(',').length, 22);
  const e = new SbsEncoder();
  assert.deepEqual(e.update({ icao: 'abc123', flight: 'KLM1023 ' }, when).map(x => x.split(',')[1]), ['1']);
  assert.deepEqual(e.update({ icao: 'abc123', flight: 'KLM1023 ', lat: 1, lon: 2, alt: 100, gs: 300, track: 90 }, when).map(x => x.split(',')[1]), ['3', '4']);
  assert.deepEqual(e.update({ icao: 'abc123', flight: 'KLM1023 ', lat: 1, lon: 2, alt: 100, gs: 300, track: 90 }, when), []);
  assert.equal(e.update({ icao: 'abc123', flight: 'KLM1023 ' }, when)[0], undefined);
});

// ---- AX.25: TNC2, KISS ----

test('TNC2 and KISS from AX.25 frames, digipeater path and escapes', () => {
  const f = ax25Aprs('N0CALL-9', '!4903.50N/07201.75W-hi');
  const noFcs = f.slice(0, f.length - 2);
  assert.equal(ax25ToTnc2(noFcs), 'N0CALL-9>APZMHM:!4903.50N/07201.75W-hi');
  // add WIDE1-1* (repeated) between source and control
  const addr = (c: string, ssid: number, last: boolean, h = false) => [...c.padEnd(6).split('').map(ch => ch.charCodeAt(0) << 1), (h ? 0x80 : 0) | 0x60 | (ssid << 1) | (last ? 1 : 0)];
  const digi = [...addr('APZMHM', 0, false), ...addr('N0CALL', 9, false), ...addr('WIDE1', 1, true, true), 0x03, 0xf0, ...Array.from('>x', c => c.charCodeAt(0))];
  assert.equal(ax25ToTnc2(digi), 'N0CALL-9>APZMHM,WIDE1-1*:>x');
  assert.equal(ax25ToTnc2([1, 2, 3]), null);
  assert.equal(hex(kissFrame([0x01, 0xc0, 0x02, 0xdb, 0x03])), 'c000' + '01dbdc02dbdd03' + 'c0');
});

test('rtl_433 JSON: time first, local time, then the decoder\'s fields', () => {
  const s = rtl433Json({ model: 'Acurite-Tower', id: 1234, channel: 'A', temperature_c: 21.5, humidity: 45, battery_ok: 1 }, new Date(2026, 10, 26, 10, 15, 0));
  assert.equal(s, '{"time":"2026-11-26 10:15:00","model":"Acurite-Tower","id":1234,"channel":"A","temperature_c":21.5,"humidity":45,"battery_ok":1}');
});

// ---- adapter, bus, sinks ----

test('adapter: worker messages become events; tables report only rows that changed', () => {
  const a = new EventAdapter();
  assert.deepEqual(a.map({ type: 'packet', line: 'T1 MMSI 1' }, CTX), [{ t: '2026-11-26T10:15:00.000Z', app: 'ais', centerHz: 162e6, kind: 'line', text: 'T1 MMSI 1' }]);
  assert.equal(a.map({ type: 'modes', hex: 'ab' }, CTX)[0].kind, 'adsb.frame');
  assert.deepEqual(a.map({ type: 'aisRaw', bytes: [1, 255], bits: 12 }, CTX).map(e => [e.kind, e.hex, e.bits]), [['ais.frame', '01ff', 12]]);
  assert.equal(a.map({ type: 'r433', data: { model: 'X', id: 1 } }, CTX)[0].kind, 'device');
  assert.deepEqual(a.map({ type: 'log', line: 'not a decode' }, CTX), []);
  const rows = [{ mmsi: 1, lastMs: 10 }, { mmsi: 2, lastMs: 10 }];
  assert.equal(a.map({ type: 'table', rows }, CTX).length, 2);
  assert.equal(a.map({ type: 'table', rows }, CTX).length, 0);
  assert.deepEqual(a.map({ type: 'table', rows: [{ mmsi: 1, lastMs: 10 }, { mmsi: 2, lastMs: 11 }] }, CTX).map(e => e.data!.mmsi), [2]);
});

test('bus: off by default and when off; on, the log holds JSON lines', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  const off = new ExportBus(structuredClone(DEFAULT_CONFIG));
  off.fromWorker({ type: 'packet', line: 'x' }, CTX);
  assert.equal(off.count, 0); assert.equal(off.log.text(), '');
  const on = new ExportBus(cfg({}));
  on.fromWorker({ type: 'packet', line: 'x' }, CTX); on.fromWorker({ type: 'packet', line: 'y' }, CTX);
  assert.deepEqual(on.log.text().trim().split('\n').map(l => JSON.parse(l).text), ['x', 'y']);
});

test('webhook: batches as JSON, keeps and retries a failed batch', async () => {
  const calls: { url: string; body: string }[] = []; let fail = true;
  const sink = new WebhookSink('https://hook.example/x', async (url, init) => { calls.push({ url, body: init.body }); if (fail) { fail = false; return { ok: false, status: 503 }; } return { ok: true, status: 200 }; }, 5);
  const ev = (n: number): DecodeEvent => ({ t: 't', app: 'a', kind: 'line', text: String(n) });
  sink.handle(ev(1)); sink.handle(ev(2));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.length, 1); assert.match(sink.status(), /HTTP 503/);
  await new Promise(r => setTimeout(r, 2100));                       // backoff, then the retry
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].body).events.map((e: DecodeEvent) => e.text), ['1', '2']);
  assert.equal(JSON.parse(calls[1].body).source, 'Mad Mobile');
  assert.equal(sink.sent, 2); sink.close();
});

class FakeWs implements WsLike {
  static last: FakeWs; readyState = 0; binaryType = ''; sent: (string | Uint8Array)[] = [];
  onopen: ((e: unknown) => void) | null = null; onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.last = this; }
  send(d: string | Uint8Array): void { this.sent.push(d); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
}

test('WebSocket: holds output until connected, then streams only what the format covers', () => {
  const s = new WsSink('ws://localhost:30005', 'beast', FakeWs);
  s.handle({ t: 't', app: 'adsb', kind: 'adsb.frame', hex: '8d4840d6202cc371c32ce0576098' });
  s.handle({ t: 't', app: 'adsb', kind: 'line', text: 'ignored by beast' });
  assert.equal(FakeWs.last.sent.length, 0);
  FakeWs.last.open();
  assert.equal(FakeWs.last.sent.length, 1);
  assert.equal(hex(FakeWs.last.sent[0] as Uint8Array).slice(0, 4), '1a33');
  assert.equal(formatEvent('nmea', { t: 't', app: 'x', kind: 'device', data: {} }).length, 0);
  s.close();
});

test('end to end: an APRS packet decoded from IQ leaves as TNC2 text and as a KISS frame', () => {
  const RATE = 960_000, INFO = '!4903.50N/07201.75W-export';
  const audio = afsk(ax25Bits(ax25Aprs('N0CALL-9', INFO)), 1200, 48_000, 1200, 2200);
  const iq = toInt8(concat(silence(RATE / 10), fmModulate(hold(audio, RATE / 48_000), RATE, 3000), silence(RATE / 10)), 60);
  const tnc2 = new WsSink('ws://x', 'tnc2', FakeWs), tWs = FakeWs.last; tWs.open();
  const kiss = new WsSink('ws://x', 'kiss', FakeWs), kWs = FakeWs.last; kWs.open();
  const bus = new ExportBus(cfg({}));
  (bus as unknown as { sinks: unknown[] }).sinks.push(tnc2, kiss);
  const d = new AprsDecoder(m => bus.fromWorker(m, { app: 'aprs', centerHz: 144.39e6 }));
  d.reset(); feed(d, iq, RATE);
  assert.deepEqual(tWs.sent, [`N0CALL-9>APZMHM:${INFO}\r\n`]);
  assert.equal(kWs.sent.length, 1);
  const k = kWs.sent[0] as Uint8Array;
  assert.equal(k[0], 0xc0); assert.equal(k[k.length - 1], 0xc0);
  assert.equal(ax25ToTnc2(k.subarray(2, k.length - 1)), `N0CALL-9>APZMHM:${INFO}`);   // no FEND/FESC inside this frame
  assert.ok(bus.log.text().includes('"kind":"aprs.frame"') && bus.log.text().includes('"kind":"aprs.station"'));
  tnc2.close(); kiss.close();
});
