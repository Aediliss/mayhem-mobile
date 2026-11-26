/**
 * FORK: control-channel protocols as plug-ins to Dispatch (fleet.ts), so EDACS, MPT1327 and LTR live in files of their
 * own. A plug-in gives each Dispatch channel a receiver; the receiver reports generic events; fleet.ts turns them into
 * the same systems, sites, calls, units and log rows as its built-in protocols, and follows analog voice on the
 * channels a call is granted. Receive only. No DOM.
 *
 * These protocols do not say what frequency a logical channel number (LCN) is: that comes from a plan the person
 * enters (a site's frequencies in LCN order). A plan is only used for a site once the site's control channel is found
 * where the plan puts the control channel's own LCN, the way Type II's channel plans are proved (smartnet.ts).
 */

/** A call a control channel granted (or keeps announcing). */
export interface PlugCall {
  tg: number; group: boolean; src: number; lcn: number;
  emergency: boolean;
  /** Digital voice (EDACS ProVoice …): identified, never voiced. */
  digital: boolean;
  encrypted: boolean;
  /** A repeat of a call already on the air (channel update) rather than a new grant. */
  update: boolean;
}

export type PlugEvent =
  /** The system / site this control channel belongs to: `id` is unique within the protocol; `ccLcn` its own LCN, if said. */
  | { kind: 'system'; id: string; label: string; ccLcn?: number }
  | { kind: 'call'; call: PlugCall; text: string }
  /** A channel was dropped or unkeyed. */
  | { kind: 'end'; lcn: number; text: string }
  /** A unit was heard (login, status, data …). */
  | { kind: 'unit'; unit: number; group?: number; text: string }
  /** Anything else worth a log row. */
  | { kind: 'note'; name: string; text: string };

export interface PlugRx {
  push(zi: Float32Array, zq: Float32Array, m: number): void;
  /** Frames (or words) that passed their checks, and frames found at all. */
  good: number; seen: number;
  onEvents: (ev: PlugEvent[], hex: string) => void;
}

export interface TrunkPlugin {
  /** Protocol name: the call / system protocol, the carrier's class, and the prefix of its system keys. */
  proto: 'EDACS' | 'MPT1327' | 'LTR';
  /** How the UI titles a system. */
  title: string;
  /** Its own down-converter (cut-off, output rate) when the channel's 24 kS/s / 5.5 kHz baseband is too narrow. */
  ddc?: { cutoffHz: number; rate: number };
  rx(fs: number): PlugRx;
  /** Good frames before a carrier is called this protocol's control channel. */
  minGood: number;
}

export const PLUGINS: TrunkPlugin[] = [];
export function registerPlugin(p: TrunkPlugin): void { if (!PLUGINS.some(x => x.proto === p.proto)) PLUGINS.push(p); }
export const plugOf = (proto: string | undefined): TrunkPlugin | undefined => PLUGINS.find(p => p.proto === proto);
/** The plug-in whose systems' keys start with its name. */
export const plugOfKey = (sys: string): TrunkPlugin | undefined => PLUGINS.find(p => sys.startsWith(p.proto + ' '));

// ---- LCN plans ----

/**
 * A site's channels as the person entered them: frequencies in LCN order (LCN 1 first), or a linear plan where channel n
 * is `base + n × step` (MPT1327 band plans number channels this way).
 */
export interface LcnPlan { proto: string; label: string; hz: number[]; base?: number; step?: number }
let plans: LcnPlan[] = [];
export function setPlans(p: LcnPlan[]): void { plans = Array.isArray(p) ? p.filter(x => x && Array.isArray(x.hz) && (x.hz.length || (x.base && x.step))) : []; }
export function getPlans(): LcnPlan[] { return plans; }

/**
 * The plan for a control channel heard at `ccHz` that says it is LCN `ccLcn`: the plan with that frequency at that LCN
 * (within 3 kHz). Without an announced LCN, a plan that has the frequency at all.
 */
export function provePlanFor(proto: string, ccHz: number, ccLcn?: number): LcnPlan | null {
  const near = (a: number) => Math.abs(a - ccHz) <= 3_000;
  const onGrid = (p: LcnPlan) => { const n = Math.round((ccHz - p.base!) / p.step!); return n >= 0 && n < 1024 && near(p.base! + n * p.step!); };
  return plans.find(p => p.proto === proto && (p.step ? (ccLcn !== undefined && ccLcn >= 0 ? near(p.base! + ccLcn * p.step) : onGrid(p))
    : ccLcn !== undefined && ccLcn >= 1 ? near(p.hz[ccLcn - 1] ?? -1e12) : p.hz.some(near))) ?? null;
}
export const lcnHz = (plan: LcnPlan | null, lcn: number) => (!plan ? 0 : plan.step ? (lcn >= 0 ? plan.base! + lcn * plan.step : 0) : lcn >= 1 ? plan.hz[lcn - 1] ?? 0 : 0);

/**
 * Plans from text, one site per line: `EDACS Site 21: 851.0125 851.5125 852.0125 …` (protocol, a label up to the colon,
 * then frequencies in MHz in LCN order). Lines that do not parse are reported, not guessed at.
 */
export function parsePlans(text: string): { plans: LcnPlan[]; errors: string[] } {
  const out: LcnPlan[] = [], errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = /^(EDACS|MPT1327|LTR)\b\s*([^:]*):\s*(.+)$/i.exec(line);
    if (!m) { errors.push(`line ${i + 1}: expected "EDACS <label>: <MHz> <MHz> …"`); continue; }
    const lin = /^ch0\s*=\s*([\d.]+)\s+step\s*=\s*([\d.]+)\s*$/i.exec(m[3].trim());
    if (lin) {
      const base = Math.round(Number(lin[1]) * 1e6), step = Math.round(Number(lin[2]) * 1e3);
      if (!(base >= 25e6 && base <= 3e9 && step >= 1_000 && step <= 100_000)) { errors.push(`line ${i + 1}: ch0 in MHz, step in kHz`); continue; }
      out.push({ proto: m[1].toUpperCase(), label: m[2].trim() || `${m[1].toUpperCase()} site`, hz: [], base, step }); continue;
    }
    const hz = m[3].split(/[\s,;]+/).filter(Boolean).map(f => Math.round(Number(f) * 1e6));
    if (!hz.length || hz.some(f => !Number.isFinite(f) || f < 25e6 || f > 3e9)) { errors.push(`line ${i + 1}: frequencies must be in MHz`); continue; }
    out.push({ proto: m[1].toUpperCase(), label: m[2].trim() || `${m[1].toUpperCase()} site`, hz });
  }
  return { plans: out, errors };
}
