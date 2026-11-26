/**
 * FORK: MQTT 3.1.1 over WebSockets (OASIS MQTT v3.1.1, §3 control packets; WebSocket subprotocol "mqtt", §6), just
 * what an exporter needs: CONNECT (optional user/password), PUBLISH at QoS 0 (retain for discovery), PINGREQ,
 * DISCONNECT. Written from the spec so no client library is added.
 *
 * Topics:  <prefix>/events/<kind as path>     every event as JSON (aprs.frame → events/aprs/frame; log lines →
 *                                              events/line/<app>, so each app's lines can be followed alone)
 *          <prefix>/devices/<uid>              each rtl_433-style device's latest fields (the Home Assistant state topic)
 *          homeassistant/<component>/madmobile_<uid>_<field>/config   (retained, with discovery on)
 */
import type { DecodeEvent } from './event.js';
import type { Sink, WsCtor, WsLike } from './sinks.js';

const enc = new TextEncoder();

/** MQTT's variable-length "remaining length" (§2.2.3). */
export function remainingLength(n: number): number[] {
  const out: number[] = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
const str = (s: string) => { const b = enc.encode(s); return [b.length >> 8, b.length & 0xff, ...b]; };

export function connectPacket(clientId: string, keepAlive: number, user?: string, pass?: string): Uint8Array {
  const flags = 0x02 | (user ? 0x80 : 0) | (user && pass ? 0x40 : 0);           // clean session (+ user, + password)
  const body = [...str('MQTT'), 4, flags, keepAlive >> 8, keepAlive & 0xff, ...str(clientId), ...(user ? str(user) : []), ...(user && pass ? str(pass) : [])];
  return Uint8Array.from([0x10, ...remainingLength(body.length), ...body]);
}
export function publishPacket(topic: string, payload: string | Uint8Array, retain = false): Uint8Array {
  const p = typeof payload === 'string' ? enc.encode(payload) : payload, t = str(topic);
  const head = [0x30 | (retain ? 1 : 0), ...remainingLength(t.length + p.length), ...t];
  const out = new Uint8Array(head.length + p.length); out.set(head); out.set(p, head.length);
  return out;
}
export const PINGREQ = Uint8Array.from([0xc0, 0x00]);
export const DISCONNECT = Uint8Array.from([0xe0, 0x00]);
const CONNACK_RC = ['accepted', 'unacceptable protocol version', 'client id rejected', 'server unavailable', 'bad user name or password', 'not authorised'];

// ---- Home Assistant discovery for Devices ----

interface HaField { component: 'sensor' | 'binary_sensor'; name: string; device_class?: string; unit?: string; state_class?: string; payload_on?: string; payload_off?: string }
/** rtl_433 field (lower-cased) → how Home Assistant should show it. */
export const HA_FIELDS: Record<string, HaField> = {
  temperature_c: { component: 'sensor', name: 'Temperature', device_class: 'temperature', unit: '°C', state_class: 'measurement' },
  temperature_f: { component: 'sensor', name: 'Temperature', device_class: 'temperature', unit: '°F', state_class: 'measurement' },
  humidity: { component: 'sensor', name: 'Humidity', device_class: 'humidity', unit: '%', state_class: 'measurement' },
  moisture: { component: 'sensor', name: 'Moisture', device_class: 'moisture', unit: '%', state_class: 'measurement' },
  pressure_hpa: { component: 'sensor', name: 'Pressure', device_class: 'pressure', unit: 'hPa', state_class: 'measurement' },
  pressure_kpa: { component: 'sensor', name: 'Pressure', device_class: 'pressure', unit: 'kPa', state_class: 'measurement' },
  pressure_psi: { component: 'sensor', name: 'Pressure', device_class: 'pressure', unit: 'psi', state_class: 'measurement' },
  wind_avg_km_h: { component: 'sensor', name: 'Wind speed', device_class: 'wind_speed', unit: 'km/h', state_class: 'measurement' },
  wind_max_km_h: { component: 'sensor', name: 'Wind gust', device_class: 'wind_speed', unit: 'km/h', state_class: 'measurement' },
  wind_avg_m_s: { component: 'sensor', name: 'Wind speed', device_class: 'wind_speed', unit: 'm/s', state_class: 'measurement' },
  wind_max_m_s: { component: 'sensor', name: 'Wind gust', device_class: 'wind_speed', unit: 'm/s', state_class: 'measurement' },
  wind_avg_mi_h: { component: 'sensor', name: 'Wind speed', device_class: 'wind_speed', unit: 'mph', state_class: 'measurement' },
  wind_dir_deg: { component: 'sensor', name: 'Wind direction', unit: '°', state_class: 'measurement' },
  rain_mm: { component: 'sensor', name: 'Rain', device_class: 'precipitation', unit: 'mm', state_class: 'total_increasing' },
  rain_in: { component: 'sensor', name: 'Rain', device_class: 'precipitation', unit: 'in', state_class: 'total_increasing' },
  light_lux: { component: 'sensor', name: 'Light', device_class: 'illuminance', unit: 'lx', state_class: 'measurement' },
  uv: { component: 'sensor', name: 'UV index', state_class: 'measurement' },
  // rtl_433's battery_ok is 1 when fine; a Home Assistant battery binary sensor is "on" when low
  battery_ok: { component: 'binary_sensor', name: 'Battery', device_class: 'battery', payload_on: '0', payload_off: '1' },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
/** A stable id for a device: model, channel and id, as rtl_433's own Home Assistant bridge builds it. */
export function deviceUid(d: Record<string, unknown>): string {
  return slug([d.model, d.channel, d.id].filter(v => v !== undefined && v !== '').join('_')) || 'unknown';
}

/** The retained discovery messages for one device: [topic, JSON] per field Home Assistant understands. */
export function haDiscovery(d: Record<string, unknown>, prefix: string): [string, string][] {
  const uid = deviceUid(d), state = `${prefix}/devices/${uid}`, out: [string, string][] = [];
  const name = [d.model, d.channel !== undefined ? `ch ${d.channel}` : '', d.id !== undefined ? `id ${d.id}` : ''].filter(Boolean).join(' ');
  for (const key of Object.keys(d)) {
    const f = HA_FIELDS[key.toLowerCase()]; if (!f) continue;
    const field = slug(key), oid = `madmobile_${uid}_${field}`;
    const cfg: Record<string, unknown> = {
      name: f.name, unique_id: oid, object_id: oid, state_topic: state,
      value_template: `{{ value_json['${key}'] }}`,
      device: { identifiers: [`madmobile_${uid}`], name: String(name), model: String(d.model ?? ''), manufacturer: 'via Mad Mobile (rtl_433 protocols)' },
      expire_after: 3600,
    };
    if (f.device_class) cfg.device_class = f.device_class;
    if (f.unit) cfg.unit_of_measurement = f.unit;
    if (f.state_class) cfg.state_class = f.state_class;
    if (f.payload_on !== undefined) { cfg.payload_on = f.payload_on; cfg.payload_off = f.payload_off; }
    out.push([`homeassistant/${f.component}/${oid}/config`, JSON.stringify(cfg)]);
  }
  return out;
}

/** Where an event is published; device states live apart under <prefix>/devices/<uid>. */
export function eventTopic(prefix: string, ev: DecodeEvent): string {
  return ev.kind === 'line' ? `${prefix}/events/line/${slug(ev.app) || 'app'}` : `${prefix}/events/${ev.kind.split('.').map(slug).join('/')}`;
}

// ---- the sink ----

export interface MqttOptions { url: string; topic: string; user: string; pass: string; ha: boolean; clientId?: string; keepAlive?: number }

export class MqttSink implements Sink {
  readonly name = 'mqtt';
  private ws: WsLike | null = null;
  private ready = false;
  private pending: Uint8Array[] = [];
  private announced = new Set<string>();
  private retry = 1000;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private rx = new Uint8Array(0);
  sent = 0; lastError = '';
  private readonly prefix: string;

  constructor(private readonly o: MqttOptions, private readonly Ws: WsCtor & (new (url: string, protocols?: string | string[]) => WsLike)) {
    this.prefix = o.topic.replace(/[#+]/g, '').replace(/\/+$/, '') || 'madmobile';
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.ready = false; this.rx = new Uint8Array(0);
    try {
      const ws = new this.Ws(this.o.url, ['mqtt']); ws.binaryType = 'arraybuffer'; this.ws = ws;
      ws.onopen = () => ws.send(connectPacket(this.o.clientId ?? `madmobile-${Math.random().toString(36).slice(2, 10)}`, this.o.keepAlive ?? 60, this.o.user || undefined, this.o.pass || undefined));
      (ws as unknown as { onmessage: ((e: { data: ArrayBuffer }) => void) | null }).onmessage = e => this.onData(new Uint8Array(e.data));
      ws.onerror = () => { this.lastError = 'connection error'; };
      ws.onclose = () => {
        this.down();
        if (!this.closed) { this.later(() => this.connect(), this.retry); this.retry = Math.min(30_000, this.retry * 2); }
      };
    } catch (e) { this.lastError = (e as Error).message; this.later(() => this.connect(), this.retry); }
  }
  private later(f: () => void, ms: number): void { this.timers.push(setTimeout(f, ms)); }
  private down(): void { this.ready = false; this.ws = null; if (this.ping) clearInterval(this.ping); this.ping = null; this.announced.clear(); }

  /** Broker → us: only CONNACK and PINGRESP matter at QoS 0. Packets may arrive split or joined. */
  private onData(b: Uint8Array): void {
    const all = new Uint8Array(this.rx.length + b.length); all.set(this.rx); all.set(b, this.rx.length);
    let o = 0;
    while (o + 2 <= all.length) {
      let len = 0, mul = 1, i = o + 1;
      for (; i < all.length; i++) { len += (all[i] & 0x7f) * mul; mul *= 128; if (!(all[i] & 0x80)) break; }
      if (i >= all.length || i + 1 + len > all.length) break;
      const type = all[o] >> 4, body = all.subarray(i + 1, i + 1 + len);
      if (type === 2) {
        const rc = body[1] ?? 255;
        if (rc === 0) {
          this.ready = true; this.retry = 1000; this.lastError = '';
          if (this.ping) clearInterval(this.ping);
          this.ping = setInterval(() => this.ws?.send(PINGREQ), ((this.o.keepAlive ?? 60) * 1000) / 2);
          const p = this.pending; this.pending = []; for (const m of p) this.send(m);
        } else { this.lastError = `broker refused: ${CONNACK_RC[rc] ?? rc}`; this.closed = true; this.ws?.close(); }
      }
      o = i + 1 + len;
    }
    this.rx = all.slice(o);
  }

  private send(pkt: Uint8Array): void {
    if (this.ready && this.ws?.readyState === 1) { this.ws.send(pkt); this.sent++; return; }
    this.pending.push(pkt); if (this.pending.length > 500) this.pending.splice(0, this.pending.length - 500);
  }

  handle(ev: DecodeEvent): void {
    this.send(publishPacket(eventTopic(this.prefix, ev), JSON.stringify(ev)));
    if (ev.kind === 'device' && ev.data) {
      const uid = deviceUid(ev.data);
      // per discovery topic, not per device: some sensors (Acurite 5-in-1) send different fields in alternate reports
      if (this.o.ha) for (const [t, cfg] of haDiscovery(ev.data, this.prefix)) {
        if (this.announced.has(t)) continue;
        this.announced.add(t); this.send(publishPacket(t, cfg, true));
      }
      this.send(publishPacket(`${this.prefix}/devices/${uid}`, JSON.stringify({ time: ev.t, ...ev.data })));
    }
  }

  status(): string { return `${this.ready ? 'connected' : 'not connected'} · ${this.sent} published${this.pending.length ? `, ${this.pending.length} waiting` : ''}${this.lastError ? ` · ${this.lastError}` : ''}`; }
  close(): void {
    this.closed = true; for (const t of this.timers) clearTimeout(t); this.timers = [];
    try { if (this.ready) this.ws?.send(DISCONNECT); this.ws?.close(); } catch { /* gone */ }
    this.down();
  }
}
