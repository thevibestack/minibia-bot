'use strict';

/**
 * LIVE probe harness — ported-automation surfaces (tasks 5.2/5.3/5.4/5.5,
 * REQ-18..22). NOT part of `npm test` (needs a real Chrome with a logged-in
 * minibia.com session on a debug port).
 *
 * Usage: node tools/automations-probe.js --port <debug-port>
 *
 * Purpose: the slice-5 modules feature-detect the game's automation surfaces;
 * this probe dumps their EXACT shapes on the live client so the candidate
 * orders can be confirmed:
 *   - Trade channel send (REQ-18): channelManager.getChannelById(2) + the
 *     channel's send method candidates.
 *   - Loot destinations (REQ-19): where the game stores the Auto-Loot List
 *     (per-monster destinations + default) and its command surface.
 *   - Spawn maps (REQ-20): the spawn-data structure (loaded on demand per
 *     obs 10320).
 *   - Hunt counters (REQ-21): player XP/gold fields + world.activeCreatures
 *     entry shape (name/loot fields for the kill diff).
 *   - Premium state (REQ-22): the account premium field candidates.
 *
 * Non-blocking by design: every degrade path is ALREADY implemented ("no
 * native trade channel", "no native loot command", "no spawn data",
 * "no data" hunt metrics, premium unknown never blocks). The probe is
 * READ-ONLY (Runtime.evaluate enumeration only — it never sends, never
 * routes, never mutates state).
 *
 * Exits 0 with findings, or 1 when no game target is reachable.
 */

const { buildScanUrl, filterTargets } = require('../app/cdp/targets.ts');
const bridge = require('../app/cdp/bridge.ts');

const AUTOMATIONS_PROBE_EXPRESSION = `(function () {
  var out = { present: {}, detail: [] };
  function report(key, value) {
    try {
      out.present[key] = { typeof: typeof value, value: value === null ? null : (typeof value === 'object' ? '[object]' : String(value)) };
    } catch (e) { out.detail.push({ key: key, error: String(e) }); }
  }
  function fnNames(obj, max) {
    if (!obj || typeof obj !== 'object') return null;
    var names = [];
    for (var k in obj) { try { if (typeof obj[k] === 'function') names.push(k); } catch (e) {} }
    return names.slice(0, max || 20);
  }
  try {
    var gc = window.gameClient;
    if (!gc) { out.detail.push({ note: 'window.gameClient is not defined yet' }); return out; }
    var cm = (gc.interface && gc.interface.channelManager) || gc.channelManager;
    if (cm) {
      report('channelManager.getChannelById', cm.getChannelById);
      report('channelManager.getChannel', cm.getChannel);
      var trade = (typeof cm.getChannelById === 'function' ? cm.getChannelById(2) : null) || null;
      if (trade) {
        out.detail.push({ tradeChannelKeys: Object.keys(trade).slice(0, 30) });
        out.detail.push({ tradeChannelSendCandidates: fnNames(trade, 20) });
        report('tradeChannel.send', trade.send);
        report('tradeChannel.sendMessage', trade.sendMessage);
        report('tradeChannel.sendChat', trade.sendChat);
      } else {
        out.detail.push({ note: 'channelManager has no resolvable Trade channel (id 2)' });
      }
    } else {
      out.detail.push({ note: 'channelManager not found' });
    }
    // Loot surfaces (REQ-19)
    report('gameClient.lootCommands', gc.lootCommands);
    report('gameClient.autoLoot', gc.autoLoot);
    report('gameClient.lootManager', gc.lootManager);
    report('gameClient.loot', gc.loot);
    if (gc.lootCommands) out.detail.push({ lootCommandKeys: Object.keys(gc.lootCommands).slice(0, 30) });
    if (gc.autoLoot) out.detail.push({ autoLootKeys: Object.keys(gc.autoLoot).slice(0, 30) });
    // Spawn maps (REQ-20)
    var world = gc.world;
    report('gameClient.spawns', gc.spawns);
    report('world.spawns', world && world.spawns);
    report('gameClient.spawnMap', gc.spawnMap);
    report('gameClient.monsterSpawns', gc.monsterSpawns);
    report('world.spawnData', world && world.spawnData);
    // Hunt counters (REQ-21)
    var p = gc.player;
    if (p) {
      report('player.state.xp', p.state && p.state.xp);
      report('player.xp', p.xp);
      report('player.state.gold', p.state && p.state.gold);
      report('player.gold', p.gold);
      report('player.state.money', p.state && p.state.money);
    }
    report('world.activeCreatures', world && world.activeCreatures);
    if (world && Array.isArray(world.activeCreatures) && world.activeCreatures[0]) {
      out.detail.push({ activeCreatureEntryKeys: Object.keys(world.activeCreatures[0]).slice(0, 30) });
    }
    // Premium (REQ-22)
    report('player.premium', p && p.premium);
    report('player.state.premium', p && p.state && p.state.premium);
    report('player.premiumUntil', p && p.premiumUntil);
    report('gameClient.premium', gc.premium);
    report('gameClient.account', gc.account);
    if (gc.account) out.detail.push({ accountKeys: Object.keys(gc.account).slice(0, 30) });
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
    console.error('usage: node tools/automations-probe.js --port <1024-65535>');
    process.exit(2);
  }

  let list = null;
  try {
    list = await (await fetch(buildScanUrl(port))).json();
  } catch (e) {
    console.error('PROBE SKIPPED: no debug endpoint on 127.0.0.1:' + port + ' (' + (e && e.message ? e.message : e)
      + '). Degrade paths active: "no native trade channel" / "no native loot command" / "no spawn data" / "no data" hunt metrics / premium unknown never blocks — run this probe from a live session to confirm the candidate shapes.');
    process.exit(1);
  }
  const found = filterTargets(list);
  if (found.length === 0) {
    console.error('PROBE SKIPPED: no minibia.com page target on 127.0.0.1:' + port
      + ' (list: ' + JSON.stringify(list).slice(0, 200) + '). Degrade paths active (see above).');
    process.exit(1);
  }

  const target = found[0];
  const session = await bridge.attachTarget({ url: target.webSocketDebuggerUrl });
  try {
    await bridge.enablePageDomains(session);
    const result = await bridge.evaluate(session, AUTOMATIONS_PROBE_EXPRESSION);
    console.log('PROBE target: ' + target.url);
    console.log('PROBE result: ' + JSON.stringify(result, null, 2));
    console.log('PROBE OK — update the feature-detect candidate orders in src/agent/bootstrap.js if any candidate differs from the shipped default.');
  } finally {
    session.close();
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('PROBE ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
