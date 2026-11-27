/**
 * FORK: ADS-L (EASA "ADS-L 4 SRD-860", Issue 2, 1 Dec 2025) packets, receive only: the network header, the XXTEA
 * scrambling with key 0, the CRC-24 (Mode-S polynomial), the ADS-L header (payload type, address table, address,
 * relay) and the Traffic and Status payloads, read field for field from the specification (written from the spec;
 * no code was ported). FLARM's own protocol is not read; a FLARM device that also sends ADS-L shows up here as
 * ADS-L. The secure signature, when present, is not checked, and FEC (Reed-Solomon) packets are skipped.
 *
 * Layout on the air (M-band): length byte, then the network packet: header byte (version 4 bits, signature flag,
 * key index 2 bits, error-control mode), the ADS-L data (5-byte ADS-L header + payload, scrambled), and the CRC-24
 * (big endian). Fields inside the ADS-L data are packed least significant bit first, bytes little endian (B.3).
 */

/** Bits [off, off+w) of a little-endian, LSB-first bit field (spec B.3). w ≤ 32. */
export function getBits(b: ArrayLike<number>, off: number, w: number): number {
  let v = 0;
  for (let i = 0; i < w; i++) { const k = off + i; if ((b[k >> 3] >> (k & 7)) & 1) v += 2 ** i; }
  return v;
}
export function setBits(b: Uint8Array, off: number, w: number, v: number): void {
  for (let i = 0; i < w; i++) {
    const k = off + i, bit = Math.floor(v / 2 ** i) & 1;
    if (bit) b[k >> 3] |= 1 << (k & 7); else b[k >> 3] &= ~(1 << (k & 7));
  }
}

/** The spec's crc24() (E.3.1): the Mode-S polynomial 0xFFF409, register zero, three zero bytes flushed through. */
export function crc24(data: ArrayLike<number>, len = data.length): number {
  const pass = (crc: number, input: number) => {
    crc = (crc | input) >>> 0;
    for (let bit = 0; bit < 8; bit++) { if (crc & 0x80000000) crc = (crc ^ 0xFFFA0480) >>> 0; crc = (crc << 1) >>> 0; }
    return crc;
  };
  let crc = 0;
  for (let i = 0; i < len; i++) crc = pass(crc, data[i]);
  crc = pass(pass(pass(crc, 0), 0), 0);
  return crc >>> 8;
}

const DELTA = 0x9e3779b9, ROUNDS = 6;
const mx = (z: number, y: number, sum: number) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (0 ^ z))) >>> 0;   // key 0
/** XXTEA with the all-zero key and 6 rounds (ADS-L; other counts for the standard test vectors), in place on 32-bit words (E.2). */
export function xxteaEncrypt(v: Uint32Array, rounds = ROUNDS): void {
  const n = v.length; let z = v[n - 1], y: number, sum = 0;
  for (let q = rounds; q > 0; q--) {
    sum = (sum + DELTA) >>> 0;
    for (let p = 0; p < n - 1; p++) { y = v[p + 1]; v[p] = (v[p] + mx(z, y, sum)) >>> 0; z = v[p]; }
    y = v[0]; v[n - 1] = (v[n - 1] + mx(z, y, sum)) >>> 0; z = v[n - 1];
  }
}
export function xxteaDecrypt(v: Uint32Array, rounds = ROUNDS): void {
  const n = v.length; let y = v[0], z: number, sum = Math.imul(rounds, DELTA) >>> 0;
  for (let q = rounds; q > 0; q--) {
    for (let p = n - 1; p > 0; p--) { z = v[p - 1]; v[p] = (v[p] - mx(z, y, sum)) >>> 0; y = v[p]; }
    z = v[n - 1]; v[0] = (v[0] - mx(z, y, sum)) >>> 0; y = v[0];
    sum = (sum - DELTA) >>> 0;
  }
}
/** Scramble or unscramble a byte block (a multiple of 4 bytes) as little-endian words. */
function xxteaBytes(b: Uint8Array, enc: boolean): void {
  const w = new Uint32Array(b.length >> 2);
  for (let i = 0; i < w.length; i++) w[i] = (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0;
  if (enc) xxteaEncrypt(w); else xxteaDecrypt(w);
  for (let i = 0; i < w.length; i++) { b[4 * i] = w[i] & 255; b[4 * i + 1] = w[i] >>> 8 & 255; b[4 * i + 2] = w[i] >>> 16 & 255; b[4 * i + 3] = w[i] >>> 24; }
}

/** Exponential encoding (G.1.6): value = 2^e·(2^N + base) − 2^N, with an optional sign bit above the exponent. */
export function expDecode(raw: number, n: number, signed: boolean): number {
  const base = raw & ((1 << n) - 1), e = (raw >> n) & 3, v = 2 ** e * (2 ** n + base) - 2 ** n;
  return signed && (raw >> (n + 2)) & 1 ? -v : v;
}
export function expEncode(value: number, n: number, signed: boolean): number {
  const neg = signed && value < 0; let a = Math.abs(Math.round(value));
  const max = 8 * (2 ** n + (2 ** n - 1)) - 2 ** n;
  a = Math.min(a, signed && !neg ? max : max - 8);   // the all-ones code is "invalid" (spec: 0x3ffe, 0xfe, 0x0ff, 0x1fe are the limits)
  let e = 0;
  for (let k = 3; k >= 0; k--) if (a >= 2 ** (n + k) - 2 ** n) { e = k; break; }
  const base = Math.floor((a - 2 ** (n + e) + 2 ** n) / 2 ** e);
  return (neg ? 1 << (n + 2) : 0) | e << n | base;
}

export const ADSL_TYPES: Record<number, string> = { 2: 'Traffic', 3: 'Status', 4: 'Traffic Uplink', 5: 'FIS-B Uplink', 6: 'Remote ID', 66: 'OGN Diagnostics' };
/** Address mapping table (F.2.2): who assigned the address. 9..63 are manufacturer pages. */
export function amtName(t: number): string {
  return t === 0 ? 'random' : t === 5 ? 'ICAO' : t === 6 ? 'FLARM' : t === 7 ? 'OGN' : t === 8 ? 'FANET' : t >= 9 ? `maker page ${t - 9}` : 'reserved';
}
export const ADSL_CATEGORY = ['unknown', 'light aircraft', 'heavy aircraft', 'helicopter', 'glider', 'balloon', 'ultralight', 'paraglider', 'parachutist', 'eVTOL', 'gyrocopter', 'drone (open)', 'drone (specific)', 'drone (certified)', 'model plane', 'heavy helicopter', 'hang glider', 'paramotor'];
export const ADSL_EMERGENCY = ['', '', 'GENERAL EMERGENCY', 'MEDICAL EMERGENCY', 'NO RADIO', 'UNLAWFUL INTERFERENCE', 'DOWNED AIRCRAFT', ''];
export const ADSL_STATE = ['', 'on ground', 'airborne', ''];

export interface AdslTraffic {
  /** Quarter seconds past the full hour, modulo 60 (0..59). */
  qs: number; state: number; category: number; emergency: number;
  lat?: number; lon?: number; altM?: number; speedMs?: number; climbMs?: number; trackDeg?: number;
  sil: number; sda: number; nic: number; nacp: number; gva: number; nacv: number;
}
export interface AdslStatus { maxVersion: number; mband: number; obandLdr: number; obandHdr: number; mobile: number; econRx: number; econTx: number; xpdr: number; uplink: boolean; fisb: boolean }
export interface AdslPacket {
  version: number; signed: boolean; keyIndex: number; fec: boolean; crcOk: boolean;
  type: number; amt: number; addr: number; relay: boolean;
  traffic?: AdslTraffic; status?: AdslStatus;
}

/**
 * Read a packet: `b` holds the bytes after the length byte (`len` of them: network header, ADS-L data, parity).
 * null when it cannot be an ADS-L packet (too short, CRC failed) or is an FEC packet (not read).
 */
export function parseAdsl(b: ArrayLike<number>, len = b.length): AdslPacket | null {
  if (len < 1 + 8 + 3) return null;
  const h = b[0], version = h & 15, signed = !!(h & 16), keyIndex = (h >> 5) & 3, fec = !!(h & 128);
  if (fec) return null;   // Reed-Solomon packets (uplinks, mostly on the O-band) are not checked here, so not trusted either
  const dataLen = len - 4;
  const crc = b[len - 3] << 16 | b[len - 2] << 8 | b[len - 1];
  if (crc24(b, len - 3) !== crc) return null;
  if (dataLen < 8 || dataLen % 4) return null;
  const d = new Uint8Array(dataLen);
  for (let i = 0; i < dataLen; i++) d[i] = b[1 + i];
  if (keyIndex === 0) xxteaBytes(d, false);
  else if (keyIndex !== 3) return { version, signed, keyIndex, fec, crcOk: true, type: -1, amt: 0, addr: 0, relay: false };   // reserved keys: not ours to read
  const p: AdslPacket = { version, signed, keyIndex, fec, crcOk: true, type: d[0], amt: getBits(d, 8, 6), addr: getBits(d, 14, 24), relay: !!getBits(d, 39, 1) };
  const P = 40;   // payload offsets are from the start of the payload (G.1)
  if (p.type === 2 && dataLen >= 20) {
    const lat = getBits(d, P + 16, 24), lon = getBits(d, P + 40, 24), gs = getBits(d, P + 64, 8), alt = getBits(d, P + 72, 14), vr = getBits(d, P + 86, 9), trk = getBits(d, P + 95, 9);
    const sx = (v: number) => v >= 0x800000 ? v - 0x1000000 : v;
    const t: AdslTraffic = {
      qs: getBits(d, P, 6), state: getBits(d, P + 6, 2), category: getBits(d, P + 8, 5), emergency: getBits(d, P + 13, 3),
      sil: getBits(d, P + 104, 2), sda: getBits(d, P + 106, 2), nic: getBits(d, P + 108, 4), nacp: getBits(d, P + 112, 3), gva: getBits(d, P + 115, 2), nacv: getBits(d, P + 117, 2),
    };
    if (lat !== 0x800000 && lon !== 0x800000) { t.lat = sx(lat) / 93206; t.lon = sx(lon) / 46603; }
    if (alt !== 0x3fff) t.altM = expDecode(alt, 12, false) - 320;
    if (gs !== 0xff) t.speedMs = expDecode(gs, 6, false) / 4;
    if (vr !== 0x1ff) t.climbMs = expDecode(vr, 6, true) / 8;
    if (t.speedMs) t.trackDeg = trk * 360 / 512;
    p.traffic = t;
  } else if (p.type === 3 && dataLen >= 12) {
    p.status = {
      maxVersion: getBits(d, P, 4), mband: getBits(d, P + 4, 2), obandLdr: getBits(d, P + 6, 2), obandHdr: getBits(d, P + 8, 2), mobile: getBits(d, P + 10, 2),
      econRx: getBits(d, P + 12, 8), econTx: getBits(d, P + 20, 8), xpdr: getBits(d, P + 28, 2), uplink: !!getBits(d, P + 30, 1), fisb: !!getBits(d, P + 31, 1),
    };
  }
  return p;
}

export interface AdslBuild {
  addr: number; amt?: number; relay?: boolean; version?: number; keyIndex?: number;
  traffic?: Partial<AdslTraffic>; status?: Partial<AdslStatus>;
}
/** A packet as a sender builds it (D.2): ADS-L data, scrambled, CRC appended, network header and length prepended. */
export function buildAdsl(o: AdslBuild): Uint8Array {
  const n = o.traffic ? 20 : 12, d = new Uint8Array(n);
  d[0] = o.traffic ? 2 : 3; setBits(d, 8, 6, o.amt ?? 6); setBits(d, 14, 24, o.addr); setBits(d, 39, 1, o.relay ? 1 : 0);
  const P = 40;
  if (o.traffic) {
    const t = o.traffic;
    setBits(d, P, 6, t.qs ?? 0); setBits(d, P + 6, 2, t.state ?? 2); setBits(d, P + 8, 5, t.category ?? 4); setBits(d, P + 13, 3, t.emergency ?? 1);
    const enc = (v: number, s: number) => Math.round(v * s) & 0xffffff;
    setBits(d, P + 16, 24, t.lat === undefined ? 0x800000 : enc(t.lat, 93206)); setBits(d, P + 40, 24, t.lon === undefined ? 0x800000 : enc(t.lon, 46603));
    setBits(d, P + 64, 8, t.speedMs === undefined ? 0xff : expEncode(t.speedMs * 4, 6, false));
    setBits(d, P + 72, 14, t.altM === undefined ? 0x3fff : expEncode(Math.max(0, t.altM + 320), 12, false));
    setBits(d, P + 86, 9, t.climbMs === undefined ? 0x1ff : expEncode(t.climbMs * 8, 6, true));
    setBits(d, P + 95, 9, Math.round((t.trackDeg ?? 0) * 512 / 360) & 511);
    setBits(d, P + 104, 2, t.sil ?? 0); setBits(d, P + 106, 2, t.sda ?? 0); setBits(d, P + 108, 4, t.nic ?? 0); setBits(d, P + 112, 3, t.nacp ?? 5); setBits(d, P + 115, 2, t.gva ?? 2); setBits(d, P + 117, 2, t.nacv ?? 2);
  } else {
    const s = o.status ?? {};
    setBits(d, P, 4, s.maxVersion ?? 1); setBits(d, P + 4, 2, s.mband ?? 3); setBits(d, P + 6, 2, s.obandLdr ?? 0); setBits(d, P + 8, 2, s.obandHdr ?? 0); setBits(d, P + 10, 2, s.mobile ?? 0);
    setBits(d, P + 12, 8, s.econRx ?? 0); setBits(d, P + 20, 8, s.econTx ?? 0); setBits(d, P + 28, 2, s.xpdr ?? 0); setBits(d, P + 30, 1, s.uplink ? 1 : 0); setBits(d, P + 31, 1, s.fisb ? 1 : 0);
  }
  const key = o.keyIndex ?? 0;
  if (key === 0) xxteaBytes(d, true);
  const out = new Uint8Array(1 + 1 + n + 3);
  out[0] = 1 + n + 3; out[1] = (o.version ?? 1) | key << 5; out.set(d, 2);
  const c = crc24(out.subarray(1, 2 + n));
  out[2 + n] = c >> 16; out[3 + n] = c >> 8 & 255; out[4 + n] = c & 255;
  return out;
}

const ECON = ['FLARM', 'PilotAware', 'FANET', 'OGN', 'ADS-B', 'UAT', 'Mode S'];
export function econList(bits: number): string { return ECON.filter((_, i) => bits >> i & 1).join(', '); }
const hex6 = (a: number) => a.toString(16).toUpperCase().padStart(6, '0');
/** The message-log line for a packet heard on `mhz`. */
export function adslLine(p: AdslPacket, mhz: number): string {
  const head = `ADSL ${mhz.toFixed(1)} ${amtName(p.amt)} ${hex6(p.addr)}${p.relay ? ' (relayed)' : ''}`;
  if (p.type < 0) return `${head} key ${p.keyIndex} (encrypted, not read)`;
  if (p.traffic) {
    const t = p.traffic, bits: string[] = [ADSL_CATEGORY[t.category] ?? `category ${t.category}`];
    if (ADSL_EMERGENCY[t.emergency]) bits.push(ADSL_EMERGENCY[t.emergency]);
    bits.push(t.lat !== undefined ? `${t.lat.toFixed(5)}, ${t.lon!.toFixed(5)}` : 'no fix');
    if (t.altM !== undefined) bits.push(`${Math.round(t.altM)} m`);
    if (t.speedMs !== undefined) bits.push(`${(t.speedMs * 3.6).toFixed(0)} km/h`);
    if (t.trackDeg !== undefined) bits.push(`${Math.round(t.trackDeg)}°`);
    if (t.climbMs !== undefined) bits.push(`${t.climbMs >= 0 ? '+' : ''}${t.climbMs.toFixed(1)} m/s`);
    if (ADSL_STATE[t.state]) bits.push(ADSL_STATE[t.state]);
    return `${head} · ${bits.join(' · ')}`;
  }
  if (p.status) {
    const s = p.status, tx = econList(s.econTx), rx = econList(s.econRx);
    return `${head} · status: protocol ≤ ${s.maxVersion}${tx ? ` · also sends ${tx}` : ''}${rx ? ` · hears ${rx}` : ''}${s.xpdr ? ` · ${s.xpdr === 2 ? 'Mode S' : 'Mode C'} transponder` : ''}`;
  }
  return `${head} · ${ADSL_TYPES[p.type] ?? `payload ${p.type}`}`;
}
