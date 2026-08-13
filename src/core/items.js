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

/**
 * Return a stable, serializable snapshot of the first visible inventory slots.
 *
 * MiniTibia creates food in the backpack after a food spell.  The game does
 * not expose a reliable food CID, therefore consumers must compare the live
 * slots before/after the spell instead of guessing an item id.  We deliberately
 * cap this scan at twenty visible slots: that is the playable backpack surface,
 * not the entire container graph.
 *
 * @param {Array<object>} containers live container list (readContainers order)
 * @param {number} [limit=20]
 * @returns {Array<{which:number,index:number,cid:number|null,count:number|null,element:object|null}>}
 */
function snapshotVisibleSlots(containers, limit = 20) {
  if (!Array.isArray(containers) || !Number.isInteger(limit) || limit < 1) return [];
  const slots = [];
  for (let which = 0; which < containers.length && slots.length < limit; which++) {
    const source = containers[which] && containers[which].slots;
    if (!Array.isArray(source)) continue;
    for (let offset = 0; offset < source.length && slots.length < limit; offset++) {
      const item = source[offset];
      const indexValue = item && Number(item.index);
      const cidValue = item && Number(item.cid);
      const countValue = item && Number(item.count);
      slots.push({
        which,
        index: Number.isFinite(indexValue) ? indexValue : offset + 1,
        cid: Number.isFinite(cidValue) ? cidValue : null,
        count: Number.isFinite(countValue) ? countValue : null,
        element: item && (item.element || (item.canvas && item.canvas.canvas)) || null,
      });
    }
  }
  return slots;
}

/**
 * Find the single safe candidate that appeared or changed after an action.
 *
 * A candidate must be occupied now and must either fill an empty slot, replace
 * its CID, or increase its stack count.  Existing unchanged objects are never
 * returned, so a trainer cannot eat arbitrary pre-existing inventory items.
 * @param {Array<object>} before snapshotVisibleSlots result before the cast
 * @param {Array<object>} after snapshotVisibleSlots result after the cast
 * @returns {{which:number,index:number,cid:number,count:number|null,element:object|null}|null}
 */
function findCreatedSlotDelta(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const baseline = new Map(before.map((slot) => [String(slot.which) + ':' + String(slot.index), slot]));
  for (const slot of after) {
    // Number(null) is 0 in JavaScript; an empty visible slot must never be
    // promoted into a consumable item because of that coercion.
    if (!slot || slot.cid === null || slot.cid === undefined || !Number.isFinite(Number(slot.cid))) continue;
    const previous = baseline.get(String(slot.which) + ':' + String(slot.index));
    if (!previous || previous.cid === null || previous.cid !== Number(slot.cid)
      || (Number.isFinite(Number(slot.count)) && Number.isFinite(Number(previous.count)) && Number(slot.count) > Number(previous.count))) {
      return slot;
    }
  }
  return null;
}

/**
 * Confirm that a previously-created item was actually consumed.
 *
 * Calling the game's use handler is not proof: MiniTibia can reject the
 * action silently. We only accept consumption when the exact slot disappears,
 * changes item, or its stack count decreases in a fresh visible-slot read.
 *
 * @param {{which:number,index:number,cid:number,count:number|null}} created
 * @param {Array<object>} after fresh snapshotVisibleSlots result
 * @returns {boolean}
 */
function didCreatedSlotConsume(created, after) {
  if (!created || !Array.isArray(after)) return false;
  const beforeCid = Number(created.cid);
  if (!Number.isFinite(beforeCid)) return false;
  const current = after.find((slot) => slot
    && Number(slot.which) === Number(created.which)
    && Number(slot.index) === Number(created.index));
  if (!current || current.cid === null || current.cid === undefined) return true;
  if (Number(current.cid) !== beforeCid) return true;
  const beforeCount = Number(created.count);
  const afterCount = Number(current.count);
  return Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount < beforeCount;
}

module.exports = {
  readContainers,
  findSlotByCid,
  snapshotVisibleSlots,
  findCreatedSlotDelta,
  didCreatedSlotConsume,
};
