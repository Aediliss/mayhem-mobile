/**
 * FORK: FANS-1/A CPDLC message bodies (ARINC 622 AT1 / CR1 / CC1 / DR1), receive only: unaligned PER decoded with the
 * schema in fans.ts, by the rules of asn1c 0.9.28's runtime that libacars uses (Lev Walkin, BSD-2-Clause:
 * per_support.c, constr_SEQUENCE.c, constr_CHOICE.c, constr_SET_OF.c, INTEGER.c, NativeEnumerated.c, OCTET_STRING.c),
 * then worded the way libacars words it: each element's controller/pilot phrase with its values put in. An encoder is
 * here for the tests only. No DOM.
 */
import { FANS_TEXT, FANS_TYPES, type FansType } from './fans.js';

export type FansValue =
  | { t: number; seq: Record<string, FansValue> }
  | { t: number; choice: string; val: FansValue }
  | { t: number; list: FansValue[] }
  | { t: number; int: number }
  | { t: number; enum: number; name: string }
  | { t: number; bool: boolean }
  | { t: number; null: true }
  | { t: number; str: string };

const byName = new Map(FANS_TYPES.map((t, i) => [t.n, i]));
export const UPLINK = byName.get('FANSATCUplinkMessage')!, DOWNLINK = byName.get('FANSATCDownlinkMessage')!;

class BitIn {
  p = 0;
  constructor(private readonly b: Uint8Array) {}
  get left(): number { return this.b.length * 8 - this.p; }
  read(n: number): number {
    if (n > this.left) throw new Error('PER: out of bits');
    let v = 0; for (let i = 0; i < n; i++, this.p++) v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    return v;
  }
  /** X.691 10.9 length (unconstrained): 7 bits, or 14 bits after "10"; fragments are not used by FANS. */
  length(): number {
    const v = this.read(8); if (!(v & 0x80)) return v;
    if (!(v & 0x40)) return ((v & 0x3f) << 8) | this.read(8);
    throw new Error('PER: fragmented length');
  }
}

function decodeType(id: number, r: BitIn): FansValue {
  const ty = FANS_TYPES[id];
  switch (ty.k) {
    case 0: {
      const m = ty.m ?? [], present = m.map(x => x[2] ? r.read(1) === 1 : true), seq: Record<string, FansValue> = {};
      m.forEach((x, i) => { if (present[i]) seq[x[0]] = decodeType(x[1], r); });
      return { t: id, seq };
    }
    case 1: {
      const v = ty.v!; let idx = r.read(v[1]);
      if (idx > v[3]) throw new Error(`PER: ${ty.n} choice ${idx} out of range`);
      if (ty.c) idx = ty.c[idx];
      const [name, sub] = ty.m![idx];
      return { t: id, choice: name, val: decodeType(sub, r) };
    }
    case 2: {
      const n = sizeOf(ty, r), list: FansValue[] = [];
      for (let i = 0; i < n; i++) list.push(decodeType(ty.m![0][1], r));
      return { t: id, list };
    }
    case 3: {
      const v = ty.v;
      if (v && v[0] & 2) return { t: id, int: v[2] + (v[1] > 0 ? r.read(v[1]) : 0) };
      const n = r.length(); let x = 0; for (let i = 0; i < n; i++) x = x * 256 + r.read(8);
      if (v && v[0] & 1) return { t: id, int: v[2] + x };
      if (n && x >= 2 ** (8 * n - 1)) x -= 2 ** (8 * n);
      return { t: id, int: x };
    }
    case 4: {
      const i = r.read(ty.v![1]); if (i >= ty.e!.length) throw new Error(`PER: ${ty.n} enumeration ${i}`);
      return { t: id, enum: ty.e![i][0], name: ty.e![i][1] };
    }
    case 5: return { t: id, bool: r.read(1) === 1 };
    case 6: return { t: id, null: true };
    default: {
      const n = sizeOf(ty, r), v = ty.v, bits = v && v[0] & 2 ? v[1] : 8, ub = v ? v[3] : 255, lb = v ? v[2] : 0;
      let s = '';
      for (let i = 0; i < n; i++) {
        const c = r.read(bits);
        // asn1c (X.691 27.5.4): when every value fits the character width, the code is the character itself
        const ch = ub <= 2 << (bits - 1) ? c : ty.a ? ty.a.charCodeAt(c) : c + lb;
        if (!ch && ty.a) throw new Error(`PER: ${ty.n} code ${c} not in its alphabet`);
        s += String.fromCharCode(ch);
      }
      return { t: id, str: s };
    }
  }
}
function sizeOf(ty: FansType, r: BitIn): number {
  const s = ty.s;
  if (!s) return r.length();
  if (s[1] === 0) return s[3];
  return s[2] + (s[1] > 0 ? r.read(s[1]) : r.length());
}

/** A CPDLC message's octets (the ARINC 622 payload, CRC removed): the decoded tree, or null when it does not parse. */
export function decodeCpdlc(bytes: Uint8Array, down: boolean): FansValue | null {
  try { const r = new BitIn(bytes); const v = decodeType(down ? DOWNLINK : UPLINK, r); return r.left < 8 ? v : null; }
  catch { return null; }
}

// ------------------------------------------------------------------------------------------------------ wording

const T = (v: FansValue) => FANS_TYPES[v.t];
/** One value, short: "FL350", "12:34", "N49°30.0'", "KJFK", "350 kts". */
export function fansShort(v: FansValue): string {
  const ty = T(v), f = ty.f;
  if ('int' in v) {
    if (f && f[0] === 'unit') { const x = v.int * (f[2] as number); return `${x.toFixed(f[3] as number)}${f[1]}`.trim(); }
    if (ty.l === 'Flight level') return `FL${v.int}`;
    return String(v.int);
  }
  if ('str' in v) return v.str.trim();
  if ('enum' in v) return v.name;
  if ('bool' in v) return v.bool ? 'yes' : 'no';
  if ('null' in v) return '';
  if ('choice' in v) return fansShort(v.val);
  if ('list' in v) {
    if (f && f[0] === 'beacon') return v.list.map(fansShort).join('');
    return v.list.map(fansShort).filter(Boolean).join(', ');
  }
  const s = v.seq, get = (k: string) => s[k] && 'int' in s[k] ? (s[k] as { int: number }).int : null;
  if (f && (f[0] === 'time' || f[0] === 'timestamp')) {
    const p2 = (n: number | null) => String(n ?? 0).padStart(2, '0');
    return `${p2(get('hours') ?? get('timehours'))}:${p2(get('minutes') ?? get('timeminutes'))}${f[0] === 'timestamp' ? `:${p2(get('seconds') ?? get('timeseconds'))}` : ''}`;
  }
  if (f && (f[0] === 'lat' || f[0] === 'lon')) {
    const vals = Object.values(s), deg = vals.find(x => 'int' in x && /Degrees/.test(T(x).n)) as { int: number } | undefined;
    const min = vals.find(x => 'int' in x && /minutes/i.test(T(x).n)) as { int: number } | undefined, dir = vals.find(x => 'enum' in x) as { name: string } | undefined;
    const d = (dir?.name ?? '')[0]?.toUpperCase() ?? '';
    return `${d}${deg?.int ?? 0}°${min ? `${(min.int / 10).toFixed(1)}'` : ''}`;
  }
  return Object.values(s).map(fansShort).filter(Boolean).join(' ');
}

/** The parameters an element's phrase has blanks for, in order. */
function params(v: FansValue, blanks: number): FansValue[] {
  if ('null' in v) return [];
  if (blanks <= 1) return [v];
  if ('seq' in v && !T(v).f && !T(v).l) return Object.values(v.seq);
  if ('list' in v && !T(v).f && !T(v).l && v.list.length === 2) return v.list;   // e.g. block altitudes
  return [v];
}
/** An element: its phrase with the values in its blanks ("CLIMB TO AND MAINTAIN FL350"). */
export function elementText(choice: string, v: FansValue): string {
  const tpl = FANS_TEXT[choice] ?? choice, ps = params(v, (tpl.match(/\[[^\]]+\]/g) ?? []).length);
  let i = 0;
  const out = tpl.replace(/\[[^\]]+\]/g, m => i < ps.length ? fansShort(ps[i++]) || m : m);
  return i < ps.length && ps.slice(i).some(p => fansShort(p)) ? `${out} (${ps.slice(i).map(fansShort).join(', ')})` : out;
}

export interface CpdlcRead { id: number | null; ref: number | null; time: string; elements: string[]; text: string }
/** A decoded message as the screens read it: header and each element's phrase. */
export function cpdlcRead(m: FansValue): CpdlcRead {
  if (!('seq' in m)) return { id: null, ref: null, time: '', elements: [], text: '' };
  const s = m.seq, hdr = s.aTCMessageheader, elements: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'aTCMessageheader') continue;
    const each = 'list' in v ? v.list : [v];
    for (const e of each) if ('choice' in e) elements.push(elementText(e.choice, e.val));
  }
  let id: number | null = null, ref: number | null = null, time = '';
  if (hdr && 'seq' in hdr) for (const x of Object.values(hdr.seq)) {
    const n = T(x).n;
    if (n === 'FANSMsgIdentificationNumber' && 'int' in x) id = x.int;
    else if (n === 'FANSMsgReferenceNumber' && 'int' in x) ref = x.int;
    else if (/Timestamp/.test(n)) time = fansShort(x);
  }
  return { id, ref, time, elements, text: elements.join(' · ') };
}

// ------------------------------------------------------------------------------------------------ test encoder

class BitOut {
  bits: number[] = [];
  put(v: number, n: number): void { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1); }
  length(n: number): void { if (n < 128) this.put(n, 8); else if (n < 16384) this.put(0x8000 | n, 16); else throw new Error('PER: too long'); }
  bytes(): Uint8Array { const o = new Uint8Array(Math.ceil(this.bits.length / 8)); this.bits.forEach((b, i) => { if (b) o[i >> 3] |= 0x80 >> (i & 7); }); return o; }
}
/** A plain description of a value: numbers, strings, enumeration names, { choice: value } objects, arrays, field objects. */
export type FansPlain = number | string | boolean | null | FansPlain[] | { [k: string]: FansPlain };
function encodeType(id: number, p: FansPlain, w: BitOut): void {
  const ty = FANS_TYPES[id];
  switch (ty.k) {
    case 0: {
      const o = (p ?? {}) as Record<string, FansPlain>, m = ty.m ?? [];
      for (const x of m) if (x[2]) w.put(x[0] in o ? 1 : 0, 1);
      for (const x of m) { if (!(x[0] in o)) { if (!x[2]) throw new Error(`${ty.n}: ${x[0]} missing`); continue; } encodeType(x[1], o[x[0]], w); }
      return;
    }
    case 1: {
      const [name, val] = Object.entries(p as Record<string, FansPlain>)[0], idx = ty.m!.findIndex(x => x[0] === name);
      if (idx < 0) throw new Error(`${ty.n}: no ${name}`);
      const code = ty.c ? ty.c.indexOf(idx) : idx;
      w.put(code, ty.v![1]); encodeType(ty.m![idx][1], val, w); return;
    }
    case 2: { const a = p as FansPlain[]; sizeOut(ty, a.length, w); for (const x of a) encodeType(ty.m![0][1], x, w); return; }
    case 3: { const v = ty.v!; w.put((p as number) - v[2], v[1]); return; }
    case 4: { const i = ty.e!.findIndex(x => x[1] === p || x[0] === p); if (i < 0) throw new Error(`${ty.n}: ${p}`); w.put(i, ty.v![1]); return; }
    case 5: w.put(p ? 1 : 0, 1); return;
    case 6: return;
    default: {
      const s = String(p), v = ty.v, bits = v && v[0] & 2 ? v[1] : 8, ub = v ? v[3] : 255, lb = v ? v[2] : 0;
      sizeOut(ty, s.length, w);
      for (const ch of s) { const c = ch.charCodeAt(0); w.put(ub <= 2 << (bits - 1) ? c : ty.a ? ty.a.indexOf(ch) : c - lb, bits); }
    }
  }
}
function sizeOut(ty: FansType, n: number, w: BitOut): void {
  const s = ty.s;
  if (!s) { w.length(n); return; }
  if (s[1] === 0) { if (n !== s[3]) throw new Error(`${ty.n}: size ${n} must be ${s[3]}`); return; }
  w.put(n - s[2], s[1]);
}
/** Test encoder: a message from a plain description (uplink or downlink root). */
export function encodeCpdlc(p: FansPlain, down: boolean): Uint8Array {
  const w = new BitOut(); encodeType(down ? DOWNLINK : UPLINK, p, w); return w.bytes();
}
