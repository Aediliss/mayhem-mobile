/**
 * FORK: talkgroup and unit names for Dispatch, imported from the lists scanner users already keep. No DOM.
 *
 *  · RadioReference talkgroup CSV (the database's "download CSV": Decimal, Hex, Alpha Tag, Mode, Description, Tag,
 *    Category; read by its header, so column order and extra columns do not matter). LTR talkgroups may be written
 *    A-HH-GGG. A mode with E (encrypted) is noted.
 *  · OP25 tag files: one id per line, a tab, the name (an optional priority after another tab), talkgroups or unit IDs
 *    (OP25 keeps the two in separate files, so the import asks which).
 *  · SDRTrunk playlist / alias XML: each <alias name=…> with its <id type="talkgroup" | "radio" value=… protocol=…/>
 *    (and talkgroup ranges); the protocol maps to Dispatch's.
 *
 * A list applies to every system or to one protocol; lookups take the protocol from the start of a system's key.
 */

export type AliasKind = 'tg' | 'unit';
export const ALIAS_PROTOS = ['ALL', 'P25', 'DMR', 'NXDN', 'TETRA', 'SMARTNET', 'EDACS', 'MPT1327', 'LTR'] as const;
export type AliasProto = typeof ALIAS_PROTOS[number];

export interface AliasEntry { kind: AliasKind; id: number; name: string; proto?: AliasProto; note?: string }
export interface AliasList { name: string; format: string; proto: AliasProto; entries: AliasEntry[] }

const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]);
const attrs = (s: string) => { const o: Record<string, string> = {}; for (const m of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) o[m[1].toLowerCase()] = unxml(m[3] ?? m[4] ?? ''); return o; };

/** One CSV line → fields (quotes, doubled quotes inside them, commas or tabs). */
function csvLine(line: string, sep: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** An id as written: decimal, 0x hex, or LTR's A-HH-GGG (read as A·100000 + HH·1000 + GGG, as Dispatch lists LTR groups). */
export function parseId(s: string): number | null {
  const t = s.trim();
  let m = /^(\d)-(\d{1,2})-(\d{1,3})$/.exec(t); if (m) return Number(m[1]) * 100_000 + Number(m[2]) * 1000 + Number(m[3]);
  m = /^0x([0-9a-f]+)$/i.exec(t); if (m) return parseInt(m[1], 16);
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** SDRTrunk's protocol names → Dispatch's. */
const SDRT_PROTO: Record<string, AliasProto> = { APCO25: 'P25', DMR: 'DMR', NXDN: 'NXDN', MPT1327: 'MPT1327', LTR: 'LTR', LTR_NET: 'LTR', PASSPORT: 'LTR', 'LTR-NET': 'LTR' };

/** A file's text → entries, by its shape. `kind` is for OP25 files, which do not say. */
export function parseAliasText(text: string, kind: AliasKind = 'tg'): { format: string; entries: AliasEntry[]; errors: number } {
  const t = text.replace(/^﻿/, '');
  if (/<alias\b/i.test(t)) return parseSdrtrunk(t);
  const lines = t.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const sep = lines.length && lines[0].includes('\t') && !lines[0].includes(',') ? '\t' : ',';
  const head = csvLine(lines[0] ?? '', sep).map(x => x.toLowerCase());
  const col = (re: RegExp) => head.findIndex(h => re.test(h));
  const dec = col(/^(dec(imal)?|tgid|talkgroup|tg|id|radio ?id|rid)$/), alpha = col(/alpha/), desc = col(/^desc/);
  if (dec >= 0 && (alpha >= 0 || desc >= 0)) {
    // RadioReference (or any CSV with a header naming the id and a name column)
    const mode = col(/^mode$/), tag = col(/^tag$/), cat = col(/^category$/), entries: AliasEntry[] = []; let errors = 0;
    for (const l of lines.slice(1)) {
      const f = csvLine(l, sep), id = parseId(f[dec] ?? ''), name = (alpha >= 0 && f[alpha]) || (desc >= 0 ? f[desc] : '') || '';
      if (id === null || !name) { errors++; continue; }
      const notes = [desc >= 0 && alpha >= 0 && f[desc] && f[desc] !== name ? f[desc] : '', tag >= 0 ? f[tag] : '', cat >= 0 ? f[cat] : '', mode >= 0 && /E/.test(f[mode] ?? '') ? 'encrypted' : ''].filter(Boolean);
      entries.push({ kind: /radio|rid|unit/.test(head[dec]) ? 'unit' : 'tg', id, name, note: notes.join(' · ') || undefined });
    }
    return { format: 'RadioReference CSV', entries, errors };
  }
  // OP25: id <tab> name [<tab> priority]
  const entries: AliasEntry[] = []; let errors = 0;
  for (const l of lines) {
    const f = l.split('\t'), id = parseId(f[0] ?? ''), name = (f[1] ?? '').trim();
    if (id === null || !name) { errors++; continue; }
    entries.push({ kind, id, name });
  }
  return { format: 'OP25 tags', entries, errors };
}

function parseSdrtrunk(t: string): { format: string; entries: AliasEntry[]; errors: number } {
  const entries: AliasEntry[] = []; let errors = 0;
  for (const m of t.matchAll(/<alias\b([^>]*?)(\/>|>([\s\S]*?)<\/alias>)/gi)) {
    const name = attrs(m[1]).name ?? ''; if (!name || !m[3]) continue;
    for (const im of m[3].matchAll(/<id\b([^>]*?)\/?>/gi)) {
      const a = attrs(im[1]), type = (a.type ?? '').toLowerCase(), proto = SDRT_PROTO[(a.protocol ?? '').toUpperCase()];
      const kind: AliasKind | null = type === 'talkgroup' || type === 'talkgrouprange' ? 'tg' : type === 'radio' || type === 'radiorange' ? 'unit' : null;
      if (!kind) continue;
      // SDRTrunk writes an LTR talkgroup as area << 13 | home << 8 | group; Dispatch lists it as A·100000 + HH·1000 + GGG
      const conv = (v: number) => (a.protocol ?? '').toUpperCase() === 'LTR' ? ((v >> 13) & 1) * 100_000 + ((v >> 8) & 31) * 1000 + (v & 255) : v;
      if (type.endsWith('range')) {
        const lo = parseId(a.min ?? ''), hi = parseId(a.max ?? '');
        if (lo === null || hi === null || hi < lo || hi - lo > 10_000) { errors++; continue; }
        for (let v = lo; v <= hi; v++) entries.push({ kind, id: conv(v), name, proto });
      } else {
        const v = parseId(a.value ?? ''); if (v === null) { errors++; continue; }
        entries.push({ kind, id: conv(v), name, proto });
      }
    }
  }
  return { format: 'SDRTrunk XML', entries, errors };
}

/** The protocol a Dispatch system key starts with ('P25 …', 'DMR …', 'EDACS …'). */
export const protoOfSys = (sys: string): string => /^[A-Z0-9]+/.exec(sys)?.[0] ?? '';

/** All imported lists, looked up by protocol, kind and id; a list scoped to a protocol wins over an ALL list. */
export class AliasBook {
  private readonly maps = new Map<string, { name: string; note?: string }>();
  constructor(readonly lists: AliasList[] = []) { this.rebuild(); }
  rebuild(): void {
    this.maps.clear();
    // ALL lists first, then scoped ones over them; within a level, later lists win
    for (const pass of [true, false]) for (const l of this.lists) {
      if ((l.proto === 'ALL') !== pass) continue;
      for (const e of l.entries) { const p = e.proto ?? l.proto; this.maps.set(`${p}|${e.kind}|${e.id}`, { name: e.name, note: e.note }); }
    }
  }
  /** The name of talkgroup / unit `id` on system `sys` (its key), or ''. */
  name(sys: string, kind: AliasKind, id: number): string { return this.get(sys, kind, id)?.name ?? ''; }
  note(sys: string, kind: AliasKind, id: number): string { return this.get(sys, kind, id)?.note ?? ''; }
  private get(sys: string, kind: AliasKind, id: number): { name: string; note?: string } | undefined {
    const p = protoOfSys(sys);
    return (p ? this.maps.get(`${p}|${kind}|${id}`) : undefined) ?? this.maps.get(`ALL|${kind}|${id}`);
  }
  get size(): number { return this.maps.size; }
}

const KEY = 'mm.aliases.v1';
export function loadAliasLists(): AliasList[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter(l => l && Array.isArray(l.entries)) : []; } catch { return []; }
}
/** Saves the lists; false when the browser's storage is full or off. */
export function saveAliasLists(lists: AliasList[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(lists)); return true; } catch { return false; }
}
