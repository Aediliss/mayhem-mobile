import test from 'node:test';
import assert from 'node:assert/strict';
import { HellDecoder, hellAudio, HELL_ROWS } from '../src/dsp/ham/hell.js';

/** Random text-like columns: runs of on pixels, as glyph strokes are. */
function columns(n: number, seed = 1): number[][] {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  return Array.from({ length: n }, () => { const c = new Array(HELL_ROWS).fill(0); if (rnd() < 0.7) { const a = Math.floor(rnd() * 12), b = a + 2 + Math.floor(rnd() * 6); for (let r = a; r < Math.min(HELL_ROWS, b); r++) c[r] = 1; } return c; });
}
/** The decoded pixel stream against the sent one, at the best alignment: the fraction of pixels wrong. */
function pixelErrors(sent: number[][], got: Float32Array[]): number {
  const tx = sent.flat(), rx = got.flatMap(c => Array.from(c, v => (v > 0.5 ? 1 : 0)));
  let best = 1;
  for (let off = 0; off + rx.length <= tx.length + 30; off++) {
    let bad = 0, n = 0; for (let i = 0; i < rx.length; i++) { const t = tx[off + i]; if (t === undefined) continue; if (t !== rx[i]) bad++; n++; }
    if (n > rx.length / 2) best = Math.min(best, bad / n);
  }
  return best;
}

test('Feld Hell: the keyed pixels come back as the picture (clean and through noise), at 245 pixels a second', () => {
  const R = 48000, sent = columns(220);
  for (const [snr, maxErr] of [[30, 0.02], [0, 0.08]] as const) {
    const a = hellAudio(sent, 980, R, 0.1);
    const sigma = Math.sqrt((0.1 * 0.1 / 2) / 10 ** (snr / 10) / (2500 / (R / 2)));
    let s = 7; for (let k = 0; k < a.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32; s = (s * 1664525 + 1013904223) >>> 0; a[k] += sigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2 ** 32); }
    const d = new HellDecoder(1000); let imgs = 0; d.onImage = img => { imgs++; assert.equal(img.height, 56); };
    d.push(a, a.length);
    const got = d.columns(150), err = pixelErrors(sent, got);
    assert.ok(err <= maxErr, `${snr} dB: ${(100 * err).toFixed(1)} % pixels wrong`);
    assert.ok(imgs > 30);
  }
});
