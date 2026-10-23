# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads an **Envertech EVT800 micro-inverter** through its local TCP link
("TCP server" mode, port 14889): the inverter sends frames, the integration
acknowledges each one. No cloud. The protocol (not documented by Envertech) is
ported from
[pyenvertechevt800](https://github.com/daniel-bergmann-00/pyenvertech-evt800)
(Daniel Bergmann, MIT, see `THIRD_PARTY_NOTICES.md`). Unofficial: not
affiliated with Envertech. **Read-only**: never `onSetValue`, never a write but
the acknowledgement.
Siblings: `gladys-omnik` (the structure: pace, night, session per address),
`gladys-p1-monitor` (the guard, through gladys-omnik), `gladys-apsystems`
(features per input, `keepCreatedFeatures`).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        EnvertechApp: the pace, the link, the night, the index, buttons
src/evt800/client.js              the only network access (one TCP link, acknowledgements, bounded)
src/evt800/protocol.js            frames -> values, acknowledgement, framing (pure)
src/guard.js                      plausibility of an energy index (gladys-p1-monitor, pure)
src/store.js                      what /data keeps across restarts
src/devices.js                    the device, feature keys, states (pure)
src/config.js                     the form, normalized
src/constants.js                  port, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
scripts/cover.mjs                 the cover image
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys, scripted links, a real local TCP server
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Energy monitoring**: `production_index` (`energy-production-sensor` /
  `index`, with its `thirty-minutes-production` declared with UUID v5 ids) is
  the only index: the sum of the lifetime counters of EVERY input of the
  created device (never a partial sum), through `IndexGuard`
  (`src/guard.js`): never 0, a drop and a jump never confirmed by repetition
  nor by time, taken only by the `accept_held_index` action, bounded to the
  value shown. The counters per input are never published on their own (they
  would be counted twice). Never `publishEnergyConsumption`. Do not change
  `src/guard.js` without the same change in gladys-p1-monitor / gladys-omnik
  and a review.
- **The night is not an error** (see TODO.md "Decisions").
- **The pace**: never two connection attempts less than a minute apart,
  whatever asks; the time of the last attempt is in `/data`, written before
  connecting. A link open is never doubled. Never add a path that skips
  `dueAt()`. Values published at most once a minute, never from a frame older
  than `FRAME_FRESH`.
- **Late frames**: every await is followed by a session check; an old session
  never publishes nor sets a status.
- **Identity**: the serial of each data frame chooses the device; an
  unreadable serial is never "another inverter".
- **Never a text of the inverter in a message**, only our own codes.
- **External ids are forever**: `inverter:<serial>`, the `FEATURE` keys of
  `src/devices.js`, the manifest keys and actions. A republished device keeps
  every feature of the created one (`keepCreatedFeatures`).
- **The container rootfs is read-only.** Write only under `/data`:
  `src/store.js` keeps `/data/envertech-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **User-facing text** is bilingual (English and French): runtime messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM nor control bytes (`test/encoding.test.js`, sources
  included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is not
  a bug in the code.

## Checking frames against a real inverter

By day, on the same LAN, the frames the inverter sends (hide the serial
numbers before a frame becomes a fixture):

```bash
nc 192.168.1.80 14889 | xxd | head
```

Without acknowledgements the inverter may stop after its first frame.
