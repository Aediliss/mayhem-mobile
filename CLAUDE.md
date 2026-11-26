# CLAUDE.md — Mad Mobile (a fork of Mayhem Mobile)

Web-only fork of [RocketGod-git/mayhem-mobile](https://github.com/RocketGod-git/mayhem-mobile) (GPL-3.0).
All work goes in `web/`. **Leave `app/` (Android/Kotlin) alone** unless a shared file forces it; never write Kotlin twins.
Backlog and license findings: `docs/ROADMAP.md`.

## Commands (run from `web/`)

| | |
|---|---|
| `npm ci` | install (devDeps only: typescript, esbuild, @types/w3c-web-usb) |
| `npm run check` | `tsc --noEmit` over `src/` |
| `npm run build` | `tsc` → `dist/` (used by `test-capture/`), then esbuild → `build/app.js`, `build/dsp-worker.js` |
| `npm test` | esbuild bundles `test/**/*.test.ts` → `.test-build/`, then `node --test` |
| `npm run serve` | build, then `node scripts/serve.mjs` → http://localhost:8080 (WebUSB works on localhost without TLS) |

All three of check / build / test must pass before an item is marked done. CI: `.github/workflows/web.yml`
(check/build/test on every push and PR; deploys Pages on `main`, Pages source = "GitHub Actions").

## Architecture in one screen

- `src/main.ts` (~10.5k lines): launcher, every app screen, WebUSB connect, the worker bridge. UI thread.
- `src/dsp.worker.ts`: owns the active `IqProcessor`, the FFT waterfall, audio demod, capture. Receives
  `{type:'iq', buf}` from the radio driver, posts results back with `emit(...)`.
- `src/radio.ts`: the `Radio` interface (`open/run/stop/setGain`, `limits`, `caps`, `targetFreqHz/targetRateHz`,
  events `onIq(Int8Array)`, `onLog`, `onStatus`). Drivers: `hackrf.ts` (HackRF / Pro / PortaPack in HackRF mode),
  `rtlsdr.ts`. Both deliver **signed int8 interleaved IQ**. `APP_NEEDS` + `blockedBecause()` grey out apps a radio
  can't do. `fileradio.ts` (kind `'file'`) plays recordings through the same interface; formats and metadata in
  `src/filesrc/`. OPEN REC lives in the no-radio strip (`#rm-openrec`); `#playbar` shows while a file plays.
- Export bus (`src/export/`): listens to the worker beside the page (`exportBus.attach` in `ensureWorker`), turns
  messages into `DecodeEvent`s (`event.ts`), sends them to sinks (`sinks.ts`) in wire formats (`formats.ts`). A new
  decoder is exported for free as `line` events; for a structured kind, map its worker message in `EventAdapter`.
- Audio in (`audioradio.ts`, kind `'audio'`): audio → IQ (`audiosrc/audio2iq.ts`) in the mode the app's demodulator
  undoes (`modForMode`), at the app's channel (`state.ham.freq` in Ham Radio, else `state.freq`). AUDIO IN: `#rm-audioin`.
- Voice recording (`voice/`): taps the player node in `ensureAudio` (before MUTE); `voiceMeta()` in main.ts says
  what each app has on the air (Dispatch: `nowPlaying`; Repeaters: the playing tile). Files in OPFS `voice/`.
- Capture: upstream's worker recorder writes `.c8` + `.txt`; `capture-sigmf.ts` adds `.sigmf-meta` and the `.sigmf`
  archive download from the page (`sigmf.ts` builds both).
- `src/dsp/`: one decoder per file or folder. `src/credits.ts`: the credits roll.

## Pattern: a decoder (DSP side)

1. Implement `IqProcessor` (`src/dsp/core.ts:6`): `reset(rate)`, `onIq(iq: Int8Array, rate)`; optionally
   `wantsFm = true` + `onFm(samples, n, rate)` to get the worker's NFM discriminator instead of raw IQ.
   Constructor takes `emit: Emit`; publish `emit({ type: 'packet', line })` for the log and an app-specific
   message (e.g. `{type:'stations', rows}`) for cards. Optional `clear()` / `tuned()` are called by the worker.
   Helpers in `core.ts`: `DiscFilter`, `BitSync`, `BitReader`, `HdlcFramer`, `popcount32`.
2. Instantiate it once at the top of `src/dsp.worker.ts` (e.g. `ais` at :85, `btle` at :124) and return it from
   `makeProcessor()` (`dsp.worker.ts:502`), keyed by the app id. App-specific commands are extra `case`s in
   `self.onmessage` (e.g. `'btleChannel'` at ~:433).
3. Reference decoders end to end: `dsp/btle.ts` (raw IQ, GFSK, CRC-24) and `dsp/ais.ts`, `dsp/aprs.ts` (own
   channelizer + AFSK + `HdlcFramer`).

rtl_433-style OOK/FSK devices: a file in `src/dsp/r433/devices/` that calls `register({...})` from
`dsp/r433/device.ts` (see `ambient.ts`), imported in `devices/index.ts` (order = priority).

## Pattern: an app (UI side, `src/main.ts`)

Copy how `btle`, `ais` or `pager` are wired:
- `type AppId` union (:94) and the `APPS: AppDef[]` array (:97): `{ id, title, blurb, cat }`.
- `open()` (:967) → `switch (app)` calls `configure(mode, freq, rate, lna, vga, amp, workerAppId)` (:766),
  e.g. `case 'ais': configure('NFM', 161_975_000, 2e6, 32, 32, false, 'ais')`.
- `render()` (:1955) → `switch` to the app's `renderX(view)`; packet apps share `renderPacket()` (:3933).
- `EMPTY` (:1742): empty-state text and tips. `WF_HIDE` (:4515): apps that hide the waterfall on phones.
- `redraw()` (:8996) and `clearApp()` (:9019): per-app refresh and CLEAR.
- `worker.onmessage` in `ensureWorker()` (:9490): route the decoder's messages to the app's refresh.
- Radio limits: `APP_NEEDS` in `radio.ts`; say in the app's about/empty text when the hardware can't do it.
- Look: existing CSS classes (`panel`, `chip`, `row`, `kv`, `li`, cards + log, waterfall left, controls right).
  No UI framework. Line numbers drift with upstream; grep for the symbol.

## Tests (`web/test/`)

- `node:test` + `node:assert/strict`, TypeScript, bundled by esbuild (no new deps). Import sources from `../src/...js`.
- Synthetic IQ helpers: `test/lib/iq.ts` (seeded noise, AFSK, FM modulation, int8 quantize, `feed()` in 128 KiB
  buffers). Every decoder ships with an encoder → modulator → decoder round trip and a negative case (noise /
  corrupted frame decodes nothing). Fixtures go in `test/fixtures/` only if their license allows redistribution;
  otherwise document the download URL in the test.
- Upstream's root `.gitignore` ignores `web/test/` (their tests live in a private repo); the fork re-includes it.

## Fork rules

1. **Web only.** New work in `web/`. No Kotlin.
2. **Stay mergeable.** Prefer new files (`src/dsp/<name>/`, new UI modules, `src/fork.ts`) plus small registry
   edits in upstream files. **Every edit to an upstream file carries a `// FORK:` comment** (`<!-- FORK -->` in
   HTML; `${'' /* FORK */}` inside template literals; JSON can't — list those below). `grep -rn FORK web/src`
   must show every touch point.
3. Follow existing patterns before inventing new ones.
4. **Licenses:** check the reference project's LICENSE and file headers yourself before porting; GPL-2.0-only is
   NOT compatible. Record it in `docs/ROADMAP.md`. Unclear → implement from the spec. Every port gets a line in
   `src/credits.ts` (project, authors, license).
5. **Receive only.** No new/changed TX. Never decode voice marked encrypted. DECT / cellular: identity and
   metadata only.
6. Every decoder: a test in `web/test/` (synthetic round trip and/or a redistributable recording).
7. One roadmap item per commit / small branch. Tick it in `docs/ROADMAP.md` with a verification note and the
   real-hardware test to run.
8. **Ask first:** large refactors of upstream files, any new runtime dependency, any change to how WebUSB
   devices are claimed.
9. Hardware limits in UI text: HackRF 1 MHz–6 GHz, ≤20 Msps, 8-bit. RTL-SDR ~24–1766 MHz (HF via V3 direct
   sampling / V4 upconverter), ~2.4 Msps. PortaPack H4M must be in HackRF mode (the app switches it over serial).

Fork touch points outside `// FORK:` comments: `web/manifest.webmanifest` (name, short_name),
`web/version.json` (release URL), deleted workflows (`android-*.yml`, `play-*.yml`, `release.yml`).
Fork identity ("Mad Mobile"): `web/src/fork.ts` (plus `index.html` `<title>`/og tags and the manifest).

## Upstream sync (before every phase)

```bash
git fetch upstream
git merge upstream/main
```
- `upstream` = https://github.com/RocketGod-git/mayhem-mobile.git (add with `git remote add upstream ...` if missing).
- Conflicts: take upstream's side everywhere except where a fork feature needs its line; re-apply `// FORK:` edits
  on top of upstream's new code rather than keeping stale copies.
- A modify/delete conflict on an Android/Play/release workflow: `git rm <file>` (the fork keeps them deleted). A
  brand-new upstream workflow that builds Android: delete it in the merge commit.
- After merging: `npm ci && npm run check && npm run build && npm test` in `web/`, then push.
