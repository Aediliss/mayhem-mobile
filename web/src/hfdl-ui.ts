/**
 * FORK: what the HFDL band of Flight Msgs remembers beyond ACARS (which goes to the shared aircraft cards): the ground
 * stations heard (their squitters, the frequencies they say they are on, the aircraft working them) and the positions
 * aircraft report in their performance and frequency data, by flight. No DOM.
 */
import { HFDL_STATIONS, type HfdlPdu } from './dsp/hfdl/pdu.js';

export interface HfGs {
  id: number; name: string; lat: number; lon: number;
  /** Squitters heard from it, and PDUs to or from it. */
  squitters: number; pdus: number; firstMs: number; lastMs: number;
  /** SNR of the last burst it sent itself (null: only heard through aircraft talking to it). */
  snr: number | null;
  /** Where it was heard (kHz), and the frequencies its own squitter says it uses. */
  heardOn: Set<number>; freqs: number[]; utcSync: boolean;
  /** Aircraft ids working it, last heard. */
  aircraft: Map<number, number>;
}
export interface HfPos { flight: string; lat: number; lon: number; ms: number; gs?: number; kind: string }

/** A flight number with the leading zeros of its number dropped (UA0901 and UA901 are one flight). */
export function normFlight(f: string): string {
  const s = f.replace(/\s/g, '').toUpperCase(), m = /^([A-Z0-9]{2}[A-Z]?)(\d+)([A-Z]?)$/.exec(s);
  return m ? `${m[1]}${parseInt(m[2], 10)}${m[3]}` : s;
}

export class HfdlHeard {
  readonly stations = new Map<number, HfGs>();
  readonly positions = new Map<string, HfPos>();
  /** ICAO addresses logons gave, by ground station and aircraft id. */
  readonly icao = new Map<string, number>();
  pdus = 0;
  add(p: HfdlPdu, khz: number, snr: number, ms: number): void {
    this.pdus++;
    const g = this.gs(p.gs, ms); if (!g) return;
    g.pdus++; g.lastMs = ms; g.heardOn.add(khz);
    if (!p.down) g.snr = snr;
    if (p.squitter) {
      g.squitters++; const own = p.squitter.stations.find(s => s.id === p.gs);
      if (own) { g.freqs = own.freqs; g.utcSync = own.utcSync; }
      for (const s of p.squitter.stations) if (s.id !== p.gs) { const o = this.gs(s.id, ms); if (o && s.freqs.length) o.freqs = s.freqs; }
    }
    if (p.acId !== undefined && p.acId > 0) g.aircraft.set(p.acId, ms);
    for (const l of p.lpdus) {
      if (l.icao !== undefined && p.acId !== undefined) this.icao.set(`${p.gs}:${l.acId ?? p.acId}`, l.icao);
      if (l.report && l.report.flight && (l.report.lat || l.report.lon)) this.positions.set(normFlight(l.report.flight), { flight: l.report.flight, lat: l.report.lat, lon: l.report.lon, ms, gs: p.gs, kind: l.report.kind });
    }
  }
  posFor(flight: string): HfPos | undefined { return flight ? this.positions.get(normFlight(flight)) : undefined; }
  list(): HfGs[] { return [...this.stations.values()].sort((a, b) => b.lastMs - a.lastMs); }
  clear(): void { this.stations.clear(); this.positions.clear(); this.icao.clear(); this.pdus = 0; }
  private gs(id: number, ms: number): HfGs | undefined {
    let g = this.stations.get(id); if (g) return g;
    const s = HFDL_STATIONS.find(x => x[0] === id); if (!s) return undefined;
    g = { id, name: s[1], lat: s[2], lon: s[3], squitters: 0, pdus: 0, firstMs: ms, lastMs: ms, snr: null, heardOn: new Set(), freqs: [], utcSync: false, aircraft: new Map() };
    this.stations.set(id, g); return g;
  }
}
