/**
 * FORK: HFDL above the physical layer, receive only, ported from dumphfdl (Tomasz Lemiech; src/mpdu.c, lpdu.c,
 * hfnpdu.c, acars.c GPL-3.0-or-later, src/spdu.c GPL-2.0-or-later, etc/systable.conf): ground-station squitters
 * (SPDU), the medium-access PDU (MPDU) and the link PDUs it carries (LPDU: logons, logoffs, data), and the HF network
 * PDUs inside them (HFNPDU: performance and frequency reports with the aircraft's position, enveloped ACARS). Every
 * PDU ends in the X.25 CRC-16 (reflected 0x1021, init and final 0xFFFF, low octet first). No DOM.
 */

/** dumphfdl's system table (version 52): ground station id, name, position, frequencies (kHz, in table order). */
export const HFDL_STATIONS: [number, string, number, number, number[]][] = [
  [1, 'San Francisco, California', 38.385, -121.760, [21934, 17919, 13276, 11327, 10081, 8927, 6559, 5508]],
  [2, 'Molokai, Hawaii', 21.184, -157.187, [21937, 17919, 13324, 13312, 13276, 11348, 11312, 10027, 8936, 8912, 6565, 5514]],
  [3, 'Reykjavik, Iceland', 63.847, -22.456, [17985, 15025, 11184, 8977, 6712, 5720, 3900]],
  [4, 'Riverhead, New York', 40.882, -72.638, [21931, 17919, 13276, 11387, 8912, 6661, 5652]],
  [5, 'Auckland, New Zealand', -37.016, 174.810, [17916, 13351, 10084, 8921, 6535, 5583]],
  [6, 'Hat Yai, Thailand', 6.938, 100.388, [21949, 17928, 13270, 10066, 8825, 6535, 5655]],
  [7, 'Shannon, Ireland', 52.744, -8.927, [11384, 10081, 8942, 8843, 6532, 5547, 3455, 2998]],
  [8, 'Johannesburg, South Africa', -26.130, 28.206, [21949, 17922, 13321, 11321, 8834, 5529, 4681, 3016]],
  [9, 'Barrow, Alaska', 71.258, -156.577, [21937, 21928, 17934, 17919, 11354, 10093, 10027, 8936, 8927, 6646, 5544, 5538, 5529, 4687, 4654, 3497, 3007, 2992, 2944]],
  [10, 'Muan, South Korea', 35.032, 126.239, [21931, 17958, 13342, 10060, 8939, 6619, 5502, 2941]],
  [11, 'Albrook, Panama', 9.085, -79.374, [17901, 13264, 10063, 8894, 6589, 5589]],
  [13, 'Santa Cruz, Bolivia', -17.671, -63.157, [21997, 17916, 13315, 11318, 8957, 6628, 4660]],
  [14, 'Krasnoyarsk, Russia', 56.153, 92.583, [21990, 17912, 13321, 10087, 8886, 6596, 5622]],
  [15, 'Al Muharraq, Bahrain', 26.309, 50.472, [21982, 17967, 13312, 10030, 8885, 6646, 5544, 2986]],
  [16, 'Agana, Guam', 13.489, 144.828, [21928, 17919, 13312, 11306, 8927, 6652, 5451]],
  [17, 'Canarias, Spain', 27.961, -15.406, [21955, 17928, 13303, 11348, 8948, 6529]],
];
/** Every published HFDL frequency (Hz), ascending. */
export const HFDL_FREQS = [...new Set(HFDL_STATIONS.flatMap(s => s[4]))].sort((a, b) => a - b).map(k => k * 1000);
/** The HFDL bands (named in MHz), each as the span to tune (centre placed so no channel lands on the DC spike) and its name. */
export const HFDL_BANDS: { name: string; centreHz: number }[] = [
  { name: '21', centreHz: 21_700_000 }, { name: '17', centreHz: 17_700_000 }, { name: '13', centreHz: 13_050_000 },
  { name: '11', centreHz: 11_100_000 }, { name: '10', centreHz: 9_850_000 }, { name: '8.9', centreHz: 8_700_000 },
  { name: '6.6', centreHz: 6_400_000 }, { name: '5.5', centreHz: 5_300_000 }, { name: '4.6', centreHz: 4_450_000 },
  { name: '3', centreHz: 3_200_000 },
];

export function stationName(id: number): string { return HFDL_STATIONS.find(s => s[0] === id)?.[1] ?? `GS ${id}`; }
/** A frequency mask's frequencies (kHz) for a station, bit i = its i-th frequency. */
export function maskFreqs(id: number, mask: number): number[] {
  const s = HFDL_STATIONS.find(x => x[0] === id); return s ? s[4].filter((_, i) => (mask >> i) & 1) : [];
}

export function crcHfdl(b: ArrayLike<number>, n = b.length): number {
  let c = 0xffff;
  for (let i = 0; i < n; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return c ^ 0xffff;
}
const fcsOk = (b: ArrayLike<number>, n: number) => n + 2 <= b.length && crcHfdl(b, n) === (b[n] | (b[n + 1] << 8));
const rev8 = (x: number) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((x >> i) & 1) << (7 - i); return r; };
/** An ICAO address as HFDL sends it: three octets, each bit-reversed. */
const icaoAt = (b: ArrayLike<number>, i: number) => ((rev8(b[i]) << 16) | (rev8(b[i + 1]) << 8) | rev8(b[i + 2])) >>> 0;
/** A 20-bit two's complement coordinate, 180° full scale. */
const coord = (v: number) => ((v << 12) >> 12) * 180 / 0x7ffff;
const u16 = (b: ArrayLike<number>, i: number) => b[i] | (b[i + 1] << 8);
const hhmmss = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export interface HfdlGsStatus { id: number; utcSync: boolean; freqs: number[] }
export interface HfdlSquitter { gs: number; version: number; changeNote: string; frameIndex: number; slot: number; systable: number; stations: HfdlGsStatus[] }
export interface HfdlAcars { down: boolean; crcOk: boolean; mode: string; reg: string; ack: string; label: string; blk: string; msn: string; flight: string; text: string }
export interface HfdlReport { flight: string; lat: number; lon: number; utc: string; gs?: number; freqKhz?: number; kind: 'performance' | 'frequency' }
export interface HfdlLpdu {
  type: string; icao?: number; acId?: number; reason?: number;
  acars?: HfdlAcars; report?: HfdlReport; hfnpdu?: string;
}
export interface HfdlPdu {
  kind: 'squitter' | 'mpdu'; down: boolean; gs: number;
  /** The aircraft's id on this ground station (the logon gives it), for MPDUs. */
  acId?: number; squitter?: HfdlSquitter; lpdus: HfdlLpdu[];
}

const CHANGE = ['none', 'channel down', 'frequency change coming', 'ground station down'];
const LPDU_TYPES: Record<number, string> = {
  0x0D: 'unnumbered data', 0x1D: "unnumbered ack'ed data", 0x2F: 'logon denied', 0x3F: 'logoff request', 0x5F: 'logon resume confirm',
  0x4F: 'logon resume', 0x8F: 'logon request', 0x9F: 'logon confirm', 0xBF: 'logon request (DLS)',
};

/** One burst's octets: a squitter or an MPDU with its LPDUs (only those whose CRC holds), or null. */
export function parseHfdl(b: Uint8Array): HfdlPdu | null {
  if (!b.length) return null;
  if (!(b[0] & 1)) {
    if (b.length < 66 || !fcsOk(b, 64)) return null;
    const gs = b[1] & 0x7f;
    const st: HfdlGsStatus[] = [
      { id: gs, utcSync: !!(b[1] & 0x80), freqs: maskFreqs(gs, (b[54] >> 4) | (b[55] << 4) | (b[56] << 12)) },
      { id: b[57] & 0x7f, utcSync: !!(b[57] & 0x80), freqs: [] },
      { id: (b[60] >> 4) | ((b[61] & 7) << 4), utcSync: !!(b[61] & 8), freqs: [] },
    ];
    st[1].freqs = maskFreqs(st[1].id, b[58] | (b[59] << 8) | ((b[60] & 0xf) << 16));
    st[2].freqs = maskFreqs(st[2].id, (b[61] >> 4) | (b[62] << 4) | (b[63] << 12));
    return { kind: 'squitter', down: false, gs, lpdus: [], squitter: { gs, version: (b[0] >> 2) & 3, changeNote: CHANGE[b[0] >> 6], frameIndex: b[2] | ((b[3] & 0xf) << 8), slot: b[3] >> 4, systable: b[53] | ((b[54] & 0xf) << 8), stations: st.filter(s => s.id) } };
  }
  const down = !!(b[0] & 2);
  if (down) {
    const cnt = (b[0] >> 2) & 0xf, hdr = 6 + cnt;
    if (b.length < hdr + 2 || !fcsOk(b, hdr)) return null;
    const lens = Array.from({ length: cnt }, (_, i) => b[6 + i] + 1);
    return { kind: 'mpdu', down, gs: b[1] & 0x7f, acId: b[2], lpdus: lpduList(b, hdr + 2, lens, true) };
  }
  const acs = ((b[0] & 0x70) >> 4) + 1; let hdr = 2;
  const per: { ac: number; lens: number[] }[] = [];
  for (let a = 0; a < acs; a++) {
    if (b.length < hdr + 2) return null;
    const cnt = b[hdr + 1] >> 4;
    per.push({ ac: b[hdr], lens: Array.from({ length: cnt }, (_, i) => (b[hdr + 2 + i] ?? 0) + 1) });
    hdr += 2 + cnt;
  }
  if (b.length < hdr + 2 || !fcsOk(b, hdr)) return null;
  let at = hdr + 2; const lpdus: HfdlLpdu[] = [];
  for (const p of per) { const l = lpduList(b, at, p.lens, false); for (const x of l) lpdus.push(x); at += p.lens.reduce((s, x) => s + x, 0); }
  return { kind: 'mpdu', down, gs: b[1] & 0x7f, acId: per.length === 1 ? per[0].ac : undefined, lpdus };
}

function lpduList(b: Uint8Array, at: number, lens: number[], down: boolean): HfdlLpdu[] {
  const out: HfdlLpdu[] = [];
  for (const len of lens) {
    if (at + len > b.length) break;
    const l = b.subarray(at, at + len); at += len;
    if (len < 3 || !fcsOk(l, len - 2)) continue;
    const n = len - 2, t = l[0], x: HfdlLpdu = { type: LPDU_TYPES[t] ?? `type 0x${t.toString(16).padStart(2, '0')}` };
    let used = 1;
    if (t === 0x2F || t === 0x3F) { if (n < 5) continue; x.icao = icaoAt(l, 1); x.reason = l[4]; used = 5; }
    else if (t === 0x9F || t === 0x5F) { if (n < 8) continue; x.icao = icaoAt(l, 1); x.acId = l[4]; used = 8; }
    else if (t === 0x4F || t === 0x8F || t === 0xBF) { if (n < 4) continue; x.icao = icaoAt(l, 1); used = 4; }
    else if (t !== 0x0D && t !== 0x1D) used = n;
    if (used < n) hfnpdu(l.subarray(used, n), down, x);
    out.push(x);
  }
  return out;
}

function hfnpdu(b: Uint8Array, down: boolean, x: HfdlLpdu): void {
  if (b.length < 2 || b[0] !== 0xFF) return;
  const t = b[1];
  const pos = (kind: 'performance' | 'frequency'): HfdlReport => ({
    kind, flight: String.fromCharCode(...b.subarray(2, 8)).replace(/[^\x20-\x7e]/g, '').trim(),
    lat: coord(b[8] | (b[9] << 8) | ((b[10] & 0xf) << 16)), lon: coord((b[10] >> 4) | (b[11] << 4) | (b[12] << 12)), utc: hhmmss(2 * u16(b, 13)),
  });
  if (t === 0xD1 && b.length >= 47) { x.hfnpdu = 'performance data'; x.report = { ...pos('performance'), gs: b[17] & 0x7f }; const f = maskFreqs(b[17] & 0x7f, 1 << b[18]); if (f.length) x.report.freqKhz = f[0]; }
  else if (t === 0xD5 && b.length >= 15) { x.hfnpdu = 'frequency data'; x.report = pos('frequency'); }
  else if (t === 0xD0) x.hfnpdu = 'system table';
  else if (t === 0xD2) x.hfnpdu = 'system table request';
  else if (t === 0xDE) x.hfnpdu = 'delayed echo';
  else if (t === 0xFF) { x.hfnpdu = 'enveloped data'; if (b[2] === 1) x.acars = acars(b.subarray(3), down) ?? undefined; }
  else x.hfnpdu = `type 0x${t.toString(16)}`;
}

const STX = 0x02, ETX = 0x03, ETB = 0x17, DEL = 0x7f;
/** An ACARS block after its SOH: mode, registration, ack, label, block id, then STX and the text. */
function acars(raw: Uint8Array, down: boolean): HfdlAcars | null {
  // ... ETX/ETB, the block check (CRC-16, reflected 0x1021 from 0, over everything through it), DEL
  let n = raw.length, crcOk = false;
  if (n >= 16 && (raw[n - 1] & 0x7f) === DEL) { crcOk = crcAcars(raw, n - 1) === 0; n -= 3; }
  const B = Array.from(raw.subarray(0, n), v => v & 0x7f); if (B.length < 12) return null;
  const ch = (i: number) => String.fromCharCode(B[i]);
  let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i);
  const a: HfdlAcars = { down, crcOk, mode: ch(0), reg: reg.replace(/^[. ]+|[. ]+$/g, ''), ack: B[8] === 0x15 ? 'NAK' : ch(8), label: ch(9) + (B[10] === DEL ? 'd' : ch(10)), blk: ch(11), msn: '', flight: '', text: '' };
  let p = 12;
  if (B[p] === STX) { p++; if (down && B.length - p >= 10) { for (let i = 0; i < 4; i++) a.msn += ch(p + i); for (let i = 4; i < 10; i++) a.flight += ch(p + i); a.flight = a.flight.trim(); p += 10; } }
  while (p < B.length) { const c = B[p++]; if (c === ETX || c === ETB) break; a.text += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : c === 0x0a || c === 0x0d ? ' ' : '·'; }
  a.text = a.text.trim();
  return a;
}

function crcAcars(b: ArrayLike<number>, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return c;
}

/** An ACARS message as the Flight Msgs screens read it (acars-planes.ts parseAcarsLine). */
export function acarsLine(a: HfdlAcars, khz: number): string {
  const head = `HFDL ${(khz / 1000).toFixed(3)} ${a.down ? '↓' : '↑'} ${a.reg}  ${a.label}  blk ${a.blk}  ack ${a.ack}${a.msn ? `  #${a.msn} ${a.flight}` : ''}${a.crcOk ? '' : '  CRC?'}${a.mode !== '2' ? `  mode ${a.mode}` : ''}`;
  return a.text ? `${head}\n${a.text}` : head;
}

const hex6 = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');
/** One line for the log. */
export function hfdlSummary(p: HfdlPdu, khz: number): string {
  const f = (khz / 1000).toFixed(3);
  if (p.squitter) {
    const s = p.squitter;
    return `HFDL ${f} squitter ${stationName(s.gs)} · slot ${s.frameIndex}/${s.slot} · on ${s.stations.map(g => `${stationName(g.id).split(',')[0]} ${g.freqs.map(k => (k / 1000).toFixed(3)).join('/') || '—'}`).join('; ')}${s.changeNote !== 'none' ? ` · ${s.changeNote}` : ''}`;
  }
  const who = p.down ? `aircraft ${p.acId} → ${stationName(p.gs)}` : `${stationName(p.gs)} → aircraft${p.acId !== undefined ? ` ${p.acId}` : 's'}`;
  const parts = p.lpdus.map(l => {
    const w = [l.type];
    if (l.icao !== undefined) w.push(`ICAO ${hex6(l.icao)}`);
    if (l.acId !== undefined) w.push(`id ${l.acId}`);
    if (l.report) w.push(`${l.hfnpdu} ${l.report.flight || '?'} ${l.report.lat.toFixed(3)},${l.report.lon.toFixed(3)} ${l.report.utc}`);
    else if (l.acars) w.push(`ACARS ${l.acars.reg} ${l.acars.label}`);
    else if (l.hfnpdu) w.push(l.hfnpdu);
    return w.join(' ');
  });
  return `HFDL ${f} ${p.down ? '↓' : '↑'} ${who}${parts.length ? ` · ${parts.join(' | ')}` : ''}`;
}

// ------------------------------------------------------------------------------------------------ test builders

const withFcs = (b: number[]) => { const c = crcHfdl(b); return [...b, c & 0xff, c >> 8]; };
/** A squitter from `gs` naming `freqMask` (its own frequencies by table order). */
export function buildSquitter(gs: number, freqMask: number, frameIndex = 0, slot = 0): number[] {
  const b = new Array(64).fill(0);
  b[0] = 0x02 | (1 << 2); b[1] = 0x80 | gs; b[2] = frameIndex & 0xff; b[3] = ((frameIndex >> 8) & 0xf) | (slot << 4);
  b[52] = 1; b[53] = 52; b[54] = (freqMask & 0xf) << 4; b[55] = (freqMask >> 4) & 0xff; b[56] = (freqMask >> 12) & 0xff;
  return withFcs(b);
}
/** A downlink MPDU from aircraft `acId` to `gs` carrying the given LPDU bodies (each without its FCS). */
export function buildDownlink(gs: number, acId: number, lpdus: number[][]): number[] {
  const ls = lpdus.map(withFcs);
  const hdr = withFcs([0x01 | 0x02 | (ls.length << 2), gs, acId, 0, 0, 0, ...ls.map(l => l.length - 1)]);
  return [...hdr, ...ls.flat()];
}
/** LPDU bodies: an ACARS message enveloped in unnumbered data; a performance report; a logon request. */
export function lpduAcars(a: { reg: string; label: string; blk: string; msn?: string; flight?: string; text: string; down: boolean }): number[] {
  const body = `2${a.reg.padStart(7, '.')}\x15${a.label}${a.blk}\x02${a.down ? `${a.msn ?? 'M01A'}${(a.flight ?? '').padEnd(6, ' ')}` : ''}${a.text}\x03`;
  // odd parity in bit 7, then the block check and DEL
  const odd = (c: number) => { let p = 0; for (let x = c; x; x >>= 1) p ^= x & 1; return p ? c : c | 0x80; };
  const blk = Array.from(body, c => odd(c.charCodeAt(0))), crc = crcAcars(blk, blk.length);
  return [0x0D, 0xFF, 0xFF, 0x01, ...blk, crc & 0xff, crc >> 8, DEL];
}
export function lpduPerformance(flight: string, lat: number, lon: number, utcS: number, gs: number): number[] {
  const la = Math.round(lat * 0x7ffff / 180) & 0xfffff, lo = Math.round(lon * 0x7ffff / 180) & 0xfffff, t = Math.floor(utcS / 2);
  const b = new Array(47).fill(0);
  b[0] = 0xFF; b[1] = 0xD1; for (let i = 0; i < 6; i++) b[2 + i] = (flight.padEnd(6, ' ')).charCodeAt(i);
  b[8] = la & 0xff; b[9] = (la >> 8) & 0xff; b[10] = ((la >> 16) & 0xf) | ((lo & 0xf) << 4); b[11] = (lo >> 4) & 0xff; b[12] = (lo >> 12) & 0xff;
  b[13] = t & 0xff; b[14] = t >> 8; b[15] = 1; b[17] = gs; b[18] = 0;
  return [0x0D, ...b];
}
export function lpduLogon(icao: number): number[] { return [0x8F, rev8(icao >> 16), rev8((icao >> 8) & 0xff), rev8(icao & 0xff)]; }
