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
