// FORK: rogue-cell heuristics (src/cell-watch.ts) on Cell snapshots: an operator's ordinary cells raise nothing; a fake
// cell's marks (test PLMN, lone TAC, bait reselection, no neighbours, clock, loudness, IMSI paging, identity change and
// duplication) each raise their finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellWatch } from '../src/cell-watch.js';
import type { CellRow } from '../src/dsp/cell/cell.js';
import type { PagingSnap } from '../src/dsp/cell/paging.js';

const NOW = Date.UTC(2026, 10, 28, 12);
function cell(o: { hz: number; pci: number; plmn?: string; name?: string; tac?: number; cid?: number; pri?: number; qmin?: number; qHyst?: string; nbr?: boolean; level?: number; timeOffS?: number }): CellRow {
  const sibs = o.nbr === false ? ['sib3'] : ['sib3', 'sib4', 'sib5'];
  return {
    key: `${o.hz}:${o.pci}`, hz: o.hz, pci: o.pci, earfcn: 5110, band: 12, tdd: false, firstMs: NOW, lastMs: NOW, mibMs: NOW, sib1Ms: NOW,
    mib: null, nrb: 50, ports: 2, sfn: 0, snrDb: 20, levelDb: o.level ?? -60, cfoHz: 0, pssScore: 10, mibCount: 1, sib1Count: 1, dciCount: 1, tbOk: 1, tbFail: 0,
    summary: { plmns: [{ id: o.plmn ?? '310-410', name: o.name ?? (o.plmn && o.plmn !== '310-410' ? '' : 'AT&T') }], tac: o.tac ?? 100, cellIdentity: o.cid ?? 1000 + o.pci, enbId: 0, cellId: 0,
      barred: 'notBarred', intraFreqReselection: 'allowed', band: 12, bands: [12], qRxLevMinDbm: o.qmin ?? -124, qQualMinDb: null, pMax: null, siWindowMs: 20, valueTag: 0,
      schedule: [{ si: 1, periodicity: 16, sibs, windowStartSfnMod: 0, windowStartSubframe: 0, windowMs: 20 }], warning: { sib10: false, sib11: false, sib12: false }, hyperSfn: null, imsEmergency: false, edrx: false, tdd: null },
    sib2: null, sib3: { qHyst: o.qHyst ?? 'dB4', sNonIntraSearchDb: null, threshServingLow: 2, priority: o.pri ?? 5, qRxLevMinDbm: o.qmin ?? -124, sIntraSearchDb: null, tReselection: 1, bandwidth: '' },
    neighbors: null, time: o.timeOffS === undefined ? null : { gpsIso: '', utcIso: new Date(NOW + o.timeOffS * 1000).toISOString() },
    sibs: [], si: [], fullBand: true, complete: true, alerts: 0,
  };
}
const real = [cell({ hz: 739e6, pci: 10 }), cell({ hz: 739e6, pci: 11 }), cell({ hz: 739e6, pci: 12, level: -70 }), cell({ hz: 751e6, pci: 300, timeOffS: 0.5 })];
const codes = (w: CellWatch, cells: CellRow[], paging: PagingSnap | null = null, now = NOW) => w.update(cells, paging, now).map(f => `${f.key} ${f.code}`).sort();

test('an operator\'s ordinary cells raise nothing', () => {
  assert.deepEqual(codes(new CellWatch(), real), []);
});

test('a fake cell: test PLMN, bait reselection, no neighbours, clock off, loud, IMSI paging', () => {
  const fake = cell({ hz: 739e6, pci: 99, plmn: '001-01', tac: 7, pri: 7, qmin: -140, qHyst: 'dB0', nbr: false, level: -30, timeOffS: -3600 });
  const paging = { total: 3, rows: [{ ms: NOW, lastMs: NOW, cell: fake.key, hz: fake.hz, pci: 99, type: 'IMSI', id: '310410123456789', domain: 'PS', count: 3 }], ids: [], flags: { sysInfoMod: 0, etws: 0, cmas: 0, eab: 0 } } as PagingSnap;
  const got = codes(new CellWatch(), [...real, fake], paging);
  assert.deepEqual(got, ['739000000:99 BAIT RESELECTION', '739000000:99 CLOCK OFF', '739000000:99 IMSI PAGING', '739000000:99 TEST PLMN'].sort(), JSON.stringify(got));
  // the same fake with the real operator's PLMN: lone TAC, no neighbours, loud too
  const mimic = cell({ hz: 739e6, pci: 98, tac: 7, pri: 7, nbr: false, level: -30 });
  const g2 = codes(new CellWatch(), [...real, mimic]);
  assert.deepEqual(g2, ['739000000:98 BAIT RESELECTION', '739000000:98 LONE TAC', '739000000:98 LOUD', '739000000:98 NO NEIGHBOURS'], JSON.stringify(g2));
});

test('identity changed on the same frequency and PCI; the same identity on another; warnings listed first', () => {
  const w = new CellWatch();
  w.update(real, null, NOW);
  const swapped = real.map((c, i) => i === 0 ? cell({ hz: 739e6, pci: 10, cid: 5555, tac: 100 }) : c);
  const twin = cell({ hz: 751e6, pci: 301, cid: 1011 });   // PCI 11's identity on another carrier
  const f = w.update([...swapped, twin], null, NOW + 60_000);
  assert.deepEqual(f.map(x => `${x.key} ${x.code}`).sort(), ['739000000:10 IDENTITY CHANGED', '739000000:11 DUPLICATE IDENTITY', '751000000:301 DUPLICATE IDENTITY']);
  assert.match(f.find(x => x.code === 'IDENTITY CHANGED')!.text, /was cell 1010 TAC 100 \(310-410\), now cell 5555 TAC 100/);
  const w2 = new CellWatch(); const l = w2.update([...real, cell({ hz: 739e6, pci: 50, plmn: '312-999', name: '' })], null, NOW);
  assert.deepEqual(l.map(x => x.code), ['UNKNOWN OPERATOR']);
});
