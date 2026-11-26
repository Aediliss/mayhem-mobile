// FORK: APRS round trip: the Transmit app's AX.25 encoder -> Bell 202 AFSK -> FM -> int8 IQ -> AprsDecoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AprsDecoder } from '../src/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { addNoise, afsk, concat, feed, fmModulate, hold, silence, toInt8 } from './lib/iq.js';

const RATE = 960_000;          // 20 x 48 kHz: the decoder's channel decimator lands on 48 kHz exactly
const AUDIO = 48_000;

function packetIq(info: string, snrDb: number, offsetHz = 0): Int8Array {
  const bits = ax25Bits(ax25Aprs('N0CALL-9', info));
  const audio = afsk(bits, 1200, AUDIO, 1200, 2200);
  const iq = fmModulate(hold(audio, RATE / AUDIO), RATE, 3000, offsetHz);
  return toInt8(addNoise(concat(silence(RATE / 5), iq, silence(RATE / 5)), snrDb), 60);
}

function decode(iq: Int8Array): string[] {
  const lines: string[] = [];
  const d = new AprsDecoder(m => { if (m.type === 'packet') lines.push(m.line as string); });
  d.reset();
  feed(d, iq, RATE);
  return lines;
}

test('APRS: a clean packet decodes to the text that was encoded', () => {
  const info = '!4903.50N/07201.75W-Test 001';
  const lines = decode(packetIq(info, 30));
  assert.equal(lines.length, 1, `expected one packet, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^N0CALL-9>APZMHM/);
  assert.ok(lines[0].includes(info), lines[0]);
});

test('APRS: survives a 2 kHz carrier offset and 10 dB SNR', () => {
  const lines = decode(packetIq('>status text', 10, 2000));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0].includes('>status text'));
});

test('APRS: noise alone decodes nothing', () => {
  assert.deepEqual(decode(toInt8(addNoise(silence(RATE), 0, 7), 60)), []);
});

test('APRS: a frame with one corrupted byte is rejected by the FCS', () => {
  const frame = ax25Aprs('N0CALL-9', '>corrupt me');
  frame[20] ^= 0x04;                                     // flip one bit inside the info field, after the FCS was computed
  const audio = afsk(ax25Bits(frame), 1200, AUDIO, 1200, 2200);
  const iq = toInt8(concat(silence(RATE / 5), fmModulate(hold(audio, RATE / AUDIO), RATE, 3000), silence(RATE / 5)), 60);
  assert.deepEqual(decode(iq), []);
});
