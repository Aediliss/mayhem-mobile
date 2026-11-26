// FORK: MQTT 3.1.1 packets against the spec, the sink against a fake broker, and Home Assistant discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectPacket, deviceUid, haDiscovery, MqttSink, publishPacket, remainingLength } from '../src/export/mqtt.js';
import { ExportBus, DEFAULT_CONFIG } from '../src/export/bus.js';
import { hex } from '../src/export/formats.js';
import type { WsLike } from '../src/export/sinks.js';

test('remaining length: the boundaries in MQTT 3.1.1 §2.2.3', () => {
  assert.deepEqual(remainingLength(0), [0x00]); assert.deepEqual(remainingLength(127), [0x7f]);
  assert.deepEqual(remainingLength(128), [0x80, 0x01]); assert.deepEqual(remainingLength(16_383), [0xff, 0x7f]);
  assert.deepEqual(remainingLength(16_384), [0x80, 0x80, 0x01]); assert.deepEqual(remainingLength(2_097_151), [0xff, 0xff, 0x7f]);
  assert.deepEqual(remainingLength(2_097_152), [0x80, 0x80, 0x80, 0x01]); assert.deepEqual(remainingLength(268_435_455), [0xff, 0xff, 0xff, 0x7f]);
});

test('CONNECT and PUBLISH bytes (§3.1, §3.3)', () => {
  // "MQTT", level 4, clean session, keep-alive 60, client id "test"
  assert.equal(hex(connectPacket('test', 60)), '1010' + '00044d515454' + '04' + '02' + '003c' + '000474657374');
  // with user name and password: flags 0xC2, then the two strings after the client id
  assert.equal(hex(connectPacket('c', 30, 'u', 'p')), '1013' + '00044d515454' + '04' + 'c2' + '001e' + '000163' + '000175' + '000170');
  assert.equal(hex(publishPacket('a/b', 'hi', true)), '31' + '07' + '0003612f62' + '6869');
  assert.equal(hex(publishPacket('t', new Uint8Array(200))).slice(0, 6), '30cb01');   // 3 + 200 = 203 = 0xcb → cb 01
});

class Broker implements WsLike {
  static last: Broker; readyState = 0; binaryType = ''; got: Uint8Array[] = []; protocols: unknown;
  onopen: ((e: unknown) => void) | null = null; onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  constructor(readonly url: string, protocols?: unknown) { Broker.last = this; this.protocols = protocols; }
  send(d: Uint8Array): void { this.got.push(d); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  reply(...bytes: number[]): void { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }); }
  /** PUBLISH packets as [topic, payload, retain]. */
  publishes(): [string, string, boolean][] {
    return this.got.filter(p => p[0] >> 4 === 3).map(p => {
      let i = 1; while (p[i] & 0x80) i++; i++;
      const tl = (p[i] << 8) | p[i + 1], topic = new TextDecoder().decode(p.subarray(i + 2, i + 2 + tl));
      return [topic, new TextDecoder().decode(p.subarray(i + 2 + tl)), (p[0] & 1) === 1];
    });
  }
}

const F007 = { model: 'Ambientweather-F007TH', id: 51, channel: 3, battery_ok: 1, temperature_F: 70.2, humidity: 44, mic: 'CRC' };
const OPTS = { url: 'ws://localhost:9001', topic: 'madmobile', user: '', pass: '', ha: true, clientId: 'mm-test', keepAlive: 60 };

test('sink: asks for the "mqtt" subprotocol, waits for CONNACK (even split in two), then publishes', () => {
  const s = new MqttSink(OPTS, Broker as never), b = Broker.last;
  assert.deepEqual(b.protocols, ['mqtt']);
  s.handle({ t: '2026-11-26T10:00:00Z', app: 'aprs', kind: 'line', text: 'x' });
  b.open();
  assert.equal(b.got.length, 1); assert.equal(b.got[0][0], 0x10);   // only CONNECT so far
  b.reply(0x20); b.reply(0x02, 0x00, 0x00);                         // CONNACK, accepted, in two WebSocket messages
  assert.deepEqual(b.publishes(), [['madmobile/events/line/aprs', '{"t":"2026-11-26T10:00:00Z","app":"aprs","kind":"line","text":"x"}', false]]);
  assert.match(s.status(), /^connected · 1 published/);
  s.close();
  assert.equal(hex(b.got[b.got.length - 1]), 'e000');               // DISCONNECT
});

test('sink: a refused CONNACK is reported and not retried', () => {
  const s = new MqttSink({ ...OPTS, user: 'me', pass: 'wrong' }, Broker as never), b = Broker.last;
  b.open(); b.reply(0x20, 0x02, 0x00, 0x05);
  assert.match(s.status(), /not authorised/);
  s.close();
});

test('Home Assistant: one retained config per understood field, the state on its own topic, announced once', () => {
  const s = new MqttSink(OPTS, Broker as never), b = Broker.last; b.open(); b.reply(0x20, 0x02, 0x00, 0x00);
  const ev = { t: '2026-11-26T10:00:00Z', app: 'devices', kind: 'device', data: F007 };
  s.handle(ev); s.handle(ev);
  const pubs = b.publishes(), cfgs = pubs.filter(([t]) => t.startsWith('homeassistant/'));
  assert.equal(deviceUid(F007), 'ambientweather_f007th_3_51');
  assert.deepEqual(cfgs.map(([t, , r]) => [t, r]), [
    ['homeassistant/binary_sensor/madmobile_ambientweather_f007th_3_51_battery_ok/config', true],
    ['homeassistant/sensor/madmobile_ambientweather_f007th_3_51_temperature_f/config', true],
    ['homeassistant/sensor/madmobile_ambientweather_f007th_3_51_humidity/config', true],
  ]);
  const temp = JSON.parse(cfgs[1][1]);
  assert.equal(temp.state_topic, 'madmobile/devices/ambientweather_f007th_3_51');
  assert.equal(temp.value_template, "{{ value_json['temperature_F'] }}");
  assert.equal(temp.device_class, 'temperature'); assert.equal(temp.unit_of_measurement, '°F');
  assert.deepEqual(temp.device.identifiers, ['madmobile_ambientweather_f007th_3_51']);
  const batt = JSON.parse(cfgs[0][1]);
  assert.equal(batt.device_class, 'battery'); assert.equal(batt.payload_on, '0');   // HA "on" = low battery
  const states = pubs.filter(([t]) => t === 'madmobile/devices/ambientweather_f007th_3_51');
  assert.equal(states.length, 2); assert.equal(JSON.parse(states[0][1]).temperature_F, 70.2);
  assert.equal(haDiscovery({ model: 'Remote', id: 1, button: 2 }, 'x').length, 0);   // nothing HA would understand
  s.close();
});

test('bus: MQTT is built from Settings and gets every event', () => {
  let made = 0;
  const bus = new ExportBus({ ...structuredClone(DEFAULT_CONFIG), enabled: true, mqtt: { ...DEFAULT_CONFIG.mqtt, on: true } }, { mqtt: c => { made++; return new MqttSink({ ...c, clientId: 'x' }, Broker as never); } });
  assert.equal(made, 1);
  Broker.last.open(); Broker.last.reply(0x20, 0x02, 0x00, 0x00);
  bus.fromWorker({ type: 'r433', data: F007 }, { app: 'devices', centerHz: 433.92e6 });
  assert.ok(Broker.last.publishes().some(([t]) => t === 'madmobile/events/device'));
  assert.ok(Broker.last.publishes().some(([t]) => t === 'madmobile/devices/ambientweather_f007th_3_51'));
  bus.configure({ ...bus.cfg, enabled: false });
});

test('topics: events under events/, never colliding with device states', async () => {
  const { eventTopic } = await import('../src/export/mqtt.js');
  const ev = (kind: string, app = 'aprs') => ({ t: '', app, kind });
  assert.equal(eventTopic('madmobile', ev('aprs.frame')), 'madmobile/events/aprs/frame');
  assert.equal(eventTopic('madmobile', ev('adsb.aircraft', 'adsb')), 'madmobile/events/adsb/aircraft');
  assert.equal(eventTopic('madmobile', ev('line', 'Ham Map!')), 'madmobile/events/line/ham_map');
  assert.equal(eventTopic('home/sdr', ev('device', 'devices')), 'home/sdr/events/device');
});

test('Home Assistant: fields first seen in a later report are announced too (Acurite 5-in-1 alternates)', () => {
  const s = new MqttSink(OPTS, Broker as never), b = Broker.last; b.open(); b.reply(0x20, 0x02, 0x00, 0x00);
  const dev = { model: 'Acurite-5n1', id: 7, channel: 'A' };
  s.handle({ t: 't', app: 'devices', kind: 'device', data: { ...dev, wind_avg_km_h: 12, rain_in: 0.2 } });
  s.handle({ t: 't', app: 'devices', kind: 'device', data: { ...dev, temperature_F: 50, humidity: 80 } });
  s.handle({ t: 't', app: 'devices', kind: 'device', data: { ...dev, wind_avg_km_h: 14, rain_in: 0.2 } });
  const cfg = b.publishes().filter(([t]) => t.startsWith('homeassistant/')).map(([t]) => t.split('/')[2].replace('madmobile_acurite_5n1_a_7_', ''));
  assert.deepEqual(cfg, ['wind_avg_km_h', 'rain_in', 'temperature_f', 'humidity']);   // each once, including the later ones
  s.close();
});
