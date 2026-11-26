/**
 * FORK: Settings → VOICE RECORDING. Built from the classes Settings already uses (sset, srow, sw, tog, li, link).
 */
import type { VoiceRecorder } from './recorder.js';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function voiceSettingsHtml(rec: VoiceRecorder): string {
  return `<section class="sset" id="sec-voice"><div class="sset-h">VOICE RECORDING</div>
    <div class="srow" data-keys="voice recording record calls wav talkgroup"><div class="srl"><b>Record voice calls</b><small>Saves each call the receiver apps play (Dispatch, Repeaters, Prowl, CB, Ham Radio, Audio) as a WAV in this browser, named and tagged with its talkgroup, unit, frequency and time. Only what the app already plays: encrypted calls are never voiced, so never recorded. Recording radio traffic is restricted in some places; check where you are.</small></div>
    <div class="src"><button id="vr-on" class="sw ${rec.enabled ? 'on' : ''}" role="switch" aria-checked="${rec.enabled}" aria-label="Record voice calls"><i></i></button></div></div>
    <div class="row" style="margin-top:6px"><button id="vr-delall" class="tog">DELETE ALL</button><span id="vr-count" class="caption"></span></div>
    <div id="vr-list" class="panel list" style="margin-top:6px"></div>
  </section>`;
}

export function bindVoiceSettings(root: ParentNode, rec: VoiceRecorder): () => Promise<void> {
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T | null;
  const refresh = async () => {
    const list = q('#vr-list'), count = q('#vr-count'); if (!list) return;
    const files = await rec.list();
    if (count) count.textContent = files.length ? `${files.length} call${files.length === 1 ? '' : 's'} · ${(files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1)} MB` : 'no calls recorded';
    list.innerHTML = files.length ? files.map((f, i) => `<div class="li row2 ${i % 2 ? 'alt' : ''}"><button class="link tap" data-vrdl="${esc(f.name)}" aria-label="download ${esc(f.name)}" style="text-align:left">${esc(f.name)}  ${f.seconds.toFixed(0)} s</button><button class="link" data-vrdel="${esc(f.name)}" aria-label="delete ${esc(f.name)}">✕</button></div>`).join('') : '';
    list.querySelectorAll<HTMLElement>('[data-vrdl]').forEach(el => el.onclick = async () => {
      const f = await rec.file(el.dataset.vrdl!), a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
    list.querySelectorAll<HTMLElement>('[data-vrdel]').forEach(el => el.onclick = async () => { await rec.remove(el.dataset.vrdel!); await refresh(); });
  };
  const on = q<HTMLButtonElement>('#vr-on');
  if (on) on.onclick = () => { rec.setEnabled(!rec.enabled); on.classList.toggle('on', rec.enabled); on.setAttribute('aria-checked', String(rec.enabled)); };
  const all = q<HTMLButtonElement>('#vr-delall');
  if (all) all.onclick = async () => { if (!confirm('Delete every recorded call?')) return; for (const f of await rec.list()) await rec.remove(f.name); await refresh(); };
  void refresh();
  return refresh;
}
