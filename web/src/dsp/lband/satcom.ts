/**
 * The Satcom app's processor: one L-band carrier, either the Inmarsat-C NCS (EGC broadcasts) or an Aero P-channel
 * (ACARS to aircraft), through the BPSK receiver into its decoder. A snapshot goes to the screen once a second and
 * whenever a message comes in; Aero's ACARS lines go out as packet lines for Flight Msgs.
 *
 * Twins: core/sat/Satcom.kt and core/sat/Satcom.swift.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { PskReceiver } from './psk.js';
import { StdcDecoder, STDC_SYMBOL_RATE, type EgcMessage, type StdcStats } from './stdc.js';
import { AeroDecoder, aesHex, type AeroStats } from './aero.js';
import { Aero105 } from '../aero105/aero105.js';   // FORK: Aero 10.5 kbps (OQPSK, after JAERO)
import { AeroMskBursts } from '../aero105/mskburst.js';   // FORK: Aero 600/1200 R/T bursts (MSK, after JAERO)

export type SatcomMode = 'egc' | 'aero600' | 'aero1200' | 'aero10500';   // FORK: + aero10500

export interface SatcomSnap {
  mode: SatcomMode; hz: number; carrierHz: number; lock: number; lineDb: number;
  egc: StdcStats; aero: AeroStats | null; messages: EgcMessage[];
}

export class SatcomProcessor implements IqProcessor {
  centerHz = 0;
  channelHz = 0;
  private modeNow: SatcomMode = 'egc';
  private psk = new PskReceiver(STDC_SYMBOL_RATE, x => this.stdc.push(x));
  private readonly stdc = new StdcDecoder();
  private aero: AeroDecoder | null = null;
  private a105: Aero105 | null = null;   // FORK: Aero 10.5 kbps
  private msk: AeroMskBursts | null = null;   // FORK: Aero 600/1200 R/T bursts
  private lastSnap = 0; private dirty = false; private wasLocked = false;

  constructor(private readonly emit: Emit) {
    this.stdc.onMessage = m => { this.dirty = true; if (m.parts === 1) this.emit({ type: 'log', line: `EGC: ${m.priorityName} · ${m.serviceName}${m.area ? ` · ${m.area}` : ''}` }); };
  }

  get mode(): SatcomMode { return this.modeNow; }
  set mode(m: SatcomMode) {
    if (m === this.modeNow) return;
    this.modeNow = m;
    this.a105 = null; this.msk = null;   // FORK: Aero 10.5 kbps, 600/1200 bursts
    if (m === 'egc') { this.aero = null; this.psk = new PskReceiver(STDC_SYMBOL_RATE, x => this.stdc.push(x)); }
    // FORK: Aero 10.5 kbps: its own OQPSK receiver and decoder, in place of the BPSK pair
    else if (m === 'aero10500') {
      const a = new Aero105();
      a.onAcars = (line, aes) => { this.emit({ type: 'packet', line }); this.emit({ type: 'log', line: `Aero 10.5k: ACARS to AES ${aesHex(aes)}` }); this.dirty = true; };
      this.aero = null; this.a105 = a;
    }
    // FORK: end
    else {
      const a = new AeroDecoder(m === 'aero600' ? 600 : 1200);
      a.onAcars = (line, aes) => { this.emit({ type: 'packet', line }); this.emit({ type: 'log', line: `Aero: ACARS to AES ${aesHex(aes)}` }); this.dirty = true; };
      this.aero = a;
      this.psk = new PskReceiver(a.rate, x => a.push(x));
      // FORK: the R/T bursts aircraft send at the same rate, listened for on the same channel
      const b = new AeroMskBursts(a.rate);
      b.onAcars = (line, aes) => { this.emit({ type: 'packet', line }); this.emit({ type: 'log', line: `Aero ${a.rate} burst: ACARS from AES ${aesHex(aes)}` }); this.dirty = true; };
      this.msk = b;
    }
    this.stdc.reset();
  }

  clear(): void { this.stdc.clear(); this.dirty = true; }
  reset(_rate: number): void { this.psk.reset(); this.stdc.reset(); this.aero?.reset(); this.a105?.reset(); this.msk?.reset(); }   // FORK: + a105, msk

  onIq(iq: Int8Array, rate: number): void {
    if (this.aero) this.aero.hz = this.channelHz;
    // FORK: Aero 10.5 kbps runs its own receiver (rx: what the lock / carrier readings come from)
    if (this.a105) { this.a105.hz = this.channelHz; this.a105.onIq(iq, rate, this.channelHz - this.centerHz); }
    else this.psk.onIq(iq, rate, this.channelHz - this.centerHz);
    if (this.msk) { this.msk.hz = this.channelHz; this.msk.onIq(iq, rate, this.channelHz - this.centerHz); }
    const rx = this.a105 ?? this.psk;
    const locked = rx.lock > 0.5;
    if (locked !== this.wasLocked) { this.wasLocked = locked; this.emit({ type: 'log', line: locked ? `Satcom: locked to the carrier ${fmtHz(rx.carrierHz)} from ${(this.channelHz / 1e6).toFixed(3)} MHz` : 'Satcom: carrier lost' }); }
    // FORK: end
    const now = Date.now();
    if (this.dirty || now - this.lastSnap > 1000) { this.dirty = false; this.lastSnap = now; this.emit({ type: 'satcom', snap: this.snap() }); }
  }

  snap(): SatcomSnap {
    const p = this.a105 ?? this.psk;   // FORK: + a105
    return { mode: this.modeNow, hz: this.channelHz, carrierHz: Number.isFinite(p.carrierHz) ? p.carrierHz : NaN, lock: p.lock, lineDb: p.lineDb,
      egc: { ...this.stdc.stats }, aero: this.aero ? { ...this.aero.stats, ...(this.msk ? { bursts: this.msk.bursts } : {}) } : this.a105 ? { ...this.a105.stats } : null, messages: this.stdc.messages() };   // FORK: + a105 stats, msk bursts
  }
}

const fmtHz = (hz: number) => (Number.isFinite(hz) ? `${hz >= 0 ? '+' : '−'}${Math.abs(hz / 1000).toFixed(2)} kHz` : '');
