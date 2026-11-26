// FORK: SigMF from Capture, and the Capture -> replay round trip through upstream's real recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSize, sigmfArchive, sigmfFromSidecar, sigmfMeta, tarEntries, tarHeader, type SigmfCaptureInfo } from '../src/sigmf.js';
import { openIqSource } from '../src/filesrc/open.js';
import { FileRadio, type WorkerLike } from '../src/fileradio.js';
import { IqRecorder } from '../src/dsp/capture.js';
import { AprsDecoder } from '../src/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../src/tx-encoders.js';
import { afsk, concat, feed, fmModulate, hold, silence, toCs8, toInt8 } from './lib/iq.js';

const RATE = 960_000, INFO = '>SigMF round trip';
const aprsIq = () => concat(silence(RATE / 10), fmModulate(hold(afsk(ax25Bits(ax25Aprs('N0CALL-3', INFO)), 1200, 48_000, 1200, 2200), RATE / 48_000), RATE, 3000), silence(RATE / 10));
const INFO_CAP: SigmfCaptureInfo = { centerHz: 144_390_000, rate: RATE, datetime: '2026-11-26T10:15:00.000Z', radio: 'HackRF One · fw 2024.02.1', app: 'Capture', recorder: 'Mad Mobile test', gain: { lna: 32, vga: 20, amp: true, agc: false }, gps: { lat: 51.5, lon: -0.12 } };

class DecodingWorker implements WorkerLike {
  lines: string[] = []; private fns: ((e: MessageEvent) => void)[] = [];
  private readonly dec = new AprsDecoder(m => { if (m.type === 'packet') this.lines.push(m.line as string); });
  constructor(private readonly rate: number) { this.dec.reset(); }
  postMessage(m: { buf: ArrayBuffer }): void { const b = new Int8Array(m.buf); setTimeout(() => { this.dec.onIq(b, this.rate); for (const f of this.fns) f({ data: { type: 'iqAck' } } as MessageEvent); }, 0); }
  addEventListener(_t: 'message', f: (e: MessageEvent) => void): void { this.fns.push(f); }
  removeEventListener(_t: 'message', f: (e: MessageEvent) => void): void { this.fns = this.fns.filter(x => x !== f); }
}
async function playAll(files: File[]): Promise<{ lines: string[]; centerHz: number; rate: number }> {
  const src = await openIqSource(files);
  const w = new DecodingWorker(src.meta.rate), r = new FileRadio(src, w, { onLog: () => {}, onStatus: () => {} });
  r.speed = Infinity; await r.open(); await r.run(); await new Promise(res => setTimeout(res, 20));
  return { lines: w.lines, centerHz: src.meta.centerHz, rate: src.meta.rate };
}

test('meta: SigMF 1.0 core fields, GeoJSON order, the gain under a declared extension', () => {
  const m = sigmfMeta(INFO_CAP) as { global: Record<string, unknown>; captures: Record<string, unknown>[] };
  const g = m.global;
  assert.equal(g['core:datatype'], 'ci8'); assert.equal(g['core:sample_rate'], RATE); assert.equal(g['core:version'], '1.0.0');
  assert.equal(g['core:hw'], 'HackRF One · fw 2024.02.1'); assert.equal(g['core:recorder'], 'Mad Mobile test');
  assert.deepEqual(g['core:geolocation'], { type: 'Point', coordinates: [-0.12, 51.5] });    // GeoJSON is [lon, lat]
  assert.deepEqual(g['core:extensions'], [{ name: 'madmobile', version: '1.0.0', optional: true }]);
  assert.equal(g['madmobile:lna_db'], 32); assert.equal(g['madmobile:amp'], true); assert.equal(g['madmobile:app'], 'Capture');
  assert.deepEqual(m.captures, [{ 'core:sample_start': 0, 'core:frequency': 144_390_000, 'core:datetime': '2026-11-26T10:15:00.000Z' }]);
  const noGps = sigmfMeta({ ...INFO_CAP, gps: undefined }) as { global: Record<string, unknown> };
  assert.equal('core:geolocation' in noGps.global, false);
});

test('archive: a valid ustar that GNU tar lists and extracts byte for byte', async () => {
  const data = new Blob([new Uint8Array(1300).map((_, i) => i & 0xff)]);
  const arc = sigmfArchive('cap1', sigmfMeta(INFO_CAP), data, 1_700_000_000);
  assert.equal(arc.size % 512, 0);
  const ents = await tarEntries(arc);
  assert.deepEqual(ents.map(e => [e.name, e.size]), [['cap1/cap1.sigmf-meta', ents[0].size], ['cap1/cap1.sigmf-data', 1300]]);
  const dir = mkdtempSync(join(tmpdir(), 'sigmf-')), path = join(dir, 'cap1.sigmf');
  writeFileSync(path, new Uint8Array(await arc.arrayBuffer()));
  const list = spawnSync('tar', ['-tvf', path], { encoding: 'utf8' });
  if (list.error) return;                                   // no tar on this machine: the reader check above stands
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /cap1\/cap1\.sigmf-meta/); assert.match(list.stdout, /1300 .*cap1\/cap1\.sigmf-data/);
  assert.equal(spawnSync('tar', ['-xf', path, '-C', dir]).status, 0);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'cap1/cap1.sigmf-data'))), new Uint8Array(await data.arrayBuffer()));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cap1/cap1.sigmf-meta'), 'utf8')), sigmfMeta(INFO_CAP));
});

test('archive -> OPEN REC: a .sigmf archive plays and the packet decodes, at the recorded frequency', async () => {
  const arc = sigmfArchive('aprs', sigmfMeta(INFO_CAP), new Blob([toCs8(aprsIq(), 60)]));
  const r = await playAll([new File([arc], 'aprs.sigmf')]);
  assert.equal(r.centerHz, 144_390_000); assert.equal(r.rate, RATE);
  assert.equal(r.lines.length, 1, JSON.stringify(r.lines)); assert.ok(r.lines[0].includes(INFO));
  await assert.rejects(openIqSource([new File([sigmfArchive('x', '{}', new Blob([]))].map(b => b), 'broken.sigmf')]), /datatype/);
});

test('old captures: SigMF rebuilt from the Capture app\'s .txt and file name', () => {
  const m = sigmfFromSidecar('sample_rate=2000000\ncenter_frequency=433920000\nformat=c8 (signed int8 I,Q)\n', '20261126_101500_433.920MHz_2000k.c8', 'Mad Mobile') as { global: Record<string, unknown>; captures: Record<string, unknown>[] };
  assert.equal(m.global['core:sample_rate'], 2_000_000); assert.equal(m.captures[0]['core:frequency'], 433_920_000);
  assert.equal(m.captures[0]['core:datetime'], new Date(2026, 10, 26, 10, 15, 0).toISOString());
  assert.equal(sigmfFromSidecar('', 'x.c8', 'Mad Mobile'), null);
});

// ---- Capture -> replay, through upstream's own recorder against an in-memory OPFS ----

function fakeOpfs(): Map<string, Uint8Array[]> {
  const files = new Map<string, Uint8Array[]>();
  const fileOf = (name: string) => new File(files.get(name) ?? [], name);
  const handle = (name: string) => ({
    kind: 'file', name,
    async createWritable() { files.set(name, []); return { async write(x: string | Uint8Array) { files.get(name)!.push(typeof x === 'string' ? new TextEncoder().encode(x) : new Uint8Array(x)); }, async close() {} }; },
    async createSyncAccessHandle() { files.set(name, []); return { write(b: Uint8Array) { files.get(name)!.push(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); return b.byteLength; }, flush() {}, close() {} }; },
    async getFile() { return fileOf(name); },
  });
  const dir = {
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name: string, o?: { create?: boolean }) { if (!files.has(name) && !o?.create) throw new Error('NotFound'); if (!files.has(name)) files.set(name, []); return handle(name); },
    async removeEntry(name: string) { files.delete(name); },
    async *entries() { for (const n of files.keys()) yield [n, handle(n)]; },
  };
  Object.defineProperty(globalThis.navigator, 'storage', { value: { getDirectory: async () => dir }, configurable: true });
  return files;
}

test('Capture -> replay: what the Capture app records plays back and decodes (c8 + txt, and as SigMF)', async () => {
  const opfs = fakeOpfs(), msgs: Record<string, unknown>[] = [];
  const rec = new IqRecorder(m => msgs.push(m));
  await rec.start(144_390_000, RATE);
  feed(rec, toInt8(aprsIq(), 60), RATE);                    // the IQ exactly as the worker hands it to the recorder
  await rec.stop();
  const c8 = [...opfs.keys()].find(n => n.endsWith('.c8'))!, txt = c8.replace(/\.c8$/, '.txt');
  assert.match(c8, /^\d{8}_\d{6}_144\.390MHz_960k\.c8$/);
  const asFile = (n: string) => new File(opfs.get(n)!, n);
  // 1) the two files a download gives you
  const a = await playAll([asFile(c8), asFile(txt)]);
  assert.equal(a.centerHz, 144_390_000); assert.equal(a.lines.length, 1); assert.ok(a.lines[0].includes(INFO));
  // 2) the .sigmf archive the SigMF button builds (metadata rebuilt from the .txt here; the page writes the full one)
  const meta = sigmfFromSidecar(new TextDecoder().decode(opfs.get(txt)![0]), c8, 'Mad Mobile')!;
  const b = await playAll([new File([sigmfArchive(c8.replace(/\.c8$/, ''), meta, asFile(c8))], 'x.sigmf')]);
  assert.equal(b.lines.length, 1); assert.ok(b.lines[0].includes(INFO));
});

// ---- malformed archives must fail, never hang (run under a timeout so a regression shows as a failure) ----

/** An archive whose first header's size field is replaced by `field` (12 bytes), checksum left as it was. */
async function withSizeField(field: Uint8Array): Promise<Blob> {
  const b = new Uint8Array(await sigmfArchive('m', sigmfMeta(INFO_CAP), new Blob([new Uint8Array(100)])).arrayBuffer());
  b.set(field, 124);
  return new Blob([b]);
}
const ascii = (s: string) => { const a = new Uint8Array(12); a.set(new TextEncoder().encode(s)); return a; };

test('malformed tar sizes are rejected, not looped on', { timeout: 5000 }, async () => {
  for (const [label, field] of [['negative', ascii('-1000')], ['not octal', ascii('99')], ['past the end', ascii('77777777777')], ['base-256 negative', Uint8Array.from([0xff, ...new Array(11).fill(0xff)])]] as const) {
    await assert.rejects(tarEntries(await withSizeField(field)), /bad size/, label);
  }
  await assert.rejects(openIqSource([new File([await withSizeField(ascii('-1000'))], 'evil.sigmf')]), /bad size/);
});

test('sizes of 8 GiB and more are written GNU base-256 and read back', () => {
  for (const n of [0, 1300, 8 ** 11 - 1, 8 ** 11, 2 ** 33 + 5, 50 * 2 ** 30]) {
    const h = tarHeader('x/x.sigmf-data', n, 0);
    assert.equal(readSize(h), n, String(n));
    // the checksum still covers the header as written
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(new TextDecoder().decode(h.subarray(148, 154)), 8), sum);
  }
  assert.equal(tarHeader('x', 8 ** 11, 0)[124], 0x80);
});
