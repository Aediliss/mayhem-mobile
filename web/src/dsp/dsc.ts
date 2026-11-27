/**
 * FORK: marine Digital Selective Calling on VHF channel 70 (156.525 MHz), receive only, written from ITU-R M.493-16
 * (no code ported). FM with a 1700 Hz sub-carrier shifted between 2100 Hz (B, 0) and 1300 Hz (Y, 1) at 1200 bit/s
 * (Annex 1 §1.3.2, §1.4). Each character is 10 bits: 7 information bits least significant first, then the number of
 * B (0) bits among them as 3 bits most significant first (§1.1.1). Every character but the phasing ones is sent twice,
 * DX then RX four characters later (§1.2); the phasing sequence puts symbol 125 in the DX positions and 111…104 in the
 * RX positions (§3), and three phasing characters in the right places fix the character alignment. Then: format
 * specifier (twice), address, category, self-ID, telecommands or the distress information, end of sequence (117, 122,
 * 127) and the error-check character (§10: even vertical parity over the information characters, one format specifier
 * and one EOS). MMSIs are five two-digit characters (the tenth digit 0); positions are quadrant, degrees and minutes;
 * channels and frequencies as Table A1-5. A call whose ECC does not check is not reported.
 */
import { BitSync, DiscFilter, type Emit, type IqProcessor } from './core.js';

export const DSC_BAUD = 1200, DSC_Y_HZ = 1300, DSC_B_HZ = 2100, DSC_CH70_HZ = 156_525_000;

/** Symbol → its 10 bits as sent (bit 1 first). */
export function dscBits(sym: number): number[] {
  const out: number[] = []; let zeros = 0;
  for (let i = 0; i < 7; i++) { const b = (sym >> i) & 1; out.push(b); if (!b) zeros++; }
  out.push((zeros >> 2) & 1, (zeros >> 1) & 1, zeros & 1);
  return out;
}
/** 10 bits as received → symbol, or -1 when the check bits disagree. */
export function dscSymbol(bits: ArrayLike<number>, at = 0): number {
  let sym = 0, zeros = 0;
  for (let i = 0; i < 7; i++) { const b = bits[at + i]; sym |= b << i; if (!b) zeros++; }
  const chk = (bits[at + 7] << 2) | (bits[at + 8] << 1) | bits[at + 9];
  return chk === zeros ? sym : -1;
}

export const DSC_FORMAT: Record<number, string> = { 112: 'Distress', 116: 'All ships', 114: 'Group', 120: 'Individual', 102: 'Geographic area', 123: 'Individual (automatic)' };
export const DSC_CATEGORY: Record<number, string> = { 100: 'Routine', 108: 'Safety', 110: 'Urgency', 112: 'Distress' };
export const DSC_NATURE: Record<number, string> = { 100: 'Fire, explosion', 101: 'Flooding', 102: 'Collision', 103: 'Grounding', 104: 'Listing, in danger of capsizing', 105: 'Sinking', 106: 'Disabled and adrift', 107: 'Undesignated distress', 108: 'Abandoning ship', 109: 'Piracy/armed robbery attack', 110: 'Man overboard' };
export const DSC_TC1: Record<number, string> = { 100: 'F3E/G3E all modes TP', 101: 'F3E/G3E duplex TP', 103: 'Polling', 104: 'Unable to comply', 105: 'End of call', 106: 'Data', 109: 'J3E TP', 110: 'Distress acknowledgement', 112: 'Distress alert relay', 113: 'F1B/J2B TTY-FEC', 115: 'F1B/J2B TTY-ARQ', 118: 'Test', 121: 'Ship position or location registration updating', 126: 'No information' };
export const DSC_TC2: Record<number, string> = { 100: 'No reason given', 101: 'Congestion at maritime switching centre', 102: 'Busy', 103: 'Queue indication', 104: 'Station barred', 105: 'No operator available', 106: 'Operator temporarily unavailable', 107: 'Equipment disabled', 108: 'Unable to use proposed channel', 109: 'Unable to use proposed mode', 110: 'Ships and aircraft of States not parties to an armed conflict', 111: 'Medical transports', 112: 'Pay-phone/public call office', 113: 'Facsimile/data (M.1081)', 126: 'No information' };
export const DSC_EOS: Record<number, string> = { 117: 'acknowledgement requested', 122: 'acknowledgement', 127: '' };

export interface DscPos { lat: number; lon: number }
export interface DscCall {
  format: number; formatName: string;
  /** Address: an MMSI, or a geographic area as its ten digits. */
  to?: string; area?: string;
  category?: number; categoryName?: string;
  from: string;
  tc1?: number; tc2?: number;
  /** A distress alert's, or the one a relay / acknowledgement is about. */
  distressId?: string; nature?: number; natureName?: string; pos?: DscPos | null; utc?: string | null; comm?: number;
  channel?: string; freqHz?: number;
  eos: number; eccOk: boolean;
}

const two = (s: number) => s.toString().padStart(2, '0');
/** Five characters → the nine-digit MMSI (the tenth digit is 0). */
export function dscMmsi(c: number[]): string { return c.map(two).join('').slice(0, 9); }
/** Ten digits as Pos1: quadrant (0 NE, 1 NW, 2 SE, 3 SW), latitude dd mm, longitude ddd mm; 99… = none. */
export function dscPos(c: number[]): DscPos | null {
  const d = c.map(two).join('');
  if (d === '9999999999' || !/^[0-3]\d{9}$/.test(d)) return null;
  const q = Number(d[0]), lat = Number(d.slice(1, 3)) + Number(d.slice(3, 5)) / 60, lon = Number(d.slice(5, 8)) + Number(d.slice(8, 10)) / 60;
  if (lat > 90 || lon > 180) return null;
  return { lat: q >= 2 ? -lat : lat, lon: q === 1 || q === 3 ? -lon : lon };
}
function dscTime(c: number[]): string | null { const h = c[0], m = c[1]; return h === 88 && m === 88 ? null : h < 24 && m < 60 ? `${two(h)}:${two(m)}` : null; }
/** Table A1-5: three characters (sent char 3, 2, 1) as a VHF channel or a frequency. */
function dscChannel(c: number[]): { channel?: string; freqHz?: number } {
  const d = c.map(two).join('');   // HM TM M H T U
  if (d[0] === '9') { const ch = Number(d.slice(3)), m = d[2]; return { channel: `${ch}${m === '1' ? ' (ship simplex)' : m === '2' ? ' (coast simplex)' : ''}` }; }
  if (d[0] <= '2') return { freqHz: Number(d) * 100 };
  return {};
}

/** Read a call from its information characters (format specifier twice … EOS, ECC). null if it does not parse. */
export function parseDsc(info: number[]): DscCall | null {
  const n = info.length;
  const eosAt = info.findIndex((s, i) => i >= 2 && (s === 117 || s === 122 || s === 127));
  if (eosAt < 0 || eosAt + 1 >= n || info[0] !== info[1] || !DSC_FORMAT[info[0]]) return null;
  let ecc = info[0]; for (let i = 2; i <= eosAt; i++) ecc ^= info[i];
  const eccOk = (ecc & 127) === info[eosAt + 1];
  const f = info[0], body = info.slice(2, eosAt), call: DscCall = { format: f, formatName: DSC_FORMAT[f], from: '', eos: info[eosAt], eccOk };
  let p = 0;
  const take = (k: number) => { const v = body.slice(p, p + k); p += k; return v.length === k && v.every(x => x >= 0) ? v : null; };
  const distressInfo = (): boolean => {
    const nat = take(1), pos = take(5), t = take(2), comm = take(1);
    if (!nat || !pos || !t || !comm) return false;
    call.nature = nat[0]; call.natureName = DSC_NATURE[nat[0]] ?? `nature ${nat[0]}`; call.pos = dscPos(pos); call.utc = dscTime(t); call.comm = comm[0];
    return true;
  };
  if (f === 112) {
    const self = take(5); if (!self) return null; call.from = dscMmsi(self);
    call.distressId = call.from;
    return distressInfo() ? call : null;
  }
  if (f !== 116) {
    const a = take(5); if (!a) return null;
    if (f === 102) call.area = a.map(two).join(''); else call.to = dscMmsi(a);
  }
  const cat = take(1), self = take(5); if (!cat || !self) return null;
  call.category = cat[0]; call.categoryName = DSC_CATEGORY[cat[0]] ?? `category ${cat[0]}`; call.from = dscMmsi(self);
  if (cat[0] === 112) {
    // distress relay / acknowledgement: telecommand, the station in distress, then its alert's information
    const tc = take(1), id = take(5); if (!tc || !id) return null;
    call.tc1 = tc[0]; call.distressId = id.every(x => x === 126) ? undefined : dscMmsi(id);
    return distressInfo() ? call : null;
  }
  const tc = take(2); if (!tc) return null;
  [call.tc1, call.tc2] = tc;
  const rest = body.slice(p);
  if (rest.length >= 6 && rest[0] === 55) call.pos = dscPos(rest.slice(1, 6));
  else if (call.tc1 === 121 && rest.length >= 5 && rest[0] !== 126) { call.pos = dscPos(rest.slice(0, 5)); if (rest.length >= 8) call.utc = dscTime(rest.slice(6, 8)); }
  else if (rest.length >= 3 && rest[0] !== 126) Object.assign(call, dscChannel(rest.slice(0, 3)));
  return call;
}

/** Transmitter side (tests): a call's symbols as sent — dot pattern bits are added by dscCallBits. */
export function dscCallSymbols(info: number[]): number[] {
  // DX/RX interleave: DX slot j carries phasing 125 (j < 6) then info[j-6]; RX slot j carries 111-j (j < 8), then
  // info[j-8]; the last info characters' RX copies run on past the last DX
  const out: number[] = [], nDx = 6 + info.length, nSlots = nDx + 2;
  for (let j = 0; j < nSlots; j++) {
    out.push(j < 6 ? 125 : j - 6 < info.length ? info[j - 6] : info[info.length - 2]);   // after the ECC, DX repeats the EOS
    out.push(j < 8 ? 111 - j : info[j - 8]);
  }
  return out;
}
/** The full bit stream: 20 bits of dot pattern (VHF, §3.4.2), then the characters. */
export function dscCallBits(info: number[]): number[] {
  const bits: number[] = []; for (let i = 0; i < 20; i++) bits.push(i & 1);
  for (const s of dscCallSymbols(info)) bits.push(...dscBits(s));
  return bits;
}
/** The information characters of a call: format specifier twice, the body, EOS, ECC. */
export function dscInfo(format: number, body: number[], eos: number): number[] {
  let ecc = format; for (const s of body) ecc ^= s; ecc ^= eos;
  return [format, format, ...body, eos, ecc & 127];
}
/** An MMSI (nine digits) as five characters. */
export function mmsiChars(mmsi: string): number[] { const d = (mmsi + '0').padStart(10, '0'); return [0, 2, 4, 6, 8].map(i => Number(d.slice(i, i + 2))); }

const MAX_INFO = 40;

/** Bits → calls: phasing found from the DX/RX characters, then DX and RX copies combined. */
export class DscFramer {
  onCall: (c: DscCall) => void = () => undefined;
  private hist: number[] = [];   // the last 40 bits, for phasing
  private stream: number[] | null = null; private cur: number[] = []; private slot0 = 0;
  push(bit: number): void {
    if (this.stream) {
      this.cur.push(bit);
      if (this.cur.length === 10) { this.stream.push(dscSymbol(this.cur)); this.cur = []; this.collect(); }
      return;
    }
    this.hist.push(bit); if (this.hist.length > 40) this.hist.shift();
    if (this.hist.length < 40) return;
    // the last four characters as DX, RX, DX, RX of the phasing: 125, r, 125, r-1 (at least three of four right)
    const c = [0, 10, 20, 30].map(o => dscSymbol(this.hist, o));
    for (let r = 111; r >= 105; r--) {
      const ok = (c[0] === 125 ? 1 : 0) + (c[1] === r ? 1 : 0) + (c[2] === 125 ? 1 : 0) + (c[3] === r - 1 ? 1 : 0);
      if (ok < 3 || (c[1] !== r && c[3] !== r - 1)) continue;   // at least one RX: it says where in the phasing we are
      // RX slot (111 - r + 1) has just ended: the stream so far covers slots 0 … (112 - r) of DX and RX
      const rxSlot = 112 - r;
      this.stream = []; this.cur = []; this.slot0 = rxSlot + 1; this.hist = [];
      return;
    }
  }
  /** Stream characters are DX, RX alternately from DX slot slot0. */
  private collect(): void {
    const s = this.stream!, slots = s.length >> 1;
    const dx = (j: number) => { const k = 2 * (j - this.slot0); return k >= 0 && k < s.length ? s[k] : -1; };
    const rx = (j: number) => { const k = 2 * (j - this.slot0) + 1; return k >= 0 && k < s.length ? s[k] : -1; };
    const info: number[] = [];
    for (let i = 0; 6 + i < this.slot0 + slots; i++) {
      const a = dx(6 + i), b = 8 + i < this.slot0 + slots ? rx(8 + i) : -1;
      info.push(a >= 0 ? a : b);
    }
    // a call ends at its EOS and ECC; wait for the ECC's RX copy if its DX was damaged
    const eosAt = info.findIndex((v, i) => i >= 2 && (v === 117 || v === 122 || v === 127));
    if (eosAt >= 0 && info.length > eosAt + 1) {
      const eccRx = rx(8 + eosAt + 1), eccDx = dx(6 + eosAt + 1);
      if (eccDx >= 0 || eccRx >= 0 || this.slot0 + slots > 8 + eosAt + 2) {
        const full = info.slice(0, eosAt + 2);
        // characters that only the RX copy saved, and any a later RX copy can still fix
        for (let i = 0; i < full.length; i++) if (full[i] < 0) { const v = rx(8 + i); if (v >= 0) full[i] = v; }
        this.stream = null;
        if (full.every(v => v >= 0)) { const c = parseDsc(full); if (c && c.eccOk) this.onCall(c); }
        return;
      }
    }
    if (info.length > MAX_INFO) this.stream = null;
  }
}

/** The DSC app's processor: the NFM discriminator → AFSK 1300/2100 → bits → calls. */
export class DscDecoder implements IqProcessor {
  readonly wantsFm = true;
  private rate = 0; private spb = 40;
  private ring = new Float32Array(40); private ri = 0;
  private ph1 = 0; private ph2 = 0; private w1 = 0; private w2 = 0;
  private c1 = 0; private s1 = 0; private c2 = 0; private s2 = 0; private since = 0;
  private sync = new BitSync(DSC_BAUD, 48000, 0.2);
  private filt = new DiscFilter(3000, 48000);
  readonly framer = new DscFramer();
  calls = 0;
  constructor(private readonly emit: Emit) {
    this.framer.onCall = c => { this.calls++; this.emit({ type: 'packet', line: dscLine(c) }); this.emit({ type: 'dsc', call: c }); };
  }
  reset(rate: number): void { if (rate > 0) this.configure(rate); else this.rate = 0; }
  onIq(): void {}
  private configure(rate: number): void {
    this.rate = rate; this.spb = Math.max(4, Math.round(rate / DSC_BAUD));
    this.ring = new Float32Array(this.spb); this.ri = 0;
    this.w1 = 2 * Math.PI * DSC_Y_HZ / rate; this.w2 = 2 * Math.PI * DSC_B_HZ / rate;
    this.ph1 = this.ph2 = this.c1 = this.s1 = this.c2 = this.s2 = 0; this.since = 0;
    this.sync = new BitSync(DSC_BAUD, rate, 0.2);
    this.filt = new DiscFilter(3000, rate);
  }
  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.rate) this.configure(rate);
    const tp = 2 * Math.PI, spb = this.spb;
    for (let i = 0; i < n; i++) {
      const x = this.filt.push(samples[i]), old = this.ring[this.ri];
      this.ring[this.ri] = x; this.ri = this.ri + 1 >= spb ? 0 : this.ri + 1;
      let o1 = this.ph1 - this.w1 * spb; while (o1 < 0) o1 += tp;
      let o2 = this.ph2 - this.w2 * spb; while (o2 < 0) o2 += tp;
      this.c1 += x * Math.cos(this.ph1) - old * Math.cos(o1); this.s1 += x * Math.sin(this.ph1) - old * Math.sin(o1);
      this.c2 += x * Math.cos(this.ph2) - old * Math.cos(o2); this.s2 += x * Math.sin(this.ph2) - old * Math.sin(o2);
      this.ph1 += this.w1; if (this.ph1 >= tp) this.ph1 -= tp;
      this.ph2 += this.w2; if (this.ph2 >= tp) this.ph2 -= tp;
      if (++this.since >= 4096) { this.since = 0; this.recompute(); }
      // Y (1300 Hz) is a 1
      const b = this.sync.push((this.c1 * this.c1 + this.s1 * this.s1) - (this.c2 * this.c2 + this.s2 * this.s2));
      if (b >= 0) this.framer.push(b);
    }
  }
  private recompute(): void {
    const tp = 2 * Math.PI, spb = this.spb;
    this.c1 = this.s1 = this.c2 = this.s2 = 0;
    for (let j = 0; j < spb; j++) {
      const v = this.ring[(this.ri + j) % spb];
      let a1 = this.ph1 - this.w1 * (spb - j); while (a1 < 0) a1 += tp;
      let a2 = this.ph2 - this.w2 * (spb - j); while (a2 < 0) a2 += tp;
      this.c1 += v * Math.cos(a1); this.s1 += v * Math.sin(a1); this.c2 += v * Math.cos(a2); this.s2 += v * Math.sin(a2);
    }
  }
}

const fmtPos = (p: DscPos) => {
  const f = (v: number, pos: string, neg: string, w: number) => { const a = Math.abs(v), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 60); return `${String(d).padStart(w, '0')}°${String(m).padStart(2, '0')}'${v < 0 ? neg : pos}`; };
  return `${f(p.lat, 'N', 'S', 2)} ${f(p.lon, 'E', 'W', 3)}`;
};
/** The message-log line for a call. */
export function dscLine(c: DscCall): string {
  const bits: string[] = [];
  const kind = c.format === 112 ? 'DISTRESS ALERT'
    : c.category === 112 ? (c.tc1 === 110 ? (c.distressId === c.from ? 'DISTRESS SELF-CANCEL' : 'DISTRESS ACKNOWLEDGEMENT') : 'DISTRESS RELAY')
    : `${(c.categoryName ?? '').toUpperCase()} ${c.formatName.toUpperCase()}`;
  bits.push(`from ${c.from}`);
  if (c.to) bits.push(`to ${c.to}`); else if (c.area) bits.push(`to area ${c.area}`);
  if (c.distressId && c.distressId !== c.from) bits.push(`about ${c.distressId}`);
  if (c.natureName) bits.push(c.natureName);
  if (c.pos) bits.push(fmtPos(c.pos)); else if (c.pos === null) bits.push('no position');
  if (c.utc) bits.push(`at ${c.utc} UTC`);
  if (c.tc1 !== undefined && c.category !== 112) bits.push(DSC_TC1[c.tc1] ?? `telecommand ${c.tc1}`);
  if (c.tc2 !== undefined && c.tc2 !== 126) bits.push(DSC_TC2[c.tc2] ?? `telecommand ${c.tc2}`);
  if (c.channel) bits.push(`channel ${c.channel}`); else if (c.freqHz) bits.push(`${(c.freqHz / 1e3).toFixed(1)} kHz`);
  if (DSC_EOS[c.eos]) bits.push(DSC_EOS[c.eos]);
  return `DSC ${kind} · ${bits.join(' · ')}`;
}
