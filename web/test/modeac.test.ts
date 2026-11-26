// FORK: Mode A/C replies (dsp/modeac.ts): codes read as squawk and Mode C altitude, the detector on replies placed at
// any fraction of a sample with noise, the X-slot rule, tracks after three replies and their association with Mode-S
// aircraft, and end to end through the ADS-B decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModeAcDetector, ModeAcTracks, acAltitude, acSquawk } from '../src/dsp/modeac.js';
import { AdsbDecoder } from '../src/dsp/adsb.js';
import { withParity } from '../src/dsp/modes.js';

/** Slots C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4 from a squawk. */
function code(sq: string, x = 0): number {
  const [a, b, c, d] = sq.split('').map(Number), bit = (v: number, k: number) => (v >> k) & 1;
  return [bit(c, 0), bit(a, 0), bit(c, 1), bit(a, 1), bit(c, 2), bit(a, 2), x, bit(b, 0), bit(d, 0), bit(b, 1), bit(d, 1), bit(b, 2), bit(d, 2)].reduce((v, y) => v * 2 + y, 0);
}

test('a code reads as a squawk and, when it is one, as a Mode C altitude', () => {
  for (const sq of ['7700', '1200', '0000', '7777', '2134']) assert.equal(acSquawk(code(sq)), sq);
  // every 100 ft step from -1000 to 62 700 ft is some code with D1 and X clear, and each such code reads back to it
  const byAlt = new Map<number, number>();
  for (let c = 0; c < 8192; c++) { if (c & ((1 << 6) | (1 << 4))) continue; const a = acAltitude(c); if (a !== undefined) byAlt.set(a, (byAlt.get(a) ?? 0) + 1); }
  for (let a = -1000; a <= 62_700; a += 100) assert.equal(byAlt.get(a), 1, `${a} ft`);
  assert.equal(acAltitude(code('0001')), undefined);            // D1 set: not an altitude
});

const FS = 2_000_000, SPS = FS / 1e6;
/** Magnitudes with replies at fractional sample times: each 0.45 µs pulse spread over the samples it covers. */
function mags(n: number, replies: { at: number; code13: number; spi?: boolean }[], amp = 2000, noise = 60, seed = 3): Float64Array {
  const m = new Float64Array(n), w = 0.45 * SPS;
  let r = seed; const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 2 ** 32; };
  for (let i = 0; i < n; i++) m[i] = noise * rnd();
  const pulse = (t: number) => { const a = t, b = t + w; for (let k = Math.floor(a); k < Math.ceil(b); k++) { const ov = Math.min(b, k + 1) - Math.max(a, k); if (ov > 0) m[k] += amp * Math.min(1, ov / Math.min(w, 1)); } };
  for (const p of replies) {
    pulse(p.at); pulse(p.at + 20.3 * SPS);
    for (let k = 1; k <= 13; k++) if ((p.code13 >> (13 - k)) & 1) pulse(p.at + 1.45 * k * SPS);
    if (p.spi) pulse(p.at + 24.65 * SPS);
  }
  return m;
}

test('detector: replies at any fraction of a sample, with noise, come out with their codes; X set or noise alone give none', () => {
  const sqs = ['7700', '1200', '4321', '0000', '7777', '2000', '1357', '6402'];
  const replies = sqs.flatMap((sq, i) => [0, 0.25, 0.5, 0.75].map((f, j) => ({ at: 200 + (i * 4 + j) * 120 + f, code13: code(sq), spi: j === 1 })));
  const m = mags(200 + replies.length * 120 + 200, replies);
  const got = new ModeAcDetector(FS).scan(m, 0, m.length, 60);
  assert.deepEqual(got.map(r => acSquawk(r.code13)), replies.map(r => acSquawk(r.code13)));
  assert.deepEqual(got.map(r => r.spi), replies.map(r => !!r.spi));
  // the X slot set: not a reply
  const mx = mags(600, [{ at: 200, code13: code('1200', 1) }]);
  assert.deepEqual(new ModeAcDetector(FS).scan(mx, 0, mx.length, 60), []);
  const quiet = mags(200_000, []);
  assert.deepEqual(new ModeAcDetector(FS).scan(quiet, 0, quiet.length, 60), []);
});

test('tracks: a code counts after three replies within ten seconds, and is matched to a Mode-S aircraft by squawk or altitude', () => {
  const t = new ModeAcTracks(), alt37 = [...Array(8192).keys()].find(c => !(c & 0x50) && acAltitude(c) === 37_000)!;
  t.add({ code13: code('1200'), spi: false, at: 0, level: 1 }, 0); t.add({ code13: code('1200'), spi: false, at: 0, level: 1 }, 4000);
  assert.equal(t.tracks.size, 0);
  t.add({ code13: code('1200'), spi: false, at: 0, level: 1 }, 8000);
  for (const ms of [0, 1000, 2000]) { t.add({ code13: code('7700'), spi: false, at: 0, level: 1 }, ms); t.add({ code13: alt37, spi: false, at: 0, level: 1 }, ms); }
  const tr = t.associate([{ icao: '4840d6', squawk: '7700', alt: 37_100 }], 9000);
  assert.deepEqual(tr.map(x => [x.squawk, x.icao]).sort(), [['1200', ''], [acSquawk(alt37), '4840d6'], ['7700', '4840d6']].sort());
  assert.equal(t.associate([], 80_000).length, 0);               // quiet for a minute: gone
});

test('end to end: Mode A/C replies among Mode-S frames; 7700 tied to the aircraft that squawks it, 1200 on its own', () => {
  const msgs: { type: string; tracks?: { squawk: string; icao: string }[] }[] = [];
  const dec = new AdsbDecoder(m => msgs.push(m as never));
  const KLM = Uint8Array.from('8D4840D6202CC371C32CE0576098'.match(/../g)!.map(x => parseInt(x, 16)));
  const sqv = code('7700'), df5 = withParity([0x28, 0, (sqv >> 8) & 0x1f, sqv & 255], 56, 0x4840d6);
  const s: number[] = [], gap = (n: number) => { for (let i = 0; i < n; i++) s.push(0, 0); };
  const frame = (f: Uint8Array) => { for (let i = 0; i < 16; i++) { const on = i === 0 || i === 2 || i === 7 || i === 9; s.push(on ? 100 : 0, 0); } for (let k = 0; k < f.length * 8; k++) { const b = (f[k >> 3] >> (7 - (k & 7))) & 1; s.push(b ? 100 : 0, 0, b ? 0 : 100, 0); } gap(300); };
  const reply = (c: number) => { const m = mags(80, [{ at: 4.3, code13: c }], 100, 0); for (const v of m) s.push(Math.round(Math.min(127, v)), 0); gap(300); };
  gap(400); frame(KLM); frame(KLM); frame(df5);
  for (let i = 0; i < 4; i++) { reply(code('7700')); reply(code('1200')); }
  dec.onIq(Int8Array.from(s));
  const last = msgs.filter(m => m.type === 'modeac').pop();
  assert.ok(last, msgs.map(m => m.type).join(','));
  assert.deepEqual(last!.tracks!.map(t => [t.squawk, t.icao]).sort(), [['1200', ''], ['7700', '4840d6']]);
});
