'use strict';

/**
 * Food eating adapter (REQ-05/06, design D2).
 *
 * Primary path: synthetic `contextmenu` on the food slot element, then click
 * the menu's "Use" entry. Fallback: `gameClient.mouse.use({which, index})`.
 * SATED is re-checked before (skip when already sated) and after (confirm the
 * attempt landed). When SATED data is unavailable, a successfully executed
 * attempt is trusted ('ate'), which is what enables the REQ-06 fallback
 * interval cadence. After `maxFailures` consecutive failed attempts the eater
 * pauses itself and surfaces a HUD alert (REQ-06).
 *
 * Fully injectable: `gameClient`, `document`, `isSated`, `findUseEntry`,
 * `setPaused`, `hudAlert`, `log` — no hard-coded globals.
 */

/**
 * Create the eater state machine.
 *
 * @param {object} [deps]
 * @param {object} [deps.gameClient] - page gameClient (mouse.use fallback)
 * @param {Document} [deps.document] - DOM document (contextmenu + menu lookup)
 * @param {() => boolean|null} [deps.isSated] - SATED check; null = unavailable
 * @param {number} [deps.maxFailures=3] - consecutive failures before pausing
 * @param {(doc: Document) => Element|null} [deps.findUseEntry] - menu scanner;
 *   default finds an element whose trimmed text is exactly "Use"
 * @param {(paused: boolean) => void} [deps.setPaused] - pause hook (REQ-06)
 * @param {(message: string) => void} [deps.hudAlert] - HUD alert hook (REQ-06)
 * @param {{error?: Function, warn?: Function}} [deps.log] - log sinks
 * @returns {{
 *   eatFood: (item: object|null) => {result: string, reason: string, attempts: number, paused: boolean},
 *   getFailures: () => number,
 *   resetFailures: () => void,
 *   isPaused: () => boolean,
 * }}
 */
function createEater(deps = {}) {
  const {
    gameClient = null,
    document: doc = null,
    isSated = null,
    maxFailures = 3,
    findUseEntry = defaultFindUseEntry,
    setPaused = null,
    hudAlert = null,
    log = {},
  } = deps;
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};

  let failures = 0;
  let paused = false;

  /** Dispatch a synthetic right-click contextmenu on the slot element. */
  function dispatchContextMenu(element) {
    const MouseEventCtor = doc?.defaultView?.MouseEvent;
    const init = { bubbles: true, cancelable: true, button: 2 };
    if (typeof MouseEventCtor === 'function') {
      element.dispatchEvent(new MouseEventCtor('contextmenu', init));
      return;
    }
    const evt = new doc.defaultView.Event('contextmenu', { bubbles: true, cancelable: true });
    evt.button = 2;
    element.dispatchEvent(evt);
  }

  /**
   * Attempt the proven contextmenu -> "Use" path.
   * @param {Element} element - the food backpack slot element
   * @returns {boolean} true when the "Use" menu entry was clicked
   */
  function tryContextMenuUse(element) {
    if (!element || typeof element.dispatchEvent !== 'function') return false;
    dispatchContextMenu(element);
    const useEntry = typeof findUseEntry === 'function' ? findUseEntry(doc) : null;
    if (!useEntry || typeof useEntry.click !== 'function') return false;
    useEntry.click();
    return true;
  }

  /** Fallback path: gameClient.mouse.use({which, index}). */
  function tryMouseUse(item) {
    const mouse = gameClient?.mouse;
    if (!mouse || typeof mouse.use !== 'function') return false;
    mouse.use({
      which: item?.which ?? 3, // right button
      index: item?.index ?? item?.slot?.index,
    });
    return true;
  }

  /**
   * Attempt to eat the given food item.
   *
   * @param {object|null} item - { slot: {element, index}, cid, which, index }
   * @returns {{result: 'ate'|'failed'|'no-food', reason: string,
   *   attempts: number, paused: boolean}}
   */
  function eatFood(item = null) {
    // REQ-05: re-check SATED before eating.
    if (typeof isSated === 'function' && isSated() === true) {
      return { result: 'no-food', reason: 'already-sated', attempts: failures, paused };
    }

    const element = item?.slot?.element ?? null;
    const hasElementPath = element !== null && element !== undefined;
    const mouse = gameClient?.mouse;
    const hasMousePath = mouse !== null && mouse !== undefined && typeof mouse.use === 'function';

    if (!hasElementPath && !hasMousePath) {
      return { result: 'no-food', reason: 'no-food-source', attempts: failures, paused };
    }

    let executed = false;
    if (hasElementPath) {
      executed = tryContextMenuUse(element);
    }
    if (!executed && hasMousePath) {
      executed = tryMouseUse(item);
    }

    // REQ-05: re-check SATED after the attempt.
    const satedNow = typeof isSated === 'function' ? isSated() : null;
    if (executed && (satedNow === true || satedNow === null)) {
      failures = 0;
      return { result: 'ate', reason: satedNow === true ? 'sated' : 'attempted', attempts: 0, paused };
    }

    // REQ-06: consecutive failure accounting; pause + HUD alert at the cap.
    failures += 1;
    if (failures >= maxFailures && !paused) {
      paused = true;
      if (typeof setPaused === 'function') setPaused(true);
      const message = `eating failed ${failures} consecutive times; eating paused (REQ-06)`;
      if (typeof hudAlert === 'function') hudAlert(message);
      error(message);
    }
    return {
      result: 'failed',
      reason: executed ? (satedNow === false ? 'not-sated' : 'unconfirmed') : 'no-use-entry',
      attempts: failures,
      paused,
    };
  }

  return {
    eatFood,
    /** @returns {number} consecutive failed attempts */
    getFailures: () => failures,
    /** Reset the consecutive-failure counter (e.g. after SATED arrives). */
    resetFailures: () => {
      failures = 0;
    },
    /** @returns {boolean} whether eating is paused after repeated failures */
    isPaused: () => paused,
  };
}

/**
 * Default menu scanner: the first element whose trimmed text is exactly "Use".
 * @param {Document|null} doc
 * @returns {Element|null}
 */
function defaultFindUseEntry(doc) {
  if (!doc?.querySelectorAll) return null;
  const candidates = doc.querySelectorAll('div, li, button, span, a, td');
  for (const el of candidates) {
    if (el.textContent.trim() === 'Use') return el;
  }
  return null;
}

module.exports = { createEater };
