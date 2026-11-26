// FORK: DMR Tier III vendor blocks: Connect Plus (FID 0x06) and Hytera (FID 0x68) CSBKs parsed into the kinds Dispatch
// acts on, and through Dispatch's real engine: a Connect Plus control channel's grant lists a call, the voice header on
// another repeater teaches Dispatch which carrier that LCN is, and the system is labelled CONNECT PLUS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsbk, csbkLine } from '../src/dsp/fleet/csbk.js';
import { conPlusLsn } from '../src/dsp/fleet/csbk-vendor.js';
import { crcCcitt, DMR_CRC_MASK, dmrDataBurst } from '../src/dsp/fleet/codes.js';
import { lcBytes } from '../src/dsp/fleet/lc.js';
import { FleetProcessor } from '../src/dsp/fleet/fleet.js';
import { fmModulate, toInt8 } from './lib/iq.js';

/** A CSBK: opcode, feature set, then 64 payload bits given as [offset, width, value] from the first payload bit; CRC'd. */
function csbk(op: number, fid: number, fields: [number, number, number][]): Uint8Array {
  const b = new Uint8Array(12); b[0] = 0x80 | op; b[1] = fid;
  for (const [at, n, v] of fields) for (let i = 0; i < n; i++) if ((v / 2 ** (n - 1 - i)) & 1) { const p = 16 + at + i; b[p >> 3] |= 0x80 >> (p & 7); }
  const c = crcCcitt(b, 10) ^ DMR_CRC_MASK[3]; b[10] = c >> 8; b[11] = c & 255;
  return b;
}

test('Connect Plus: logical slot numbers map to repeater and slot as SDRTrunk reads them', () => {
  assert.equal(conPlusLsn(1), null);
  assert.deepEqual([2, 3, 4, 5, 6].map(r => conPlusLsn(r)), [{ lcn: 1, slot: 0 }, { lcn: 1, slot: 1 }, { lcn: 2, slot: 0 }, { lcn: 2, slot: 1 }, { lcn: 3, slot: 0 }]);
});

test('Connect Plus blocks: voice channel user is a grant; affiliation, registration, data grant, neighbors', () => {
  const g = parseCsbk(csbk(3, 0x06, [[0, 24, 1234567], [24, 24, 4321], [48, 5, 5]]), true);
  assert.equal(g.name, 'CON+ VOICE CHANNEL USER');
  assert.deepEqual([g.kind, g.trunk, g.group, g.dst, g.src, g.lpcn, g.slot], ['grant', 'CONNECT PLUS', true, 4321, 1234567, 2, 1]);
  assert.match(csbkLine(g), /talkgroup 4321.*source 1234567.*LCN 2 TS2/i);
  const a = parseCsbk(csbk(24, 0x06, [[0, 24, 777], [24, 24, 4321]]), true);
  assert.deepEqual([a.kind, a.unit, a.dst], ['affil', 777, 4321]);
  const r = parseCsbk(csbk(17, 0x06, [[0, 24, 888], [24, 24, 16776415]]), true);
  assert.deepEqual([r.kind, r.dst, r.name], ['unit', 888, 'CON+ REGISTRATION REQUEST']);
  const d = parseCsbk(csbk(6, 0x06, [[0, 24, 999], [24, 5, 6]]), true);
  assert.deepEqual([d.kind, d.dst, d.lcn], ['unit', 999, 3]);
  const n = parseCsbk(csbk(1, 0x06, [[0, 8, 3], [8, 8, 7], [16, 8, 0]]), true);
  assert.match(csbkLine(n), /neighbor sites 3, 7/i);
  assert.match(parseCsbk(csbk(44, 0x06, []), true).name, /^CON\+ CSBK/);
});

test('Hytera blocks: Aloha and Announcement carry the system code; the XPT preamble names caller, group and free repeater', () => {
  const sc = (1 << 14) | (5 << 7) | (2 << 2);                  // SMALL (7 network bits, 5 site bits): network 5, site 3
  const al = parseCsbk(csbk(25, 0x68, [[24, 16, sc]]), true);
  assert.deepEqual([al.kind, al.model, al.net, al.site], ['aloha', 'SMALL', 5, 3]);
  assert.equal(parseCsbk(csbk(40, 0x68, [[24, 16, sc]]), true).net, 5);
  const pre = parseCsbk(csbk(61, 0x68, [[1, 1, 1], [16, 4, 3], [24, 16, 601], [48, 16, 1201]]), true);
  assert.deepEqual([pre.kind, pre.trunk, pre.group, pre.dst, pre.src, pre.rest], ['xpt', 'HYTERA XPT', true, 601, 1201, 3]);
  const st = parseCsbk(csbk(10, 0x68, [[0, 4, 0]]), true);
  assert.match(csbkLine(st), /free repeater all busy/i);
  // other feature sets are left as they were
  assert.equal(parseCsbk(csbk(3, 0x08, []), true).kind, 'vendor');
});

// ---- Dispatch end to end: DMR 4FSK at 4800 symbols/s (dibit 01 → +3 … 11 → -3; ±1944 Hz outer deviation)

const RATE = 960_000, CENTER = 451_000_000, CC = 450_900_000, TRAFFIC = 451_150_000;
const LEVEL = [1, 3, -1, -3];                                 // dibit 00, 01, 10, 11
function fsk(bursts: Uint8Array[]): Float32Array {
  const sps = RATE / 4800, n = bursts.length * 144 * sps, m = new Float32Array(n);
  let k = 0; for (const d of bursts) for (const s of d) { const v = LEVEL[s] / 3; for (let i = 0; i < sps; i++) m[k++] = v; }
  // a little rounding of the symbol edges (a radio's shaping filter)
  const R = 60, out = new Float32Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += m[i] - (i >= R ? m[i - R] : 0); out[i] = acc / Math.min(i + 1, R); }
  return out;
}
function mix(...sig: [Float32Array, number][]): Float32Array {
  const n = Math.max(...sig.map(([m]) => m.length)), iq = new Float32Array(2 * n);
  for (const [m, off] of sig) { const x = fmModulate(m, RATE, 1944, off); for (let i = 0; i < x.length; i++) iq[i] += 0.4 * x[i]; }
  let seed = 7; for (let k = 0; k < iq.length; k++) { seed = (seed * 1103515245 + 12345) >>> 0; iq[k] += 0.02 * (seed / 2 ** 32 - 0.5); }
  return iq;
}

test('Dispatch: a Connect Plus grant lists the call, the voice header on the granted repeater maps the LCN to it', { timeout: 120_000 }, () => {
  // control channel: the grant (LCN 2 TS2 for TG 4321 from 1234567) on both slots, over and over
  const grant = csbk(3, 0x06, [[0, 24, 1234567], [24, 24, 4321], [48, 5, 5]]);
  const ccBursts: Uint8Array[] = []; for (let i = 0; i < 240; i++) ccBursts.push(dmrDataBurst(i & 1, 1, 3, grant));
  // the granted repeater: voice LC headers for that call on TS2, idle bursts on TS1
  const hdr = lcBytes({ group: true, dst: 4321, src: 1234567 }, 1), idle = new Uint8Array(12);
  const tBursts: Uint8Array[] = []; for (let i = 0; i < 240; i++) tBursts.push(i & 1 ? dmrDataBurst(1, 1, 1, hdr) : dmrDataBurst(0, 1, 9, idle));
  const iq = mix([fsk(ccBursts), CC - CENTER], [fsk(tBursts), TRAFFIC - CENTER]);
  const fleet = new FleetProcessor(null);
  const t0 = Date.UTC(2026, 10, 26, 12); let sent = 0;
  fleet.now = () => t0 + (sent / RATE) * 1000;
  fleet.centerHz = CENTER; fleet.reset(RATE);
  const i8 = toInt8(iq, 100), BUF = 131072;
  for (let o = 0; o < i8.length; o += BUF) { const b = i8.subarray(o, Math.min(i8.length, o + BUF)); fleet.onIq(b, RATE); sent += b.length / 2; }
  const snap = fleet.snapshot();
  const cc = snap.carriers.find(c => Math.abs(c.hz - CC) < 5_000);
  assert.ok(cc, `carriers: ${snap.carriers.map(c => (c.hz / 1e6).toFixed(4) + ' ' + c.cls + ' ' + c.role).join(', ')}`);
  assert.deepEqual([cc!.cls, cc!.role], ['DMR', 'control']);
  const sys = snap.systems.find(s => s.proto === 'DMR');
  assert.ok(sys); assert.equal(sys!.label, 'CONNECT PLUS · COLOR CODE 1');
  const call = snap.calls.find(c => c.tg === 4321);
  assert.ok(call, `calls: ${JSON.stringify(snap.calls.map(c => [c.tg, c.hz, c.slot]))}`);
  assert.deepEqual([call!.proto, call!.src, call!.slot], ['DMR', 1234567, 1]);
  assert.ok(Math.abs(call!.hz - TRAFFIC) < 5_000, `call at ${call!.hz}`);
});
