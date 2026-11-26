// FORK: two-tone paging named: Motorola Quick Call II (reeds, cap code, call kind, the one-tone group call) and GE
// Type 99, from the tables; and end to end through upstream's analog reader (hamid/analog.ts) on synthetic audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ge99Tones, identifyLongTone, identifyTwoTone, qc2CapTones } from '../src/dsp/twotone.js';
import { AnalogSignaling, analogSummary } from '../src/dsp/hamid/analog.js';

test('Quick Call II: reed codes and cap codes from tones; call kind from timing', () => {
  const id = identifyTwoTone(1122.5, 1472.9, 1000, 3000);
  assert.deepEqual([id?.system, id?.kind, id?.tones, id?.code], ['Motorola QC-II', 'individual call', '190/170', '']);   // groups 6 and 10: no cap code in the plan
  // the general encoding plan: 3 → A from group 1, B from group 2; tone 4 of group 1 is 410.8, tone 7 of group 2 is 832.5
  assert.deepEqual(qc2CapTones('347'), [410.8, 832.5]);
  const cap = identifyTwoTone(410.8, 832.5, 1000, 3000);
  assert.deepEqual([cap?.code, cap?.tones], ['347', '114/127']);
  assert.equal(cap?.text, 'Motorola QC-II individual call cap code 347 (reeds 114/127)');
  // every cap code of the plan comes back from its own tones, 0.8 % off
  for (const d of '1234567890A') for (const x of '0123456789') for (const y of '0123456789') {
    const [a, b] = qc2CapTones(d + x + y)!;
    if (a === b) continue;                                     // same group, same number: one long tone, not a page
    assert.equal(identifyTwoTone(a * 1.008, b * 0.992, 1000, 3000)?.code, d + x + y);
  }
  assert.equal(identifyTwoTone(410.8, 832.5, 400, 800)?.kind, 'tone only');
  assert.equal(identifyTwoTone(410.8, 832.5, 2700, 800)?.kind, 'battery save');
  // reed 109: 313.0 Hz in one table, 313.8 in another
  assert.equal(identifyTwoTone(313.8, 1122.5, 1000, 3000)?.tones, '109/190');
  // off the tables
  assert.equal(identifyTwoTone(940, 1108, 1000, 3000), null);    // more than 1.2 % from every reed
  assert.equal(identifyLongTone(1122.5, 8000)?.text, 'Motorola QC-II group call (reed 190, 8.0 s)');
  assert.equal(identifyLongTone(1122.5, 3000), null);
});

test('GE Type 99: code from tones; its timing tells it from a Quick Call II page in the shared range', () => {
  assert.deepEqual(ge99Tones('312'), [592.5, 787.5]);       // 3: first tone group A, second group B
  const id = identifyTwoTone(592.5, 787.5, 1000, 1500);
  assert.deepEqual([id?.system, id?.code, id?.tones], ['GE Type 99', '312', 'A1/B2']);
  // 600.9 / 788.5 are Quick Call II group 2 reeds, 1.4 % and 0.1 % from GE tones: with QC-II timing they stay QC-II
  assert.equal(identifyTwoTone(600.9, 788.5, 1000, 3000)?.system, 'Motorola QC-II');
});

/** Squelched audio at 16 kHz: silence, then the parts (Hz, s; 0 Hz = speech-like noise), then silence. */
function audio(parts: [number, number][]): Float32Array {
  const fs = 16_000, out: number[] = [];
  for (let i = 0; i < fs * 0.5; i++) out.push(0);
  let ph = 0, seed = 5;
  for (const [hz, s] of parts) for (let i = 0; i < fs * s; i++) {
    if (hz) { ph += 2 * Math.PI * hz / fs; out.push(0.3 * Math.sin(ph)); }
    else { seed = (seed * 1103515245 + 12345) >>> 0; const t = i / fs; out.push(0.2 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(7 * t)) * t) + 0.1 * (seed / 2 ** 32 - 0.5)); }
  }
  for (let i = 0; i < fs * 1; i++) out.push(0);
  return Float32Array.from(out);
}
function read(a: Float32Array): string[] {
  const r = new AnalogSignaling(16_000, true), lines: string[] = [];
  r.onTx = tx => lines.push(...analogSummary(tx));
  r.push(a, a.length); r.flush();
  return lines;
}

test('end to end: the analog reader names a Quick Call II page, a group call and a GE Type 99 page', () => {
  const [a, b] = qc2CapTones('347')!;
  const page = read(audio([[a, 1], [b, 3], [0, 2]])).find(l => l.startsWith('2-tone page'));
  assert.match(page ?? '', /^2-tone page 41\d and 83\d Hz, Motorola QC-II individual call cap code 347 \(reeds 114\/127\)$/);
  const group = read(audio([[1122.5, 8]])).find(l => l.startsWith('Long tone'));
  assert.match(group ?? '', /^Long tone 112\d Hz, Motorola QC-II group call \(reed 190, [78]\.\d s\)$/);
  const [g1, g2] = ge99Tones('312')!;
  assert.match(read(audio([[g1, 1], [g2, 1.5]])).join(' | '), /GE Type 99 code 312/);
  // speech alone: no page
  assert.deepEqual(read(audio([[0, 4]])).filter(l => /page|Long tone/.test(l)), []);
});
