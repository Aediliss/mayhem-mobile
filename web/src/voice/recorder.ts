/**
 * FORK: voice recording. Listens to the speaker audio of the receiver apps (Dispatch, Repeaters, Prowl, CB, Ham Radio,
 * Audio) after the decoder and before MUTE, cuts it into calls (segmenter.ts) and saves each one as a WAV (wav.ts) in
 * the browser's private storage, tagged with what the app said the call was: talkgroup, unit, system, frequency …
 * It records only what the app already plays, so encrypted calls (which the apps never voice) are never recorded.
 */
import { MetaHistory, VoiceSegmenter, uniqueName, type CallMeta, type VoiceSegment } from './segmenter.js';
import { encodeWav } from './wav.js';

const KEY = 'mm.voice.v1';
const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('voice', { create: true });
const p2 = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
/** The player waits for a 200 ms cushion (audio-worklet.js) and the audio travels to it: what is heard now was decoded about this long ago. */
export const PLAYER_DELAY_MS = 250;
const slug = (s: string) => s.replace(/[^A-Za-z0-9.]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

export interface VoiceFile { name: string; size: number; seconds: number }

export class VoiceRecorder {
  enabled = false;
  saved = 0;
  onSaved: (name: string) => void = () => {};
  private readonly seg = new VoiceSegmenter();
  private readonly history = new MetaHistory();
  private readonly names = new Set<string>();
  private rate = 48_000;
  private attached = false;
  /** The tap: connected only while recording is on, so ordinary listening pays nothing for it. */
  private tap: { source: AudioNode; node: AudioWorkletNode } | null = null;
  private connected = false;

  constructor(private readonly meta: () => CallMeta | null, private readonly software: () => string, private readonly log: (l: string) => void) {
    try { this.enabled = JSON.parse(localStorage.getItem(KEY) ?? 'false') === true; } catch { /* no storage */ }
  }

  setEnabled(on: boolean): void {
    if (!on) for (const s of this.seg.flush(Date.now(), this.rate)) void this.save(s);
    this.enabled = on;
    try { localStorage.setItem(KEY, JSON.stringify(on)); } catch { /* private window */ }
    this.connect();
  }
  private connect(): void {
    const t = this.tap; if (!t) return;
    if (this.enabled && !this.connected) { t.source.connect(t.node); this.connected = true; }
    else if (!this.enabled && this.connected) { try { t.source.disconnect(t.node); } catch { /* already */ } this.connected = false; }
  }

  /** Tap the speaker audio: `source` is the node the app's audio comes out of, before any mute. */
  async attach(ctx: AudioContext, source: AudioNode): Promise<void> {
    if (this.attached) return;
    this.attached = true; this.rate = ctx.sampleRate;
    try {
      await ctx.audioWorklet.addModule('./mic-worklet.js');
      const node = new AudioWorkletNode(ctx, 'mayhem-mic', { numberOfOutputs: 0 });
      node.port.onmessage = e => this.block(e.data as Float32Array);
      this.tap = { source, node };
      this.connect();
    } catch (e) { this.log(`voice recording: could not tap the audio (${(e as Error).message})`); }
  }

  /** One block of speaker audio. Exposed for tests. */
  block(a: Float32Array, nowMs = Date.now()): void {
    if (!this.enabled) return;
    // the audio playing now was decoded about PLAYER_DELAY_MS ago: tag it with what was on the air then
    this.history.note(nowMs, this.meta());
    const m = this.history.at(nowMs - PLAYER_DELAY_MS);
    const done = m ? this.seg.push(a, this.rate, m, nowMs) : this.seg.flush(nowMs, this.rate);   // left a recording app: close the call
    for (const s of done) void this.save(s);
  }

  private async save(s: VoiceSegment): Promise<void> {
    const { label, key: _key, ...rest } = s.meta;
    const seconds = s.samples.length / s.rate;
    const info = {
      INAM: label, ICRD: new Date(s.startMs).toISOString(), ISFT: this.software(),
      ICMT: JSON.stringify({ ...rest, label, start: new Date(s.startMs).toISOString(), end: new Date(s.endMs).toISOString(), seconds: Math.round(seconds * 10) / 10 }),
    };
    const name = uniqueName(`${stamp(s.startMs)}_${slug(label) || 'call'}`, this.names);   // never overwrite an earlier call
    try {
      const w = await (await (await dir()).getFileHandle(name, { create: true })).createWritable();
      await w.write(encodeWav(s.samples, s.rate, info)); await w.close();
      this.saved++; this.onSaved(name);
    } catch (e) { this.log(`voice recording: ${name} not saved (${(e as Error).message})`); }
  }

  async list(): Promise<VoiceFile[]> {
    const out: VoiceFile[] = [];
    try {
      for await (const [name, h] of (await dir() as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind !== 'file' || !name.endsWith('.wav')) continue;
        const f = await (h as FileSystemFileHandle).getFile();
        out.push({ name, size: f.size, seconds: Math.max(0, (f.size - 44) / 2 / this.rate) });   // approximate (tags are small)
      }
    } catch { /* no storage */ }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }
  async file(name: string): Promise<File> { return (await (await dir()).getFileHandle(name)).getFile(); }
  async remove(name: string): Promise<void> { try { await (await dir()).removeEntry(name); } catch { /* gone */ } }
}
