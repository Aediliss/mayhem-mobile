// FORK: Inmarsat Aero 10.5 kbps P-channel (dsp/aero105/), after JAERO (MIT): framing, interleaver, the continuous
// K = 7 code, the scrambler, signal-unit CRCs and the ACARS reassembly, from bits; then OQPSK IQ end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aero105Sync, FRAME_BITS, acarsSus, buildFrames, signalUnit, suCrc } from '../src/dsp/aero105/frame.js';

const msg = () => acarsSus(0xA1B2C3, 0x82, 1, 5, 'N512UA', 'H1', 'A', 'HELLO FROM 10.5K OVER THE PACIFIC');

test('signal-unit CRC is CRC-16/X-25 (check value 0x906E), sent low byte first', () => {
  assert.equal(suCrc(Array.from('123456789', c => c.charCodeAt(0)), 0, 9), 0x906E);
  const u = signalUnit([1, 2, 3]); assert.equal(u[10] | (u[11] << 8), suCrc(u));
});

test('bits: frames with an ACARS message read back, through either rail polarity and a one-bit shift', () => {
  const frames = [[], msg(), [], [], []] as number[][][];
  const bits = buildFrames(frames);
  for (const [flipA, flipB, shift] of [[1, 1, 0], [-1, 1, 0], [1, -1, 1], [-1, -1, 3]]) {
    const s = new Aero105Sync(), lines: string[] = [];
    s.reader.hz = 1_546_000_000; s.reader.onAcars = l => lines.push(l);
    let seed = 3; const n = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 2 ** 32 - 0.5) * 1.2; };
    const soft = new Float32Array(bits.length + shift);
    for (let i = 0; i < bits.length; i++) { const k = i + shift; soft[k] = (bits[i] ? 1 : -1) * ((k & 1) ? flipB : flipA) + n(); }
    for (let o = 0; o < soft.length; o += 777) s.push(soft.subarray(o, Math.min(soft.length, o + 777)));
    assert.deepEqual(lines, ['SAT 1546.000 ↑ N512UA  H1  blk A  ack NAK\nHELLO FROM 10.5K OVER THE PACIFIC'], `${flipA} ${flipB} ${shift}: ${s.reader.stats.units} units, ${s.reader.stats.badUnits} bad, ${s.frames} frames`);
    assert.ok(s.frames >= 3 && s.reader.stats.badUnits === 0);
  }
  void FRAME_BITS;
});

/** OQPSK at `rate`: bits alternate I, Q (Q half a symbol late), ±1, root raised cosine (roll-off 1), carrier `offHz`. */
function oqpsk(bits: Uint8Array, rate: number, offHz: number, snrDb: number, seed = 1): Int8Array {
  const Ts = 1 / 5250, nSym = bits.length >> 1, dur = nSym * Ts + 0.05, n = Math.round(dur * rate), out = new Int8Array(2 * n);
  const p = (t: number) => { // RRC, roll-off 1, unit symbol time
    const x = t / Ts; if (Math.abs(x) < 1e-9) return 4 / Math.PI;
    if (Math.abs(Math.abs(4 * x) - 1) < 1e-9) return (1 / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / 4) + (1 - 2 / Math.PI) * Math.cos(Math.PI / 4));
    return (4 * x * Math.cos(2 * Math.PI * x)) / (Math.PI * x * (1 - 16 * x * x));
  };
  let s = seed; const g = () => { let u = 0; while (!u) { s = (s * 1103515245 + 12345) >>> 0; u = s / 2 ** 32; } s = (s * 1103515245 + 12345) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s / 2 ** 32); };
  const sig = 30, nz = sig / Math.sqrt(2) * 10 ** (-snrDb / 20) * Math.sqrt(rate / 5250 / 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate - 0.02, k0 = Math.floor(t / Ts);
    let I = 0, Q = 0;
    for (let k = k0 - 4; k <= k0 + 5; k++) {
      if (k < 0 || k >= nSym) continue;
      I += (bits[2 * k] ? 1 : -1) * p(t - k * Ts); Q += (bits[2 * k + 1] ? 1 : -1) * p(t - k * Ts - Ts / 2);
    }
    I *= sig / 1.3; Q *= sig / 1.3;
    const ph = 2 * Math.PI * offHz * i / rate + 0.7, c = Math.cos(ph), sn = Math.sin(ph);
    out[2 * i] = Math.max(-127, Math.min(127, Math.round(I * c - Q * sn + nz * g())));
    out[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(I * sn + Q * c + nz * g())));
  }
  return out;
}

test('IQ end to end: OQPSK at 250 kS/s, a 3.2 kHz carrier error, Eb/N0 ≈ 9 dB: the ACARS message comes out', async () => {
  const { Aero105 } = await import('../src/dsp/aero105/aero105.js');
  const bits = buildFrames([[], [], msg(), [], [], [], []]);
  const rate = 250_000, iq = oqpsk(bits, rate, 3200, 9);
  const a = new Aero105(), lines: string[] = []; a.hz = 1_546_000_000; a.onAcars = l => lines.push(l);
  for (let o = 0; o < iq.length; o += 65536) a.onIq(iq.subarray(o, o + 65536), rate, 0);
  assert.ok(Math.abs(a.carrierHz - 3200) < 30, `carrier ${a.carrierHz}`);
  assert.deepEqual(lines, ['SAT 1546.000 ↑ N512UA  H1  blk A  ack NAK\nHELLO FROM 10.5K OVER THE PACIFIC'], `${a.sync.frames} frames, ${a.stats.units} units, ${a.stats.badUnits} bad, ber ${a.stats.ber}, lock ${a.rx.lock}`);
});

// fixtures/jaero-aero10k5-16000sps.cs8: 5.6 s of JAERO's samples/10.5k_sample.ogg (JAERO by Jonathan Olds, MIT; a real
// Inmarsat 10.5 kbps P-channel received as SSB audio), turned into complex baseband around its carrier and brought to
// 16 kS/s (int8). JAERO itself decodes these same three uplinks from it.
test('a real recording (JAERO\'s 10.5k sample): every signal unit checks, three ACARS uplinks — CPDLC, ATIS, ADS-C — read', async () => {
  const { readFileSync } = await import('node:fs');
  const { Aero105 } = await import('../src/dsp/aero105/aero105.js');
  const { parseAcarsLine } = await import('../src/acars-planes.js');
  const { parseArinc622, arinc622Summary } = await import('../src/dsp/arinc622.js');
  const iq = new Int8Array(readFileSync(new URL('../test/fixtures/jaero-aero10k5-16000sps.cs8', import.meta.url)));
  const a = new Aero105(), lines: string[] = []; a.hz = 1_546_000_000; a.onAcars = l => lines.push(l);
  for (let o = 0; o < iq.length; o += 16384) a.onIq(iq.subarray(o, o + 16384), 16_000, 0);
  assert.ok(a.sync.frames >= 6 && a.stats.badUnits === 0 && a.stats.units === 26 * a.sync.frames, `${a.sync.frames} frames, ${a.stats.units} units, ${a.stats.badUnits} bad`);
  assert.deepEqual(lines.map(l => l.split('\n')[0]), ['SAT 1546.000 ↑ PH-BQI  AA  blk F  ack NAK', 'SAT 1546.000 ↑ A6-EDY  A9  blk T  ack NAK', 'SAT 1546.000 ↑ N914BA  H1  blk Q  ack NAK']);
  assert.match(lines[1], /EDDF ARR ATIS Z .*ILS Y APCH RWY 25R/);
  // the fork's ARINC 622 reader on what came down: a CPDLC uplink from Shanwick, an ADS-C contract request; CRCs good
  const [cp, , ads] = lines.map(l => parseAcarsLine(l, 0)!);
  const c = parseArinc622(cp.label, cp.text, false)!, d = parseArinc622(ads.label, ads.text, false)!;
  assert.deepEqual([c.app, c.gsAddr, c.reg, c.crcOk], ['cpdlc', 'PIKCPYA', 'PH-BQI', true]);
  assert.equal(arinc622Summary(c).summary, 'CPDLC message from PIKCPYA #1: THIS IS AN AUTOMATED MESSAGE TO CONFIRM CPDLC CONTACT WITH SHANWICK CENTER');
  assert.deepEqual([d.app, d.gsAddr, d.crcOk], ['adsc', 'PIKCPYA', true]);
  assert.equal(arinc622Summary(d).summary, 'ADS-C from PIKCPYA: periodic contract request #6 every 832 s + flight id, predicted route, earth reference data, meteo data');
});

// ---- the R and T channels (aircraft → ground bursts)

/** A short downlink split into R-channel units: sequence indicator / bytes, Q/ref with the user-data flag, AES, GES, data. */
function rUnits(aes: number, ges: number, q: number, ref: number, data: number[]): number[][] {
  const total = Math.ceil(data.length / 11), seqs = [[1], [2, 3], [4, 5, 6]][total - 1], out: number[][] = [];
  for (let i = 0; i < total; i++) {
    const part = data.slice(11 * i, 11 * i + 11);
    out.push([(seqs[i] << 4) | part.length, (q << 4) | 0x08 | ref, aes >> 16, (aes >> 8) & 255, aes & 255, ges, ...part]);
  }
  return out;
}

test('R and T packets: built, read back from soft bits with the right column count; a flipped bit fails', async () => {
  const { buildRt, decodeRt, rPacket, tPacket, RtReader } = await import('../src/dsp/aero105/burst.js');
  const { SuReader } = await import('../src/dsp/aero105/frame.js');
  const soft = (bits: Uint8Array, extra = 0) => { const s = new Float32Array(bits.length + extra); bits.forEach((b, i) => { s[i] = b ? 1 : -1; }); return s; };
  // a short ACARS downlink (≤ 33 bytes) in three R packets
  const odd = (c: number) => { let n = 0; for (let i = 0; i < 7; i++) n += (c >> i) & 1; return n % 2 === 0 ? c | 0x80 : c; };
  const su = new SuReader(), lines: string[] = []; su.hz = 1_646_015_000; su.onAcars = l => lines.push(l);
  const rt = new RtReader(su);
  // a T packet: header and the same 0x71 / 0xC0 units as the P channel, here a downlink with text
  const units = acarsSus(0xA1B2C3, 0x82, 2, 6, 'N512UA', 'H1', 'B', 'M01AUA0901POS N4030.0W07015.0').map(u => u.slice(0, 10));
  const tb = tPacket(0xA1B2C3, 0x82, units.map(u => signalUnit(u)));
  const cols = 5 + 3 * (units.length - 1), t = decodeRt(soft(buildRt(tb, cols), 300))!;
  assert.ok(t && t.kind === 'T' && t.aes === 0xA1B2C3 && t.ges === 0x82 && t.units.length === units.length);
  rt.packet(t);
  assert.deepEqual(lines, ['SAT 1646.015 ↓ N512UA  H1  blk B  ack NAK  #M01A UA0901\nPOS N4030.0W07015.0']);
  // R packets: a signalling unit is counted and not read; user data comes back together across three
  const r1 = decodeRt(soft(buildRt(rPacket([0x22, 0x01, 0xA1, 0xB2, 0xC3, 0x82]), 5)))!;
  assert.equal(r1.kind, 'R');
  const body = [0xFF, 0xFF, 0x01, ...[..."2", ...'.N512UA', '\x15', ...'Q0', '2', '\x02', ...'M02AUA0901HI', '\x03'].map(c => odd(c.charCodeAt(0))), 0x00, 0x00, 0x7F];
  for (const u of rUnits(0xA1B2C3, 0x82, 1, 3, body.slice(0, 33))) { const p = decodeRt(soft(buildRt(rPacket(u), 5)))!; assert.equal(p.kind, 'R'); rt.packet(p); }
  rt.packet(r1);
  assert.equal(rt.stats.rPackets, 4);
  assert.equal(lines[1], 'SAT 1646.015 ↓ N512UA  Q0  blk 2  ack NAK  #M02A UA0901\nHI');
  // one coded bit in eight wrong is mended by the code (a stretch would be too: the interleaver spreads it); one in three is not
  const mended = buildRt(tb, cols); for (let i = 0; i < mended.length; i += 8) mended[i] ^= 1;
  assert.equal(decodeRt(soft(mended))?.kind, 'T');
  const bad = buildRt(tb, cols); for (let i = 0; i < bad.length; i += 3) bad[i] ^= 1;
  assert.equal(decodeRt(soft(bad)), null);
});

// fixtures/jaero-aero10k5-bursts-16000sps.cs8: two bursts (0.7 s and 0.65 s) from JAERO's samples/10.5k_burst_sample.mp3
// (MIT), turned into complex baseband and brought to 16 kS/s.
test('real bursts (JAERO\'s 10.5k burst sample): two T packets, an ADS-C report from D-AIHV and a position from F-OFDF', async () => {
  const { readFileSync } = await import('node:fs');
  const { Aero105 } = await import('../src/dsp/aero105/aero105.js');
  const { parseAcarsLine } = await import('../src/acars-planes.js');
  const { msgInsight } = await import('../src/acars-insight.js');
  const iq = new Int8Array(readFileSync(new URL('../test/fixtures/jaero-aero10k5-bursts-16000sps.cs8', import.meta.url)));
  const a = new Aero105(), lines: string[] = []; a.hz = 1_646_000_000; a.onAcars = l => lines.push(l);
  for (let o = 0; o < iq.length; o += 16384) a.onIq(iq.subarray(o, o + 16384), 16_000, 0);
  assert.deepEqual([a.stats.bursts, a.stats.tPackets, a.stats.badBursts], [2, 2, 0]);
  assert.deepEqual(lines.map(l => l.split('\n')[0]), ['SAT 1646.000 ↓ D-AIHV  B6  blk 8  ack NAK  #J31A LH0424', 'SAT 1646.000 ↓ F-OFDF  H1  blk 7  ack NAK  #F37A TX0542']);
  const [ads, pos] = lines.map(l => msgInsight(parseAcarsLine(l, 0)!));
  // ADS-C (its own CRC checks): Lufthansa 424 over the North Atlantic at FL360, a waypoint change at 51°N 30°W
  assert.equal(ads.kind, 'adsc'); assert.ok(Math.abs(ads.pos!.lat - 51.0013) < 1e-3 && Math.abs(ads.pos!.lon + 30.0054) < 1e-3); assert.equal(ads.nums.altFt, 36000);
  assert.equal(pos.kind, 'pos'); assert.ok(Math.abs(pos.pos!.lat - 46.855) < 1e-3 && Math.abs(pos.pos!.lon + 22.2317) < 1e-3);
});

// ---- 600/1200 bps R/T bursts (MSK)

test('MSK bursts at 1200 and 600 bps: a T packet through noise and a carrier offset, read back; noise gives nothing', async () => {
  const { AeroMskBursts } = await import('../src/dsp/aero105/mskburst.js');
  const { buildRt, tPacket } = await import('../src/dsp/aero105/burst.js');
  const { fsk, addNoise, concat, silence, toInt8, feed } = await import('./lib/iq.js');
  const units = acarsSus(0xC078BD, 0x82, 3, 2, 'C-GGTS', 'H1', 'C', 'M02ATS0281POS N5000W03000').map(u => signalUnit(u.slice(0, 10)));
  const cols = 5 + 3 * (units.length - 1), coded = buildRt(tPacket(0xC078BD, 0x82, units), cols, true);
  for (const br of [1200, 600] as const) {
    // opening: carrier (constant frequency is not MSK: a run of ones), timing tone (1010…), then the UW and the block
    const bits: boolean[] = [];
    for (let i = 0; i < 100; i++) bits.push(true);
    for (let i = 0; i < 100; i++) bits.push(!!(i & 1));
    for (let m = 31; m >= 0; m--) bits.push(!!((0xE15AE893 >>> m) & 1));
    for (const b of coded) bits.push(!!b);
    const rate = 24_000, burst = fsk(bits, br, rate, br / 4, { offsetHz: 310 });
    const iq = toInt8(addNoise(concat(silence(rate / 2), burst, silence(rate / 2)), 14, 3), 50);
    const b = new AeroMskBursts(br), lines: string[] = []; b.hz = 1_646_015_000; b.onAcars = l => lines.push(l);
    feed(b, iq, rate, 16384);
    assert.deepEqual([b.bursts, b.rx.bad, b.rt.stats.tPackets], [1, 0, 1], `${br} bps`);
    assert.deepEqual(lines, ['SAT 1646.015 ↓ C-GGTS  H1  blk C  ack NAK  #M02A TS0281\nPOS N5000W03000'], `${br} bps`);
  }
  const quiet = new AeroMskBursts(1200), got: string[] = []; quiet.onAcars = l => got.push(l);
  feed(quiet, toInt8(addNoise(silence(48_000), 0, 9), 50), 24_000, 16384);
  assert.equal(got.length, 0); assert.equal(quiet.rt.stats.tPackets, 0);
});

// fixtures/jaero-aero1200-bursts-12000sps.cs8: the two bursts of JAERO's samples/1200bps_burst_sample2.wav (MIT), each
// ~2.15 s, as complex baseband at 12 kS/s. The ADS-C message spans both.
test('real 1200 bps bursts (JAERO\'s sample): two T packets put back together into an ADS-C report from 165831', async () => {
  const { readFileSync } = await import('node:fs');
  const { AeroMskBursts } = await import('../src/dsp/aero105/mskburst.js');
  const { parseAcarsLine } = await import('../src/acars-planes.js');
  const { msgInsight } = await import('../src/acars-insight.js');
  const iq = new Int8Array(readFileSync(new URL('../test/fixtures/jaero-aero1200-bursts-12000sps.cs8', import.meta.url)));
  const b = new AeroMskBursts(1200), lines: string[] = []; b.hz = 1_646_000_000; b.onAcars = l => lines.push(l);
  for (let o = 0; o < iq.length; o += 16384) b.onIq(iq.subarray(o, o + 16384), 12_000, 0);
  assert.deepEqual([b.bursts, b.rx.bad, b.rt.stats.tPackets], [2, 0, 2]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split('\n')[0], 'SAT 1646.000 ↓ 165831  H1  blk 1  ack NAK  #F79A MC4666');
  const i = msgInsight(parseAcarsLine(lines[0], 0)!);
  assert.equal(i.kind, 'adsc');   // the ADS-C reader takes it: its own CRC good
  assert.ok(i.pos, JSON.stringify(i));
});
