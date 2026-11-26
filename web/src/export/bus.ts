/**
 * FORK: the decode export bus. Every decoder's results pass through here on their way to the screen (the bus
 * listens to the DSP worker beside the page's own handler) and go to whichever sinks are switched on.
 * Off by default; configured in Settings → EXPORT; nothing leaves the browser unless a network sink is set up.
 */
import { EventAdapter, type DecodeEvent, type EventContext } from './event.js';
import { LogSink, WebhookSink, WsSink, type FetchLike, type Sink, type WsCtor, type WsFormat } from './sinks.js';

export interface ExportConfig {
  enabled: boolean;
  log: boolean;
  webhook: { on: boolean; url: string };
  ws: { on: boolean; url: string; format: WsFormat };
  mqtt: { on: boolean; url: string; topic: string; user: string; pass: string; ha: boolean };
}

export const DEFAULT_CONFIG: ExportConfig = {
  enabled: false, log: true,
  webhook: { on: false, url: '' },
  ws: { on: false, url: 'ws://localhost:30005', format: 'jsonl' },
  mqtt: { on: false, url: 'ws://localhost:9001', topic: 'madmobile', user: '', pass: '', ha: false },
};

const KEY = 'mm.export.v1';
export function loadConfig(): ExportConfig {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ExportConfig> | null;
    if (!s) return structuredClone(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, ...s, webhook: { ...DEFAULT_CONFIG.webhook, ...s.webhook }, ws: { ...DEFAULT_CONFIG.ws, ...s.ws }, mqtt: { ...DEFAULT_CONFIG.mqtt, ...s.mqtt } };
  } catch { return structuredClone(DEFAULT_CONFIG); }
}
export function saveConfig(c: ExportConfig): void { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private window */ } }

export interface Transports { fetch?: FetchLike; WebSocket?: WsCtor; mqtt?: (c: ExportConfig['mqtt']) => Sink | null }

export class ExportBus {
  readonly log = new LogSink();
  private sinks: Sink[] = [];
  private readonly adapter = new EventAdapter();
  /** Events published since the page loaded (while enabled). */
  count = 0;
  constructor(public cfg: ExportConfig, private readonly t: Transports = {}) { this.rebuild(); }

  /** Apply a new configuration: network sinks are torn down and rebuilt; the in-page log is kept. */
  configure(cfg: ExportConfig): void { this.cfg = cfg; this.rebuild(); }

  private rebuild(): void {
    for (const s of this.sinks) s.close();
    this.sinks = [];
    const c = this.cfg;
    if (!c.enabled) return;
    if (c.log) this.sinks.push(this.log);
    if (c.webhook.on && c.webhook.url && this.t.fetch) this.sinks.push(new WebhookSink(c.webhook.url, this.t.fetch));
    if (c.ws.on && c.ws.url && this.t.WebSocket) this.sinks.push(new WsSink(c.ws.url, c.ws.format, this.t.WebSocket));
    if (c.mqtt.on && c.mqtt.url && this.t.mqtt) { const m = this.t.mqtt(c.mqtt); if (m) this.sinks.push(m); }
  }

  publish(ev: DecodeEvent): void {
    if (!this.cfg.enabled) return;
    this.count++;
    for (const s of this.sinks) { try { s.handle(ev); } catch { /* one sink's trouble is not the others' */ } }
  }

  /** A DSP worker message, as the page receives it. */
  fromWorker(m: Record<string, unknown>, ctx: EventContext): void {
    if (!this.cfg.enabled) return;
    for (const ev of this.adapter.map(m, ctx)) this.publish(ev);
  }

  /** Listen to the worker beside the page's own handler; `ctx` says which app and frequency each message is from. */
  attach(worker: { addEventListener(t: 'message', f: (e: MessageEvent) => void): void }, ctx: () => EventContext): void {
    worker.addEventListener('message', e => this.fromWorker(e.data as Record<string, unknown>, ctx()));
  }

  statuses(): [string, string][] { return this.sinks.map(s => [s.name, s.status()]); }
}
