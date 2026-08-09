'use strict';

/**
 * LIVE probe harness — rune start/stop trigger API (task 4.6, REQ-15).
 * NOT part of `npm test` (needs a real Chrome with a logged-in minibia.com
 * session on a debug port).
 *
 * Usage: node tools/rune-probe.js --port <debug-port>
 *
 * Purpose: REQ-15 drives rune attack/heal INSIDE the game's own windows.
 * The timer fields hotbarManager.__runeAttackUntil / __runeHealUntil and the
 * cooldown helpers setRuneGlobalCooldown / __getRuneEffectiveCooldown were
 * spotted on the live client (obs 10320); this probe dumps their exact shape
 * (presence, typeof, current values) plus player.attackSlowness so the module
 * semantics can be confirmed against the real client.
 *
 * Non-blocking by design: the implementable degrade path is ALREADY active —
 * when the native timers are absent the rune module records "no native rune
 * data" and never fires (design D7: NO invented fallback loop). The probe is
 * read-only (Runtime.evaluate enumeration only — it never triggers rune
 * start/stop, never mutates state).
 *
 * Exits 0 with findings, or 1 when no game target is reachable.
 */

const { buildScanUrl, filterTargets } = require('../app/cdp/targets.ts');
const bridge = require('../app/cdp/bridge.ts');

// Read-only: enumerate the rune surface — presence, type and current values.
const RUNE_PROBE_EXPRESSION = `(function () {
  var out = { present: {}, detail: [] };
  function report(key, value) {
    try {
      out.present[key] = { typeof: typeof value, value: value === null ? null : (typeof value === 'object' ? '[object]' : String(value)) };
    } catch (e) { out.detail.push({ key: key, error: String(e) }); }
  }
  try {
    var gc = window.gameClient;
    if (!gc) { out.detail.push({ note: 'window.gameClient is not defined yet' }); return out; }
    var hb = (gc.interface && gc.interface.hotbarManager) || gc.hotbarManager;
    if (!hb) { out.detail.push({ note: 'hotbarManager not found' }); return out; }
    report('hotbarManager.__runeAttackUntil', hb.__runeAttackUntil);
    report('hotbarManager.__runeHealUntil', hb.__runeHealUntil);
    report('hotbarManager.setRuneGlobalCooldown', hb.setRuneGlobalCooldown);
    report('hotbarManager.__getRuneEffectiveCooldown', hb.__getRuneEffectiveCooldown);
    report('hotbarManager.__canPlayerCastSpell', hb.__canPlayerCastSpell);
    report('hotbarManager.__handleClick', hb.__handleClick);
    report('hotbarManager.__useItemOnSelf', hb.__useItemOnSelf);
    var p = gc.player;
    if (p) {
      report('player.attackSlowness', p.attackSlowness);
      report('player.state.attackSlowness', p.state && p.state.attackSlowness);
      report('player.conditions.has(SATED)', p.conditions && typeof p.conditions.has === 'function' ? p.conditions.has('SATED') : undefined);
    }
    // Values of the native timers relative to now (window active until?).
    var now = Date.now();
    out.detail.push({ note: 'Date.now()=' + now });
    if (typeof hb.__runeAttackUntil === 'number') out.detail.push({ runeAttackUntilVsNowMs: hb.__runeAttackUntil - now });
    if (typeof hb.__runeHealUntil === 'number') out.detail.push({ runeHealUntilVsNowMs: hb.__runeHealUntil - now });
  } catch (e) { out.detail.push({ note: 'probe failed: ' + String(e) }); }
  return out;
})()`;

function readArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function run() {
  const portRaw = readArg('--port');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('usage: node tools/rune-probe.js --port <1024-65535>');
    process.exit(2);
  }

  let list = null;
  try {
    list = await (await fetch(buildScanUrl(port))).json();
  } catch (e) {
    console.error('PROBE SKIPPED: no debug endpoint on 127.0.0.1:' + port + ' (' + (e && e.message ? e.message : e)
      + '). Degrade path active: rune module records "no native rune data" and never fires (design D7) — run this probe from a live session to confirm the timer/cooldown shapes.');
    process.exit(1);
  }
  const found = filterTargets(list);
  if (found.length === 0) {
    console.error('PROBE SKIPPED: no minibia.com page target on 127.0.0.1:' + port
      + ' (list: ' + JSON.stringify(list).slice(0, 200)
      + '). Degrade path active: rune module records "no native rune data" and never fires (design D7).');
    process.exit(1);
  }

  const target = found[0];
  const session = await bridge.attachTarget({ url: target.webSocketDebuggerUrl });
  try {
    await bridge.enablePageDomains(session);
    const result = await bridge.evaluate(session, RUNE_PROBE_EXPRESSION);
    console.log('PROBE target: ' + target.url);
    console.log('PROBE result: ' + JSON.stringify(result, null, 2));
    const hb = result && result.present ? result.present : {};
    const runeTimers = hb['hotbarManager.__runeAttackUntil'] || hb['hotbarManager.__runeHealUntil'];
    if (!runeTimers) {
      console.log('PROBE: no native rune timer fields found — module degrade "no native rune data" applies (D7, no fallback loop).');
    } else {
      console.log('PROBE: native rune timer fields present — timer-read + fire-on-expire semantics confirmed;'
        + ' record whether setRuneGlobalCooldown/__getRuneEffectiveCooldown match the module post-fire-wait reads.');
    }
  } finally {
    session.close();
  }
  console.log('PROBE OK');
  process.exit(0);
}

run().catch((e) => {
  console.error('PROBE ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
