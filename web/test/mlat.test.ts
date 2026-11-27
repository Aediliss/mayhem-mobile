// FORK: the MLAT feed: every Mode-S frame leaves with its time as a 12 MHz tick count from the radio's sample clock (as
// dump1090's free-running counter, which mlat-client reads with --input-type dump1090). Frames placed at known samples
// across several buffers (one straddling a buffer edge) come out exactly 6 ticks a sample apart at 2 MS/s; a gap the
// radio reports moves the clock on by the samples lost; the Beast output (through the export bus) carries the ticks and
// a signal byte; the clock starts again from zero on a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdsbDecoder } from '../src/dsp/adsb.js';
import { EventAdapter } from '../src/export/event.js';
import { beastFrame, hex, unhex } from '../src/export/formats.js';

const KLM = unhex('8d4840d6202cc371c32ce0576098');
/** 2 MS/s IQ (`n` samples) with a Mode-S frame starting (its first preamble pulse) at each of `at`. */
function ppmAt(n: number, at: number[], amp = 100): Int8Array {
  const s = new Int8Array(2 * n);
  const put = (i: number, on: boolean) => { if (on && i < n) s[2 * i] = amp; };
  for (const p of at) {
    for (let i = 0; i < 16; i++) put(p + i, i === 0 || i === 2 || i === 7 || i === 9);
    for (let k = 0; k < 112; k++) { const b = (KLM[k >> 3] >> (7 - (k & 7))) & 1; put(p + 16 + 2 * k, !!b); put(p + 17 + 2 * k, !b); }
  }
  return s;
}
function run(chunks: (Int8Array | number)[]) {
  const ts: number[] = [], sig: number[] = [], d = new AdsbDecoder(m => { if (m.type === 'modes') { ts.push(m.ts as number); sig.push(m.sig as number); } });
  for (const c of chunks) { if (typeof c === 'number') d.gap(c); else d.onIq(c, 2e6); }
  return { ts, sig, d };
}

test('a frame\'s time is 6 ticks a sample (12 MHz at 2 MS/s), across buffer edges', () => {
  const N = 65536, at = [1000, 20_000, N - 100, N + 5000, 3 * N - 300], all = ppmAt(4 * N, at);
  const chunks = [0, 1, 2, 3].map(k => all.subarray(2 * k * N, 2 * (k + 1) * N));
  const { ts, sig } = run(chunks);
  assert.deepEqual(ts, at.map(p => p * 6));
  assert.ok(sig.every(v => Math.abs(v - Math.round(100 / 128 * 255)) <= 2), `${sig}`);
});

test('a reported gap moves the clock on by the samples lost; a restart begins again at 0', () => {
  const N = 65536, a = ppmAt(N, [3000]), b = ppmAt(N, [7000]);
  const { ts, d } = run([a, 12_345, b]);
  // b's first sample follows a's last one plus the 12 345 that never arrived
  assert.deepEqual(ts, [3000 * 6, (N + 12_345 + 7000) * 6]);
  const out: number[] = []; const d2 = new AdsbDecoder(m => { if (m.type === 'modes') out.push(m.ts as number); });
  d2.onIq(a, 2e6); d2.reset(); d2.onIq(b, 2e6);
  assert.deepEqual(out, [3000 * 6, 7000 * 6]);
  void d;
});

test('the Beast output carries the ticks and the signal byte (mlat-client reads them as dump1090\'s clock)', () => {
  const ev = new EventAdapter().map({ type: 'modes', hex: '8d4840d6202cc371c32ce0576098', ts: 0x123456789a, sig: 0x50 }, { app: 'adsb', centerHz: 1_090_000_000 })[0];
  assert.deepEqual(ev.data, { ts: 0x123456789a, sig: 0x50 });
  assert.equal(hex(beastFrame(unhex(ev.hex!), Number(ev.data!.sig), Number(ev.data!.ts))), '1a33' + '00123456789a' + '50' + '8d4840d6202cc371c32ce0576098');
  // a tick count with 0x1a in it is escaped like any other byte
  assert.equal(hex(beastFrame(KLM, 0, 0x1a)), '1a33' + '00000000001a1a' + '00' + '8d4840d6202cc371c32ce0576098');
});
