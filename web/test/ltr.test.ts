// FORK: LTR Standard and LTR Passport: the checks against SDRTrunk's published per-bit tables, the word layouts, and
// the receiver on synthetic 300 bit/s sub-audible data under FM voice (carrier offset, noise, either polarity).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LTR_CHECK_TABLE, LtrRx, PASSPORT_CHECK_TABLE, encodeLtr, encodePassport, ltrCheck, ltrLine, ltrTg, parseLtr, parsePassport, passportCheck, type LtrMsg } from '../src/dsp/fleet/ltr.js';
import { awgn, concat, fmModulate, silence } from './lib/iq.js';

test('checks: the tables built from their generators equal SDRTrunk\'s published ones', () => {
  // SDRTrunk edac/CRCLTR.java and edac/CRCPassport.java (GPL-3.0; used here as test vectors only)
  const ltr = [0x38, 0x1C, 0x0E, 0x46, 0x23, 0x51, 0x68, 0x75, 0x7A, 0x3D, 0x1F, 0x4F, 0x26, 0x52, 0x29, 0x15, 0x0B, 0x45, 0x62, 0x31, 0x19, 0x0D, 0x07, 0x43];
  const passport = [0x6E, 0xBF, 0xD6, 0xE3, 0xF8, 0x7C, 0x3E, 0x97, 0xC2, 0xE9, 0x75, 0x3B, 0x94, 0x4A, 0xAD, 0x57, 0xA2, 0xD9, 0x6D, 0x37, 0x92, 0xC1, 0x61, 0x31,
    0x19, 0x0D, 0x07, 0x8A, 0xCD, 0x67, 0xBA, 0xD5, 0x6B, 0xBC, 0x5E, 0xA7, 0xDA, 0xE5, 0x73, 0xB0, 0x58, 0x2C, 0x16, 0x83, 0xC8, 0x64, 0x32, 0x91, 0x49, 0x25, 0x13];
  assert.deepEqual(Array.from(LTR_CHECK_TABLE), ltr);
  assert.deepEqual(Array.from(PASSPORT_CHECK_TABLE), passport);
});

test('words: LTR call, end and idle; Passport call, idle, radio and end; a flipped bit fails the check', () => {
  const call = encodeLtr({ area: 0, chan: 5, home: 5, group: 123, free: 7 });
  assert.ok(ltrCheck(call));
  assert.deepEqual(parseLtr(call), { std: 'ltr', kind: 'call', area: 0, chan: 5, home: 5, group: 123, free: 7 });
  assert.equal(ltrTg(parseLtr(call)), 5123);
  assert.equal(ltrLine(parseLtr(call)), 'CALL 0-05-123 · REPEATER 5 · FREE 7');
  assert.equal(parseLtr(encodeLtr({ area: 1, chan: 31, home: 5, group: 123, free: 7 })).kind, 'end');
  assert.equal(parseLtr(encodeLtr({ area: 0, chan: 7, home: 3, group: 255, free: 7 })).kind, 'idle');
  assert.equal(parseLtr(encodeLtr({ area: 0, chan: 25, home: 3, group: 1, free: 7 })).kind, 'other');
  for (const k of [9, 20, 33, 39]) { const bad = call.slice(); bad[k] ^= 1; assert.equal(ltrCheck(bad), false, `bit ${k}`); }

  const pc = encodePassport({ dcc: 1, lcn: 345, site: 17, group: 4242, type: 0, free: 350 });
  assert.ok(passportCheck(pc));
  assert.deepEqual(parsePassport(pc), { std: 'passport', kind: 'call', dcc: 1, lcn: 345, site: 17, group: 4242, type: 0, free: 350, radio: (17 << 16) | 4242 });
  assert.equal(parsePassport(encodePassport({ lcn: 1792, site: 17, group: 0, type: 1, free: 400 })).kind, 'idle');
  assert.equal(parsePassport(encodePassport({ lcn: 2047, site: 17, group: 4242, type: 1, free: 350 })).kind, 'end');
  const radio = parsePassport(encodePassport({ lcn: 0, site: 0, group: 0, type: 6, free: 350, radio: 1_234_567 }));
  assert.equal(radio.kind, 'unit'); assert.equal(radio.radio, 1_234_567);
  for (const k of [9, 30, 59, 67]) { const bad = pc.slice(); bad[k] ^= 1; assert.equal(passportCheck(bad), false, `bit ${k}`); }
});

const RATE = 24_000;                                      // Dispatch's channel rate
/**
 * A repeater's transmission as FM IQ: the words back to back as 300 bit/s NRZ at ±1 kHz (rounded a little, as a radio's
 * data filter does), a 1 kHz voice tone at 2.5 kHz on top, the carrier `offsetHz` off.
 */
export function ltrIq(words: Uint8Array[], o: { invert?: boolean; offsetHz?: number; voice?: number } = {}): Float32Array {
  const bits: number[] = [];
  for (const w of words) for (const b of w) bits.push(b ^ (o.invert ? 1 : 0));
  const spb = RATE / 300, n = Math.round(bits.length * spb) + RATE / 2, nrz = new Float32Array(n), m = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = Math.floor(i / spb); nrz[i] = k < bits.length ? (bits[k] ? 1 : -1) : -1; }
  const R = 24; let s = 0;                                 // a 1 ms moving average
  for (let i = 0; i < n; i++) { s += nrz[i] - (i >= R ? nrz[i - R] : 0); m[i] = (s / Math.min(i + 1, R)) * 1000 + (o.voice ?? 2500) * Math.sin(2 * Math.PI * 1000 * i / RATE); }
  return concat(silence(4000), fmModulate(m.map(v => v / 1000), RATE, 1000, o.offsetHz ?? 0), silence(4000));
}
export function receiveLtr(iq: Float32Array, fs = RATE): LtrMsg[] {
  const rx = new LtrRx(fs), out: LtrMsg[] = [];
  rx.onWord = m => out.push(m);
  const n = iq.length / 2, zi = new Float32Array(n), zq = new Float32Array(n);
  for (let i = 0; i < n; i++) { zi[i] = iq[2 * i]; zq[i] = iq[2 * i + 1]; }
  for (let o = 0; o < n; o += 2048) rx.push(zi.subarray(o, o + 2048), zq.subarray(o, o + 2048), Math.min(2048, n - o));
  return out;
}

test('receiver: LTR words under FM voice, with a carrier offset and noise, in either polarity', () => {
  const words = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => encodeLtr({ area: 0, chan: 5, home: 5, group: 100 + i, free: 7 }));
  for (const invert of [false, true]) for (const offsetHz of [0, 1800]) {
    const got = receiveLtr(awgn(ltrIq(words, { invert, offsetHz }), 10, 3));
    // the first word or two go to settling the slicer level on a carrier that has just come up
    assert.ok(got.length >= 8, `invert ${invert} offset ${offsetHz}: ${got.length} words`);
    for (const m of got) { assert.equal(m.std, 'ltr'); assert.equal((m as { chan: number }).chan, 5); }
    assert.deepEqual(got.map(m => (m as { group: number }).group), words.slice(10 - got.length).map((_, i) => 110 - got.length + i));
  }
});

test('receiver: Passport words decode too (both standards share the sync)', () => {
  const words = [0, 1, 2, 3, 4, 5].map(i => encodePassport({ lcn: 300 + i, site: 17, group: 4242, type: 0, free: 350 }));
  const got = receiveLtr(awgn(ltrIq(words, { offsetHz: -900 }), 10, 4));
  assert.ok(got.length >= 5, `${got.length} words`);
  for (const m of got) { assert.equal(m.std, 'passport'); assert.equal(m.kind, 'call'); }
});

test('receiver: noise and voice alone find nothing', () => {
  assert.deepEqual(receiveLtr(awgn(silence(480_000), 0, 8)), []);
  assert.deepEqual(receiveLtr(awgn(ltrIq([], { voice: 4000 }).subarray(0, 960_000), 15, 9)), []);
});

test('plug-in: the repeater learns its own LCN from the calls it names, go-to words for other repeaters do not move it', async () => {
  const { ltrPlugRx } = await import('../src/dsp/fleet/ltr-plugin.js');
  const rx = ltrPlugRx(24_000), w = (chan: number, group: number) => parseLtr(encodeLtr({ area: 0, chan, home: 3, group, free: 4 }));
  const ev = [w(3, 45), w(3, 45), w(3, 45), w(6, 12), w(3, 45), w(3, 45)].map(m => rx.events(m));
  const sys = (e: ReturnType<typeof rx.events>) => e.find(x => x.kind === 'system') as { ccLcn?: number; site?: string; planned?: boolean };
  assert.equal(sys(ev[0]).ccLcn, undefined);                 // not yet sure which repeater this is
  assert.deepEqual([sys(ev[5]).ccLcn, sys(ev[5]).site, sys(ev[5]).planned], [3, 'REPEATER 3', true]);
  const calls = ev.flatMap(e => e.filter(x => x.kind === 'call')) as { call: { lcn: number; tg: number; update: boolean } }[];
  assert.deepEqual(calls.map(c => [c.call.lcn, c.call.tg, c.call.update]), [[3, 3045, false], [3, 3045, true], [3, 3045, true], [6, 3012, false], [3, 3045, true], [3, 3045, true]]);
  const end = rx.events(parseLtr(encodeLtr({ area: 0, chan: 31, home: 3, group: 45, free: 4 }))).find(x => x.kind === 'end');
  assert.deepEqual(end, { kind: 'end', lcn: 3, text: 'CALL END 0-03-045 · REPEATER 3' });
  const again = rx.events(w(3, 45)).find(x => x.kind === 'call') as { call: { update: boolean } };
  assert.equal(again.call.update, false);                    // a new call after the end
  const pp = rx.events(parsePassport(encodePassport({ lcn: 1792, site: 17, group: 0, type: 1, free: 400 })));
  assert.deepEqual(pp[0], { kind: 'system', id: 'SITE 17', label: 'LTR PASSPORT · SITE 17', ccLcn: 3, site: 'LCN 3' });
});
