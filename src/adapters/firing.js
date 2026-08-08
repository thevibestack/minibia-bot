'use strict';

/**
 * Spell firing adapter (REQ-07/08, design D1).
 *
 * Primary firing path: `hotbarManager.__handleClick(slot)` — the exact path a
 * real keypress takes (preset-independent; the client gate silently drops
 * packets on cooldown/mana, so calling it is safe). Slots are 1–12; anything
 * else is a logged no-op.
 *
 * Optional keyboard-simulation mode (config `firing.mode: "keyboard"`):
 *  1. blurs `document.activeElement` first (chat-input gate, REQ-08),
 *  2. looks up the slot in `keyboard.__hotbarKeybinds`,
 *  3. dispatches a synthetic `keydown` with that keyCode,
 *  4. falls back to `__handleClick` when no keybind exists or the injected
 *     `didCast(slot)` predicate reports no cast resulted.
 *
 * Everything is injected (`gameClient`, `document`, `didCast`, `log`) — no
 * hard-coded globals.
 */

/** Resolve the hotbar manager from the injected gameClient. */
function getHotbar(gameClient) {
  return gameClient?.interface?.hotbarManager ?? gameClient?.hotbarManager ?? null;
}

/** Resolve the keyboard state from the injected gameClient. */
function getKeyboard(gameClient) {
  return gameClient?.interface?.keyboard ?? gameClient?.keyboard ?? null;
}

/**
 * Create a synthetic keydown event carrying the keyCode.
 * @param {Document} doc
 * @param {number} keyCode
 * @returns {Event}
 */
function createKeydown(doc, keyCode) {
  const KeyEvent = doc?.defaultView?.KeyboardEvent;
  const init = { keyCode, which: keyCode, bubbles: true, cancelable: true };
  if (typeof KeyEvent === 'function') {
    try {
      return new KeyEvent('keydown', init);
    } catch {
      // Fall through to the plain event path.
    }
  }
  const evt = new doc.defaultView.Event('keydown', { bubbles: true, cancelable: true });
  evt.keyCode = keyCode;
  evt.which = keyCode;
  return evt;
}

/** Primary path: hotbarManager.__handleClick(slot). */
function fireHandleClick(slot, gameClient, error) {
  const hotbar = getHotbar(gameClient);
  if (!hotbar || typeof hotbar.__handleClick !== 'function') {
    error(`fireSlot: hotbarManager.__handleClick unavailable for slot ${slot}`);
    return false;
  }
  hotbar.__handleClick(slot);
  return true;
}

/**
 * Keyboard-simulation path: blur, keybind lookup, synthetic keydown, fallback.
 */
function fireKeyboard(slot, deps, error, warn) {
  const { gameClient, document: doc, didCast = null } = deps;

  // REQ-08: blur the focused element first (chat input gate).
  if (doc && doc.activeElement && doc.activeElement !== doc.body) {
    if (typeof doc.activeElement.blur === 'function') {
      doc.activeElement.blur();
    }
  }

  const keyboard = getKeyboard(gameClient);
  const keybinds = keyboard?.__hotbarKeybinds ?? {};
  const keyCode = keybinds[slot] ?? keybinds[String(slot)] ?? keybinds['F' + slot];

  // REQ-08: no keybind maps to the slot -> immediate fallback to __handleClick.
  if (keyCode === undefined || keyCode === null) {
    warn(`fireSlot: no keybind for slot ${slot}; falling back to __handleClick (REQ-08)`);
    return fireHandleClick(slot, gameClient, error);
  }

  doc.dispatchEvent(createKeydown(doc, keyCode));

  // REQ-08: if no cast results (injected predicate), fall back to REQ-07.
  if (typeof didCast === 'function' && didCast(slot) === false) {
    warn(`fireSlot: keydown for slot ${slot} produced no cast; falling back to __handleClick`);
    return fireHandleClick(slot, gameClient, error);
  }

  return true;
}

/**
 * Fire the spell bound to a hotbar slot.
 *
 * @param {number} slot - hotbar slot index (1–12)
 * @param {object} [deps]
 * @param {'handleClick'|'keyboard'} [deps.mode='handleClick'] - firing mode
 * @param {object} [deps.gameClient] - page gameClient (hotbarManager/keyboard)
 * @param {Document} [deps.document] - DOM document (keyboard mode)
 * @param {(slot: number) => boolean} [deps.didCast] - keyboard-mode predicate:
 *   false means the keydown produced no cast and __handleClick fallback runs
 * @param {{error?: Function, warn?: Function}} [deps.log] - log sinks
 * @returns {boolean} true when a fire path executed
 */
function fireSlot(slot, deps = {}) {
  const { mode = 'handleClick', gameClient = null, document: doc = null, log = {} } = deps;
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  // REQ-07: slots are 1–12; anything else is a logged no-op.
  if (!Number.isInteger(slot) || slot < 1 || slot > 12) {
    error(`fireSlot: slot ${slot} out of range 1-12; no-op (REQ-07)`);
    return false;
  }

  if (mode === 'keyboard' && doc) {
    return fireKeyboard(slot, { ...deps, gameClient, document: doc }, error, warn);
  }
  return fireHandleClick(slot, gameClient, error);
}

module.exports = { fireSlot };
