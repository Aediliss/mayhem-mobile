/**
 * FORK: DMR Tier III vendor control blocks, receive only: Motorola Connect Plus (feature set 0x06) and Hytera (0x68,
 * Hytera's Tier III and XPT). Field layouts after SDRTrunk by Dennis Sheirer (GPL-3.0-or-later,
 * module/decode/dmr/message/data/csbk/motorola/ConnectPlus*, .../hytera/Hytera*); neither vendor publishes them. The
 * blocks come out as the same kinds the ETSI ones do (grant, unit, aloha), so Dispatch's existing logic lists their calls
 * and learns which carrier each logical channel is from the voice headers that follow a grant.
 *
 * Bit offsets below count from the first payload bit after the opcode and feature set octets (SDRTrunk's index - 16).
 */
import { hex } from './codes.js';
import { h, type Field } from './tsbk.js';
import { sysCode, type Csbk } from './csbk.js';
import { rs129Ok } from './lc.js';

/**
 * Connect Plus logical slot number → repeater (LCN) and time slot (0/1). SDRTrunk takes the LSN as the field less one
 * (found on air; its note says to leave it so), then LCN = (LSN - 1) / 2 + 1 and slot = (LSN - 1) mod 2.
 */
export function conPlusLsn(raw: number): { lcn: number; slot: number } | null {
  const lsn = raw - 1;
  return lsn >= 1 ? { lcn: Math.floor((lsn - 1) / 2) + 1, slot: (lsn - 1) % 2 } : null;
}

/** Parses a feature set 0x06 or 0x68 block into [c]; null for any other feature set. */
export function parseVendorCsbk(b: ArrayLike<number>, c: Csbk): Csbk | null {
  if (c.fid !== 0x06 && c.fid !== 0x68) return null;
  const f = (from: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) { const p = 16 + from + i; v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1); } return v; };
  const fields: Field[] = c.fields, add = (k: string, v: string) => fields.push({ k, v });
  const payload = () => add('PAYLOAD', hex(b, 2, 10));
  const sys = (v: number) => { const s = sysCode(v); c.sysCode = v; c.net = s.net; c.site = s.site; c.model = s.model; add('SYSTEM CODE', `${h(v, 4)} (${s.model} net ${s.net} site ${s.site})`); };
  c.kind = 'vendor';
  if (c.fid === 0x06) {
    c.trunk = 'CONNECT PLUS';
    switch (c.op) {
      case 3: {
        c.name = 'CON+ VOICE CHANNEL USER';
        const src = f(0, 24), tg = f(24, 24), ch = conPlusLsn(f(48, 5));
        add('TALKGROUP', `${tg}`); add('SOURCE', `${src}`);
        if (ch) { c.kind = 'grant'; c.group = true; c.dst = tg; c.src = src; c.lpcn = ch.lcn; c.slot = ch.slot; add('CHANNEL', `LCN ${ch.lcn} TS${ch.slot + 1}`); }
        else add('LSN', `${f(48, 5)}`);
        break;
      }
      case 6: {
        c.name = 'CON+ DATA CHANNEL GRANT'; c.kind = 'unit';
        const to = f(0, 24), ch = conPlusLsn(f(24, 5)); c.dst = to;
        add('TO', `${to}`); if (ch) { c.lcn = ch.lcn; add('CHANNEL', `LCN ${ch.lcn} TS${ch.slot + 1}`); }
        break;
      }
      case 12: c.name = 'CON+ TERMINATE CHANNEL GRANT'; c.kind = 'unit'; c.dst = f(0, 24); add('TO', `${c.dst}`); break;
      case 1: {
        c.name = 'CON+ NEIGHBOR REPORT';
        const sites: number[] = []; for (let i = 0; i < 6; i++) { const s = f(i * 8, 8); if (s) sites.push(s); }
        add('NEIGHBOR SITES', sites.length ? sites.join(', ') : 'none');
        break;
      }
      case 17: case 18: {
        c.name = c.op === 17 ? 'CON+ REGISTRATION REQUEST' : 'CON+ REGISTRATION RESPONSE'; c.kind = 'unit';
        c.dst = f(0, 24); add('RADIO', `${c.dst}`); add('TO', `${f(24, 24)}`);
        break;
      }
      case 24: {
        c.name = 'CON+ TALKGROUP AFFILIATION'; c.kind = 'affil';
        c.unit = f(0, 24); c.dst = f(24, 24); c.group = true; add('RADIO', `${c.unit}`); add('TALKGROUP', `${c.dst}`);
        break;
      }
      default: c.name = `CON+ CSBK ${h(c.op, 2)}`; payload();
    }
    return c;
  }
  switch (c.op) {
    case 25: {
      // the ETSI Aloha's layout under Hytera's feature set
      c.name = 'HYTERA ALOHA'; c.kind = 'aloha';
      add('VERSION', `${f(3, 3)}`); add('REGISTRATION REQUIRED', f(19, 1) ? 'yes' : 'no');
      sys(f(24, 16)); const ms = f(40, 24); if (ms) { c.dst = ms; add('MS ADDRESS', `${ms}`); }
      break;
    }
    case 40: c.name = 'HYTERA ANNOUNCEMENT'; add('TYPE', `${f(0, 5)}`); sys(f(24, 16)); break;
    case 61: {
      c.trunk = 'HYTERA XPT'; c.name = 'HYTERA XPT PREAMBLE'; c.kind = 'xpt';
      const group = f(1, 1) === 1, free = f(16, 4), prio = f(20, 4);
      c.group = group; c.dst = f(24, 16); c.src = f(48, 16); c.rest = free;
      add(group ? 'TALKGROUP' : 'TO RADIO', `${c.dst}`); add('SOURCE', `${c.src}`);
      add('FREE REPEATER', free ? `${free}` : 'all busy'); if (prio) add('PRIORITY CALL ON', `repeater ${prio}`);
      break;
    }
    case 10: {
      c.trunk = 'HYTERA XPT'; c.name = 'HYTERA XPT SITE STATE';
      const free = f(0, 4); c.rest = free;
      add('FREE REPEATER', free ? `${free}` : 'all busy'); add('REPEATER STATES', [f(4, 4), f(8, 4), f(12, 4)].map(x => h(x, 1)).join(' '));
      break;
    }
    case 11: c.trunk = 'HYTERA XPT'; c.name = 'HYTERA XPT ADJACENT SITES'; payload(); break;
    case 32: c.name = 'HYTERA ACKNOWLEDGE'; payload(); break;
    default: c.name = `HYTERA CSBK ${h(c.op, 2)}`; payload();
  }
  return c;
}

/**
 * Hytera XPT channel grant, a full link control (FLCO 9 under feature set 0x68, in a voice LC header or terminator):
 * the repeater a call goes to, its talkgroup and caller (SDRTrunk lc/full/hytera/HyteraXptChannelGrant: CHANNEL bits
 * 16-19, TARGET 24-47, SOURCE 48-71). Checked by the LC's Reed-Solomon(12,9) like any full LC. Null for anything else.
 */
export function parseXptGrant(b: ArrayLike<number>, dt: number): { repeater: number; tg: number; src: number; ok: boolean } | null {
  if ((b[0] & 0x3f) !== 9 || b[1] !== 0x68) return null;
  return { repeater: b[2] >> 4, tg: (b[3] << 16) | (b[4] << 8) | b[5], src: (b[6] << 16) | (b[7] << 8) | b[8], ok: rs129Ok(b, dt) };
}
