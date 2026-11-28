/**
 * FORK: D-STAR (D-PRS, GPS in the slow data) and Fusion (positions in its data units) on Ham Map. The identity layer
 * already reads them (dsp/hamid/dstar.ts, ysf.ts); this takes each talker's position from HAM+'s snapshots into the
 * Ham Map store, on the APRS layer. A position counts again only when it moves or a minute has passed, so the
 * snapshots (several a second) do not each count as a hearing.
 */
import { hamSpots } from './ham-spots.js';
import type { HamIdent } from './dsp/hamid/ident.js';

const MODES: Record<string, string> = { 'D-STAR': 'D-STAR', YSF: 'Fusion' };
const seen = new Map<string, { lat: number; lon: number; ms: number }>();

interface SnapLike { tiles: { hz: number; talkers?: { ident: HamIdent }[] }[] }

/** Every D-STAR / Fusion talker with a position in [snap] → Ham Map. Returns how many were added. */
export function dvSpots(snap: SnapLike | null | undefined, now: number): number {
  let n = 0;
  for (const t of snap?.tiles ?? []) for (const tk of t.talkers ?? []) {
    const id = tk.ident, p = id?.position, how = id && MODES[id.mode];
    if (!how || !p || !id.callsign) continue;
    const key = `${id.mode}:${id.callsign}`, old = seen.get(key);
    if (old && Math.abs(old.lat - p.lat) < 1e-5 && Math.abs(old.lon - p.lon) < 1e-5 && now - old.ms < 60_000) continue;
    seen.set(key, { lat: p.lat, lon: p.lon, ms: now });
    const src = p.source === 'd-prs' ? 'D-PRS' : 'GPS';
    if (hamSpots.dv(id.callsign, p.lat, p.lon, { dial: t.hz, ms: now, text: `${how} ${src}${id.text ? ` · ${id.text}` : ''}` })) n++;
  }
  if (seen.size > 500) seen.clear();
  return n;
}
