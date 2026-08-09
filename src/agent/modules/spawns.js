'use strict';

/**
 * Monster spawn maps provider (REQ-20, design "Spawns" row, task 5.3).
 *
 * Ports the game's Hub -> Automations "monster spawn maps" data read ("Pick a
 * monster to see where it spawns"): v1 is a spawn-DATA PROVIDER that
 * feature-detects the game's spawn-data structure (implementation probe —
 * tools/automations-probe.js 5.3 dumps the candidates; the game loads spawn
 * maps on demand per obs 10320) and exposes monster -> spawn locations.
 * The panel displays the provider state via the live snapshot; the ROUTES
 * consumption of spawn data is explicitly slice 6 (design: "ground-map
 * overlay NOT required in v1").
 *
 * Degrade: when the game exposes no spawn data structure, the provider
 * reports "no spawn data" in its state and the panel shows exactly that —
 * never fails, never invents locations.
 *
 * Pure node-testable: the data reader is injected; the location normalizer is
 * exported pure.
 */

/**
 * Normalize a raw spawn-data read into a canonical location list
 * [{x, y, z?}]. Accepts:
 *   - an array of {x, y} / {x, y, z} / "x,y" strings
 *   - a single {x, y} point
 * Returns [] for shaped-but-empty data; null for unshaped garbage.
 * @param {unknown} raw
 * @returns {Array<{x: number, y: number, z?: number}>|null}
 */
function normalizeSpawnLocations(raw) {
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'object') {
      const x = Number(item.x);
      const y = Number(item.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const z = Number(item.z);
        out.push(Number.isFinite(z) ? { x, y, z } : { x, y });
        continue;
      }
      if (typeof item.name === 'string' && Array.isArray(item.locations)) {
        const nested = normalizeSpawnLocations(item.locations);
        if (nested !== null) out.push(...nested);
        continue;
      }
      return null; // shaped object we cannot interpret
    }
    if (typeof item === 'string') {
      const parts = item.split(',').map((s) => Number(s.trim()));
      if (parts.length >= 2 && parts.slice(0, 3).every(Number.isFinite)) {
        out.push(parts.length >= 3 ? { x: parts[0], y: parts[1], z: parts[2] } : { x: parts[0], y: parts[1] });
        continue;
      }
      return null;
    }
    return null;
  }
  return out.length > 0 ? out : null; // shaped-but-empty => "no spawn data"
}

/**
 * Create the spawn-data provider module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized spawns config { on: boolean }
 * @param {(monster: string) => unknown} [opts.readSpawnData] - feature-detected
 *   game spawn-data reader; null return/throw = "no spawn data"
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   query: (monster: string) => object,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createSpawnsModule(opts = {}) {
  const { config, readSpawnData = null, readPremium = null, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { lastQuery: null };

  /** Eager premium read (REQ-22): panel-facing state computed on getState. */
  function currentPremium() {
    const p = typeof readPremium === 'function' ? readPremium() : null;
    return {
      gated: p ? p.gated : true,
      active: p ? p.active : null,
      blocked: Boolean(p && p.active === false),
    };
  }

  /**
   * Query the spawn locations for a monster (read-only, REQ-20). The panel
   * picker drives this via the getSpawns surface RPC; the result lands in the
   * module state so the snapshot carries it into the panel live view.
   * @param {string} monster
   * @returns {{monster: string, locations: Array<{x:number,y:number,z?:number}>|null, available: boolean, reason: string}}
   */
  function query(monster) {
    const name = String(monster || '').trim();
    if (currentPremium().blocked) {
      state.lastQuery = { monster: name, locations: null, available: false, reason: 'premium-required' };
      return state.lastQuery;
    }
    if (!name) {
      state.lastQuery = { monster: name, locations: null, available: false, reason: 'no-monster' };
      return state.lastQuery;
    }
    let locations = null;
    try {
      const raw = typeof readSpawnData === 'function' ? readSpawnData(name) : null;
      locations = normalizeSpawnLocations(raw);
    } catch (e) {
      warn('spawns: spawn data read failed: ' + (e && e.message ? e.message : e));
      locations = null;
    }
    state.lastQuery = {
      monster: name,
      locations,
      available: locations !== null,
      reason: locations !== null ? 'ok' : 'no spawn data',
    };
    return state.lastQuery;
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const last = state.lastQuery || { monster: null, locations: null, available: false, reason: 'no spawn data' };
    return {
      on: Boolean(config && config.on === true),
      available: last.available,
      reason: last.reason,
      lastQuery: last,
      premium: currentPremium(),
    };
  }

  return { query, getState, isEnabled };
}

module.exports = { createSpawnsModule, normalizeSpawnLocations };
