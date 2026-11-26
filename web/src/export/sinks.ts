/**
 * FORK: where exported events go. Each sink picks the events it can say something about and formats them itself.
 * Network transports are passed in (fetch, WebSocket), so the same code runs in the page and in Node tests.
 */
import type { DecodeEvent } from './event.js';
import { aivdm, ax25ToTnc2, beastFrame, kissFrame, rtl433Json, SbsEncoder, unhex, type SbsAircraft } from './formats.js';

export interface Sink {
  readonly name: string;
  handle(ev: DecodeEvent): void;
  /** One line for the Settings screen: what it has done, and whether it is unhappy. */
  status(): string;
  close(): void;
}

// ---- JSON lines, kept in the page for download ----

export class LogSink implements Sink {
  readonly name = 'log';
  readonly lines: string[] = [];
  total = 0;
  constructor(private readonly max = 20_000) {}
  handle(ev: DecodeEvent): void {
    this.lines.push(JSON.stringify(ev)); this.total++;
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  text(): string { return this.lines.length ? this.lines.join('\n') + '\n' : ''; }
  clear(): void { this.lines.length = 0; }
  status(): string { return `${this.lines.length} held${this.total > this.lines.length ? ` (${this.total - this.lines.length} older dropped)` : ''}`; }
  close(): void {}
}

// ---- webhook: batched HTTP POST ----

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; keepalive?: boolean }) => Promise<{ ok: boolean; status: number }>;

/**
 * POSTs `{"source": …, "events": [...]}` as JSON at most every `intervalMs`. The endpoint must allow this page's origin
 * (CORS) and be https unless it is on localhost. Failed batches are kept (up to 1000 events) and retried with backoff.
 */
export class WebhookSink implements Sink {
  readonly name = 'webhook';
  private queue: DecodeEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 0;
  sent = 0; failed = 0; lastError = '';
  constructor(private readonly url: string, private readonly fetchFn: FetchLike, private readonly intervalMs = 2000, private readonly source = 'Mad Mobile') {}
  handle(ev: DecodeEvent): void {
    this.queue.push(ev);
    if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.intervalMs + this.backoff);
  }
  async flush(): Promise<void> {
    this.timer = null;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 200);
    try {
      const r = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: this.source, events: batch }), keepalive: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.sent += batch.length; this.backoff = 0; this.lastError = '';
    } catch (e) {
      this.failed++; this.lastError = (e as Error).message || 'network error (CORS?)';
      this.queue.unshift(...batch);
      this.backoff = Math.min(60_000, this.backoff ? this.backoff * 2 : 2000);
    }
    if (this.queue.length && !this.timer) this.timer = setTimeout(() => void this.flush(), this.intervalMs + this.backoff);
  }
  status(): string { return `${this.sent} sent${this.queue.length ? `, ${this.queue.length} waiting` : ''}${this.lastError ? ` · ${this.lastError}` : ''}`; }
  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

// ---- WebSocket stream in one of the domain formats ----

export type WsFormat = 'jsonl' | 'sbs' | 'beast' | 'nmea' | 'tnc2' | 'kiss' | 'rtl433';
export const WS_FORMATS: [WsFormat, string][] = [
  ['jsonl', 'JSON lines (every event)'], ['sbs', 'SBS / BaseStation (ADS-B)'], ['beast', 'Beast binary (ADS-B)'], ['nmea', 'NMEA !AIVDM (AIS)'],
  ['tnc2', 'APRS text, TNC2 (APRS)'], ['kiss', 'KISS (APRS AX.25)'], ['rtl433', 'rtl_433 JSON (Devices)'],
];

/** The bytes or text one event becomes in a format; empty when the format has nothing to say about it. */
export function formatEvent(fmt: WsFormat, ev: DecodeEvent, sbs?: SbsEncoder): (string | Uint8Array)[] {
  const when = new Date(ev.t);
  switch (fmt) {
    case 'jsonl': return [JSON.stringify(ev) + '\n'];
    case 'beast': return ev.kind === 'adsb.frame' && ev.hex ? [beastFrame(unhex(ev.hex))] : [];
    case 'sbs': return ev.kind === 'adsb.aircraft' && ev.data && sbs ? sbs.update(ev.data as unknown as SbsAircraft, when).map(l => l + '\r\n') : [];
    case 'nmea': return ev.kind === 'ais.frame' && ev.hex ? aivdm(unhex(ev.hex), ev.bits ?? ev.hex.length * 4).map(s => s + '\r\n') : [];
    case 'tnc2': { const s = ev.kind === 'aprs.frame' && ev.hex ? ax25ToTnc2(unhex(ev.hex)) : null; return s ? [s + '\r\n'] : []; }
    case 'kiss': return ev.kind === 'aprs.frame' && ev.hex ? [kissFrame(unhex(ev.hex))] : [];
    case 'rtl433': return ev.kind === 'device' && ev.data ? [rtl433Json(ev.data, when) + '\n'] : [];
  }
}

export interface WsLike { readyState: number; binaryType: string; send(d: string | Uint8Array): void; close(): void; onopen: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null }
export type WsCtor = new (url: string) => WsLike;

/**
 * A WebSocket client that streams one format. Browsers cannot open a TCP listener, so the consumer runs a WebSocket
 * server, or a bridge such as `websockify 30005 localhost:30004` in front of readsb's Beast input. Reconnects with
 * backoff; holds up to 500 messages while down.
 */
export class WsSink implements Sink {
  readonly name: string;
  private ws: WsLike | null = null;
  private pending: (string | Uint8Array)[] = [];
  private retry = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly sbs = new SbsEncoder();
  sent = 0; lastError = '';
  constructor(private readonly url: string, readonly format: WsFormat, private readonly Ws: WsCtor) { this.name = `ws:${format}`; this.connect(); }
  private connect(): void {
    if (this.closed) return;
    try {
      const ws = new this.Ws(this.url); ws.binaryType = 'arraybuffer'; this.ws = ws;
      ws.onopen = () => { this.retry = 1000; this.lastError = ''; const p = this.pending; this.pending = []; for (const m of p) this.send(m); };
      ws.onerror = () => { this.lastError = 'connection error'; };
      ws.onclose = () => { this.ws = null; if (!this.closed) { this.lastError ||= 'closed'; this.retryTimer = setTimeout(() => this.connect(), this.retry); this.retry = Math.min(30_000, this.retry * 2); } };
    } catch (e) { this.lastError = (e as Error).message; this.retryTimer = setTimeout(() => this.connect(), this.retry); this.retry = Math.min(30_000, this.retry * 2); }
  }
  private send(m: string | Uint8Array): void {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(m); this.sent++; return; }
    this.pending.push(m); if (this.pending.length > 500) this.pending.splice(0, this.pending.length - 500);
  }
  handle(ev: DecodeEvent): void { for (const m of formatEvent(this.format, ev, this.sbs)) this.send(m); }
  status(): string { return `${this.ws?.readyState === 1 ? 'connected' : 'not connected'} · ${this.sent} sent${this.pending.length ? `, ${this.pending.length} waiting` : ''}${this.lastError && this.ws?.readyState !== 1 ? ` · ${this.lastError}` : ''}`; }
  close(): void { this.closed = true; if (this.retryTimer) clearTimeout(this.retryTimer); try { this.ws?.close(); } catch { /* gone */ } this.ws = null; }
}
