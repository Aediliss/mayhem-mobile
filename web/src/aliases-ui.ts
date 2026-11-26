/**
 * FORK: Settings → ALIASES: import talkgroup and unit names (RadioReference CSV, OP25 tags, SDRTrunk XML) for Dispatch.
 * Built from the classes Settings already uses (sset, srow, tog, txin, li, link, caption).
 */
import { ALIAS_PROTOS, AliasBook, loadAliasLists, parseAliasText, saveAliasLists, type AliasKind, type AliasList, type AliasProto } from './aliases.js';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The book Dispatch reads names from; replaced in place when lists change. */
export const aliasBook = new AliasBook(loadAliasLists());

export function aliasSettingsHtml(): string {
  return `<section class="sset" id="sec-alias"><div class="sset-h">ALIASES</div>
    <div class="srow" data-keys="aliases talkgroup names unit names radioreference op25 sdrtrunk import csv tsv xml"><div class="srl"><b>Talkgroup and unit names</b><small>Dispatch shows these beside the numbers. Import a RadioReference talkgroup CSV, an OP25 tag file (talkgroups or radio IDs, one per line: the number, a tab, the name) or an SDRTrunk playlist XML. A list can apply to every system or to one protocol. Kept in this browser only.</small></div></div>
    <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">
      <select id="al-proto" class="txin" aria-label="Protocol the list applies to" style="flex:1">${ALIAS_PROTOS.map(p => `<option value="${p}">${p === 'ALL' ? 'every system' : p}</option>`).join('')}</select>
      <select id="al-kind" class="txin" aria-label="What an OP25 file holds" style="flex:1"><option value="tg">OP25 file: talkgroups</option><option value="unit">OP25 file: radio IDs</option></select>
      <button id="al-import" class="tog">IMPORT FILE</button><input id="al-file" type="file" accept=".csv,.tsv,.txt,.xml" hidden multiple>
    </div>
    <div class="row" style="margin-top:6px"><span id="al-status" class="caption"></span></div>
    <div id="al-list" class="panel list" style="margin-top:6px"></div>
  </section>`;
}

/** Wire the section; `changed` runs after the lists change (Dispatch redraws with the new names). */
export function bindAliasSettings(root: ParentNode, changed: () => void): void {
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T | null;
  const list = q('#al-list'), st = q('#al-status'), file = q<HTMLInputElement>('#al-file'), btn = q<HTMLButtonElement>('#al-import');
  if (!list || !st || !file || !btn) return;
  const lists = aliasBook.lists as AliasList[];
  const commit = (msg: string) => {
    const ok = saveAliasLists(lists); aliasBook.rebuild();
    st.textContent = ok ? msg : `${msg} · not saved: this browser's storage is full or off`;
    draw(); changed();
  };
  const draw = () => {
    list.innerHTML = lists.length ? lists.map((l, i) => {
      const tg = l.entries.filter(e => e.kind === 'tg').length, un = l.entries.length - tg;
      return `<div class="li row2 ${i % 2 ? 'alt' : ''}"><span style="text-align:left">${esc(l.name)} · ${esc(l.format)} · ${l.proto === 'ALL' ? 'every system' : esc(l.proto)} · ${tg} talkgroups${un ? ` · ${un} units` : ''}</span><button class="link" data-aldel="${i}" aria-label="remove ${esc(l.name)}">✕</button></div>`;
    }).join('') : '';
    list.querySelectorAll<HTMLElement>('[data-aldel]').forEach(el => el.onclick = () => { const l = lists.splice(Number(el.dataset.aldel), 1)[0]; commit(`removed ${l?.name ?? ''}`); });
    if (!st.textContent) st.textContent = lists.length ? `${aliasBook.size} names` : 'no names imported';
  };
  btn.onclick = () => file.click();
  file.onchange = async () => {
    const proto = (q<HTMLSelectElement>('#al-proto')?.value ?? 'ALL') as AliasProto, kind = (q<HTMLSelectElement>('#al-kind')?.value ?? 'tg') as AliasKind;
    const msgs: string[] = [];
    for (const f of Array.from(file.files ?? [])) {
      const r = parseAliasText(await f.text(), kind);
      if (!r.entries.length) { msgs.push(`${f.name}: no names found`); continue; }
      lists.push({ name: f.name, format: r.format, proto, entries: r.entries });
      msgs.push(`${f.name}: ${r.entries.length} names (${r.format})${r.errors ? `, ${r.errors} lines skipped` : ''}`);
    }
    file.value = '';
    commit(msgs.join(' · '));
  };
  draw();
}
