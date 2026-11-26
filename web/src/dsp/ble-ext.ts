/**
 * FORK: BLE 5 extended advertising, receive only, as far as the primary advertising channels (37 / 38 / 39) carry it.
 * ADV_EXT_IND (PDU type 7) uses the Common Extended Advertising Payload Format (Bluetooth Core 5.x Vol 6 Part B 2.3.4):
 * a byte of extended header length (6 bits) and AdvMode (connectable, scannable), then a flags byte saying which fields
 * follow, in order: AdvA (6), TargetA (6), CTEInfo (1), ADI (2: data ID 12 bits, set ID 4 bits), AuxPtr (3: channel 0-39,
 * clock accuracy, offset units of 30 or 300 µs, a 13-bit offset, the PHY the auxiliary packet goes on), SyncInfo (18),
 * TxPower (1, signed), then ACAD to the end of the header; any AdvData after it. On the primary channels the advertising
 * data itself is usually on the auxiliary packet the AuxPtr points to, on a data channel this receiver does not follow.
 * Written from the specification; no code used.
 */

export const PHY_NAMES = ['1M', '2M', 'Coded'] as const;

export interface AuxPtr { channel: number; offsetUs: number; phy: string; ca: 'up to 50 ppm' | 'up to 500 ppm' }
export interface ExtHeader {
  advMode: 'non-connectable' | 'connectable' | 'scannable' | 'reserved';
  advA?: string; advARandom?: boolean; targetA?: string;
  adi?: { did: number; sid: number };
  aux?: AuxPtr;
  sync?: boolean; txPower?: number;
  /** The advertising data after the header (AD structures), when any. */
  adData: number[];
}

const mac = (p: number[], at: number) => [5, 4, 3, 2, 1, 0].map(i => p[at + i].toString(16).padStart(2, '0').toUpperCase()).join(':');

/** The extended header of an ADV_EXT_IND PDU (header byte, length byte, payload), or null if it does not fit. */
export function parseExtHeader(pdu: ArrayLike<number>): ExtHeader | null {
  const p = Array.from(pdu, v => v & 0xff);
  if (p.length < 3 || (p[0] & 0x0f) !== 7) return null;
  const len = Math.min(p[1], p.length - 2), end = 2 + len;
  if (len < 1) return null;
  const hlen = p[2] & 0x3f, mode = p[2] >> 6;
  if (3 + hlen > end) return null;
  const h: ExtHeader = { advMode: (['non-connectable', 'connectable', 'scannable', 'reserved'] as const)[mode], adData: p.slice(3 + hlen, end) };
  if (hlen === 0) return h;
  const flags = p[3], hEnd = 3 + hlen;
  let q = 4;
  const take = (n: number) => { const at = q; q += n; return q <= hEnd ? at : -1; };
  if (flags & 0x01) { const a = take(6); if (a < 0) return null; h.advA = mac(p, a); h.advARandom = (p[0] & 0x40) !== 0; }
  if (flags & 0x02) { const a = take(6); if (a < 0) return null; h.targetA = mac(p, a); }
  if (flags & 0x04) { if (take(1) < 0) return null; }
  if (flags & 0x08) { const a = take(2); if (a < 0) return null; const v = p[a] | (p[a + 1] << 8); h.adi = { did: v & 0xfff, sid: v >> 12 }; }
  if (flags & 0x10) {
    const a = take(3); if (a < 0) return null;
    const v = p[a + 1] | (p[a + 2] << 8), units = (p[a] >> 7) & 1, phy = v >> 13;
    h.aux = { channel: p[a] & 0x3f, ca: (p[a] >> 6) & 1 ? 'up to 50 ppm' : 'up to 500 ppm', offsetUs: (v & 0x1fff) * (units ? 300 : 30), phy: PHY_NAMES[phy] ?? `PHY ${phy}` };
  }
  if (flags & 0x20) { if (take(18) < 0) return null; h.sync = true; }
  if (flags & 0x40) { const a = take(1); if (a < 0) return null; h.txPower = (p[a] << 24) >> 24; }
  return h;
}

/** One line for the packet log. */
export function extLine(h: ExtHeader): string {
  return [h.advA ? `${h.advA} ${h.advARandom ? 'rnd' : 'pub'}` : 'anonymous', h.advMode,
    h.adi ? `set ${h.adi.sid} data ${h.adi.did}` : '', h.aux ? `aux ch ${h.aux.channel} ${h.aux.phy} +${h.aux.offsetUs} µs` : '',
    h.sync ? 'periodic' : '', h.txPower !== undefined ? `tx ${h.txPower}dBm` : ''].filter(Boolean).join(' · ');
}

/** The test transmitter's ADV_EXT_IND: fields as given, in the specification's order. */
export function extAdvPdu(f: { advA?: string; random?: boolean; mode?: number; adi?: { did: number; sid: number }; aux?: { channel: number; units300?: boolean; offset: number; phy: number }; txPower?: number; adData?: number[] }): number[] {
  const hdr: number[] = []; let flags = 0;
  if (f.advA) { flags |= 0x01; hdr.push(...f.advA.split(':').map(x => parseInt(x, 16)).reverse()); }
  if (f.adi) { flags |= 0x08; const v = (f.adi.sid << 12) | f.adi.did; hdr.push(v & 255, v >> 8); }
  if (f.aux) { flags |= 0x10; const v = (f.aux.phy << 13) | f.aux.offset; hdr.push(f.aux.channel | (f.aux.units300 ? 0x80 : 0), v & 255, v >> 8); }
  if (f.txPower !== undefined) { flags |= 0x40; hdr.push(f.txPower & 255); }
  const ext = flags ? [flags, ...hdr] : [];
  const payload = [((f.mode ?? 0) << 6) | ext.length, ...ext, ...(f.adData ?? [])];
  return [7 | (f.random ?? true ? 0x40 : 0), payload.length, ...payload];
}
