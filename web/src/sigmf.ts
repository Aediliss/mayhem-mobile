/**
 * FORK: SigMF (Signal Metadata Format, sigmf.org, core spec v1.x) for Capture: the .sigmf-meta document, and the
 * .sigmf archive (a POSIX ustar tar holding `<name>/<name>.sigmf-meta` and `<name>/<name>.sigmf-data`).
 *
 * The archive is assembled as a Blob of parts, so a multi-gigabyte capture is never copied into memory: the
 * recording's own File is one part, between two 512-byte headers and the padding tar needs.
 */

export interface SigmfCaptureInfo {
  centerHz: number;
  rate: number;
  /** ISO 8601 UTC, when recording started. */
  datetime: string;
  /** e.g. 'HackRF One · fw 2024.02.1', 'RTL-SDR Blog V4'. */
  radio: string;
  /** The app the recording was made in. */
  app: string;
  gain?: { lna: number; vga: number; amp: boolean; agc: boolean };
  /** Phone/PC location when known (WGS84). */
  gps?: { lat: number; lon: number; alt?: number };
  /** Recorder name + version, e.g. 'Mad Mobile 0.9.73-fork · abc1234'. */
  recorder: string;
  /** SigMF datatype of the data file; Capture writes signed 8-bit. */
  datatype?: 'ci8' | 'cu8' | 'ci16_le' | 'cf32_le';
}

/** The extension namespace for fields SigMF core has no name for (gain, app). Declared in core:extensions. */
export const NS = 'madmobile';

/** A SigMF 1.0 metadata document for one continuous capture. */
export function sigmfMeta(i: SigmfCaptureInfo): Record<string, unknown> {
  const global: Record<string, unknown> = {
    'core:datatype': i.datatype ?? 'ci8',
    'core:sample_rate': i.rate,
    'core:version': '1.0.0',
    'core:recorder': i.recorder,
    'core:hw': i.radio,
    'core:description': `Recorded in ${i.app} at ${(i.centerHz / 1e6).toFixed(6)} MHz, ${(i.rate / 1e6).toFixed(3)} Msps${i.gain ? `, LNA ${i.gain.lna} dB / VGA ${i.gain.vga} dB${i.gain.amp ? ' / amp on' : ''}${i.gain.agc ? ' (AGC)' : ''}` : ''}`,
    'core:extensions': [{ name: NS, version: '1.0.0', optional: true }],
    [`${NS}:app`]: i.app,
  };
  if (i.gain) {
    global[`${NS}:lna_db`] = i.gain.lna; global[`${NS}:vga_db`] = i.gain.vga;
    global[`${NS}:amp`] = i.gain.amp; global[`${NS}:agc`] = i.gain.agc;
  }
  if (i.gps) global['core:geolocation'] = { type: 'Point', coordinates: i.gps.alt === undefined ? [i.gps.lon, i.gps.lat] : [i.gps.lon, i.gps.lat, i.gps.alt] };
  return {
    global,
    captures: [{ 'core:sample_start': 0, 'core:frequency': i.centerHz, 'core:datetime': i.datetime }],
    annotations: [],
  };
}

/** Best-effort metadata for a capture made before SigMF existed here (or whose .sigmf-meta was lost): from its .txt. */
export function sigmfFromSidecar(txt: string, fileName: string, recorder: string): Record<string, unknown> | null {
  const rate = Number(/sample_rate=(\d+(?:\.\d+)?)/.exec(txt)?.[1] ?? 0), centerHz = Number(/center_frequency=(\d+(?:\.\d+)?)/.exec(txt)?.[1] ?? 0);
  if (!rate) return null;
  // the Capture app names files YYYYMMDD_HHMMSS_…: that is local time when recording started
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(fileName);
  const datetime = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : new Date(0).toISOString();
  return sigmfMeta({ centerHz, rate, datetime, radio: 'unknown', app: 'Capture', recorder });
}

// ---- tar (POSIX ustar), just enough for a SigMF archive ----

const enc = new TextEncoder();

function octal(n: number, width: number): string { return n.toString(8).padStart(width - 1, '0') + '\0'; }

/** Largest size the 11 octal digits of a ustar size field can hold (8 GiB - 1). */
const OCTAL_MAX = 8 ** 11 - 1;

/** Size field: octal when it fits, GNU base-256 (high bit set, big-endian) for 8 GiB and up, as GNU tar writes. */
function writeSize(h: Uint8Array, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: bad size ${size}`);
  if (size <= OCTAL_MAX) { h.set(enc.encode(octal(size, 12)), 124); return; }
  let v = size;
  for (let i = 135; i > 124; i--) { h[i] = v % 256; v = Math.floor(v / 256); }
  h[124] = 0x80;
}

/** The size in a header, or -1 when the field is not a well-formed octal or base-256 number. */
export function readSize(h: Uint8Array): number {
  if (h[124] & 0x80) {                                       // GNU base-256; a set sign bit (0xff) would be negative
    if (h[124] !== 0x80) return -1;
    let v = 0; for (let i = 125; i < 136; i++) v = v * 256 + h[i];
    return Number.isSafeInteger(v) ? v : -1;
  }
  const s = new TextDecoder().decode(h.subarray(124, 136)).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : s === '' ? 0 : -1;
}

/** One 512-byte ustar header for a regular file. */
export function tarHeader(name: string, size: number, mtimeSec: number): Uint8Array {
  if (enc.encode(name).length > 100) throw new Error(`tar: name too long: ${name}`);
  const h = new Uint8Array(512);
  const put = (off: number, s: string) => h.set(enc.encode(s), off);
  put(0, name);
  put(100, octal(0o644, 8)); put(108, octal(0, 8)); put(116, octal(0, 8));
  writeSize(h, size); put(136, octal(Math.floor(mtimeSec), 12));
  h.fill(0x20, 148, 156);                                   // checksum field counts as spaces while summing
  put(156, '0'); put(257, 'ustar\0'); put(263, '00');
  let sum = 0; for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

const pad512 = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** A .sigmf archive: `<base>/<base>.sigmf-meta` then `<base>/<base>.sigmf-data`, as one lazily assembled Blob. */
export function sigmfArchive(base: string, meta: Record<string, unknown> | string, data: Blob, mtimeSec = Date.now() / 1000): Blob {
  const metaBytes = enc.encode(typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2));
  return new Blob([
    tarHeader(`${base}/${base}.sigmf-meta`, metaBytes.length, mtimeSec), metaBytes, pad512(metaBytes.length),
    tarHeader(`${base}/${base}.sigmf-data`, data.size, mtimeSec), data, pad512(data.size),
    new Uint8Array(1024),                                    // two zero blocks end the archive
  ], { type: 'application/x-tar' });
}

export interface TarEntry { name: string; offset: number; size: number }

/** The regular files in a tar, reading only its headers (a few bytes per file, wherever they sit in the Blob). */
export async function tarEntries(blob: Blob): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  let o = 0;
  for (let n = 0; o + 512 <= blob.size; n++) {
    if (n >= 10_000) throw new Error('tar: too many entries');
    const h = new Uint8Array(await blob.slice(o, o + 512).arrayBuffer());
    if (h.every(b => b === 0)) break;
    const str = (a: number, b: number) => new TextDecoder().decode(h.subarray(a, b)).replace(/\0.*$/s, '');
    // a malformed size must never move the offset backwards or not at all (that would read the same header forever)
    const size = readSize(h);
    if (size < 0 || o + 512 + size > blob.size) throw new Error(`tar: entry ${out.length + 1} has a bad size`);
    const prefix = str(345, 500), name = (prefix ? prefix + '/' : '') + str(0, 100);
    const type = String.fromCharCode(h[156] || 48);
    if (type === '0' || type === '\0') out.push({ name, offset: o + 512, size });
    o += 512 + size + ((512 - (size % 512)) % 512);
  }
  return out;
}
