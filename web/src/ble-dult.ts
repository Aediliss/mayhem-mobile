/**
 * FORK: whether a tracker says it is with its owner, for the unwanted-tracking alert. A tracker travelling with its owner
 * nearby is not following you; the IETF DULT work (draft-ietf-dult-accessory-protocol-01, Apple and Google) has the
 * accessory say which state it is in, and only a separated one is a concern. Read here:
 *
 *  · DULT: service data 0xFCB2, a Network ID byte, then the near-owner bit (the least significant bit of the next byte:
 *    1 near-owner mode, 0 separated mode). A separated accessory changes its address only every 24 hours (every 15
 *    minutes near its owner), so one address follows it for the whole of an encounter.
 *  · Apple Find My (Continuity type 0x12): the long payload (length 0x19 and up, the full key) is sent when away from
 *    its owner, the short one when near (as the card already said).
 *  · Google Find Hub (Eddystone service data, frame 0x41): unwanted-tracking protection is on, which the network turns
 *    on when the tracker is away from its owner; frame 0x40 does not say.
 * Anything else (Tile, SmartTag and the rest) does not say, and is judged by time and distance as before. No DOM.
 */
import type { BleAdv } from './ble.js';

export type OwnerState = 'near owner' | 'separated' | 'not stated';
export const DULT_UUID = 0xfcb2;

export function ownerState(a: BleAdv): { state: OwnerState; how: string; network?: number } {
  const d = a.svc.find(s => s.uuid === DULT_UUID);
  if (d && d.data.length >= 2) return { state: d.data[1] & 1 ? 'near owner' : 'separated', how: 'DULT near-owner bit', network: d.data[0] };
  if (a.mfr === 0x004c && a.mfrData[0] === 0x12 && a.mfrData.length >= 2) return { state: a.mfrData[1] >= 0x19 ? 'separated' : 'near owner', how: 'Find My payload length' };
  const fh = a.svc.find(s => s.uuid === 0xfeaa && s.data[0] === 0x41);
  if (fh) return { state: 'separated', how: 'Find Hub unwanted-tracking protection on' };
  return { state: 'not stated', how: '' };
}
