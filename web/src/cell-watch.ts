/**
 * FORK: rogue-cell heuristics over what the Cell app already decodes (identity and broadcast metadata only: nothing
 * here reads a phone's traffic). Our own rules, after the ideas published by SeaGlass (Ney et al., PETS 2017) and EFF's
 * Crocodile Hunter (Quintin et al., 2020): a fake base station ("IMSI catcher", "Stingray") has to look like the real
 * network and pull phones to itself, and that leaves marks in its broadcasts. Each finding is a reason to look closer,
 * not proof; real networks trip some of them (a new cell, a test cell, an odd configuration).
 *
 *  - TEST PLMN: MCC 001 or 999 (test and private networks; what lab kits and many catchers default to).
 *  - UNKNOWN OPERATOR: a PLMN not in the operator list.
 *  - IDENTITY CHANGED: the same frequency and PCI now broadcasting another cell identity, TAC or PLMN.
 *  - DUPLICATE IDENTITY: two cells (different frequency or PCI) broadcasting the same PLMN and cell identity.
 *  - LONE TAC: a TAC no other cell of the same operator uses, when the others agree on theirs (a new tracking area
 *    makes phones that move in do a tracking area update: what a catcher wants).
 *  - BAIT RESELECTION: the top reselection priority (7) while the operator's other cells use lower, or the lowest
 *    q-RxLevMin (−140 dBm), or q-Hyst 0 with priority 7: settings that make phones move to it and stay.
 *  - NO NEIGHBOURS: no neighbour list (no SIB4 / SIB5 scheduled) while the operator's other cells send them (a catcher
 *    does not want phones to leave).
 *  - IMSI PAGING: pages by IMSI (real networks page by S-TMSI and use the IMSI rarely).
 *  - CLOCK OFF: the time the cell broadcasts (SIB8 / SIB16) more than a minute from this device's clock.
 *  - LOUD: 20 dB or more above every other cell of the same operator heard on the band.
 */
import type { CellRow } from './dsp/cell/cell.js';
import type { PagingSnap } from './dsp/cell/paging.js';

export type WatchLevel = 'warn' | 'info';
export interface WatchFinding { key: string; code: string; level: WatchLevel; text: string; firstMs: number; lastMs: number }

const plmnsOf = (c: CellRow) => (c.summary?.plmns ?? []).map(p => p.id);
const mainPlmn = (c: CellRow) => plmnsOf(c)[0] ?? '';
const label = (c: CellRow) => `${(c.hz / 1e6).toFixed(1)} MHz PCI ${c.pci}`;

export class CellWatch {
  /** Each frequency + PCI's identity as first heard. */
  private readonly ident = new Map<string, { cellIdentity: number; tac: number; plmn: string; ms: number }>();
  private readonly found = new Map<string, WatchFinding>();

  /** A new snapshot: [cells], [paging], at [now]. Returns every finding, warnings first, newest first. */
  update(cells: CellRow[], paging: PagingSnap | null | undefined, now = Date.now()): WatchFinding[] {
    const hit = (c: CellRow, code: string, level: WatchLevel, text: string) => {
      const id = `${c.key}|${code}`, f = this.found.get(id);
      if (f) { f.lastMs = now; f.text = text; } else this.found.set(id, { key: c.key, code, level, text, firstMs: now, lastMs: now });
    };
    const withSib1 = cells.filter(c => c.summary);
    for (const c of withSib1) {
      const s = c.summary!, plmn = mainPlmn(c), mcc = plmn.split('-')[0];
      const others = withSib1.filter(o => o !== c && mainPlmn(o) === plmn);
      if (mcc === '001' || mcc === '999') hit(c, 'TEST PLMN', 'warn', `PLMN ${plmn}: a test / private network code (lab kits and many fake cells use it)`);
      else if (s.plmns.length && s.plmns.every(p => !p.name)) hit(c, 'UNKNOWN OPERATOR', 'info', `PLMN ${plmns(c)} is not in the operator list`);
      // the same frequency and PCI, now another identity
      const k = `${c.hz}|${c.pci}`, was = this.ident.get(k);
      if (!was) this.ident.set(k, { cellIdentity: s.cellIdentity, tac: s.tac, plmn, ms: now });
      else if (was.cellIdentity !== s.cellIdentity || was.tac !== s.tac || was.plmn !== plmn)
        hit(c, 'IDENTITY CHANGED', 'warn', `${label(c)} was cell ${was.cellIdentity} TAC ${was.tac} (${was.plmn}), now cell ${s.cellIdentity} TAC ${s.tac} (${plmn})`);
      // the same global identity elsewhere
      const twin = withSib1.find(o => o !== c && mainPlmn(o) === plmn && o.summary!.cellIdentity === s.cellIdentity && (o.hz !== c.hz || o.pci !== c.pci));
      if (twin && s.cellIdentity > 0) hit(c, 'DUPLICATE IDENTITY', 'warn', `cell ${s.cellIdentity} (${plmn}) also broadcast by ${label(twin)}`);
      // a tracking area of its own
      if (others.length >= 2) {
        const tacs = new Set(others.map(o => o.summary!.tac));
        if (!tacs.has(s.tac) && tacs.size === 1) hit(c, 'LONE TAC', 'warn', `TAC ${s.tac}, while the operator's ${others.length} other cells here use TAC ${[...tacs][0]}`);
      }
      // reselection bait
      if (c.sib3) {
        const pri = c.sib3.priority, otherPri = others.map(o => o.sib3?.priority).filter((p): p is number => typeof p === 'number' && !Number.isNaN(p));
        if (pri === 7 && otherPri.length && Math.max(...otherPri) < 7) hit(c, 'BAIT RESELECTION', 'warn', `reselection priority 7 (the highest) while the operator's other cells use ${Math.max(...otherPri)} or less`);
        else if (pri === 7 && /dB0$/.test(c.sib3.qHyst)) hit(c, 'BAIT RESELECTION', 'warn', 'reselection priority 7 with q-Hyst 0 dB: phones move to it and stay');
      }
      const qmin = c.sib3?.qRxLevMinDbm ?? s.qRxLevMinDbm;
      if (qmin !== null && qmin !== undefined && qmin <= -140) hit(c, 'BAIT RESELECTION', 'warn', `q-RxLevMin ${qmin} dBm (the lowest allowed): phones camp on it however weak`);
      // no neighbours while the others send them
      const hasNbr = (x: CellRow) => x.summary!.schedule.some(e => e.sibs.some(n => /^sib[45]$/i.test(n)));
      if (c.complete && !hasNbr(c) && others.filter(o => o.complete).length >= 2 && others.filter(o => o.complete).every(hasNbr))
        hit(c, 'NO NEIGHBOURS', 'warn', 'sends no neighbour list (no SIB4 / SIB5) while the operator\'s other cells here do');
      // its clock
      if (c.time) { const d = (Date.parse(c.time.utcIso) - now) / 1000; if (Math.abs(d) > 60) hit(c, 'CLOCK OFF', 'warn', `broadcast time ${Math.round(d)} s from this device's clock`); }
      // much louder than its siblings
      const lv = others.filter(o => o.band === c.band).map(o => o.levelDb);
      if (lv.length >= 2 && c.levelDb >= Math.max(...lv) + 20) hit(c, 'LOUD', 'info', `${Math.round(c.levelDb - Math.max(...lv))} dB above the operator's other cells on band ${c.band}`);
    }
    // paging by IMSI
    for (const r of paging?.rows ?? []) {
      if (r.type !== 'IMSI') continue;
      const c = cells.find(x => x.key === r.cell); if (!c) continue;
      const n = (paging?.rows ?? []).filter(x => x.cell === r.cell && x.type === 'IMSI').reduce((a, x) => a + x.count, 0);
      hit(c, 'IMSI PAGING', 'warn', `${n} page${n === 1 ? '' : 's'} by IMSI (real networks page by S-TMSI and rarely by IMSI)`);
    }
    return this.list();
  }
  list(): WatchFinding[] { return [...this.found.values()].sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1) || b.lastMs - a.lastMs); }
  clear(): void { this.ident.clear(); this.found.clear(); }
}
const plmns = (c: CellRow) => plmnsOf(c).join(', ');
