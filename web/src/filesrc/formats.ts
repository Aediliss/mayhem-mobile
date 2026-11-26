/**
 * FORK: IQ recording formats for FileRadio. Pure functions (no DOM), so Node tests can drive them.
 *
 * Supported, by what the bytes are:
 *   cs8   signed 8-bit I,Q          .cs8 .c8 (hackrf_transfer, this app's Capture), Mayhem .C8, SigMF ci8
 *   cu8   unsigned 8-bit, offset 128 .cu8 (rtl_sdr, rtl_433 -w), 8-bit PCM WAV, SigMF cu8
 *   cs16  signed 16-bit I,Q         .cs16 .c16, Mayhem .C16, 16-bit PCM WAV, SigMF ci16_le / ci16_be
 *   cf32  32-bit float I,Q          .cf32 .cfile .fc32 .raw (GNU Radio / gqrx), float WAV, SigMF cf32_le / cf32_be
 * Metadata (centre frequency, sample rate) comes from, in order of trust: a SigMF .sigmf-meta, a Mayhem-style .txt
 * sidecar, a WAV's own header (rate) and SDR#'s `auxi` chunk (frequency), then the file name.
 */

export type SampleFormat = 'cs8' | 'cu8' | 'cs16' | 'cf32';

/** Bytes per complex sample. */
export const BYTES_PER_SAMPLE: Record<SampleFormat, number> = { cs8: 2, cu8: 2, cs16: 4, cf32: 8 };

export interface IqMeta {
  format: SampleFormat;
  bigEndian: boolean;
  /** Sample rate in Hz; 0 when nothing said. */
  rate: number;
  /** Centre frequency in Hz; 0 when nothing said. */
  centerHz: number;
  /** Where the samples start in the data file, and how many bytes of them there are. */
  dataOffset: number;
  dataBytes: number;
  /** Anything else worth showing (SigMF hw / datetime / description, the name of the sidecar used). */
  notes: string[];
  /** SigMF / sidecar extras kept as-is for display. */
  datetime?: string;
}

/** A hint parsed from a file name; any field may be missing. */
export interface NameHints { centerHz?: number; rate?: number; format?: SampleFormat }

const EXT_FORMAT: Record<string, SampleFormat> = {
  cs8: 'cs8', c8: 'cs8', s8: 'cs8', cu8: 'cu8', u8: 'cu8', cs16: 'cs16', c16: 'cs16', s16: 'cs16',
  cf32: 'cf32', fc32: 'cf32', cfile: 'cf32', raw: 'cf32',
};

export function extOf(name: string): string { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
export function baseOf(name: string): string { return name.replace(/\.sigmf-(meta|data)$/i, '').replace(/\.[^.]+$/, ''); }

const UNIT: Record<string, number> = { hz: 1, k: 1e3, khz: 1e3, m: 1e6, mhz: 1e6, g: 1e9, ghz: 1e9, ksps: 1e3, msps: 1e6, sps: 1 };

/**
 * What a file name says. Recognises the common writers:
 *   rtl_433       g001_433.92M_250k.cu8
 *   this app      20261126_101500_433.920MHz_2000k.c8
 *   gqrx          gqrx_20260101_120000_433920000_2000000_fc.raw
 *   SDR#          SDRSharp_20260101_120000Z_433920000Hz_IQ.wav
 *   HDSDR         HDSDR_20260101_120000Z_433920kHz_RF.wav
 */
export function hintsFromName(name: string): NameHints {
  const h: NameHints = {};
  const ext = extOf(name);
  if (EXT_FORMAT[ext]) h.format = EXT_FORMAT[ext];
  const base = name.replace(/\.[^.]+$/, '');
  const gq = /gqrx_\d{8}_\d{6}_(\d+)_(\d+)_fc$/i.exec(base);
  if (gq) return { centerHz: Number(gq[1]), rate: Number(gq[2]), format: 'cf32' };
  // number + unit tokens, classified by unit: "Hz"-suffixed and bare M/G are frequencies, bare k and "sps" are rates
  // (rtl_433: 433.92M_250k; this app: 433.920MHz_2000k; HDSDR: 433920kHz). Order in the name does not matter.
  const freqs: number[] = [], rates: number[] = [];
  const re = /(?:^|[_\-\s])(\d+(?:\.\d+)?)(ghz|mhz|khz|hz|msps|ksps|sps|m|k|g)(?=$|[_\-\s.])/gi;
  for (let m = re.exec(base); m; m = re.exec(base)) {
    const u = m[2].toLowerCase(), v = Number(m[1]) * UNIT[u];
    (u.endsWith('sps') || u === 'k' ? rates : freqs).push(v);
  }
  // two frequency-like values and no rate (433.92M_2M): the smaller one, if a plausible rate, is the rate
  if (!rates.length && freqs.length >= 2) { const lo = Math.min(...freqs); if (lo <= 61.44e6) { rates.push(lo); freqs.splice(freqs.indexOf(lo), 1); } }
  if (freqs.length) h.centerHz = freqs[0];
  if (rates.length) h.rate = rates[0];
  return h;
}

/** A Mayhem / this-app `.txt` sidecar: `sample_rate=500000`, `center_frequency=433920000`, one per line. */
export function parseTxtSidecar(text: string): { rate?: number; centerHz?: number; format?: SampleFormat } {
  const out: { rate?: number; centerHz?: number; format?: SampleFormat } = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'sample_rate' || k === 'samplerate') out.rate = Number(v);
    else if (k === 'center_frequency' || k === 'frequency') out.centerHz = Number(v);
    else if (k === 'format') { const f = /^(c8|cs8|cu8|c16|cs16|cf32)/i.exec(v); if (f) out.format = EXT_FORMAT[f[1].toLowerCase()]; }
  }
  return out;
}

/** SigMF `core:datatype` → our format. Only complex types; real (r*) recordings are refused. */
export function sigmfDatatype(dt: string): { format: SampleFormat; bigEndian: boolean } {
  const m = /^c([fiu])(8|16|32)(?:_(le|be))?$/.exec(dt.trim());
  if (!m) throw new Error(`SigMF datatype "${dt}" is not complex IQ this player reads (ci8, cu8, ci16_le/be, cf32_le/be)`);
  const be = m[3] === 'be';
  if (m[1] === 'i' && m[2] === '8') return { format: 'cs8', bigEndian: false };
  if (m[1] === 'u' && m[2] === '8') return { format: 'cu8', bigEndian: false };
  if (m[1] === 'i' && m[2] === '16') return { format: 'cs16', bigEndian: be };
  if (m[1] === 'f' && m[2] === '32') return { format: 'cf32', bigEndian: be };
  throw new Error(`SigMF datatype "${dt}" is not supported yet`);
}

export interface SigmfMetaDoc {
  global: Record<string, unknown>;
  captures?: Record<string, unknown>[];
  annotations?: Record<string, unknown>[];
}

/** Read a .sigmf-meta document into the fields the player needs. `dataBytes` is the .sigmf-data file's size. */
export function parseSigmfMeta(json: string, dataBytes: number): IqMeta {
  const doc = JSON.parse(json) as SigmfMetaDoc;
  const g = doc.global ?? {};
  const dt = g['core:datatype'];
  if (typeof dt !== 'string') throw new Error('SigMF: global core:datatype is missing');
  const { format, bigEndian } = sigmfDatatype(dt);
  const cap0 = (doc.captures ?? [])[0] ?? {};
  const bps = BYTES_PER_SAMPLE[format];
  const start = Number(cap0['core:sample_start'] ?? 0) * bps;
  const notes: string[] = [];
  for (const k of ['core:hw', 'core:description', 'core:recorder', 'core:author']) if (typeof g[k] === 'string') notes.push(`${k.slice(5)}: ${g[k]}`);
  if (doc.captures && doc.captures.length > 1) notes.push(`${doc.captures.length} capture segments; the player uses the first segment's frequency`);
  return {
    format, bigEndian, rate: Number(g['core:sample_rate'] ?? 0), centerHz: Number(cap0['core:frequency'] ?? 0),
    dataOffset: start, dataBytes: Math.max(0, dataBytes - start), notes,
    datetime: typeof cap0['core:datetime'] === 'string' ? cap0['core:datetime'] as string : undefined,
  };
}

/**
 * A RIFF/WAVE header: 2 channels (I left, Q right), 8-bit unsigned, 16-bit signed or 32-bit float. SDR#'s `auxi`
 * chunk carries the centre frequency 32 bytes in (after two SYSTEMTIMEs); HDSDR writes the same chunk.
 */
export function parseWavHeader(head: Uint8Array, fileBytes: number): IqMeta {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (o: number) => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
  if (head.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12, rate = 0, channels = 0, bits = 0, fmtCode = 0, centerHz = 0;
  const notes: string[] = [];
  while (o + 8 <= head.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      fmtCode = dv.getUint16(body, true); channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true); bits = dv.getUint16(body + 14, true);
      if (fmtCode === 0xFFFE && size >= 40) fmtCode = dv.getUint16(body + 24, true);   // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === 'auxi' && size >= 36 && body + 36 <= head.length) {
      centerHz = dv.getUint32(body + 32, true);
      if (centerHz) notes.push('centre frequency from the auxi chunk (SDR# / HDSDR)');
    } else if (id === 'data') {
      if (channels !== 2) throw new Error(`WAV has ${channels} channel(s); IQ needs 2 (I left, Q right)`);
      const format: SampleFormat | null = fmtCode === 3 && bits === 32 ? 'cf32' : fmtCode === 1 && bits === 16 ? 'cs16' : fmtCode === 1 && bits === 8 ? 'cu8' : null;
      if (!format) throw new Error(`WAV sample format ${fmtCode}/${bits}-bit is not IQ this player reads`);
      return { format, bigEndian: false, rate, centerHz, dataOffset: body, dataBytes: Math.min(size, fileBytes - body), notes };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV: no data chunk in the first part of the file');
}

/**
 * Samples → the signed 8-bit IQ the radios deliver. 8-bit formats pass through unchanged (cu8 loses its offset);
 * 16-bit and float are multiplied by `scale` (chosen once per file by [chooseScale]) and clipped.
 */
export function toInt8Iq(bytes: Uint8Array, format: SampleFormat, bigEndian: boolean, scale: number, out?: Int8Array): Int8Array {
  const nVals = Math.floor(bytes.length / BYTES_PER_SAMPLE[format]) * 2;
  const o = out && out.length >= nVals ? out.subarray(0, nVals) : new Int8Array(nVals);
  const clip = (v: number) => (v > 127 ? 127 : v < -127 ? -127 : Math.round(v));
  if (format === 'cs8') { o.set(new Int8Array(bytes.buffer, bytes.byteOffset, nVals)); return o; }
  if (format === 'cu8') { for (let i = 0; i < nVals; i++) o[i] = bytes[i] - 128; return o; }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le = !bigEndian;
  if (format === 'cs16') { for (let i = 0; i < nVals; i++) o[i] = clip(dv.getInt16(2 * i, le) * scale); return o; }
  for (let i = 0; i < nVals; i++) o[i] = clip(dv.getFloat32(4 * i, le) * scale);
  return o;
}

/** Target RMS in int8 counts: the middle of the 7-22 counts the app's AGC holds a live radio in. */
export const TARGET_RMS = 16;

/**
 * The gain that maps a 16-bit or float recording onto int8, from a block near its start: RMS to [TARGET_RMS],
 * unless that would clip the loudest samples hard (then the 99.9th percentile goes to 120). 8-bit formats: 1.
 */
export function chooseScale(block: Uint8Array, format: SampleFormat, bigEndian: boolean): number {
  if (format === 'cs8' || format === 'cu8') return 1;
  const n = Math.floor(block.length / BYTES_PER_SAMPLE[format]) * 2;
  if (n === 0) return format === 'cs16' ? 1 / 256 : 127;
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength), le = !bigEndian;
  const mags = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) { const v = format === 'cs16' ? dv.getInt16(2 * i, le) : dv.getFloat32(4 * i, le); sq += v * v; mags[i] = Math.abs(v); }
  const rms = Math.sqrt(sq / n);
  if (rms === 0) return format === 'cs16' ? 1 / 256 : 127;
  mags.sort();
  const p999 = mags[Math.min(n - 1, Math.floor(n * 0.999))];
  return Math.min(TARGET_RMS / rms, p999 > 0 ? 120 / p999 : Infinity);
}
