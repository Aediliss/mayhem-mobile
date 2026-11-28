import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Msk144Decoder, augmentedCrc, msk144Audio, msk144DecodeFrame, msk144Encode, msk144Frame, msk144Search } from '../src/dsp/ham/msk144.js';
import { ldpcChecks } from '../src/dsp/ham/ldpc.js';
import { MSK144_MN, MSK144_NM, MSK144_NRW } from '../src/dsp/ham/msk144-tables.js';
import { ftxShared } from '../src/dsp/ham/ft8.js';
import { packStandard, packFree } from '../src/dsp/ham/ft8-encode.js';

const CODE = { n: 128, m: 38, mn: MSK144_MN, nm: MSK144_NM, nrw: MSK144_NRW, colw: 3, roww: 11 };
const MSGS = ['CQ K1ABC FN42', 'K1ABC W9XYZ -11', 'W9XYZ K1ABC R-09', 'K1ABC W9XYZ RR73', 'W9XYZ K1ABC 73'];

test('the augmented CRC agrees with FT8\'s CRC-14 (same construction, as boost::augmented_crc)', () => {
  for (const m of MSGS) {
    const p = packStandard(m)!, bits = new Uint8Array(96);
    for (let i = 0; i < 82; i++) bits[i] = (p[i >> 3] >> (7 - (i & 7))) & 1;
    const a = new Uint8Array(12); a.set(p.subarray(0, 10)); a[9] &= 0xF8;
    for (let i = 77; i < 82; i++) bits[i] = 0;
    assert.equal(augmentedCrc(bits, 14, 0x2757), ftxShared.crc14(a, 82), m);
  }
});

test('the generator and the parity checks (two WSJT-X tables) agree; the frame has its syncs', () => {
  for (const m of MSGS) assert.equal(ldpcChecks(CODE, msk144Encode(packStandard(m)!)), 0, m);
  assert.equal(ldpcChecks(CODE, msk144Encode(packFree('TNX 73 GL'))), 0);
  const f = msk144Frame(packStandard(MSGS[0])!);
  assert.deepEqual(Array.from(f.slice(0, 8)), [0, 1, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(f.slice(56, 64)), [0, 1, 1, 1, 0, 0, 1, 0]);
});

test('the I/Q waveform is the same signal as WSJT-X\'s tone sequence (genmsk_128_90: tones 1000 / 2000 Hz)', () => {
  const p = packStandard(MSGS[1])!, bits = Array.from(msk144Frame(p), b => 2 * b - 1), tone = new Array<number>(144);
  for (let i = 1; i <= 72; i++) {
    tone[2 * i - 2] = (bits[2 * i - 1] * bits[2 * i - 2] + 1) / 2;
    tone[2 * i - 1] = -(bits[2 * i - 1] * bits[(2 * i) % 144] - 1) / 2;
  }
  for (let i = 0; i < 144; i++) tone[i] = 1 - tone[i];   // "flip polarity"
  // continuous-phase FSK at 12 kHz: 6 samples a bit at 1000 + 1000·tone Hz
  const fsk = new Float32Array(864 * 2); let ph = 0;
  for (let k = 0; k < fsk.length; k++) { fsk[k] = Math.cos(ph); ph += 2 * Math.PI * (1000 + 1000 * tone[Math.floor(k / 6) % 144]) / 12000; }
  const iq = msk144Audio(p, 2, 12000);
  // best match over a constant phase (and half-bit start)
  let best = 0;
  for (let sh = 0; sh < 12; sh++) {
    let a = 0, b = 0, ea = 0, eb = 0;
    for (let k = 864; k < 1700; k++) {
      const x = iq[k], y = fsk[(k + sh) % fsk.length];
      a += x * y; ea += x * x; eb += y * y;
    }
    // the FSK sine and cosine both: try quadrature too
    let a2 = 0; ph = 0;
    void b; for (let k = 864; k < 1700; k++) a2 += iq[k] * fskQ(k + sh);
    best = Math.max(best, Math.hypot(a, a2) / Math.sqrt(ea * eb));
  }
  function fskQ(k: number): number { let p2 = 0; for (let j = 0; j < k; j++) p2 += 2 * Math.PI * (1000 + 1000 * tone[Math.floor(j / 6) % 144]) / 12000; return Math.sin(p2); }
  assert.ok(best > 0.97, `match ${best.toFixed(3)}`);
});

test('a frame decodes clean and through noise; noise alone does not', () => {
  const p = packStandard('K1ABC W9XYZ -11')!, a = msk144Audio(p, 3, 12000, 1500, 1);
  const r = new Float32Array(3 * 864), i = new Float32Array(3 * 864);
  let s = 5; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); };
  for (let k = 0; k < r.length; k++) { const w = -2 * Math.PI * 1500 * k / 12000; r[k] = 2 * a[k] * Math.cos(w); i[k] = 2 * a[k] * Math.sin(w); }
  // a crude low-pass: an 8-sample average removes the 3 kHz image well enough here
  const lp = (x: Float32Array) => Float32Array.from(x, (_, k) => { let t = 0; for (let j = -3; j <= 4; j++) t += x[Math.max(0, Math.min(x.length - 1, k + j))]; return t / 8; });
  const R = lp(r), I = lp(i);
  const one = msk144DecodeFrame(R.slice(864, 1728), I.slice(864, 1728));
  assert.ok(one); assert.deepEqual(Array.from(one), Array.from(p.slice(0, 10)).map((b, k) => k === 9 ? b & 0xF8 : b));
  const nr = Float32Array.from(R, x => x + 0.9 * g()), ni = Float32Array.from(I, x => x + 0.9 * g());
  const got = msk144Search(nr, ni, 0); assert.ok(got, 'noisy three frames');
  const z = Float32Array.from({ length: 3 * 864 }, () => g());
  assert.equal(msk144Search(z, Float32Array.from(z, () => g()), 0), null);
});

/** A 48 kHz stream: noise, then a ping of [frames] frames at +[offHz] and [amp], then noise. */
function pingAudio(msg: string, frames: number, offHz: number, amp: number, seed = 3): Float32Array {
  const R = 48000, a = new Float32Array(R * 3), x = msk144Audio(packStandard(msg)!, frames, R, 1500 + offHz, amp), at = Math.round(1.23 * R);
  for (let k = 0; k < x.length; k++) a[at + k] += x[k] * Math.min(1, k / 480, (x.length - k) / 480);
  let s = seed; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += 0.1 * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  return a;
}
function feed(d: Msk144Decoder, a: Float32Array): string[] {
  const got: string[] = []; d.onDecodes = list => { for (const x of list) got.push(`${x.text}@${x.hz}`); };
  for (let o = 0; o < a.length; o += 4800) d.push(a.subarray(o, o + 4800), Math.min(4800, a.length - o));
  return got;
}

test('a 0.4 s ping 37 Hz off, in noise, decodes once with its frequency; noise alone gives nothing', () => {
  const got = feed(new Msk144Decoder(), pingAudio('K1ABC W9XYZ R-09', 5, 37, 0.06));
  assert.equal(got.length, 1);
  const [text, hz] = got[0].split('@'); assert.equal(text, 'K1ABC W9XYZ R-09'); assert.ok(Math.abs(Number(hz) - 1537) <= 2, hz);   // 2 Hz search steps
  assert.deepEqual(feed(new Msk144Decoder(), pingAudio('K1ABC W9XYZ R-09', 5, 37, 0)), []);
});

// fixtures/wsjtx-msk144-181211_1205*.ci12: WSJT-X's samples/MSK144/181211_120500.wav and _120800.wav (WSJT-X, GPL-3.0;
// real 6 m meteor-scatter pings), 12 kHz 16-bit audio as WSJT-X ships it. Source: https://sourceforge.net/p/wsjt/wsjtx/
// (samples/MSK144).
for (const [name, want] of [['181211_120500', ['K1JT WA4CQG EM72']], ['181211_120800', ['CQ KD9VV EN71', 'CQ W4IMD EM84']]] as const) {
  test(`the WSJT-X sample ${name}: ${want.join(', ')}`, () => {
    const b = readFileSync(new URL(`../test/fixtures/wsjtx-msk144-${name}.wav`, import.meta.url));
    const n = (b.length - 44) >> 1, a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = b.readInt16LE(44 + 2 * k) / 32768;
    const got = feed(new Msk144Decoder(12000), a);
    assert.deepEqual(got.map(g => g.split('@')[0]).sort(), [...want]);
    for (const g of got) assert.ok(Math.abs(Number(g.split('@')[1]) - 1500) <= 100);
  });
}

// ---- MSK40 ----------------------------------------------------------------------------------------------------------
import { msk40Audio, msk40Encode, msk40Hash, MSK40_RPT } from '../src/dsp/ham/msk144.js';

test('MSK40: the (32,16) generator and bpdecode40\'s parity checks agree for every report and many hashes', () => {
  const CODE40 = { n: 32, m: 16, colw: 3, roww: 7, mn: new Uint8Array(0), nm: Uint8Array.from([1, 7, 12, 18, 21, 27, 31, 2, 8, 13, 18, 24, 28, 0, 2, 9, 14, 19, 23, 29, 0, 3, 8, 12, 20, 23, 30, 0, 4, 8, 15, 19, 22, 31, 0, 1, 6, 13, 19, 25, 30, 0, 5, 9, 16, 21, 25, 26, 0, 3, 10, 11, 18, 26, 32, 0, 6, 9, 15, 20, 27, 32, 0, 5, 10, 13, 22, 27, 0, 0, 4, 7, 14, 20, 26, 28, 0, 4, 10, 12, 17, 25, 29, 0, 1, 11, 16, 22, 28, 29, 0, 2, 11, 15, 17, 21, 30, 0, 3, 6, 14, 16, 24, 31, 0, 5, 7, 17, 23, 24, 32, 0]), nrw: Uint8Array.from([7, 6, 6, 6, 6, 6, 6, 6, 6, 5, 6, 6, 6, 6, 6, 6]) };
  for (let h = 0; h < 4096; h += 97) for (let r = 0; r < 16; r++) assert.equal(ldpcChecks(CODE40, msk40Encode(16 * h + r)), 0, `${h}/${r}`);
});

test('MSK40: after an MSK144 message, a short "<CALL1 CALL2> RRR" ping decodes; one from an unknown pair does not', () => {
  const R = 48000, a = new Float32Array(R * 5);
  const add = (x: Float32Array, at: number) => { for (let k = 0; k < x.length; k++) a[at + k] += x[k] * Math.min(1, k / 240, (x.length - k) / 240); };
  add(msk144Audio(packStandard('K1ABC W9XYZ R-09')!, 5, R, 1530, 0.06), Math.round(0.8 * R));
  add(msk40Audio(16 * msk40Hash('W9XYZ K1ABC') + MSK40_RPT.indexOf('RRR'), 12, R, 1530, 0.06), Math.round(2.4 * R));
  add(msk40Audio(16 * msk40Hash('G4ABC DL1XYZ') + MSK40_RPT.indexOf('73'), 12, R, 1470, 0.06), Math.round(3.8 * R));
  let s = 21; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += 0.1 * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
  const got = feed(new Msk144Decoder(), a).map(g => g.split('@')[0]);
  assert.deepEqual(got, ['K1ABC W9XYZ R-09', '<W9XYZ K1ABC> RRR']);
});
