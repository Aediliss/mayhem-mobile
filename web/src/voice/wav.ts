/**
 * FORK: 16-bit mono PCM WAV with a RIFF LIST/INFO chunk, which audio players and taggers show:
 *   INAM title   (e.g. "TG 1234 · unit 5678")   ICRD date (ISO 8601)   ISFT software
 *   ICMT comment (the full metadata as JSON: app, frequency, talkgroup, unit, system, protocol …)
 */

const enc = new TextEncoder();

function infoChunk(info: Record<string, string>): Uint8Array {
  const subs: Uint8Array[] = [];
  for (const [id, value] of Object.entries(info)) {
    if (!/^[A-Z]{4}$/.test(id) || !value) continue;
    const v = enc.encode(value + '\0'), pad = v.length & 1, b = new Uint8Array(8 + v.length + pad), dv = new DataView(b.buffer);
    b.set(enc.encode(id)); dv.setUint32(4, v.length, true); b.set(v, 8);
    subs.push(b);
  }
  const body = subs.reduce((s, b) => s + b.length, 0), out = new Uint8Array(12 + body), dv = new DataView(out.buffer);
  out.set(enc.encode('LIST')); dv.setUint32(4, 4 + body, true); out.set(enc.encode('INFO'), 8);
  let o = 12; for (const b of subs) { out.set(b, o); o += b.length; }
  return out;
}

/** Float samples (-1..1) → a WAV file's bytes, with INFO tags. */
export function encodeWav(samples: Float32Array, rate: number, info: Record<string, string> = {}): Uint8Array {
  const list = Object.keys(info).length ? infoChunk(info) : new Uint8Array(0);
  const dataLen = samples.length * 2, out = new Uint8Array(44 + list.length + dataLen), dv = new DataView(out.buffer);
  const put = (o: number, s: string) => out.set(enc.encode(s), o);
  put(0, 'RIFF'); dv.setUint32(4, out.length - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  out.set(list, 36);
  const d = 36 + list.length;
  put(d, 'data'); dv.setUint32(d + 4, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767;
    dv.setInt16(d + 8 + 2 * i, v < 0 ? -Math.round(-v) : Math.round(v), true);   // symmetric rounding
  }
  return out;
}

/** Read a WAV's INFO tags, format and samples back (for tests and for listing recordings). */
export function readWav(b: Uint8Array): { rate: number; channels: number; bits: number; info: Record<string, string>; samples: Int16Array } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, rate = 0, channels = 0, bits = 0; const info: Record<string, string> = {}; let samples = new Int16Array(0);
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') { channels = dv.getUint16(body + 2, true); rate = dv.getUint32(body + 4, true); bits = dv.getUint16(body + 14, true); }
    else if (id === 'LIST' && tag(body) === 'INFO') {
      let p = body + 4;
      while (p + 8 <= body + size) { const k = tag(p), n = dv.getUint32(p + 4, true); info[k] = new TextDecoder().decode(b.subarray(p + 8, p + 8 + n)).replace(/\0+$/, ''); p += 8 + n + (n & 1); }
    } else if (id === 'data') samples = new Int16Array(b.slice(body, body + size).buffer);
    o = body + size + (size & 1);
  }
  return { rate, channels, bits, info, samples };
}
