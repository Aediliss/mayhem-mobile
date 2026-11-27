// FORK: FT4 (dsp/ham/ft4.ts). The encoder against ft8_lib's own (C, MIT; ft4_encode run on these messages): payloads
// and all 105 tones match; then the decoder: three FT4 signals in one 7.5 s slot at different audio frequencies and
// times, through noise, all read back; a damaged one (tones scrambled) and noise alone give nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ft4Decoder, ft4Audio, ft4Tones } from '../src/dsp/ham/ft4.js';
import { packFree, packStandard } from '../src/dsp/ham/ft8-encode.js';

// ft8_lib: message | payload | tones (ft4_encode)
const REF: [string, string, string][] = [
  ['CQ K1ABC FN42', '000000204def1a8a1988', '001321033112330313110222113111302210231223312331210203121200233032123101212323023000120100233321133032010'],
  ['K1ABC W9XYZ -11', '09bde3506149dc1faa08', '001321002230213332310210120023311110230330110030222311323012102223023101120313000001322133100310132132010'],
  ['W9XYZ K1ABC R-09', '0c293b804def1abfaa88', '001321013121232030210222113111302210233330110330212132301313113303323100033333313300212103332331312132010'],
  ['TNX BOB 73 GL', '63edcee2a4ae07f50000', '001320331320210121113011003101223310233003223033121300221003030231123100002301012020301213003321232032010'],
];
const hex = (b: Uint8Array) => Array.from(b.subarray(0, 10), x => x.toString(16).padStart(2, '0')).join('');
const pack = (t: string) => packStandard(t) ?? packFree(t);

test('encoder: payloads and the 105 tones match ft8_lib\'s ft4_encode', () => {
  for (const [msg, payload, tones] of REF) {
    const p = pack(msg);
    assert.equal(hex(p), payload, msg);
    assert.equal(Array.from(ft4Tones(p)).join(''), tones, msg);
  }
});

const FS = 48_000 * 2 / 9;
function slot(sigs: { text: string; hz: number; dt: number; amp?: number; scramble?: boolean }[], snrNoise = 0.35, seed = 7): Float32Array {
  const buf = new Float32Array(Math.round(7.5 * FS));
  for (const s of sigs) {
    const tones = ft4Tones(pack(s.text));
    if (s.scramble) for (let i = 5; i < 100; i += 2) tones[i] = (tones[i] + 1) & 3;
    const a = ft4Audio(tones, s.hz, FS, s.amp ?? 0.3), at = Math.round((1.0 + 0.5 + s.dt) * FS);
    for (let i = 0; i < a.length && at + i < buf.length; i++) buf[at + i] += a[i];
  }
  let x = seed; const g = () => { let u = 0; while (!u) { x = (x * 1103515245 + 12345) >>> 0; u = x / 2 ** 32; } x = (x * 1103515245 + 12345) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * x / 2 ** 32); };
  for (let i = 0; i < buf.length; i++) buf[i] += snrNoise * g();
  return buf;
}

test('decoder: three signals in one slot through noise; a scrambled one and noise give nothing', () => {
  const d = new Ft4Decoder();
  const got = d.decodeBuffer(slot([{ text: 'CQ K1ABC FN42', hz: 800, dt: 0 }, { text: 'K1ABC W9XYZ -11', hz: 1500, dt: 0.2 }, { text: 'TNX BOB 73 GL', hz: 2200, dt: -0.1, amp: 0.15 }]));
  const texts = got.map(x => x.text).sort();
  assert.deepEqual(texts, ['CQ K1ABC FN42', 'K1ABC W9XYZ -11', 'TNX BOB 73 GL'], JSON.stringify(got));
  const cq = got.find(x => x.text === 'CQ K1ABC FN42')!;
  assert.ok(Math.abs(cq.hz - 800) <= 11 && Math.abs(cq.dt) <= 0.05, JSON.stringify(cq));
  assert.equal(new Ft4Decoder().decodeBuffer(slot([{ text: 'CQ K1ABC FN42', hz: 900, dt: 0, scramble: true }])).length, 0);
  assert.equal(new Ft4Decoder().decodeBuffer(slot([])).length, 0);
});

test('live: 48 kHz audio pushed as it comes, decoded at the slot it was sent in (the clock stubbed)', () => {
  const R = 48_000, slotMs = 1_800_000_000_000 - (1_800_000_000_000 % 7500), audio = new Float32Array(R * 20);
  const sig = ft4Audio(ft4Tones(pack('CQ K1ABC FN42')), 1200, R, 0.3), at = Math.round((7.5 + 0.5) * R);
  for (let i = 0; i < sig.length; i++) audio[at + i] += sig[i];
  let s = 3; for (let i = 0; i < audio.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; audio[i] += (s / 2 ** 32 - 0.5) * 0.4; }
  const d = new Ft4Decoder(), got: { slot: number; text: string; dt: number }[] = [];
  d.onDecodes = (list, slot) => { for (const x of list) got.push({ slot, text: x.text, dt: x.dt }); };
  let now = slotMs; const real = Date.now; Date.now = () => now;
  try { for (let o = 0; o < audio.length; o += 4800) { now = slotMs + (o + 4800) / R * 1000; d.push(audio.subarray(o, o + 4800), 4800); } }
  finally { Date.now = real; }
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].slot * 7500 - slotMs, got[0].text], [7500, 'CQ K1ABC FN42']);
  assert.ok(Math.abs(got[0].dt) < 0.1);
});
