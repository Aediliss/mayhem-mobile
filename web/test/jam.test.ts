// FORK: jamming detection (dsp/jam.ts): barrage, carrier and sweep jammers raise alerts against a learned baseline;
// noise, short bursts and a carrier that was there all along do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JamDetector, JamProcessor, jamLine, type JamAlert } from '../src/dsp/jam.js';
import { EventAdapter } from '../src/export/event.js';

const RATE = 1_000_000, CENTRE = 433_920_000;
type Gen = (t: number) => [number, number];   // extra signal at time t (s)
function run(seconds: number, extra: Gen, noiseAt: (t: number) => number = () => 1, seed = 1): { alerts: JamAlert[]; det: JamDetector } {
  const det = new JamDetector(); det.learnS = 3; det.reset(RATE, CENTRE);
  const alerts: JamAlert[] = []; det.onAlert = a => alerts.push(a);
  let s = seed; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32 + 1e-12; s = (s * 1664525 + 1013904223) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s / 2 ** 32); };
  const B = 100_000, buf = new Float32Array(2 * B);
  for (let o = 0; o < seconds * RATE; o += B) {
    for (let i = 0; i < B; i++) { const t = (o + i) / RATE, a = noiseAt(t), [x, y] = extra(t); buf[2 * i] = a * g() + x; buf[2 * i + 1] = a * g() + y; }
    det.push(buf, B);
  }
  return { alerts, det };
}
const tone = (hz: number, amp: number, from: number, to: number): Gen => t => t >= from && t < to ? [amp * Math.cos(2 * Math.PI * hz * t), amp * Math.sin(2 * Math.PI * hz * t)] : [0, 0];
const none: Gen = () => [0, 0];
const closed = (a: JamAlert[], kind: string) => a.filter(x => x.kind === kind && x.endS !== null);

test('noise and short bursts (a sensor every 2 s, a 0.6 s key fob) raise nothing', () => {
  const bursts: Gen = t => { const ph = t % 2; return ph < 0.15 || (t > 9 && t < 9.6) ? [30 * Math.cos(2 * Math.PI * 150e3 * t), 30 * Math.sin(2 * Math.PI * 150e3 * t)] : [0, 0]; };
  assert.deepEqual(run(14, bursts).alerts, []);
  assert.deepEqual(run(14, none).alerts, []);
});

test('BARRAGE: the floor 12 dB up for 5 s opens an alert, and closes it after', () => {
  const { alerts } = run(14, none, t => t >= 5 && t < 10 ? 4 : 1);
  const b = closed(alerts, 'barrage');
  assert.equal(b.length, 1, JSON.stringify(alerts));
  assert.ok(Math.abs(b[0].startS - 5) < 0.4 && Math.abs(b[0].endS! - 10) < 0.4, JSON.stringify(b[0]));
  assert.ok(b[0].riseDb >= 10, JSON.stringify(b[0]));
  assert.ok(alerts.every(a => a.kind === 'barrage'), JSON.stringify(alerts));
});

test('CARRIER: a steady carrier 300 kHz up for 6 s is found at its frequency; one there all along is left alone', () => {
  const { alerts } = run(14, tone(300e3, 3, 5, 11));
  const c = closed(alerts, 'carrier');
  assert.equal(c.length, 1, JSON.stringify(alerts));
  assert.ok(Math.abs(c[0].hz - (CENTRE + 300e3)) < 2e3, `${c[0].hz}`);
  assert.ok(Math.abs(c[0].startS - 5) < 0.4 && c[0].peakDb >= 20, JSON.stringify(c[0]));
  assert.deepEqual(run(12, tone(-200e3, 3, 0, 99)).alerts, []);
});

test('SWEEP: a chirp across ±400 kHz (ten, and 27, times a second) raises a sweep alert over the band it covers', () => {
  const chirp: Gen = t => { if (t < 5 || t >= 10) return [0, 0]; const u = (t * 10) % 1, ph = 2 * Math.PI * (-400e3 * u + 400e3 * u * u) / 10; return [3 * Math.cos(ph), 3 * Math.sin(ph)]; };
  const { alerts } = run(14, chirp);
  const w = closed(alerts, 'sweep');
  assert.equal(w.length, 1, JSON.stringify(alerts));
  assert.ok(w[0].spanHz![0] < CENTRE - 250e3 && w[0].spanHz![1] > CENTRE + 250e3, JSON.stringify(w[0]));
  assert.ok(!alerts.some(a => a.kind === 'carrier'), JSON.stringify(alerts));  // a period that does not line up with the frames (37 ms)
  const odd: Gen = t => { if (t < 5 || t >= 10) return [0, 0]; const P = 0.037, u = (t / P) % 1, ph = 2 * Math.PI * (-400e3 * u + 400e3 * u * u) * P; return [3 * Math.cos(ph), 3 * Math.sin(ph)]; };
  assert.equal(closed(run(13, odd).alerts, 'sweep').length, 1);
});

test('the worker processor: int8 IQ, a log line and a jamAlert per alert, each band\'s baseline remembered', () => {
  const msgs: Record<string, unknown>[] = [], p = new JamProcessor(m => msgs.push(m));
  p.det.learnS = 2; p.retune(433_920_000, '433.92 MHz'); p.reset(RATE);
  let s = 5; const iq = (sec: number, amp: number) => { const a = new Int8Array(2 * RATE * sec); for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = Math.round(amp * ((s >>> 24) - 127.5) / 127.5); } return a; };
  p.onIq(iq(3, 20), RATE);                                    // learn
  p.retune(345_000_000, '345 MHz'); p.onIq(iq(3, 20), RATE);  // another band learns too
  p.retune(433_920_000, '433.92 MHz');                        // back: no learning again
  const learningAgain = () => msgs.filter(m => m.type === 'jam' && m.band === '433.92 MHz').slice(-1)[0];
  p.onIq(iq(1, 20), RATE); assert.equal(learningAgain().learning, false);
  p.onIq(iq(4, 80), RATE); p.onIq(iq(3, 20), RATE);          // the floor 12 dB up for 4 s
  const al = msgs.filter(m => m.type === 'jamAlert');
  assert.deepEqual(al.map(m => [(m.alert as JamAlert).kind, (m.alert as JamAlert).endS === null, m.band]), [['barrage', true, '433.92 MHz'], ['barrage', false, '433.92 MHz']]);
  const lines = msgs.filter(m => m.type === 'packet').map(m => m.line as string);
  assert.match(lines[0], /^JAMMING BARRAGE \(noise floor up\) · 433\.92 MHz · floor \+1\d dB$/);
  assert.match(lines[1], /^jamming ended: barrage · 433\.92 MHz · lasted 4 s/);
  // on the export bus: jam.alert events
  const ev = new EventAdapter().map(al[0], { app: 'jam', centerHz: 434_420_000 });
  assert.deepEqual([ev[0].kind, ev[0].text, (ev[0].data as Record<string, unknown>).kind], ['jam.alert', '433.92 MHz', 'barrage']);
  assert.equal(jamLine('915 MHz', { id: 1, kind: 'sweep', startS: 0, endS: null, hz: 0, riseDb: 0, peakDb: 31, spanHz: [905e6, 925e6] }), 'JAMMING SWEEP (swept signal) · 905.000–925.000 MHz · 31 dB over the floor');
});
