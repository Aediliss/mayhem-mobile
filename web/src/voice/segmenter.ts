/**
 * FORK: cuts the app's speaker audio into calls. A call starts when there is sound and ends after `hangMs` of quiet,
 * or at once when the call it belongs to changes (another talkgroup, unit or channel), so one file is one call. A
 * little audio from before the start is kept (pre-roll) so first syllables are not clipped; blips shorter than
 * `minMs` are dropped, and very long calls are split at `maxMs`.
 */

/** What a call is, as the open app says: `key` changes when the call does; everything else goes in the file's tags. */
export interface CallMeta { key: string; label: string; [k: string]: unknown }

export interface VoiceSegment { startMs: number; endMs: number; rate: number; samples: Float32Array; meta: CallMeta }

export interface SegmenterOptions { thresholdDb?: number; hangMs?: number; minMs?: number; maxMs?: number; preMs?: number }

export class VoiceSegmenter {
  private readonly o: Required<SegmenterOptions>;
  private parts: Float32Array[] = []; private n = 0;
  private pre: Float32Array[] = []; private preN = 0;
  private active = false; private quietMs = 0; private loudMs = 0;
  private meta: CallMeta | null = null; private startMs = 0;

  constructor(o: SegmenterOptions = {}) { this.o = { thresholdDb: -45, hangMs: 2000, minMs: 500, maxMs: 600_000, preMs: 200, ...o }; }

  /**
   * One block of speaker audio (any length; ~10-50 ms is typical) at `rate`, with what the app says is on the air.
   * `nowMs` is the wall-clock time at the block's end. Returns the calls that finished with this block.
   */
  push(block: Float32Array, rate: number, meta: CallMeta, nowMs: number): VoiceSegment[] {
    const out: VoiceSegment[] = [];
    const ms = (block.length / rate) * 1000;
    let sq = 0; for (let i = 0; i < block.length; i++) sq += block[i] * block[i];
    const loud = block.length > 0 && 10 * Math.log10(sq / block.length + 1e-12) > this.o.thresholdDb;
    if (this.active && meta.key !== this.meta!.key) { const s = this.close(nowMs - ms, rate); if (s) out.push(s); }   // the call changed
    // the same call learns more about itself (Dispatch names a talkgroup or unit later): keep the latest it says
    else if (this.active) this.meta = { ...this.meta!, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== '')) } as CallMeta;
    if (!this.active && loud) {
      this.active = true; this.meta = { ...meta }; this.quietMs = 0; this.loudMs = 0;
      this.startMs = nowMs - ms - (this.preN / rate) * 1000;
      this.parts = this.pre; this.n = this.preN;                 // the pre-roll opens the call
      this.pre = []; this.preN = 0;
    }
    if (this.active) {
      this.parts.push(block.slice()); this.n += block.length;
      if (loud) { this.quietMs = 0; this.loudMs += ms; } else this.quietMs += ms;
      if (this.quietMs >= this.o.hangMs || (this.n / rate) * 1000 >= this.o.maxMs) { const s = this.close(nowMs, rate); if (s) out.push(s); }
    } else {
      this.pre.push(block.slice()); this.preN += block.length;
      const keep = (this.o.preMs / 1000) * rate;
      while (this.pre.length > 1 && this.preN - this.pre[0].length >= keep) this.preN -= this.pre.shift()!.length;
    }
    return out;
  }

  /** End whatever is open (the app closed, recording was switched off). */
  flush(nowMs: number, rate: number): VoiceSegment[] { const s = this.active ? this.close(nowMs, rate) : null; return s ? [s] : []; }

  private close(nowMs: number, rate: number): VoiceSegment | null {
    const loudMs = this.loudMs, meta = this.meta!;
    // trim the trailing quiet (the hang time) down to a short tail
    const tail = Math.min(this.n, Math.round((Math.max(0, this.quietMs - 300) / 1000) * rate));
    const samples = new Float32Array(this.n - tail); let o = 0;
    for (const p of this.parts) { const take = Math.min(p.length, samples.length - o); if (take <= 0) break; samples.set(p.subarray(0, take), o); o += take; }
    this.active = false; this.parts = []; this.n = 0; this.quietMs = 0; this.loudMs = 0; this.meta = null;
    if (loudMs < this.o.minMs) return null;
    return { startMs: this.startMs, endMs: nowMs - (tail / rate) * 1000, rate, samples, meta };
  }
}

/**
 * What the app said was on the air, kept for a few seconds, so a block of speaker audio can be matched with the call
 * it belonged to when it was decoded: the player plays audio some time after the decoder made it.
 */
export class MetaHistory {
  private readonly h: { ms: number; meta: CallMeta | null }[] = [];
  constructor(private readonly keepMs = 5_000) {}
  note(ms: number, meta: CallMeta | null): void {
    const last = this.h[this.h.length - 1];
    if (!last || last.meta?.key !== meta?.key || last.meta?.label !== meta?.label) this.h.push({ ms, meta: meta ? { ...meta } : null });
    while (this.h.length > 1 && this.h[1].ms < ms - this.keepMs) this.h.shift();
  }
  /** What was on the air at `ms` (the latest note at or before it; the oldest kept when earlier still). */
  at(ms: number): CallMeta | null {
    for (let i = this.h.length - 1; i >= 0; i--) if (this.h[i].ms <= ms) return this.h[i].meta;
    return this.h[0]?.meta ?? null;
  }
}

/** A file name no other recording of this session has: the time to the millisecond, then a counter if needed. */
export function uniqueName(base: string, taken: Set<string>): string {
  let n = `${base}.wav`;
  for (let i = 2; taken.has(n); i++) n = `${base}-${i}.wav`;
  taken.add(n);
  return n;
}
