'use strict';

const { createPremiumReader } = require('../../core/premium');

/**
 * Auto-loot list module (REQ-19, design "Loot" row, task 5.2).
 *
 * Ports the game's Hub -> Automations "Auto-Loot List" model: a destination
 * PER MONSTER plus a default destination for "everything without its own
 * destination" (mirror the game's Loot List, obs 10312). v1 = configuration
 * + decision module: when a monster is killed and loot is available, the
 * module routes the loot to the configured destination.
 *
 * - `route(monster)` (pure): per-monster destination wins; otherwise the
 *   default destination; none configured => no route (recorded, no fire).
 * - Kill feed: `observeKills(kills)` consumes kill observations from the
 *   shared active-creature diff observer (core/kills); only kills WITH loot
 *   info (`loot === true`) enter the bounded pending queue.
 * - Fire path: the game's loot-command surface is FEATURE-DETECTED
 *   (unprobed — tools/automations-probe.js 5.2 dumps candidates). When the
 *   surface is absent the module records "no native loot command" (honest
 *   panel state) and never invokes anything — degrade = record/no-op.
 * - Premium gate (REQ-22): the game's auto-loot is premium-gated; an
 *   explicit non-premium account reports "Premium required" and never fires.
 *   Unknown premium state never blocks.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const PENDING_CAP = 50;

/**
 * Create the loot routing module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized loot config
 *   { on: boolean, defaultDest: string|null, perMonster: Object<string,string> }
 * @param {() => Function|null} [opts.readLootCommand] - feature-detected game
 *   loot-command function (monster, destination) => void; null = unavailable
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   route: (monster: string) => {dest: string|null, source: string},
 *   observeKills: (kills: Array<{name: string|null, loot: boolean|null}>) => void,
 *   decide: () => {fire: boolean, reason: string, item?: object, route?: object},
 *   fire: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createLootModule(opts = {}) {
  const { config, readLootCommand = null, readPremium = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  const state = {
    pending: [],
    available: true,
    reason: 'ok',
    lastRouted: null,
  };

  // Eager premium read (REQ-22): panel-facing state computed on getState —
  // shared reader (core/premium) so every gated module exposes the same shape.
  const currentPremium = createPremiumReader(readPremium);

  /**
   * Pure destination resolution (REQ-19): per-monster first, then the default
   * ("everything without its own destination"), else none.
   * @param {string} monster - killed monster name
   * @returns {{dest: string|null, source: 'per-monster'|'default'|'none'}}
   */
  function route(monster) {
    const name = String(monster || '');
    if (!name) return { dest: null, source: 'none' };
    const per = config && config.perMonster && config.perMonster[name];
    if (typeof per === 'string' && per.trim()) return { dest: per, source: 'per-monster' };
    const def = config && config.defaultDest;
    if (typeof def === 'string' && def.trim()) return { dest: def, source: 'default' };
    return { dest: null, source: 'none' };
  }

  /**
   * Consume kill observations (from the shared kill observer, core/kills).
   * Only kills WITH loot info (`loot === true`) can be routed; the pending
   * queue is bounded so a spammy feed cannot grow unboundedly.
   * @param {Array<{name: string|null, loot: boolean|null}>} kills
   */
  function observeKills(kills = []) {
    if (!Array.isArray(kills)) return;
    for (const kill of kills) {
      if (!kill || kill.loot !== true) continue; // no loot info => nothing to route
      const monster = kill.name || 'unknown';
      if (state.pending.some((p) => p.monster === monster && p.at === kill.at)) continue;
      state.pending.push({ monster, at: now() });
      if (state.pending.length > PENDING_CAP) state.pending.shift();
    }
  }

  /**
   * Pure decision: pending routable kill + a configured destination -> fire.
   * @returns {{fire: boolean, reason: string, item?: object, route?: object}}
   */
  function decide() {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const premium = currentPremium();
    if (premium.blocked) {
      state.reason = 'premium-required';
      return { fire: false, reason: 'premium-required' };
    }
    if (state.available === false) return { fire: false, reason: 'no-native-loot-command' };
    if (state.pending.length === 0) return { fire: false, reason: 'no-pending' };
    const item = state.pending[0];
    const r = route(item.monster);
    if (!r.dest) return { fire: false, reason: 'no-destination' };
    state.reason = 'ok';
    return { fire: true, reason: 'routed', item, route: r };
  }

  /**
   * Execute the loot route (QUEUE-DISPATCHED ONLY, REQ-12). Degrade: no
   * native loot command => record + no-op, and the module stops deciding
   * (honest panel state; no re-enqueue churn). On success the pending item
   * drains.
   * @param {{item: {monster: string}, route: {dest: string}}} decision
   * @returns {boolean} true when the game loot command executed
   */
  function fire(decision = {}) {
    const cmd = typeof readLootCommand === 'function' ? readLootCommand() : null;
    if (typeof cmd !== 'function') {
      state.available = false;
      state.reason = 'no native loot command';
      error('loot: no native loot command surface — routing skipped (degrade)');
      return false;
    }
    state.available = true;
    state.reason = 'ok';
    const item = decision.item || {};
    try {
      cmd(item.monster, decision.route && decision.route.dest);
      state.pending.shift();
      state.lastRouted = { monster: item.monster, dest: decision.route && decision.route.dest, at: now() };
      return true;
    } catch (e) {
      error('loot: loot command failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const per = config && config.perMonster && typeof config.perMonster === 'object' ? config.perMonster : {};
    return {
      on: Boolean(config && config.on === true),
      available: config && config.on === true ? state.available : false,
      reason: config && config.on === true ? state.reason : 'off',
      defaultDest: (config && config.defaultDest) || null,
      perMonsterCount: Object.keys(per).length,
      pendingCount: state.pending.length,
      lastRouted: state.lastRouted,
      premium: currentPremium(),
    };
  }

  return { route, observeKills, decide, fire, getState, isEnabled };
}

module.exports = { createLootModule, PENDING_CAP };
