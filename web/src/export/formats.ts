/**
 * FORK: the wire formats other tools already read. Pure functions, so they are tested against published examples.
 *
 *   NMEA 0183 !AIVDM    AIS for OpenCPN, AIS-catcher, MarineTraffic feeders (ITU-R M.1371 payload, IEC 61162-1 framing)
 *   Beast binary        Mode-S frames for readsb / dump1090 / tar1090 (0x1a escape framing)
 *   SBS (BaseStation)   decoded aircraft for Virtual Radar Server and friends ("MSG,…" CSV)
 *   TNC2 text           APRS as monitor text (SRC>DEST,PATH:info), as APRS-IS and aprs.fi tools show it
 *   KISS                AX.25 frames for packet software (Direwolf-style TNC framing)
 *   rtl_433 JSON        sensors, keys and remotes as rtl_433 -F json prints them
 */

export const hex = (b: ArrayLike<number>) => Array.from(b, x => (x & 0xff).toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));

// ---- NMEA AIVDM ----

/** XOR of every character between the leading ! or $ and the *, as two upper-case hex digits. */
export function nmeaChecksum(body: string): string {
  let c = 0; for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}

/** 6-bit ASCII armouring of a bit string (MSB first per byte), with the fill bits needed to end on a 6-bit boundary. */
export function aisArmor(bytes: ArrayLike<number>, bits: number): { payload: string; fill: number } {
  let out = '';
  const fill = (6 - (bits % 6)) % 6, total = bits + fill;
  for (let i = 0; i < total; i += 6) {
    let v = 0;
    for (let k = 0; k < 6; k++) {
      const bit = i + k < bits ? (bytes[(i + k) >> 3] >> (7 - ((i + k) & 7))) & 1 : 0;
      v = (v << 1) | bit;
    }
    out += String.fromCharCode(v < 40 ? v + 48 : v + 56);
  }
  return { payload: out, fill };
}

/** And back: 6-bit armour to bytes (for tests and for anyone feeding NMEA in). */
export function aisUnarmor(payload: string, fill: number): { bytes: Uint8Array; bits: number } {
  const bits = payload.length * 6 - fill, bytes = new Uint8Array(Math.ceil(bits / 8));
  for (let i = 0; i < payload.length; i++) {
    let v = payload.charCodeAt(i) - 48; if (v > 40) v -= 8;
    for (let k = 0; k < 6; k++) { const n = i * 6 + k; if (n < bits && (v >> (5 - k)) & 1) bytes[n >> 3] |= 0x80 >> (n & 7); }
  }
  return { bytes, bits };
}

let aisSeq = 0;
/**
 * One AIS message as !AIVDM sentences. Long messages (type 5, 19, 21 …) are split into fragments of at most 60
 * payload characters, which keeps every sentence inside NMEA's 82-character limit; fragments share a sequence id.
 */
export function aivdm(bytes: ArrayLike<number>, bits: number, channel: 'A' | 'B' = 'A'): string[] {
  const { payload, fill } = aisArmor(bytes, bits);
  const parts: string[] = [];
  for (let i = 0; i < payload.length; i += 60) parts.push(payload.slice(i, i + 60));
  const seq = parts.length > 1 ? String(aisSeq = (aisSeq + 1) % 10) : '';
  return parts.map((p, i) => {
    const body = `AIVDM,${parts.length},${i + 1},${seq},${channel},${p},${i === parts.length - 1 ? fill : 0}`;
    return `!${body}*${nmeaChecksum(body)}`;
  });
}

// ---- Beast binary ----

/**
 * A Mode-S frame in Beast binary: 0x1a, '2' (56-bit) or '3' (112-bit), a 6-byte 12 MHz timestamp, a signal byte,
 * the frame; every 0x1a after the first byte doubled. The timestamp is 0: this receiver has no sample-accurate
 * clock, so the output is fine for readsb/tar1090 but not for multilateration.
 */
export function beastFrame(frame: ArrayLike<number>, signal = 0, timestamp12MHz = 0): Uint8Array {
  if (frame.length !== 7 && frame.length !== 14) throw new Error(`Beast: a Mode-S frame is 7 or 14 bytes, not ${frame.length}`);
  const body: number[] = [frame.length === 14 ? 0x33 : 0x32];
  for (let s = 40; s >= 0; s -= 8) body.push(Math.floor(timestamp12MHz / 2 ** s) & 0xff);
  body.push(signal & 0xff, ...Array.from(frame));
  const out: number[] = [0x1a];
  for (const b of body) { out.push(b); if (b === 0x1a) out.push(0x1a); }
  return Uint8Array.from(out);
}

// ---- SBS (BaseStation) ----

export interface SbsAircraft { icao: string; flight?: string; lat?: number; lon?: number; alt?: number; gs?: number; track?: number; vr?: number; squawk?: string }

function sbsTime(d: Date): [string, string] {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return [`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`, `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`];
}

/** One SBS line: MSG,<type>,1,1,<ICAO>,1,<date>,<time>,<date>,<time>, then fields 11-22 (callsign … on-ground). */
export function sbsLine(type: 1 | 3 | 4 | 6, a: SbsAircraft, when: Date): string {
  const [d, t] = sbsTime(when), f = (v: number | undefined, digits = 0) => (v === undefined ? '' : digits ? v.toFixed(digits) : String(Math.round(v)));
  const cols: string[] = ['', '', '', '', '', '', '', '', '', '', '', ''];   // 11 callsign · 12 alt · 13 gs · 14 track · 15 lat · 16 lon · 17 vr · 18 squawk · 19-22 flags
  if (type === 1) cols[0] = (a.flight ?? '').trim();
  if (type === 3) { cols[1] = f(a.alt); cols[4] = f(a.lat, 5); cols[5] = f(a.lon, 5); }
  if (type === 4) { cols[2] = f(a.gs); cols[3] = f(a.track); cols[6] = f(a.vr); }
  if (type === 6) cols[7] = a.squawk ?? '';
  if (type !== 1) cols[8] = cols[9] = cols[10] = cols[11] = '0';
  return ['MSG', type, 1, 1, a.icao.toUpperCase(), 1, d, t, d, t, ...cols].join(',');
}

/** SBS keeps per-aircraft state: each table update becomes the MSG lines for what actually changed. */
export class SbsEncoder {
  private last = new Map<string, SbsAircraft>();
  update(a: SbsAircraft, when = new Date()): string[] {
    const p = this.last.get(a.icao) ?? { icao: a.icao }, out: string[] = [];
    if (a.flight && a.flight !== p.flight) out.push(sbsLine(1, a, when));
    if (a.lat !== undefined && a.lon !== undefined && (a.lat !== p.lat || a.lon !== p.lon || a.alt !== p.alt)) out.push(sbsLine(3, a, when));
    if ((a.gs !== undefined || a.track !== undefined) && (a.gs !== p.gs || a.track !== p.track || a.vr !== p.vr)) out.push(sbsLine(4, a, when));
    if (a.squawk && a.squawk !== p.squawk) out.push(sbsLine(6, a, when));
    this.last.set(a.icao, { ...a });
    if (this.last.size > 5000) this.last.clear();
    return out;
  }
}

// ---- AX.25: TNC2 text and KISS ----

/** An AX.25 UI frame (no FCS) as TNC2 monitor text: SRC>DEST,DIGI1,DIGI2*:info. Null when it is not a UI frame. */
export function ax25ToTnc2(f: ArrayLike<number>): string | null {
  const call = (o: number) => {
    let s = ''; for (let i = 0; i < 6; i++) s += String.fromCharCode(f[o + i] >> 1);
    const ssid = (f[o + 6] >> 1) & 0x0f;
    return s.trim() + (ssid ? `-${ssid}` : '');
  };
  const addrs: string[] = [];
  let o = 0;
  for (;;) {
    if (o + 7 > f.length) return null;
    let c = call(o);
    if (addrs.length >= 2 && (f[o + 6] & 0x80)) c += '*';    // has-been-repeated, on digipeaters
    addrs.push(c);
    const last = (f[o + 6] & 1) === 1; o += 7;
    if (last || addrs.length === 10) break;
  }
  if (addrs.length < 2 || f[o] !== 0x03 || f[o + 1] !== 0xf0) return null;
  let info = ''; for (let i = o + 2; i < f.length; i++) info += String.fromCharCode(f[i]);
  return `${addrs[1]}>${addrs[0]}${addrs.length > 2 ? ',' + addrs.slice(2).join(',') : ''}:${info}`;
}

const FEND = 0xc0, FESC = 0xdb, TFEND = 0xdc, TFESC = 0xdd;
/** A KISS data frame on port 0: FEND, 0x00, the frame with FEND/FESC escaped, FEND. */
export function kissFrame(f: ArrayLike<number>, port = 0): Uint8Array {
  const out = [FEND, (port & 0x0f) << 4];
  for (let i = 0; i < f.length; i++) { const b = f[i]; if (b === FEND) out.push(FESC, TFEND); else if (b === FESC) out.push(FESC, TFESC); else out.push(b); }
  out.push(FEND);
  return Uint8Array.from(out);
}

// ---- rtl_433 JSON ----

/** rtl_433's default "time" field: local time, "YYYY-MM-DD HH:MM:SS". */
export function rtl433Time(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** A device report as rtl_433 -F json prints it: time first, then model, id and the decoder's fields. */
export function rtl433Json(data: Record<string, unknown>, when: Date): string {
  return JSON.stringify({ time: rtl433Time(when), ...data });
}
