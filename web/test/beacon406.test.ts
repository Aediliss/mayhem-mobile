// FORK: 406 MHz distress beacons (dsp/beacon406/), ported from PortaPack Mayhem's EPIRB receiver (GPL-2.0-or-later).
// Frames from Mayhem's own list of reference and real beacon frames (sdcard/EPIRB/BEACONS.TXT) read as their titles
// say, the ADRASEC standard-location test frame at its documented position; a corrupted bit corrected, two not; and
// bursts end to end as the beacon sends them — 160 ms of carrier, then ±1.1 rad biphase-L at 400 bit/s (a little
// off, and off-frequency) — on two channels of the band, through noise; noise alone gives nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beaconLine, frameBits, parse406, valid406 } from '../src/dsp/beacon406/frame.js';
import { Beacon406Decoder, framesFromBits } from '../src/dsp/beacon406/beacon406.js';
import { B406_CENTRE_HZ } from '../src/dsp/beacon406/phy.js';

const hexBytes = (h: string) => h.match(/../g)!.map(x => parseInt(x, 16));
const ADRASEC = 'FFFED08E3E0425A8318074FE44B735CD7B46';   // "Standard Test; ADRASEC02 30/11/2014 N49d16m32s/E3d16m32s"

test('reference frames: protocol, country, ID, position, serials, emergencies, as Mayhem\'s list titles them', () => {
  const a = parse406(hexBytes(ADRASEC))!;
  assert.ok(valid406(a));
  assert.deepEqual([a.selfTest, a.protocol, a.countryName, a.id], [true, 'STD_TEST', 'France', '1C7C084B50FFBFF']);
  assert.ok(Math.abs(a.lat! - (49 + 16 / 60 + 32 / 3600)) < 1e-9 && Math.abs(a.lon! - (3 + 16 / 60 + 32 / 3600)) < 1e-9);
  const cases: [string, RegExp][] = [
    ['FFFED0A0D205F260850F3DC9E0B70B6E4FD7', /EPIRB · 41A40BE4C0FFBFF · Indonesia · EPIRB - MMSI \/ Location · 04°57'08"S 121°59'16"E/],   // "Standard Location Protocol EPIRB-MMSI"
    ['FFFED0A5DC19E1A07FDFFE5C803483E0FCCA', /SHIP · .* · Algeria · Ship Security Location · MMSI \(last 6 digits\) 106010/],   // "SSAS"
    ['FFFED096E3AAAAAA7FDFF8211F3583E0FAA8', /ELT · .* · USA · ELT-24-bit Address \/ Location · aircraft 24-bit address AAAAAA/],
    ['FFFED08E0D0990014710021963C85C7009F5', /RLS · .* · Spain · RLS Location Protocol/],
    ['FFFED09F7B00F9E8EC737E5312378A1802B0', /PLB · .* · Australia · PLB National Location · 35°44'20"S 115°29'36"E/],
    ['FFFED056E68040022021A4CDC675', /EPIRB · .* · USA · Serial User Protocol · Capsizing \(automatic\) · FF EPIRBs\/SN/],   // "EPIRB Emergency Capsizing"
    ['FFFE2FCE3000000000000DBD0E4022417500', /^406 ALERT · ORB · 9C6000000000001 · France · Orbitography Protocol$/],
  ];
  for (const [hex, re] of cases) { const b = parse406(hexBytes(hex))!; assert.ok(valid406(b), hex); assert.match(beaconLine(b), re); }
});

test('BCH: one wrong bit corrected, a frame with BCH errors in both fields not accepted', () => {
  const one = parse406(hexBytes('FFFED0D7E6202820000C29FF51041775302D'))!;   // "Selftest BCH1 ERR"
  assert.ok(valid406(one) && one.corrected);
  assert.equal(one.hex, 'FFFED0D6E6202820000C29FF51041775302D');
  assert.equal(valid406(parse406(hexBytes('FFFED0D7D6202820000C29FF51041745302D'))!), false);   // "3+2 ERR"
  assert.equal(valid406(parse406(hexBytes('FFFED03EF613523F81FE00'))!), false);   // "User protocol KO (wrong BCH1)"
});

/** A burst at `offHz` from 406.045 MHz: carrier for 160 ms, then the frame's bits as ±1.1 rad biphase-L at `bps`. */
function burst(hex: string, rate: number, offHz: number, bps = 400, amp = 25): Float32Array {
  const bits = frameBits(hex), Tb = rate / bps, n0 = Math.round(0.16 * rate), n = Math.round(n0 + bits.length * Tb + 0.02 * rate), out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    let th = 0;
    if (i >= n0) { const k = Math.floor((i - n0) / Tb); if (k < bits.length) { const first = (i - n0) - k * Tb < Tb / 2; th = (bits[k] ? 1 : -1) * (first ? 1.1 : -1.1); } }
    const ph = 2 * Math.PI * offHz * i / rate + th + 0.4;
    out[2 * i] = amp * Math.cos(ph); out[2 * i + 1] = amp * Math.sin(ph);
  }
  return out;
}

test('bursts end to end: two beacons on different channels, bit rates 1% apart, through noise; noise alone: nothing', () => {
  const rate = 2_000_000;
  let seed = 3; const g = () => { let u = 0; while (!u) { seed = (seed * 1103515245 + 12345) >>> 0; u = seed / 2 ** 32; } seed = (seed * 1103515245 + 12345) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * seed / 2 ** 32); };
  const a = burst(ADRASEC, rate, 406_040_000 - B406_CENTRE_HZ + 310, 403);
  const b = burst('FFFED0A0D205F260850F3DC9E0B70B6E4FD7', rate, 406_025_000 - B406_CENTRE_HZ - 220, 397);
  const gap = Math.round(0.3 * rate), total = gap + a.length / 2 + gap + b.length / 2 + gap, iq = new Int8Array(2 * total);
  const put = (x: Float32Array, at: number) => { for (let i = 0; i < x.length; i++) iq[2 * at + i] += Math.round(x[i]); };
  for (let i = 0; i < iq.length; i++) iq[i] = Math.round(6 * g());
  put(a, gap); put(b, gap + a.length / 2 + gap);
  const msgs: Record<string, unknown>[] = [], d = new Beacon406Decoder(m => msgs.push(m));
  for (let o = 0; o < iq.length; o += 131072) d.onIq(iq.subarray(o, o + 131072), rate);
  const got = msgs.filter(m => m.type === 'beacon406') as { b: { id: string; lat: number }; hz: number }[];
  assert.deepEqual(got.map(m => m.b.id), ['1C7C084B50FFBFF', '41A40BE4C0FFBFF'], msgs.filter(m => m.type === 'packet').map(m => m.line).join('\n'));
  assert.ok(Math.abs(got[0].hz - 406_040_310) < 30 && Math.abs(got[1].hz - 406_024_780) < 30, `${got.map(m => m.hz)}`);
  // noise
  const q: Record<string, unknown>[] = [], d2 = new Beacon406Decoder(m => q.push(m));
  const nz = Int8Array.from({ length: 2 * rate }, () => Math.round(6 * g()));
  for (let o = 0; o < nz.length; o += 131072) d2.onIq(nz.subarray(o, o + 131072), rate);
  assert.equal(q.filter(m => m.type === 'beacon406').length, 0);
  assert.equal(framesFromBits(new Array(144).fill(0)), null);
});

test('121.5 MHz homing: an AM tone sweeping 1600→300 Hz three times a second is found; a steady tone and noise are not', async () => {
  const { HomingDetector } = await import('../src/dsp/beacon406/homing.js');
  const rate = 250_000, secs = 3, n = rate * secs;
  let seed = 11; const g = () => { let u = 0; while (!u) { seed = (seed * 1103515245 + 12345) >>> 0; u = seed / 2 ** 32; } seed = (seed * 1103515245 + 12345) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * seed / 2 ** 32); };
  const am = (tone: (t: number) => number, off: number) => {
    const iq = new Int8Array(2 * n); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate; ph += 2 * Math.PI * tone(t) / rate;
      const a = 30 * (1 + 0.9 * Math.sin(ph)), c = 2 * Math.PI * off * t;
      iq[2 * i] = Math.round(a * Math.cos(c) + 4 * g()); iq[2 * i + 1] = Math.round(a * Math.sin(c) + 4 * g());
    }
    return iq;
  };
  const run = (iq: Int8Array) => { const out: { on: boolean; sweepHz: number[]; perS: number }[] = [], d = new HomingDetector(); d.onState = s => out.push(s); for (let o = 0; o < iq.length; o += 32768) d.onIq(iq.subarray(o, o + 32768), rate, 20_000); return out; };
  const sweep = (t: number) => 1600 - 1300 * ((t * 3) % 1);   // down from 1600 to 300 Hz, 3 times a second
  const s = run(am(sweep, 20_000)), on = s.filter(x => x.on);
  assert.ok(on.length > 0, JSON.stringify(s));
  const last = on[on.length - 1];
  assert.ok(last.sweepHz[0] >= 1400 && last.sweepHz[1] <= 500 && Math.abs(last.perS - 3) < 0.6, JSON.stringify(last));
  assert.equal(run(am(() => 1000, 20_000)).filter(x => x.on).length, 0);
  assert.equal(run(am(() => 0, 20_000)).filter(x => x.on).length, 0);
});
