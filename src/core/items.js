'use strict';

/**
 * Container slot lookup (REQ-13/17, design "Heal items"/"Eat" module table).
 *
 * Pure, node-testable helpers for finding a usable item slot inside the
 * client's container state. The container SOURCES are live-probed (the
 * userscript resolves food slots from the same locations — see the eat rule
 * in tools/build-userscript.js): gameClient.containerPrototype,
 * gameClient.backpack, gameClient.interface.containerPrototype and
 * gameClient.player.containers (desktop-agent addition). Each source exposes
 * a `slots` array; slots carry `cid` (item id), `index` (mouse.use index) and
 * optionally a DOM `element`/`canvas.canvas` for the contextmenu path.
 *
 * Reads are pure: given the containers snapshot + the wanted cids, return the
 * first matching slot descriptor or null. Unknown container shapes degrade to
 * null ("no item") — the module then takes NO action (safe degrade, REQ-06
 * read-only boundary).
 */

/**
 * Resolve the list of container objects to scan, in probe order.
 * @param {object|null} gameClient - page gameClient
 * @returns {Array<object>} container objects (deduped, non-null)
 */
function readContainers(gameClient) {
  const gc = gameClient;
  if (!gc || typeof gc !== 'object') return [];
  const list = [
    gc.containerPrototype,
    gc.backpack,
    (gc.interface && gc.interface.containerPrototype) || null,
  ];
  const playerContainers = gc.player && gc.player.containers;
  if (Array.isArray(playerContainers)) {
    list.push.apply(list, playerContainers);
  } else if (playerContainers) {
    list.push(playerContainers);
  }
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Find the first container slot whose cid is in the wanted list.
 *
 * @param {Array<object>} containers - container objects (each with `.slots`)
 * @param {Array<number|string>} [cids] - item cids to match (numbers/strings)
 * @returns {{which: number, index: number, element: object|null}|null}
 *   - `which`: position of the container in the scan order
 *   - `index`: the slot's own mouse-use index (1-based), or its 1-based
 *     position in the slots array when the slot carries no index
 *   - `element`: the slot's DOM element when exposed (contextmenu path)
 *   Returns null when nothing matches or the shape is unknown.
 */
function findSlotByCid(containers, cids) {
  if (!Array.isArray(containers)) return null;
  const wanted = new Set((cids || []).map(Number).filter(Number.isFinite));
  if (wanted.size === 0) return null;
  for (let c = 0; c < containers.length; c++) {
    const container = containers[c];
    const slots = container && container.slots;
    if (!slots || !Array.isArray(slots)) continue;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || typeof slot !== 'object') continue;
      if (!wanted.has(Number(slot.cid))) continue;
      const ownIndex = Number(slot.index);
      return {
        which: c,
        index: Number.isFinite(ownIndex) ? ownIndex : i + 1,
        element: slot.element || (slot.canvas && slot.canvas.canvas) || null,
      };
    }
  }
  return null;
}

module.exports = { readContainers, findSlotByCid };
