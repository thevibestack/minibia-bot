'use strict';

/**
 * Cavebot skeleton (REQ-36, design D10, task 6.2).
 *
 * CAVEBOT is a STATE-ONLY SKELETON in this slice:
 *  - RECORD: throttled position snapshots into a SESSION-scoped buffer
 *    (state.timers — survives config rebuilds, resets on agent restart).
 *    The bootstrap recording loop calls record() on a cadence; the module
 *    enforces the throttle (min gap between points) + dedupe + a cap.
 *  - SAVE: the recorded waypoints land in `config.routes` (the character
 *    config's top-level route list) via the panel save flow.
 *  - PAUSE: `config.paused` flag (panel-pushed) — a paused bot refuses
 *    start.
 *  - START: from the NEAREST recorded waypoint (euclidean min, pure
 *    helper below) via the game's NATIVE autowalk primitive — the
 *    bootstrap enqueues the walk (REQ-12 no-bypass), never synthetic input.
 *  - OBJECT DETECT: feature-detected reader (injected); when the game
 *    surface is absent the module reports honest "no object surface"
 *    state — the walk-to-object action stays a no-op state (open probe).
 *  - EDITING: explicitly FUTURE (REQ-36: full route editing is not v1).
 *  - `skeleton: true` + disclosure "skeleton — limited": no tree loop, no
 *    continuous auto-walking (D10: state only).
 *
 * Pure node-testable: the position/object readers are injected; all
 * normalization + the nearest-waypoint math are local.
 */

/** Recorded waypoint cap (oldest dropped first — bounded session memory). */
const MAX_ROUTE_POINTS = 500;

/** Default minimum gap between recorded snapshots (ms). */
const DEFAULT_RECORD_INTERVAL_MS = 1000;

/**
 * Normalize a position/waypoint: finite numbers only. null/undefined and
 * empty strings are rejected (Number(null) === 0 and Number('') === 0 would
 * otherwise turn a missing input into the origin — same trap routes.js
 * guards in normalizeCoords).
 * @param {unknown} p
 * @returns {{x: number, y: number}|null}
 */
function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const { x, y } = p;
  if (x === null || x === undefined || y === null || y === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  if (typeof y === 'string' && y.trim() === '') return null;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}

/**
 * Sanitize a saved route list: every entry normalizes to a finite {x, y}
 * point; junk entries are dropped (never crash, never a bogus waypoint).
 * @param {unknown} list
 * @returns {Array<{x: number, y: number}>}
 */
function sanitizeRouteList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const p = normalizePoint(entry);
    if (p) out.push(p);
    if (out.length >= MAX_ROUTE_POINTS) break;
  }
  return out;
}

/**
 * Euclidean distance between two points.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
function euclideanDistance(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

/**
 * Nearest waypoint to a position (REQ-36: "start from the nearest recorded
 * waypoint" — euclidean min). Tie-breaks to the FIRST nearest waypoint
 * (stable). Empty/unusable inputs -> null.
 * @param {{x: number, y: number}|null} position
 * @param {Array<{x: number, y: number}>} waypoints
 * @returns {{index: number, waypoint: {x: number, y: number}, distance: number}|null}
 */
function nearestWaypoint(position, waypoints) {
  const pos = normalizePoint(position);
  if (!pos || !Array.isArray(waypoints) || waypoints.length === 0) return null;
  let best = null;
  for (let i = 0; i < waypoints.length; i += 1) {
    const wp = normalizePoint(waypoints[i]);
    if (!wp) continue;
    const d = euclideanDistance(pos, wp);
    if (best === null || d < best.distance) best = { index: i, waypoint: wp, distance: d };
  }
  return best;
}

/**
 * Create the cavebot skeleton module.
 *
 * @param {object} opts
 * @param {object} [opts.config] - normalized cavebot config
 *   { on: boolean, paused: boolean, route: Array<{x,y}> }
 *   (route = the saved route list; panel-saved into config.routes)
 * @param {() => {x: number, y: number}|null} [opts.readPosition] - live
 *   player position reader (feature-detected; null when absent)
 * @param {() => Array<object>|null} [opts.readObjects] - live ground-object
 *   list reader (open probe: object-walk stays a no-op state)
 * @param {object} [opts.timers] - session-scoped state container (survives
 *   config rebuilds; the recording buffer lives here)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {number} [opts.recordIntervalMs=1000] - min gap between snapshots
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   startRecording: () => object,
 *   stopRecording: () => object,
 *   isRecording: () => boolean,
 *   record: (point: unknown) => object,
 *   decideStart: () => object,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createCavebotModule(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const readPosition = typeof opts.readPosition === 'function' ? opts.readPosition : null;
  const readObjects = typeof opts.readObjects === 'function' ? opts.readObjects : null;
  const timers = opts.timers && typeof opts.timers === 'object' ? opts.timers : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const recordIntervalMs = Number.isFinite(Number(opts.recordIntervalMs))
    ? Math.max(0, Number(opts.recordIntervalMs))
    : DEFAULT_RECORD_INTERVAL_MS;
  const warn = typeof opts.log === 'object' && typeof opts.log.warn === 'function'
    ? opts.log.warn : () => {};

  // Session-scoped recording state (survives config rebuilds within the
  // session; agent restart = new session = fresh route buffer).
  if (!timers.cavebotRoute || typeof timers.cavebotRoute !== 'object') {
    timers.cavebotRoute = { recording: false, startedAt: null, points: [] };
  }
  const session = timers.cavebotRoute;

  /** Saved route (normalized waypoint list from the config). */
  function savedRoute() {
    return sanitizeRouteList(config.route);
  }

  /**
   * Start route recording. The bootstrap arms the recording loop on ok.
   * @returns {{ok: boolean, reason?: string}}
   */
  function startRecording() {
    if (session.recording) return { ok: false, reason: 'already-recording' };
    session.recording = true;
    session.startedAt = now();
    return { ok: true, startedAt: session.startedAt };
  }

  /** @returns {boolean} whether the recording loop should keep running */
  function isRecording() {
    return session.recording === true;
  }

  /**
   * Stop route recording and return the recorded waypoints (plain {x,y}
   * entries — the shape that saves into config.routes). The buffer resets
   * for the next recording session.
   * @returns {{ok: boolean, reason?: string, points?: Array<{x: number, y: number}>}}
   */
  function stopRecording() {
    if (!session.recording) return { ok: false, reason: 'not-recording' };
    session.recording = false;
    const points = session.points.map((p) => ({ x: p.x, y: p.y }));
    session.points = [];
    session.startedAt = null;
    return { ok: true, points, count: points.length };
  }

  /**
   * Record one position snapshot (called by the bootstrap recording loop).
   * The throttle: a point lands only when it differs from the last one AND
   * the min gap (recordIntervalMs) has passed — position snapshots are
   * throttled, never a raw firehose (REQ-36 "throttled position snapshots").
   * @param {unknown} point
   * @returns {{recorded: boolean, reason: string, count?: number}}
   */
  function record(point) {
    if (!session.recording) return { recorded: false, reason: 'not-recording' };
    const p = normalizePoint(point);
    if (!p) return { recorded: false, reason: 'invalid-point' };
    const t = now();
    const last = session.points[session.points.length - 1];
    if (last && last.x === p.x && last.y === p.y) return { recorded: false, reason: 'duplicate' };
    if (last && t - last.ts < recordIntervalMs) return { recorded: false, reason: 'throttled' };
    session.points.push({ x: p.x, y: p.y, ts: t });
    if (session.points.length > MAX_ROUTE_POINTS) session.points.shift();
    return { recorded: true, count: session.points.length };
  }

  /**
   * Decide the cavebot start: nearest recorded waypoint to the current
   * position (euclidean min). The walk itself is issued by the bootstrap
   * through the game's NATIVE autowalk primitive (queue-dispatched).
   * @returns {{fire: boolean, reason: string, x?: number, y?: number, index?: number, distance?: number}}
   */
  function decideStart() {
    if (config.on !== true) return { fire: false, reason: 'off' };
    if (config.paused === true) return { fire: false, reason: 'paused' };
    const route = savedRoute();
    if (route.length === 0) return { fire: false, reason: 'no-route' };
    let position = null;
    if (readPosition) {
      try { position = readPosition(); } catch (e) { position = null; }
    }
    if (!position) return { fire: false, reason: 'no-position' };
    const nw = nearestWaypoint(position, route);
    if (!nw) return { fire: false, reason: 'no-route' };
    return {
      fire: true,
      reason: 'nearest-waypoint',
      x: nw.waypoint.x,
      y: nw.waypoint.y,
      index: nw.index,
      distance: nw.distance,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return config.on === true;
  }

  /**
   * Honest module state (snapshot -> panel live state, REQ-36): skeleton
   * disclosure, recording status, saved route summary, pause flag, start
   * availability and the feature-detected object-walk surface. `editing:
   * 'future'` states plainly that route editing is out of v1 scope.
   * @returns {object}
   */
  function getState() {
    const route = savedRoute();
    let objects = null;
    if (readObjects) {
      try { objects = readObjects(); } catch (e) { objects = null; }
    }
    const objectList = Array.isArray(objects) ? objects : null;
    return {
      skeleton: true,
      disclosure: 'skeleton — limited',
      on: config.on === true,
      recording: {
        active: session.recording === true,
        points: session.points.length,
        startedAt: session.startedAt,
      },
      savedRoute: {
        count: route.length,
        first: route.length > 0 ? route[0] : null,
        last: route.length > 0 ? route[route.length - 1] : null,
      },
      paused: config.paused === true,
      start: {
        available: config.on === true && config.paused !== true && route.length > 0,
        reason: config.on !== true ? 'off'
          : config.paused === true ? 'paused'
            : route.length === 0 ? 'no-route' : 'ok',
      },
      objectWalk: {
        available: objectList !== null,
        reason: objectList === null ? 'no object surface' : 'ok',
        count: objectList === null ? null : objectList.length,
      },
      // REQ-36: full route editing is explicitly FUTURE (not v1).
      editing: 'future',
    };
  }

  return { startRecording, stopRecording, isRecording, record, decideStart, getState, isEnabled };
}

module.exports = {
  createCavebotModule,
  normalizePoint,
  sanitizeRouteList,
  euclideanDistance,
  nearestWaypoint,
  MAX_ROUTE_POINTS,
  DEFAULT_RECORD_INTERVAL_MS,
};
