// FORK: analog FPV video (dsp/fpv.ts): the channel table, NTSC and PAL found and told apart in either polarity, off
// centre and in noise, the picture rebuilt from the sync pulses (bars in order), nothing from noise, a tone or OFDM, and
// the processor end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FPV_CHANNELS, FpvProcessor, buildField, compositeFm, discriminate, lookForVideo } from '../src/dsp/fpv.js';
import { buildBurst, buildFrame } from '../src/dsp/droneid.js';

const FS = 20e6;
let seed = 4; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const noisy = (x: Float32Array, snrDb: number) => { const s = Math.sqrt(Math.pow(10, -snrDb / 10) / 2); return x.map(v => v + s * g()); };

test('channel table: 48 channels in six bands, the published frequencies', () => {
  assert.equal(FPV_CHANNELS.length, 48); assert.equal(new Set(FPV_CHANNELS.map(c => c.name)).size, 48);
  const f = (n: string) => FPV_CHANNELS.find(c => c.name === n)!.hz / 1e6;
  assert.deepEqual([f('A1'), f('B1'), f('E1'), f('F1'), f('R1'), f('R8'), f('L1')], [5865, 5733, 5705, 5740, 5658, 5917, 5362]);
});

test('video found: NTSC and PAL, either polarity, off centre and at 10 dB; the picture comes out in order', () => {
  for (const [std, inv, snr] of [['NTSC', false, 30], ['PAL', true, 15], ['NTSC', true, 10], ['PAL', false, 10]] as const) {
    const v = discriminate(noisy(compositeFm(std, FS, 0.02, { invert: inv, offsetHz: 300e3 }), snr), FS), look = lookForVideo(v, FS);
    assert.equal(look.standard, std, `${std} ${inv ? 'inverted' : ''} ${snr} dB`);
    assert.equal(look.polarity, inv ? 1 : -1);
    const f = buildField(v, FS, look, 160)!;
    assert.ok(f && f.lines > 250, `${f?.lines} lines`);
    // eight bars, black to white: the middle rows' bars rise (averaged over 40 rows)
    const bars = Array.from({ length: 8 }, (_, b) => { let s = 0; for (let r = 60; r < 100; r++) s += f.pixels[r * 160 + b * 20 + 10]; return s / 40; });
    for (let b = 1; b < 8; b++) assert.ok(bars[b] > bars[b - 1] - 6, `${std} ${snr} dB bars ${bars.map(Math.round)}`);
    assert.ok(bars[7] - bars[0] > 150, `contrast ${bars.map(Math.round)}`);
  }
});

test('not video: noise, an FM tone, a DJI DroneID burst', () => {
  const noise = new Float32Array(2 * 400_000).map(() => g());
  assert.equal(lookForVideo(discriminate(noise, FS), FS).standard, null);
  const tone = new Float32Array(2 * 400_000); { let ph = 0; for (let i = 0; i < 400_000; i++) { ph += 2 * Math.PI * (1e6 * Math.sin(2 * Math.PI * 7000 * i / FS)) / FS; tone[2 * i] = Math.cos(ph); tone[2 * i + 1] = Math.sin(ph); } }
  assert.equal(lookForVideo(discriminate(tone, FS), FS).standard, null);
  const b = buildBurst(buildFrame({ serial: 'X', lat: 1, lon: 1, height: 1, altitude: 1, pilotLat: 1, pilotLon: 1, homeLat: 1, homeLon: 1 }));
  const ofdm = new Float32Array(2 * 400_000); for (let k = 0; k < 40; k++) ofdm.set(b.subarray(0, Math.min(b.length, ofdm.length - k * b.length)), k * b.length);
  assert.equal(lookForVideo(discriminate(noisy(ofdm, 20), FS), FS).standard, null);
});

test('processor: a look every quarter second with the channel tag, and the picture when watching', () => {
  const msgs: Record<string, unknown>[] = [], p = new FpvProcessor(m => msgs.push(m));
  p.reset(FS); p.tune('R3', true);
  const iq = Int8Array.from(compositeFm('PAL', FS, 0.6), v => Math.round(v * 90));
  for (let o = 0; o < iq.length; o += 262144) p.onIq(iq.subarray(o, o + 262144), FS);
  const looks = msgs.filter(m => m.type === 'fpvLook'), fields = msgs.filter(m => m.type === 'fpvField');
  assert.ok(looks.length >= 2 && looks.length <= 3, `${looks.length} looks`);
  assert.ok(looks.every(m => m.ch === 'R3' && m.standard === 'PAL'));
  assert.equal(fields.length, looks.length);
  const q: Record<string, unknown>[] = [], p2 = new FpvProcessor(m => q.push(m)); p2.reset(FS); p2.tune('A1', false);
  for (let o = 0; o < iq.length; o += 262144) p2.onIq(iq.subarray(o, o + 262144), FS);
  assert.equal(q.filter(m => m.type === 'fpvField').length, 0);    // scanning: no pictures
});
