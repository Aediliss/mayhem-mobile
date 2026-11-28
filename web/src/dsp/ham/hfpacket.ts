/**
 * FORK: HF packet (AX.25 at 300 baud, AFSK with a 200 Hz shift) on the HAM receiver's USB audio, receive only. As Dire
 * Wolf (GPL-2.0-or-later, not ported) and the KAM / PK-232 HF modes define the signal: mark 1600 Hz, space 1800 Hz on the
 * audio (the HF APRS and packet convention: tune USB so the pair sits there), NRZI, HDLC flags and bit stuffing, the
 * AX.25 FCS; the frames are the same as on VHF. Written here: audio at 8 kHz; for each of five tunings (−60 to +60 Hz,
 * since an HF dial is rarely exact) a one-bit sliding DFT at the mark and the space, their magnitude difference into a
 * bit clock and an HDLC deframer (core.ts's, shared with APRS); good frames (FCS) are de-duplicated and printed as TNC2
 * text, and handed on as AX.25 frames for the export bus (TNC2 / KISS).
 */
import { BitSync, HdlcFramer } from '../core.js';
import { ftxShared } from './ft8.js';
import { ax25ToTnc2 } from '../../export/formats.js';
import type { DigitalDecoder } from './digital.js';

const FS = 8000, BAUD = 300, SHIFT = 200, TUNINGS = [-60, -30, 0, 30, 60];

/** A sliding one-bit DFT at one frequency. */
class Tone {
  private readonly re: Float64Array; private readonly im: Float64Array; private i = 0;
  private sr = 0; private si = 0; private ph = 0; private n = 0;
  constructor(private readonly w: number, private readonly len: number) { this.re = new Float64Array(len); this.im = new Float64Array(len); }
  push(x: number): number {
    const r = x * Math.cos(this.ph), q = -x * Math.sin(this.ph);
    this.ph += this.w; if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
    this.sr += r - this.re[this.i]; this.si += q - this.im[this.i]; this.re[this.i] = r; this.im[this.i] = q;
    this.i = (this.i + 1) % this.len;
    if (++this.n >= 8192) { this.n = 0; this.sr = 0; this.si = 0; for (let k = 0; k < this.len; k++) { this.sr += this.re[k]; this.si += this.im[k]; } }
    return Math.hypot(this.sr, this.si);
  }
}

class Slicer {
  readonly mark: Tone; readonly space: Tone; readonly sync = new BitSync(BAUD, FS, 0.15); readonly framer: HdlcFramer;
  constructor(centre: number, onFrame: (f: Uint8Array) => void) {
    const len = Math.round(FS / BAUD);
    this.mark = new Tone(2 * Math.PI * (centre - SHIFT / 2) / FS, len); this.space = new Tone(2 * Math.PI * (centre + SHIFT / 2) / FS, len);
    this.framer = new HdlcFramer(400, onFrame);
  }
  push(x: number): void { const b = this.sync.push(this.mark.push(x) - this.space.push(x)); if (b >= 0) this.framer.pushRaw(b); }
}

export class HfPacketDecoder implements DigitalDecoder {
  readonly name = 'PACKET';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  /** Each good frame without its FCS (for the export bus). */
  onFrame: (bytes: number[]) => void = () => {};
  private readonly rs = new ftxShared.SincResampler(48_000, FS, 32);
  private slicers: Slicer[] = []; private clock = 0; private recent: { fcs: number; at: number }[] = [];
  /** [centre]: halfway between mark and space (1700 Hz: mark 1600, space 1800). */
  constructor(public center = 1700) { this.setup(); }
  setCenter(hz: number): void { if (hz !== this.center) { this.center = hz; this.setup(); } }
  reset(): void { this.rs.reset(); this.setup(); }
  private setup(): void { this.slicers = TUNINGS.map(o => new Slicer(this.center + o, f => this.frame(f))); this.recent = []; }

  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.clock++; for (const s of this.slicers) s.push(v); });
    this.confidence = Math.max(0, this.confidence - n / 48_000 / 30);   // a good frame lifts it; it fades over 30 s
  }

  private frame(f: Uint8Array): void {
    if (f.length < 17 || !HdlcFramer.fcsOk(f)) return;
    const fcs = (f[f.length - 2] << 8) | f[f.length - 1];
    this.recent = this.recent.filter(r => this.clock - r.at < 2 * FS);
    if (this.recent.some(r => r.fcs === fcs)) return;
    this.recent.push({ fcs, at: this.clock });
    const body = f.subarray(0, f.length - 2);
    this.confidence = 1;
    this.onFrame(Array.from(body));
    this.onText(`${ax25Line(body)}\n`, `PACKET 300 Bd ${this.center} Hz`);
  }
}

/** TNC2 text for a UI frame; for other frames the addresses and the control field (connected-mode traffic). */
export function ax25Line(f: Uint8Array): string {
  const t = ax25ToTnc2(f);
  if (t) return t;
  const call = (o: number) => { let s = ''; for (let i = 0; i < 6; i++) s += String.fromCharCode(f[o + i] >> 1); const ssid = (f[o + 6] >> 1) & 15; return s.trim() + (ssid ? `-${ssid}` : ''); };
  if (f.length < 15) return '(short frame)';
  let o = 0; while (o + 7 <= f.length && !(f[o + 6] & 1)) o += 7;
  const ctl = f[o + 7], kind = (ctl & 1) === 0 ? `I${(ctl >> 1) & 7}` : (ctl & 3) === 1 ? ['RR', 'RNR', 'REJ', 'SREJ'][(ctl >> 2) & 3] : ({ 0x2f: 'SABM', 0x6f: 'SABME', 0x43: 'DISC', 0x0f: 'DM', 0x63: 'UA', 0x87: 'FRMR', 0x03: 'UI' } as Record<number, string>)[ctl & 0xef] ?? `U${ctl.toString(16)}`;
  let info = ''; if ((ctl & 1) === 0) for (let i = o + 9; i < f.length; i++) { const c = f[i]; info += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 13 ? ' ' : '.'; }
  return `${call(7)}>${call(0)} [${kind}]${info ? ': ' + info : ''}`;
}
