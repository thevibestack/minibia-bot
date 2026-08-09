'use strict';

/**
 * Kill observation via active-creature diffs (REQ-21/REQ-19 feed, task 5.4).
 *
 * The game keeps the currently-active creatures on the client
 * (`world.activeCreatures`, live-probed surface obs 10320). A KILL is a
 * creature that was present in the previous scan and is absent now — a pure
 * diff over the active set. This observer feeds:
 *   - huntStats kills-per-hour + loot-per-hour (REQ-21),
 *   - loot routing (REQ-19): a killed creature with loot info routes to the
 *     configured destination.
 *
 * Feature-detect: `readActiveCreatures` returns the array or null. When the
 * array is absent (unprobed location, uninitialized world) the observer
 * reports `available: false` and produces no kills — the modules record the
 * honest "no kill data" degrade instead of inventing events.
 *
 * Pure node-testable: injectable reader + clock.
 */

/** Identity of a creature entry (stable across scans). */
function creatureId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.id !== undefined && entry.id !== null) return 'id|' + String(entry.id);
  if (entry.speciesId !== undefined && entry.speciesId !== null) return 'sid|' + String(entry.speciesId);
  if (entry.name !== undefined && entry.name !== null) return 'name|' + String(entry.name);
  return null;
}

/** Best-effort display name of a creature entry. */
function creatureName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.name === 'string' && entry.name) return entry.name;
  if (typeof entry.speciesName === 'string' && entry.speciesName) return entry.speciesName;
  if (typeof entry.type === 'string' && entry.type) return entry.type;
  return null;
}

/**
 * Loot availability for a creature: true/false when the entry exposes a
 * `loot` field; null when the field is absent (unknown — unprobed).
 */
function creatureLoot(entry) {
  if (!entry || typeof entry !== 'object' || entry.loot === undefined) return null;
  return Boolean(entry.loot);
}

/**
 * Create the kill observer.
 *
 * @param {object} [opts]
 * @param {() => Array<object>|null} [opts.readActiveCreatures] - feature-detect
 *   reader for the live active-creature list; null/absent => unavailable
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @returns {{
 *   scan: () => {kills: Array<{id: string, name: string|null, loot: boolean|null}>, available: boolean},
 *   reset: () => void,
 * }}
 */
function createKillObserver({ readActiveCreatures = () => null, now = Date.now } = {}) {
  let previous = new Map(); // id -> entry
  let initialized = false;

  /**
   * Diff the current active set against the previous scan. Kills = creatures
   * that disappeared since the last scan (player aggression or other causes —
   * the game does not distinguish; v1 counts disappearances, feature-detected
   * from the array). First scan only establishes the baseline.
   * @returns {{kills: Array<{id: string, name: string|null, loot: boolean|null}>, available: boolean}}
   */
  function scan() {
    const current = typeof readActiveCreatures === 'function' ? readActiveCreatures() : null;
    if (!Array.isArray(current)) {
      initialized = false;
      previous = new Map();
      return { kills: [], available: false };
    }
    const nowMap = new Map();
    const kills = [];
    for (const entry of current) {
      const id = creatureId(entry);
      if (id === null) continue;
      nowMap.set(id, entry);
    }
    if (initialized) {
      for (const [id, entry] of previous) {
        if (!nowMap.has(id)) {
          kills.push({ id, name: creatureName(entry), loot: creatureLoot(entry) });
        }
      }
    }
    previous = nowMap;
    initialized = true;
    return { kills, available: true };
  }

  /** Drop the baseline (agent rebuild / new session). */
  function reset() {
    previous = new Map();
    initialized = false;
  }

  return { scan, reset };
}

module.exports = { createKillObserver, creatureId, creatureName, creatureLoot };
