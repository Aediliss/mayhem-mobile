// FORK: FileRadio: every recording format is read, its metadata found, and a packet recorded in it decodes when the
// file is played through the same worker message path a radio uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseScale, hintsFromName, parseSigmfMeta, parseTxtSidecar, parseWavHeader, sigmfDatatype, toInt8Iq } from '../src/filesrc/formats.js';
import { openIqSource, type IqSource } from '../src/filesrc/open.js';
import { FileRadio, IN_FLIGHT, type WorkerLike } from '../src/fileradio.js';
import { AprsDecoder } from '../src/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { afsk, concat, fmModulate, hold, silence, toCs16, toCs8, toCu8, toWavIq } from './lib/iq.js';

const RATE = 960_000;
const INFO = '!4903.50N/07201.75W-FileRadio';

/** One APRS packet as float IQ (the same chain as aprs.roundtrip.test.ts), unit amplitude. */
function aprsIq(): Float32Array {
  const audio = afsk(ax25Bits(ax25Aprs('N0CALL-7', INFO)), 1200, 48_000, 1200, 2200);
  return concat(silence(RATE / 10), fmModulate(hold(audio, RATE / 48_000), RATE, 3000), silence(RATE / 10));
}
function toCf32(iq: Float32Array, bigEndian = false): Uint8Array {
  const out = new Uint8Array(iq.length * 4), dv = new DataView(out.buffer);
  for (let i = 0; i < iq.length; i++) dv.setFloat32(4 * i, iq[i] * 0.6, !bigEndian);
  return out;
}
const file = (bytes: Uint8Array | string, name: string) => new File([bytes], name);

/** A stand-in DSP worker: runs the APRS decoder on each buffer and acks it on the next tick, like dsp.worker.ts. */
class FakeWorker implements WorkerLike {
  lines: string[] = []; maxInFlight = 0; private inFlight = 0; private fns: ((e: MessageEvent) => void)[] = [];
  private readonly dec = new AprsDecoder(m => { if (m.type === 'packet') this.lines.push(m.line as string); });
  constructor(private readonly rate: number, private readonly ack = true) { this.dec.reset(); }
  postMessage(m: { type: string; buf: ArrayBuffer; ack?: boolean }): void {
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const b = new Int8Array(m.buf);
    setTimeout(() => { this.dec.onIq(b, this.rate); this.inFlight--; if (m.ack && this.ack) for (const f of this.fns) f({ data: { type: 'iqAck' } } as MessageEvent); }, 0);
  }
  addEventListener(_t: 'message', f: (e: MessageEvent) => void): void { this.fns.push(f); }
  removeEventListener(_t: 'message', f: (e: MessageEvent) => void): void { this.fns = this.fns.filter(x => x !== f); }
}

async function play(src: IqSource, speed = Infinity): Promise<{ w: FakeWorker; r: FileRadio; ms: number; logs: string[] }> {
  const w = new FakeWorker(src.meta.rate), logs: string[] = [];
  const r = new FileRadio(src, w, { onLog: l => logs.push(l), onStatus: () => {} });
  r.speed = speed;
  const t0 = performance.now(); await r.open(); await r.run();
  await new Promise(res => setTimeout(res, 20));
  return { w, r, ms: performance.now() - t0, logs };
}

// ---- metadata ----

test('file names: rtl_433, this app, gqrx, SDR# and HDSDR conventions', () => {
  assert.deepEqual(hintsFromName('g001_433.92M_250k.cu8'), { format: 'cu8', centerHz: 433_920_000, rate: 250_000 });
  assert.deepEqual(hintsFromName('20261126_101500_433.920MHz_2000k.c8'), { format: 'cs8', centerHz: 433_920_000, rate: 2_000_000 });
  assert.deepEqual(hintsFromName('gqrx_20260101_120000_433920000_2000000_fc.raw'), { format: 'cf32', centerHz: 433_920_000, rate: 2_000_000 });
  assert.equal(hintsFromName('SDRSharp_20260101_120000Z_433920000Hz_IQ.wav').centerHz, 433_920_000);
  assert.equal(hintsFromName('HDSDR_20260101_120000Z_433920kHz_RF.wav').centerHz, 433_920_000);
  assert.deepEqual(hintsFromName('mystery.bin'), {});
  assert.deepEqual(hintsFromName('quiet_960k_144.39M.c8'), { format: 'cs8', centerHz: 144_390_000, rate: 960_000 });
  assert.deepEqual(hintsFromName('pager_929.6125M_2M.cu8'), { format: 'cu8', centerHz: 929_612_500, rate: 2_000_000 });
});

test('sidecars: the Capture app\'s and Mayhem\'s .txt, SigMF datatypes', () => {
  // exactly what capture.ts writes
  assert.deepEqual(parseTxtSidecar('sample_rate=2000000\ncenter_frequency=433920000\nformat=c8 (signed int8 I,Q)\n'), { rate: 2_000_000, centerHz: 433_920_000, format: 'cs8' });
  assert.deepEqual(parseTxtSidecar('center_frequency=162000000\r\nsample_rate=500000\r\n'), { rate: 500_000, centerHz: 162_000_000 });
  assert.deepEqual(sigmfDatatype('ci16_le'), { format: 'cs16', bigEndian: false });
  assert.deepEqual(sigmfDatatype('cf32_be'), { format: 'cf32', bigEndian: true });
  assert.throws(() => sigmfDatatype('rf32_le'), /not complex/);
  const m = parseSigmfMeta(JSON.stringify({ global: { 'core:datatype': 'cu8', 'core:sample_rate': 250000, 'core:hw': 'RTL-SDR v4' }, captures: [{ 'core:sample_start': 10, 'core:frequency': 315e6, 'core:datetime': '2026-11-26T10:00:00Z' }] }), 1000);
  assert.equal(m.format, 'cu8'); assert.equal(m.rate, 250_000); assert.equal(m.centerHz, 315e6);
  assert.equal(m.dataOffset, 20); assert.equal(m.dataBytes, 980); assert.equal(m.datetime, '2026-11-26T10:00:00Z');
  assert.ok(m.notes.includes('hw: RTL-SDR v4'));
});

test('WAV: 16-bit, 8-bit and SDR# auxi centre frequency', () => {
  const w = toWavIq(new Float32Array([0.5, -0.5, 0.25, 0]), 2_400_000);
  const m = parseWavHeader(w, w.length);
  assert.deepEqual([m.format, m.rate, m.dataOffset, m.dataBytes], ['cs16', 2_400_000, 44, 8]);
  // add an SDR#-style auxi chunk before data: two SYSTEMTIMEs, then the centre frequency
  const aux = new Uint8Array(8 + 40), dv = new DataView(aux.buffer);
  aux.set([0x61, 0x75, 0x78, 0x69]); dv.setUint32(4, 40, true); dv.setUint32(8 + 32, 145_800_000, true);
  const withAux = new Uint8Array([...w.subarray(0, 36), ...aux, ...w.subarray(36)]);
  const m2 = parseWavHeader(withAux, withAux.length);
  assert.equal(m2.centerHz, 145_800_000); assert.equal(m2.dataOffset, 44 + 48);
  const mono = toWavIq(new Float32Array(4), 48000); mono[22] = 1;
  assert.throws(() => parseWavHeader(mono, mono.length), /channel/);
});

test('conversion to int8: every format, and the 16-bit / float gain', () => {
  const x = new Float32Array([0.5, -0.5, 0.1, 0]);
  assert.deepEqual(Array.from(toInt8Iq(toCs8(x, 100), 'cs8', false, 1)), [50, -50, 10, 0]);
  assert.deepEqual(Array.from(toInt8Iq(toCu8(x, 100), 'cu8', false, 1)), [50, -50, 10, 0]);
  assert.deepEqual(Array.from(toInt8Iq(toCs16(x, 10000), 'cs16', false, 0.01)), [50, -50, 10, 0]);
  assert.deepEqual(Array.from(toInt8Iq(toCf32(x), 'cf32', false, 100 / 0.6)), [50, -50, 10, 0]);
  assert.deepEqual(Array.from(toInt8Iq(toCf32(x, true), 'cf32', true, 100 / 0.6)), [50, -50, 10, 0]);
  // a quiet 16-bit recording is brought up to ~16 counts RMS rather than vanishing under >>8
  const quiet = toCs16(aprsIq(), 300);
  const s = chooseScale(quiet, 'cs16', false), q = toInt8Iq(quiet, 'cs16', false, s);
  let sq = 0; for (const v of q) sq += v * v;
  assert.ok(Math.abs(Math.sqrt(sq / q.length) - 16) < 3, `rms ${Math.sqrt(sq / q.length)}`);
  assert.equal(chooseScale(toCs8(x), 'cs8', false), 1);
});

// ---- choosing files ----

test('open: data + sidecar pairing, Mayhem upper-case names, and helpful errors', async () => {
  const c8 = toCs8(new Float32Array(400));
  let s = await openIqSource([file('sample_rate=500000\ncenter_frequency=162000000\n', 'AIS_0001.TXT'), file(c8, 'AIS_0001.C8')]);
  assert.deepEqual([s.name, s.meta.format, s.meta.rate, s.meta.centerHz, s.samples], ['AIS_0001.C8', 'cs8', 500_000, 162e6, 200]);
  s = await openIqSource([file(toCs16(new Float32Array(400)), 'X.C16'), file('sample_rate=250000\n', 'X.TXT')]);
  assert.equal(s.meta.format, 'cs16');
  await assert.rejects(openIqSource([file('x', 'only.txt')]), /pick the recording/);
  await assert.rejects(openIqSource([file('{}', 'a.sigmf-meta')]), /both files/);
  await assert.rejects(openIqSource([file(c8, 'noinfo.c8')]), /no sample rate/);
  s = await openIqSource([file(c8, 'noinfo.c8')], async w => (w === 'rate' ? 1_000_000 : 0));
  assert.equal(s.meta.rate, 1_000_000);
  await assert.rejects(openIqSource([file(c8, 'noinfo.c8')], async () => null), /cancelled/);
});

// ---- playback through the worker path ----

const FORMATS: [string, () => (File | string)[]][] = [
  ['.c8 + .txt (Capture)', () => [file(toCs8(aprsIq(), 60), 'cap.c8'), 'sample_rate=960000\ncenter_frequency=144390000\nformat=c8 (signed int8 I,Q)\n']],
  ['.cu8 (rtl_433 name)', () => [file(toCu8(aprsIq(), 60), 'g001_144.39M_960k.cu8')]],
  ['.C16 + .TXT (Mayhem)', () => [file(toCs16(aprsIq(), 1200), 'APRS.C16'), 'sample_rate=960000\ncenter_frequency=144390000\n']],
  ['gqrx .raw (cf32)', () => [file(toCf32(aprsIq()), 'gqrx_20260101_120000_144390000_960000_fc.raw')]],
  ['WAV IQ', () => [file(toWavIq(aprsIq(), RATE, 9000), 'SDRSharp_20260101_120000Z_144390000Hz_IQ.wav')]],
  ['SigMF ci16_le', () => [file(toCs16(aprsIq(), 9000), 'x.sigmf-data'), file(JSON.stringify({ global: { 'core:datatype': 'ci16_le', 'core:sample_rate': RATE, 'core:version': '1.0.0' }, captures: [{ 'core:sample_start': 0, 'core:frequency': 144.39e6 }] }), 'x.sigmf-meta')]],
];
for (const [label, make] of FORMATS) {
  test(`playback: an APRS packet recorded as ${label} decodes`, async () => {
    const parts = make();
    const files = parts.map(p => (typeof p === 'string' ? file(p, (parts[0] as File).name.replace(/\.[^.]+$/, '.txt')) : p));
    const src = await openIqSource(files);
    assert.equal(src.meta.rate, RATE);
    assert.equal(src.meta.centerHz, 144_390_000);
    const { w, r } = await play(src);
    assert.equal(r.position, src.samples, 'played to the end');
    assert.equal(w.lines.length, 1, JSON.stringify(w.lines));
    assert.ok(w.lines[0].includes(INFO), w.lines[0]);
    assert.ok(w.maxInFlight <= IN_FLIGHT, `in flight ${w.maxInFlight}`);
  });
}

test('pacing: real time takes as long as the recording; 8x about an eighth', async () => {
  const src = await openIqSource([file(toCs8(silence(RATE * 0.5)), 'quiet_960k_144.39M.c8')]);   // 0.5 s
  const t1 = await play(src, 1);
  assert.ok(t1.ms > 430 && t1.ms < 900, `1x took ${t1.ms.toFixed(0)} ms`);
  const t8 = await play(src, 8);
  assert.ok(t8.ms < 250, `8x took ${t8.ms.toFixed(0)} ms`);
});

test('tuning: inside the span the digital LO follows the app; outside, it plays as recorded and says so once', async () => {
  const src = await openIqSource([file(toCs8(silence(1000)), 'a_433.92M_250k.cs8')]);
  const logs: string[] = [];
  const r = new FileRadio(src, new FakeWorker(250_000), { onLog: l => logs.push(l), onStatus: () => {} });
  r.targetFreqHz = 161_975_000; r.targetFreqHz = 161_975_000;
  assert.equal(r.targetFreqHz, 433_920_000);                 // outside the span: plays as recorded
  r.targetFreqHz = 433_950_000;
  assert.equal(r.targetFreqHz, 433_950_000); assert.equal(r.mixHz, -30_000);   // inside: the digital LO follows
  r.targetRateHz = 2_000_000;
  assert.equal(r.targetRateHz, 250_000);
  assert.equal(logs.filter(l => l.includes('tunes')).length, 1);
  assert.equal(logs.filter(l => l.includes('Msps')).length, 1);
  assert.deepEqual(r.limits.rates, [[250_000, 250_000]]);
  assert.equal(r.limits.canTransmit, false);
});

test('digital LO: a packet recorded on-centre decodes in an app that parks its LO 250 kHz away (Ham Map / Ships)', async () => {
  const src = await openIqSource([file(toCs8(aprsIq(), 60), 'aprs_144.39M_960k.c8')]);
  const w = new FakeWorker(RATE), logs: string[] = [];
  // what the APRS app does: LO 250 kHz above the channel, decoder told the channel sits at -250 kHz
  const dec = (w as unknown as { dec: AprsDecoder }).dec; dec.offsetHz = -250_000;
  const r = new FileRadio(src, w, { onLog: l => logs.push(l), onStatus: () => {} });
  r.speed = Infinity; r.targetFreqHz = 144_390_000 + 250_000;
  await r.open(); await r.run(); await new Promise(res => setTimeout(res, 20));
  assert.equal(r.mixHz, -250_000);
  assert.equal(w.lines.length, 1, JSON.stringify(w.lines));
  assert.ok(w.lines[0].includes(INFO));
  assert.equal(logs.filter(l => l.includes('plays as recorded')).length, 0);
});

test('digital LO: without it, the same app setup hears nothing (so the test above is not vacuous)', async () => {
  const src = await openIqSource([file(toCs8(aprsIq(), 60), 'aprs_144.39M_960k.c8')]);
  const w = new FakeWorker(RATE);
  (w as unknown as { dec: AprsDecoder }).dec.offsetHz = -250_000;
  const r = new FileRadio(src, w, { onLog: () => {}, onStatus: () => {} });
  r.speed = Infinity;                                        // LO never moved off the recording's centre
  await r.open(); await r.run(); await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(w.lines, []);
});
