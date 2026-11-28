// FORK: Site Survey (dsp/survey.ts, src/site-survey.ts): a span learned with two signals; watching, a third appears as a
// new emitter at its frequency, a stopped one is listed as gone, a gain change raises nothing; the site's JSON round
// trip and its report; the worker hands a pass over on each retune.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpanAccum, SurveyProcessor, type SurveyPass } from '../src/dsp/survey.js';
import { SiteSurvey } from '../src/site-survey.js';

const RATE = 2_000_000, C = 433_920_000;
function pass(tones: [number, number][], gain = 1, seconds = 1.5, seed = 1): SurveyPass {
  const a = new SpanAccum(C, RATE), B = 100_000, buf = new Float32Array(2 * B);
  let s = seed; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; const u = s / 2 ** 32 + 1e-12; s = (s * 1664525 + 1013904223) >>> 0; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s / 2 ** 32); };
  for (let o = 0; o < seconds * RATE; o += B) {
    for (let i = 0; i < B; i++) { const t = (o + i) / RATE; let x = g(), y = g(); for (const [hz, amp] of tones) { x += amp * Math.cos(2 * Math.PI * hz * t); y += amp * Math.sin(2 * Math.PI * hz * t); } buf[2 * i] = gain * x; buf[2 * i + 1] = gain * y; }
    a.push(buf, B);
  }
  return a.pass();
}
const BASE: [number, number][] = [[-400e3, 2], [250e3, 1]];   // two signals always there (+~30 and +~24 dB)

test('learning, then a new emitter at its frequency; a gain change and the same signals raise nothing; a stopped one is gone', () => {
  const site = new SiteSurvey('test site', 0);
  site.add(pass(BASE, 1, 1.5, 1), 1); site.add(pass(BASE, 1, 1.5, 2), 2);
  assert.equal(site.passesOf(C, RATE), 2);
  const base = site.toJSON().spans[0], be = site.baselineEmitters(base);
  assert.deepEqual(be.map(e => Math.round((e.hz - C) / 1e4)), [-40, 25], JSON.stringify(be));
  site.learning = false;
  assert.deepEqual(site.add(pass(BASE, 4, 1.5, 3), 3), []);               // 12 dB more gain: still nothing new
  const news = site.add(pass([...BASE, [610e3, 1.5]], 1, 1.5, 4), 4);      // a third signal
  assert.equal(news.length, 1, JSON.stringify(news));
  assert.ok(Math.abs(news[0].hz - (C + 610e3)) < 3e3 && news[0].relDb > 20, JSON.stringify(news[0]));
  assert.deepEqual(site.add(pass([...BASE, [610e3, 1.5]], 1, 1.5, 5), 5), []);   // seen again: counted, not raised again
  assert.equal(site.alertList()[0].passes, 2);
  const gone = site.gone(pass([BASE[0]], 1, 1.5, 6));
  assert.deepEqual(gone.map(e => Math.round((e.hz - C) / 1e4)), [25]);
});

test('the site JSON round trip and its printable report', () => {
  const site = new SiteSurvey('Warehouse <B>', 0);
  site.add(pass(BASE), 10); site.learning = false; site.add(pass([...BASE, [-700e3, 2]], 1, 1.5, 7), 20);
  const back = SiteSurvey.fromJSON(JSON.parse(JSON.stringify(site.toJSON())));
  assert.equal(back.learning, false); assert.equal(back.passesOf(C, RATE), 1); assert.equal(back.alertList().length, 1);
  const html = back.reportHtml(30);
  assert.match(html, /<title>RF site survey: Warehouse &lt;B&gt;<\/title>/);
  assert.match(html, /433\.220 \(/);                       // -700 kHz as a new emitter in the span row
  assert.match(html, /New emitters \(1\)/);
});

test('the worker processor sends the last span pass when it retunes', () => {
  const msgs: Record<string, unknown>[] = [], p = new SurveyProcessor(m => msgs.push(m));
  p.begin(C); p.reset(RATE);
  const iq = new Int8Array(2 * RATE); let s = 3; for (let i = 0; i < iq.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; iq[i] = (s >>> 25) - 64; }
  p.onIq(iq, RATE); p.onIq(iq, RATE);
  p.begin(C + 2e6);
  const sp = msgs.filter(m => m.type === 'surveyPass');
  assert.equal(sp.length, 1);
  assert.equal((sp[0].pass as SurveyPass).centreHz, C); assert.ok((sp[0].pass as SurveyPass).ticks >= 15)   // 2 s less the 0.25 s settle;
});
