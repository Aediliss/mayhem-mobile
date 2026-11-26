// FORK: voice recording: calls are cut where they start and stop (or change hands), and the WAV carries the tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSegmenter, type CallMeta, type VoiceSegment } from '../src/voice/segmenter.js';
import { encodeWav, readWav } from '../src/voice/wav.js';

const R = 48_000, BLOCK = 960;                              // 20 ms blocks
const tone = (ms: number, amp = 0.3) => Float32Array.from({ length: Math.round(R * ms / 1000) }, (_, i) => amp * Math.sin(2 * Math.PI * 800 * i / R));
const quiet = (ms: number, amp = 0.0005) => Float32Array.from({ length: Math.round(R * ms / 1000) }, (_, i) => amp * Math.sin(i));
const TG1: CallMeta = { key: 'tg1', label: 'TG 1 · unit 100', tg: 1, unit: 100 };
const TG2: CallMeta = { key: 'tg2', label: 'TG 2 · unit 200', tg: 2, unit: 200 };

/** Feed audio in 20 ms blocks, with the metadata a function of time; collect the finished calls. */
function run(seg: VoiceSegmenter, audio: Float32Array, metaAt: (ms: number) => CallMeta): VoiceSegment[] {
  const out: VoiceSegment[] = [];
  for (let i = 0; i < audio.length; i += BLOCK) { const b = audio.subarray(i, i + BLOCK), t = (i + b.length) / R * 1000; out.push(...seg.push(b, R, metaAt(t), t)); }
  return out;
}
const cat = (...a: Float32Array[]) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

test('two transmissions with a 3 s gap are two calls, each about as long as it was spoken', () => {
  const s = run(new VoiceSegmenter(), cat(quiet(1000), tone(2000), quiet(3000), tone(1500), quiet(3000)), () => TG1);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].startMs - 1000) <= 220, `start ${s[0].startMs}`);              // with up to 200 ms pre-roll
  const dur = (x: VoiceSegment) => x.samples.length / R * 1000;
  assert.ok(dur(s[0]) > 2000 && dur(s[0]) < 2600, `first ${dur(s[0])}`);
  assert.ok(dur(s[1]) > 1500 && dur(s[1]) < 2100, `second ${dur(s[1])}`);
  assert.equal(s[0].meta.label, 'TG 1 · unit 100');
});

test('a gap shorter than the hang time stays one call; a change of talkgroup splits at once', () => {
  assert.equal(run(new VoiceSegmenter(), cat(tone(1000), quiet(800), tone(1000), quiet(3000)), () => TG1).length, 1);
  const s = run(new VoiceSegmenter(), cat(tone(3000), quiet(3000)), ms => (ms < 1500 ? TG1 : TG2));
  assert.deepEqual(s.map(x => x.meta.key), ['tg1', 'tg2']);
});

test('blips are dropped; flush ends an open call; long calls are split', () => {
  assert.equal(run(new VoiceSegmenter(), cat(tone(200), quiet(3000)), () => TG1).length, 0);
  const seg = new VoiceSegmenter(); run(seg, tone(1500), () => TG1);
  assert.equal(seg.flush(1500, R).length, 1);
  assert.equal(run(new VoiceSegmenter({ maxMs: 1000 }), cat(tone(2500), quiet(3000)), () => TG1).length, 3);
});

test('WAV: 16-bit mono, INFO tags any tagger reads, samples intact', () => {
  const x = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const meta = { app: 'fleet', tg: 1234, unit: 5678, freqHz: 851_012_500 };
  const w = encodeWav(x, 8000, { INAM: 'TG 1234 · unit 5678', ICRD: '2026-11-26T10:00:00Z', ISFT: 'Mad Mobile', ICMT: JSON.stringify(meta) });
  const r = readWav(w);
  assert.deepEqual([r.rate, r.channels, r.bits], [8000, 1, 16]);
  assert.equal(r.info.INAM, 'TG 1234 · unit 5678'); assert.equal(r.info.ISFT, 'Mad Mobile');
  assert.deepEqual(JSON.parse(r.info.ICMT), meta);
  assert.deepEqual(Array.from(r.samples), [0, 16384, -16384, 32767, -32767]);
  assert.equal(new DataView(w.buffer).getUint32(4, true), w.length - 8);       // RIFF size covers the whole file
});
