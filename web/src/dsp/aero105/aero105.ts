/**
 * FORK: the Aero 10.5 kbps P-channel as the Satcom app runs it: the OQPSK receiver (oqpsk.ts) into the frame sync and
 * signal-unit reader (frame.ts). Shaped like upstream's PskReceiver + AeroDecoder pair, so the Satcom processor can
 * hold it in their place: carrierHz, lock, lineDb, and stats for the screen; ACARS lines out. Receive only.
 */
import { OqpskRx } from './oqpsk.js';
import { Aero105Sync } from './frame.js';

export class Aero105 {
  readonly rx = new OqpskRx();
  readonly sync = new Aero105Sync();
  private bitsIn = 0;
  constructor() { this.rx.onBits = (s, n) => { this.bitsIn += n; this.sync.push(s, n); }; }
  set hz(v: number) { this.sync.reader.hz = v; }
  set onAcars(f: ((line: string, aes: number) => void) | null) { this.sync.reader.onAcars = f; }
  get stats() { return this.sync.reader.stats; }
  get carrierHz(): number { return this.rx.carrierHz; }
  get lineDb(): number { return this.rx.lineDb; }
  /** Locked: a unique word in the last two frames' worth of bits. */
  get lock(): number { return this.bitsIn - this.sync.lastSync < 2 * 5250 ? 1 : Math.min(this.rx.lock, 0.49); }
  reset(): void { this.rx.reset(); this.sync.reset(); this.bitsIn = 0; }
  onIq(iq: Int8Array, rate: number, offsetHz: number): void { this.rx.onIq(iq, rate, offsetHz); }
}
