'use strict';

/**
 * Heal-with-items module (REQ-13, design "Heal items" row).
 *
 * Optional, user-activated. Decision: when the player's health is at or below
 * the configured threshold and a potion whose cid is in `slotCids` is found in
 * the container state, the module decides a use-on-self action. Module OFF
 * (default) => the decision is always 'off' and no action can be enqueued
 * (toggle honored at the tree condition).
 *
 * Game action (REQ-06 handler boundary — never a state write):
 *   1. Primary: `hotbarManager.__useItemOnSelf({which, index})` — live-probed
 *      action (obs 10320). Signature best-effort; a throw falls through.
 *   2. Fallback: `gameClient.mouse.use({which: 3, index})` — the proven
 *      userscript right-click-use path (same shape as adapters/eat).
 * The fire() function is invoked ONLY inside a queue-dispatched closure
 * (REQ-12 no-bypass) — the module never touches handlers during a tree tick.
 *
 * Reads (container snapshot, health) are injectable so the decision logic is
 * fully node-testable; the default finder scans the live-probed container
 * sources (src/core/items.js).
 */

const { readContainers, findSlotByCid } = require('../../core/items');

/**
 * Default item finder: scan the probe-order container sources for the first
 * slot whose cid is in the configured list.
 * @param {object|null} gameClient - page gameClient
 * @param {Array<number>} cids - wanted item cids
 * @returns {{which: number, index: number, element: object|null}|null}
 */
function defaultFindSlot(gameClient, cids) {
  return findSlotByCid(readContainers(gameClient), cids);
}

/**
 * Create the heal-items decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized healItems config
 *   { on: boolean, threshold: number, slotCids: Array<number> }
 * @param {() => ({which: number, index: number}|null)} [opts.findSlot] -
 *   injected item finder (default: container-scan by slotCids)
 * @param {object|null} [opts.gameClient] - page gameClient (fire path);
 *   may be a lazy getter-compatible object (bootstrap passes a live object)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, item?: object},
 *   fire: (item: object) => boolean,
 *   isEnabled: () => boolean,
 * }}
 */
function createHealItems(opts = {}) {
  const { config, findSlot = null, gameClient = null, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  /**
   * Pure decision (REQ-13): health <= threshold AND item present -> fire.
   * @param {object} ctx - tick context { health }
   * @returns {{fire: boolean, reason: string, item?: object}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const threshold = Number(config.threshold);
    if (!Number.isFinite(threshold)) return { fire: false, reason: 'no-threshold' };
    if (ctx.health === null || ctx.health === undefined) return { fire: false, reason: 'no-health' };
    if (ctx.health > threshold) return { fire: false, reason: 'healthy' };
    const item = typeof findSlot === 'function' ? findSlot() : null;
    if (!item) return { fire: false, reason: 'no-item' };
    return { fire: true, reason: 'low-hp', item };
  }

  /**
   * Execute the use-on-self action (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{which: number, index: number}} item - found potion slot
   * @returns {boolean} true when a game handler executed
   */
  function fire(item) {
    const gc = typeof gameClient === 'function' ? gameClient() : gameClient;
    const hotbar = gc && ((gc.interface && gc.interface.hotbarManager) || gc.hotbarManager);
    // Primary: live-probed use-on-self action (obs 10320). Signature unprobed
    // => best-effort with a throw falling through to the proven mouse.use path.
    if (hotbar && typeof hotbar.__useItemOnSelf === 'function') {
      try {
        const result = hotbar.__useItemOnSelf({ which: item.which ?? 3, index: item.index });
        if (result !== false) return true;
      } catch (e) { /* fall through to mouse.use */ }
    }
    const mouse = gc && gc.mouse;
    if (mouse && typeof mouse.use === 'function') {
      mouse.use({ which: item.which ?? 3, index: item.index });
      return true;
    }
    error('heal-items: no game handler available (__useItemOnSelf / mouse.use)');
    return false;
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, isEnabled };
}

module.exports = { createHealItems, defaultFindSlot };
