# Mini-Tibia Rotation Bot

Auto-rotation bot for [minibia.com/play](https://minibia.com/play): hotbar spell
rotation, food management, jittered cadence, anti-bot rune-check handling, and a
localhost control panel.

## Architecture

Two deployment surfaces share the same engine (`src/core`, `src/adapters`):

- **Desktop app (primary)** — `app/` + `minibia-desktop-agent.js`. A Bun/Node
  process launches (or attaches to) Chrome via CDP
  (`app/cdp/*`, `app/main.ts`), injects the agent bundle with
  `Page.addScriptToEvaluateOnNewDocument` (survives reloads), and serves the
  control panel on `127.0.0.1` only (`app/panel/server.ts`).
- **Userscript (legacy)** — `minibia-rotation-bot.user.js`, a Tampermonkey
  bundle assembled from the same `src/` modules. Kept for reference; the
  project currently runs the desktop app.

The panel is a **separate localhost window**, never drawn over the game page.

## Run

```bash
bun app/entry-compiled.js     # PRIMARY: launches its own dedicated Chrome
                              # (profile keeps login), opens minibia.com/play,
                              # prints the panel URL
```

The control-panel URL is printed at startup:

```
[minibia-desktop-bot] control panel: http://127.0.0.1:<port>
```

Open that URL in your browser — the whole UI lives there: config wizard,
TRAINER tab, mana/CAP bars, rune-check banner, hotkeys.

### Attach to an already-open Chrome / PWA window

```bash
# 1. Relaunch Chrome with the debug port open (close Chrome first — the flag
#    is ignored on an already-running instance):
open -a "Google Chrome" --args --remote-debugging-port=9222

# 2. Open https://minibia.com/play in that window and log in.

# 3. Attach (scans ports 9222-9224, dev-only helper):
bun app/entry-attach.js
```

## Builds

| Command | Produces |
| --- | --- |
| `node tools/build-agent.js` | Regenerates `minibia-desktop-agent.js` from `src/**` (run after any `src/` change; `--check` asserts up to date) |
| `node tools/build-userscript.js` | Regenerates `minibia-rotation-bot.user.js` (legacy; `--check` guarded by `npm test`) |
| `node tools/build-app.js` | Compiles `dist/minibia-desktop-darwin-arm64` + `dist/minibia-desktop-windows-x64.exe` via Bun (`--dry-run` prints the plan) |
| `node tools/extract-catalog.js` | Seeds the spell catalog (once) |

## Test

```bash
npm test        # node:test + jsdom, full suite (unit + e2e wiring)
```

## Feature status

Integrated on `develop`/`main`:

- Rune-check detection (chat + config-gated DOM scan), queue-level pause with
  auto-resume and panel alert (REQ-37..41)
- TRAINER tab redesign: 2-column grid, mana/CAP gradient bars, catalog-filtered
  rune select, confirm-gated stop toggles, hotbar keybind RPC with
  per-character persistence (REQ-42..46)

Deferred (live probe): DOM-overlay selector finalization, real-client hotkey
slot confirmation, exact Cipfried wording.
