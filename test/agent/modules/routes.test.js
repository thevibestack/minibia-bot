'use strict';

/**
 * Routes v1 module tests (REQ-23, tasks 6.1/6.2): native autowalk state
 * reading (__isAutoWalking / __autoWalkStepsRemaining /
 * __autowalkStartPosition / __minimapWaypoints) with honest degrades, and
 * walk-to decisions through the native autowalk primitive ONLY (never
 * synthetic input). Route recording is FUTURE — asserted present as a
 * marker, never a surface.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRoutesModule, normalizeCoords, resolveWalkToMethod } = require('../../../src/agent/modules/routes');

/** Live-probed pathfinder shape (obs 10320: world.pathfinder). */
function pathfinderWith(overrides = {}) {
  return Object.assign({
    __isAutoWalking: true,
    __autoWalkStepsRemaining: 12,
    __autowalkStartPosition: { x: 100, y: 100 },
    __minimapWaypoints: [{ x: 100, y: 100 }, { x: 120, y: 140 }],
    pathTo: function pathTo(x, y) { return { x, y }; },
  }, overrides);
}

function makeModule(overrides = {}) {
  const calls = { pathTo: [], now: 1000 };
  const config = overrides.config !== undefined ? overrides.config : { on: true };
  const pf = overrides.pathfinder !== undefined ? overrides.pathfinder : pathfinderWith({
    pathTo: function pathTo(x, y) { calls.pathTo.push({ x, y }); return true; },
  });
  const module = createRoutesModule({
    config,
    readPathfinder: () => pf,
    now: () => calls.now,
  });
  return { module, calls };
}

test('REQ-23: getState reads the native autowalk state — steps + destination', () => {
  const { module } = makeModule();
  const st = module.getState();
  assert.equal(st.available, true);
  assert.equal(st.reason, 'ok');
  assert.equal(st.isAutoWalking, true);
  assert.equal(st.stepsRemaining, 12);
  assert.deepEqual(st.startPosition, { x: 100, y: 100 });
  assert.deepEqual(st.destination, { x: 120, y: 140 }, 'destination = last minimap waypoint');
  assert.equal(st.recording, 'future', 'route recording is FUTURE (REQ-23)');
});

test('REQ-23: getState is honest when the pathfinder is absent — "no pathfinder data"', () => {
  const module = createRoutesModule({ config: { on: true }, readPathfinder: () => null });
  const st = module.getState();
  assert.equal(st.available, false);
  assert.equal(st.reason, 'no pathfinder data');
  assert.equal(st.isAutoWalking, false);
  assert.equal(st.stepsRemaining, null);
  assert.equal(st.destination, null);
  assert.equal(st.walkTo.available, false);
  assert.equal(st.walkTo.reason, 'no pathfinder data');
});

test('REQ-23: partial/nonexistent autowalk fields degrade individually, never throw', () => {
  const module = createRoutesModule({
    config: { on: true },
    readPathfinder: () => pathfinderWith({
      __isAutoWalking: undefined,
      __autoWalkStepsRemaining: undefined,
      __autowalkStartPosition: null,
      __minimapWaypoints: undefined,
    }),
  });
  const st = module.getState();
  assert.equal(st.available, true, 'pathfinder object present -> available');
  assert.equal(st.isAutoWalking, false);
  assert.equal(st.stepsRemaining, null);
  assert.equal(st.startPosition, null);
  assert.equal(st.destination, null, 'no waypoints -> no destination data');
});

test('REQ-23: not auto-walking reports false with remaining steps untouched', () => {
  const { module } = makeModule({ pathfinder: pathfinderWith({ __isAutoWalking: false, __autoWalkStepsRemaining: 0 }) });
  const st = module.getState();
  assert.equal(st.isAutoWalking, false);
  assert.equal(st.stepsRemaining, 0);
});

test('REQ-23: walk-to decision uses ONLY the native autowalk method (pathTo)', () => {
  const { module, calls } = makeModule();
  const d = module.decideWalkTo(150, 200);
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'native-autowalk');
  assert.deepEqual({ x: d.x, y: d.y }, { x: 150, y: 200 });
  assert.equal(typeof d.method, 'function', 'decision carries the native method for the queue closure');
  assert.equal(calls.pathTo.length, 0, 'decision alone never calls the game');
});

test('REQ-23: fireWalk invokes the native pathTo with the coordinates', () => {
  const { module, calls } = makeModule();
  const d = module.decideWalkTo(150, 200);
  assert.equal(module.fireWalk(d), true);
  assert.deepEqual(calls.pathTo, [{ x: 150, y: 200 }]);
  assert.deepEqual(module.getState().lastWalkTo, { x: 150, y: 200, at: 1000 });
});

test('REQ-23: walk-to is OFF when the routes toggle is off (no pathTo call)', () => {
  const { module, calls } = makeModule({ config: { on: false } });
  const d = module.decideWalkTo(150, 200);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'off');
  assert.equal(module.fireWalk(d), false);
  assert.equal(calls.pathTo.length, 0);
});

test('REQ-23: walk-to degrades without pathfinder data — never fires', () => {
  const module = createRoutesModule({ config: { on: true }, readPathfinder: () => null });
  const d = module.decideWalkTo(150, 200);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'no pathfinder data');
});

test('REQ-23: walk-to degrades when the pathfinder has no walk-to method', () => {
  const module = createRoutesModule({
    config: { on: true },
    readPathfinder: () => pathfinderWith({ pathTo: undefined, findPath: () => [] }),
  });
  const d = module.decideWalkTo(150, 200);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'no walk-to method', 'findPath alone is not a walk-to (never synthetic)');
  assert.equal(module.getState().walkTo.available, false);
});

test('REQ-23: non-finite coordinates are refused before any game call', () => {
  const { module, calls } = makeModule();
  for (const bad of [['x', 5], [5, 'y'], [null, 3], [3, undefined], [NaN, 4], ['1.5', 'junk']]) {
    const d = module.decideWalkTo(bad[0], bad[1]);
    assert.equal(d.fire, false, 'rejects ' + JSON.stringify(bad));
    assert.equal(d.reason, 'invalid-coordinates');
  }
  assert.equal(calls.pathTo.length, 0);
});

test('REQ-23: fireWalk failure logs via warn and reports false', () => {
  const warns = [];
  const module = createRoutesModule({
    config: { on: true },
    readPathfinder: () => pathfinderWith({ pathTo: () => { throw new Error('native boom'); } }),
    log: { warn: (m) => warns.push(m) },
  });
  const d = module.decideWalkTo(1, 2);
  assert.equal(d.fire, true);
  assert.equal(module.fireWalk(d), false);
  assert.ok(warns.some((m) => /native walk-to failed/.test(m)));
});

test('6.1: normalizeCoords accepts finite numbers only', () => {
  assert.deepEqual(normalizeCoords(5, 8), { x: 5, y: 8 });
  assert.deepEqual(normalizeCoords('5', '8.5'), { x: 5, y: 8.5 });
  assert.equal(normalizeCoords('a', 3), null);
  assert.equal(normalizeCoords(undefined, 3), null);
});

test('6.1: resolveWalkToMethod finds the native walk-to, preferring pathTo', () => {
  const pf = { pathTo: function pathTo() {}, walkTo: function walkTo() {} };
  assert.equal(resolveWalkToMethod(pf).name, 'pathTo');
  assert.equal(resolveWalkToMethod({ walkTo: function walkTo() {} }).name, 'walkTo');
  assert.equal(resolveWalkToMethod({ findPath: () => {} }), null);
  assert.equal(resolveWalkToMethod(null), null);
});
