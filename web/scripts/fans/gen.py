import json, re, sys
D, L, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
types = json.load(open(f'{D}/schema.json'))
src = open(f'{L}/asn1-format-cpdlc-text.c').read()
# element phrasings
texts = {}
for m in re.finditer(r'FANSATC(?:Uplink|Downlink)MsgElementId_PR_(\w+), "((?:[^"\\]|\\.)*)"', src): texts[m.group(1)] = m.group(2)
# unit formatters: name -> (unit, scale, decimals)
units = {}
for m in re.finditer(r'LA_ASN1_FORMATTER_FUNC\((la_asn1_format_\w+)\) \{\s*la_format_INTEGER_with_unit_as_text\(p, "([^"]*)", ([\d.]+), (\d+)\);', src): units[m.group(1)] = (m.group(2), float(m.group(3)), int(m.group(4)))
special = {'la_asn1_format_FANSTime_as_text': 'time', 'la_asn1_format_FANSTimestamp_as_text': 'timestamp', 'la_asn1_format_FANSLatitude_as_text': 'lat',
           'la_asn1_format_FANSLongitude_as_text': 'lon', 'la_asn1_format_FANSBeaconCode_as_text': 'beacon', 'la_asn1_format_ENUM_as_text': 'enum'}
fmt = {}
for m in re.finditer(r'\{ \.type = &asn_DEF_(\w+), \.format = (\w+), \.label = (NULL|"[^"]*") \}', src):
    name, f, label = m.group(1), m.group(2), (None if m.group(3) == 'NULL' else m.group(3)[1:-1])
    if f in units: kind = ['unit', *units[f]]
    elif f in special: kind = [special[f]]
    else: kind = None
    fmt[name] = (label, kind)
KIND = {'seq': 0, 'choice': 1, 'seqof': 2, 'int': 3, 'enum': 4, 'bool': 5, 'null': 6, 'str': 7}
out = []
for t in types:
    pc = t['pc']
    v = pc['v'] if pc else None; s = pc['s'] if pc else None
    label, kind = fmt.get(t['name'], (None, None))
    e = {'n': t['name'], 'k': KIND[t['kind']]}
    if v and v[0]: e['v'] = v[:2] + v[3:]          # flags, range bits, lb, ub
    if s and s[0]: e['s'] = [s[0], s[2], s[3], s[4]]  # flags, effective bits, lb, ub
    if pc and 'alpha' in pc: e['a'] = ''.join(chr(c) if c >= 0 else '\0' for c in pc['alpha'])
    if t['kind'] == 'choice' and t['canon']: e['c'] = t['canon']
    if t['kind'] == 'enum': e['e'] = [[x[0], x[1]] for x in t['values']]
    if t['members']: e['m'] = [[m['name'], m['type'], 1 if m['opt'] else 0] for m in t['members']]
    if label is not None: e['l'] = label
    if kind: e['f'] = kind
    for chk in ('extAfter',):
        if t.get(chk, -1) not in (-1, None) and t['extAfter'] < len(t['members']) - 1: raise SystemExit('extensions not handled: ' + t['name'])
    if t['kind'] == 'choice' and t['extStart'] != -1: raise SystemExit('choice extension: ' + t['name'])
    if t['kind'] == 'enum' and t['ext']: raise SystemExit('enum extension: ' + t['name'])
    if (v and v[0] & 4) or (s and s[0] & 4): raise SystemExit('extensible constraint: ' + t['name'])
    out.append(e)
missing = [m[0] for t in out if t['n'] in ('FANSATCUplinkMsgElementId', 'FANSATCDownlinkMsgElementId') for m in t['m'] if m[0] not in texts]
if missing: raise SystemExit(f'no text for {missing[:5]}')
el = {m[0]: texts[m[0]] for t in out if t['n'] in ('FANSATCUplinkMsgElementId', 'FANSATCDownlinkMsgElementId') for m in t['m']}
with open(OUT, 'w') as f:
    f.write('''/**
 * FORK: GENERATED (do not edit by hand) — the FANS-1/A CPDLC message set as unaligned PER sees it, and how libacars
 * words it. Types and constraints were read out of libacars' asn1c-generated tables (libacars by Tomasz Lemiech, MIT;
 * asn1c runtime by Lev Walkin, BSD-2-Clause) by walking their descriptors in C; labels, units and the message element
 * texts come from libacars/asn1-format-cpdlc-text.c. Kinds: 0 SEQUENCE, 1 CHOICE, 2 SEQUENCE OF, 3 INTEGER,
 * 4 ENUMERATED, 5 BOOLEAN, 6 NULL, 7 string. v = [flags, range bits, lb, ub] of the value, s = [flags, effective bits,
 * lb, ub] of the size, a = the alphabet by code, c = CHOICE canonical order, e = enumerations, m = [name, type, optional],
 * l = label, f = display format.
 */
export interface FansType { n: string; k: number; v?: number[]; s?: number[]; a?: string; c?: number[]; e?: [number, string][]; m?: [string, number, number][]; l?: string; f?: (string | number)[] }
''')
    f.write('export const FANS_TYPES: FansType[] = [\n' + ',\n'.join(json.dumps(e, separators=(',', ':'), ensure_ascii=False) for e in out) + '\n];\n')
    f.write('/** Element id → the controller/pilot phrase it stands for. */\nexport const FANS_TEXT: Record<string, string> = ' + json.dumps(el, indent=0, ensure_ascii=False) + ';\n')
print(len(out), 'types,', len(el), 'element texts,', sum(1 for e in out if 'f' in e), 'formats,', sum(1 for e in out if 'l' in e), 'labels')
