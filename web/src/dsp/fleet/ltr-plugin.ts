/**
 * FORK: LTR Standard and LTR Passport as one Dispatch plug-in. Neither has a control channel: each repeater sends its
 * data under its own voice, so every repeater Dispatch hears becomes a site of its own, and the voice is followed on
 * that same carrier. Which repeater (LCN) a carrier is comes from the data: a busy repeater names itself as the channel
 * of the call it carries, so the channel it names most is its own. A plan (Settings → TRUNKING PLANS, the site's
 * frequencies in LCN order) is proved when that LCN sits on the carrier's frequency; it then names the system and gives
 * the frequencies of the other repeaters' calls.
 *
 * LTR Standard sends no system identity at all: without a plan each repeater is listed by its frequency. Passport sends a
 * site number, which names the system. LTR Standard sends no unit identities: calls are listed by group (A-HH-GGG,
 * written A·100000 + HH·1000 + GGG).
 */
import { LtrRx, ltrLine, ltrTg, ltrTgText, type LtrMsg } from './ltr.js';
import { registerPlugin, type PlugEvent, type PlugRx } from './plugins.js';

class LtrPlugRx implements PlugRx {
  onEvents: (ev: PlugEvent[], hex: string) => void = () => undefined;
  private readonly rx: LtrRx;
  /** How often each channel was named as a call's channel, decaying: the leader is this repeater's own LCN. */
  private readonly named = new Map<number, number>();
  private own = -1;
  /** Calls already announced (`lcn:tg` → word count when last heard), so repeats are updates, not new grants. */
  private readonly live = new Map<string, number>(); private words = 0;

  constructor(fs: number) {
    this.rx = new LtrRx(fs);
    this.rx.onWord = (m, w) => {
      let hex = ''; for (let k = 0; k + 4 <= w.length; k += 4) hex += ((w[k] << 3) | (w[k + 1] << 2) | (w[k + 2] << 1) | w[k + 3]).toString(16);
      this.onEvents(this.events(m), hex);
    };
  }
  get good(): number { return this.rx.good; }
  get seen(): number { return this.rx.frames; }
  push(zi: Float32Array, zq: Float32Array, m: number): void { this.rx.push(zi, zq, m); }

  /** A word → events. Public for tests. */
  events(m: LtrMsg): PlugEvent[] {
    this.words++;
    const text = ltrLine(m), ev: PlugEvent[] = [];
    const callLcn = m.kind === 'call' ? (m.std === 'ltr' ? m.chan : m.lcn) : -1;
    if (callLcn > 0) this.name(callLcn);
    if (m.std === 'ltr') ev.push({ kind: 'system', id: 'LTR', label: 'LTR', ccLcn: this.own > 0 ? this.own : undefined, planned: true, site: this.own > 0 ? `REPEATER ${this.own}` : undefined });
    else if (m.kind !== 'unit' && m.kind !== 'register') ev.push({ kind: 'system', id: `SITE ${m.site}`, label: `LTR PASSPORT · SITE ${m.site}`, ccLcn: this.own > 0 ? this.own : undefined, site: this.own > 0 ? `LCN ${this.own}` : undefined });
    switch (m.kind) {
      case 'call': {
        const tg = m.std === 'ltr' ? ltrTg(m) : m.group, key = `${callLcn}:${tg}`, last = this.live.get(key);
        this.live.set(key, this.words);
        if (this.live.size > 64) for (const [k, n] of this.live) if (this.words - n > 40) this.live.delete(k);
        ev.push({ kind: 'call', call: { tg, group: true, src: 0, lcn: callLcn, emergency: false, digital: false, encrypted: false, update: last !== undefined && this.words - last < 40 }, text });
        break;
      }
      case 'end': {
        // the repeater sending it is the one whose call is over
        const tg = m.std === 'ltr' ? ltrTg(m) : m.group;
        for (const k of [...this.live.keys()]) if (k.endsWith(`:${tg}`)) this.live.delete(k);
        ev.push({ kind: 'end', lcn: this.own, text: m.std === 'ltr' ? `CALL END ${ltrTgText(m)}${this.own > 0 ? ` · REPEATER ${this.own}` : ''}` : text });
        break;
      }
      case 'unit': ev.push({ kind: 'unit', unit: m.std === 'passport' ? m.radio : 0, text }); break;
      default: ev.push({ kind: 'note', name: m.kind.toUpperCase(), text });
    }
    return ev;
  }

  /** Counts a call's channel; the leader, once it has been named a few times and most of the time, is this repeater. */
  private name(lcn: number): void {
    let sum = 0;
    for (const [k, v] of this.named) { const d = v * 0.9; this.named.set(k, d); sum += d; }
    const v = (this.named.get(lcn) ?? 0) + 1; this.named.set(lcn, v); sum += 1;
    let best = -1, bv = 0; for (const [k, x] of this.named) if (x > bv) { bv = x; best = k; }
    if (bv >= 2.5 && bv >= 0.6 * sum) this.own = best;
  }
}

/** Exported for tests: a receiver whose words can be fed directly. */
export const ltrPlugRx = (fs: number) => new LtrPlugRx(fs);

registerPlugin({ proto: 'LTR', title: 'LTR', rx: fs => new LtrPlugRx(fs), minGood: 4 });
