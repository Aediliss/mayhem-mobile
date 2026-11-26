/**
 * FORK: the one shape every decoder's results take on the export bus, and the adapter that makes them from the DSP
 * worker's existing messages, so no decoder needs to know the bus exists.
 *
 * kinds:
 *   line            any decoder's log line (the text the app's LOG shows)
 *   adsb.frame      a CRC-checked Mode-S frame (hex)                      ← worker 'modes'
 *   adsb.aircraft   an aircraft whose state changed                       ← worker 'aircraft' table
 *   ais.frame       an AIS message's payload (hex + bit count)           ← worker 'aisRaw'
 *   ais.vessel      a vessel whose state changed                          ← worker 'table' (Ships)
 *   aprs.frame      an AX.25 frame without FCS (hex)                      ← worker 'ax25'
 *   aprs.station    a station whose state changed                         ← worker 'stations' (Ham Map)
 *   device          an rtl_433-style report (sensor, key, remote)         ← worker 'r433'
 *   ble.adv         a BLE advertising PDU (hex, dB, channel)              ← worker 'ble'
 */

export interface DecodeEvent {
  /** ISO 8601 UTC time the page received it. */
  t: string;
  /** The app it came from (state.app on the page). */
  app: string;
  kind: string;
  /** The radio's centre frequency when it was heard, Hz. */
  centerHz?: number;
  text?: string;
  /** Raw frame bytes as hex, and the bit count when it is not whole bytes. */
  hex?: string;
  bits?: number;
  data?: Record<string, unknown>;
}

export interface EventContext { app: string; centerHz: number; now?: Date }

type Row = Record<string, unknown>;
const hexOf = (b: ArrayLike<number>) => Array.from(b, x => (x & 0xff).toString(16).padStart(2, '0')).join('');

/** Worker message → events. Keeps just enough state to report table rows that changed rather than whole tables. */
export class EventAdapter {
  private seen = new Map<string, unknown>();

  map(m: Record<string, unknown> | null | undefined, ctx: EventContext): DecodeEvent[] {
    if (!m || typeof m.type !== 'string') return [];
    const base = () => ({ t: (ctx.now ?? new Date()).toISOString(), app: ctx.app, centerHz: ctx.centerHz || undefined });
    switch (m.type) {
      case 'packet': return typeof m.line === 'string' ? [{ ...base(), kind: 'line', text: m.line }] : [];
      case 'modes': return [{ ...base(), kind: 'adsb.frame', hex: String(m.hex) }];
      case 'aisRaw': return [{ ...base(), kind: 'ais.frame', hex: hexOf(m.bytes as number[]), bits: m.bits as number }];
      case 'ax25': return [{ ...base(), kind: 'aprs.frame', hex: hexOf(m.bytes as number[]) }];
      case 'ble': return [{ ...base(), kind: 'ble.adv', hex: hexOf(m.pdu as number[]), data: { db: m.db, ch: m.ch } }];
      case 'r433': {
        const data = m.data as Row | undefined;
        return data ? [{ ...base(), kind: 'device', data: { ...data } }] : [];
      }
      case 'aircraft': return this.changed('adsb.aircraft', 'icao', 'seenMs', m.list as Row[], base);
      case 'table': return this.changed('ais.vessel', 'mmsi', 'lastMs', m.rows as Row[], base);
      case 'stations': return this.changed('aprs.station', 'call', 'lastMs', m.rows as Row[], base);
      default: return [];
    }
  }

  /** Rows of a table whose timestamp moved since the last copy of the table. */
  private changed(kind: string, key: string, stamp: string, rows: Row[] | undefined, base: () => Omit<DecodeEvent, 'kind'>): DecodeEvent[] {
    if (!Array.isArray(rows)) return [];
    const out: DecodeEvent[] = [];
    for (const r of rows) {
      const id = `${kind}:${String(r[key] ?? r.callsign ?? r.src ?? '')}`;
      if (id.endsWith(':')) continue;
      if (this.seen.get(id) === r[stamp]) continue;
      this.seen.set(id, r[stamp]);
      out.push({ ...base(), kind, data: { ...r } });
    }
    if (this.seen.size > 20_000) this.seen.clear();
    return out;
  }
}
