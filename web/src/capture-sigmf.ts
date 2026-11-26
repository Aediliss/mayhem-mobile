/**
 * FORK: SigMF for the Capture app, done on the page so upstream's recorder (dsp/capture.ts, in the worker) is
 * untouched. The recorder still writes `<name>.c8` + `<name>.txt` to the browser's private storage (OPFS); this
 * adds `<name>.sigmf-meta` beside them when recording starts, and builds a `.sigmf` archive on download.
 */
import { sigmfArchive, sigmfFromSidecar, sigmfMeta, type SigmfCaptureInfo } from './sigmf.js';

const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('captures', { create: true });
const metaName = (c8: string) => c8.replace(/\.c8$/, '.sigmf-meta');

/** Waiting for the recorder to name the file: the details as they were when REC was pressed. */
let pending: SigmfCaptureInfo | null = null;
export function captureStarting(info: SigmfCaptureInfo): void { pending = info; }

/** The recorder said it is recording `name`: write its metadata beside it. */
export async function captureNamed(name: string, log: (l: string) => void): Promise<void> {
  const info = pending; pending = null;
  if (!info || !name.endsWith('.c8')) return;
  try {
    const w = await (await (await dir()).getFileHandle(metaName(name), { create: true })).createWritable();
    await w.write(JSON.stringify(sigmfMeta(info), null, 2)); await w.close();
  } catch (e) { log(`capture: SigMF metadata not written: ${(e as Error).message}`); }
}

/** Download a capture as one `.sigmf` archive (its .sigmf-meta, or one rebuilt from the .txt, plus the samples). */
export async function downloadSigmf(name: string, recorder: string, log: (l: string) => void): Promise<void> {
  try {
    const d = await dir();
    const data = await (await d.getFileHandle(name)).getFile();
    let meta: string | Record<string, unknown> | null = null;
    try { meta = await (await (await d.getFileHandle(metaName(name))).getFile()).text(); } catch { /* older capture */ }
    if (!meta) {
      let txt = ''; try { txt = await (await (await d.getFileHandle(name.replace(/\.c8$/, '.txt'))).getFile()).text(); } catch { /* none */ }
      meta = sigmfFromSidecar(txt, name, recorder);
      if (!meta) { log(`capture: ${name} has no metadata to build SigMF from`); return; }
      log(`capture: ${name} predates SigMF here; its metadata was rebuilt from the .txt (no gain, radio or GPS)`);
    }
    const base = name.replace(/\.c8$/, '');
    const url = URL.createObjectURL(sigmfArchive(base, meta, data));
    const a = document.createElement('a'); a.href = url; a.download = `${base}.sigmf`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { log(`capture: SigMF download failed: ${(e as Error).message}`); }
}

/** The recorder deletes the .c8 and .txt; the metadata goes with them. */
export async function removeCaptureMeta(name: string): Promise<void> {
  try { await (await dir()).removeEntry(metaName(name)); } catch { /* none */ }
}
