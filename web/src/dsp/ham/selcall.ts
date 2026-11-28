/**
 * FORK: HF DSC and CCIR 493-4 selective calling (the selcall of HF network radios such as CODAN's and Barrett's) on the
 * HAM receiver's USB audio, receive only. Written from ITU-R M.493 (HF: F1B at 100 baud, ±85 Hz about 1700 Hz on the
 * audio, the higher tone B = 0, the lower Y = 1; the same 10-bit characters, DX / RX time diversity, phasing and ECC as
 * VHF, so dsc.ts's framer and parser do the rest). A call whose ECC checks prints as DSC when it carries MMSIs; a short
 * individual call (format 120 / 123 with a 4- or 6-digit address: two or three characters) prints as a selcall with its
 * address, category and self-ID. CODAN's own extensions (its call types beyond these formats) are not published and
 * are shown as their characters.
 */
import { BitSync } from '../core.js';
import { DSC_CATEGORY, DSC_FORMAT, DscFramer, dscLine, parseDsc } from '../dsc.js';
import { ftxShared } from './ft8.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000, BAUD = 100, Y_HZ = 1615, B_HZ = 1785;

class Tone {
  private readonly re: Float64Array; private readonly im: Float64Array; private i = 0; private sr = 0; private si = 0; private ph = 0;
  constructor(private readonly w: number, private readonly len: number) { this.re = new Float64Array(len); this.im = new Float64Array(len); }
  push(x: number): number {
    const r = x * Math.cos(this.ph), q = -x * Math.sin(this.ph); this.ph = (this.ph + this.w) % (2 * Math.PI);
    this.sr += r - this.re[this.i]; this.si += q - this.im[this.i]; this.re[this.i] = r; this.im[this.i] = q; this.i = (this.i + 1) % this.len;
    return this.sr * this.sr + this.si * this.si;
  }
}

const two = (n: number) => n.toString().padStart(2, '0');
/** A short individual call → its selcall line, or null when the characters are not one. */
export function selcallLine(info: number[]): string | null {
  const f = info[0], eosAt = info.findIndex((v, i) => i >= 2 && (v === 117 || v === 122 || v === 127));
  if (eosAt < 0 || (f !== 120 && f !== 123)) return null;
  const body = info.slice(2, eosAt), cat = body.findIndex(v => v in DSC_CATEGORY);
  if (cat !== 2 && cat !== 3) return null;
  const to = body.slice(0, cat), from = body.slice(cat + 1, cat + 1 + cat), rest = body.slice(cat + 1 + cat);
  if (to.some(v => v > 99) || from.length < cat || from.some(v => v > 99)) return null;
  return `SELCALL to ${to.map(two).join('')} from ${from.map(two).join('')} · ${DSC_CATEGORY[body[cat]]} · ${DSC_FORMAT[f]}${rest.length ? ` · ${rest.join(' ')}` : ''}${info[eosAt] === 117 ? ' · ack requested' : ''}`;
}

export class SelcallDecoder implements DigitalDecoder {
  readonly name = 'SELCALL';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private y = new Tone(2 * Math.PI * Y_HZ / FS, FS / BAUD); private b = new Tone(2 * Math.PI * B_HZ / FS, FS / BAUD);
  private sync = new BitSync(BAUD, FS, 0.2); private framer = new DscFramer();
  constructor() { this.reset(); }
  reset(): void {
    this.rs.reset(); this.y = new Tone(2 * Math.PI * Y_HZ / FS, FS / BAUD); this.b = new Tone(2 * Math.PI * B_HZ / FS, FS / BAUD);
    this.sync = new BitSync(BAUD, FS, 0.2); this.framer = new DscFramer();
    this.framer.onInfo = info => {
      let ecc = info[0]; for (let i = 2; i < info.length - 1; i++) ecc ^= info[i];
      if ((ecc & 127) !== info[info.length - 1]) return;
      const sel = selcallLine(info), c = sel ? null : parseDsc(info);
      const line = sel ?? (c ? dscLine(c) : null);
      if (line) { this.confidence = 1; this.onText(line + '\n', 'HF DSC / selcall 100 Bd'); }
    };
  }
  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { const bit = this.sync.push(this.y.push(v) - this.b.push(v)); if (bit >= 0) this.framer.push(bit); });   // Y (lower) is a 1
    this.confidence = Math.max(0, this.confidence - n / 48_000 / 30);
  }
}
