/**
 * FORK: a BLE legacy-advertising transmitter for tests (Bluetooth Core Spec v5.x, Vol 6 Part B: preamble, access
 * address 0x8E89BED6, PDU, CRC-24 poly 0x00065B init 0x555555, data whitening x^7+x^4+1 seeded 0x40|channel).
 * Bits go out LSB first.
 */
import { bitsLsb } from './iq.js';

export const ADV_AA = 0x8E89BED6;

/** One AD structure: [len, type, ...data]. */
export function ad(type: number, data: ArrayLike<number>): number[] { return [data.length + 1, type, ...Array.from(data)]; }
export function adName(name: string): number[] { return ad(0x09, Array.from(name, c => c.charCodeAt(0))); }

/** An advertising PDU: header (type, TxAdd), length, AdvA (given MSB-first as on screen, sent reversed), AD data. */
export function advPdu(type: number, mac: string, adData: number[], randomAddr = true): number[] {
  const a = mac.split(':').map(h => parseInt(h, 16)).reverse();
  const payload = [...a, ...adData];
  return [(type & 0x0F) | (randomAddr ? 0x40 : 0), payload.length, ...payload];
}

/** The on-air bit stream for a PDU on an advertising channel: preamble, AA, whitened PDU + CRC. */
export function advBits(pdu: number[], channel: number): boolean[] {
  const aa = [ADV_AA & 0xFF, (ADV_AA >>> 8) & 0xFF, (ADV_AA >>> 16) & 0xFF, (ADV_AA >>> 24) & 0xFF];
  const pre = (aa[0] & 1) ? 0x55 : 0xAA;          // the preamble's last bit differs from the AA's first
  // CRC over PDU bits (LSB first); appending the register MSB first zeroes a receiver's identical register
  let crc = 0x555555;
  const pduBits = bitsLsb(pdu);
  for (const b of pduBits) { const fb = ((crc >> 23) & 1) ^ (b ? 1 : 0); crc = (crc << 1) & 0xFFFFFF; if (fb) crc ^= 0x00065B; }
  const crcBits: boolean[] = []; for (let k = 23; k >= 0; k--) crcBits.push(((crc >> k) & 1) === 1);
  let lfsr = 0x40 | channel;
  const white = [...pduBits, ...crcBits].map(b => {
    const o = lfsr & 1; lfsr = (lfsr >>> 1) | (o << 6); if (o) lfsr ^= 0x04;
    return b !== (o === 1);
  });
  return [...bitsLsb([pre]), ...bitsLsb(aa), ...white];
}
