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
| [ ] | | **Voice recording** to WAV with TG/unit/time metadata (Dispatch, Repeaters, Prowl) | WAV `LIST/INFO` chunks | spec |
| [ ] | | **Analyzer protocol library** export/import JSON | `analyzer-store.ts` | in-repo |

## Phase 2 — Quick wins and corrections

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | Satellites: NOAA 15/18/19 decommissioned (grey out, keep) | NOAA OSPO notices | facts |
| [ ] | ★ | Full Mode-S in `dsp/adsb.ts`: DF0/4/5/11/16/20/21, Comm-B BDS 1,0/2,0/4,0/5,0/6,0, AP recovery vs known ICAOs, 1–2 bit CRC fix (DF11/17/18), "Mode-S only" aircraft | ICAO Annex 10 Vol IV, Doc 9871; pyModeS; readsb; dump1090-fa | pyModeS GPL-3.0 ✔ · readsb GPL-3.0 ✔ · dump1090-fa GPL-2.0-or-later ✔ · antirez dump1090 BSD-3 ✔ |
| [ ] | | Mode A/C replies (≥2 Msps), unassociated tracks | dump1090-fa `mode_ac.c` | GPL-2.0-or-later ✔ |
| [ ] | | BLE: auto-rotate 37/38/39, extended adv headers, coded PHY if feasible, PHY per packet | Bluetooth Core 5.x Vol 6; ubertooth/libbtbb | ubertooth/libbtbb GPL-2.0-or-later ✔ (headers) |
| [ ] | | BLE tracker-following alert (AirTag/Find My/Tile/SmartTag/Find Hub) over time + GPS distance | Apple/Google DULT draft (IETF), AirGuard research | spec; check any code |

## Phase 3 — Drones

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | Remote ID: BLE legacy (UUID 0xFFFA, message pack) → BT5 ext/coded → Wi-Fi beacon/NAN (ch 6); map with drone + operator | ASTM F3411, ASD-STAN prEN 4709-002; opendroneid-core-c | opendroneid-core-c Apache-2.0 ✔ |
| [ ] | ★ | DJI DroneID (OcuSync 2.4/5.8 GHz OFDM): detect, demod, serial + drone/pilot/home GPS | proto17/dji_droneid; RUB-SysSec/DroneSecurity (NDSS '23 paper) | dji_droneid MIT ✔ · DroneSecurity AGPL-3.0 ✔ (prefer the paper / MIT code) |
| [ ] | | FPV analog video detect at 5.8 GHz (raceband/A/B/E/F), NTSC/PAL frames if bandwidth allows | channel tables (public) | facts |
| [ ] | | Digital FPV + control-link fingerprinting: DJI O3/O4, Walksnail, HDZero, ELRS, Crossfire | ExpressLRS source | check (ELRS is GPL-3.0 per memory — verify) |

## Phase 4 — Aviation

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | HFDL (2.9–22 MHz), many channels per span, feeds ACARS cards | dumphfdl | GPL-3.0-or-later ✔ |
| [ ] | | CPDLC / ADS-C inside ACARS/VDL2/HFDL | libacars | MIT ✔ |
| [ ] | | Iridium (1616–1626.5 MHz): bursts, frame types, ring alerts, sat/beam IDs, ACARS | gr-iridium; iridium-toolkit | gr-iridium GPL-3.0-or-later ✔ (headers) · iridium-toolkit BSD-2-Clause ✔ (README) |
| [ ] | | VOR bearing + Morse ID; ILS LOC/GS DDM; DME pulse pairs | Mayhem `vor_rx` | Mayhem GPL-3.0 ✔ |
| [ ] | | Inmarsat AERO / STD-C (needs LNA + patch; say so in UI) | JAERO | MIT ✔ |
| [ ] | | FLARM / OGN receive | OGN docs, published decoders | check |
| [ ] | | MLAT feeder (Beast over WebSocket) via export bus | Beast format | facts |

## Phase 5 — Marine and emergency

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | Marine DSC ch 70 (156.525 MHz, 1200 Bd FSK); link MMSIs to Ships | ITU-R M.493, M.541 | spec |
| [ ] | ★ | EPIRB/PLB/ELT 406 MHz (BCH, hex ID, country, protocol, position) + 121.5 MHz homing | Mayhem `epirb_rx`; C/S T.001 | Mayhem GPL-3.0 ✔ · C/S T.001 spec |
| [ ] | | NAVTEX / SITOR-B (518/490 kHz) | ITU-R M.540, M.625 | spec |
| [ ] | | Inmarsat-C EGC / SafetyNET | JAERO / scytale-c | JAERO MIT ✔ · scytale-c check |

## Phase 6 — Public safety trunking (extends Dispatch)

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | EDACS (standard + networked), ProVoice identification only | SDRTrunk; DSD-FME | SDRTrunk GPL-3.0 ✔ · DSD-FME ISC ✔ (README; check per-file) |
| [ ] | ★ | LTR / LTR Passport | SDRTrunk | GPL-3.0 ✔ |
| [ ] | ★ | MPT1327 | SDRTrunk; MPT1327 spec | GPL-3.0 ✔ |
| [ ] | | DMR Tier III: Connect Plus, Hytera XPT mapping | DSD-FME; SDRTrunk | as above |
| [ ] | | Two-tone sequential (QC-II) receive, GE Star | upstream `ui_test` (TX) tables | in-repo |
| [ ] | | Alias import (RadioReference / OP25 / SDRTrunk CSV/TSV) | OP25 | OP25 (boatbod) GPL-3.0-or-later ✔ (headers) |

## Phase 7 — Ham radio digital (extends Ham Radio → DIGITAL)

| Done | ★ | Item | Reference | License |
|---|---|---|---|---|
| [ ] | ★ | FT4 (reuse FT8 LDPC/unpack), WSPR (+ optional WSPRnet spots, off by default), JT65/JT9/Q65/FST4/FST4W, MSK144 | WSJT-X | check (GPL-3.0 expected; verify from the source tarball's COPYING) |
| [ ] | ★ | FreeDV 700D/700E/1600 modems (Codec 2 already in `dsp/hamid/codec2.ts`) | codec2 | LGPL-2.1 ✔ |
| [ ] | | fldigi modes: Olivia, Contestia, MFSK16/32, Thor, Domino, Hell, PSK63/125, QPSK31 | fldigi | GPL-3.0 ✔ |
| [ ] | | D-STAR slow data + DPRS → Ham Map; Fusion data | DSD-FME; JARL spec | ISC ✔ / spec |
| [ ] | | HF packet (300 Bd), ARDOP; KISS out via export bus | Dire Wolf; ARDOP spec | check |
| [ ] | | WEFAX; digital SSTV (HamDRM / EasyPal) | Mayhem `wefax_rx`; QSSTV | Mayhem GPL-3.0 ✔ · QSSTV check |
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
  Beast timestamps are 0 (no sample clock), so the Beast output suits readsb/tar1090 but not MLAT.
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
