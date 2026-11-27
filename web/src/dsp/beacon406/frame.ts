/**
 * FORK: Cospas-Sarsat 406 MHz distress beacon frames (EPIRB, PLB, ELT), first generation, receive only. Ported from
 * PortaPack Mayhem's EPIRB receiver by Frederic Borry, ADRASEC 31 (GPL-2.0-or-later: firmware/application/external/
 * epirb_rx/beacon.hpp, location.cpp, sdcard/EPIRB/RES/BEACON.RES), following C/S T.001's bit numbering: bit 1 is the first
 * bit sent; 1-15 bit sync (ones), 16-24 frame sync (000101111 normal, 011010000 self-test), 25 format flag (long/short),
 * 26 protocol flag, 27-36 country code (the MID), 37-39/40 protocol code, 26-85 the 15-hex-digit beacon ID (location
 * bits defaulted), 86-106 BCH-1, then for long frames 107-132 the second protected field and 133-144 BCH-2. A single
 * bit error in either protected field is corrected (as Mayhem does). Receive only.
 */
import { mmsiInfo } from '../../ais-info.js';

export const BCH1_POLY = 0b1001101101100111100011, BCH1_LEN = 22;
export const BCH2_POLY = 0b1010100111001, BCH2_LEN = 13;

/** Bits startBit..endBit (1-based, inclusive), first bit most significant. */
function bits(f: Uint8Array, startBit: number, endBit: number): number {
  let r = 0;
  for (let b = startBit; b <= endBit; b++) r = r * 2 + ((f[(b - 1) >> 3] >> (7 - ((b - 1) & 7))) & 1);
  return r;
}
function flip(f: Uint8Array, b: number): void { f[(b - 1) >> 3] ^= 1 << (7 - ((b - 1) & 7)); }
/** BCH remainder of bits start..end by `poly` (Mayhem's computeBCH). */
export function bch(f: Uint8Array, start: number, end: number, poly: number, plen: number): number {
  const n = end - start + 1, total = n + plen - 1;
  let r = bits(f, start, start + plen - 1);
  for (let i = plen; i <= total; i++) {
    if (Math.floor(r / 2 ** (plen - 1)) & 1) r = (r ^ poly) >>> 0;
    if (i < total) { r = r * 2; if (i < n) r += bits(f, start + i, start + i); }
  }
  return r;
}
const bch1 = (f: Uint8Array) => bch(f, 25, 85, BCH1_POLY, BCH1_LEN);
const bch2 = (f: Uint8Array) => bch(f, 107, 132, BCH2_POLY, BCH2_LEN);

const PROTOCOL_NAMES: Record<string, string> = {
  USER_EPIRB_MARITIME: 'EPIRB - Maritime', USER_EPIRB_RADIO: 'EPIRB - Radio Call Sign', USER_ELT: 'ELT - Aviation', USER_SERIAL: 'Serial User Protocol',
  USER_TEST: 'Test User Protocol', USER_ORB: 'Orbitography Protocol', USER_NAT: 'National User Protocol', USER_2G: '2nd Generation Beacons',
  STD_EPIRB: 'EPIRB - MMSI / Location', STD_ELT_24: 'ELT-24-bit Address / Location', STD_ELT_SERIAL: 'ELT Serial Location', STD_ELT_AIRCRAFT: 'ELT Serial Aircraft Location',
  STD_EPIRB_SERIAL: 'EPIRB Serial Location', STD_PLB_SERIAL: 'PLB Serial Location', STD_SHIP: 'Ship Security Location', STD_TEST: 'Test Standard Location',
  NAT_ELT: 'ELT National Location', NAT_EPIRB: 'EPIRB National Location', NAT_PLB: 'PLB National Location', NAT_TEST: 'Test National Location',
  RLS: 'RLS Location Protocol', ELT_DT: 'ELT(DT) Location Protocol', SPARE: 'Spare', UNKNOWN: 'Unknown',
};
const USER = ['USER_ORB', 'USER_ELT', 'USER_EPIRB_MARITIME', 'USER_SERIAL', 'USER_NAT', 'USER_2G', 'USER_EPIRB_RADIO', 'USER_TEST'];
const LONG: Record<number, string> = { 0b0010: 'STD_EPIRB', 0b0011: 'STD_ELT_24', 0b0100: 'STD_ELT_SERIAL', 0b0101: 'STD_ELT_AIRCRAFT', 0b0110: 'STD_EPIRB_SERIAL', 0b0111: 'STD_PLB_SERIAL', 0b1000: 'NAT_ELT', 0b1001: 'ELT_DT', 0b1010: 'NAT_EPIRB', 0b1011: 'NAT_PLB', 0b1100: 'STD_SHIP', 0b1101: 'RLS', 0b1110: 'STD_TEST', 0b1111: 'NAT_TEST' };
type Family = 'user' | 'standard' | 'national' | 'rls' | 'eltdt' | 'spare' | 'unknown';
const family = (p: string): Family => p.startsWith('USER_') ? 'user' : p.startsWith('STD_') ? 'standard' : p.startsWith('NAT_') ? 'national' : p === 'RLS' ? 'rls' : p === 'ELT_DT' ? 'eltdt' : p === 'SPARE' ? 'spare' : 'unknown';
const SERIAL_KIND = ['ELTs/SN', 'ELTs/AC op & SN', 'FF EPIRBs/SN', 'ELTs+AC 24-bit ad.', 'NFF EPIRBs/SN', 'Not Used', 'PLBs/SN'];
const EMERGENCY = ['Other', 'Fire', 'Flooding', 'Collision', 'Grounding', 'Capsizing', 'Sinking', 'Disabled', 'Abandoning'];
const BAUDOT = ' 5 9      4 8  3     6 /-2  71   T O HNM LRGIPCVEZDBSYFXAWJ UQK ';

export interface Beacon406 {
  /** The 18 bytes as received (36 hex digits, bits 1-144), after any correction. */
  hex: string;
  long: boolean; selfTest: boolean;
  /** 15-hex-digit beacon ID (bits 26-85, location bits defaulted as Cospas-Sarsat does). */
  id: string;
  protocol: string; protocolName: string; type: 'EPIRB' | 'ELT' | 'PLB' | 'TEST' | 'SHIP' | 'RLS' | 'ORB' | 'OTHER';
  country: number; countryName?: string;
  lat?: number; lon?: number;
  serial?: number; extra?: string; mmsi?: number;
  emergency?: string; mainNav?: 'internal' | 'external'; aux?: string;
  bch1Ok: boolean; bch2Ok: boolean | null; corrected: boolean;
}

const deg = (d: number, m: number, s: number, neg: boolean) => (neg ? -1 : 1) * (d + m / 60 + s / 3600);
/** Mayhem's Angle.apply_offset. */
function offset(d: number, m: number, s: number, positive: boolean, om: number, os: number): [number, number, number] {
  if (positive) return [d, m + om, s + os];
  m -= om; if (m < 0) { m += 60; d -= 1; }
  s -= os; if (s < 0) { s += 60; m -= 1; }
  return [d, m, s];
}

/** Read a frame (18 bytes: bits 1-144; a short frame's last four bytes unused). null when there is no frame sync. */
export function parse406(bytes: ArrayLike<number>, correct = true): Beacon406 | null {
  const f = Uint8Array.from({ length: 18 }, (_, i) => bytes[i] ?? 0);
  const sync = bits(f, 16, 24);
  if (sync !== 0b000101111 && sync !== 0b011010000) return null;
  const long = !!bits(f, 25, 25);
  let corrected = false;
  const b1 = bits(f, 86, 106); let ok1 = bch1(f) === b1;
  if (!ok1 && correct) for (let i = 25; i <= 85 && !ok1; i++) { flip(f, i); if (bch1(f) === b1) { ok1 = true; corrected = true; } else flip(f, i); }
  const pflag = bits(f, 26, 26), pcode = pflag ? bits(f, 37, 39) : bits(f, 37, 40);
  const hasB2 = long && !(pflag && pcode === 0);
  let ok2: boolean | null = null;
  if (hasB2) {
    const b2 = bits(f, 133, 144); ok2 = bch2(f) === b2;
    if (!ok2 && correct) for (let i = 107; i <= 132 && !ok2; i++) { flip(f, i); if (bch2(f) === b2) { ok2 = true; corrected = true; } else flip(f, i); }
  }
  const protocol = !long || pflag ? USER[pcode] ?? 'UNKNOWN' : LONG[pcode] ?? 'UNKNOWN';
  const fam = family(protocol);
  const country = bits(f, 27, 36);
  const out: Beacon406 = {
    hex: Array.from(f.subarray(0, long ? 18 : 14), x => x.toString(16).toUpperCase().padStart(2, '0')).join(''),
    long, selfTest: sync === 0b011010000, id: '', protocol, protocolName: PROTOCOL_NAMES[protocol], type: 'OTHER',
    country, countryName: mmsiInfo(country * 1_000_000).flag, bch1Ok: ok1, bch2Ok: ok2, corrected,
  };
  // the serial user protocol says what it is in its own field (ELT, EPIRB float-free or not, PLB)
  const serialKind = protocol === 'USER_SERIAL' ? bits(f, 40, 42) : -1;
  out.type = serialKind >= 0 ? ([0, 1, 3].includes(serialKind) ? 'ELT' : [2, 4].includes(serialKind) ? 'EPIRB' : serialKind === 6 ? 'PLB' : 'OTHER') : /EPIRB/.test(protocol) ? 'EPIRB' : /ELT/.test(protocol) ? 'ELT' : /PLB/.test(protocol) ? 'PLB' : /TEST/.test(protocol) ? 'TEST' : protocol === 'STD_SHIP' ? 'SHIP' : protocol === 'RLS' ? 'RLS' : protocol === 'USER_ORB' ? 'ORB' : 'OTHER';
  // location (long frames)
  if (long) {
    const B = (i: number) => f[i];
    let lat: [number, number, number, boolean] | null = null, lon: [number, number, number, boolean] | null = null;
    if (fam === 'user' && protocol !== 'USER_ORB') {
      lat = [((B(13) & 0x0F) << 3) | ((B(14) & 0xE0) >> 5), ((B(14) & 0x1E) >> 1) * 4, 0, !!((B(13) & 0x10) >> 4)];
      lon = [B(15), ((B(16) & 0xF0) >> 4) * 4, 0, !!(B(14) & 0x01)];
    } else if (fam === 'national') {
      const lo = offset(((B(7) & 0x1F) << 2) | ((B(8) & 0xC0) >> 6), ((B(8) & 0x3E) >> 1) * 2, 0, !!((B(14) & 0x80) >> 7), (B(14) & 0x60) >> 5, ((B(14) & 0x1E) >> 1) * 4);
      lat = [...lo, !!((B(7) & 0x20) >> 5)];
      const l2 = offset(B(9), ((B(10) & 0xF8) >> 3) * 2, 0, !!(B(14) & 0x01), (B(15) & 0xC0) >> 6, ((B(15) & 0x3C) >> 2) * 4);
      lon = [...l2, !!(B(8) & 0x01)];
    } else if (fam === 'standard') {
      const lo = offset(B(8) & 0x7F, ((B(9) & 0xC0) >> 6) * 15, 0, !!((B(14) & 0x80) >> 7), (B(14) & 0x7C) >> 2, (((B(14) & 0x03) << 2) | ((B(15) & 0xC0) >> 6)) * 4);
      lat = [...lo, !!((B(8) & 0x80) >> 7)];
      const l2 = offset(((B(9) & 0x1F) << 3) | ((B(10) & 0xE0) >> 5), ((B(10) & 0x18) >> 3) * 15, 0, !!((B(15) & 0x20) >> 5), B(15) & 0x1F, ((B(16) & 0xF0) >> 4) * 4);
      lon = [...l2, !!((B(9) & 0x20) >> 5)];
    } else if (fam === 'rls' || fam === 'eltdt') {
      const lo = offset(((B(8) & 0x1F) << 2) | ((B(9) & 0xC0) >> 6), ((B(9) & 0x20) >> 5) * 30, 0, !!((B(14) & 0x20) >> 5), (B(14) & 0x1E) >> 1, (((B(14) & 0x01) << 3) | ((B(15) & 0xE0) >> 5)) * 4);
      lat = [...lo, !!((B(8) & 0x20) >> 5)];
      const l2 = offset(((B(9) & 0x0F) << 4) | ((B(10) & 0xF0) >> 4), ((B(10) & 0x08) >> 3) * 30, 0, !!((B(15) & 0x10) >> 4), B(15) & 0x0F, ((B(16) & 0xF0) >> 4) * 4);
      lon = [...l2, !!((B(9) & 0x10) >> 4)];
    }
    // the protocols' "no position" defaults (all ones in the coarse fields) give degrees past 90 / 180
    if (lat && lon && lat[0] <= 90 && lon[0] <= 180) { out.lat = deg(lat[0], lat[1], lat[2], lat[3]); out.lon = deg(lon[0], lon[1], lon[2], lon[3]); }
  }
  // additional data
  if (pflag) {
    if (pcode === 0b011) {
      const k = bits(f, 40, 42);
      if (SERIAL_KIND[k] && k !== 5) out.extra = SERIAL_KIND[k];
      out.serial = k === 0b011 ? bits(f, 44, 67) : k === 0b001 ? bits(f, 62, 73) : bits(f, 44, 63);
    }
    if (!long && bits(f, 107, 107)) {
      const maritime = protocol === 'USER_EPIRB_MARITIME' || protocol === 'USER_EPIRB_RADIO' || (pcode === 0b011 && [0b100, 0b010].includes(bits(f, 40, 42)));
      if (maritime) { const e = bits(f, 109, 112); out.emergency = EMERGENCY[e >= 1 && e <= 8 ? e : 0]; }
      else out.emergency = [bits(f, 109, 109) ? 'Fire' : '', bits(f, 110, 110) ? 'Medical' : '', bits(f, 111, 111) ? 'Disabled' : ''].filter(Boolean).join(' + ') || 'Other';
      if (bits(f, 108, 108)) out.emergency += ' (automatic)';
    }
  } else if (long) {
    switch (pcode) {
      case 0b0010: out.serial = bits(f, 61, 64); break;
      case 0b1100: { const m = bits(f, 41, 60); out.mmsi = m; out.extra = `MMSI (last 6 digits) ${m}`; break; }
      case 0b0011: out.extra = `aircraft 24-bit address ${bits(f, 41, 64).toString(16).toUpperCase().padStart(6, '0')}`; break;
      case 0b0100: case 0b0110: case 0b0111: out.extra = `C/S type approval ${bits(f, 41, 50)}`; out.serial = bits(f, 51, 64); break;
      case 0b0101: out.extra = `operator ${BAUDOT[32 + bits(f, 41, 45)]}${BAUDOT[32 + bits(f, 46, 50)]}${BAUDOT[32 + bits(f, 51, 55)]}`.trimEnd(); out.serial = bits(f, 56, 64); break;
      case 0b1000: case 0b1010: case 0b1011: case 0b1111: out.serial = bits(f, 41, 58); out.extra = `national data ${bits(f, 127, 132)}`; break;
    }
  }
  // navigation devices
  if (fam === 'standard' || fam === 'national') { out.mainNav = bits(f, 111, 111) ? 'internal' : 'external'; out.aux = bits(f, 112, 112) ? '121.5 MHz homer' : 'no or other homer'; }
  else if (fam === 'user' || fam === 'rls') {
    out.mainNav = bits(f, 107, 107) ? 'internal' : 'external';
    if (fam === 'rls') out.aux = bits(f, 108, 108) ? '121.5 MHz homer' : 'no or other homer';
    else if (pcode !== 0b100) out.aux = ['no homer', '121.5 MHz homer', 'SART', 'other homer'][bits(f, 84, 85)];
  }
  // the beacon ID: bits 26-85 with the location bits set to their defaults
  let hi = bits(f, 26, 53), lo = bits(f, 54, 85);
  if (fam === 'standard') lo = ((lo & 0xFFE00000) | 0x000FFBFF) >>> 0;
  else if (fam === 'national') lo = ((lo & 0xF8000000) | 0x03F81FE0) >>> 0;
  else if (fam === 'rls' || fam === 'eltdt') lo = ((lo & 0xFFF80000) | 0x0003FDFF) >>> 0;
  out.id = hi.toString(16).toUpperCase().padStart(7, '0') + lo.toString(16).toUpperCase().padStart(8, '0');
  return out;
}

/** A frame passes when its BCH codes check (after at most one corrected bit each) and it is not an empty orbitography one. */
export const valid406 = (b: Beacon406) => b.bch1Ok && b.bch2Ok !== false;

/** Transmitter side (tests): bits 1-144 (or 112) from a hex frame. */
export function frameBits(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) { const v = parseInt(hex.slice(i, i + 2), 16); for (let k = 7; k >= 0; k--) out.push((v >> k) & 1); }
  return out;
}

const fmt = (v: number, p: string, n: string, w: number) => { const a = Math.abs(v), d = Math.floor(a + 1e-9), mm = (a - d) * 60, m = Math.floor(mm + 1e-9), s = Math.round((mm - m) * 60); return `${String(d).padStart(w, '0')}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"${v < 0 ? n : p}`; };
/** The message-log line. */
export function beaconLine(b: Beacon406): string {
  const bits: string[] = [b.selfTest ? 'SELF-TEST' : 'ALERT', b.type, b.id, b.countryName ?? `country ${b.country}`, b.protocolName];
  if (b.lat !== undefined) bits.push(`${fmt(b.lat, 'N', 'S', 2)} ${fmt(b.lon!, 'E', 'W', 3)}`);
  if (b.emergency) bits.push(b.emergency);
  if (b.extra) bits.push(b.extra);
  if (b.serial !== undefined) bits.push(`serial ${b.serial}`);
  if (b.corrected) bits.push('1 bit corrected');
  return `406 ${bits.join(' · ')}`;
}
