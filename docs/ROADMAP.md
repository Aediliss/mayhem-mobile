# Mad Mobile roadmap

Web-only decoding work on top of upstream Mayhem Mobile. Phases are in build order: infrastructure first, because it
makes every later decoder testable without a live signal. ★ = priority.

**How to use this file.** Tick `[x]` when an item is done (`npm run check`, `npm run build` and `npm test` all pass),
and add a line under *Verification notes* at the bottom: what the test proves and what still needs real hardware.

**License column.** "✔" means checked on the date shown against the project's LICENSE file and/or source headers.
GPL-3.0-compatible: GPL-3.0(-or-later), GPL-2.0-**or-later**, LGPL-2.x, AGPL-3.0 (combinable under GPLv3 §13; the
combined work then carries AGPL terms for network use), Apache-2.0, MIT, BSD, ISC, public domain. **Not compatible:
GPL-2.0-only.** "check" means not verified yet: verify before porting any code; if unclear, implement from the spec.

## Phase 0 — Orient and set up

| Done | Item | Notes |
|---|---|---|
| [x] | `CLAUDE.md` (commands, patterns, FORK rules, upstream sync) | |
| [x] | This roadmap with reference licenses | licenses checked 2026-11-26 |
| [x] | `npm ci && npm run build` works; `npm run serve` on http://localhost:8080 | `web/scripts/serve.mjs`, no new deps |
| [x] | `npm test` (node:test, bundled by the existing esbuild) + seed APRS round-trip test | `web/test/` |
| [x] | CI: Android/Play/release workflows removed; `web.yml` runs check/build/test, deploys Pages on `main` | |
| [x] | Branding: **Mad Mobile**: title, manifest, wordmark, About → fork, upstream credited | name chosen 2026-11-26 |
| [x] | `upstream` remote added, first sync | level with upstream at setup |

## Phase 1 — Decoding infrastructure

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | **Test harness**: `web/test/lib/iq.ts` grown into tones, FSK/GFSK, OOK/ASK, PSK, AWGN at a set SNR, `.cu8/.cs8/.cs16` writers | own code | — |
| [x] | ★ | **File source** `FileRadio`: `.c8/.cs8`, `.cu8`, `.cs16`, `.wav` IQ, Mayhem `.C8/.C16` + `.txt`, SigMF; real-time or as-fast-as-possible; Capture → replay round trip. UI: an "Open recording…" button beside CONNECT (approved 2026-11-26); WebUSB claiming untouched | SigMF spec (sigmf.org) | spec, CC-BY-SA-4.0 text (implementing it is fine) |
| [x] | ★ | **SigMF recording** from Capture: frequency, rate, datetime, gain, radio, app, GPS | SigMF core spec v1.x | spec |
| [x] | | **Decode export bus**: JSON-lines + download, webhook, MQTT/WebSocket (+ HA discovery), Beast/SBS, NMEA, APRS-IS text/KISS, rtl_433 JSON. Off by default; Settings | Beast/SBS formats (readsb docs), rtl_433 JSON field names | readsb GPL-3.0 ✔ (code); formats are facts |
| [x] | | **Audio-in source** (mic/line-in/discriminator) for FT8, RTTY, PSK, SSTV, APRS, POCSAG/FLEX, SAME, ACARS | upstream `mic-worklet.js` | in-repo |
| [x] | | **Voice recording** to WAV with TG/unit/time metadata (Dispatch, Repeaters, Prowl) | WAV `LIST/INFO` chunks | spec |
| [x] | | **Analyzer protocol library** export/import JSON | `analyzer-store.ts` | in-repo |

## Phase 2 — Quick wins and corrections

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | Satellites: NOAA 15/18/19 decommissioned (grey out, keep) | NOAA OSPO notices | facts |
| [x] | ★ | Full Mode-S in `dsp/adsb.ts`: DF0/4/5/11/16/20/21, Comm-B BDS 1,0/2,0/4,0/5,0/6,0, AP recovery vs known ICAOs, 1–2 bit CRC fix (DF11/17/18), "Mode-S only" aircraft | ICAO Annex 10 Vol IV, Doc 9871; pyModeS; readsb; dump1090-fa | pyModeS GPL-3.0 ✔ · readsb GPL-3.0 ✔ · dump1090-fa GPL-2.0-or-later ✔ · antirez dump1090 BSD-3 ✔ |
| [x] | | Mode A/C replies (≥2 Msps), unassociated tracks | dump1090-fa `mode_ac.c` | GPL-2.0-or-later ✔ |
| [x] | | BLE: auto-rotate 37/38/39, extended adv headers, PHY per packet (coded PHY: own row below) | Bluetooth Core 5.x Vol 6 | spec only |
| [ ] | | BLE LE Coded PHY receiver (125/500 kbit/s: FEC, pattern mapping, coded access address) | Bluetooth Core 5.x Vol 6 Part B 3.3 | spec |
| [x] | | BLE tracker-following alert (AirTag/Find My/Tile/SmartTag/Find Hub) over time + GPS distance | IETF draft-ietf-dult-accessory-protocol-01 (Apple, Google) | spec only (IETF Trust, BCP 78); no code used |

## Phase 3 — Drones

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | Remote ID: BLE legacy (UUID 0xFFFA, message pack) · map with drone + operator | ASTM F3411, ASD-STAN prEN 4709-002; opendroneid-core-c | opendroneid-core-c Apache-2.0 ✔ |
| [ ] | | Remote ID over Bluetooth 5 long range (AUX packets on data channels, LE Coded PHY) | ASTM F3411 | needs the LE Coded row and AUX following |
| [ ] | | Remote ID over Wi-Fi beacon / NAN (2.4 GHz ch 6, 5.8 GHz) | ASTM F3411; IEEE 802.11 | needs an 802.11 receiver (Phase 9 Wi-Fi row) |
| [x] | ★ | DJI DroneID (OcuSync 2.4 GHz OFDM): detect, demod, serial + drone/pilot/home GPS | proto17/dji_droneid; 3GPP TS 36.211 / 36.212 | dji_droneid MIT ✔ (file LICENSE) · turbofec GPL-3.0-or-later ✔ (one table row checked) · DroneSecurity not used |
| [ ] | | DJI DroneID at 5.8 GHz, and the newer encrypted DroneID (detect only) | channel survey | needs recordings |
| [x] | | FPV analog video detect at 5.8 GHz (raceband/A/B/E/F), NTSC/PAL frames if bandwidth allows | channel tables (public) | facts |
| [x] | | Digital FPV + control-link fingerprinting: ExpressLRS by its published parameters; digital video measured as OFDM | ExpressLRS `src/src/common.cpp`, `src/lib/FHSS` | ExpressLRS GPL-3.0 ✔ (LICENSE) |
| [ ] | | Naming digital FPV systems (DJI O3/O4, Walksnail, HDZero) and TBS Crossfire | — | no published air parameters or redistributable recordings: needs measurements |

## Phase 4 — Aviation

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | HFDL (2.9–22 MHz), many channels per span, feeds ACARS cards | dumphfdl (Tomasz Lemiech): hfdl.c, mpdu/lpdu/hfnpdu/acars.c, etc/systable.conf; liquid-dsp conventions checked against liquid-dsp 1.6 | GPL-3.0-or-later ✔ (spdu.c GPL-2.0-or-later ✔); libacars MIT ✔ (format only) |
| [x] | | ADS-C (and the ARINC 622 envelope: CPDLC named) inside ACARS/VDL2/HFDL | libacars (Tomasz Lemiech): arinc.c, adsc.c, acars.c | MIT ✔ |
| [x] | | CPDLC message bodies (FANS-1/A, ASN.1 PER: clearances, requests, free text) | libacars (asn1/ generated from the FANS-1/A ASN.1; asn1-format-cpdlc-text.c); asn1c 0.9.28 runtime PER rules | libacars MIT ✔ · asn1c runtime BSD-2-Clause ✔ |
| [x] | | Iridium (1616–1626.5 MHz): bursts, frame types, ring alerts, sat/beam IDs, ACARS | gr-iridium (burst tagger, burst_downmix, qpsk_demod; test-data/prbs15-2M-20dB); iridium-toolkit (bitsparser.py, bch.py, reassembler ida.py / sbd.py) | gr-iridium GPL-3.0-or-later ✔ (headers) · iridium-toolkit BSD-2-Clause ✔ (README: "unless otherwise noted"; the RS files with their own notice are not used) |
| [x] | | VOR bearing + Morse ID; ILS LOC/GS DDM; DME pulse pairs | Mayhem `proc_vor_rx` (the VOR bearing); ICAO Annex 10 Vol. I signal parameters (ILS, idents, DME); LOC/GS/DME pairing checked against the FAA/RadioReference table | Mayhem GPL-3.0 ✔ · ICAO and FAA: facts (frequencies, tones, depths) only |
| [x] | | Inmarsat AERO / STD-C (needs LNA + patch; say so in UI) — **done upstream**: the Satcom app (0.9.76, dsp/lband/: Inmarsat-C NCS EGC, Aero P-channel 600/1200 bps ACARS to Flight Msgs; the UI says an LNA and patch are needed) | upstream | — |
| [x] | | Inmarsat Aero 10.5 kbps P-channel (OQPSK, ground → aircraft): Satcom's AERO 10.5K mode | JAERO (aerol.cpp/.h: framing, 64×78 interleaver, K=7 code 109/79, 15-bit scrambler, SU CRC, ISU reassembly and ACARS parse; oqpskdemodulator / coarsefreqestimate: RRC roll-off 1, the squared-signal line pair); samples/10.5k_sample.ogg (5.6 s cut as a test fixture) | JAERO MIT ✔ (LICENSE, Jonathan Olds 2015-2019; the files used carry no other notice) |
| [x] | | Inmarsat Aero 10.5k R/T burst channels (aircraft → ground, OQPSK bursts): in AERO 10.5K beside the P channel | JAERO (burstoqpskdemodulator: carrier opening and symbol tone; aerol RTChannelDeleaveFECScram, RISUData, T-packet SUs); samples/10.5k_burst_sample.mp3 (two bursts cut as a test fixture) | MIT ✔ |
| [x] | | Inmarsat Aero 600/1200 bps R/T bursts (MSK): in AERO 600 / AERO 1200 beside upstream's P-channel decoder | JAERO (burstmskdemodulator: MSK as offset QPSK + differential decoding = the frequency's sign each bit; aerol deinterleaveMSK, RTChannelDeleaveFECScram.updateMSK); samples 1200bps_burst_sample1/2.wav (sample 2's two bursts as a test fixture) | MIT ✔ |
| [x] | | FLARM / OGN receive — as **ADS-L** (the Gliders app): both M-band channels (868.2/868.4 MHz) at once; Traffic (position, altitude, speed, climb, track, category, emergency) and Status payloads; OGN tracker packets counted, not read; FLARM's own protocol not read | EASA ADS-L 4 SRD-860 Issue 2 (1 Dec 2025, ED Decision 2022/024/R): physical layer, packet, XXTEA key-0 scrambling, CRC-24, payloads; OGN wiki (OGN sync word) | EASA spec: "open to any interested party for implementation" (A.3), written from the spec, no code ported ✔ · OGN wiki CC BY-SA 3.0 (a fact: the sync word) ✔ · FLARM air protocol: closed and obfuscated, decrypting it may be unlawful in the EU ✘ (not read) · OGN tracker firmware (pjalocha, glidernet): no license ✘ (not used; OGN's LDPC code and whitening are not published, so OGN packets are counted only) |
| [x] | | MLAT feeder (Beast over WebSocket) via export bus: Mode-S frames carry 12 MHz ticks from the sample clock | Beast format; dump1090/readsb's 12 MHz free-running counter (what mlat-client's `dump1090` input type expects) | facts ✔ (no code ported) |

## Phase 5 — Marine and emergency

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | Marine DSC ch 70 (156.525 MHz, 1200 Bd FSK); link MMSIs to Ships | ITU-R M.493-16 (12/2023): Annex 1 (ten-bit code, time diversity, phasing, format specifiers, call tables A1-4.x, Table A1-5 channels, ECC) | ITU-R recommendation: implemented from the spec, no code ported ✔ |
| [x] | ★ | EPIRB/PLB/ELT 406 MHz (BCH, hex ID, country, protocol, position) + 121.5 MHz homing | Mayhem `epirb_rx` (external/epirb_rx: beacon.hpp, location.cpp, BEACON.RES; baseband/proc_epirb: the signal) and its sdcard/EPIRB/BEACONS.TXT reference frames; C/S T.001 bit layout; ICAO 121.5 homer sweep (≥700 Hz within 1600–300 Hz, 2–4 Hz) | Mayhem's EPIRB files: GPL-2.0-or-later (Frederic Borry, ADRASEC 31) ✔ — checked in each file's header |
| [x] | | NAVTEX / SITOR-B (518/490 kHz), both at once | ITU-R M.625-4 (mode B: 7-unit code Table 1, Table 2 phasing signals, §4 time diversity and phasing), M.540-2 (ZCZC B1B2B3B4 … NNNN) | ITU-R recommendations: implemented from the specs, no code ported ✔ |
| [x] | | Inmarsat-C EGC / SafetyNET — **done upstream**: the Satcom app's EGC mode (0.9.76, dsp/lband/stdc.ts: NCS TDM, EGC messages with priority, service and area) | upstream | — |

## Phase 6 — Public safety trunking (extends Dispatch)

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | EDACS (standard + networked), ProVoice identification only — in Dispatch via the plug-in hook | TIA/EIA TSB-69.3; DSD-FME `edacs-fme.c`; edacs-fm; ledacs | DSD-FME ISC ✔ (COPYRIGHT: all but the D-STAR files) · edacs-fm GPL-3.0 ✔ · ledacs Unlicense ✔ · Morelos-Zaragoza BCH code "non-commercial only" ✘ not used |
| [x] | ★ | LTR / LTR Passport — in Dispatch via the plug-in hook | SDRTrunk `module/decode/ltrstandard`, `passport`, `edac/CRCLTR`, `CRCPassport` | SDRTrunk GPL-3.0-or-later ✔ (file headers); no public spec |
| [x] | ★ | MPT1327 — in Dispatch via the plug-in hook | SDRTrunk `module/decode/mpt1327`, `edac/CRCFleetsync` | SDRTrunk GPL-3.0-or-later ✔ (file headers) · MPT1327 spec PDF not reachable (Ofcom 403) |
| [x] | | DMR Tier III: Connect Plus, Hytera XPT (control blocks; see notes for what is left) | SDRTrunk `module/decode/dmr/message/data/csbk/motorola/ConnectPlus*`, `.../hytera/Hytera*` | SDRTrunk GPL-3.0-or-later ✔ (file headers) · DSD-FME not used (its BCH routine is non-commercial only, see EDACS) |
| [x] | | DMR short LC (CACH): Connect Plus network/site, Hytera XPT free repeater | ETSI TS 102 361-1 (BPTC(68,36), CRC-8); SDRTrunk `lc/shorty`, `bptc/BPTC_68_36` | SDRTrunk GPL-3.0-or-later ✔ |
| [x] | | Hytera XPT channel grant (full LC opcode 9 under FID 0x68): which repeater a call moves to | SDRTrunk `lc/full/hytera/HyteraXptChannelGrant` | SDRTrunk GPL-3.0-or-later ✔ |
| [x] | | Two-tone sequential receive named: Motorola Quick Call II (reeds, cap code, call kind, group call), GE Type 99 | Midian Electronics tone signaling charts (tables, timings); PGHscanner/qsl.net k3fs QC-II table (cross-check) | facts (frequencies, timings) only; no code copied |
| [ ] | | GE Star (digital ANI) — **blocked** | the only frame description found is Matthew Kaufman's STAR Encoder/Decoder Library (github.com/atmatthewat/star-encode-decode) | **GPL-2.0-only ✘** ("version 2 of the GNU General Public License", no "or later"; README offers commercial terms on request) · no published spec |
| [x] | | Alias import (RadioReference CSV / OP25 tags / SDRTrunk XML) → names in Dispatch | file formats only (RadioReference CSV export, OP25 tag TSV, SDRTrunk playlist XML) | no code used; formats implemented from their layout |

## Phase 7 — Ham radio digital (extends Ham Radio → DIGITAL)

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [x] | ★ | FT4 (reuses FT8's LDPC, OSD, CRC and unpacking) in Ham Radio → DIGITAL | ft8_lib (constants.c FT4 Costas/Gray/XOR, encode.c ft4_encode, decode.c ft4 sync and symbols); its C encoder run to give the test vectors | ft8_lib MIT ✔ (LICENSE, Kārlis Goba) |
| [x] | ★ | WSPR-2 in Ham Radio → DIGITAL (2-minute beacons: call, grid, dBm, SNR, DT, drift) | WSJT-X lib/wsprd (wsprd.c, wsprd_utils.c, wsprsim_utils.c); its wsprsim built and run for the test vectors | WSJT-X GPL-3.0 ✔ (COPYING is GPLv3; wsprd.c, wsprd_utils.c and nhash.c say GPL v3 or later). fano.c (Phil Karn, 1994) carries no licence line, so the sequential decoder is written here from the textbook stack algorithm instead; nhash is lookup3 (Bob Jenkins, public domain) |
| [ ] | | WSPRnet spot upload (off by default; needs the STATION call and grid, and Settings' "nothing is sent anywhere else" text changed) | WSJT-X WSPRNet.cpp (form fields to check) | GPL-3.0 ✔ |
| [x] | ★ | FST4W-120 in Ham Radio → DIGITAL (the 2-minute beacons on WSPR's dials) | WSJT-X lib/fst4 (genfst4, get_crc24, ldpc_240_74_*, decode240_74, get_fst4_bitmetrics), lib/fst4_decode.f90, lib/77bit/packjt77.f90 (type 0.6) | GPL-3.0 ✔ (WSJT-X COPYING; these files carry no header of their own) |
| [x] | ★ | MSK144 (meteor scatter) in Ham Radio → DIGITAL | WSJT-X lib/genmsk_128_90, encode_128_90, crc13.cpp, ldpc_128_90_*, bpdecode128_90, msk144spd / msk144sync / msk144_freq_search / msk144decodeframe | GPL-3.0 ✔ (WSJT-X COPYING) |
| [x] | ★ | FST4 (15 s to 30 min) and FST4W-300/900/1800 in Ham Radio → DIGITAL | WSJT-X lib/fst4 (ldpc_240_101_*, genfst4's message scrambling), lib/fst4_decode.f90 (the periods' timing) | GPL-3.0 ✔ |
| [x] | ★ | JT65 (A, B, C) in Ham Radio → DIGITAL | WSJT-X lib/gen65, setup65, interleave63, igray.c, wrapkarn.c, packjt.f90; Karn's init_rs / encode_rs / decode_rs | WSJT-X GPL-3.0 ✔; Karn's RS: "may be used under the terms of the GNU General Public License (GPL)" (no version: any, so 3 ✔) |
| [x] | ★ | MSK40 short messages (in MSK144) | WSJT-X lib/genmsk40, encode_msk40, bpdecode40, msk40decodeframe | GPL-3.0 ✔ |
| [x] | ★ | JT9 (JT9-1) in Ham Radio → DIGITAL | WSJT-X lib/gen9, jt9sync, entail, encode232 / conv232, interleave9, symspec2, jt9fano | GPL-3.0 ✔ |
| [ ] | ★ | Q65 | WSJT-X | GPL-3.0 ✔ |
| [ ] | ★ | FreeDV 700D/700E/1600 modems (Codec 2 already in `dsp/hamid/codec2.ts`) | codec2 | LGPL-2.1 ✔ |
| [x] | | PSK63, PSK125, QPSK31 in Ham Radio → DIGITAL | fldigi src/psk/psk.cxx, src/filters/viterbi.cxx (QPSK) | GPL-3.0-or-later ✔ (COPYING GPLv3; file headers "version 3 or later") |
| [ ] | | fldigi modes: Olivia, Contestia, MFSK16/32, Thor, Domino, Hell | fldigi | GPL-3.0 ✔ |
| [ ] | | D-STAR slow data + DPRS → Ham Map; Fusion data | DSD-FME; JARL spec | ISC ✔ / spec |
| [ ] | | HF packet (300 Bd), ARDOP; KISS out via export bus | Dire Wolf; ARDOP spec | check |
| [x] | | WEFAX (HF radiofacsimile) in Ham Radio → DIGITAL | the published broadcast parameters (NOAA's radiofacsimile schedules; WMO practice); Mayhem's `wefax_rx` not used | written from the parameters, nothing ported |
| [ ] | | digital SSTV (HamDRM / EasyPal) | QSSTV | check |
| [ ] | | 2G ALE (MIL-STD-188-141A), CODAN selcall | spec | spec |

## Phase 8 — Security and situational awareness

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | Jamming detection (319.5/345/433.92/915 MHz, GNSS L1): sustained floor rise / CW carrier → alert card + bus event | own | — |
| [ ] | ★ | GPS L1 C/A monitor: acquisition (PRN, Doppler, C/N0), jamming + spoofing flags; fix = stretch | IS-GPS-200; GNSS-SDR | spec · GNSS-SDR GPL-3.0 ✔ |
| [ ] | ★ | Rogue cell heuristics on the LTE decoder (identity/metadata only) | 3GPP TS 36.331; SeaGlass/Crocodile Hunter papers | spec · check any code |
| [ ] | | RF baseline per site + new-emitter alerts, JSON + printable HTML report | own | — |
| [ ] | | PowerG presence + supervision timing only (encrypted) | own measurements | — |
| [ ] | | Fox hunt / DF: RSSI vs compass bearing plot | Mayhem fox hunt / signal hunter | GPL-3.0 ✔ |

## Phase 9 — Everything else

| Done | Item | Reference | License |
|---|---|---|---|
| [ ] | Mayhem parity: NRF24 (`nrf_rx`), Sigfox (`ui_sigfrx`), Horus Binary (`horus_rx`), analog TV, AFSK RX | Mayhem; horusdemodlib | Mayhem GPL-3.0 ✔ · horusdemodlib LGPL-2.1 ✔ |
| [ ] | Pagers: GSC; more on-site pagers | spec / recordings | — |
| [ ] | CubeSat telemetry: FUNcube BPSK 1200, GMSK 9600 beacons | gr-satellites | GPL-3.0 ✔ |
| [ ] | GOES HRIT/LRIT/EMWIN, Meteor HRPT (dish + LNA; say so in UI) | goestools; SatDump | check |
| [ ] | Broadcast: DAB/DAB+, DRM, FM SCA (67/92 kHz), AM HD Radio (if missing), ATSC 3.0 bootstrap/L1, WWV/WWVH | ETSI specs; qt-dab / dab-cmdline | spec · check |
| [ ] | Wireless: 5G NR SSB/MIB/SIB1, GSM BCCH, Wi-Fi b/g beacons, Zigbee/Thread, BT Classic LAP, Wi-Fi HaLow, Reticulum/RNode, DECT RFPI only | 3GPP; gr-ieee802-11; gr-ieee802-15-4; libbtbb; srsRAN | gr-ieee802-11 GPL-3.0 ✔ · gr-ieee802-15-4 GPL-3.0 ✔ · libbtbb GPL-2.0-or-later ✔ · srsRAN_4G AGPL-3.0 ✔ |

## Notes on upstream code already in the tree

Upstream's credits name two GPL-2.0 sources "after the frame layout" (fsync by Matthew Kaufman; YSFClients). Using a
documented frame layout is not copying code, but if this fork ever ports code from either, check the file headers
for "or later" first.

## Verification notes

- **Phase 0 · seed test** (`web/test/aprs.roundtrip.test.ts`): the Transmit app's AX.25 encoder → Bell 202 AFSK →
  FM (±3 kHz) → int8 IQ at 960 ksps → `AprsDecoder`. Proves: a clean packet decodes to the exact text; it still
  decodes with a 2 kHz carrier offset at 10 dB SNR; pure noise decodes nothing; a one-bit corruption is rejected by
  the FCS. Hardware: none needed for this item.
- **Phase 1 · test harness** (`web/test/lib/iq.ts`, `lib/ble.ts`, `harness.test.ts`, `btle.roundtrip.test.ts`):
  tone, FSK/GFSK (Gaussian BT), OOK from rtl_433-style pulse lists, M-PSK, AWGN at an SNR measured against the
  signal's own active power, and `.cs8` / `.cu8` / `.cs16` / WAV-IQ writers. The harness tests itself: tone energy at
  the right offset (and >40 dB down at its mirror), FSK symbol centres at ±deviation and GFSK never overshooting,
  OOK edges exact to the sample, QPSK phases exact, measured SNR within 0.2 dB, writer byte layouts. A BLE
  transmitter written from the Core Spec (whitening, CRC-24) round-trips through the existing `BtleDecoder` on
  channels 37/38/39, including at 15 dB SNR; wrong-channel whitening, a flipped bit and pure noise decode nothing.
  Hardware: none needed for this item.
- **Phase 1 · FileRadio** (`web/src/fileradio.ts`, `web/src/filesrc/`, `test/fileradio.test.ts`): a recording plays as a
  radio through the same `{type:'iq'}` worker path. Formats: `.cs8/.c8`, `.cu8`, `.cs16/.c16`, `.cf32/.cfile/.raw`
  (gqrx), WAV IQ (8/16-bit, float; SDR#/HDSDR `auxi` centre frequency), Mayhem `.C8/.C16` + `.TXT`, SigMF (ci8, cu8,
  ci16_le/be, cf32_le/be). Metadata order: SigMF meta, `.txt` sidecar, WAV header, file name (rtl_433, this app,
  gqrx, SDR#, HDSDR naming); asks for the rate if nothing gives it. 16-bit and float are scaled to ~16 counts RMS int8.
  Pacing 1×/2×/4×/8×/MAX with worker acks (`iqAck`, ≤3 buffers in flight). A digital LO honours any tune inside the
  recording's span, so apps that park their LO off the channel (Ham Map, Ships: +250 kHz) still decode.
  Tests prove: an APRS packet recorded in each of the six container types decodes when played; real-time playback
  of 0.5 s takes 0.43–0.9 s and 8× under 0.25 s; the digital LO makes a centre-recorded packet decode in Ham Map's
  +250 kHz setup, and without it nothing decodes. Browser check (headless Chromium, real worker, desktop and phone
  widths): OPEN REC → a 5 s `.c8` + `.txt` → all three packets in Ham Map's log, playback strip shown and removed.
  Hardware: none needed to play files. Real-recording check: record in Capture (HackRF or H4M in HackRF mode) on a
  busy channel, download the `.c8` + `.txt`, OPEN REC both in the matching app; the same packets should decode.
- **Phase 1 · SigMF in Capture** (`web/src/sigmf.ts`, `web/src/capture-sigmf.ts`, `test/sigmf.test.ts`): REC writes
  `<name>.sigmf-meta` (SigMF 1.0: ci8, sample rate, centre, ISO datetime, `core:hw` radio, `core:recorder`,
  `core:geolocation` when the page has a fix, gain/AGC/amp and app under a declared `madmobile` extension) beside
  upstream's `.c8` + `.txt`, without touching the worker's recorder. Each capture row gains a **SigMF** download: one
  `.sigmf` archive (ustar, assembled lazily so big captures are not copied); captures from before this rebuild their
  metadata from the `.txt`. OPEN REC reads `.sigmf` archives. Also fixed (upstream bug): REC recorded the channel
  (`state.freq`) as the centre; it now records the radio's LO (`spanCenter()`), so a capture made after sliding the
  channel inside the span replays at the right frequency.
  Tests prove: the metadata fields and GeoJSON order; GNU tar 1.35 lists the archive and extracts both files byte for
  byte; a `.sigmf` archive plays and decodes; upstream's real `IqRecorder` (against an in-memory OPFS) records IQ
  that plays back and decodes both as `.c8` + `.txt` and as `.sigmf`. Browser check (headless Chromium, real OPFS):
  OPEN REC a file in Capture, REC, SigMF download, OPEN REC that archive in Ham Map → all three packets decode.
  Not done here: validating against the official `sigmf` Python validator (installing it was blocked in this
  environment). To check locally: `pip install sigmf`, then
  `python -c "import sigmf; sigmf.sigmffile.fromfile('X.sigmf').validate()"`.
  Hardware: record 30 s of a busy channel in Capture with a HackRF (or H4M in HackRF mode), with location allowed;
  download SigMF; open it in inspectrum or `sigmf` tools: frequency, rate, time, hw and position should match.
- **Phase 1 · export bus, part A** (`web/src/export/`, `test/export.test.ts`): Settings → EXPORT (off by default):
  JSON-lines log with download, webhook (batched JSON POST, retry with backoff), WebSocket stream in one of JSONL,
  SBS, Beast, NMEA !AIVDM, TNC2, KISS or rtl_433 JSON. Events come from the worker's existing messages, plus three
  one-line raw-frame emits (ADS-B `modes`, AIS `aisRaw`, APRS `ax25`). Tests prove: NMEA checksums of published
  sentences (gpsd's AIVDM examples: *5C, *1C, *25); a published sentence → bytes → the real `AisDecoder` (MMSI
  477553000) → the identical sentence; long messages split ≤82 chars and reassemble; Beast framing and 0x1a escape;
  SBS 22-field lines and change-only updates; TNC2 incl. digipeater `*`; KISS escapes; rtl_433 time/field order;
  table rows reported only when they change; webhook batching and retry; WebSocket buffering until connected; an
  APRS packet decoded from IQ leaves as TNC2 text and a KISS frame. Browser check (Chromium): EXPORT on, settings
  survive reload, the APRS recording played in Ham Map → a local WebSocket server receives the three TNC2 lines, a
  local CORS webhook one POST of 9 events, and DOWNLOAD gives the same 9 as JSON lines.
  Beast timestamps were 0 here at first (no sample clock); Phase 4's MLAT item added them (see below).
- **Phase 1 · export bus, part B: MQTT** (`web/src/export/mqtt.ts`, `test/mqtt.test.ts`): MQTT 3.1.1 over WebSockets
  written from the OASIS spec (CONNECT with optional user/password, PUBLISH QoS 0, keep-alive PINGREQ, DISCONNECT;
  no client library added). Topics: `<prefix>/events/<kind>` (log lines under `events/line/<app>`), and each
  rtl_433-style device's latest fields at `<prefix>/devices/<model_channel_id>`. Optional Home Assistant discovery:
  one retained `homeassistant/<sensor|binary_sensor>/madmobile_<uid>_<field>/config` per field it understands
  (temperature °C/°F, humidity, pressure, wind, rain, light, UV, moisture; `battery_ok` as a battery binary sensor
  that is "on" when low), announced once per device per connection. Tests prove: the remaining-length boundaries
  from §2.2.3; CONNECT and PUBLISH bytes; CONNACK handled when split across WebSocket messages; a refused CONNACK
  reported and not retried; discovery topics, retain flags, templates and units for an Ambient F007TH report.
  Browser check (Chromium against a fake broker doing a real WebSocket handshake): the `mqtt` subprotocol is
  negotiated, CONNECT/CONNACK, keep-alive, and the APRS recording's events published under `madmobile/events/…`.
  Hardware/infra to test: Mosquitto with `listener 9001` + `protocol websockets`, Home Assistant's MQTT integration
  on the same broker, the Devices app on 433.92 MHz near a weather sensor: the sensor should appear in HA by itself.
- **Phase 1 · audio in** (`web/src/audiosrc/audio2iq.ts`, `web/src/audioradio.ts`, `test/audio2iq.test.ts`): AUDIO IN
  beside OPEN REC: a microphone / line-in / virtual cable (echo cancellation, noise suppression and AGC off) or an
  audio file (WAV, MP3, FLAC, OGG … decoded by the browser). The audio becomes a radio of kind `audio`: it is
  modulated onto IQ at the open app's channel the way that app's demodulator expects (USB/CW → upper sideband via a
  Hilbert filter, LSB, AM, NFM ±3 kHz, WFM ±75 kHz), re-aimed before every block, so every audio-domain decoder
  works with no decoder changes. Files play at 1×, 4× or MAX with the same worker acks as recordings; a mono WAV
  given to OPEN REC now says to use AUDIO IN. Tests prove: one second of audio is one second of IQ and 128-sample
  blocks join exactly; an APRS packet as audio decodes in the real decoder on-channel and at Ham Map's -250 kHz LO
  offset, and 25 dB quieter; USB/LSB put a tone on the right side with the mirror >30 dB down (measured ~78 dB);
  AM carries the tone on its envelope; RTTY audio → USB IQ → product detector → the real RTTY decoder reads the text.
  Browser checks (Chromium, real worker): APRS audio WAV via AUDIO FILE → all three packets in Ham Map; the same
  audio as a live microphone (Chromium's fake capture device) → all three; RTTY audio WAV in Ham Radio → DIGITAL →
  RTTY → the exact text, through the worker's own USB demodulator.
  Note: RttyDecoder's header comment says 2125/2295 Hz, but it listens for space at mark − shift (1955 Hz), i.e. mark
  is the higher tone, as on air in USB. Left as upstream wrote it.
  Hardware: (1) a handheld's speaker or a scanner's discriminator output into a line-in (or a USB sound card),
  Ham Map, AUDIO IN → that input, tuned to 144.39 MHz APRS on the handheld: packets should appear. (2) An HF rig's
  USB audio into the line-in, Ham Radio → DIGITAL → FT8 or RTTY with the rig on 14.074 / 14.080 MHz. Use headphones
  or MUTE with a microphone. Audio → IQ runs on the page at up to 2.4 Msps; on a slow phone pick a lower span.
- **Phase 1 · voice recording** (`web/src/voice/`, `test/voice.test.ts`): Settings → VOICE RECORDING (off by
  default). The speaker audio of the receiver apps (Dispatch, Repeaters, Prowl, CB, Ham Radio, Audio) is tapped
  after the decoder and before MUTE, cut into calls (starts on sound with 200 ms pre-roll; ends after 2 s quiet or
  at once when the talkgroup / unit / channel changes; blips under 0.5 s dropped; split at 10 min) and saved as
  16-bit mono WAV in the browser's private storage, named `YYYYMMDD_HHMMSS_<label>.wav` and tagged with RIFF INFO:
  INAM (e.g. "TG 1234 · unit 5678"), ICRD, ISFT, and ICMT holding JSON (app, talkgroup, group, unit, system, site,
  protocol, frequency, emergency; for Repeaters frequency, tone and callsign; start, end, seconds). Only what the
  app already plays is recorded, so encrypted calls (never voiced) are never recorded. Settings lists, downloads
  and deletes them. Tests prove: two transmissions 3 s apart → two calls of the right length; a gap under the hang
  time stays one call; a talkgroup change splits at once; blips dropped; flush and long-call splitting; WAV format,
  INFO tags and samples round-trip. Browser check (Chromium): AUDIO IN fed a two-burst WAV into the Audio app →
  two WAVs in OPFS, ~2.5 s each, tagged with app, frequency and mode, listed in Settings.
  Hardware: Dispatch on a P25 or DMR system near you (HackRF / H4M in HackRF mode, a 700/800 MHz or UHF antenna)
  with VOICE RECORDING on: each call should become its own WAV named with its talkgroup and unit; open one in an
  audio player and check the tags (title, comment).
- **Phase 6 · EDACS decoder** (`web/src/dsp/fleet/edacs.ts`, `test/edacs.test.ts`): standard and networked control
  channel, receive only. Sync 0x555557125555, two 40-bit messages × 3 copies (middle inverted), soft-voted, then a
  BCH(40,28) check built from its definition (GF(64) on x^6+x+1, g = m1·m3). Messages per TSB-69.3: group voice
  assignment (analog / ProVoice, emergency, message vs transmission trunking), channel updates, individual and
  interconnect calls, data calls, login, status / ack, system-assigned ID, unkey / drop, adjacent site, site ID,
  system all-call; LCNs 26+ reported as queued / busy / denied; optional ESK mask. ProVoice is identified, never
  voiced. Receiver: 9600 bd (wideband) or 4800 bd (narrowband), either polarity. Tests prove: g(x) equals the
  textbook BCH(63,51) generator (octal 12471) and divides x^63+1; every 1-4 bit error is detected; the vote fixes
  an error in any one copy and two bad copies fail; every layout parses; frames decode from FSK at 18 dB SNR in
  both polarities at 9600 and 4800 bd; noise finds nothing. Not yet verified on a real EDACS capture: the bit order
  of the check (data high, parity low) follows DSD-FME's working decoder. Still to do: wiring into Dispatch (it
  needs a 25 kHz channel for 9600 bd, wider than Dispatch's 24 kHz / 5.5 kHz channels, and a per-system LCN →
  frequency plan, which EDACS does not broadcast). EA (extended addressing) is not implemented.
- **Phase 6 · plug-in hook + EDACS in Dispatch** (`dsp/fleet/plugins.ts`, `edacs-plugin.ts`, `trunk-ui.ts`,
  `test/edacs.dispatch.test.ts`): a small control-channel plug-in interface in Dispatch (agreed 2026-11-26), so EDACS,
  MPT1327 and LTR live in their own files. Every Dispatch channel runs each plug-in's receiver (EDACS on its own
  25 kHz / 48 kS/s down-converter); a carrier becomes the protocol's control channel after 3 good frames; events
  become systems, sites, calls, units and log rows through Dispatch's own paths; analog calls are followed and voiced
  by its FM voice path. ProVoice calls are granted with a codec nothing decodes (`provoice`): listed ("identified,
  not voiced"), never followed or voiced. Settings → TRUNKING PLANS: one site per line, frequencies in LCN order; a
  plan is used only once the site's control channel is heard where the plan puts the LCN its Site ID announces.
  Also fixed: a recording that cannot follow an app's tune now tells the worker its real centre, so decoders that
  name absolute frequencies (Dispatch) are right while Dispatch scans its own bands.
  Tests prove (Dispatch's real engine on synthetic IQ, simulated time): the control channel is found and classed;
  the site is identified; the typed plan is proved; an analog group call lands on LCN 3 = 852.0125 MHz with FM voice,
  a ProVoice call on LCN 2 with the `provoice` codec; the unit is known. Browser check (Chromium): plan typed in
  Settings, the recording played in Dispatch → "EDACS · SITE 21", TG 1234 (unit 4242, 852.0125 MHz, LCN 3), TG 777
  "ProVoice digital voice: identified, not voiced". Limitation: while a recording plays, Dispatch's dial and waterfall
  labels still show the band it is scanning, not the recording's; the decoded frequencies are right.
  Hardware: an EDACS site near you (RadioReference lists the frequencies in LCN order): put them in Settings →
  TRUNKING PLANS, open Dispatch with a HackRF (or H4M in HackRF mode) and an 800 MHz antenna. The control channel
  should become "EDACS · SITE n", calls should appear with talkgroup, LID and frequency, analog calls should be heard,
  ProVoice ones listed only.
- **Phase 6 · MPT1327** (`dsp/fleet/mpt1327.ts`, `mpt1327-plugin.ts`, `test/mpt1327*.test.ts`): 1200 bit/s FFSK
  (1200 Hz = 1, 1800 Hz = 0) on the channel's own 24 kS/s baseband: sliding single-bin DFTs at both tones over one
  bit, a bit clock on their difference, REVS+SYNC (0xC4D7; French 0xB433) in either polarity, the 64-bit address
  codeword checked (15-bit check from its generator with the last bit inverted, even parity; one bit corrected), and
  the system identity from the CCSC ahead of the sync, believed once seen twice running (its own check is not in the
  reference). Messages: GTC (calls; data calls logged, not voiced), ALOHA family, ACK, AHOY, MAINT, CLEAR, MOVE,
  BCAST. Channel plans gain a linear form for band plans: `MPT1327 <name>: ch0=<MHz> step=<kHz>`, proved by the
  control channel sitting on the grid. Tests prove: the derived check table equals SDRTrunk's published entries;
  parity and single-error correction; message layouts; slots decode from FM at 15 and 9 dB SNR in either slicer
  polarity with the CCSC identity; noise finds nothing; Dispatch's real engine finds and classes the control
  channel, reads SYS 2A5B, proves the linear plan and lists a GTC on channel 52 = 169.6375 MHz with FM voice.
  Browser check (Chromium): the same as a recording in Dispatch with the plan typed in Settings. Found and fixed on
  the way: MOVE's channel field overlaps IDENT1, so no identity is read from a MOVE; a system announced once could be
  lost before Dispatch accepted the carrier, so the identity is now sent with every codeword that carries it.
  Not confirmed on air: the CCSC layout (SYS in bits 2-16, REVS + SYNC as its last 32 bits) follows SDRTrunk's framing;
  group vs individual addresses are not told apart (the fleet plan decides), so calls are shown by IDENT.
  Hardware: an MPT1327 system (taxi, utility or public-transport fleets in Europe / Asia / Australia; VHF or UHF): put
  its band plan in Settings → TRUNKING PLANS, open Dispatch with a HackRF (or H4M in HackRF mode). The control channel
  should become "MPT1327 · SYS xxxx", calls should list with IDENT and frequency, analog voice should be heard.
- **Phase 6 · LTR / LTR Passport** (`dsp/fleet/ltr.ts`, `ltr-plugin.ts`, `test/ltr*.test.ts`): no control channel; every
  repeater sends 300 bit/s sub-audible NRZ data under its own voice. Receiver on the channel's 24 kS/s baseband: FM
  discriminator averaged to ~2400 S/s, two bit-long moving averages (matched filter; first null at 300 Hz keeps voice
  out), sliced at the middle of the recent highs and lows (absorbs the carrier's frequency offset), a bit clock on the
  crossings, sync 101011000 in either polarity, then the 40-bit LTR word and the 68-bit Passport word behind it checked.
  The checks are built from their generators: LTR = a 6-bit shift register (feedback from its top two stages) + even
  parity; Passport = CRC-7 x^7+x^3+1 + even parity. No correction (7-8 check bits leave none to spare). One plug-in
  serves both: each busy repeater becomes a site, learns its own LCN as the channel its calls name most (go-to words for
  other repeaters do not move it), a call on its own LCN is placed on the carrier itself (plan or not) and its FM voice
  followed there. LTR Standard sends no system identity, so the proved plan names the system (else the frequency);
  Passport's site number does. Groups are A-HH-GGG, listed as A·100000 + HH·1000 + GGG (0-03-045 → 3045); LTR Standard
  sends no unit IDs. Dispatch change (FORK): a plug-in call with FM voice turns the voice on at grant time even when its
  channel is already open (it is, for LTR); a system event may carry `planned` and `site`.
  Tests prove: both derived tables equal SDRTrunk's published ones; word layouts and kinds; a flipped bit fails;
  LTR words decode under a 2.5 kHz voice tone at 10 dB, with a 1.8 kHz carrier offset, in either polarity (at most the
  first two words of a keyup go to settling); Passport words decode; noise and voice alone decode nothing; the plug-in
  learns its LCN, treats repeats as updates and ends the right call; Dispatch's real engine classes a busy repeater,
  proves the plan by its LCN, lists the call on 461.0375 MHz and follows over a second of its voice; without a plan the
  call still sits on the repeater. Browser check (Chromium): a recording in Dispatch plays "LTR · Shop net", TG 3045,
  REPEATER 3, 461.0375 MHz with voice.
  Not confirmed on air: that a busy repeater names itself most often (the LTR scheme says so); Passport's channel-number
  to frequency rule (its band field is logged, not used: a plan gives the frequencies); idle repeaters send nothing, so
  only repeaters that carry a call while Dispatch is looking are found.
  Hardware: an LTR or Passport system (business / utility trunking, often 450-470 MHz or 800/900 MHz) with an RTL-SDR or
  HackRF. Put the site's repeaters in Settings → TRUNKING PLANS in LCN order (`LTR <name>: <MHz> <MHz> …`, RadioReference
  lists them), open Dispatch. As repeaters key up, each should show as "REPEATER n" under "LTR · <name>", calls should list
  by group with their frequency, and the voice should be heard.
- **Phase 6 · DMR Tier III vendors** (`dsp/fleet/csbk-vendor.ts`, `test/dmr-vendor.test.ts`): the CSBKs of Motorola
  Connect Plus (feature set 0x06) and Hytera (0x68) parsed into the kinds Dispatch already acts on, so no new call logic:
  CON+ VOICE CHANNEL USER is a grant (logical slot → LCN and slot as SDRTrunk reads it: LSN = field - 1, LCN =
  (LSN-1)/2+1, slot = (LSN-1) mod 2), which lists the call and lets Dispatch learn the granted repeater's carrier from the
  voice header that follows; TALKGROUP AFFILIATION puts the radio in the group; REGISTRATION, DATA CHANNEL GRANT and
  TERMINATE touch the unit; NEIGHBOR REPORT lists site numbers. Hytera ALOHA (the ETSI layout) and ANNOUNCEMENT carry the
  system identity code; the XPT PREAMBLE names caller, group or radio and the free repeater; XPT SITE STATE gives the free
  repeater and the repeater states. The system is labelled CONNECT PLUS / HYTERA XPT. Upstream touch points (FORK): one
  line in `csbk.ts` hands those feature sets to the new module and a `trunk` field on `Csbk`; in `fleet.ts` the vendor
  trunk is taken onto the system, two new kinds handled (affiliation, XPT preamble) and the system label extended.
  Hytera group/unit voice LCs (FLCO 0/3 under 0x68) were already read upstream.
  Tests prove: CRC'd blocks of each kind parse to the right fields; other feature sets are left alone; Dispatch's real
  engine, fed a Connect Plus control channel (4FSK) and a second repeater sending the granted call's voice headers on
  TS2, classes the control channel, labels the system CONNECT PLUS · COLOR CODE 1 and lists TG 4321 from 1234567 on the
  repeater's frequency, TS2. Browser check (Chromium): the same from a recording, the affiliation counted as a unit.
  Not done (new row above): the short LC in the CACH, which carries Connect Plus's network and site (so a Connect Plus
  system is keyed by its color code for now) and XPT's free repeater; Hytera's full-LC XPT channel grant. Not confirmed
  on air: SDRTrunk's LSN offset (it says it was found on air); which XPT repeater numbers are which frequencies (calls
  are still placed by the voice LC heard on each repeater, as upstream did).
  Hardware: a Connect Plus or Hytera XPT site (business / utility DMR, often UHF 450-470 MHz) with an RTL-SDR or HackRF,
  Dispatch on the band. A Connect Plus control channel should be labelled CONNECT PLUS · COLOR CODE n, grants should list
  with talkgroup and source, and after a few calls each LCN should show its repeater's frequency; Hytera XPT repeaters
  should be labelled HYTERA XPT with preamble callers listed as units.
- **Phase 6 · DMR short LC** (`dsp/fleet/slc.ts`, tests in `test/dmr-vendor.test.ts`): the 24-bit CACH at the head of
  every base-station burst: TACT checked by its Hamming(7,4) (Hytera XPT's flipped access-type bit accepted), the four
  17-bit fragments put together by their LCSS (first, continuation, continuation, last; a single fragment carries no
  check and is not read), de-interleaved (17 mod 67), each Hamming(17,12) row corrected (the code built from its
  generator x^5+x^2+1), the column-parity row checked (one column off = a bad parity bit), then the CRC-8
  (x^8+x^2+x+1). Read: Connect Plus control / traffic channel (network, site), Hytera XPT channel (free repeater,
  priority call), control / traffic system parameters, Capacity Plus rest channel; anything else is logged.
  On a carrier already classed DMR: Connect Plus puts its network on the system (label CONNECT PLUS NETWORK n) and its
  site on the site row (site n); XPT marks the system HYTERA XPT. Upstream touch points (FORK): `rx.ts` DmrFramer gains
  `onCach` (one line where each burst is emitted); `fleet.ts` wires it in `open()`, a FORK block reads it, and the DMR
  site label prefers the short LC's site.
  Tests prove: the derived Hamming table equals SDRTrunk's; round trip; one bad bit in any fragment corrected (rows and
  parity row); a burst of bad bits rejected, not miscorrected; a missing fragment yields nothing and the next whole
  message still decodes; XPT with the scrambled TACT; Dispatch's real engine labels a Connect Plus control channel
  CONNECT PLUS NETWORK 5, site 12. Browser check (Chromium): the system and call card read CONNECT PLUS NETWORK 5.
  Seen on the way (upstream, not changed): a traffic repeater's voice header heard before Dispatch has mapped its
  logical channel makes a short-lived call with no system beside the granted one.
  Hardware: as for Connect Plus / XPT above. A Connect Plus control channel should become CONNECT PLUS NETWORK n with its
  site number; the log should show SHORT LC rows on Connect Plus and XPT repeaters.
- **Phase 6 · two-tone paging named** (`dsp/twotone.ts`, `test/twotone.test.ts`): upstream's analog reader
  (`hamid/analog.ts`) already found a page (tone A ≥ 350 ms then tone B ≥ 600 ms) and printed its two frequencies. Now
  each page is matched (within 1.2 %) against the Motorola Quick Call II reed table (80 tones, groups 1-6, 10, 11) and
  GE Type 99 (groups A-C), and named the way a dispatch card reads: reed codes (114/127), the 3-digit cap code where
  Motorola's general encoding plan gives one (groups 1-5), and the call kind from the timing (individual A 1 s + B 3 s,
  tone only, battery save). A single tone held 6 s or more on a reed is the Quick Call II group call. GE Type 99 vs a
  Quick Call II page in the range where both tables have tones close together: GE's timing (A 1 s + B 1.5 s) decides.
  Upstream touch points (FORK, `hamid/analog.ts`): the import, `TwoTone.id`, the id filled where a page is found, the
  long-tone group call after it, and the summary line. Shown wherever upstream shows analog signaling: Ham Radio's
  identity panel (any frequency the radio tunes, so a fire / EMS paging channel works) and Ham Plus.
  Tables: Midian Electronics' chart; its Quick Call II table equals the PGHscanner (qsl.net/k3fs) one except reed 109
  (313.0 vs 313.8 Hz): both are matched. Tests prove: every cap code of the plan (11 × 100, same-tone pairs aside) comes
  back from its own tones 0.8 % off; reed codes; call kinds by timing; reed 109 either way; off-table tones give
  nothing; the group call; GE codes; GE vs QC-II by timing; end to end through upstream's analog reader on synthetic
  squelched audio: an individual page reads "2-tone page … Motorola QC-II individual call cap code 347 (reeds
  114/127)", an 8 s tone the group call, a GE page its code, and speech nothing.
  Not done: GE Star (a digital ANI with no published description found; new row). No browser check (the text is an
  existing line in an existing panel).
  Hardware: a fire / EMS dispatch channel that pages by two-tone (often VHF high band 150-160 MHz) with an RTL-SDR or
  HackRF in Ham Radio, tuned to it in FM. A page should list as "2-tone page A and B Hz, Motorola QC-II individual call
  cap code nnn (reeds xxx/yyy)"; compare with the department's tone-out list (RadioReference often has it).
- **Phase 6 · alias import** (`src/aliases.ts`, `src/aliases-ui.ts`, `test/aliases.test.ts`): Settings → ALIASES imports
  talkgroup and unit names: RadioReference talkgroup CSV (read by its header: Decimal, Alpha Tag or Description, Mode E
  noted as encrypted, Tag, Category; quoted commas; LTR A-HH-GGG ids), OP25 tag files (id, tab, name; the import says
  whether the file is talkgroups or radio IDs), SDRTrunk playlist XML (alias name, talkgroup / radio ids and ranges,
  protocol mapped, LTR ids converted to Dispatch's A·100000 + HH·1000 + GGG). Each list applies to every system or to
  one protocol (a scoped list wins); several lists, each removable; kept in localStorage. Dispatch shows the name on
  the on-air card and call rows ("TG 4321 · FD Main"), the talkgroup tile (name, then TG number), grant rows, the
  talkgroup and unit detail cards, and in voice recordings' labels. Upstream touch points (FORK, `main.ts`): imports,
  the Settings section and its jump entry, `dispatchWho` and a `flAlias` helper, the tile, grant row, the two detail
  heads and the voice label.
  Tests prove: each format parses (made-up names in each layout), bad lines are counted and skipped, ids in decimal,
  hex and A-HH-GGG, scoping (a P25 list over an ALL list; other protocols fall back; unit vs talkgroup kept apart).
  Browser check (Chromium): a RadioReference CSV scoped to DMR and an OP25 radio-ID file imported in Settings; the
  Connect Plus recording in Dispatch shows "TG 4321 · FD Main" on the call card and "FD Main" on its tile.
  Hardware: none needed; with any system Dispatch hears, import its RadioReference talkgroup CSV (Database → the
  system → talkgroups → download), scoped to its protocol, and the talkgroups should read by name.
- **Phase 6 · Hytera XPT channel grant** (`parseXptGrant` in `dsp/fleet/csbk-vendor.ts`, tests in
  `test/dmr-vendor.test.ts`): the full LC with opcode 9 under Hytera's feature set (repeater 4 bits, talkgroup, caller),
  checked by the LC's Reed-Solomon(12,9), which upstream's `parseLc` dropped (it reads opcodes 0 and 3 only). Logged
  always; on a carrier already in a DMR system it marks the system HYTERA XPT, lists a grant with the repeater number as
  its logical channel, and lets Dispatch learn that repeater's carrier from the voice header that follows there (as for
  DMR logical channels). The grant does not carry a time slot: it is listed on the slot it was heard on and matched to
  a voice header on either. Upstream touch points (FORK, `fleet.ts`): an import, one line after `parseLc` in
  `dmrBurst`, and `xptGrant` in a FORK block.
  Tests prove: fields; a corrupted LC fails its check; a plain Hytera group voice LC is not taken for a grant;
  Dispatch's real engine, with repeater A sending an XPT site state and grants to repeater 2 and repeater 2 carrying
  TG 601's voice headers, maps repeater 2 to its carrier and lists TG 601 from 1201 in the HYTERA XPT system.
  Not confirmed on air: the time slot of the call a grant sends to (taken from the burst it came in); an XPT repeater
  whose carrier sent no CSBK has no system yet, so its grants are only logged.
  Hardware: as for Hytera XPT above; after a few calls the system's logical channels should list repeater numbers with
  their frequencies.
- **Phase 6 · GE Star: blocked on license** (searched 2026-11-26). What is public: vendor sheets (Midian CAD-400 /
  CAD-MF, Cimarron CIM-1000 / CIM-2200, C Plus I) give the physical layer only: PSK at 400 bit/s on a 1600 Hz (±1.5 %)
  carrier, unit IDs of 11 to 14 bits (to 16383), about 320 ms per ANI. No sync word, field layout or check is published.
  The only source with the frame is Matthew Kaufman's STAR library, licensed GPL-2.0-only, which rule 4 excludes (and
  writing a decoder from it would be a port, not an implementation from a spec). Not implemented. Ways forward: the
  author offers other license terms (matthew@eeph.com); or a published spec / a redistributable recording with known IDs
  to work the layout out from.
- **Phase 1 · Analyzer protocol library** (`src/dsp/analyzer/library.ts`, `test/analyzer-library.test.ts`): upstream
  shared protocols only inside a session file (binary, with every captured burst). Now the PROTOCOLS panel has EXPORT
  PROTOCOLS: a small JSON file (format `mad-mobile.analyzer-protocols`, version 1) of the saved protocols alone; IMPORT
  reads it back (also a bare array, or any JSON with a `protocols` array). Imported files are untrusted: every protocol is
  checked field by field (sync bits, modulation, coding, symbol time, up to 64 fields with known kinds and ordered
  bounds, the checksum's kind and numbers) and rebuilt from checked values only; malformed ones are skipped and counted.
  Merge: an identical protocol is skipped, a taken name gets "(2)". Upstream touch points (FORK, `analyzer-ui.ts`): the
  import, `.json` on the file input, one line in the IMPORT handler, the EXPORT PROTOCOLS button and its case, and
  `exportLibrary` / `importLibrary` in a FORK block.
  Tests prove: round trip; bare-array and session-JSON forms; eleven kinds of malformed entry skipped; extra keys
  (`__proto__`, handlers) dropped without polluting objects; merge counts and renaming; an imported protocol recognizes
  a frame with its sync word and not one of another modulation. Browser check (Chromium): IMPORT in the Analyzer saves
  two protocols to IndexedDB, reports one unreadable, an HTML-laden name stays text, no page errors.
  Hardware: none needed. Save a protocol from a remote in the Analyzer, EXPORT PROTOCOLS, clear the browser's data (or
  use another browser), IMPORT the file: the remote's next press should be recognized by name.
- **Phase 2 · NOAA 15/18/19 retired** (`sat.ts`, `main.ts`, `test/sat-retired.test.ts`): upstream already called them
  retired in their notes. They are still in orbit, so CelesTrak still gives their TLEs and the app listed passes as for
  a working satellite. Now `SatDef.retired` holds NOAA OSPO's decommissioning dates (NOAA-18 6 Jun 2025, NOAA-19 13 Aug
  2025, NOAA-15 19 Aug 2025); their tiles are dimmed and read RETIRED (the date on hover), and choosing one says
  "Decommissioned … · no longer transmitting · tuned so you can confirm the silence" with no pass list. They stay in the
  list and still tune 137.62 / 137.9125 / 137.10 MHz. Upstream touch points (FORK): `sat.ts` (the field, `retiredText`,
  the three dates), `main.ts` (import, tile, the info panel's early return). Tests prove the dates and that Meteor and
  the amateur satellites are not marked. Browser check (Chromium): the NOAA 19 tile is dimmed with RETIRED, the panel
  shows the message and no passes, Meteor M2-3 is unchanged, no page errors.
- **Phase 2 · full Mode-S** (`src/dsp/modes.ts`, `test/modes.test.ts`): upstream read DF17/18 with an exact CRC only.
  Now every downlink format, short (56-bit) frames included: DF17/18 with one-bit repair, two-bit repair for an aircraft
  already heard; DF11 all-call with the interrogator code (II / SI) in its parity, one-bit repair when that code is 0
  and the address is known; DF0/4/5/16/20/21 by address / parity (the syndrome is the address), taken only for an
  aircraft heard in the last minute. Fields: altitude (25 ft, and the Gillham 100 ft code), squawk, flight status
  (alert, SPI, on the ground), and the DF20/21 Comm-B register inferred among BDS 1,0 / 2,0 / 4,0 / 5,0 / 6,0 from fixed
  bits, status bits and ranges, named only when exactly one fits (pyModeS's approach). An aircraft never heard on ADS-B
  is marked Mode-S only; with no ADS-B, BDS 5,0's track and ground speed stand in. The CRC (generator 0x1FFF409), the
  syndrome tables and the Gillham code are built here. Flights' aircraft card gains SQUAWK (7500 / 7600 / 7700 named,
  changed, IDENT, on the ground), SELECTED ALT (with QNH) and AIR DATA (heading, IAS, TAS, Mach, roll), and says
  "Mode-S only" where a position would be. Raw frames of every format go to the export bus (Beast takes 7 and 14 bytes).
  Upstream touch points (FORK, `adsb.ts`): the import, the `Aircraft` fields, the frame loop (short frames, the checks),
  the log line's per-DF counts, `es` on ADS-B, the merge of the new fields, `modeSApply` in a FORK block,
  `CRC_TABLE` exported (its `checksum()` replaced by modes.ts); `main.ts`: the card's three rows and its position text.
  Tests prove: the derived syndromes equal upstream's per-bit table; a public DF17 frame (KLM1023, 4840D6) is clean;
  every one-bit error (bits 5-111) repaired back to the frame; a two-bit error repaired only for a known address; DF11
  with interrogator codes 0-127 and rejected otherwise; address / parity gated on a known address; 25 ft altitude; every
  Gillham 100 ft step from -1000 to 62 700 ft decoded by exactly one code; squawks; each Comm-B register and an empty one;
  end to end through upstream's decoder on 2 Msps pulse-position IQ (callsign, DF4 altitude, DF5 7700, DF20 BDS 4,0,
  a Mode-S only aircraft from DF11 + DF5); noise makes no aircraft. Browser check (Chromium): a recording in Flights
  shows both aircraft and the card rows (7700 · EMERGENCY, 36 000 ft · QNH 1013.2, HDG 90° · IAS 250 kt · M0.60,
  "Mode-S only" for the other), no page errors.
  Not done: Comm-B registers beyond the five (BDS 1,7 capability, 3,0 ACAS, 4,4/4,5 meteo); BDS 5,0 vs 6,0 ambiguity is
  left unnamed rather than settled against ADS-B as pyModeS can.
  Hardware: Flights at 1090 MHz with an RTL-SDR or HackRF (2 Msps), near an airport with Mode-S radar coverage: the log's
  "by DF" counts should show 4, 5, 11, 20 and 21 as well as 17; aircraft cards should gain squawks, and under en-route
  radar (EHS airspace, e.g. most of Europe) selected altitude and air data.
- **Phase 2 · Mode A/C replies** (`src/dsp/modeac.ts`, `test/modeac.test.ts`): written from ICAO Annex 10 Vol IV (pulse
  positions; dump1090-fa's mode_ac.c, GPL-2.0-or-later, was the reference named here and not needed). On the same 2 Msps
  magnitudes Flights already has: F1, 13 slots on a 1.45 µs grid and F2 at 20.3 µs, each slot read at its own time (the
  larger of the two samples around it), set when over half the framing pulses; F1 and F2 at least 12 dB over the mean
  and within 6 dB of each other, the X slot empty, nothing just before F1, SPI read. Spans read as Mode-S are skipped.
  A code becomes a track after three replies within 10 s and drops after a minute of silence. Each code is read both
  ways (squawk; Mode C Gillham altitude when D1 is clear) and tied to a Mode-S aircraft reporting that squawk or an
  altitude within 200 ft. Flights' header counts MODE A/C and a caption under the list shows the codes no Mode-S
  aircraft accounts for ("1200 (or … ft) ×12") and how many were matched. Upstream touch points (FORK): `adsb.ts` (import,
  detector and tracks, the Mode-S spans, the scan after the frame loop, the `modeac` message in `publish` and `clear`),
  `main.ts` (the message, the header count, the caption element and its text, CLEAR).
  Tests prove: squawk reading; every 100 ft step -1000..62 700 ft is exactly one Mode C code, D1 set is no altitude;
  32 replies of 8 codes at offsets of 0, ¼, ½ and ¾ sample with noise all decoded, SPI included; X set rejected; 0.1 s
  of noise gives nothing; tracks need three replies, associate by squawk and by altitude, expire; end to end through
  the ADS-B decoder among Mode-S frames (7700 tied to the aircraft squawking it, 1200 on its own). Browser check
  (Chromium): a recording with both shows "2 MODE A/C", both matched (7700 → KLM1023, 1200 → the Mode-S only aircraft).
  Not confirmed on air: real replies' pulse shapes at 2 Msps (0.45 µs pulses are under one sample; a receiver's filter
  spreads them, which the "larger of two samples" read allows for); garbling from overlapping replies is not resolved.
  Hardware: Flights at 1090 MHz, 2 Msps, within reach of an SSR radar (most airports): MODE A/C should appear in the
  header; general-aviation squawks such as 1200 / 7000 / 2000 with no Mode-S aircraft should be listed on their own.
- **Phase 2 · BLE: AUTO, extended advertising, PHY** (`src/dsp/ble-ext.ts`, `test/ble-ext.test.ts`): written from
  Bluetooth Core 5.x Vol 6 (no code used). AUTO steps the receiver through channels 37 → 38 → 39, 1.5 s each, until a
  channel is picked or the app is left. The receiver reads BLE 5's full 8-bit length and accepts ADV_EXT_IND (type 7,
  1-255 bytes; legacy PDUs stay 6-37), its buffer grown to 260 bytes. The Common Extended Advertising header is read:
  AdvMode, AdvA, TargetA, CTEInfo, ADI (set and data IDs), AuxPtr (secondary channel, clock accuracy, offset in µs, the
  PHY the data goes on), SyncInfo, TX power, then any AD data. The packet log gives it a line; a device card keys it by
  AdvA (or "ANON SET n") and shows an Extended advertising row; every packet carries the PHY it was heard on (1M on the
  primary channels) into the card and the export bus. Upstream touch points (FORK): `btle.ts` (import, PDU names,
  buffer, length rule, the ADV_EXT_IND report, `phy` on `ble`), `ble.ts` (import, PDU names, `BleAdv.phy/ext`,
  `parseAdv`'s `phy` and type 7, the AD loop moved into `readAd`, the card rows), `main.ts` (AUTO chip on both control
  rows, `setBtleAuto`, `phy` passed), `export/event.ts` (`phy` in `ble.adv`).
  Tests prove: every header field (2M and Coded AuxPtr, 30 and 300 µs units, anonymous); a header claiming too much is
  refused; ADV_EXT_IND through the GFSK receiver, and one of 83 bytes (past the old 48); the device record (AdvA,
  anonymous set, AD name, PHY); legacy PDUs unchanged and over-long legacy ones still refused. Browser check (Chromium):
  AUTO steps 38 → 39 → 37 → 38, picking 39 stops it, no page errors.
  Not done: the auxiliary packets (AUX_ADV_IND on data channels 0-36, often on 2M) are not followed; LE Coded PHY (own
  row).
  Hardware: Bluetooth app with a HackRF (2 Msps), AUTO on, near phones and BLE 5 devices (recent phones, Find My / Find
  Hub trackers, smart watches): ADV_EXT_IND lines should appear with their set and aux channel, and device cards gain an
  Extended advertising row.
- **Phase 2 · tracker alert: owner state** (`src/ble-dult.ts`, `test/ble-dult.test.ts`): upstream already alerted on a
  tracker heard for 20 minutes or after you moved 500 m with it, for every tracker kind, so a friend's AirTag travelling
  with its owner raised the same alarm as one following you. The IETF DULT draft (draft-ietf-dult-accessory-protocol-01)
  has the accessory say whether it is with its owner. Now each tracker's own word is read: DULT service data 0xFCB2
  (Network ID, then the near-owner bit, LSB); Find My's payload length (the long, full-key payload when away from its
  owner); Find Hub's frame 0x41 (unwanted-tracking protection on). A tracker that says it is near its owner never alerts;
  one that says it is separated alerts with "· SEPARATED FROM ITS OWNER"; one that says nothing (Tile, SmartTag) is judged
  by time and distance as before. DULT-only accessories are a new tracker kind, and every tracker card gains an Owner
  row. A separated DULT accessory keeps one address for 24 hours (15 minutes near its owner), so the per-address record
  holds for a whole encounter. Upstream touch points (FORK, `ble.ts`): the import, the `dult` kind (union, label,
  tracker kinds, classify), `BleDevice.owner`, the state taken in `add`, `trackerAlert`'s two rules, the Owner row.
  Tests prove: each state reading; with its owner (Find My short, DULT bit 1) no alert after 40 min and 2 km; separated
  Find My after 25 min and separated DULT after 1 km alert with the suffix; Tile alerts at 25 min and not at 10; the DULT
  kind, owner and card row.
  Not done: the draft's platform detection guidance is still a TODO in it, so the time / distance thresholds stay
  upstream's (20 min, 500 m); trackers that rotate addresses near their owner are not linked across addresses (not
  needed: those do not alert).
  Hardware: Bluetooth app (AUTO on) while carrying, or travelling near, an AirTag: with its owner's phone nearby its card
  should read "with its owner … not following you" and stay quiet; one left separated from its owner for a while
  should read "separated" and alert after 20 minutes or 500 m.
- **Phase 3 · Remote ID over Bluetooth** (`src/dsp/remoteid.ts`, `test/remoteid.test.ts`): ASTM F3411 / ASD-STAN EN
  4709-002 messages, the layouts as opendroneid-core-c (Apache-2.0) encodes them, written from those definitions. The
  Bluetooth app reads service data 0xFFFA (application code 0x0D, counter, one 25-byte message, or a Message Pack):
  Basic ID (ID type, UA type, UAS ID), Location (status, direction, horizontal speed with its multiplier, vertical speed,
  latitude / longitude, pressure and geodetic altitude, height and its reference, accuracies, time past the hour),
  Authentication (noted), Self-ID, System (operator position and how it is known, area, EU category and class,
  operator altitude), Operator ID; values the standard marks unknown are left out. Bluetooth 4 sends one message per
  advertisement, so each drone's card puts its messages together. Drones are their own kind ("Drone (Remote ID)", not a
  tracker); a map appears over the cards once a drone has a position: the drone (pointing its way, with its height),
  its operator, and a line between them. Upstream touch points (FORK): `ble.ts` (import, the `drone` kind and label,
  classify, `BleDevice.rid`, the messages read in `add`, the card rows), `main.ts` (the map element, the map, the drone
  and operator markers and lines in `refreshBle`).
  Tests prove: each message read back (both speed ranges, the heading past 180°, altitudes, accuracies, time, EU class);
  unknown values left out; a bad pack and a foreign application code read nothing; a Message Pack; four advertisements
  make one drone card with every field; a Remote ID advertisement through the BLE receiver over GFSK. Browser check
  (Chromium): a recording in the Bluetooth app gives the drone card, the map with the drone and its operator joined by
  a line, no page errors.
  Not done (rows above): Bluetooth 5 long range (the drone's AUX packets on LE Coded), Wi-Fi beacon / NAN.
  Hardware: Bluetooth app with a HackRF, AUTO on, near a drone that broadcasts Remote ID (most DJI and other drones sold
  since 2023 in the US and EU broadcast it over Bluetooth 4 and Wi-Fi): a "Drone (Remote ID)" card with its serial number
  and position, and the map with the drone and its pilot.
- **Phase 3 · DJI DroneID** (`src/dsp/droneid.ts`, `src/dsp/lte-turbo.ts`, `test/droneid.test.ts`): a new Drones app
  (HackRF, 2.4 GHz, 15.36 MS/s; APP_NEEDS keeps it off an RTL-SDR). The burst structure and frame layout after
  proto17/dji_droneid (MIT): nine OFDM symbols on a 1024-point FFT, 600 carriers around DC, CPs 80 / 72 / … / 80,
  Zadoff-Chu symbols 4 and 6 (roots 600, 147), symbol 1 the bare scrambler, six data symbols of QPSK scrambled by the
  LTE Gold sequence (c_init 0x12345678), an LTE turbo code (K = 1408) rate-matched to 7200 bits, CRC-24A, and the frame
  (serial, drone / pilot / home positions in radians × 1e7, height, altitude, velocities, yaw, app time, product type,
  UUID, CRC-16). Written here: the LTE turbo code from TS 36.212 (QPP interleaver, encoder with trellis termination,
  sub-block interleaving and circular-buffer rate matching, max-log-MAP decoder, 8 iterations; the K = 1408 QPP row
  f1 = 43, f2 = 88 checked against turbofec), the Gold sequence from TS 36.211, and the receiver: a 3 dB energy trigger
  on 256-sample blocks, timing by FFT correlation with symbol 4, the frequency offset from all nine cyclic prefixes
  plus a whole-carrier search on symbol 4, the channel from both Zadoff-Chu symbols (smoothed over 9 carriers,
  interpolated across the burst), channel-weighted soft QPSK, descrambling, de-matching, decoding, CRC-24A. The app:
  the four known channels and AUTO (1.5 s each), one card per serial number (drone, pilot and home positions, height,
  altitude, velocities, yaw as sent, sequence, the measured frequency offset, the frame CRC), and a map with the drone,
  its pilot (joined by a line) and its home point. Upstream touch points (FORK): `main.ts` (AppId, APPS, open, render,
  worker messages, EMPTY, CLEAR, the import, the Drones view in a FORK block), `radio.ts` (APP_NEEDS),
  `dsp.worker.ts` (import, processor, makeProcessor).
  Tests prove: CRC-24A's catalogue check value 0xCDE703; QPP(1408) a permutation with its first values; turbo +
  rate matching round trip clean and at -1 dB; the frame CRC equals the reference's table (entries 1, 128, 255) and
  initial value; the frame layout round trips; whole bursts decode at 25, 15, 8, 4 and 1 dB with frequency offsets of
  0 to 40 kHz and fractional timing, the offset measured within 500 Hz; noise gives no bursts; a burst at -9 dB is seen
  but gives no frame; the processor warns at the wrong rate. Browser check (Chromium): a recording in Drones gives
  "1 DRONE · 3 FRAMES DECODED · 3 BURSTS SEEN", the card, and the map with drone, pilot and home, no page errors.
  Not confirmed on air: no real DroneID recording was available (the reference does not publish its own, as it holds a
  location); field units for height, altitude, velocity and yaw are not given by the reference, so they are shown as
  sent; newer DJI models encrypt DroneID, and 5.8 GHz is not scanned (new row).
  Hardware: Drones with a HackRF and a 2.4 GHz antenna near a DJI drone that sends DroneID in the clear (Mini 2,
  Mavic Air 2 / 2S and others of that age): bursts should be counted within seconds; with AUTO on, frames should decode
  and the card and map show the drone, its pilot and its home point. Check the drone's position against the pilot app.
- **Phase 3 · analog FPV video** (`src/dsp/fpv.ts`, `test/fpv.test.ts`): a new FPV app (HackRF, 5.8 GHz, 20 MS/s). The
  48 channels of bands A, B, E, F / IRC, R raceband and L lowband (published tables). On a channel: the FM
  discriminator, smoothed over 0.2 µs (video is under 5 MHz); video is told by its line rate, the discriminator
  correlating with itself 16 lines later (NTSC 63.556 µs and PAL 64 µs lines are 7 µs apart over 16, so the standards
  are told apart) well above lags that are no whole line, and with itself one line later (which a tone whose period
  happens to fit does not); the sync polarity from the averaged line's 4.7 µs extreme; the picture cut at each sync's
  leading edge and sampled across the 52.6 µs active line, black at blanking, white at the brightest. The processor
  looks at 20 ms of the channel about every 250 ms (dropping 50 ms after a retune) and sends the picture when watching.
  The app: SCAN steps through all 48 channels (350 ms each) and turns the ones with video gold with their standard; a
  tap watches one, in black and white on a canvas, with the standard, how clearly, the FM swing and the power.
  Upstream touch points (FORK): `main.ts` (AppId, APPS, open, render, worker messages, EMPTY, CLEAR, the import, the FPV
  view in a FORK block), `radio.ts` (APP_NEEDS), `dsp.worker.ts` (import, processor, makeProcessor, `fpvTune`).
  Tests prove: the channel table; NTSC and PAL found and named in either polarity, 300 kHz off centre, at 30, 15 and
  10 dB; the picture's eight bars rising black to white; noise, a 7 kHz FM tone and DJI DroneID OFDM are not video; the
  processor's looks carry the channel and pictures come only when watching. Browser check (Chromium): a PAL recording
  on R1 shows "PAL video · 98 %", R1 gold, and the bars on the canvas (23 … 255), no page errors.
  Not done: colour (the chroma subcarrier is ignored: black and white only); one field per look, not a moving picture;
  digital FPV is the next row.
  Hardware: FPV with a HackRF and a 5.8 GHz antenna near a powered analog FPV transmitter (a quad's VTX, or a goggle
  test pattern): SCAN should turn its channel gold with NTSC or PAL; tap it for the picture. Compare the channel with the
  VTX's band and channel setting.
- **Phase 3 · control links and digital video, by how they look** (`src/dsp/linkprint.ts`, `lookForOfdm` in
  `src/dsp/fpv.ts`, `test/linkprint.test.ts`): nothing is decoded. A short-time spectrum (256 points) finds LoRa packets:
  one tone sweeping linearly, frame after frame, its width the bandwidth and its least-squares slope per run
  (bandwidth² / 2^SF) the spreading factor; a burst counts only when 70 % of its steps follow that slope or wrap, so
  wideband bursts do not pass. Packets of one bandwidth and SF are one link, named after three packets, with its channels
  and the shortest common gap between packets. A link is called "consistent with ExpressLRS" only where its published
  air parameters fit (ExpressLRS GPL-3.0, its air-rate and FHSS tables): 812.5 kHz SF5-8 on the 2.4 GHz grid of 80 channels
  from 2400.4 MHz, or 500 kHz SF5-9 on the FCC915 / EU868 / AU915 grids, the rate from the intervals that SF uses.
  The Drones app runs it on its 2.4 GHz span and shows CONTROL LINKS. Digital video: when an FPV channel is not analog
  video, the FFT autocorrelation over 2^16 samples finds OFDM's cyclic-prefix lag (the useful symbol time, so the carrier
  spacing) and the spectrum its occupied width; the channel turns gold as DIG with those numbers. Upstream touch points
  (FORK): `main.ts` (the `loraBurst` message, the link tracker and CONTROL LINKS line in the Drones view, CLEAR, the FPV
  digital text and DIG chips), the Drones processor in `dsp/droneid.ts` runs the fingerprinter.
  Tests prove: ExpressLRS 2.4 GHz at SF5 / 500 Hz, SF6 / 250 Hz and SF7 / 150 Hz named with their rates; ExpressLRS
  FCC915 at SF7 / 100 Hz; a LoRa link off every grid found but not named; noise, DroneID OFDM bursts and analog FM video
  give no LoRa packets; OFDM with DJI's numerology measured as 15 kHz carriers, 66.7 µs symbols, about 9 MHz; noise is
  not OFDM. Browser check (Chromium): an ExpressLRS-like recording in Drones shows "consistent with ExpressLRS 2.4 GHz ·
  SF6 · 812.5 kHz · 250 Hz"; an OFDM recording on R1 in FPV shows "digital (OFDM) · 11.9 MHz wide · 19.53 kHz carriers ·
  51.2 µs symbols" and R1 DIG; no page errors.
  Not done (new row): naming DJI O3/O4, Walksnail or HDZero, or TBS Crossfire: none publish their air parameters and no
  redistributable recordings were found, so a name would be a guess. FLRC-mode ExpressLRS is not detected.
  Hardware: Drones with a HackRF near a powered ExpressLRS 2.4 GHz receiver and its transmitter (bound, sticks live):
  CONTROL LINKS should name ExpressLRS with the packet rate set in its Lua menu; FPV near a digital FPV system: its
  channel should show DIG with its width and carrier spacing (worth noting down per system for a future fingerprint).
- **HFDL** (`dsp/hfdl/`, `hfdl-ui.ts`, `test/hfdl.test.ts`): bursts at all eight rates (300/600/1200/1800 bps, single
  and double slot) built by the test transmitter round-trip through noise, a frequency error and an unknown phase and
  timing; 300 bps decodes at 3 dB SNR. The same bursts, written to a CF32 file, were decoded by dumphfdl 1.7 built from
  source (all eight rates; squitter, ACARS with good CRC through libacars, performance report, logon), so the scrambler,
  interleaver, code, constellations and sequences match the real thing, not only this decoder. The decoder takes every
  published HFDL frequency in a 2 MS/s span (15 at 8.9 MHz) after one shared band stage; a burst heard on two channels
  is kept once. Browser check: a 2 MS/s recording played through OPEN REC in real time gave both aircraft cards (one
  with its position on the map from a performance report) and both ground stations. Not yet tested against a real
  off-air recording (none redistributable found).
  Hardware: HackRF (or an RTL-SDR in direct sampling / V4) with an outdoor wire, Flight Msgs → HFDL HF, band 8.9 by
  night or 13 / 17 / 21 by day: squitters from ground stations within a few minutes, then aircraft ACARS; compare a few
  messages with dumphfdl on the same recording (Capture it, then run dumphfdl over the .cs8).
- **ADS-C / ARINC 622** (`dsp/arinc622.ts`, hook in `acars-insight.ts`, `test/arinc622.test.ts`): the envelope (ground
  address, IMI, registration, hex payload, CRC-16) and every ADS-C tag libacars reads, downlink and uplink. Messages
  built here were decoded by libacars 2.2 itself (built from source); the tests hold the values it printed (position to
  1e-6°, altitude, time past the hour, track, speeds, flight ID, contract number and reporting interval, meteo, airframe
  ID) and libacars found every CRC good. In Flight Msgs an ADS-C report is kind ADS-C, its position goes on the map and
  its altitude, speed and track on the card (checked in Chromium). CPDLC is only named (connect request, confirm,
  disconnect, message): its body is ASN.1 PER and is the next row.
  Hardware: ADS-C is mostly oceanic and polar, so HFDL (Flight Msgs → HFDL HF) is where to hear it; also VDL2 near
  airports with FANS-equipped long-haul traffic. Look for cards with an ADS-C chip and compare with dumphfdl / dumpvdl2
  on the same recording.
- **CPDLC (FANS-1/A)** (`dsp/cpdlc/`, `scripts/fans/`, `test/cpdlc.test.ts`): the message set's unaligned-PER schema
  (213 types, 183 uplink and 129 downlink elements) was read out of libacars' asn1c tables by a C program that walks the
  descriptors (so constraints, alphabets and CHOICE order are asn1c's own), with libacars' element phrases, labels and
  units; `fans.ts` is generated and `scripts/fans/README.md` says how to regenerate it. A decoder (and a test encoder)
  follow asn1c 0.9.28's PER rules. Messages encoded here were decoded by libacars 2.2 itself to the same values
  (header, timestamp, flight levels, QNH altitude, lat/lon, fix, free text); the tests hold those texts and values.
  In Flight Msgs a CPDLC message is kind CPDLC and its summary is the clearance or request in words (checked in
  Chromium). Not done: positions inside CPDLC position reports are not put on the map.
  Hardware: as for ADS-C (HFDL over oceans, VDL2 near busy long-haul airports): CPDLC cards should read like
  "CPDLC message from NYCODYA #12: CLIMB TO AND MAINTAIN FL360"; compare with dumphfdl / dumpvdl2.
- **Iridium** (`dsp/iridium/`, new app, `test/iridium.test.ts`, `test/fixtures/iridium-prbs15-1622M-2000k.cs8`): bursts
  found in a short-time spectrum across the span and demodulated as gr-iridium does (squared-preamble CFO, RRC 0.4, sync
  word correlation, PLL, unique word, DQPSK). On gr-iridium's own test recording (22 ms cut from test-data/prbs15, GPL)
  the bits match its README's RAW line exactly. Frames built here were read by iridium-toolkit's parser and reassembler
  to the same values (IRA satellite/beam/position/pages, IBC Iridium time in era 3, IDA fragments and CRC, SBD → ACARS
  "N512UA H1 5 HELLO IRIDIUM"); the tests hold them. In Chromium a 2 MS/s recording played in real time gave both
  satellites on the map, the broadcast time and the ACARS line. Load: 5% of a core at 2 MS/s, ~26% at 10 MS/s on noise
  (more with many bursts). Not read on purpose: voice, IP and pager messages (counted only); TMSIs in ring alerts
  (counted only). Not done: Iridium NEXT's new frame formats; ACARS from Iridium is not fed to Flight Msgs yet.
  Hardware: an L-band patch or an active GPS antenna outside with a clear sky (LNA helps); RTL-SDR or HackRF on "Ring
  alerts · 2 MS/s": satellites with positions within a minute; HackRF on "Whole band · 10 MS/s": broadcasts with
  Iridium time and, near aircraft routes, ACARS. Compare with gr-iridium + iridium-toolkit on a Capture of the same span.
- **Navaids** (`dsp/navaid.ts`, new app, `test/navaid.test.ts`): VOR radial from the 30 Hz variable AM against the 30 Hz
  reference FM on 9960 Hz (as Mayhem's proc_vor_rx), within 1° at every bearing tested and through noise; ILS 90/150 Hz
  depths into DDM and SDM (to 0.002); Morse idents on 1020 Hz (VOR, localizer, glide path) and DME ground-beacon pulse
  pairs (X 12 µs, Y 30 µs), their rate and the 1350 pair/s ident; the localizer ↔ glide path ↔ DME channel pairings
  (all 40 ILS pairs as the FAA/RadioReference table lists them). End to end: a VOR at 113.90 (bearing 211°, ident SFO)
  and a DME beacon (ident ABC) through noise; noise gives no bearing and no ident. In Chromium a VOR recording read
  "RADIAL 211° · ident SFO"; a localizer reading showed DDM, fly right and the paired glide path / DME buttons. Not done:
  DME range (it needs an interrogation, i.e. a transmitter); no check against a real off-air recording yet.
  Hardware: any radio here (RTL-SDR included) with a short antenna near an airport: tune the nearest VOR (its chart
  frequency): the radial should match where you are from the station on a map, and the ident its three letters; a
  localizer at an airport with instrument approaches (and its paired glide path) for DDM; its paired DME for pulse pairs.
- **Inmarsat AERO / STD-C**: covered by upstream's Satcom app (merged with 0.9.76): EGC from the Inmarsat-C NCS and Aero
  P-channel ACARS at 600/1200 bps. Nothing duplicated here. The fork's ARINC 622 reader applies to its ACARS lines
  ("SAT"), so ADS-C and CPDLC over Inmarsat read in words in Flight Msgs (test: arinc622.test.ts, "over Inmarsat too").
  Left as a new row: the 10.5 kbps OQPSK P-channel and the T/R bursts, which upstream does not read.
- **FLARM / OGN → ADS-L** (`dsp/adsl/`, new app "Gliders", `test/adsl.test.ts`): ADS-L written from EASA's ADS-L 4
  SRD-860 Issue 2 (the spec says it "is open to any interested party for implementation"). Both M-band channels
  (868.2 and 868.4 MHz) from one 2 MS/s span at 868.3: each mixed down, low-passed to ~4 samples a chip, FM
  discriminator, Manchester bits as second chip minus first (a carrier offset cancels), the sync word 0x72 0x4B
  searched at every sample, length byte, CRC-24, XXTEA (key 0, 6 rounds) undone; Traffic and Status payloads read
  field for field. Tests: the spec's bit-packing example and every exponential-encoding table row (altitude, ground
  speed, vertical rate); the CRC-24 checks a real ADS-B frame's parity (8D4840D6…576098, so it is the Mode-S code the
  spec names); XXTEA matches the standard zero-key test vector; Traffic/Status built and read back; end to end, three
  packets on both channels (two overlapping in time, one with a 12 kHz crystal error) through noise; a damaged packet,
  a reserved key and noise give nothing; an OGN tracker's sync is counted. Sensitivity on synthetic packets: 39/40 at
  0 dB SNR across the 2 MHz span (about 9 dB in the channel), 19/40 at −3 dB. In Chromium a 2 MS/s recording played
  through OPEN REC gave both aircraft on the map, the emergency pulsing, and the status ("also FLARM, ADS-B · Mode S")
  on the card. Not read: FLARM's own protocol (closed and obfuscated; decrypting it may be unlawful in the EU), OGN
  tracker packets (their LDPC code and whitening are unpublished; the firmware has no license), FEC (Reed-Solomon)
  packets and the O-band (869.525 MHz, PilotAware-compatible LDR and the HDR uplinks), and the secure signature
  (not checked). Note: the spec's XXTEA table says num_data_words 6, but its own text and packet layout give 5 (the
  20-byte ADS-L data of a Traffic packet, length 0x18); 5 is used. Not yet checked against a real off-air recording.
  Hardware (Europe): any radio here, 868 MHz antenna outside, near a gliding site on a soaring day; open Gliders: aircraft
  with newer FLARMs, OGN trackers or SkyEcho-type devices appear on the map within seconds. Compare positions with
  glidernet.org's live map (OGN ground stations receive ADS-L too).
- **MLAT feeder** (`dsp/adsb.ts` FORK edits, `export/event.ts`, `export/sinks.ts`, `test/mlat.test.ts`): every Mode-S
  frame now leaves the ADS-B decoder with its time in 12 MHz ticks counted from the radio's samples (the first preamble
  pulse; 6 ticks a sample at 2 MS/s, as dump1090's free-running counter) and dump1090's signal byte (√power · 255).
  The export bus puts both in `adsb.frame` events (`data.ts`, `data.sig`) and in the Beast output (it was 0 before).
  Samples the radio reports lost (DeliveryMeter gaps) move the clock on by the estimated count, and the held-back
  samples are dropped; a restart starts it at 0 (mlat-server resynchronizes a receiver whose clock jumps). Tests:
  frames at known samples across four buffers (one straddling an edge) come out exactly 6 ticks a sample apart; a gap
  of 12 345 samples shows up as 74 070 ticks; reset starts again at 0; the Beast bytes carry the ticks, the signal and
  the 0x1a escape inside a timestamp. Limits: at 2 MS/s a frame's time is to the sample (0.5 µs, ~150 m), coarser than
  readsb's 2.4 MS/s phase-corrected times, so expect MLAT positions within a few hundred meters at best; a gap's size
  is estimated from the wall clock, so after a USB stall the server has to resync (seconds). Not tried here: a real
  mlat-client session (no network to an MLAT server from this environment).
  Hardware: RTL-SDR or HackRF on ADS-B at 2 MS/s with a 1090 MHz antenna; Settings → EXPORT → WebSocket, format Beast,
  `ws://localhost:30005`; on the computer: `websockify 30005 localhost:30004`, `readsb --net-only --net-bi-port 30004
  --net-bo-port 30005`, then `mlat-client --input-type dump1090 --input-connect localhost:30005 --lat … --lon … --alt …
  --user … --server <an MLAT server you are allowed to feed>`. mlat-client should report "clock: dump1090" and, after a
  few minutes with aircraft around, synchronized peers. tar1090 on readsb shows the frames meanwhile.
- **Inmarsat Aero 10.5 kbps P-channel** (`dsp/aero105/`, Satcom FORK edits in `dsp/lband/satcom.ts` and main.ts,
  `test/aero105.test.ts`): after JAERO (MIT). OQPSK at 5250 symbols a second a rail (RRC roll-off 1): the carrier from
  the pair of lines the squared signal puts 5250 Hz either side of twice the carrier (±25 kHz search), then a Gardner
  clock on half-symbol strobes and a Costas loop. Frames of 5250 bits: header, 178 dummy bits, 4992 coded bits through
  a 64 × 78 interleaver, the UW 0xE15AE893 on both rails (each rail's polarity found from it); the K = 7 code runs on
  across frames, so each frame is decoded with the end of the one before and the start of the one after (half a
  second of latency); 15-bit scrambler; 26 signal units of 12 bytes with CRC-16/X-25; JAERO's ISU/SSU reassembly and
  ACARS check (odd parity), then upstream's `acarsLine`, so the lines read as upstream's 600/1200 ones ("SAT …") and go
  to Flight Msgs. Tests: the SU CRC's check value (0x906E); frames → bits → message through every rail polarity and a
  bit shift; OQPSK IQ end to end with a 3.2 kHz carrier error at Eb/N0 ≈ 9 dB; and a real recording: 5.6 s of JAERO's
  10.5k sample (fixture, 179 KB, 16 kS/s) gives 6+ frames with every signal unit's CRC good and three uplinks: a CPDLC
  message from Shanwick (PIKCPYA) to PH-BQI that the fork's FANS decoder reads as "THIS IS AN AUTOMATED MESSAGE TO
  CONFIRM CPDLC CONTACT WITH SHANWICK CENTER", the Frankfurt ATIS to A6-EDY, and an ADS-C periodic contract request
  to N914BA (every 832 s, with flight ID, predicted route, earth reference and meteo data). Over the whole 4-minute
  sample (not committed): 2496 signal units in 50 s, none bad; about 60× faster than real time at 48 kS/s. In
  Chromium the same signal played at 2 MS/s through OPEN REC: Satcom AERO 10.5K locked (+0.26 kHz), 468 signal units,
  GES 144, the ATIS and ADS-C lines in its log. Not done: the T/R bursts aircraft send back (new row); C-channel voice
  (never: voice).
  Hardware: an L-band patch and LNA (as for upstream's Satcom), HackRF or RTL-SDR at 2 MS/s; Satcom → AERO 10.5K; tap a
  ~10 kHz-wide carrier around 1545–1555 MHz (the 10.5k ones are the widest Aero carriers); "LOCKED" within a second or
  two and signal units counting; messages within minutes on a busy one (Atlantic/Indian Ocean satellites at peak hours).
- **Inmarsat Aero 10.5k R/T bursts** (`dsp/aero105/burst.ts`, `test/aero105.test.ts`): after JAERO (MIT). In AERO 10.5K
  a burst receiver runs beside the P-channel one, so an R/T carrier tapped on the waterfall is read too. A burst is
  found by its power (2.5× the floor for 12 symbols; it ends at 30% of its own level), its carrier from the strongest
  line in its unmodulated opening (128 symbols, then a 128-symbol timing tone), then the matched filter, Gardner and
  Costas, the UW (each rail's polarity), and a 64-row block of 5 + 3k columns: de-interleaved, Viterbi from state 0,
  descrambled; the column count is the one where every CRC checks (R: 17 bytes + CRC; T: a 6-byte header and k + 1
  units). R-channel user data (up to three 11-byte units by sequence indicator) and T-channel 0x71/0xC0 units are put
  back together into ACARS downlinks: "SAT … ↓ reg  label  blk  ack  #MSN FLIGHT" + text, so Flight Msgs reads them.
  Tests: T and R packets built and read back (the right column count found), R units reassembled into a message, a
  signalling R unit counted and not read, one coded bit in eight wrong mended, one in three not; and real bursts:
  JAERO's 10.5k burst sample (34 s) gives 9 bursts, all 9 read (CRCs good); two of them (43 KB fixture at 16 kS/s):
  D-AIHV (LH424) sending ADS-C to Gander, a waypoint change at 51.00°N 30.01°W, FL360, which the fork's ADS-C reader
  checks (its CRC good), and F-OFDF (TX542) with a position report at 46.85°N 22.23°W. In Chromium at 2 MS/s through
  OPEN REC: 5 bursts, three downlinks in the Satcom log (D-AIHV to Shanwick and Gander, G-CIVG BA287's ADS-C).
  Not done: the 600/1200 bps MSK bursts (new row); R-channel signalling units are counted, not named.
  Hardware: aircraft send these bursts up to the satellite at about 1.6 GHz, so an L-band patch on the ground hears
  them only from aircraft nearby; JAERO's users usually take them from the satellite's C-band feeder link (around
  3.6 GHz: a dish, and a HackRF, which reaches it; an RTL-SDR does not). Tap the bursty carrier in AERO 10.5K: the
  stats show BURSTS counting and downlinks appear in the log and in Flight Msgs. Check against JAERO on the same signal.
- **Inmarsat Aero 600/1200 bps R/T bursts** (`dsp/aero105/mskburst.ts`, FORK edits in `dsp/lband/satcom.ts`,
  `test/aero105.test.ts`): after JAERO (MIT). JAERO demodulates these MSK bursts coherently as offset QPSK and then
  differentially decodes each rail sample against the one before, which for MSK is the sign of the frequency in each
  bit; so here: the carrier from the squared burst (lines at twice the carrier ± half the bit rate; both lines are
  required, past the burst's opening, or the opening's own carrier line wins), mixed out, low-passed, an FM
  discriminator integrated over each bit with a clock pulled to its zero crossings. The UW (32 bits, one stream,
  either polarity) opens the data; the block is 64 × 5 and then 64 × 3 per further unit, so every length up to the
  true one checks and the longest one whose CRCs all pass is kept. T and R packets go through the same readers as the
  10.5k bursts. Runs in upstream's AERO 600 / AERO 1200 modes beside their P-channel decoder (a few lines, FORK).
  Also fixed in both burst receivers: the noise floor now starts from the mean power of the first stretch (it started
  near 0, so the first burst took the whole recording). Tests: a synthetic T packet as MSK at 1200 and at 600 bps
  through noise with a 310 Hz carrier offset, read back; noise gives nothing; and JAERO's real 1200 bps burst
  samples: sample 1 gives C-GGTS (Air Transat 281) ADS-C to Gander across two bursts (10 + 8 units), sample 2 (the
  103 KB fixture at 12 kS/s) gives 165831 (MC4666) ADS-C to Gander across two bursts, which the fork's ADS-C reader
  takes (its CRC good). Every UW matched 32 of 32. In Chromium at 2 MS/s through OPEN REC in AERO 1200: 3 bursts, the
  165831 downlink in the log. Not done: R-channel signalling units are counted, not named.
  Hardware: as the 10.5k bursts (aircraft transmit at 1.6 GHz: nearby aircraft on L band, or the C-band feeder link);
  in AERO 600 or AERO 1200, tap the bursty carrier: BURSTS counts and downlinks appear.
- **Marine DSC** (`dsp/dsc.ts`, new app "Marine DSC", `test/dsc.test.ts`): written from ITU-R M.493-16. The NFM
  discriminator → 1300 Hz (Y, 1) / 2100 Hz (B, 0) sliding correlators → bit clock → ten-bit characters (7 information
  bits LSB first, the count of B bits MSB first); phasing found from the DX 125 / RX 111…104 characters (three of four
  right, one of them an RX, which says where in the phasing we are); each information character taken from its DX
  copy or, when that fails its check bits, its RX copy four characters later; calls parsed by format specifier
  (distress alert; all-ships, individual, group and geographic calls; distress relays, acknowledgements and
  self-cancels with the distress ID and its information; telecommands; VHF channels and frequencies as Table A1-5;
  position replies) and kept only if the ECC checks. Tests: every Table A1-1 row the PDF prints (0, 1, 3, 15, 43, 63,
  99, 104, 117, 122, 125, 126, 127), every symbol's single-bit errors caught; MMSI, position (quadrant, degrees,
  minutes), time and ECC; five calls end to end as AFSK (alert, relay and acknowledgement from a coast station, an
  individual call proposing channel 72, a position reply); damaged DX copies read from their RX copies; the same
  character hit in both copies, and noise, give nothing. In Chromium an FM recording at 2 MS/s through OPEN REC: three
  calls on the cards (distress in red), the position on the map, coast station named. No off-air recording yet (none
  with a redistributable license found). The app links to Ships: a vessel AIS has heard shows its name on the DSC card
  with a SHIPS button, and its Ships card shows its last DSC call.
  Hardware: any radio here, an antenna near the water, Marine DSC: coast stations make routine and test calls through
  the day; check against a handheld DSC radio's
  log, or another DSC decoder (YaDDNet / a DSC-capable scanner) on the same channel.
- **Distress beacons: 406 MHz and 121.5 MHz homing** (`dsp/beacon406/`, new app "Beacons", `test/beacon406.test.ts`).
  406: frames ported from PortaPack Mayhem's EPIRB receiver (GPL-2.0-or-later): sync, BCH-1/BCH-2 with single-bit
  correction, protocol (user, standard, national, RLS, ELT(DT), test, orbitography), country (MID), the 15-hex beacon ID,
  positions with their fine offsets, serials, aircraft addresses and operator designators, MMSI (ship security),
  emergency codes, homers. The signal: every channel of 406.0–406.1 MHz at once from one 2 MS/s span; a new carrier
  line (26 dB over the median bin; birdies and the burst's own sidebands are not new) opens a burst; its carrier's
  frequency and phase from a line through the unwrapped phase of its unmodulated 160 ms; the phase read against it;
  bit rate (396–404 bit/s) and timing where the Manchester halves differ most; each bit the first half's mean phase
  minus the second's; the 24 sync bits (two wrong allowed), BCH, and one report per burst. Tests: Mayhem's own list of
  reference and real beacon frames reads as titled — the ADRASEC standard-location test frame at its documented
  position (49°16'32"N 3°16'32"E), EPIRB-MMSI, ship security, ELT 24-bit, RLS, national PLB, serial user EPIRB with
  an automatic capsizing emergency, orbitography; a one-bit BCH error corrected, BCH errors in both fields not
  accepted; bursts end to end on two channels at 403 and 397 bit/s through noise with its own spurious lines; noise
  alone gives nothing. 121.5: the AM envelope's strongest tone tracked in 32 ms frames; three or more downward sweeps
  of ≥ 700 Hz repeating every 0.15-0.7 s make a homer (test: 1600→300 Hz three times a second found at 3/s; a steady
  tone and silence are not). In Chromium a 2 MS/s recording through OPEN REC: two beacons on the map and cards
  (France's twice, on 406.040 and 406.028), the homing mode renders. No off-air recording yet.
  Hardware: any radio here; 406 MHz: an antenna for 400 MHz outside; beacons are tested by their owners now and then
  (a self-test burst): near a marina, airfield or outdoor shop you may catch one; a real alert is shown in red. 121.5:
  an ELT's homer is heard for miles from an aircraft; FAA guidance puts ELT tests in the first five minutes of the hour
  (in the US): turn for the highest level to find it.
- **NAVTEX** (`dsp/navtex.ts`, new app "NAVTEX", `test/navtex.test.ts`): written from ITU-R M.625-4 and M.540-2. The
  radio at 1 MHz and 2 MS/s holds 490 and 518 kHz together; each channel mixed down, a boxcar then a FIR to 2 kHz, FM
  discriminator less its slow mean (the carrier error), a 100 Bd bit clock; character sync from two phasing pairs
  (phasing signal 2 in DX, α in RX); every DX signal paired with its RX copy two slots on and the good one kept
  (four B and three Y; both good but different: mutilated; phasing 2 against α during phasing is phasing); letters and
  figures (figure-case D, F, G, H, J print nothing); a message from an error-free ZCZC B1B2B3B4 to NNNN, ended early by
  two idle α or too many mutilated signals; repeats of the same B1-B4 counted, not shown twice (serial 00 always).
  Tests: the code table (32 distinct signals, constant ratio); a message read back from bits; one bit hit in every
  third DX signal read from the RX copies; the same signal hit in both copies of the preamble gives no message; end to
  end, two messages at once on 518 and 490 kHz as 100 Bd FSK through noise with carrier errors of +40 and −25 Hz; noise
  gives nothing. In Chromium a 2 MS/s recording at 1 MHz through OPEN REC: the 518 kHz message on its card. No
  off-air recording yet.
  Hardware: a HackRF (518 kHz is under its rated 1 MHz floor: strong stations only; an upconverter or an HF-sampling
  RTL-SDR does better) with a long wire outside; NAVTEX stations send in their own ten-minute slots every four hours,
  carrying far at night; check messages against the station's published schedule (B1 letter) or another NAVTEX decoder.
- **FT4** (`dsp/ham/ft4.ts`, FORK edits in `dsp/ham/ft8.ts` (one method and one export: the shared code, CRC,
  LLR scaling, resampler and unpacking), the worker and main.ts (the DIGITAL tile; FT8's panel follows the mode:
  caption, 7.5 s countdown, FT4's dial frequencies), `test/ft4.test.ts`): after ft8_lib (MIT). Audio at 10 2/3 kHz (a
  symbol is 512 samples), a two-symbol Hann window every half symbol, half-tone bins in dB; candidates from the four
  Costas blocks (each tone against its symbol's other three); the 87 data symbols' four tone levels give two
  likelihoods each (Gray map); FT8's belief propagation, then OSD when BP comes close (then the message must be a
  plausible standard one); CRC-14 over the scrambled payload; unscrambled and unpacked by FT8's code. Tests: four
  messages' payloads and all 105 tones equal ft8_lib's own ft4_encode output (its C code built and run here); three
  signals in one slot (800, 1500, 2200 Hz; DT 0, +0.2, −0.1 s; the weakest about −7 dB in 2500 Hz) all read; a
  scrambled one and noise give nothing; the live path (48 kHz pushed as it comes, the clock stubbed) decodes in the
  right slot with DT within 0.1 s. In Chromium: Ham Radio → DIGITAL → FT4 shows the FT4 caption, countdown and dials.
  No off-air recording yet.
  Hardware: a HackRF (or an HF-capable RTL-SDR) on an FT4 frequency (20 m 14.080 MHz USB is the busiest; 40 m 7.0475)
  with a wire antenna, during contests most of all: decodes every 7.5 s; compare with WSJT-X on the same audio.
- **WSPR** (`dsp/ham/wspr.ts`; FORK edits in the worker (its own decoder, outside AUTO; its spots go to FT8's list
  with the drift after the message) and main.ts (the DIGITAL tile; FT8's panel follows the mode: caption, 120 s
  countdown, WSPR's dial frequencies, its own empty text, tap-to-log takes the first word as the call), `test/wspr.test.ts`,
  `test/fixtures/wsjtx-wspr-150426_0918-375sps.ci16`): after wsprd (GPL-3.0). USB audio mixed down from 1500 Hz to a
  375 Hz complex baseband; half-symbol-step spectra give candidates within ±110 Hz; a coarse search over frequency,
  start and drift on the spectra, then wsprd's fine searches on the samples; soft bits from each symbol's two
  allowed tones; a stack sequential decoder (written here) over the K=32 code; the message must end in the 31 zero tail
  bits and unpack to a valid call, grid and power. Decodes 115 s into each even minute, from the slot's first 114 s.
  Tests: five messages (types 1, 2 and 3) pack to the same data bytes and all 162 channel symbols as WSJT-X's wsprsim
  (built and run here); unpacking gives each back, a hashed call shows once heard in full; the decoder corrects noisy soft symbols
  (at least 10 hard errors, checked) and gives up on noise; three stations in a slot (one drifting 2 Hz, the weakest −26 dB in 2500 Hz) decode
  with their frequency (±1 Hz) and DT (±0.3 s); noise alone gives nothing; the live path (48 kHz pushed as it comes,
  the clock stubbed) decodes at the end of its slot; WSJT-X's real off-air sample (samples/WSPR/150426_0918.wav) gives
  seven stations (NM7J DM26, WD4LHT EL89, ND6P DM04, W3HH EL89, W5BIT EL09, DJ6OL JO52, KI7CI DM09). Synthetic threshold
  (6 runs each): every one at −28 dB, 4/6 at −29, 1/6 at −30; no false decodes; a slot takes well under a second.
  Not done: wsprd's multi-symbol detection, its signal subtraction (second pass) and OSD, so the deepest decodes are
  wsprd's; Ham Map spots for WSPR; WSPRnet upload (its own row). In Chromium: Ham Radio → DIGITAL → WSPR shows the
  WSPR caption, countdown and the twelve dials.
  Hardware: a HackRF (or an HF-capable RTL-SDR) with a wire antenna on 20 m (14.0956 MHz USB) or 40 m by day, 80 m by
  night: spots every two minutes; compare with WSJT-X on the same audio, or with wsprnet.org's spot list for the band.
- **FST4W-120** (`dsp/ham/fst4w.ts`, `dsp/ham/fst4w-tables.ts` (WSJT-X's LDPC(240,74) generator and parity tables,
  generated from the .f90 files); `WsprFrontEnd` takes an output rate (300 Hz here); FORK edits in the worker and
  main.ts beside WSPR's (the DIGITAL tile; WSPR's panel, dials and countdown), `test/fst4w.test.ts`): after WSJT-X
  (GPL-3.0). 160 symbols of 4-GFSK at 1.4634 Hz (8200 samples at 12 kHz), five 8-symbol sync blocks; 50 message bits
  in packjt77's 0.6 layout (WSPR's three types; the hashed type has no power), CRC-24, LDPC(240,74). A 300 Hz baseband
  around 1500 Hz; quarter-symbol spectra and the sync blocks give candidates within ±100 Hz and −1..+3 s; frequency and
  start are refined together on the five sync blocks, each correlated coherently over its eight symbols; bit metrics
  from 1, 2 and 4 symbols coherently (as get_fst4_bitmetrics: modulation index 1 keeps every tone's phase step the
  same); at least 16 of the 40 sync symbols right; belief propagation (as decode240_74) on each metric in turn; the
  CRC and the unpacking must hold. Tests: encoded codewords pass every parity check (two independent WSJT-X tables
  agree) and the CRC; a call packs to the same 28 bits as FT8's encoder (packjt77's pack28 both); all three types and
  compound calls unpack back, a hashed call shows once heard; the frame has its sync blocks; BP corrects noisy
  likelihoods (≥15 hard errors) and gives up on noise; three stations in one slot (−18, −24, −28 dB in 2500 Hz; DT 0,
  +0.6, −0.4 s) all decode with frequency (±1 Hz), DT (±0.2 s) and the strong one's SNR within 3 dB; noise alone gives
  nothing; the live path (48 kHz, clock stubbed) decodes at the end of its slot. Measured while building (4 runs each):
  4/4 at −26, −28 and −29 dB, 2/4 at −30, 1/4 at −31; 12 noise-only slots gave no false decode; ~50-100 ms a slot.
  Not done: WSJT-X's 8-symbol metrics, OSD and a-priori passes (it claims about −33 dB), FST4W-300/900/1800, FST4.
  No off-air recording to test against (WSJT-X's samples folder could not be listed from here); not checked against
  WSJT-X's own encoder (no Fortran compiler here). In Chromium: Ham Radio → DIGITAL → FST4W shows the FST4W-120
  caption, countdown and WSPR's dials.
  Hardware: as WSPR (FST4W shares its sub-band, 1400-1600 Hz above the WSPR dial): 20 m 14.0956 MHz or 40 m 7.0386
  MHz USB with a wire antenna; spots every two minutes on the even minute; compare with WSJT-X in FST4W mode, T/R 120.
- **WEFAX** (`dsp/ham/wefax.ts`; FORK edits in the worker (its rows go out as SSTV's picture messages; the LPM
  option) and main.ts (the DIGITAL tile; SSTV's picture panel with WEFAX's own station and LPM buttons in place of
  SSTV's; the caption), `test/wefax.test.ts`): written from the published parameters. USB audio, FM around 1900 Hz,
  black 1500 / white 2300 Hz; 120 LPM by default (60, 90, 240 chosen by hand); a quadrature detector; Goertzel filters
  on the frequency hear the start signal (300 Hz: IOC 576, 1810 pixels a line; 675 Hz: IOC 288) and the stop signal
  (450 Hz); the phasing lines' 5 % pulse (either polarity) sets the line start; each line's samples are averaged into
  its pixels; without a start signal the lines run free. Station buttons: NMF, NMG, NMC, DWD Hamburg, JMH (published
  carrier frequencies from memory, the dial 1.9 kHz below; check each station's schedule). Tests: a chart (smooth bands
  that drift down the lines) after 3.37 s of noise: start heard, line start found, start → phasing → image → stop, 118-123
  lines, mean pixel error under 0.08; IOC 288 told by its 675 Hz start (905 pixels); noise alone hears no start or stop.
  Measured while building: mean error 0.01 at 30 dB SNR in 2500 Hz to 0.06 at 13 dB, the line start within 2 pixels
  every time. In Chromium: a WAV of a synthetic chart through AUDIO IN (Ham Radio, USB, MAX speed) gave the start,
  phasing and stop lines and the chart (grid lines straight, left edge in place) in the picture panel.
  Not done: slant correction for a sample clock that is off (a few ppm leans the chart slightly), cropping the canvas
  to the chart's length, a manual line-start shift for charts tuned in mid-way, the schedules themselves.
  Hardware: a HackRF (or an HF-capable RTL-SDR) with a wire antenna on NMF 6340.5 or 9110 kHz (dial 6338.6 / 9108.1
  USB) or DWD Hamburg 7880 kHz, at a scheduled chart time: the start tone, phasing and a surface analysis should
  draw over ~10-20 minutes; compare with fldigi's or SeaTTY's WEFAX on the same audio.
- **MSK144** (`dsp/ham/msk144.ts`, `dsp/ham/msk144-tables.ts` (WSJT-X's LDPC(128,90) tables, generated from the .f90
  files), `dsp/ham/ldpc.ts` (belief propagation shared with FST4W, whose decoder now uses it); FORK edits in the worker
  and main.ts beside FT8/FT4/WSPR (the DIGITAL tile; FT8's list and panel: caption, the calling frequencies 50.260,
  50.280, 144.150, 144.360 MHz, its own empty text; not Ham Map spots), `test/msk144.test.ts`, fixtures
  `test/fixtures/wsjtx-msk144-181211_120500.wav` and `_120800.wav` (WSJT-X's own samples, 12 kHz, GPL-3.0)): after
  WSJT-X. USB audio to a 12 kHz baseband at 1500 Hz; every 18 ms the squared frame's spectrum looks for MSK's lines at
  ±1000 Hz (moved by twice the frequency error); a peak 3× the quarter-quantile (or 12× its neighbours) is a ping: its
  three frames in six combinations, ±8 Hz in 2 Hz steps, coherently summed; the sync word by correlation; phase from the
  two syncs; matched-filtered bits (≤4 sync bits wrong); BP (10 iterations, early stop); CRC-13; under 18 hard errors;
  the message type allowed; unpacked by FT8's code. Tests: the CRC construction agrees with FT8's CRC-14; encoded
  codewords pass every parity check (two WSJT-X tables agree); the frame has its syncs; the I/Q waveform is the same
  signal as WSJT-X's tone sequence (genmsk_128_90's tones through continuous-phase FSK at 1000/2000 Hz: match > 0.97);
  a frame decodes clean and three noisy frames decode, noise does not; a 0.4 s ping 37 Hz off in noise decodes once at
  its frequency (±2 Hz), noise alone gives nothing; WSJT-X's two real 6 m recordings give K1JT WA4CQG EM72 (120500) and
  CQ W4IMD EM84, CQ KD9VV EN71 (120800). 60 s of noise took 0.6 s of CPU (2 candidates, no decode). In Chromium: the
  120800 recording through AUDIO IN (Ham Radio, USB, real time) listed CQ KD9VV EN71 and CQ W4IMD EM84 (two pings).
  Not done: MSK40 short messages ("<CALL1 CALL2> RPT"), a-priori decoding, Ham Map spots.
  Hardware: a HackRF or RTL-SDR with a 6 m vertical or a small Yagi on 50.260 MHz USB (2 m 144.150 in North America,
  144.360 in Europe), around dawn or during a meteor shower (the Geminids in mid-December): pings decode as they come;
  compare with WSJT-X in MSK144 mode on the same audio.
- **FST4 and the FST4W periods** (`dsp/ham/fst4w.ts` now `Fst4Decoder(wspr, period, centreHz)` with `Fst4wDecoder` the
  FST4W case; `dsp/ham/fst4w-tables.ts` gains WSJT-X's LDPC(240,101) tables; `WsprFrontEnd` takes the audio centre;
  FORK edits in the worker and main.ts: an FST4 tile, the T/R period chips for both, FST4's Rx frequency box, 2200 m and
  630 m dials for FST4, the countdown per period, the list's hint now following the mode (it stayed on FT8's before),
  `test/fst4w.test.ts`, fixture `test/fixtures/wsjtx-fst4-60-210115_0058-250sps-1335hz.ci16`): after WSJT-X. Each
  period's samples a symbol (fst4_decode.f90: 720 for 15 s ... 134400 for 1800 s), the baseband at 250-375 Hz so a
  symbol is a whole number of samples, the frame nominally 1 s in (0.5 s for 15 s); the search and refinement scaled to
  the tone spacing; FST4: FT8's 77-bit message XORed with genfst4's sequence, CRC-24 over 101 bits, LDPC(240,101),
  FT8's unpacking. Tests: the (240,101) generator and parity checks agree and the CRC checks; FST4W-300 at −34 dB,
  FST4W-900 and -1800 at −38 dB (in 2500 Hz), 40 Hz off, decode with frequency and DT, noise alone gives nothing in each;
  FST4-15 through 12 kHz audio and the front end decodes a standard message 60 Hz off at −16 dB; WSJT-X's real FST4-60
  sample (samples/FST4+FST4W/210115_0058.wav) decodes CQ K9KFR EN71 at 1335 Hz (with the Rx frequency set there: the
  search covers ±100 Hz). A 1800 s period takes about 1.2 s to decode. In Chromium: the FST4 tile with its seven
  periods, the Rx box and the LF/MF dials; FST4W's four periods; captions and countdowns follow.
  Not done: WSJT-X's wider FST4 search (it can cover the whole passband), its 8-symbol metrics, OSD and a-priori passes;
  no off-air FST4W recording yet (WSJT-X's FST4W sample would not download).
  Hardware: FST4/FST4W are mostly on 2200 m (136 kHz) and 630 m (474.2 kHz), below the HackRF's 1 MHz: an RTL-SDR with
  direct sampling (or an upconverter) and a large antenna; FST4W also on the WSPR dials above 1.8 MHz with a HackRF.
  Compare with WSJT-X in the same mode and T/R period.
- **PSK63 / PSK125 / QPSK31** (`dsp/ham/psk.ts`, beside the upstream PSK31 decoder, untouched; FORK edits in the worker
  (three decoders on PSK31's centre buttons) and main.ts (the DIGITAL tiles, USB/LSB)), `test/psk.test.ts`): BPSK at 62.5
  and 125 baud as PSK31; QPSK31 after fldigi: the K=5 code (0x17, 0x19), fldigi's phase mapping (pair 0 → 180°, 1 → +90°,
  2 → 0°, 3 → 270°), soft bits from the phase change and a Viterbi decoder (30-bit traceback). Demodulator (written here,
  better than the upstream structure it started from, found while testing): the symbol centre from the smoothed
  per-phase envelope, chosen once a symbol; a pulse-shaped matched filter over the whole symbol around it; and a real
  frequency-tracking AFC (a tracked rate whose running total turns each symbol back; a fixed phase, as the upstream loop
  applies, cancels in differential detection and corrects nothing), fast for the first 64 symbols. Tests: clean text
  exactly in all three; PSK63 at −4 dB and PSK125 at −1 dB in 2500 Hz, 3 Hz off; QPSK31 at −6 dB, 2 Hz off (measured:
  clean to −4 dB at 0-4 Hz off, a character or so lost at −8); noise and a plain carrier give no text. Hardware: 14.070
  MHz USB (PSK63/125 around 14.070-14.073, QPSK31 rarer); compare with fldigi.
- **JT9** (`dsp/ham/jt9.ts`; `wsprStackDecode` takes the code's length (WSPR 81 bits, JT9 103); FORK edits in the worker
  and main.ts beside JT65's (the DIGITAL tile, JT65's dials); `test/jt9.test.ts`, fixture
  `test/fixtures/wsjtx-jt9-130418_1742-4000sps.wav`): after WSJT-X. 85 symbols of 0.576 s, 9-FSK at 1.736 Hz (tone 0
  sync on 16 symbols, tones 1-8 three Gray-coded bits each); packjt's 72 bits + 31-bit tail through the K=32 code
  (WSPR's polynomials); bit-reversal interleaving. Audio at 7111 Hz (a symbol is 4096 samples); half-symbol spectra
  with half-tone bins; the sync tone searched over 200-2700 Hz, DT −2.5..+5 s, required on in the sync symbols and off in
  the data ones; refined; symspec2's bit soft values; the WSPR stack decoder; JT65's unpacking; one line per message
  (a strong signal's weaker copies elsewhere are dropped). Also, JT9 and JT65: bins far below the band's typical level
  are left out instead of being normalised up (found with audio band-limited to 2 kHz: they took every candidate).
  Tests: the frame's sync and data tones; three stations at −10, −18, −24 dB decode with frequency, DT and SNR (±3 dB);
  noise gives nothing; WSJT-X's real JT9 sample (samples/JT9/130418_1742.wav, resampled to 4000 Hz for the fixture)
  gives seven stations: K1JT N5KDV EM41, JA1KAU PD0JAC −23, TF3G N7MQ CN84, G7CNF N4HFA EL89, K1JT KF4RWA 73,
  CQ M0WAY IO82, CQ GM7GAX IO75 (calls and grids that agree with each other, so real, not chance). The recording also
  checks JT65's message packing, which JT9 shares. Hardware: as JT65 (14.076 / 14.078 MHz USB); compare with WSJT-X.
- **MSK40** (in `dsp/ham/msk144.ts`; the frame search generalised over frame length, sync positions and frame decoder;
  `test/msk144.test.ts`): after WSJT-X. When no MSK144 frame decodes in a ping, its 20 ms frames are tried as MSK40: the
  reversed sync word, matched-filtered bits, BP over the (32,16) code (bpdecode40's checks, encode_msk40's generator and
  column order), then msk40decodeframe's tests (≤ 3 sync bits wrong, ≤ 4 code bits off the hard decisions, their summed
  reliability < 0.65, an R / RRR / 73 report). Shown only when the 12-bit hash (WSJT-X's lookup3 over the 37-character
  "CALL1 CALL2") matches a pair of calls seen together in an MSK144 decode lately: tried at every offset, a 32-bit code
  matches by chance (WSJT-X's own sample gave three such "<hash>" decodes when bare hashes were shown, so they are not).
  Tests: the generator and the parity checks agree for every report and a spread of hashes; after "K1ABC W9XYZ R-09",
  a "<W9XYZ K1ABC> RRR" ping decodes, and a ping from a pair never seen gives nothing; the two real recordings still give
  exactly their three messages. Hardware: as MSK144; short messages follow a QSO's full ones.
- **JT65** (`dsp/ham/jt65.ts`; FORK edits in the worker and main.ts beside FT8's: the DIGITAL tile, A/B/C chips, the HF
  JT65 dials plus 6 m and 2 m EME, the 60 s countdown, its own empty text; not Ham Map spots; `test/jt65.test.ts`):
  after WSJT-X and Karn's RS codec (ported). 60 s slots; 126 symbols of 0.3715 s, the sync tone on the pattern's 63
  symbols, the data 2-65 spacings above it (2.69 Hz ×1/×2/×4); RS(63,12) over GF(64), 7×9 interleave, Gray code;
  packjt's 72-bit messages (calls, grid / report / RO / RRR / 73, CQ nnn, QRZ, free text; the v2 CQ/QRZ/DE prefix and
  suffix forms on receive). Audio at 5512.5 Hz (a symbol = 2048 samples); half-symbol spectra, each bin against its
  median; the sync pattern searched over 200-2700 Hz and DT −2..+4 s; refined; 64 tone powers a data symbol; hard
  decisions ranked by reliability; Karn's Berlekamp-Massey with 0-48 of the least reliable erased, then 1500 random
  reliability-weighted erasure sets. Against false decodes (each found while building): the sync tone must be on in the
  sync symbols and off in the data ones (ratio ≥ 2: a carrier or another mode gives ~1); the decoded tones must average
  ≥ 3.5× their symbols' medians (5× for free text); no tone value more than 12 times in the codeword (a near-all-zero
  message is a steady tone); nothing inside an already decoded signal's band. Tests: messages pack and unpack back;
  RS corrects 25 errors and fills 51 erasures, 26 errors do not give the message; interleaving undoes itself; the
  frame's sync and data tones; three JT65A stations (−8, −16, −22 dB in 2500 Hz) decode with frequency (±1 Hz), DT (±0.1
  s) and SNR (±2 dB), no echo of the strong one; JT65B and C at −22 dB; noise, a carrier and a strong random 9-tone
  signal give nothing in A, B and C; the live path (48 kHz, clock stubbed) decodes 52 s into its minute. Measured while
  building: A and C decode every time at −23 dB, none at −24 (WSJT-X's KV decoder reaches about −25); 24 noise-only
  slots gave nothing; about 0.4 s a slot. In Chromium: the JT65 tile, its submode chips and dials.
  Not done: no real JT65 recording decodes here to check against: WSJT-X's JT65B samples are weak EME meant to be averaged
  over several transmissions, and DL7UAE's is 26 s long (a JT65 transmission is 47 s); WSJT-X's JT9 sample gave no JT65
  decode, as it should. Also not done: averaging, deep search, EME shorthand messages, type-1 prefix / suffix calls.
  Hardware: a HackRF with a wire antenna on 14.076 MHz USB (JT65A; less busy than in its day, so try evenings or 10 m /
  6 m openings); compare with WSJT-X in JT65 mode.
