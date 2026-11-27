/**
 * FORK: the Beacons app's 406 MHz decoder: bursts from every channel of 406.0–406.1 MHz (phy.ts), their 24 sync bits
 * checked (15 ones, then the normal or self-test frame sync; two wrong allowed), the frame read (frame.ts) and kept
 * when its BCH codes check. Receive only.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { Beacon406Rx, B406_CENTRE_HZ } from './phy.js';
import { beaconLine, parse406, valid406 } from './frame.js';

const NORMAL = '111111111111111000101111', TEST = '111111111111111011010000';

/** Bits as received → the frame's 18 bytes (sync bits put right), or null when the sync does not match. */
export function framesFromBits(bits: number[]): Uint8Array | null {
  if (bits.length < 112) return null;
  const head = bits.slice(0, 24).join('');
  const diff = (p: string) => { let d = 0; for (let i = 0; i < 24; i++) if (head[i] !== p[i]) d++; return d; };
  const dn = diff(NORMAL), dt = diff(TEST), sync = dn <= dt ? NORMAL : TEST;
  if (Math.min(dn, dt) > 2) return null;
  const all = [...sync].map(Number).concat(bits.slice(24)), n = all[24] ? 144 : 112;
  if (all.length < n) return null;
  const out = new Uint8Array(18);
  for (let i = 0; i < n; i++) if (all[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

export class Beacon406Decoder implements IqProcessor {
  centerHz = B406_CENTRE_HZ;
  private readonly rx = new Beacon406Rx();
  frames = 0; bad = 0; private lastHex = ''; private lastAt = -1e9;
  constructor(private readonly emit: Emit) {
    this.rx.onBurst = b => {
      const f = framesFromBits(b.bits), p = f ? parse406(f) : null;
      if (!p || !valid406(p)) { this.bad++; return; }
      // the same frame twice from one burst (a second look at it) is reported once; a beacon repeats every ~50 s
      if (p.hex === this.lastHex && Math.abs(b.t - this.lastAt) < 0.5) return;
      this.lastHex = p.hex; this.lastAt = b.t;
      this.frames++;
      this.emit({ type: 'packet', line: beaconLine(p) });
      this.emit({ type: 'beacon406', b: p, hz: B406_CENTRE_HZ + b.carrierHz, levelDb: b.levelDb });
    };
  }
  reset(_rate: number): void { this.rx.reset(); }
  onIq(iq: Int8Array, rate: number): void { this.rx.onIq(iq, rate, B406_CENTRE_HZ - this.centerHz); }
}

import { HomingDetector, HOMING_HZ, type HomingState } from './homing.js';
/** The Beacons app's 121.5 MHz processor: the homing detector, its state to the page. */
export class HomingProcessor implements IqProcessor {
  centerHz = HOMING_HZ;
  private readonly det = new HomingDetector();
  constructor(private readonly emit: Emit) {
    this.det.onState = (s: HomingState) => {
      this.emit({ type: 'homing', s });
      if (s.on) this.emit({ type: 'log', line: `121.5 MHz homer: sweep ${s.sweepHz[0]}→${s.sweepHz[1]} Hz, ${s.perS}/s, ${s.snrDb.toFixed(0)} dB` });
    };
  }
  reset(_rate: number): void { this.det.reset(); }
  onIq(iq: Int8Array, rate: number): void { this.det.onIq(iq, rate, HOMING_HZ - this.centerHz); }
}
