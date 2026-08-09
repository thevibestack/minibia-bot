'use strict';

/**
 * Routes v1 (REQ-23, design "Routes v1" row, tasks 6.1/6.2).
 *
 * v1 is a NATIVE AUTOWALK integration, not a route editor:
 *  - STATE READ (MUST): reads the game's own pathfinder autowalk fields
 *    (live-probed, obs 10320 — world.pathfinder):
 *      __isAutoWalking, __autoWalkStepsRemaining, __autowalkStartPosition,
 *      __minimapWaypoints.
 *    The panel shows remaining steps + destination; when the pathfinder is
 *    absent the module reports "no pathfinder data" (honest panel state,
 *    never invents data).
 *  - WALK-TO (SHOULD): issues walk-to ONLY through the native autowalk
 *    primitive (world.pathfinder.pathTo — the probed walk-to entry; never
 *    synthetic per-step input, REQ-23). The fire runs ONLY inside a
 *    queue-dispatched closure (REQ-12 movement no-bypass).
 *  - ROUTE RECORDING is explicitly FUTURE (REQ-23: "not v1"): the module
 *    exposes recording: 'future' and has NO recording surface; the panel
 *    marks it FUTURE in the UI.
 *
 * Not premium-gated: walking/autowalk state is not a gated automation
 * (REQ-22 keeps other modules functional; native walking is available to
 * every account).
 *
 * Pure node-testable: the pathfinder reader is injected; all normalization
 * is local.
 */

/**
 * Normalize walk-to coordinates: finite numbers only. null/undefined and
 * empty strings are rejected (Number(null) === 0 and Number('') === 0
 * would otherwise turn a missing input into a walk-to (0, 0)).
 * @param {unknown} x
 * @param {unknown} y
 * @returns {{x: number, y: number}|null}
 */
function normalizeCoords(x, y) {
  if (x === null || x === undefined || y === null || y === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  if (typeof y === 'string' && y.trim() === '') return null;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}

/** Walk-to method candidates on the pathfinder (probed surface, obs 10320). */
const WALK_TO_METHODS = ['pathTo', 'walkTo'];

/**
 * Resolve the native walk-to method on a pathfinder object.
 * @param {object} pf
 * @returns {Function|null}
 */
function resolveWalkToMethod(pf) {
  if (!pf || typeof pf !== 'object') return null;
  for (const name of WALK_TO_METHODS) {
    if (typeof pf[name] === 'function') return pf[name];
  }
  return null;
}

/**
 * Create the routes v1 module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized routes config { on: boolean }
 * @param {() => object|null} [opts.readPathfinder] - live-probed
 *   world.pathfinder accessor (obs 10320); null = "no pathfinder data"
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decideWalkTo: (x: unknown, y: unknown) => object,
 *   fireWalk: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createRoutesModule(opts = {}) {
  const { config, readPathfinder = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { lastWalkTo: null };

  /** Live pathfinder (lazy reader, feature-detected). */
  function pathfinder() {
    try {
      const pf = typeof readPathfinder === 'function' ? readPathfinder() : null;
      return pf && typeof pf === 'object' ? pf : null;
    } catch (e) {
      warn('routes: pathfinder read failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /**
   * Read the native autowalk state (all fields feature-detected).
   * @param {object|null} pf
   * @returns {object} canonical state shape
   */
  function readAutowalkState(pf) {
    if (!pf) {
      return {
        available: false,
        reason: 'no pathfinder data',
        isAutoWalking: false,
        stepsRemaining: null,
        startPosition: null,
        destination: null,
        waypoints: null,
      };
    }
    let stepsRemaining = null;
    if (pf.__autoWalkStepsRemaining !== undefined && pf.__autoWalkStepsRemaining !== null) {
      const n = Number(pf.__autoWalkStepsRemaining);
      if (Number.isFinite(n)) stepsRemaining = Math.max(0, Math.floor(n));
    }
    let startPosition = null;
    if (pf.__autowalkStartPosition && typeof pf.__autowalkStartPosition === 'object') {
      const x = Number(pf.__autowalkStartPosition.x);
      const y = Number(pf.__autowalkStartPosition.y);
      if (Number.isFinite(x) && Number.isFinite(y)) startPosition = { x, y };
    }
    let destination = null;
    if (Array.isArray(pf.__minimapWaypoints) && pf.__minimapWaypoints.length > 0) {
      const last = pf.__minimapWaypoints[pf.__minimapWaypoints.length - 1];
      if (last && typeof last === 'object') {
        const x = Number(last.x);
        const y = Number(last.y);
        if (Number.isFinite(x) && Number.isFinite(y)) destination = { x, y };
      }
    }
    return {
      available: true,
      reason: 'ok',
      isAutoWalking: pf.__isAutoWalking === true,
      stepsRemaining,
      startPosition,
      destination,
      waypoints: Array.isArray(pf.__minimapWaypoints) ? pf.__minimapWaypoints : null,
    };
  }

  /**
   * Decide a walk-to (REQ-23): native autowalk ONLY. The decision carries
   * the resolved native method; the bootstrap enqueues the fire closure
   * (REQ-12 no-bypass).
   * @param {unknown} x
   * @param {unknown} y
   * @returns {{fire: boolean, reason: string, x?: number, y?: number, method?: Function}}
   */
  function decideWalkTo(x, y) {
    if (!config || config.on !== true) return { fire: false, reason: 'off', x, y };
    const coords = normalizeCoords(x, y);
    if (!coords) return { fire: false, reason: 'invalid-coordinates', x, y };
    const pf = pathfinder();
    if (!pf) return { fire: false, reason: 'no pathfinder data', x: coords.x, y: coords.y };
    const method = resolveWalkToMethod(pf);
    if (!method) return { fire: false, reason: 'no walk-to method', x: coords.x, y: coords.y };
    return { fire: true, reason: 'native-autowalk', method, x: coords.x, y: coords.y };
  }

  /**
   * Fire the native walk-to (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{x: number, y: number, method?: Function}} decision
   * @returns {boolean} true when the native call executed
   */
  function fireWalk(decision) {
    // Only a decided walk-to may fire (toggle OFF / invalid / degrade
    // decisions never reach the game — defense-in-depth on top of the
    // RPC's early return).
    if (!decision || decision.fire !== true) return false;
    if (!Number.isFinite(Number(decision.x)) || !Number.isFinite(Number(decision.y))) return false;
    const pf = pathfinder();
    const method = decision.method || (pf ? resolveWalkToMethod(pf) : null);
    if (!pf || !method) return false;
    try {
      method.call(pf, decision.x, decision.y);
      state.lastWalkTo = { x: decision.x, y: decision.y, at: now() };
      return true;
    } catch (e) {
      warn('routes: native walk-to failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state, REQ-23) */
  function getState() {
    const pf = pathfinder();
    const autowalk = readAutowalkState(pf);
    const walkMethod = pf ? resolveWalkToMethod(pf) : null;
    return Object.assign({}, autowalk, {
      on: Boolean(config && config.on === true),
      walkTo: {
        available: walkMethod !== null,
        reason: !pf ? 'no pathfinder data' : (walkMethod ? 'ok' : 'no walk-to method'),
        method: walkMethod ? (walkMethod.name || 'native') : null,
      },
      lastWalkTo: state.lastWalkTo,
      // REQ-23: full route recording/editing is explicitly FUTURE (not v1).
      recording: 'future',
    });
  }

  return { decideWalkTo, fireWalk, getState, isEnabled };
}

module.exports = { createRoutesModule, normalizeCoords, resolveWalkToMethod };
