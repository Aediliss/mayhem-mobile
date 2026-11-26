/**
 * FORK: drone Remote ID (ASTM F3411 / ASD-STAN EN 4709-002), receive only. Over Bluetooth 4 legacy advertising a drone
 * sends service data 0xFFFA: an application code (0x0D), a message counter, then one 25-byte message; over Bluetooth 5
 * extended advertising (and Wi-Fi) the messages come bundled in a Message Pack (type 0xF). Message types:
 *
 *  0 Basic ID      ID type, UA type, the UAS ID (serial number, registration or session ID, 20 characters)
 *  1 Location      status, direction, speeds, latitude / longitude (1e-7°), pressure and geodetic altitude and height
 *                  (0.5 m steps from -1000 m), accuracies, the time in tenths of a second past the hour
 *  2 Authentication  pages of signature data (shown as present, not checked)
 *  3 Self-ID       a 23-character description of the flight
 *  4 System        the operator's position, the area and its altitudes, the EU category and class, the time
 *  5 Operator ID   the operator's registration (20 characters)
 *
 * Field layouts as opendroneid-core-c (Apache-2.0) encodes them; written here from those definitions, no code copied.
 * Every value the standard marks invalid / unknown is left out. No DOM.
 */

export interface RidState {
  idType?: string; uaType?: string; uasId?: string;
  status?: string; lat?: number; lon?: number; altBaro?: number; altGeo?: number; height?: number; heightRef?: string;
  speed?: number; vspeed?: number; direction?: number; hAcc?: string; vAcc?: string; time?: string;
  selfId?: string; operatorId?: string;
  opLat?: number; opLon?: number; opAlt?: number; opLocType?: string; areaCount?: number; areaRadius?: number;
  category?: string; uaClass?: string;
  auth?: boolean;
  /** Message types heard (0-5). */
  types: number[];
}

const ID_TYPES = ['none', 'serial number', 'CAA registration', 'UTM ID', 'session ID'];
const UA_TYPES = ['none', 'aeroplane', 'multirotor / helicopter', 'gyroplane', 'hybrid lift (VTOL)', 'ornithopter', 'glider', 'kite', 'free balloon', 'captive balloon', 'airship', 'parachute', 'rocket', 'tethered powered aircraft', 'ground obstacle', 'other'];
const STATUS = ['undeclared', 'on the ground', 'airborne', 'emergency', 'Remote ID system failure'];
const H_ACC = ['unknown', '< 18.52 km', '< 7.408 km', '< 3.704 km', '< 1852 m', '< 926 m', '< 555.6 m', '< 185.2 m', '< 92.6 m', '< 30 m', '< 10 m', '< 3 m', '< 1 m'];
const V_ACC = ['unknown', '< 150 m', '< 45 m', '< 25 m', '< 10 m', '< 3 m', '< 1 m'];
const OP_LOC = ['take-off', 'live GNSS', 'fixed'];
const EU_CAT = ['undeclared', 'open', 'specific', 'certified'];

const u16 = (m: ArrayLike<number>, i: number) => m[i] | (m[i + 1] << 8);
const i32 = (m: ArrayLike<number>, i: number) => m[i] | (m[i + 1] << 8) | (m[i + 2] << 16) | (m[i + 3] << 24);
const text = (m: ArrayLike<number>, a: number, n: number) => { let s = ''; for (let i = a; i < a + n; i++) { const c = m[i]; if (!c) break; if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c); } return s.trim(); };
/** An altitude field: 0.5 m steps from -1000 m; 0 (-1000 m) means unknown. */
const alt = (v: number) => (v === 0 ? undefined : v * 0.5 - 1000);
const coord = (v: number, lim: number) => (v === 0 ? undefined : Math.abs(v / 1e7) <= lim ? v / 1e7 : undefined);

/** One 25-byte message into the drone's record. Returns the message type, or -1 if it is not one. */
export function readRidMessage(m: ArrayLike<number>, s: RidState): number {
  if (m.length < 25) return -1;
  const type = m[0] >> 4;
  switch (type) {
    case 0: {
      const idt = m[1] >> 4, uat = m[1] & 15, id = text(m, 2, 20);
      if (id) { s.uasId = id; s.idType = ID_TYPES[idt] ?? `type ${idt}`; }
      s.uaType = UA_TYPES[uat] ?? `type ${uat}`;
      break;
    }
    case 1: {
      const f = m[1];
      s.status = STATUS[f >> 4] ?? `status ${f >> 4}`;
      s.heightRef = f & 4 ? 'above ground' : 'above take-off';
      const dir = m[2] + (f & 2 ? 180 : 0); if (dir <= 360) s.direction = dir % 360;
      const sp = f & 1 ? m[3] * 0.75 + 255 * 0.25 : m[3] * 0.25; if (!(f & 1 && m[3] === 255)) s.speed = Math.round(sp * 100) / 100;
      const vs = ((m[4] << 24) >> 24) * 0.5; if (Math.abs(vs) <= 62) s.vspeed = vs;
      const lat = coord(i32(m, 5), 90), lon = coord(i32(m, 9), 180);
      if (lat !== undefined && lon !== undefined) { s.lat = lat; s.lon = lon; }
      s.altBaro = alt(u16(m, 13)); s.altGeo = alt(u16(m, 15)); s.height = alt(u16(m, 17));
      s.vAcc = V_ACC[m[19] >> 4] ?? 'unknown'; s.hAcc = H_ACC[m[19] & 15] ?? 'unknown';
      const t = u16(m, 21); if (t !== 0xffff && t <= 36_000) { const mm = Math.floor(t / 600), ss = (t % 600) / 10; s.time = `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')} past the hour`; }
      break;
    }
    case 2: s.auth = true; break;
    case 3: { const d = text(m, 2, 23); if (d) s.selfId = d; break; }
    case 4: {
      const f = m[1];
      s.opLocType = OP_LOC[f & 3] ?? 'unknown';
      const lat = coord(i32(m, 2), 90), lon = coord(i32(m, 6), 180);
      if (lat !== undefined && lon !== undefined) { s.opLat = lat; s.opLon = lon; }
      s.areaCount = u16(m, 10); s.areaRadius = m[12] * 10;
      if (((f >> 2) & 7) === 1) { s.category = EU_CAT[m[17] >> 4] ?? 'unknown'; const c = m[17] & 15; s.uaClass = c ? `C${c - 1}` : 'undeclared'; }
      s.opAlt = alt(u16(m, 18));
      break;
    }
    case 5: { const id = text(m, 2, 20); if (id) s.operatorId = id; break; }
    default: return -1;
  }
  if (!s.types.includes(type)) s.types.push(type);
  return type;
}

/** A message or a Message Pack (type 0xF: message size, count, then the messages) into the record; the types read. */
export function readRid(m: ArrayLike<number>, s: RidState): number[] {
  if (m.length >= 3 && m[0] >> 4 === 0xf) {
    const size = m[1], n = m[2], out: number[] = [];
    if (size !== 25 || n > 9) return out;
    for (let k = 0; k < n && 3 + 25 * (k + 1) <= m.length; k++) { const t = readRidMessage(Array.from(m).slice(3 + 25 * k, 3 + 25 * (k + 1)), s); if (t >= 0) out.push(t); }
    return out;
  }
  const t = readRidMessage(m, s);
  return t >= 0 ? [t] : [];
}

/** Service data 0xFFFA (after the UUID): application code 0x0D, counter, then the message or pack. */
export function readRidServiceData(d: ArrayLike<number>, s: RidState): number[] {
  if (d.length < 3 || d[0] !== 0x0d) return [];
  return readRid(Array.from(d).slice(2), s);
}

/** The lines a drone card shows. */
export function ridFields(s: RidState): { name: string; value: string }[] {
  const f: { name: string; value: string }[] = [], m = (v: number | undefined, u: string) => (v === undefined ? '' : `${Math.round(v * 10) / 10} ${u}`);
  if (s.uasId) f.push({ name: 'UAS ID', value: `${s.uasId} · ${s.idType}` });
  if (s.uaType) f.push({ name: 'Aircraft', value: s.uaType });
  if (s.status) f.push({ name: 'Status', value: s.status });
  if (s.lat !== undefined) f.push({ name: 'Drone position', value: `${s.lat.toFixed(6)}, ${s.lon!.toFixed(6)}${s.hAcc && s.hAcc !== 'unknown' ? ` · ${s.hAcc}` : ''}` });
  const alts = [s.altGeo !== undefined ? `${m(s.altGeo, 'm')} geodetic` : '', s.altBaro !== undefined ? `${m(s.altBaro, 'm')} pressure` : '', s.height !== undefined ? `${m(s.height, 'm')} ${s.heightRef}` : ''].filter(Boolean);
  if (alts.length) f.push({ name: 'Altitude', value: alts.join(' · ') });
  const mv = [s.speed !== undefined ? m(s.speed, 'm/s') : '', s.direction !== undefined ? `${s.direction}°` : '', s.vspeed !== undefined ? `${s.vspeed > 0 ? '+' : ''}${s.vspeed} m/s vertical` : ''].filter(Boolean);
  if (mv.length) f.push({ name: 'Moving', value: mv.join(' · ') });
  if (s.opLat !== undefined) f.push({ name: 'Operator position', value: `${s.opLat.toFixed(6)}, ${s.opLon!.toFixed(6)} · ${s.opLocType}` });
  if (s.operatorId) f.push({ name: 'Operator ID', value: s.operatorId });
  if (s.selfId) f.push({ name: 'Description', value: s.selfId });
  if (s.category) f.push({ name: 'EU category', value: `${s.category}${s.uaClass ? ` · class ${s.uaClass}` : ''}` });
  if (s.time) f.push({ name: 'Time', value: s.time });
  if (s.auth) f.push({ name: 'Authentication', value: 'sent (not checked)' });
  return f;
}

// ---------------------------------------------------------------------------------------------------- test transmitter

const put16 = (b: number[], i: number, v: number) => { b[i] = v & 255; b[i + 1] = (v >> 8) & 255; };
const put32 = (b: number[], i: number, v: number) => { for (let k = 0; k < 4; k++) b[i + k] = (v >>> (8 * k)) & 255; };
const encAlt = (m: number) => Math.round((m + 1000) / 0.5);
const putText = (b: number[], i: number, n: number, s: string) => { for (let k = 0; k < n; k++) b[i + k] = k < s.length ? s.charCodeAt(k) : 0; };
/** Messages as a drone builds them (test transmitter). */
export const ridEncode = {
  basicId(idType: number, uaType: number, id: string): number[] { const b = Array(25).fill(0); b[0] = 0x02; b[1] = (idType << 4) | uaType; putText(b, 2, 20, id); return b; },
  location(o: { status: number; dir: number; speed: number; vspeed: number; lat: number; lon: number; altBaro: number; altGeo: number; height: number; tenths: number }): number[] {
    const b = Array(25).fill(0); b[0] = 0x12;
    const ew = o.dir >= 180 ? 1 : 0, mult = o.speed > 63.75 ? 1 : 0;
    b[1] = (o.status << 4) | (ew << 1) | mult; b[2] = Math.round(o.dir - 180 * ew);
    b[3] = mult ? Math.round((o.speed - 63.75) / 0.75) : Math.round(o.speed / 0.25); b[4] = Math.round(o.vspeed / 0.5) & 255;
    put32(b, 5, Math.round(o.lat * 1e7)); put32(b, 9, Math.round(o.lon * 1e7));
    put16(b, 13, encAlt(o.altBaro)); put16(b, 15, encAlt(o.altGeo)); put16(b, 17, encAlt(o.height));
    b[19] = (4 << 4) | 10; put16(b, 21, o.tenths); return b;
  },
  selfId(t: string): number[] { const b = Array(25).fill(0); b[0] = 0x32; putText(b, 2, 23, t); return b; },
  system(o: { lat: number; lon: number; alt: number; category: number; cls: number }): number[] {
    const b = Array(25).fill(0); b[0] = 0x42; b[1] = 1 | (1 << 2); put32(b, 2, Math.round(o.lat * 1e7)); put32(b, 6, Math.round(o.lon * 1e7));
    put16(b, 10, 1); b[12] = 0; b[17] = (o.category << 4) | (o.cls + 1); put16(b, 18, encAlt(o.alt)); return b;
  },
  operatorId(id: string): number[] { const b = Array(25).fill(0); b[0] = 0x52; putText(b, 2, 20, id); return b; },
  pack(msgs: number[][]): number[] { return [0xf2, 25, msgs.length, ...msgs.flat()]; },
  /** The 0xFFFA service data of a Bluetooth 4 advertisement. */
  serviceData(counter: number, msg: number[]): number[] { return [0xfa, 0xff, 0x0d, counter & 255, ...msg]; },
};
