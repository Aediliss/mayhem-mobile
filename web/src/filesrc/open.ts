/**
 * FORK: turn the files a person picked into one IQ source: which file holds the samples, which one describes them,
 * and what the description says. Works on anything Blob-like with a name, so Node tests can use it too.
 */
import { tarEntries } from '../sigmf.js';
import { baseOf, BYTES_PER_SAMPLE, chooseScale, extOf, hintsFromName, parseSigmfMeta, parseTxtSidecar, parseWavHeader, type IqMeta } from './formats.js';

export interface NamedBlob { readonly name: string; readonly size: number; slice(start?: number, end?: number): Blob }

export interface IqSource {
  /** The file the samples are read from. */
  data: NamedBlob;
  /** What is shown on screen: the data file's name. */
  name: string;
  meta: IqMeta;
  /** int8 gain for 16-bit / float recordings (1 for 8-bit). */
  scale: number;
  /** Number of complex samples. */
  samples: number;
}

/** Asks the person for a number the files did not give (sample rate, centre frequency); null = cancel. */
export type Ask = (what: 'rate' | 'centerHz', fileName: string) => Promise<number | null>;

async function text(b: NamedBlob): Promise<string> { return new TextDecoder().decode(await b.slice().arrayBuffer()); }
async function bytes(b: NamedBlob, start: number, end: number): Promise<Uint8Array> { return new Uint8Array(await b.slice(start, end).arrayBuffer()); }

/** The sidecar that belongs to `data`: same base name (case-insensitive), else the only .txt picked. */
function sidecarFor(data: NamedBlob, files: NamedBlob[], ext: string): NamedBlob | undefined {
  const all = files.filter(f => extOf(f.name) === ext);
  return all.find(f => baseOf(f.name).toLowerCase() === baseOf(data.name).toLowerCase()) ?? (all.length === 1 ? all[0] : undefined);
}

/** A part of a Blob that keeps a name (an entry inside a .sigmf archive). */
function namedSlice(b: NamedBlob, name: string, start: number, size: number): NamedBlob {
  const part = b.slice(start, start + size);
  return { name, size, slice: (s?: number, e?: number) => part.slice(s, e) };
}

/** A .sigmf archive (tar) → its .sigmf-meta and .sigmf-data entries as files of their own. */
async function unpackArchive(a: NamedBlob): Promise<NamedBlob[]> {
  const entries = await tarEntries(a.slice() as Blob);
  const meta = entries.find(e => /\.sigmf-meta$/i.test(e.name)), data = entries.find(e => /\.sigmf-data$/i.test(e.name));
  if (!meta || !data) throw new Error(`"${a.name}" is not a SigMF archive (no .sigmf-meta + .sigmf-data inside)`);
  const leaf = (n: string) => n.replace(/^.*\//, '');
  return [namedSlice(a, leaf(meta.name), meta.offset, meta.size), namedSlice(a, leaf(data.name), data.offset, data.size)];
}

export async function openIqSource(files: NamedBlob[], ask?: Ask): Promise<IqSource> {
  if (!files.length) throw new Error('no file chosen');
  const archive = files.find(f => /\.sigmf$/i.test(f.name));
  if (archive) files = await unpackArchive(archive);
  const metaFile = files.find(f => /\.sigmf-meta$/i.test(f.name));
  let data: NamedBlob, meta: IqMeta;
  if (metaFile || files.some(f => /\.sigmf-data$/i.test(f.name))) {
    data = files.find(f => /\.sigmf-data$/i.test(f.name)) as NamedBlob;
    if (!metaFile || !data) throw new Error('SigMF needs both files: pick the .sigmf-meta and the .sigmf-data together');
    meta = parseSigmfMeta(await text(metaFile), data.size);
    meta.notes.unshift(`metadata from ${metaFile.name}`);
  } else {
    // the samples are in the biggest file that is not a sidecar
    const candidates = files.filter(f => extOf(f.name) !== 'txt' && extOf(f.name) !== 'json');
    if (!candidates.length) throw new Error('only a .txt was chosen: pick the recording itself as well (the .c8 / .C16 / .cu8 …)');
    data = candidates.reduce((a, b) => (b.size > a.size ? b : a));
    const hints = hintsFromName(data.name);
    if (extOf(data.name) === 'wav') {
      meta = parseWavHeader(await bytes(data, 0, Math.min(data.size, 65536)), data.size);
      if (!meta.centerHz && hints.centerHz) { meta.centerHz = hints.centerHz; meta.notes.push('centre frequency from the file name'); }
    } else {
      const fmt = hints.format;
      if (!fmt) throw new Error(`"${data.name}": unknown extension; use .cs8/.c8, .cu8, .cs16/.c16, .cf32/.cfile/.raw, .wav or SigMF`);
      meta = { format: fmt, bigEndian: false, rate: hints.rate ?? 0, centerHz: hints.centerHz ?? 0, dataOffset: 0, dataBytes: data.size, notes: [] };
      if (hints.rate || hints.centerHz) meta.notes.push('rate / frequency from the file name');
      const txt = sidecarFor(data, files, 'txt');
      if (txt) {
        const sc = parseTxtSidecar(await text(txt));
        if (sc.rate) meta.rate = sc.rate;
        if (sc.centerHz) meta.centerHz = sc.centerHz;
        if (sc.format) meta.format = sc.format;
        meta.notes.unshift(`metadata from ${txt.name}`);
      }
    }
  }
  if (!meta.rate && ask) { const r = await ask('rate', data.name); if (r === null) throw new Error('cancelled'); meta.rate = r; }
  if (!meta.rate || !(meta.rate > 0)) throw new Error(`"${data.name}": no sample rate in the file, its name or a sidecar`);
  if (!meta.centerHz && ask) { const c = await ask('centerHz', data.name); if (c === null) throw new Error('cancelled'); meta.centerHz = c; }
  const bps = BYTES_PER_SAMPLE[meta.format];
  const probeEnd = meta.dataOffset + Math.min(meta.dataBytes, Math.floor(1 << 20) - ((1 << 20) % bps));
  const scale = chooseScale(await bytes(data, meta.dataOffset, probeEnd), meta.format, meta.bigEndian);
  return { data, name: data.name, meta, scale, samples: Math.floor(meta.dataBytes / bps) };
}
