/**
 * FORK: MPT1327 as a Dispatch plug-in: the receiver (mpt1327.ts) on the channel's own 24 kS/s baseband (1200 bit/s FFSK
 * at ±2.5 kHz fits it), its messages as generic events. Group and individual addresses share one number space in MPT1327
 * (the system's fleet plan says which is which), so calls are shown by their IDENT, with PFIX/IDENT in the log.
 */
import { MptRx, mptLine, parseMpt, type MptMsg } from './mpt1327.js';
import { registerPlugin, type PlugEvent, type PlugRx } from './plugins.js';

/** MPT1327 messages → events. Exported for tests. */
export function mptEvents(m: MptMsg): PlugEvent[] {
  const text = mptLine(m);
  switch (m.kind) {
    case 'gtc': return m.data || m.chan === 0 ? [{ kind: 'note', name: 'GTC', text }]   // data calls carry no voice
      : [{ kind: 'call', call: { tg: m.ident1, group: true, src: m.ident2, lcn: m.chan, emergency: false, digital: false, encrypted: false, update: false }, text }];
    case 'clear': return [{ kind: 'end', lcn: m.chan, text }];
    case 'ack': case 'ahoy': return m.ident1 > 0 && m.ident1 <= 8100 ? [{ kind: 'unit', unit: m.ident1, text }] : [{ kind: 'note', name: m.kind.toUpperCase(), text }];
    default: return [{ kind: 'note', name: m.kind.toUpperCase(), text }];
  }
}

class MptPlugRx implements PlugRx {
  onEvents: (ev: PlugEvent[], hex: string) => void = () => undefined;
  private readonly rx: MptRx;
  constructor(fs: number) {
    this.rx = new MptRx(fs);
    this.rx.onCodeword = (w, sys) => {
      const ev: PlugEvent[] = [];
      // every codeword that carries the identity says so: Dispatch ignores a carrier's events until it has passed a
      // few good frames, so a one-off announcement could be lost (it only logs when something changes)
      if (sys !== null) {
        const id = sys.toString(16).toUpperCase().padStart(4, '0');
        ev.push({ kind: 'system', id: `SYS ${id}`, label: `MPT1327 · SYS ${id}` });
      }
      let hex = ''; for (let k = 0; k < 64; k += 4) hex += ((w[k] << 3) | (w[k + 1] << 2) | (w[k + 2] << 1) | w[k + 3]).toString(16);
      ev.push(...mptEvents(parseMpt(w)));
      this.onEvents(ev, hex);
    };
  }
  get good(): number { return this.rx.good; }
  get seen(): number { return this.rx.frames; }
  push(zi: Float32Array, zq: Float32Array, m: number): void { this.rx.push(zi, zq, m); }
}

registerPlugin({ proto: 'MPT1327', title: 'MPT1327', rx: fs => new MptPlugRx(fs), minGood: 3 });
