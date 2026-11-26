/**
 * FORK: the Analyzer's protocol library on its own: the saved protocols (sync word, modulation, coding, symbol time,
 * named fields, the checksum found) as a small JSON file that can be shared and merged, without the captured bursts a
 * session file carries. Imported files are untrusted: every protocol is checked field by field and rebuilt from the
 * checked values only; anything malformed is skipped and counted. No DOM.
 */
import { FIELD_KINDS, type CheckFound, type Field, type Protocol } from './fields.js';

export const LIBRARY_FORMAT = 'mad-mobile.analyzer-protocols';

/** The library file's text. */
export function libraryJson(protocols: Protocol[], app: string, now = new Date()): string {
  return JSON.stringify({ format: LIBRARY_FORMAT, version: 1, app, saved: now.toISOString(), protocols }, null, 1);
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const CHECK_KINDS = ['crc', 'sum8', 'xor8', 'negsum8', 'sum16'] as const;

function field(v: unknown): Field | null {
  const f = v as Record<string, unknown>;
  if (!f || typeof f !== 'object' || !isStr(f.name, 64) || !FIELD_KINDS.includes(f.kind as Field['kind']) || !isInt(f.from, -4096, 4096) || !isInt(f.to, -4096, 4096) || f.to <= f.from) return null;
  return { name: f.name, kind: f.kind as Field['kind'], from: f.from, to: f.to };
}
function check(v: unknown): CheckFound | null {
  const c = v as Record<string, unknown>, s = c?.spec as Record<string, unknown>;
  if (!c || typeof c !== 'object' || !s || typeof s !== 'object' || !isStr(c.name, 120) || !CHECK_KINDS.includes(s.kind as typeof CHECK_KINDS[number])) return null;
  if (!isInt(s.width, 1, 32) || !isInt(s.poly, 0, 0xffffffff) || !isInt(s.init, 0, 0xffffffff) || !isInt(s.xorout, 0, 0xffffffff) || typeof s.refl !== 'boolean') return null;
  if (!isInt(c.from, 0, 4096) || !isInt(c.to, 0, 4096) || c.to < c.from || !isInt(c.at, 0, 4096) || typeof c.little !== 'boolean') return null;
  return { name: c.name, spec: { kind: s.kind as CheckFound['spec']['kind'], width: s.width, poly: s.poly, init: s.init, refl: s.refl, xorout: s.xorout }, from: c.from, to: c.to, at: c.at, little: c.little };
}
/** One protocol, rebuilt from checked values, or null. */
export function cleanProtocol(v: unknown): Protocol | null {
  const p = v as Record<string, unknown>;
  if (!p || typeof p !== 'object' || !isStr(p.name, 80) || typeof p.sync !== 'string' || !/^[01]{1,512}$/.test(p.sync)) return null;
  if (!isStr(p.mod, 32) || !isStr(p.coding, 32) || typeof p.symUs !== 'number' || !(p.symUs > 0 && p.symUs < 1e7) || !Array.isArray(p.fields) || p.fields.length > 64) return null;
  const fields = p.fields.map(field);
  if (fields.some(f => !f)) return null;
  const out: Protocol = { name: p.name, sync: p.sync, mod: p.mod, coding: p.coding, symUs: p.symUs, fields: fields as Field[] };
  if (p.check !== undefined && p.check !== null) { const c = check(p.check); if (!c) return null; out.check = c; }
  return out;
}

/**
 * A library file's protocols. Takes this fork's library file, an upstream session's JSON part (anything with a
 * `protocols` array) or a bare array of protocols.
 */
export function readLibrary(text: string): { protocols: Protocol[]; skipped: number; error?: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { protocols: [], skipped: 0, error: 'not JSON' }; }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { protocols?: unknown }).protocols) ? (v as { protocols: unknown[] }).protocols : null;
  if (!list) return { protocols: [], skipped: 0, error: 'no protocols in it' };
  const protocols: Protocol[] = []; let skipped = 0;
  for (const x of list.slice(0, 500)) { const p = cleanProtocol(x); if (p) protocols.push(p); else skipped++; }
  return { protocols, skipped: skipped + Math.max(0, list.length - 500) };
}

const same = (a: Protocol, b: Protocol) => a.sync === b.sync && a.mod === b.mod && a.coding === b.coding && JSON.stringify(a.fields) === JSON.stringify(b.fields) && JSON.stringify(a.check ?? null) === JSON.stringify(b.check ?? null);

/**
 * Adds `incoming` to `into` (in place): a protocol identical to one already saved is skipped; one whose name is taken by
 * a different protocol is added as "name (2)".
 */
export function mergeProtocols(into: Protocol[], incoming: Protocol[]): { added: number; same: number; renamed: number } {
  let added = 0, dup = 0, renamed = 0;
  for (const p of incoming) {
    if (into.some(q => same(q, p))) { dup++; continue; }
    let name = p.name, n = 2;
    while (into.some(q => q.name === name)) name = `${p.name} (${n++})`;
    if (name !== p.name) renamed++;
    into.push({ ...p, name }); added++;
  }
  return { added, same: dup, renamed };
}
