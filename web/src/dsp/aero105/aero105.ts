/**
 * FORK: the Aero 10.5 kbps channels as the Satcom app runs them: whichever carrier is tapped, the P channel (ground to
 * aircraft, continuous: oqpsk.ts into frame.ts) and the R/T channels (aircraft to ground, bursts: burst.ts) are both
 * listened for. Shaped like upstream's PskReceiver + AeroDecoder pair, so the Satcom processor can hold it in their
 * place: carrierHz, lock, lineDb, and stats for the screen; ACARS lines out. Receive only.
 */
import { OqpskRx } from './oqpsk.js';
import { Aero105Sync } from './frame.js';
import { BurstRx, RtReader } from './burst.js';

export class Aero105 {
  readonly rx = new OqpskRx();
  readonly sync = new Aero105Sync();
  readonly bursts = new BurstRx();
  readonly rt = new RtReader(this.sync.reader);
  private bitsIn = 0; private burstAt = -1e9; private burstHz = NaN; private calls = 0;
  constructor() {
    this.rx.onBits = (s, n) => { this.bitsIn += n; this.sync.push(s, n); };
    this.bursts.onPacket = (p, hz) => { this.rt.packet(p); this.burstAt = this.calls; this.burstHz = hz; };
  }
  set hz(v: number) { this.sync.reader.hz = v; }
  set onAcars(f: ((line: string, aes: number) => void) | null) { this.sync.reader.onAcars = f; }
  /** P-channel frames and units, plus the bursts: R and T packets, and the T packets' units. */
  get stats() { const s = this.sync.reader.stats, r = this.rt.stats; return { ...s, bursts: this.bursts.bursts, rPackets: r.rPackets, tPackets: r.tPackets, badBursts: this.bursts.bad }; }
  /** The P channel's carrier when it is locked, else the last burst's. */
  get carrierHz(): number { return this.pLocked || !Number.isFinite(this.burstHz) ? this.rx.carrierHz : this.burstHz; }
  get lineDb(): number { return this.rx.lineDb; }
  private get pLocked(): boolean { return this.bitsIn - this.sync.lastSync < 2 * 5250; }
  /** Locked: a P-channel UW in the last two frames, or a burst read lately (an R/T channel). */
  get lock(): number { return this.pLocked || this.calls - this.burstAt < 200 ? 1 : Math.min(this.rx.lock, 0.49); }
  reset(): void { this.rx.reset(); this.sync.reset(); this.bursts.reset(); this.bitsIn = 0; }
  onIq(iq: Int8Array, rate: number, offsetHz = 0): void { this.calls++; this.rx.onIq(iq, rate, offsetHz); this.bursts.onIq(iq, rate, offsetHz); }
}
