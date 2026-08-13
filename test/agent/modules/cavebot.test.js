'use strict';

/**
 * PR 6 — cavebot skeleton module tests (REQ-36, D10, task 6.2): state-only
 * record (throttled position snapshots), save shape (config.routes), pause,
 * start from the NEAREST waypoint (euclidean min), feature-detected object
 * detect, editing FUTURE. Unit + fake clock — no DOM, no game calls.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCavebotModule,
  normalizePoint,
  sanitizeRouteList,
  euclideanDistance,
  nearestWaypoint,
} = require('../../../src/agent/modules/cavebot');

function makeModule(overrides = {}) {
  const now = { t: 1_000_000 };
  const timers = overrides.timers !== undefined ? overrides.timers : {};
  const mod = createCavebotModule(Object.assign({
    config: { on: true, paused: false, route: [] },
    readPosition: overrides.position !== undefined ? (() => overrides.position) : (() => ({ x: 0, y: 0 })),
    readObjects: overrides.readObjects !== undefined ? overrides.readObjects : (() => null),
    timers,
    now: () => now.t,
    recordIntervalMs: 1000,
    log: {},
  }, overrides));
  return { mod, now, timers };
}

/* ----------------------------- normalization ----------------------------- */

test('REQ-36: normalizePoint — finite numbers only, junk rejected', () => {
  assert.deepEqual(normalizePoint({ x: 1, y: 2 }), { x: 1, y: 2 });
  assert.deepEqual(normalizePoint({ x: '1', y: '2' }), { x: 1, y: 2 });
  assert.equal(normalizePoint(null), null);
  assert.equal(normalizePoint({}), null);
  assert.equal(normalizePoint({ x: '', y: 1 }), null, 'empty string is NOT the origin (Number("")===0 trap)');
  assert.equal(normalizePoint({ x: NaN, y: 1 }), null);
  assert.equal(normalizePoint({ x: 1, y: Infinity }), null);
});

test('REQ-36: sanitizeRouteList — junk dropped, capped, never crashes', () => {
  assert.deepEqual(sanitizeRouteList([{ x: 1, y: 2 }, { x: '3', y: '4' }]), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(sanitizeRouteList([{ x: 1, y: 2 }, null, 'junk', { x: NaN, y: 0 }]), [{ x: 1, y: 2 }]);
  assert.deepEqual(sanitizeRouteList('nope'), []);
  assert.deepEqual(sanitizeRouteList(undefined), []);
});

test('REQ-36: euclideanDistance — plain math', () => {
  assert.equal(euclideanDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(euclideanDistance({ x: 10, y: 10 }, { x: 10, y: 10 }), 0);
});

test('REQ-36: nearestWaypoint picks the euclidean min, first on ties', () => {
  const route = [{ x: 100, y: 100 }, { x: 120, y: 140 }, { x: 50, y: 60 }];
  const nw = nearestWaypoint({ x: 115, y: 135 }, route);
  assert.equal(nw.index, 1, 'waypoint (120,140) is nearest to (115,135)');
  assert.deepEqual(nw.waypoint, { x: 120, y: 140 });
  assert.ok(nw.distance < 8, 'distance sanity');
  const tie = nearestWaypoint({ x: 0, y: 0 }, [{ x: 5, y: 0 }, { x: 5, y: 0 }]);
  assert.equal(tie.index, 0, 'first nearest wins on ties');
});

test('REQ-36: nearestWaypoint degrades — no position / empty route / junk route', () => {
  assert.equal(nearestWaypoint(null, [{ x: 1, y: 2 }]), null);
  assert.equal(nearestWaypoint({ x: 0, y: 0 }, []), null);
  assert.equal(nearestWaypoint({ x: 0, y: 0 }, null), null);
  assert.equal(nearestWaypoint({ x: 0, y: 0 }, ['junk']), null);
});

/* ------------------------------- skeleton -------------------------------- */

test('cavebot state exposes a real route/combat flow, not a skeleton disclosure', () => {
  const { mod } = makeModule();
  const st = mod.getState();
  assert.equal(st.skeleton, undefined);
  assert.equal(st.mode, 'route');
  assert.equal(st.editing, 'record-and-save');
  assert.equal(st.recording.active, false);
  assert.equal(st.savedRoute.count, 0);
});

/* ------------------------------- recording ------------------------------- */

test('REQ-36: record flow — start, throttled snapshots, stop returns the route', () => {
  const { mod, now } = makeModule();
  assert.deepEqual(mod.startRecording(), { ok: true, startedAt: 1_000_000 });
  assert.equal(mod.isRecording(), true);
  assert.deepEqual(mod.record({ x: 10, y: 10 }), { recorded: true, count: 1 });
  assert.deepEqual(mod.record({ x: 10, y: 10 }), { recorded: false, reason: 'duplicate' },
    'identical snapshot deduped');
  assert.deepEqual(mod.record({ x: 11, y: 10 }), { recorded: false, reason: 'throttled' },
    'same-tick snapshot throttled');
  now.t += 1001;
  assert.deepEqual(mod.record({ x: 11, y: 10 }), { recorded: true, count: 2 },
    'gap elapsed -> lands');
  const stopped = mod.stopRecording();
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.points, [{ x: 10, y: 10 }, { x: 11, y: 10 }],
    'plain {x,y} waypoints — the config.routes save shape');
  assert.equal(mod.isRecording(), false);
});

test('REQ-36: record gates — not recording, invalid points', () => {
  const { mod } = makeModule();
  assert.deepEqual(mod.record({ x: 1, y: 2 }), { recorded: false, reason: 'not-recording' });
  mod.startRecording();
  assert.deepEqual(mod.record(null), { recorded: false, reason: 'invalid-point' });
  assert.deepEqual(mod.record({ x: '', y: 2 }), { recorded: false, reason: 'invalid-point' });
});

test('REQ-36: start/stop idempotence + stop without recording', () => {
  const { mod } = makeModule();
  assert.deepEqual(mod.stopRecording(), { ok: false, reason: 'not-recording' });
  mod.startRecording();
  assert.deepEqual(mod.startRecording(), { ok: false, reason: 'already-recording' });
});

test('REQ-36: recording buffer is capped (oldest dropped, bounded memory)', () => {
  const { mod, now } = makeModule({ recordIntervalMs: 0 });
  mod.startRecording();
  let recorded = 0;
  for (let i = 0; i < 520; i += 1) {
    now.t += 1;
    const r = mod.record({ x: i, y: 0 });
    if (r.recorded) recorded += 1;
  }
  assert.equal(recorded, 520, 'every distinct snapshot passes the throttle at interval 0');
  const st = mod.getState();
  assert.equal(st.recording.points, 500, 'buffer keeps the newest 500, oldest dropped');
  const stopped = mod.stopRecording();
  assert.equal(stopped.points.length, 500);
  assert.deepEqual(stopped.points[0], { x: 20, y: 0 }, 'the oldest 20 were dropped');
  assert.deepEqual(stopped.points[499], { x: 519, y: 0 }, 'the newest snapshot survives');
});

/* ---------------------------- start decision ----------------------------- */

test('REQ-36: decideStart picks the NEAREST waypoint to the position', () => {
  const route = [{ x: 100, y: 100 }, { x: 120, y: 140 }];
  const { mod } = makeModule({ config: { on: true, paused: false, route }, position: { x: 118, y: 138 } });
  const d = mod.decideStart();
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'nearest-waypoint');
  assert.equal(d.index, 1, 'nearest waypoint is (120,140)');
  assert.deepEqual({ x: d.x, y: d.y }, { x: 120, y: 140 });
  assert.ok(d.distance > 0);
});

test('REQ-36: decideStart gates — off, paused, no route, no position', () => {
  const route = [{ x: 1, y: 2 }];
  assert.equal(makeModule({ config: { on: false, paused: false, route } }).mod.decideStart().reason, 'off');
  assert.equal(makeModule({ config: { on: true, paused: true, route } }).mod.decideStart().reason, 'paused');
  assert.equal(makeModule({ config: { on: true, paused: false, route: [] } }).mod.decideStart().reason, 'no-route');
  assert.equal(makeModule({ config: { on: true, paused: false, route }, position: null }).mod.decideStart().reason, 'no-position');
});

test('REQ-36: decideStart reads the SAVED route from the config', () => {
  // The route list arrives normalized on the cavebot config (config.routes).
  const { mod } = makeModule({
    config: { on: true, paused: false, route: [{ x: 40, y: 30 }, { x: 1, y: 1 }] },
    position: { x: 2, y: 1 },
  });
  const d = mod.decideStart();
  assert.equal(d.index, 1, 'waypoint (1,1) is nearest');
});

/* ------------------------- object detect (probe) ------------------------- */

test('REQ-36: object surface feature-detected — absent = honest no-op state', () => {
  const { mod } = makeModule({ readObjects: () => null });
  const st = mod.getState();
  assert.equal(st.objectWalk.available, false);
  assert.equal(st.objectWalk.reason, 'no object surface');
  assert.equal(st.objectWalk.count, null);
});

test('REQ-36: object surface present -> state reports availability (walk stays no-op)', () => {
  const { mod } = makeModule({ readObjects: () => [{ id: 1 }, { id: 2 }] });
  const st = mod.getState();
  assert.equal(st.objectWalk.available, true);
  assert.equal(st.objectWalk.reason, 'ok');
  assert.equal(st.objectWalk.count, 2);
});

/* ------------------------------ pause + save ----------------------------- */

test('REQ-36: pause flag comes from the config and blocks start', () => {
  const { mod } = makeModule({ config: { on: true, paused: true, route: [{ x: 1, y: 1 }] } });
  const st = mod.getState();
  assert.equal(st.paused, true);
  assert.equal(st.start.available, false);
  assert.equal(mod.decideStart().reason, 'paused');
});

test('REQ-36: saved route summary rides the state (panel save feedback)', () => {
  const { mod } = makeModule({
    config: { on: true, paused: false, route: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] },
  });
  const st = mod.getState();
  assert.equal(st.savedRoute.count, 3);
  assert.deepEqual(st.savedRoute.first, { x: 1, y: 2 });
  assert.deepEqual(st.savedRoute.last, { x: 5, y: 6 });
  assert.equal(st.start.available, true);
});

test('REQ-36: session buffer survives config rebuilds (timers container)', () => {
  const timers = {};
  const { mod } = makeModule({ timers });
  mod.startRecording();
  mod.record({ x: 7, y: 7 });
  // Rebuild = a NEW module instance over the SAME session timers.
  const rebuilt = createCavebotModule({
    config: { on: true, paused: false, route: [] },
    readPosition: () => ({ x: 7, y: 7 }),
    readObjects: () => null,
    timers,
    now: () => 1_000_000,
    recordIntervalMs: 0,
    log: {},
  });
  assert.equal(rebuilt.isRecording(), true, 'recording state survived the rebuild');
  assert.equal(rebuilt.getState().recording.points, 1, 'buffer survived the rebuild');
  mod.stopRecording();
  assert.equal(rebuilt.isRecording(), false, 'stop on one instance stops the session');
});

test('continuous cavebot acquires configured monsters, pauses walking and resumes the route', () => {
  const now = { t: 1000 };
  const creatures = [{ id: 1, name: 'Rat', state: { __state: { health: 40, maxHealth: 100 } } }];
  let target = null;
  const walks = [];
  const mod = createCavebotModule({
    config: { on: true, paused: false, route: [{ x: 10, y: 10 }, { x: 20, y: 20 }], monsters: ['Rat'], targeting: 'lowest-hp' },
    readPosition: () => ({ x: 0, y: 0 }),
    readCreatures: () => creatures,
    readTarget: () => target,
    readAutoWalk: () => ({ isAutoWalking: false }),
    selectTarget: (creature) => { target = creature; return true; },
    walkTo: (x, y) => { walks.push({ x, y }); return true; },
    timers: {}, now: () => now.t,
  });
  let d = mod.decide();
  assert.equal(d.kind, 'target');
  assert.equal(mod.fire(d), true);
  assert.equal(mod.decide().reason, 'combat', 'targeted monster pauses route movement');
  target = null;
  creatures.length = 0;
  d = mod.decide();
  assert.equal(d.kind, 'walk');
  assert.equal(mod.fire(d), true);
  assert.deepEqual(walks, [{ x: 10, y: 10 }]);
});
