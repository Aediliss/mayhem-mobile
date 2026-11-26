/**
 * FORK: ARINC 622 ATS applications inside ACARS (on ACARS, VDL2 and HFDL alike), receive only. Ported from libacars
 * (Tomasz Lemiech, MIT: libacars/arinc.c, adsc.c, acars.c): the envelope (ground station address, IMI, aircraft
 * registration, the payload in hex, CRC-16), and ADS-C (ARINC 745) in both directions: the aircraft's reports (basic
 * report with position, altitude and time; flight ID; predicted route; earth and air reference; meteo; airframe ID;
 * projections; acknowledgements) and the ground's contract requests. FANS-1/A CPDLC (AT1, CR1, CC1, DR1) is named
 * here; its message body (ASN.1 PER) is not read yet. No DOM.
 */

export type Arinc622App = 'adsc' | 'adsc-disconnect' | 'cpdlc' | 'cpdlc-connect' | 'cpdlc-confirm' | 'cpdlc-disconnect';
const IMIS: [string, Arinc622App][] = [['AT1', 'cpdlc'], ['CR1', 'cpdlc-connect'], ['CC1', 'cpdlc-confirm'], ['DR1', 'cpdlc-disconnect'], ['ADS', 'adsc'], ['DIS', 'adsc-disconnect']];

export interface AdscTag { tag: number; name: string; [k: string]: unknown }
export interface Arinc622 {
  app: Arinc622App; imi: string; gsAddr: string; reg: string; crcOk: boolean; down: boolean;
  /** The payload (CRC removed). */
  bytes: Uint8Array;
  /** ADS-C tags, in order; `err` when one could not be read (the rest is left unread). */
  adsc?: { tags: AdscTag[]; err: boolean };
}

/** CRC-16 (0x1021, from 0xFFFF, not reflected) over IMI, registration and payload with its CRC: 0x1D0F when good. */
export function crcArinc(b: ArrayLike<number>, n = b.length, init = 0xffff): number {
  let c = init;
  for (let i = 0; i < n; i++) { c ^= b[i] << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
  return c;
}

/** The sublabel and MFI an H1 message may open with ("#M1B/FA " down, "- #M1/FA " up): how many characters to skip. */
function skipSublabel(text: string, down: boolean): number {
  let p = 0;
  if (down) { if (text.length >= 4 && text[0] === '#' && text[3] === 'B') p = 4; else return 0; }
  else { if (text.startsWith('- #') && text.length >= 5) p = 5; else return 0; }
  if (text.length >= p + 4 && text[p] === '/' && text[p + 3] === ' ') p += 4;
  return p;
}

const LABELS = new Set(['A6', 'AA', 'B6', 'BA', 'H1']);
/** An ACARS message's ARINC 622 application, or null when it carries none. */
export function parseArinc622(label: string, text: string, down: boolean): Arinc622 | null {
  if (!LABELS.has(label)) return null;
  let t = label === 'H1' ? text.slice(skipSublabel(text, down)) : text;
  if (t[0] === '/') t = t.slice(1);
  let imi = '', app: Arinc622App | null = null, at = -1;
  for (const [s, a] of IMIS) { const i = t.indexOf(`.${s}`); if (i >= 0) { imi = s; app = a; at = i; break; } }
  if (!app || (at !== 7 && at !== 4) || !/^[A-Z0-9]+$/.test(t.slice(0, at))) return null;
  const gsAddr = t.slice(0, at), payload = t.slice(at + 1);
  if (payload.length < 3 + 7 + 4) return null;
  const reg = payload.slice(3, 10), hex = payload.slice(10).replace(/[^0-9A-Fa-f].*$/s, '');
  const n = hex.length >> 1, raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (n < 2) return null;
  const head = Array.from(payload.slice(0, 10), c => c.charCodeAt(0) & 0xff);
  const crcOk = crcArinc([...head, ...raw]) === 0x1d0f;
  const bytes = raw.slice(0, n - 2);
  const r: Arinc622 = { app, imi, gsAddr, reg: reg.replace(/^[.\s]+/, ''), crcOk, down, bytes };
  if (app === 'adsc') r.adsc = down ? adscDown(bytes) : adscUp(bytes);
  if (app === 'adsc-disconnect') r.adsc = { tags: bytes.length ? [{ tag: 255, name: 'Disconnect', reason: bytes[0] }] : [], err: !bytes.length };
  return r;
}

// ------------------------------------------------------------------------------------------------------- ADS-C

/** Bits, most significant first. */
class Bits {
  private p = 0;
  constructor(private readonly b: Uint8Array, private readonly at: number) {}
  read(n: number): number { let v = 0; for (let i = 0; i < n; i++, this.p++) v = v * 2 + ((this.b[this.at + (this.p >> 3)] >> (7 - (this.p & 7))) & 1); return v; }
}
const sx = (v: number, n: number) => v >= 2 ** (n - 1) ? v - 2 ** n : v;
/** 21-bit coordinate: MSB 90°, so full scale 180 − 90/2^19 at 0xFFFFF. */
const coord = (v: number) => (180 - 90 / 2 ** 19) * sx(v, 21) / 0xfffff;
const angle = (v: number, n: number, msbScale: number) => { const r = (msbScale * 2 - msbScale / 2 ** (n - 2)) * sx(v, n) / (2 ** (n - 1) - 1); return r < 0 ? r + 360 : r; };
const alt = (v: number) => sx(v, 16) * 4;
const tidy = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

function basicReport(b: Uint8Array, at: number) {
  const r = new Bits(b, at), lat = coord(r.read(21)), lon = coord(r.read(21)), altFt = alt(r.read(16)), ts = r.read(15) * 0.125, f = r.read(7);
  return { lat: tidy(lat), lon: tidy(lon), altFt, secPastHour: ts, redundancy: f & 1, accuracy: (f >> 1) & 7, tcasOk: (f >> 4) & 1 };
}
const DOWN: Record<number, [string, number, (b: Uint8Array, at: number) => Record<string, unknown>]> = {
  3: ['Acknowledgement', 1, (b, at) => ({ contract: b[at] })],
  6: ['Cancel emergency mode', 0, () => ({})],
  7: ['Basic report', 10, basicReport], 9: ['Emergency basic report', 10, basicReport],
  10: ['Lateral deviation change event', 10, basicReport], 18: ['Vertical rate change event', 10, basicReport],
  19: ['Altitude range event', 10, basicReport], 20: ['Waypoint change event', 10, basicReport],
  12: ['Flight ID', 6, (b, at) => { const r = new Bits(b, at); let s = ''; for (let i = 0; i < 8; i++) { let c = r.read(6); if (!(c & 0x20)) c += 0x40; s += String.fromCharCode(c); } return { id: s.trim() }; }],
  13: ['Predicted route', 17, (b, at) => { const r = new Bits(b, at); return { lat: tidy(coord(r.read(21))), lon: tidy(coord(r.read(21))), altFt: alt(r.read(16)), etaS: r.read(14), lat2: tidy(coord(r.read(21))), lon2: tidy(coord(r.read(21))), altFt2: alt(r.read(16)) }; }],
  14: ['Earth reference data', 5, (b, at) => { const r = new Bits(b, at), bad = r.read(1); return { trackDeg: tidy(angle(r.read(12), 12, 90), 2), trackValid: !bad, groundKt: r.read(13) / 2, vsFpm: sx(r.read(12), 12) * 16 }; }],
  15: ['Air reference data', 5, (b, at) => { const r = new Bits(b, at), bad = r.read(1); return { headingDeg: tidy(angle(r.read(12), 12, 90), 2), headingValid: !bad, mach: r.read(13) / 2 / 1000, vsFpm: sx(r.read(12), 12) * 16 }; }],
  16: ['Meteo data', 4, (b, at) => { const r = new Bits(b, at), ws = r.read(9) / 2, bad = r.read(1), wd = angle(r.read(9), 9, 90), t = (512 - 256 / 2 ** 10) * sx(r.read(12), 12) / 0x7ff; return { windKt: ws, windDeg: tidy(wd, 1), windValid: !bad, tempC: tidy(t, 2) }; }],
  17: ['Airframe ID', 3, (b, at) => ({ icao: ((b[at] << 16) | (b[at + 1] << 8) | b[at + 2]).toString(16).toUpperCase().padStart(6, '0') })],
  22: ['Intermediate projection', 8, (b, at) => { const r = new Bits(b, at), nm = r.read(16) / 8, bad = r.read(1); return { distNm: nm, trackDeg: tidy(angle(r.read(12), 12, 90), 2), trackValid: !bad, altFt: alt(r.read(16)), etaS: r.read(14) }; }],
  23: ['Fixed projection', 9, (b, at) => { const r = new Bits(b, at); return { lat: tidy(coord(r.read(21))), lon: tidy(coord(r.read(21))), altFt: alt(r.read(16)), etaS: r.read(14) }; }],
};
function adscDown(b: Uint8Array): { tags: AdscTag[]; err: boolean } {
  const tags: AdscTag[] = []; let p = 0;
  while (p < b.length) {
    const t = b[p++];
    if (t === 4) {                                             // negative acknowledgement: 2 or 3 octets
      if (p + 2 > b.length || b[p + 1] > 13) return { tags, err: true };
      const ext = b[p + 1] === 1 || b[p + 1] === 2 || b[p + 1] === 7;
      if (ext && p + 3 > b.length) return { tags, err: true };
      tags.push({ tag: 4, name: 'Negative acknowledgement', contract: b[p], reason: b[p + 1], ...(ext ? { ext: b[p + 2] } : {}) }); p += ext ? 3 : 2; continue;
    }
    if (t === 5) {                                             // noncompliance notification: groups of varying length
      if (p + 2 > b.length) return { tags, err: true };
      const contract = b[p], groups = b[p + 1]; p += 2; const g: { tag: number; params: number[] }[] = [];
      for (let i = 0; i < groups; i++) {
        if (p + 2 > b.length) return { tags, err: true };
        const tag = b[p], f = b[p + 1]; p += 2; const params: number[] = [];
        if (!(f & 0xc0)) { const n = f & 0xf; if (p + Math.ceil(n / 2) > b.length) return { tags, err: true }; for (let k = 0; k < n; k++) params.push((b[p + (k >> 1)] >> (k & 1 ? 0 : 4)) & 0xf); p += Math.ceil(n / 2); }
        g.push({ tag, params });
      }
      tags.push({ tag: 5, name: 'Noncompliance notification', contract, groups: g }); continue;
    }
    const d = DOWN[t];
    if (!d || p + d[1] > b.length) return { tags, err: true };
    tags.push({ tag: t, name: d[0], ...d[2](b, p) }); p += d[1];
  }
  return { tags, err: false };
}

const REQ: Record<number, [string, number]> = { 10: ['Lateral deviation threshold', 1], 11: ['Reporting interval', 1], 12: ['Flight ID', 1], 13: ['Predicted route', 1], 14: ['Earth reference data', 1], 15: ['Air reference data', 1], 16: ['Meteo data', 1], 17: ['Airframe ID', 1], 18: ['Vertical speed threshold', 1], 19: ['Altitude range', 4], 20: ['Waypoint changes', 0], 21: ['Aircraft intent', 2] };
function adscUp(b: Uint8Array): { tags: AdscTag[]; err: boolean } {
  const tags: AdscTag[] = []; let p = 0;
  while (p < b.length) {
    const t = b[p++];
    if (t === 1) { tags.push({ tag: 1, name: 'Cancel all contracts' }); continue; }
    if (t === 2 || t === 6) { if (p >= b.length) return { tags, err: true }; tags.push({ tag: t, name: t === 2 ? 'Cancel contract' : 'Cancel emergency mode', contract: b[p++] }); continue; }
    if (t !== 7 && t !== 8 && t !== 9) return { tags, err: true };
    if (p >= b.length) return { tags, err: true };
    const contract = b[p++], wants: string[] = []; let intervalS: number | undefined;
    while (p < b.length && REQ[b[p]]) {
      const s = b[p++], [name, len] = REQ[s]; if (p + len > b.length) return { tags, err: true };
      if (s === 11) intervalS = [0, 1, 8, 64][b[p] >> 6] * ((b[p] & 0x3f) + 1);   // as libacars reads it
      else wants.push(name);
      p += len;
    }
    tags.push({ tag: t, name: t === 7 ? 'Periodic contract request' : t === 8 ? 'Event contract request' : 'Emergency periodic contract request', contract, wants, ...(intervalS !== undefined ? { intervalS } : {}) });
  }
  return { tags, err: false };
}

const APP_WORDS: Record<Arinc622App, string> = {
  adsc: 'ADS-C', 'adsc-disconnect': 'ADS-C disconnect', cpdlc: 'CPDLC message', 'cpdlc-connect': 'CPDLC connect request',
  'cpdlc-confirm': 'CPDLC connect confirm', 'cpdlc-disconnect': 'CPDLC disconnect request',
};
const sec = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(0).padStart(2, '0')}`;
/** What the message says, in a line; and the aircraft's position, height and motion when it reports them. */
export function arinc622Summary(a: Arinc622): { summary: string; pos: { lat: number; lon: number } | null; altFt: number | null; kt: number | null; hdg: number | null } {
  const to = a.down ? `to ${a.gsAddr}` : `from ${a.gsAddr}`, crc = a.crcOk ? '' : ' (CRC failed)';
  let pos: { lat: number; lon: number } | null = null, altFt: number | null = null, kt: number | null = null, hdg: number | null = null;
  if (!a.adsc) return { summary: `${APP_WORDS[a.app]} ${to}${crc}`, pos, altFt, kt, hdg };
  const words: string[] = [];
  for (const t of a.adsc.tags) {
    if (!a.down) { words.push(t.tag === 7 || t.tag === 8 || t.tag === 9 ? `${(t.name as string).toLowerCase()} #${t.contract}${t.intervalS !== undefined ? ` every ${t.intervalS} s` : ''}${(t.wants as string[]).length ? ` + ${(t.wants as string[]).join(', ').toLowerCase()}` : ''}` : `${(t.name as string).toLowerCase()}${t.contract !== undefined ? ` #${t.contract}` : ''}`); continue; }
    if ([7, 9, 10, 18, 19, 20].includes(t.tag)) {
      pos = { lat: t.lat as number, lon: t.lon as number }; altFt = t.altFt as number;
      words.push(`${t.tag === 9 ? 'EMERGENCY ' : ''}${t.tag === 7 || t.tag === 9 ? 'position' : (t.name as string).toLowerCase()} ${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)} · ${altFt} ft · at :${sec(t.secPastHour as number)}`);
    } else if (t.tag === 14) { kt = t.groundKt as number; if (t.trackValid) hdg = Math.round(t.trackDeg as number); words.push(`track ${Math.round(t.trackDeg as number)}° · ${kt} kt · ${t.vsFpm} ft/min`); }
    else if (t.tag === 15) words.push(`heading ${Math.round(t.headingDeg as number)}° · Mach ${(t.mach as number).toFixed(3)}`);
    else if (t.tag === 16) words.push(`wind ${Math.round(t.windDeg as number)}° ${t.windKt} kt · ${t.tempC} °C`);
    else if (t.tag === 12) words.push(`flight ${t.id}`);
    else if (t.tag === 17) words.push(`ICAO ${t.icao}`);
    else if (t.tag === 13) words.push(`next ${(t.lat as number).toFixed(2)}, ${(t.lon as number).toFixed(2)} at ${t.altFt} ft`);
    else words.push(`${(t.name as string).toLowerCase()}${t.contract !== undefined ? ` #${t.contract}` : ''}`);
  }
  return { summary: `ADS-C ${to}: ${words.join(' · ') || 'nothing'}${a.adsc.err ? ' (partly unreadable)' : ''}${crc}`, pos, altFt, kt, hdg };
}

// ------------------------------------------------------------------------------------------------ test builders

/** A message text carrying an ARINC 622 payload, as an aircraft (down) or ground station sends it. */
export function buildArinc622(o: { imi: string; gsAddr: string; reg: string; bytes: number[]; h1Prefix?: string }): string {
  const reg = o.reg.padStart(7, '.'), head = Array.from(o.imi + reg, c => c.charCodeAt(0));
  const crc = crcArinc([...head, ...o.bytes]) ^ 0xffff;
  const hex = [...o.bytes, crc >> 8, crc & 0xff].map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
  return `${o.h1Prefix ?? ''}/${o.gsAddr}.${o.imi}${reg}${hex}`;
}
const put = (bits: number[], v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(((v % 2 ** n) + 2 ** n) % 2 ** n / 2 ** i) & 1); };
const pack = (bits: number[]) => { const o: number[] = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let k = 0; k < 8; k++) v = v * 2 + (bits[i + k] ?? 0); o.push(v); } return o; };
const enc = (deg: number, n: number, full: number, max: number) => Math.round(deg * max / full);
/** Downlink ADS-C tags for tests: a basic report, earth reference and flight ID. */
export function adscBasicReport(lat: number, lon: number, altFt: number, secPastHour: number, tag = 7): number[] {
  const b: number[] = [];
  put(b, enc(lat, 21, 180 - 90 / 2 ** 19, 0xfffff), 21); put(b, enc(lon, 21, 180 - 90 / 2 ** 19, 0xfffff), 21);
  put(b, Math.round(altFt / 4), 16); put(b, Math.round(secPastHour * 8), 15); put(b, 0b0010001, 7);
  return [tag, ...pack(b)];
}
export function adscEarthRef(trackDeg: number, kt: number, vsFpm: number): number[] {
  const b: number[] = [];
  const tr = trackDeg > 180 ? trackDeg - 360 : trackDeg;
  put(b, 0, 1); put(b, enc(tr, 12, 180 - 90 / 2 ** 10, 0x7ff), 12); put(b, Math.round(kt * 2), 13); put(b, Math.round(vsFpm / 16), 12); put(b, 0, 2);
  return [14, ...pack(b)];
}
export function adscFlightId(id: string): number[] {
  const b: number[] = [];
  for (const c of id.padEnd(8, ' ').slice(0, 8)) put(b, c.charCodeAt(0) & 0x3f, 6);
  return [12, ...pack(b)];
}
