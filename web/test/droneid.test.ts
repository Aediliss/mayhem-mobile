// FORK: DJI DroneID (dsp/droneid.ts, dsp/lte-turbo.ts): the LTE pieces (CRC-24A, QPP, turbo code, rate matching), the
// frame CRC against the reference's table, the frame layout, and whole bursts through the receiver with noise,
// frequency offset and timing offset; noise and a burst too weak to decode give nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc24a, qpp, rateDematch, rateMatch, toBits, turboDecode, turboEncode } from '../src/dsp/lte-turbo.js';
import { DroneIdProcessor, DroneIdRx, buildBurst, buildFrame, frameCrc, parseFrame, DRONEID_RATE, type DroneIdFrame } from '../src/dsp/droneid.js';

test('LTE: CRC-24A check value, the K = 1408 interleaver, turbo code through rate matching, clean and at -1 dB', () => {
  assert.equal(crc24a(Array.from('123456789', c => c.charCodeAt(0))), 0xcde703);
  const p = qpp(1408, 43, 88); assert.equal(new Set(p).size, 1408); assert.deepEqual(Array.from(p.subarray(0, 4)), [0, 131, 438, 921]);
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const bits = toBits(Uint8Array.from({ length: 176 }, () => Math.floor(rnd() * 256)));
  const e = rateMatch(turboEncode(bits, 1408, 43, 88), 7200, 0);
  for (const snrDb of [99, -1]) {
    const sigma = Math.sqrt(Math.pow(10, -snrDb / 10));
    const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const llr = Float32Array.from(e, b => { const y = (b ? -1 : 1) + sigma * g(); return 2 * y / (sigma * sigma); });
    assert.deepEqual(turboDecode(rateDematch(llr, 1412, 0), 1408, 43, 88, 8), bits, `${snrDb} dB`);
  }
});

test('frame CRC-16 equals the reference\'s table (reflected 0x8408, initial 0x3692); the frame layout round trips', () => {
  // calculate_crc.m's table entries 1, 128 and 255 are the CRC of that byte from 0
  const entry = (i: number) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; return c; };
  assert.deepEqual([entry(1), entry(128), entry(255)], [0x1189, 0x8408, 0x0f78]);
  assert.equal(frameCrc([]), 0x3692);
  const fr = buildFrame({ serial: '1581F4QWD2210ABC', seq: 77, lat: 52.3676, lon: 4.9041, height: 120, altitude: 135, vNorth: 150, vEast: -320, vUp: 10, yaw: 9000, appTime: 1764158400000, pilotLat: 52.367, pilotLon: 4.903, homeLat: 52.3668, homeLon: 4.9028, productType: 63, uuid: 'abcdefghij' });
  const f = parseFrame(fr)!;
  assert.deepEqual([f.serial, f.seq, f.height, f.altitude, f.vNorth, f.vEast, f.vUp, f.yaw, f.appTime, f.productType, f.uuid, f.crcOk], ['1581F4QWD2210ABC', 77, 120, 135, 150, -320, 10, 9000, 1764158400000, 63, 'abcdefghij', true]);
  for (const [a, b] of [[f.lat, 52.3676], [f.lon, 4.9041], [f.pilotLat, 52.367], [f.pilotLon, 4.903], [f.homeLat, 52.3668], [f.homeLon, 4.9028]]) assert.ok(Math.abs(a! - b) < 1e-5, `${a} vs ${b}`);
  const bad = fr.slice(); bad[40] ^= 1; assert.equal(parseFrame(bad)!.crcOk, false);
});

const FRAME = buildFrame({ serial: '1581F4QWD2210ABC', seq: 5, lat: 52.3676, lon: 4.9041, height: 80, altitude: 95, pilotLat: 52.367, pilotLon: 4.903, homeLat: 52.3668, homeLon: 4.9028, productType: 63 });
/** A burst in noise at 15.36 MS/s: SNR over the whole band, frequency offset, a fraction of a sample of timing. */
function air(snrDb: number, cfoHz: number, frac: number, seed: number, burst = true): Int8Array {
  let r = seed; const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 2 ** 32; };
  const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const b = buildBurst(FRAME), pre = 30000, total = pre + b.length / 2 + 30000, x = new Float32Array(2 * total);
  const nz = 0.05 / Math.SQRT2, sig = 0.05 * Math.pow(10, snrDb / 20);
  for (let n = 0; n < total; n++) { x[2 * n] = nz * g(); x[2 * n + 1] = nz * g(); }
  if (burst) for (let n = 0; n < b.length / 2; n++) {
    // a fractional delay by linear interpolation between neighbours
    const i0 = n, i1 = Math.min(b.length / 2 - 1, n + 1), re = b[2 * i0] * (1 - frac) + b[2 * i1] * frac, im = b[2 * i0 + 1] * (1 - frac) + b[2 * i1 + 1] * frac;
    const k = pre + n, ph = 2 * Math.PI * cfoHz * k / DRONEID_RATE + 1.1, c = Math.cos(ph), s = Math.sin(ph);
    x[2 * k] += sig * (re * c - im * s); x[2 * k + 1] += sig * (re * s + im * c);
  }
  return Int8Array.from(x, v => Math.max(-127, Math.min(127, Math.round(v * 128))));
}
function receive(iq: Int8Array): { frames: DroneIdFrame[]; cfo: number[]; bursts: number } {
  const rx = new DroneIdRx(), frames: DroneIdFrame[] = [], cfo: number[] = [];
  rx.onFrame = (f, _r, info) => { frames.push(f); cfo.push(info.cfoHz); };
  for (let o = 0; o < iq.length; o += 262144) rx.push(iq.subarray(o, o + 262144));
  return { frames, cfo, bursts: rx.bursts };
}

test('receiver: bursts decode with noise, frequency offsets up to 40 kHz and fractional timing; the offset is measured', () => {
  for (const [snr, cfo, frac] of [[25, 0, 0], [15, 3500, 0.3], [8, -21_000, 0.6], [4, 40_000, 0.5], [1, 7000, 0.2]]) {
    const r = receive(air(snr, cfo, frac, 7 + snr));
    assert.equal(r.frames.length, 1, `${snr} dB, ${cfo} Hz`);
    assert.deepEqual([r.frames[0].serial, r.frames[0].height, r.frames[0].crcOk], ['1581F4QWD2210ABC', 80, true]);
    assert.ok(Math.abs(r.cfo[0] - cfo) < 500, `measured ${r.cfo[0]} for ${cfo}`);
  }
});

test('receiver: noise alone decodes nothing; a burst too weak to decode is seen but gives no frame', () => {
  const quiet = receive(air(0, 0, 0, 21, false));
  assert.deepEqual([quiet.frames.length, quiet.bursts], [0, 0]);
  const weak = receive(air(-9, 0, 0, 22));
  assert.equal(weak.frames.length, 0);
});

test('processor: frames to the page; a warning, not a decode, at the wrong sample rate', () => {
  const msgs: Record<string, unknown>[] = [], p = new DroneIdProcessor(m => msgs.push(m));
  p.reset(); p.onIq(air(15, 2000, 0.1, 31), DRONEID_RATE);
  assert.ok(msgs.some(m => m.type === 'droneid' && (m.frame as DroneIdFrame).serial === '1581F4QWD2210ABC'));
  const w: Record<string, unknown>[] = [], q = new DroneIdProcessor(m => w.push(m)); q.onIq(air(15, 0, 0, 32), 20e6);
  assert.deepEqual(w.map(m => m.type), ['log']);
});
