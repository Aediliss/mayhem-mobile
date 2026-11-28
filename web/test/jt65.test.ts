import test from 'node:test';
import assert from 'node:assert/strict';
import { Jt65Decoder, JT65_SYNC, jt65Audio, jt65Deinterleave, jt65Interleave, jt65Pack, jt65RsDecode, jt65RsEncode, jt65Tones, jt65Unpack } from '../src/dsp/ham/jt65.js';

const MSGS = ['CQ K1ABC FN42', 'K1ABC W9XYZ -15', 'W9XYZ K1ABC R-12', 'K1ABC W9XYZ RRR', 'W9XYZ K1ABC 73', 'CQ 015 K1ABC FN42', 'QRZ W9XYZ EN37', 'K1ABC W9XYZ RO'];

test('messages pack and unpack back (standard, CQ nnn, QRZ, reports, RO / RRR / 73, free text)', () => {
  for (const m of MSGS) assert.equal(jt65Unpack(jt65Pack(m)), m, m);
  assert.equal(jt65Unpack(jt65Pack('TNX BOB 73 GL')), 'TNX BOB 73 GL');
  assert.equal(jt65Unpack(jt65Pack('CQ 3DA0XYZ KG53')), 'CQ 3DA0XYZ KG53');
});

test('RS(63,12): 25 errors corrected, 51 erasures filled, 26 errors not taken for the message', () => {
  const d = jt65Pack('K1ABC W9XYZ -15'), cw = jt65RsEncode(d);
  const e25 = Int32Array.from(cw); for (let i = 0; i < 25; i++) e25[(i * 5) % 63] ^= 1 + (i % 62);
  assert.deepEqual(Array.from(jt65RsDecode(e25)!.dgen), Array.from(d));
  const er = Int32Array.from(cw), eras: number[] = []; for (let i = 0; i < 51; i++) { const p = (i * 11) % 63; er[p] = 0; eras.push(p); }
  assert.deepEqual(Array.from(jt65RsDecode(er, eras.sort((a, b) => a - b))!.dgen), Array.from(d));
  const e26 = Int32Array.from(cw); for (let i = 0; i < 26; i++) e26[i * 2] ^= 7;
  const r = jt65RsDecode(e26); assert.ok(!r || Array.from(r.dgen).join() !== Array.from(d).join());
});

test('frame: interleaving undoes itself; 63 sync symbols on tone 0, the data on tones 2-65', () => {
  const x = Int32Array.from({ length: 63 }, (_, i) => i);
  assert.deepEqual(Array.from(jt65Deinterleave(jt65Interleave(x))), Array.from(x));
  const t = jt65Tones(jt65Pack(MSGS[0]));
  assert.equal(JT65_SYNC.reduce((a, b) => a + b, 0), 63);
  JT65_SYNC.forEach((s, i) => { if (s) assert.equal(t[i], 0); else assert.ok(t[i] >= 2 && t[i] <= 65); });
});

/** A minute of 5512.5 Hz audio with JT65 signals ([snr] in 2500 Hz) and white noise. */
function slot(sigs: { msg: string; hz: number; dt: number; snr: number; sub: number }[], seed = 1, extra?: (x: Float32Array) => void): Float32Array {
  const R = 5512.5, x = new Float32Array(Math.round(52 * R)), noise = 0.1;
  for (const g of sigs) {
    const A = Math.sqrt(2 * 10 ** (g.snr / 10) * noise * noise * 2500 / (R / 2)), s = jt65Audio(jt65Tones(jt65Pack(g.msg)), g.hz, R, g.sub, A), at = Math.round((1 + g.dt) * R);
    for (let k = 0; k < s.length; k++) if (at + k >= 0 && at + k < x.length) x[at + k] += s[k];
  }
  extra?.(x);
  let s = seed; for (let k = 0; k < x.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; x[k] += noise * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  return x;
}

test('JT65A: three stations in a slot (−8, −16, −22 dB) decode with frequency, DT and SNR; no echo of the strong one', () => {
  const sigs = [{ msg: 'CQ K1ABC FN42', hz: 800, dt: 0, snr: -8, sub: 1 }, { msg: 'K1ABC W9XYZ -15', hz: 1400, dt: 0.6, snr: -16, sub: 1 }, { msg: 'W9XYZ K1ABC R-12', hz: 2100, dt: -0.5, snr: -22, sub: 1 }];
  const d = new Jt65Decoder(); d.budgetMs = 60_000;
  const got = d.decodeBuffer(slot(sigs), Date.UTC(2026, 10, 28, 7, 31));
  assert.equal(got.length, 3, JSON.stringify(got));
  for (const s of sigs) {
    const g = got.find(x => x.text === s.msg)!; assert.ok(g, s.msg);
    assert.ok(Math.abs(g.hz - s.hz) <= 1, `${s.msg} ${g.hz}`); assert.ok(Math.abs(g.dt - s.dt) <= 0.1, `${s.msg} DT ${g.dt}`);
    assert.ok(Math.abs(g.snr - s.snr) <= 2, `${s.msg} SNR ${g.snr}`); assert.equal(g.utc, '0731');
  }
});

test('JT65B and JT65C (EME spacings) decode at −22 dB', () => {
  for (const sub of [2, 4]) {
    const d = new Jt65Decoder(); d.sub = sub; d.budgetMs = 60_000;
    assert.deepEqual(d.decodeBuffer(slot([{ msg: 'K1ABC W9XYZ RRR', hz: 1200, dt: 0.3, snr: -22, sub }], 5)).map(g => g.text), ['K1ABC W9XYZ RRR'], `sub ${sub}`);
  }
});

test('noise, a steady carrier and a strong random 9-tone signal decode nothing', () => {
  const R = 5512.5;
  const x = slot([], 11, y => {
    let ph = 0, ph2 = 0; let s = 77;
    for (let k = 0; k < y.length; k++) {
      y[k] += 0.05 * Math.sin(ph); ph += 2 * Math.PI * 1500 / R;
      if (k % 3200 === 0) { s = (s * 1664525 + 1013904223) >>> 0; }
      y[k] += 0.05 * Math.sin(ph2); ph2 += 2 * Math.PI * (900 + 1.736 * (s % 9)) / R;
    }
  });
  for (const sub of [1, 2, 4]) { const d = new Jt65Decoder(); d.sub = sub; d.budgetMs = 60_000; assert.deepEqual(d.decodeBuffer(x), [], `sub ${sub}`); }
});

test('live: 48 kHz audio pushed as it comes decodes at 52 s into its minute (the clock stubbed)', () => {
  const R = 48_000, slotMs = 1_800_000_000_000 - (1_800_000_000_000 % 60_000), a = new Float32Array(R * 56);
  const s = jt65Audio(jt65Tones(jt65Pack('CQ K1ABC FN42')), 1270, R, 1, 0.05);
  for (let k = 0; k < s.length; k++) a[R + k] += s[k];
  let q = 9; for (let k = 0; k < a.length; k++) { q = (q * 1664525 + 1013904223) >>> 0; a[k] += (q / 2 ** 32 - 0.5) * 0.3; }
  const d = new Jt65Decoder(), got: { slot: number; text: string; dt: number }[] = [];
  d.onDecodes = (list, sl) => { for (const g of list) got.push({ slot: sl, text: g.text, dt: g.dt }); };
  let now = slotMs; const real = Date.now; Date.now = () => now;
  try { for (let o = 0; o < a.length; o += 4800) { now = slotMs + (o + 4800) / R * 1000; d.push(a.subarray(o, o + 4800), 4800); } }
  finally { Date.now = real; }
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].slot * 60_000, got[0].text], [slotMs, 'CQ K1ABC FN42']);
  assert.ok(Math.abs(got[0].dt) <= 0.2, `DT ${got[0].dt}`);
});
