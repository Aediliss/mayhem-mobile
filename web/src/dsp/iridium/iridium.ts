/**
 * FORK: the Iridium app's decoder: every burst in the span (phy.ts) read as a frame (frames.ts); satellites, beams and
 * Iridium time sent to the page as they come, IDA fragments put back together into SBD messages and their ACARS (as
 * message lines), counts of every frame kind once a second. Receive only; voice, IP and pager messages are counted, not
 * read. No DOM.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { IridiumRx } from './phy.js';
import { IdaReassembler, parseIridium, type IridiumKind } from './frames.js';

export { IRIDIUM_SPANS } from './frames.js';

export class IridiumDecoder implements IqProcessor {
  centerHz = 0;
  private key = ''; private rx: IridiumRx | null = null;
  private readonly ida = new IdaReassembler();
  private counts: Partial<Record<IridiumKind | 'unknown', number>> = {}; private lastStats = 0; private t0 = 0;
  constructor(private readonly emit: Emit) {
    this.ida.onAcars = a => {
      const head = `IRDM ${(a.freqHz / 1e6).toFixed(3)} ${a.down ? '↑' : '↓'} ${a.reg}  ${a.label}  blk ${a.blk}  ack NAK${a.msn ? `  #${a.msn} ${a.flight}` : ''}${a.crcOk ? '' : '  CRC?'}`;
      // on Iridium "down" is towards the aircraft: the message arrows read as ACARS's (↓ from the aircraft)
      this.emit({ type: 'packet', line: a.text ? `${head}\n${a.text}` : head });
    };
  }
  reset(_rate: number): void { this.key = ''; this.rx = null; this.counts = {}; this.lastStats = 0; }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${rate}`;
    if (key !== this.key || !this.rx) {
      this.key = key; this.rx = new IridiumRx(rate, this.centerHz);
      this.rx.onBurst = b => {
        const f = parseIridium(b.bits, b.freqHz, b.down, b.ms);
        const k = f?.kind ?? 'unknown'; this.counts[k] = (this.counts[k] ?? 0) + 1;
        if (!f) return;
        if (f.kind === 'IDA') this.ida.add(f);
        if (f.kind === 'IRA' || (f.kind === 'IBC' && f.sat !== undefined)) this.emit({ type: 'iridiumFrame', f: { ...f, levelDb: b.levelDb, confidence: b.confidence } });
      };
      this.emit({ type: 'log', line: `Iridium: listening ${((this.centerHz - rate / 2) / 1e6).toFixed(3)}–${((this.centerHz + rate / 2) / 1e6).toFixed(3)} MHz` });
    }
    this.rx.push(iq);
    const now = this.rx ? this.t0++ : 0;
    if (now - this.lastStats >= Math.max(1, Math.round(rate / (iq.length / 2)))) {
      this.lastStats = now;
      this.emit({ type: 'iridiumStats', counts: { ...this.counts }, detected: this.rx.detected, demodulated: this.rx.demodulated });
    }
  }
}
