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
bun app/entry-compiled.js     # PRIMARY: first attaches to an existing debug-capable
                              # minibia.com/PWA window; if none is found, launches
                              # its own dedicated Chrome and prints the panel URL
```

The control-panel URL is printed at startup:

```
[minibia-desktop-bot] control panel: http://127.0.0.1:<port>
```

Open that URL in your browser — the whole UI lives there: config wizard,
TRAINER tab, mana/CAP bars, rune-check banner, hotkeys. If the panel opens
before a game session is linked, click **Link first PWA** after opening a
`minibia.com` PWA/Chrome window with the remote-debugging port enabled.

### Attach to an already-open Chrome / PWA window

`bun app/entry-compiled.js` already does this first. The helper below is only
when you want **attach-only** behavior and do not want launch fallback.


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

## Known gaps / pending work (as of 2026-08-11)

Audited during the runecheck-trainer-ui close. None of these block the
merged code; they are the honest remainder.

1. **Catalog picker covers only 3 modules.** The spell picker
   (`renderSpellPicker`, `PICKER_MODULES = ['healMagic', 'training',
   'attack']`) lets you select a spell from the client catalog for those
   modules. All other modules — runes, eat, loot, trade, spawns, cavebot —
   are configured with numeric hotbar slots only, not a catalog selector.
   The full catalog is fetched from the client (`/api/spell-catalog`,
   filtered by vocation + level) but the UI does not let you assign a spell
   to every machine.
2. **Config form is hidden until armed.** `renderConfigForm` renders only
   when `gate === GATE_ARMED` (connected); before that the panel shows a
   locked placeholder (`configLocked`). The TRAINER section (rune-making,
   hotkeys, toggles) is part of that form — it is not visible until you
   Connect. Easy to misread as "no configuration exists".
3. **TRAINER rune select vs picker overlap.** The TRAINER form filters the
   catalog with `/rune/i` (name|words); the general picker also lists the
   `training` module. Duplicated selection paths — unify when touched.
4. **Live probe (deferred, CF-blocked posture):** finalize the DOM-overlay
   rune-check selectors (A3, config-optional, default off), confirm the
   real hotbar slot / F-key arrival in `keyboard.__hotbarKeybinds` (B5),
   and refine the exact Cipfried verification wording (A2).
5. **`dist/` binaries are stale.** Built 2026-08-09, before the
   runecheck-trainer-ui change. Rebuild with `node tools/build-app.js`
   before distributing.
6. **Dedicated `sdd-*` sub-agents return empty task results** in this
   environment (`GENTLE_AI_SDD_FAILURE sdd_task_result_empty`, transport
   level; apply ×2, verify ×2 during the runecheck close). Workaround used:
   the general worker under the identical contract, gatekeeper-validated.
   Recorded in the change archive; report upstream when convenient.

Deferred live checks: DOM-overlay selector finalization, real-client
hotkey slot confirmation, exact Cipfried wording.
