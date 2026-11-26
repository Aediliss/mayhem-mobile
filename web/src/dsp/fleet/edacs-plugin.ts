/**
 * FORK: EDACS as a Dispatch plug-in: the receiver (edacs.ts) on its own 25 kHz down-converter, its messages as generic
 * events. Standard and networked EDACS at 9600 bd; ProVoice calls are reported as digital and never voiced.
 */
import { EdacsRx, edacsLine, parseEdacs, type EdacsMsg } from './edacs.js';
import { registerPlugin, type PlugEvent, type PlugRx } from './plugins.js';

/** EDACS messages → events. Exported for tests. */
export function edacsEvents(m: EdacsMsg): PlugEvent[] {
  const text = edacsLine(m);
  switch (m.kind) {
    case 'site': return [{ kind: 'system', id: `site ${m.siteId}`, label: `EDACS · SITE ${m.siteId}`, ccLcn: m.ccLcn }, { kind: 'note', name: 'SITE ID', text }];
    case 'group': return m.lcn >= 1 && m.lcn < 26 ? [{ kind: 'call', call: { tg: m.group, group: true, src: m.lid, lcn: m.lcn, emergency: m.emergency, digital: m.digital, encrypted: false, update: false }, text }] : [{ kind: 'note', name: 'GROUP CALL', text }];
    case 'update': return m.test || m.lcn < 1 || m.lcn >= 26 ? [{ kind: 'note', name: 'UPDATE', text }]
      : [{ kind: 'call', call: { tg: m.target, group: !m.individual, src: m.source, lcn: m.lcn, emergency: m.emergency, digital: m.digital, encrypted: false, update: true }, text }];
    case 'individual': return m.test || m.lcn < 1 || m.lcn >= 26 ? [{ kind: 'note', name: 'INDIVIDUAL CALL', text }]
      : [{ kind: 'call', call: { tg: m.target, group: false, src: m.source, lcn: m.lcn, emergency: false, digital: m.digital, encrypted: false, update: false }, text }];
    case 'unkey': return [{ kind: 'end', lcn: m.lcn, text }];
    case 'login': return [{ kind: 'unit', unit: m.lid, group: m.group, text }];
    case 'status': return [{ kind: 'unit', unit: m.lid, text }];
    default: return [{ kind: 'note', name: m.kind.toUpperCase(), text }];
  }
}

class EdacsPlugRx implements PlugRx {
  onEvents: (ev: PlugEvent[], hex: string) => void = () => undefined;
  private readonly rx: EdacsRx;
  constructor(fs: number) {
    this.rx = new EdacsRx(fs, 9600);
    this.rx.onFrame = (m1, m2) => {
      if (m1 === null || m2 === null) return;
      const hex = `${m1.toString(16).padStart(7, '0')} ${m2.toString(16).padStart(7, '0')}`;
      this.onEvents(edacsEvents(parseEdacs(m1, m2)), hex);
    };
  }
  get good(): number { return this.rx.good / 2; }
  get seen(): number { return this.rx.frames; }
  push(zi: Float32Array, zq: Float32Array, m: number): void { this.rx.push(zi, zq, m); }
}

registerPlugin({ proto: 'EDACS', title: 'EDACS', ddc: { cutoffHz: 10_000, rate: 48_000 }, rx: fs => new EdacsPlugRx(fs), minGood: 3 });
