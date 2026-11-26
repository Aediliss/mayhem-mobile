// FORK: Mode-S beyond extended squitter (dsp/modes.ts): the CRC and its syndromes, one and two bit repair, DF11
// interrogator codes, address / parity, the altitude and squawk codes, Comm-B inference, and end to end through the ADS-B
// decoder on synthetic 2 Msps pulse-position IQ (a Mode-S only aircraft included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModeS, SYN112, SYN56, ac13, id13, inferCommB, syndrome, withParity } from '../src/dsp/modes.js';
import { AdsbDecoder, CRC_TABLE, type Aircraft } from '../src/dsp/adsb.js';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));
/** A well-known public DF17 identification frame: KLM1023, address 4840D6. */
const KLM = '8D4840D6202CC371C32CE0576098';

test('CRC: the syndromes built from 0x1FFF409 equal upstream\'s per-bit table; a known frame is clean', () => {
  for (let i = 0; i < 88; i++) assert.equal(SYN112[i], CRC_TABLE[i], `bit ${i}`);
  for (let i = 0; i < 32; i++) assert.equal(SYN56[i], CRC_TABLE[i + 56], `short bit ${i}`);
  assert.equal(syndrome(hex(KLM), 112), 0);
});

test('DF17: any one bit wrong is repaired; two bits only for an aircraft already heard', () => {
  const ms = new ModeS(), clean = hex(KLM);
  for (let i = 5; i < 112; i++) {
    const b = clean.slice(); b[i >> 3] ^= 0x80 >> (i & 7);
    const f = ms.frame(b, 0); assert.equal(f?.via, 'fixed1', `bit ${i}`); assert.deepEqual(f!.bytes, clean);
  }
  const two = clean.slice(); two[3] ^= 0x10; two[9] ^= 0x02;
  assert.equal(new ModeS().frame(two, 0), null);                 // unknown address: not trusted
  const f = ms.frame(two, 1000); assert.equal(f?.via, 'fixed2'); assert.deepEqual(f!.bytes, clean);
});

test('DF11: the interrogator code rides in the parity; the address is taken from it', () => {
  const body = [0x5d, 0x48, 0x40, 0xd6];                         // DF11, CA 5, address 4840D6
  for (const iid of [0, 1, 15, 0x7f]) {
    const f = new ModeS().frame(withParity(body, 56, iid), 0);
    assert.deepEqual([f?.df, f?.icao, f?.iid], [11, '4840d6', iid]);
  }
  assert.equal(new ModeS().frame(withParity(body, 56, 0x1234), 0), null);
});

test('address / parity: a DF4 / DF5 / DF20 frame is taken only for an aircraft already heard', () => {
  const ms = new ModeS(), icao = 0x4840d6;
  const alt = (38_000 + 1000) / 25;                              // 25 ft code
  const ac13v = ((alt >> 5) << 7) | (((alt >> 4) & 1) << 5) | (1 << 4) | (alt & 15);   // M 0, Q 1
  const df4 = withParity([0x20, 0, (ac13v >> 8) & 0x1f, ac13v & 255], 56, icao);
  assert.equal(ms.frame(df4, 0), null);
  ms.frame(hex(KLM), 0);
  const f = ms.frame(df4, 10);
  assert.deepEqual([f?.via, f?.icao, f?.alt, f?.ground], ['ap', '4840d6', 38_000, false]);
});

test('altitude codes: 25 ft (Q set) and every Gillham 100 ft step decoded once', () => {
  // Q form: n = 1560 → 38000 ft
  const n = 1560, v = ((n >> 5) << 7) | (((n >> 4) & 1) << 5) | (1 << 4) | (n & 15);
  assert.equal(ac13(v), 38_000);
  // Gillham: over every code with M = Q = 0, each 100 ft altitude from -1000 to 62 700 ft comes out of exactly one code
  const seen = new Map<number, number>();
  for (let c = 0; c < 8192; c++) { if (c & 0b0000001010000) continue; const a = ac13(c); if (a !== undefined) seen.set(a, (seen.get(a) ?? 0) + 1); }
  for (let a = -1000; a <= 62_700; a += 100) assert.equal(seen.get(a), 1, `${a} ft`);
});

test('squawk codes: ID13 to four octal digits', () => {
  const enc = (sq: string) => {
    const [a, b, c, d] = sq.split('').map(Number), bit = (x: number, k: number) => (x >> k) & 1;
    const f = [bit(c, 0), bit(a, 0), bit(c, 1), bit(a, 1), bit(c, 2), bit(a, 2), 0, bit(b, 0), bit(d, 0), bit(b, 1), bit(d, 1), bit(b, 2), bit(d, 2)];
    return f.reduce((v, x) => v * 2 + x, 0);
  };
  for (const sq of ['7700', '7600', '7500', '1200', '2000', '0000', '7777', '4321']) assert.equal(id13(enc(sq)), sq);
});

/** A 56-bit Comm-B register from [bit (1-based), width, value] fields. */
function reg(fields: [number, number, number][]): Uint8Array {
  const r = new Uint8Array(7);
  for (const [at, n, v] of fields) for (let i = 0; i < n; i++) if ((v >> (n - 1 - i)) & 1) { const p = at - 1 + i; r[p >> 3] |= 0x80 >> (p & 7); }
  return r;
}

test('Comm-B: BDS 1,0 / 2,0 / 4,0 / 5,0 / 6,0 inferred from their bits; an empty or ambiguous register is not named', () => {
  assert.deepEqual(inferCommB(reg([[1, 8, 0x10], [17, 7, 3]])), { bds: '1,0', version: 3 });
  const cs = 'KLM1023 '.split('').map(c => c === ' ' ? 32 : c >= '0' && c <= '9' ? c.charCodeAt(0) : c.charCodeAt(0) - 64);
  assert.deepEqual(inferCommB(reg([[1, 8, 0x20], ...cs.map((c, i) => [9 + 6 * i, 6, c] as [number, number, number])])), { bds: '2,0', callsign: 'KLM1023' });
  // 4,0: MCP 36 000 ft, QNH 1013.2
  assert.deepEqual(inferCommB(reg([[1, 1, 1], [2, 12, 36_000 / 16], [27, 1, 1], [28, 12, 2132]])), { bds: '4,0', selAlt: 36_000, qnh: 1013.2 });
  // 5,0: roll 10.2°, track 45°, GS 420, TAS 410
  const r50 = inferCommB(reg([[1, 1, 1], [3, 9, 58], [12, 1, 1], [14, 10, 256], [24, 1, 1], [25, 10, 210], [46, 1, 1], [47, 10, 205]]));
  assert.deepEqual(r50, { bds: '5,0', roll: 10.2, trueTrack: 45, gs: 420, tas: 410 });
  // 6,0: heading 90°, IAS 250, Mach 0.6, baro -1024 ft/min
  const r60 = inferCommB(reg([[1, 1, 1], [3, 10, 512], [13, 1, 1], [14, 10, 250], [24, 1, 1], [25, 10, 150], [35, 1, 1], [36, 1, 1], [37, 9, 512 - 32]]));
  assert.deepEqual(r60, { bds: '6,0', hdg: 90, ias: 250, mach: 0.6, baroRate: -1024 });
  assert.equal(inferCommB(new Uint8Array(7)), null);
});

// ---- end to end through the ADS-B decoder

/** 2 Msps IQ of Mode-S frames: preamble pulses at 0, 1, 3.5, 4.5 µs, then pulse-position bits (1 = high then low). */
function ppm(frames: Uint8Array[]): Int8Array {
  const s: number[] = [];
  const gap = (n: number) => { for (let i = 0; i < n; i++) s.push(0, 0); };
  gap(400);
  for (const f of frames) {
    for (let i = 0; i < 16; i++) { const on = i === 0 || i === 2 || i === 7 || i === 9; s.push(on ? 100 : 0, 0); }
    for (let k = 0; k < f.length * 8; k++) { const b = (f[k >> 3] >> (7 - (k & 7))) & 1; s.push(b ? 100 : 0, 0, b ? 0 : 100, 0); }
    gap(300);
  }
  return Int8Array.from(s);
}

test('end to end: ADS-B, a DF4 altitude, a DF5 squawk, a DF20 Comm-B, and a Mode-S only aircraft from DF11 + DF5', () => {
  const out: Aircraft[][] = [];
  const dec = new AdsbDecoder(m => { if (m.type === 'aircraft') out.push(m.list as Aircraft[]); });
  const icao = 0x4840d6, other = 0xabc123;
  const alt = (37_000 + 1000) / 25, ac = ((alt >> 5) << 7) | (((alt >> 4) & 1) << 5) | (1 << 4) | (alt & 15);
  const sq = (s: string) => { const [a, b, c, d] = s.split('').map(Number), bit = (x: number, k: number) => (x >> k) & 1; return [bit(c, 0), bit(a, 0), bit(c, 1), bit(a, 1), bit(c, 2), bit(a, 2), 0, bit(b, 0), bit(d, 0), bit(b, 1), bit(d, 1), bit(b, 2), bit(d, 2)].reduce((v, x) => v * 2 + x, 0); };
  const df4 = withParity([0x20, 0, (ac >> 8) & 0x1f, ac & 255], 56, icao);
  const df5 = (id: number, code: string) => { const v = sq(code); return withParity([0x28, 0, (v >> 8) & 0x1f, v & 255], 56, id); };
  const mbv = reg([[1, 1, 1], [2, 12, 36_000 / 16], [27, 1, 1], [28, 12, 2132]]);
  const df20 = withParity([0xa0, 0, (ac >> 8) & 0x1f, ac & 255, ...mbv], 112, icao);
  const df11 = withParity([0x5d, other >> 16, (other >> 8) & 255, other & 255], 56, 0);
  dec.onIq(ppm([hex(KLM), hex(KLM), df4, df5(icao, '7700'), df20, df11, df11, df5(other, '1200')]));
  const list = out[out.length - 1], klm = list.find(a => a.icao === '4840d6'), ms = list.find(a => a.icao === 'abc123');
  assert.ok(klm, JSON.stringify(list));
  assert.deepEqual([klm!.flight, klm!.alt, klm!.squawk, klm!.selAlt, klm!.qnh, klm!.modeSOnly], ['KLM1023', 37_000, '7700', 36_000, 1013.2, false]);
  assert.ok(ms, 'the DF11 aircraft');
  assert.deepEqual([ms!.squawk, ms!.modeSOnly], ['1200', true]);
});

test('end to end: noise makes no aircraft', () => {
  const out: Aircraft[][] = [], dec = new AdsbDecoder(m => { if (m.type === 'aircraft') out.push(m.list as Aircraft[]); });
  let seed = 9; const iq = new Int8Array(2_000_000); for (let i = 0; i < iq.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; iq[i] = ((seed >>> 24) % 60) - 30; }
  dec.onIq(iq);
  assert.ok(out.every(l => l.length === 0));
});
