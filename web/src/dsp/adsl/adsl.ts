/**
 * FORK: the Gliders app's decoder: ADS-L on both M-band channels (868.2 and 868.4 MHz) at once, from one 2 MS/s span
 * centred between them. Every packet whose CRC-24 checks is unscrambled and read (frame.ts); aircraft go to the page as
 * `adsl` messages and to the message log as "ADSL …" lines; OGN tracker packets are counted. Receive only. No DOM.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { AdslRx } from './phy.js';
import { adslLine, parseAdsl } from './frame.js';

export const ADSL_CENTRE_HZ = 868_300_000;
export const ADSL_RATE = 2_000_000;
export const ADSL_CHANNELS = [868_200_000, 868_400_000];

export class AdslDecoder implements IqProcessor {
  centerHz = ADSL_CENTRE_HZ;
  private key = ''; private rx: AdslRx[] = [];
  private packets = 0; private ogn = 0; private calls = 0; private lastStats = 0;
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; this.rx = []; this.packets = 0; this.ogn = 0; this.calls = 0; this.lastStats = 0; }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${rate}`;
    if (key !== this.key) {
      this.key = key;
      this.rx = ADSL_CHANNELS.filter(f => Math.abs(f - this.centerHz) + 120_000 < rate / 2).map(f => {
        const r = new AdslRx(rate, f - this.centerHz), mhz = f / 1e6;
        r.accept = b => {
          const p = parseAdsl(b.bytes);
          if (!p) return false;
          this.packets++;
          this.emit({ type: 'packet', line: adslLine(p, mhz) });
          this.emit({ type: 'adsl', p, mhz, levelDb: b.levelDb, offsetHz: b.offsetHz });
          return true;
        };
        r.onOgn = () => { this.ogn++; };
        return r;
      });
      this.emit({ type: 'log', line: this.rx.length ? `ADS-L: listening on ${this.rx.length === 2 ? '868.2 and 868.4' : '1 channel of 2'} MHz` : 'ADS-L: 868.2/868.4 MHz are not in this span' });
    }
    for (const r of this.rx) r.push(iq);
    this.calls++;
    if (this.calls - this.lastStats >= Math.max(1, Math.round(rate / (iq.length / 2)))) {
      this.lastStats = this.calls;
      this.emit({ type: 'adslStats', packets: this.packets, ogn: this.ogn });
    }
  }
}
