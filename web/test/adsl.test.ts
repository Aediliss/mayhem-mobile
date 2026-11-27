// FORK: ADS-L (dsp/adsl/), against EASA's ADS-L 4 SRD-860 Issue 2: the spec's own bit-packing and exponential-encoding
// examples, the CRC-24 (the Mode-S code: an ADS-B frame's parity checks), XXTEA (the zero-key test vector, and the
// ADS-L 6-round scramble undone), then end to end: Traffic and Status packets built as a sender builds them, GFSK
// Manchester at 100 kchip/s on 868.2 and 868.4 MHz in one 2 MS/s span, through noise and a crystal offset, read back
// field for field; a damaged packet, a reserved key and plain noise give nothing; an OGN tracker's sync is counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adslLine, buildAdsl, crc24, expDecode, expEncode, getBits, parseAdsl, setBits, xxteaDecrypt, xxteaEncrypt, type AdslPacket } from '../src/dsp/adsl/frame.js';
import { AdslDecoder, ADSL_CENTRE_HZ, ADSL_RATE } from '../src/dsp/adsl/adsl.js';
import { addNoise, concat, feed, fsk, silence, toInt8 } from './lib/iq.js';

test('bit order (spec B.3 example 2): A = 0x12AA (14 bits), B = 0x355 (10 bits) → AA 52 D5 (10101010 01010010 11010101)', () => {
  const b = new Uint8Array(3); setBits(b, 0, 14, 0x12AA); setBits(b, 14, 10, 0x355);
  assert.deepEqual([...b], [0xAA, 0x52, 0xD5]);
  assert.deepEqual([getBits(b, 0, 14), getBits(b, 14, 10)], [0x12AA, 0x355]);
});

test('exponential encoding: the spec tables for altitude, ground speed and vertical rate', () => {
  const alt = (m: number) => expEncode(Math.max(0, m + 320), 12, false);
  assert.deepEqual([alt(-400), alt(0), alt(1000), alt(70000)], [0x0000, 0x0140, 0x0528, 0x3ffe]);
  assert.equal(expDecode(0x3ffe, 12, false) - 320, 61104);
  const gs = (ms: number) => expEncode(ms * 4, 6, false);
  assert.deepEqual([gs(0), gs(0.25), gs(0.75), gs(120), gs(300)], [0x00, 0x01, 0x03, 0xc4, 0xfe]);
  const vr = (ms: number) => expEncode(ms * 8, 6, true);
  assert.deepEqual([vr(0), vr(0.125), vr(-0.125), vr(10), vr(-10), vr(200), vr(-200)], [0x000, 0x001, 0x101, 0x048, 0x148, 0x0ff, 0x1fe]);
  assert.deepEqual([expDecode(0x148, 6, true) / 8, expDecode(0xc4, 6, false) / 4], [-10, 120]);
});

test('CRC-24 is the Mode-S parity (an ADS-B frame checks) and XXTEA matches the zero-key test vector', () => {
  const adsb = [0x8D, 0x48, 0x40, 0xD6, 0x20, 0x2C, 0xC3, 0x71, 0xC3, 0x2C, 0xE0];
  assert.equal(crc24(adsb), 0x576098);
  const v = new Uint32Array(2); xxteaEncrypt(v, 32);   // standard XXTEA: 6 + 52/n rounds
  assert.deepEqual([...v], [0x053704ab, 0x575d8c80]);
  const w = Uint32Array.from([1, 2, 3, 4, 5]), c = w.slice(); xxteaEncrypt(c); assert.notDeepEqual([...c], [...w]); xxteaDecrypt(c); assert.deepEqual([...c], [...w]);
});

const glider = { addr: 0xDD4A2B, amt: 6, traffic: { qs: 37, state: 2, category: 4, emergency: 1, lat: 46.512345, lon: 7.98765, altM: 2850, speedMs: 27.5, climbMs: 2.375, trackDeg: 213.75, nacp: 5, gva: 2, nacv: 2 } };

test('packets: Traffic and Status built, read back; a flipped bit and a reserved key', () => {
  const t = buildAdsl(glider);
  assert.equal(t[0], 24); assert.equal(t.length, 25);   // length 0x18, as the OGN wiki says
  const p = parseAdsl(t.subarray(1))!;
  assert.deepEqual([p.version, p.keyIndex, p.fec, p.crcOk, p.type, p.amt, p.addr, p.relay], [1, 0, false, true, 2, 6, 0xDD4A2B, false]);
  const r = p.traffic!;
  assert.ok(Math.abs(r.lat! - 46.512345) < 1 / 93206 && Math.abs(r.lon! - 7.98765) < 1 / 46603);
  assert.deepEqual([r.qs, r.state, r.category, r.emergency, r.altM, r.speedMs, r.climbMs, r.trackDeg], [37, 2, 4, 1, 2850, 27.5, 2.375, 213.75]);
  assert.match(adslLine(p, 868.2), /^ADSL 868\.2 FLARM DD4A2B · glider · 46\.51235, 7\.9876\d · 2850 m · 99 km\/h · 214° · \+2\.4 m\/s · airborne$/);
  const s = parseAdsl(buildAdsl({ addr: 0x3C6544, amt: 5, status: { maxVersion: 1, mband: 3, econTx: 0b10001, econRx: 0b1011, xpdr: 2 } }).subarray(1))!;
  assert.deepEqual([s.type, s.status!.maxVersion, s.status!.econTx, s.status!.xpdr], [3, 1, 0b10001, 2]);
  assert.match(adslLine(s, 868.4), /ICAO 3C6544 · status: protocol ≤ 1 · also sends FLARM, ADS-B · hears FLARM, PilotAware, OGN · Mode S transponder/);
  const bad = t.slice(1); bad[9] ^= 4; assert.equal(parseAdsl(bad), null);
  const clear = parseAdsl(buildAdsl({ ...glider, keyIndex: 3 }).subarray(1))!;   // key 3: scrambling off
  assert.equal(clear.traffic!.altM, 2850);
  const k1 = buildAdsl({ ...glider, keyIndex: 1 }); assert.equal(parseAdsl(k1.subarray(1))!.type, -1);
});

/** On the air (C.2): preamble 01×8 and 1001 1001 (not Manchester), then sync + packet Manchester-coded, 0 → 10, 1 → 01. */
function onAir(packet: Uint8Array, offsetHz: number, rate: number, amp = 1): Float32Array {
  const chips: boolean[] = [];
  for (let i = 0; i < 8; i++) chips.push(false, true);
  for (const c of '10011001') chips.push(c === '1');
  for (const b of [0x72, 0x4B, ...packet]) for (let i = 7; i >= 0; i--) { const v = (b >> i) & 1; chips.push(!v, !!v); }
  for (let i = 0; i < 8; i++) chips.push(false, true);
  return fsk(chips, 100_000, rate, 50_000, { bt: 0.5, offsetHz, amp });
}
/** Mix two spans (same length or padded) sample by sample. */
const mix = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(Math.max(a.length, b.length)); o.set(a); for (let i = 0; i < b.length; i++) o[i] += b[i]; return o; };

function run(iq: Int8Array) {
  const msgs: Record<string, unknown>[] = [], d = new AdslDecoder(m => msgs.push(m));
  d.centerHz = ADSL_CENTRE_HZ; d.reset(ADSL_RATE); feed(d, iq, ADSL_RATE);
  return { msgs, heard: msgs.filter(m => m.type === 'adsl') as { p: AdslPacket; mhz: number; offsetHz: number; levelDb: number }[], stats: msgs.filter(m => m.type === 'adslStats').pop() as { packets: number; ogn: number } | undefined };
}

test('end to end: a glider on 868.2, a status on 868.4, an ICAO-addressed aircraft with a 12 kHz crystal error, through noise', () => {
  const rate = ADSL_RATE, gap = silence(rate / 50);
  const a = onAir(buildAdsl(glider), -100_000, rate);
  const b = onAir(buildAdsl({ addr: 0x3C6544, amt: 5, status: { maxVersion: 1, econTx: 0b10000, xpdr: 2 } }), 100_000, rate);
  const c = onAir(buildAdsl({ addr: 0x3C6544, amt: 5, traffic: { ...glider.traffic, category: 1, lat: 50.0333, lon: 8.5706, altM: 900, emergency: 3, climbMs: -4 } }), 100_000 + 12_000, rate);
  // b and c overlap in time with a on the other channel
  const span = concat(gap, mix(a, concat(silence(2000), b)), gap, c, gap, gap);
  const { heard, msgs } = run(toInt8(addNoise(span, 12, 7), 60));
  assert.equal(heard.length, 3, msgs.filter(m => m.type === 'packet').map(m => m.line).join('\n'));
  const [g, ac, st] = heard.sort((x, y) => (x.p.type - y.p.type) || (x.mhz - y.mhz));
  assert.equal(g.mhz, 868.2); assert.equal(g.p.traffic!.altM, 2850); assert.ok(Math.abs(g.p.traffic!.lat! - 46.512345) < 2e-5);
  assert.equal(ac.mhz, 868.4); assert.equal(ac.p.traffic!.emergency, 3); assert.equal(ac.p.traffic!.climbMs, -4); assert.ok(Math.abs(ac.offsetHz - 12_000) < 3000, `${ac.offsetHz}`);
  assert.equal(st.p.status!.xpdr, 2);
  assert.ok(msgs.some(m => m.type === 'packet' && /MEDICAL EMERGENCY/.test(m.line as string)));
});

test('noise, and a packet with one bit flipped on the air, give nothing; an OGN tracker sync is counted, not read', () => {
  const rate = ADSL_RATE;
  assert.equal(run(toInt8(addNoise(silence(rate), 0, 3), 60)).heard.length, 0);
  const bad = buildAdsl(glider); bad[12] ^= 0x10;
  assert.equal(run(toInt8(addNoise(concat(silence(4000), onAir(bad, -100_000, rate), silence(rate / 10)), 15, 4), 60)).heard.length, 0);
  // OGN: preamble, then the sync 0x0AF3656C and 26 bytes, Manchester-coded the same way
  const chips: boolean[] = [];
  for (let i = 0; i < 8; i++) chips.push(false, true);
  for (const b of [0x0A, 0xF3, 0x65, 0x6C, ...Array.from({ length: 26 }, (_, i) => (i * 37 + 11) & 255)]) for (let i = 7; i >= 0; i--) { const v = (b >> i) & 1; chips.push(!v, !!v); }
  const o = run(toInt8(addNoise(concat(silence(4000), fsk(chips, 100_000, rate, 50_000, { bt: 0.5, offsetHz: 100_000 }), silence(1.5 * rate)), 15, 5), 60));
  assert.equal(o.heard.length, 0); assert.equal(o.stats!.ogn, 1);
});
