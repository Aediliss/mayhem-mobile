/**
 * FORK: Settings → EXPORT. Built from the classes Settings already uses (sset, srow, sw, tog, chip, txin).
 */
import { saveConfig, type ExportBus, type ExportConfig } from './bus.js';
import { WS_FORMATS } from './sinks.js';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const sw = (id: string, on: boolean) => `<button id="${id}" class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}"><i></i></button>`;
const row = (label: string, desc: string, control: string) => `<div class="srow" data-keys="${esc((label + ' ' + desc + ' export').toLowerCase())}"><div class="srl"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="src">${control}</div></div>`;
const input = (id: string, value: string, ph: string, type = 'text') => `<input id="${id}" class="txin" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" style="margin-top:6px">`;

export function exportSettingsHtml(bus: ExportBus, opts: { mqtt: boolean } = { mqtt: false }): string {
  const c = bus.cfg;
  const fmt = WS_FORMATS.map(([id, label]) => `<button class="chip ${c.ws.format === id ? 'on' : ''}" data-exfmt="${id}" title="${esc(label)}">${id.toUpperCase()}</button>`).join('');
  return `<section class="sset" id="sec-export"><div class="sset-h">EXPORT</div>
    ${row('Export decodes', 'Off by default. Sends what the decoders find to the outputs switched on below; nothing leaves this browser unless you set up a network output.', sw('ex-on', c.enabled))}
    ${row('Decode log', 'Every result as JSON lines, kept in this page (last 20,000) to download.', `${sw('ex-log', c.log)}<button id="ex-dl" class="tog">DOWNLOAD</button><button id="ex-clr" class="tog">CLEAR</button>`)}
    ${row('Webhook', 'POSTs batches of results as JSON every 2 s. The server must allow this page (CORS) and use https unless it is on localhost.', sw('ex-wh', c.webhook.on))}
    ${input('ex-wh-url', c.webhook.url, 'https://example.com/hook', 'url')}
    ${row('WebSocket stream', 'Streams one format to a WebSocket server. For tools that listen on TCP (readsb, OpenCPN, Direwolf) put a bridge such as websockify in front. From the https site only ws://localhost or wss:// work.', sw('ex-ws', c.ws.on))}
    ${input('ex-ws-url', c.ws.url, 'ws://localhost:30005', 'url')}
    <div class="row" style="flex-wrap:wrap;gap:4px;margin-top:6px">${fmt}</div>
    ${opts.mqtt ? `${row('MQTT', 'Publishes results to an MQTT broker over WebSockets (Mosquitto: listener 9001 + protocol websockets). The password is stored in this browser.', sw('ex-mq', c.mqtt.on))}
    ${input('ex-mq-url', c.mqtt.url, 'ws://localhost:9001', 'url')}${input('ex-mq-topic', c.mqtt.topic, 'topic prefix: madmobile')}
    <div class="row" style="gap:6px">${input('ex-mq-user', c.mqtt.user, 'user (optional)')}${input('ex-mq-pass', c.mqtt.pass, 'password (optional)', 'password')}</div>
    ${row('Home Assistant discovery', 'Announce Devices sensors (temperature, humidity, battery …) so Home Assistant adds them by itself.', sw('ex-ha', c.mqtt.ha))}` : ''}
    <div id="ex-status" class="caption" style="margin-top:6px;white-space:pre-line"></div>
  </section>`;
}

/** Wire the section's controls; returns a function that refreshes the status lines (call it on a timer). */
export function bindExportSettings(root: ParentNode, bus: ExportBus, log: (l: string) => void): () => void {
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T | null;
  const c: ExportConfig = structuredClone(bus.cfg);
  const apply = () => { saveConfig(c); bus.configure(structuredClone(c)); refresh(); };
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = q<HTMLButtonElement>(`#${id}`); if (!b) return;
    b.onclick = () => { set(!get()); b.classList.toggle('on', get()); b.setAttribute('aria-checked', String(get())); apply(); };
  };
  const text = (id: string, set: (v: string) => void, check?: (v: string) => string) => {
    const i = q<HTMLInputElement>(`#${id}`); if (!i) return;
    i.onchange = () => { const v = i.value.trim(), bad = check?.(v) ?? ''; if (bad) { log(`export: ${bad}`); i.style.borderColor = 'var(--danger)'; return; } i.style.borderColor = ''; set(v); apply(); };
  };
  const scheme = (allowed: string[]) => (v: string) => (!v || allowed.some(s => v.startsWith(s)) ? '' : `${v} must start with ${allowed.join(' or ')}`);
  toggle('ex-on', () => c.enabled, v => { c.enabled = v; });
  toggle('ex-log', () => c.log, v => { c.log = v; });
  toggle('ex-wh', () => c.webhook.on, v => { c.webhook.on = v; });
  toggle('ex-ws', () => c.ws.on, v => { c.ws.on = v; });
  toggle('ex-mq', () => c.mqtt.on, v => { c.mqtt.on = v; });
  toggle('ex-ha', () => c.mqtt.ha, v => { c.mqtt.ha = v; });
  text('ex-wh-url', v => { c.webhook.url = v; }, scheme(['https://', 'http://']));
  text('ex-ws-url', v => { c.ws.url = v; }, scheme(['wss://', 'ws://']));
  text('ex-mq-url', v => { c.mqtt.url = v; }, scheme(['wss://', 'ws://']));
  text('ex-mq-topic', v => { c.mqtt.topic = v.replace(/[#+]/g, '').replace(/\/+$/, '') || 'madmobile'; });
  text('ex-mq-user', v => { c.mqtt.user = v; });
  text('ex-mq-pass', v => { c.mqtt.pass = v; });
  root.querySelectorAll<HTMLButtonElement>('[data-exfmt]').forEach(b => b.onclick = () => {
    c.ws.format = b.dataset.exfmt as ExportConfig['ws']['format'];
    root.querySelectorAll<HTMLButtonElement>('[data-exfmt]').forEach(x => x.classList.toggle('on', x === b)); apply();
  });
  const dl = q<HTMLButtonElement>('#ex-dl');
  if (dl) dl.onclick = () => {
    const t = bus.log.text(); if (!t) { log('export: the decode log is empty'); return; }
    const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'application/x-ndjson' }));
    a.download = `madmobile-decodes-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };
  const clr = q<HTMLButtonElement>('#ex-clr'); if (clr) clr.onclick = () => { bus.log.clear(); refresh(); };
  const refresh = () => {
    const s = q('#ex-status'); if (!s) return;
    s.textContent = !bus.cfg.enabled ? 'export is off' : [`${bus.count} results exported since this page opened`, ...bus.statuses().map(([n, st]) => `${n}: ${st}`)].join('\n');
  };
  refresh();
  return refresh;
}
