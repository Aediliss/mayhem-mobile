/**
 * FORK: Mode A/C replies (SSR), receive only, on the magnitude samples the ADS-B decoder already has (2 Msps or more).
 * A reply is a framing pulse F1, twelve information pulses and the X slot on a 1.45 µs grid, and F2 20.3 µs after F1,
 * with an optional SPI pulse 4.35 µs after F2 (ICAO Annex 10 Vol IV 3.1.1.6). The slots are, in order:
 * C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4. A Mode A reply (the squawk) and a Mode C reply (the pressure altitude, Gillham
 * coded) look the same; which one it is depends on the interrogation, which is not heard here, so each code is read both
 * ways and matched against the Mode-S aircraft: a squawk they report, or an altitude within 200 ft.
 *
 * Detection: F1 and F2 both well over the noise and within 6 dB of each other, every slot read at its own time (the
 * larger of the two samples around it), a slot set when over half the framing pulses' level; the X slot must be
 * empty and nothing may stand just before F1. Spans the Mode-S decoder already read are skipped. A code counts once it
 * has come three times within ten seconds (radar sweeps repeat it; noise does not).
 */
import { ac13 } from './modes.js';

/** The 13 slot pattern as a number, C1 first (the same order as Mode-S's AC13 / ID13 fields). */
export interface AcReply { code13: number; spi: boolean; at: number; level: number }

/** The squawk a 13-slot code reads as (X ignored). */
export function acSquawk(code13: number): string {
  const c = (k: number) => (code13 >> (12 - k)) & 1;
  return `${c(5) * 4 + c(3) * 2 + c(1)}${c(11) * 4 + c(9) * 2 + c(7)}${c(4) * 4 + c(2) * 2 + c(0)}${c(12) * 4 + c(10) * 2 + c(8)}`;
}
/**
 * The altitude a 13-slot code reads as in Mode C (Gillham), or undefined. Mode C has D1 where Mode-S's AC13 has Q; D1 is
 * never set below 62 800 ft, so a code with D1 set is not an altitude.
 */
export function acAltitude(code13: number): number | undefined {
  if (code13 & (1 << 4)) return undefined;                       // D1
  return ac13(code13 & ~(1 << 6));                                // X (M's place in AC13) cleared
}

export class ModeAcDetector {
  private readonly sps: number;
  constructor(readonly fs = 2_000_000) { this.sps = fs / 1e6; }

  /**
   * Replies in m[from, to) (a reply must start there and fit before m.length). `skip` holds [start, end) sample spans to
   * leave alone (Mode-S frames already read). `floor` is the noise level the pulses must stand over.
   */
  scan(m: ArrayLike<number>, from: number, to: number, floor: number, skip: [number, number][] = []): AcReply[] {
    const out: AcReply[] = [], s = this.sps, span = Math.ceil(20.3 * s) + 2, need = Math.max(floor * 4, 1);
    const at = (i: number, t: number) => { const x = i + t * s, a = Math.floor(x); return Math.max(m[a] ?? 0, m[a + 1] ?? 0); };
    let k = 0;
    for (let i = Math.max(1, from); i < to && i + span + Math.ceil(4.35 * s) + 2 < m.length; i++) {
      while (k < skip.length && skip[k][1] <= i) k++;
      if (k < skip.length && skip[k][0] <= i + span) { i = skip[k][1] - 1; continue; }
      const f1 = m[i];
      if (f1 < need || f1 < m[i - 1] || f1 < m[i + 1]) continue;     // a pulse peak
      if ((m[i - 2] ?? 0) > f1 / 2 && (m[i - 3] ?? 0) > f1 / 2) continue;   // something just before: not a reply's start
      const f2 = at(i, 20.3);
      if (f2 < need || f2 < f1 / 2 || f2 > f1 * 2) continue;
      const th = Math.min(f1, f2) / 2;
      let code = 0, bad = false;
      for (let n = 1; n <= 13; n++) {
        const v = at(i, 1.45 * n) > th ? 1 : 0;
        if (n === 7 && v) { bad = true; break; }                    // X: always empty
        code = (code << 1) | v;
      }
      if (bad) continue;
      out.push({ code13: code, spi: at(i, 24.65) > th, at: i, level: Math.min(f1, f2) });
      i += span;
    }
    return out;
  }
}

export interface AcTrack {
  /** The code read as a squawk, and as a Mode C altitude where it is one. */
  squawk: string; alt?: number;
  count: number; firstMs: number; lastMs: number;
  /** The Mode-S aircraft it belongs to (its squawk, or its altitude within 200 ft), or ''. */
  icao: string;
}

/** Codes heard, kept as tracks once one has come three times within ten seconds. */
export class ModeAcTracks {
  private readonly hits = new Map<number, number[]>();
  readonly tracks = new Map<number, AcTrack>();
  add(r: AcReply, now: number): void {
    const h = (this.hits.get(r.code13) ?? []).filter(t => now - t < 10_000); h.push(now); this.hits.set(r.code13, h);
    if (this.hits.size > 2000) for (const [c, v] of this.hits) if (!v.length || now - v[v.length - 1] > 10_000) this.hits.delete(c);
    const t = this.tracks.get(r.code13);
    if (t) { t.count++; t.lastMs = now; return; }
    if (h.length >= 3) this.tracks.set(r.code13, { squawk: acSquawk(r.code13), alt: acAltitude(r.code13), count: h.length, firstMs: h[0], lastMs: now, icao: '' });
  }
  /** Ties each track to a Mode-S aircraft if one reports that squawk or that altitude; drops tracks quiet for a minute. */
  associate(aircraft: { icao: string; squawk?: string; alt?: number }[], now: number): AcTrack[] {
    for (const [c, t] of this.tracks) {
      if (now - t.lastMs > 60_000) { this.tracks.delete(c); continue; }
      const bySq = aircraft.find(a => a.squawk === t.squawk);
      const byAlt = t.alt !== undefined ? aircraft.find(a => a.alt !== undefined && Math.abs(a.alt - t.alt!) <= 200) : undefined;
      t.icao = (bySq ?? byAlt)?.icao ?? '';
    }
    return [...this.tracks.values()].sort((a, b) => b.lastMs - a.lastMs);
  }
}
