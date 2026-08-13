'use strict';

/**
 * Mana-potion module. It deliberately mirrors heal-items' native use-on-self
 * path, but its decision gate is current mana instead of health. The module
 * only consumes CIDs that the player selected from the live inventory.
 */

const { readContainers, findSlotByCid } = require('../../core/items');

function defaultFindSlot(gameClient, cids) {
  return findSlotByCid(readContainers(gameClient), cids);
}

function createManaItems(opts = {}) {
  const { config, findSlot = null, gameClient = null, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const threshold = Number(config.threshold);
    if (!Number.isFinite(threshold)) return { fire: false, reason: 'no-threshold' };
    if (ctx.mana === null || ctx.mana === undefined) return { fire: false, reason: 'no-mana' };
    if (ctx.mana > threshold) return { fire: false, reason: 'mana-ok' };
    const item = typeof findSlot === 'function' ? findSlot() : null;
    if (!item) return { fire: false, reason: 'no-item' };
    return { fire: true, reason: 'low-mana', item };
  }

  function fire(item) {
    const gc = typeof gameClient === 'function' ? gameClient() : gameClient;
    const hotbar = gc && ((gc.interface && gc.interface.hotbarManager) || gc.hotbarManager);
    if (hotbar && typeof hotbar.__useItemOnSelf === 'function') {
      try {
        const result = hotbar.__useItemOnSelf({ which: item.which ?? 3, index: item.index });
        if (result !== false) return true;
      } catch (e) { /* fall through */ }
    }
    const mouse = gc && gc.mouse;
    if (mouse && typeof mouse.use === 'function') {
      mouse.use({ which: item.which ?? 3, index: item.index });
      return true;
    }
    error('mana-items: no game handler available (__useItemOnSelf / mouse.use)');
    return false;
  }

  function isEnabled() { return Boolean(config && config.on === true); }

  return { decide, fire, isEnabled };
}

module.exports = { createManaItems, defaultFindSlot };
