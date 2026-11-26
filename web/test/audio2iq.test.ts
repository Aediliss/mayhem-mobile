// FORK: audio → IQ for the audio-in source: packets survive the trip into the real decoders, SSB lands on the right
// sideband, AM carries the audio on its envelope, and blocks join without seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioToIq, modForMode } from '../src/audiosrc/audio2iq.js';
import { AprsDecoder } from '../src/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { afsk, feed } from './lib/iq.js';

const A = 48_000;
const toneAudio = (hz: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / A));
function dftDb(iq: Int8Array, rate: number, hz: number, skip = 4096): number {
  let re = 0, im = 0; const n = (iq.length >> 1) - skip, w = -2 * Math.PI * hz / rate;
  for (let i = 0; i < n; i++) { const t = i + skip, c = Math.cos(w * t), s = Math.sin(w * t); re += iq[2 * t] * c - iq[2 * t + 1] * s; im += iq[2 * t] * s + iq[2 * t + 1] * c; }
  return 10 * Math.log10((re * re + im * im) / (n * n) + 1e-12);
}
const aprsAudio = (info: string, amp = 0.6) => {
  const a = afsk(ax25Bits(ax25Aprs('N0CALL-5', info)), 1200, A, 1200, 2200);
  const out = new Float32Array(a.length + A / 2); out.set(a.map(v => v * amp), A / 4); return out;
};
function decodeAprs(iq: Int8Array, rate: number, offsetHz = 0): string[] {
  const lines: string[] = [];
  const d = new AprsDecoder(m => { if (m.type === 'packet') lines.push(m.line as string); });
  d.reset(); d.offsetHz = offsetHz; feed(d, iq, rate); return lines;
}
function convertInBlocks(c: AudioToIq, audio: Float32Array, block: number): Int8Array {
  const parts: Int8Array[] = []; let n = 0;
  for (let i = 0; i < audio.length; i += block) { const p = c.push(audio.subarray(i, i + block), A); parts.push(p); n += p.length; }
  const out = new Int8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

test('modes: each worker mode gets the modulation its demodulator undoes', () => {
  assert.deepEqual(modForMode('USB'), { mod: 'usb', devHz: 0 }); assert.deepEqual(modForMode('CW'), { mod: 'usb', devHz: 0 });
  assert.deepEqual(modForMode('LSB'), { mod: 'lsb', devHz: 0 }); assert.deepEqual(modForMode('AM'), { mod: 'am', devHz: 0 });
  assert.deepEqual(modForMode('NFM'), { mod: 'fm', devHz: 3000 }); assert.deepEqual(modForMode('WFM'), { mod: 'fm', devHz: 75_000 });
  assert.deepEqual(modForMode('NONE'), { mod: 'fm', devHz: 3000 });
});

test('rate and continuity: one second of audio is one second of IQ, and blocks join exactly', () => {
  const audio = toneAudio(1000, A);
  const whole = new AudioToIq({ mod: 'fm', rate: 960_000 }).push(audio, A);
  assert.ok(Math.abs(whole.length / 2 - 960_000) <= 21, String(whole.length / 2));
  const blocks = convertInBlocks(new AudioToIq({ mod: 'fm', rate: 960_000 }), audio, 128);   // AudioWorklet block size
  assert.equal(blocks.length, whole.length);
  assert.deepEqual(blocks, whole);
});

test('FM: an APRS packet as audio decodes in the real APRS decoder, on-channel and at Ham Map\'s offset', () => {
  const info = '!4903.50N/07201.75W-audio in';
  const on = new AudioToIq({ mod: 'fm', rate: 960_000, devHz: 3000 });
  assert.deepEqual(decodeAprs(convertInBlocks(on, aprsAudio(info), 128), 960_000).map(l => l.includes(info)), [true]);
  const off = new AudioToIq({ mod: 'fm', rate: 2_000_000, devHz: 3000, offsetHz: -250_000 });   // LO 250 kHz above the channel
  assert.deepEqual(decodeAprs(off.push(aprsAudio(info), A), 2_000_000, -250_000).map(l => l.includes(info)), [true]);
});

test('levelling: a line-in 25 dB quieter still decodes', () => {
  const c = new AudioToIq({ mod: 'fm', rate: 960_000 });
  const lines = decodeAprs(c.push(aprsAudio('>quiet line', 0.033), A), 960_000);
  assert.equal(lines.length, 1); assert.ok(lines[0].includes('>quiet line'));
});

test('SSB: USB puts a 1 kHz tone at +1 kHz with the mirror 30 dB down; LSB the other way; offset moves it', () => {
  const tone = toneAudio(1000, A / 2);
  const usb = new AudioToIq({ mod: 'usb', rate: 96_000 }).push(tone, A);
  const lsb = new AudioToIq({ mod: 'lsb', rate: 96_000 }).push(tone, A);
  const u = [dftDb(usb, 96_000, 1000), dftDb(usb, 96_000, -1000)], l = [dftDb(lsb, 96_000, 1000), dftDb(lsb, 96_000, -1000)];
  assert.ok(u[0] - u[1] > 30, `USB: +1k ${u[0].toFixed(1)} dB, -1k ${u[1].toFixed(1)} dB`);
  assert.ok(l[1] - l[0] > 30, `LSB: -1k ${l[1].toFixed(1)} dB, +1k ${l[0].toFixed(1)} dB`);
  const moved = new AudioToIq({ mod: 'usb', rate: 96_000, offsetHz: 10_000 }).push(tone, A);
  assert.ok(dftDb(moved, 96_000, 11_000) - dftDb(moved, 96_000, 1000) > 30);
  assert.equal(new AudioToIq({ mod: 'usb', rate: 96_000 }).push(new Float32Array(4800), A).every(v => v === 0), true);   // silence is silence
});

test('AM: the audio rides on the envelope, around a steady carrier', () => {
  const iq = new AudioToIq({ mod: 'am', rate: 96_000 }).push(toneAudio(700, A / 2), A);
  const env = new Int8Array(iq.length);                       // |iq| - mean, as a "real" signal in I with Q = 0
  let mean = 0; for (let i = 0; i < iq.length; i += 2) mean += Math.hypot(iq[i], iq[i + 1]); mean /= iq.length / 2;
  for (let i = 0; i < iq.length; i += 2) env[i] = Math.round(Math.hypot(iq[i], iq[i + 1]) - mean);
  assert.ok(mean > 40 && mean < 60, `carrier ${mean}`);
  assert.ok(dftDb(env, 96_000, 700) - dftDb(env, 96_000, 1700) > 20);
});

test('SSB end to end: RTTY audio → USB IQ (int8, 960 ksps) → product detector → the real RTTY decoder reads the text', async () => {
  const { RttyDecoder } = await import('../src/dsp/ham/digital.js');
  const { baudot } = await import('../src/tx-encoders.js');
  // mark 2125 Hz, space 1955 Hz (RttyDecoder: space = mark - shift), 45.45 Bd, 1 start, 5 data LSB first, 1.5 stop
  const spb = A / 45.45, seg: [number, number][] = [[2125, A]];
  for (const c of baudot('CQ DE N0CALL K')) { seg.push([1955, spb]); for (let i = 0; i < 5; i++) seg.push([(c >> i) & 1 ? 2125 : 1955, spb]); seg.push([2125, 1.5 * spb]); }
  seg.push([2125, A / 2]);
  const n = Math.round(seg.reduce((s, [, d]) => s + d, 0)), audio = new Float32Array(n);
  let ph = 0, t = 0, edge = 0; for (const [f, d] of seg) { edge += d; while (t < edge && t < n) { ph += 2 * Math.PI * f / A; audio[t++] = 0.3 * Math.sin(ph); } }
  const iq = convertInBlocks(new AudioToIq({ mod: 'usb', rate: 960_000, offsetHz: 0 }), audio, 128);
  // USB product detector at the carrier: the in-phase part, low-passed by averaging 20 samples back to 48 kHz
  const back = new Float32Array(Math.floor(iq.length / 40));
  for (let i = 0; i < back.length; i++) { let s = 0; for (let k = 0; k < 20; k++) s += iq[2 * (i * 20 + k)]; back[i] = s / 20 / 127; }
  let text = ''; const d = new RttyDecoder(); d.onText = s => { text += s; }; d.reset();
  for (let i = 0; i < back.length; i += 480) d.push(back.subarray(i, i + 480), Math.min(480, back.length - i));
  assert.equal(text.trim(), 'CQ DE N0CALL K');
});

test('live audio in: a worker that falls behind gets at most LIVE_IN_FLIGHT buffers; the rest are dropped and counted', async () => {
  const { AudioRadio, LIVE_IN_FLIGHT } = await import('../src/audioradio.js');
  const posted: unknown[] = []; let fns: ((e: MessageEvent) => void)[] = [];
  const worker = { postMessage: (m: unknown) => { posted.push(m); }, addEventListener: (_t: 'message', f: (e: MessageEvent) => void) => { fns.push(f); }, removeEventListener: (_t: 'message', f: (e: MessageEvent) => void) => { fns = fns.filter(x => x !== f); } };
  let stopped = 0;
  const src = { kind: 'live' as const, label: 'test input', ctx: { sampleRate: A } as unknown as AudioContext, stream: { getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream };
  const r = new AudioRadio(src, worker, { onLog: () => {}, onStatus: () => {} }, { mode: () => 'NFM', channelHz: () => 0 });
  r.targetRateHz = 240_000;
  (worker.addEventListener as (t: 'message', f: (e: MessageEvent) => void) => void)('message', (r as unknown as { onMessage: (e: MessageEvent) => void }).onMessage);
  for (let i = 0; i < 20 * 8; i++) r.liveBlock(new Float32Array(128).fill(0.1));   // ~0.43 s of audio, nothing acked
  assert.equal(posted.length, LIVE_IN_FLIGHT);
  assert.ok(r.dropped > 0);
  for (const f of fns) f({ data: { type: 'iqAck' } } as MessageEvent);              // the worker catches up by one
  for (let i = 0; i < 8; i++) r.liveBlock(new Float32Array(128).fill(0.1));
  assert.equal(posted.length, LIVE_IN_FLIGHT + 1);
  assert.match(r.statusLine(), /blocks dropped/);
  (r as unknown as { cleanup(): void }).cleanup();
  assert.equal(stopped, 1);                                                           // the microphone is released
  assert.equal(fns.length, 0);
});
