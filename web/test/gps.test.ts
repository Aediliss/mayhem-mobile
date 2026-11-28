// FORK: GPS L1 C/A monitor (dsp/gps/acq.ts): the codes against IS-GPS-200, acquisition of a synthetic sky (PRN,
// Doppler, code phase, C/N0) with a radio clock 18 kHz off, noise alone, and the spoofing flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GpsProcessor, GpsSearch, caCode, spoofFlags, GPS_FS, type GpsResult } from '../src/dsp/gps/acq.js';

test('C/A codes: the first 10 chips of PRN 1-10 as IS-GPS-200 Table 3-Ia lists them (octal), and the codes\' balance', () => {
  const want = ['1440', '1620', '1710', '1744', '1133', '1455', '1131', '1454', '1626', '1504'];
  for (let p = 1; p <= 10; p++) { const c = caCode(p); let v = 0; for (let i = 0; i < 10; i++) v = 2 * v + c[i]; assert.equal(v.toString(8), want[p - 1], `PRN ${p}`); }
  for (let p = 1; p <= 32; p++) { const ones = caCode(p).reduce((a, b) => a + b, 0); assert.equal(ones, 512, `PRN ${p}`); }   // Gold codes: 512 ones, 511 zeros
});

interface Sat { prn: number; cn0: number; dop: number; chips: number }
function sky(sats: Sat[], clockHz: number, seed = 1): Float32Array {
  const n = 2048 * 20, x = new Float32Array(2 * n);
  let s = seed; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32 + 1e-12; s = (s * 1664525 + 1013904223) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s / 2 ** 32); };
  for (let i = 0; i < n; i++) { x[2 * i] = g(); x[2 * i + 1] = g(); }   // N0 = 2 / fs
  for (const st of sats) {
    const c = caCode(st.prn), A = Math.sqrt(2 * 10 ** (st.cn0 / 10) / GPS_FS), f = st.dop + clockHz;
    for (let i = 0; i < n; i++) {
      const chip = c[Math.floor(((i * 1.023e6 / GPS_FS) - st.chips + 1023 * 100) % 1023)] ? -1 : 1, ph = 2 * Math.PI * f * i / GPS_FS;
      x[2 * i] += A * chip * Math.cos(ph); x[2 * i + 1] += A * chip * Math.sin(ph);
    }
  }
  return x;
}
const search = (x: Float32Array, clock: number, wide: boolean) => { const s = new GpsSearch(x, clock, wide); while (!s.done) s.step(4); return s.result(); };

test('acquisition: five satellites (38-48 dB-Hz) with the radio\'s clock 18 kHz off: PRN, Doppler, code phase, C/N0', () => {
  const sats: Sat[] = [{ prn: 3, cn0: 48, dop: 2100, chips: 100.5 }, { prn: 7, cn0: 45, dop: -3400, chips: 512 }, { prn: 12, cn0: 43, dop: 600, chips: 900.25 },
    { prn: 21, cn0: 41, dop: -1200, chips: 33 }, { prn: 29, cn0: 38, dop: 3900, chips: 700 }];
  const r = search(sky(sats, 18_000), 0, true);
  assert.deepEqual(r.sats.map(s => s.prn).sort((a, b) => a - b), [3, 7, 12, 21, 29], JSON.stringify(r.sats));
  assert.ok(Math.abs(r.clockHz - 18_000) <= 1000, `clock ${r.clockHz}`);
  for (const s of sats) {
    const got = r.sats.find(x => x.prn === s.prn)!;
    assert.ok(Math.abs(got.dopplerHz + r.clockHz - (s.dop + 18_000)) <= 250, `PRN ${s.prn} Doppler ${got.dopplerHz} + ${r.clockHz}`);
    const dc = Math.abs(got.codeChips - s.chips); assert.ok(Math.min(dc, 1023 - dc) <= 0.6, `PRN ${s.prn} code ${got.codeChips}`);
    assert.ok(Math.abs(got.cn0 - s.cn0) <= 3.5, `PRN ${s.prn} C/N0 ${got.cn0} vs ${s.cn0}`);
  }
  assert.deepEqual(r.flags, []);
  // the narrow search around the clock found the same
  const r2 = search(sky(sats, 18_000, 2), r.clockHz, false);
  assert.ok(r2.sats.length >= 4, JSON.stringify(r2.sats));
});

test('noise alone finds nothing', () => {
  assert.deepEqual(search(sky([], 0, 3), 0, true).sats, []);
});

test('spoofing flags: uniform strong satellites; a PRN at two code phases', () => {
  const sats: Sat[] = [1, 5, 9, 14, 22].map((prn, i) => ({ prn, cn0: 62, dop: -2000 + 900 * i, chips: 150 * i + 10 }));
  sats.push({ prn: 5, cn0: 49, dop: 1200, chips: 800 });   // the real PRN 5 under the spoofer's
  const r = search(sky(sats, 0, 4), 0, false);
  const flags = r.flags.map(f => f.split(':')[0]);
  assert.deepEqual(flags, ['UNIFORM', 'STRONG', 'DOUBLE'], JSON.stringify(r));
  assert.ok(r.sats.find(s => s.prn === 5)!.second, JSON.stringify(r.sats));
  assert.deepEqual(spoofFlags([{ prn: 1, cn0: 45, dopplerHz: 0, codeChips: 0, ratio: 30 }, { prn: 2, cn0: 38, dopplerHz: 0, codeChips: 0, ratio: 7 }, { prn: 3, cn0: 50, dopplerHz: 0, codeChips: 0, ratio: 99 }, { prn: 4, cn0: 41, dopplerHz: 0, codeChips: 0, ratio: 12 }]), []);
});

test('the worker processor: int8 IQ at 2.048 MS/s, a snapshot, the search in slices, a result and a log line', () => {
  const x = sky([{ prn: 17, cn0: 47, dop: 1500, chips: 250 }, { prn: 24, cn0: 45, dop: -2500, chips: 600 }, { prn: 31, cn0: 44, dop: 300, chips: 10 }], 5000, 9);
  const iq = new Int8Array(x.length); for (let i = 0; i < x.length; i++) iq[i] = Math.max(-127, Math.min(127, Math.round(x[i] * 20)));
  const msgs: Record<string, unknown>[] = [], p = new GpsProcessor(m => msgs.push(m)); p.reset(GPS_FS); p.setClock(5000);
  for (let i = 0; i < 400 && !msgs.some(m => m.type === 'gps' && m.result); i++) p.onIq(iq, GPS_FS);
  const r = msgs.find(m => m.type === 'gps' && m.result)!.result as GpsResult;
  assert.deepEqual(r.sats.map(s => s.prn).sort(), [17, 24, 31]);
  assert.ok(msgs.some(m => m.type === 'gps' && typeof m.progress === 'number'));
  assert.match(msgs.find(m => m.type === 'packet')!.line as string, /^GPS: 3 satellites \(17 4\d, 24 4\d, 31 4\d dB-Hz\) · clock [45]\.\d kHz$/);
});
