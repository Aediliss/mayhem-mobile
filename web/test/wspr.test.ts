import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WsprDecoder, WsprFrontEnd, wsprAudio, wsprData, wsprDeinterleave, wsprEncode, wsprPack, wsprStackDecode, wsprTones, wsprUnpack } from '../src/dsp/ham/wspr.js';

/** WSJT-X's own wsprsim (lib/wsprd, GPL-3.0), built and run: "wsprsim -cd MESSAGE" → data bytes and channel symbols. */
const REF: [string, string, string][] = [
  ['K1ABC FN42 37', 'F70C238B0D1940', '330020001020131222100323133220200032012322002232110233210221321222033030301210212032132003323032203020201023021112330231212221332000010320132222202332323320031222'],
  ['G4JNT IO90 23', 'F65C05F7FA95C0', '332000001020333222100121113022220030032302022210112033010001101220213212301010032010110223123010223002023203001312132231210201332220032322310220222132121120031022'],
  ['PJ4/K1ABC 37', 'F70C23810E99C0', '310220001022131020100123131220220230030322022010130031010003323222013010301210032032112203323030223022021023001310310031230021332000010120112222222132323102011022'],
  ['K1ABC/7 30', 'F70C238D4CF800', '330020001022111022100323133022200232032322022230130231030003303020033230301010012032110003103210203020021223021110330013210223112200010322112200202330103322031020'],
  ['<PJ4/K1ABC> FK52UD 37', '88247C69A2E680', '332022223002133202300303131220222012032300200010310013210203103000211010103230210010130021123032201202221203021310130211012201112222032122310020000310101100011202'],
];
const hex = (d: Uint8Array) => Array.from(d.slice(0, 7), b => b.toString(16).toUpperCase().padStart(2, '0')).join('');

test('packing and the 162 channel symbols equal wsprsim for all three message types', () => {
  for (const [msg, data, syms] of REF) {
    const p = wsprPack(msg); assert.ok(p, msg);
    assert.equal(hex(wsprData(p.n, p.m)), data, msg);
    assert.equal(Array.from(wsprTones(msg)!).join(''), syms, msg);
  }
});

test('unpacking gives the message back; a type 3 shows the call once it has been heard in full', () => {
  const hashes = new Map<number, string>();
  const un = (msg: string) => { const p = wsprPack(msg)!; return wsprUnpack(wsprData(p.n, p.m), hashes)?.text; };
  assert.equal(un('<PJ4/K1ABC> FK52UD 37'), '<...> FK52UD 37');
  for (const [msg] of REF.slice(0, 4)) assert.equal(un(msg), msg);
  assert.equal(un('<PJ4/K1ABC> FK52UD 37'), '<PJ4/K1ABC> FK52UD 37');
  assert.equal(un('K1ABC/12 33'), 'K1ABC/12 33');
  assert.equal(wsprPack('K1ABC FN42 35'), null);   // not a WSPR power
});

test('the stack decoder corrects errors in the soft symbols, and gives up on noise', () => {
  const p = wsprPack('K1ABC FN42 37')!, coded = wsprEncode(wsprData(p.n, p.m));
  let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const soft = coded.map(b => Math.max(0, Math.min(255, Math.round(128 + (b ? 1 : -1) * 35 + 32 * gauss()))));
  let errs = 0; for (let i = 0; i < 162; i++) if ((soft[i] > 128 ? 1 : 0) !== coded[i]) errs++;
  assert.ok(errs >= 10, `only ${errs} hard errors`);
  const d = wsprStackDecode(soft); assert.ok(d);
  assert.equal(wsprUnpack(d)?.text, 'K1ABC FN42 37');
  const noise = Uint8Array.from({ length: 162 }, () => Math.max(0, Math.min(255, Math.round(128 + 50 * gauss()))));
  const n = wsprStackDecode(noise); assert.ok(!n || !wsprUnpack(n));
});

/** A slot of 12 kHz USB audio: the signals start 1 s (+ dt) into the even minute. */
function slotAudio(sigs: { msg: string; hz: number; dt?: number; drift?: number; amp: number }[], noiseAmp: number, seed = 1): Float32Array {
  const R = 12_000, a = new Float32Array(R * 114);
  for (const g of sigs) {
    const x = wsprAudio(wsprTones(g.msg)!, g.hz, R, g.amp, g.drift ?? 0), at = Math.round((1 + (g.dt ?? 0)) * R);
    for (let i = 0; i < x.length && at + i < a.length; i++) a[at + i] += x[i];
  }
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let i = 0; i < a.length; i += 2) { const r = Math.sqrt(-2 * Math.log(rnd() + 1e-12)), t = 2 * Math.PI * rnd(); a[i] += noiseAmp * r * Math.cos(t); if (i + 1 < a.length) a[i + 1] += noiseAmp * r * Math.sin(t); }
  return a;
}
function baseband(audio: Float32Array, rate = 12_000): [Float32Array, Float32Array] {
  const i: number[] = [], q: number[] = [];
  const fe = new WsprFrontEnd(rate, (a, b) => { i.push(a); q.push(b); });
  fe.push(audio); fe.push(new Float32Array(rate));
  const skip = Math.round(fe.delayS * 375);
  return [Float32Array.from(i.slice(skip, skip + 114 * 375)), Float32Array.from(q.slice(skip, skip + 114 * 375))];
}
/** SNR in 2500 Hz, WSJT-X's reference bandwidth: a sine of amplitude A against white noise of variance s² at 12 kHz. */
const snr2500 = (A: number, s: number) => 10 * Math.log10((A * A / 2) / (s * s * 2500 / 6000));

test('three stations in one slot, one drifting, the weakest near -25 dB, all decode with their frequencies and DT', () => {
  const sigs = [
    { msg: 'K1ABC FN42 37', hz: 1450, amp: 0.02 },
    { msg: 'G4JNT IO90 23', hz: 1520, dt: 0.5, drift: 2, amp: 0.012 },
    { msg: 'PJ4/K1ABC 37', hz: 1575, dt: -0.3, amp: 0.0045 },
  ];
  const noise = 0.1, [id, qd] = baseband(slotAudio(sigs, noise));
  assert.ok(snr2500(0.0045, noise) < -25, `weakest ${snr2500(0.0045, noise).toFixed(1)} dB`);
  const dec = new WsprDecoder(); dec.budgetMs = 60_000;
  const got = dec.decodeBuffer(id, qd, Date.UTC(2026, 10, 27, 12, 4));
  const by = new Map(got.map(g => [g.text, g]));
  for (const s of sigs) {
    const g = by.get(s.msg); assert.ok(g, `${s.msg} not decoded; got ${JSON.stringify(got.map(x => x.text))}`);
    assert.ok(Math.abs(g.hz - s.hz) <= 1, `${s.msg} at ${g.hz} Hz`);
    assert.ok(Math.abs(g.dt - (s.dt ?? 0)) <= 0.3, `${s.msg} DT ${g.dt}`);
    assert.equal(g.utc, '1204');
  }
  assert.ok(Math.abs(by.get('G4JNT IO90 23')!.drift - 2) <= 1);
  assert.equal(got.length, 3);
});

test('noise alone decodes nothing', () => {
  const [id, qd] = baseband(slotAudio([], 0.1, 5));
  const dec = new WsprDecoder(); dec.budgetMs = 60_000;
  assert.deepEqual(dec.decodeBuffer(id, qd).map(g => g.text), []);
});

test('live: 48 kHz audio pushed as it comes decodes at the end of its slot (the clock stubbed)', () => {
  const R = 48_000, slotMs = 1_800_000_000_000 - (1_800_000_000_000 % 120_000), a = new Float32Array(R * 125);
  const x = wsprAudio(wsprTones('K1ABC FN42 37')!, 1500, R, 0.05);
  for (let i = 0; i < x.length; i++) a[R + i] += x[i];
  let s = 9; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] += (s / 2 ** 32 - 0.5) * 0.3; }
  const d = new WsprDecoder(), got: { slot: number; text: string; dt: number }[] = [];
  d.onDecodes = (list, slot) => { for (const g of list) got.push({ slot, text: g.text, dt: g.dt }); };
  let now = slotMs; const real = Date.now; Date.now = () => now;
  try { for (let o = 0; o < a.length; o += 4800) { now = slotMs + (o + 4800) / R * 1000; d.push(a.subarray(o, o + 4800), 4800); } }
  finally { Date.now = real; }
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].slot * 120_000, got[0].text], [slotMs, 'K1ABC FN42 37']);
  assert.ok(Math.abs(got[0].dt) <= 0.3, `DT ${got[0].dt}`);
});

// fixtures/wsjtx-wspr-150426_0918-375sps.ci16: WSJT-X's samples/WSPR/150426_0918.wav (WSJT-X, GPL-3.0; real off-air 20 m
// WSPR, a 2-minute slot of 12 kHz USB audio), put through WsprFrontEnd to the decoder's own 375 Hz complex baseband
// (1500 Hz at 0 Hz), 114 s, int16 interleaved I/Q. Source: https://sourceforge.net/p/wsjt/wsjtx/ (samples/WSPR).
test('the WSJT-X sample recording: seven stations, with plausible calls, locators, SNRs and DTs', () => {
  const b = readFileSync(new URL('../test/fixtures/wsjtx-wspr-150426_0918-375sps.ci16', import.meta.url));
  const n = b.length / 4, id = new Float32Array(n), qd = new Float32Array(n);
  for (let k = 0; k < n; k++) { id[k] = b.readInt16LE(4 * k) / 32768; qd[k] = b.readInt16LE(4 * k + 2) / 32768; }
  const d = new WsprDecoder(); d.budgetMs = 60_000;
  const got = d.decodeBuffer(id, qd, Date.UTC(2015, 3, 26, 9, 18));
  assert.deepEqual(got.map(g => g.text).sort(), ['DJ6OL JO52 37', 'KI7CI DM09 37', 'ND6P DM04 30', 'NM7J DM26 30', 'W3HH EL89 30', 'W5BIT EL09 17', 'WD4LHT EL89 30']);
  const nm7j = got.find(g => g.text.startsWith('NM7J'))!;
  assert.deepEqual([nm7j.utc, nm7j.hz], ['0918', 1503]);
  for (const g of got) { assert.ok(g.snr <= 0 && g.snr >= -30, `${g.text} ${g.snr} dB`); assert.ok(Math.abs(g.dt) <= 2.5, `${g.text} DT ${g.dt}`); }
});
