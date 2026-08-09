'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTree, Condition, Action, Selector, Sequence } = require('../../src/core/tree');
const { createEngine } = require('../../src/core/rotation');

/** Count how many times a spy action ran. */
function spy(label, out) {
  return Action((ctx) => {
    (out || []).push(label);
    return true;
  }, 'spy-' + label);
}

/* =========================================================================
 * 2.1 Engine semantics (REQ-10): Selector/Sequence/Condition/Action,
 * short-circuiting, <=1 action per tick.
 * ========================================================================= */

test('2.1: selector runs the first successful child and STOPS', () => {
  const calls = [];
  const tree = createTree({
    root: Selector([
      Sequence([Condition(() => false, 'cond-a'), spy('a', calls)],
        'seq-a'),
      spy('b', calls),
      spy('c', calls),
    ], 'root'),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, ['b'], 'only the first successful child executed');
  assert.equal(typeof res.action, 'function');
  const actions = res.path.filter((p) => p.type === 'action');
  assert.deepEqual(actions.map((p) => p.id), ['spy-b'], 'path records exactly one executed action');
  assert.equal(res.path[0].halted, true, 'selector halted after the action');
  assert.equal(res.path[res.path.length - 1].type, 'action', 'the action entry is the last path entry');
});

test('2.1: selector with all children failing returns no action', () => {
  const tree = createTree({
    root: Selector([
      Condition(() => false, 'c1'),
      Sequence([Condition(() => false, 'c2')], 's1'),
      Condition(() => false, 'c3'),
    ]),
  });
  const res = tree.tick({});
  assert.equal(res.action, null);
  assert.deepEqual(
    res.path.map((p) => ({ type: p.type, status: p.status })),
    [
      { type: 'selector', status: 'failure' },
      { type: 'condition', status: 'failure' },
      { type: 'sequence', status: 'failure' },
      { type: 'condition', status: 'failure' },
      { type: 'condition', status: 'failure' },
    ],
    'path covers every evaluated node in pre-order',
  );
});

test('2.1: a failed action (run returns false) lets the selector fall through', () => {
  const calls = [];
  const tree = createTree({
    root: Selector([
      Action(() => false, 'no-op'),
      spy('fallback', calls),
    ]),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, ['fallback'], 'selector tried the next child after the failed action');
  assert.equal(typeof res.action, 'function');
});

test('2.1: sequence succeeds only when every child succeeds', () => {
  const calls = [];
  const tree = createTree({
    root: Sequence([
      Condition(() => true, 'gate-1'),
      Condition(() => true, 'gate-2'),
      spy('run', calls),
    ], 'guarded-run'),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, ['run']);
  assert.equal(typeof res.action, 'function');
  assert.equal(res.path[0].status, 'success');
});

test('2.1: sequence fails fast — a failing child skips the rest', () => {
  const calls = [];
  const tree = createTree({
    root: Sequence([
      Condition(() => true, 'gate-ok'),
      Condition(() => false, 'gate-fail'),
      spy('never', calls),
    ]),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, [], 'children after the failure were not evaluated');
  assert.equal(res.action, null);
  assert.equal(res.path[0].status, 'failure');
});

test('2.1: condition gates an action (true runs it, false skips it)', () => {
  const calls = [];
  const tree = createTree({
    root: Sequence([Condition((ctx) => ctx.armed, 'armed'), spy('fire', calls)]),
  });
  assert.equal(tree.tick({ armed: false }).action, null);
  assert.deepEqual(calls, [], 'action skipped while the gate is closed');
  assert.equal(typeof tree.tick({ armed: true }).action, 'function');
  assert.deepEqual(calls, ['fire']);
});

test('2.1: at most ONE action executes per tick (REQ-10) — sequence with two actions', () => {
  const calls = [];
  const tree = createTree({
    root: Sequence([spy('a', calls), spy('b', calls)], 'two-actions'),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, ['a'], 'tick halts after the first executed action');
  assert.equal(res.path[0].halted, true);
  const actions = res.path.filter((p) => p.type === 'action');
  assert.equal(actions.length, 1);
});

test('2.1: halt propagates across a failing subtree — no second action anywhere in the tick', () => {
  const calls = [];
  const tree = createTree({
    root: Selector([
      Sequence([spy('a', calls), Condition(() => false, 'fails-after')], 'bad-seq'),
      spy('b', calls),
    ]),
  });
  const res = tree.tick({});
  assert.deepEqual(calls, ['a'], 'the action that ran halts the whole tick even though its sequence failed');
  assert.equal(res.path[0].halted, true, 'selector halted');
  assert.equal(res.path[1].halted, true, 'sequence halted');
  assert.equal(res.path[0].status, 'success', 'parent reports success — the action did execute');
});

test('2.1: a condition predicate receives the ctx and may not mutate it', () => {
  const seen = [];
  const tree = createTree({
    root: Condition((ctx) => { seen.push(ctx); return ctx.hp > 0; }, 'alive'),
  });
  const ctx = { hp: 80 };
  assert.equal(tree.tick(ctx).action, null);
  assert.equal(seen[0], ctx, 'predicate got the shared ctx');
});

test('2.1: predicate and action errors propagate to the tick caller (no swallowing)', () => {
  const badCond = createTree({ root: Condition(() => { throw new Error('cond boom'); }, 'boom') });
  assert.throws(() => badCond.tick({}), /cond boom/);
  const badAct = createTree({ root: Action(() => { throw new Error('act boom'); }, 'boom') });
  assert.throws(() => badAct.tick({}), /act boom/);
});

test('2.1: unknown node types and missing roots are rejected loudly', () => {
  const bogus = createTree({ root: { type: 'bogus' } });
  assert.throws(() => bogus.tick({}), /unknown node type/);
  assert.throws(() => createTree({}), /requires a root node/);
  assert.throws(() => createTree(), /requires a root node/);
});

test('2.1: node helpers produce the same plain objects a hand-written tree would', () => {
  const tree = createTree({
    root: Selector([Condition(() => true, 'ok'), Action(() => true, 'act')], 'root'),
  });
  assert.deepEqual(tree.root, {
    type: 'selector',
    id: 'root',
    children: [
      { type: 'condition', predicate: tree.root.children[0].predicate, id: 'ok' },
      { type: 'action', run: tree.root.children[1].run, id: 'act' },
    ],
  });
});

test('2.1: nodes without ids fall back to their type in the path', () => {
  const tree = createTree({ root: Selector([Condition(() => false), Action(() => true)]) });
  const res = tree.tick({});
  assert.deepEqual(
    res.path.map((p) => p.id),
    ['selector', 'condition', 'action'],
  );
});

/* =========================================================================
 * 2.3 Priority (survival > combat > loot, REQ-11) + determinism.
 * ========================================================================= */

/** Deterministic PRNG (mulberry32) for the fixed-seed determinism tests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The production-shaped priority tree (design D3/D4):
 *   Selector[ Survival(Sequence[hp<=threshold, heal]), Combat(rotation leaf), Loot ]
 */
function makePriorityTree({ ctx, combat = { rules: [] }, lootFeasible = false, spawnLoot = true }) {
  const calls = [];
  const loot = {
    type: 'sequence',
    id: 'loot',
    children: [
      { type: 'condition', id: 'loot-feasible', predicate: () => lootFeasible },
      Action((c) => { calls.push('loot'); return true; }, 'loot-collect'),
    ],
  };
  const combatNode = {
    type: 'action',
    id: 'combat',
    run: (c) => {
      const res = combat.engine.tick();
      if (!res.fired) return false;
      calls.push('combat:' + res.fired);
      return true;
    },
  };
  const survival = {
    type: 'sequence',
    id: 'survival',
    children: [
      { type: 'condition', id: 'low-hp', predicate: (c) => c.health !== null && c.health <= 50 },
      Action((c) => { calls.push('survival-heal'); return true; }, 'heal'),
    ],
  };
  const tree = createTree({ root: Selector([survival, combatNode, loot], 'priority-root') });
  return { tree, calls, ctx };
}

test('2.3: survival beats combat and loot (REQ-11 priority)', () => {
  const combat = createEngine({
    rules: [{ id: 'cast', condition: () => true, action: () => true }],
  });
  const { tree, calls, ctx } = makePriorityTree({
    ctx: { health: 30, mana: 100 },
    combat: { engine: combat },
    lootFeasible: true,
  });
  const res = tree.tick(ctx);
  assert.deepEqual(calls, ['survival-heal'], 'low hp runs the survival branch and nothing else');
  assert.equal(res.path[0].halted, true, 'selector halted after survival');
  const executed = res.path.filter((p) => p.type === 'action').map((p) => p.id);
  assert.deepEqual(executed, ['heal'], 'exactly one action per tick');
});

test('2.3: with hp healthy the combat branch fires (rotation leaf)', () => {
  const combat = createEngine({
    rules: [{ id: 'cast-exura', condition: () => true, action: () => true }],
  });
  const { tree, calls, ctx } = makePriorityTree({
    ctx: { health: 100, mana: 100 },
    combat: { engine: combat },
    lootFeasible: true,
  });
  tree.tick(ctx);
  assert.deepEqual(calls, ['combat:cast-exura'], 'combat fired, loot deferred');
});

test('2.3: combat infeasible falls through to loot', () => {
  const combat = createEngine({ rules: [{ id: 'cast', condition: () => false, action: () => true }] });
  const { tree, calls, ctx } = makePriorityTree({
    ctx: { health: 100, mana: 100 },
    combat: { engine: combat },
    lootFeasible: true,
  });
  tree.tick(ctx);
  assert.deepEqual(calls, ['loot'], 'loot branch executed when combat is infeasible');
});

test('2.3: nothing fires when every branch is infeasible', () => {
  const combat = createEngine({ rules: [] });
  const { tree, calls, ctx } = makePriorityTree({
    ctx: { health: 100 },
    combat: { engine: combat },
    lootFeasible: false,
  });
  const res = tree.tick(ctx);
  assert.deepEqual(calls, [], 'no action when nothing is feasible');
  assert.equal(res.action, null);
  assert.equal(res.path[0].status, 'failure');
});

test('2.3: rotation engine as the combat leaf fires AT MOST one rule per tree tick', () => {
  // Two feasible rules in the engine: the engine picks the first, exactly once.
  const combat = createEngine({
    rules: [
      { id: 'r1', condition: () => true, action: () => true },
      { id: 'r2', condition: () => true, action: () => true },
    ],
  });
  const fired = [];
  const tree = createTree({
    root: Selector([
      Sequence([Condition((c) => c.health > 50, 'healthy'), Action(() => {
        const res = combat.tick();
        if (!res.fired) return false;
        fired.push(res.fired);
        return true;
      }, 'combat')]),
    ]),
  });
  tree.tick({ health: 100 });
  assert.deepEqual(fired, ['r1'], 'engine fired its first feasible rule once');
});

test('2.3: determinism — identical state+config+clock+rng produce identical ticks', () => {
  const runOnce = () => {
    const calls = [];
    const rng = mulberry32(42);
    // The rotation engine owns its own ctx (the bootstrap pushes fresh stats
    // into it per tick); seed it here as the bootstrap would.
    const combat = createEngine({
      rules: [
        { id: 'cast-a', condition: (c) => c.mana >= 20, action: () => { calls.push('cast-a'); return true; } },
        { id: 'cast-b', condition: (c) => c.mana >= 10, action: () => { calls.push('cast-b'); return true; } },
      ],
      ctx: { mana: 40 },
    });
    const tree = createTree({
      root: Selector([
        Sequence([
          { type: 'condition', id: 'low-hp', predicate: (c) => c.health <= 50 },
          Action((c) => { calls.push('heal'); return true; }, 'heal'),
        ], 'survival'),
        { type: 'action', id: 'combat', run: (c) => {
          const res = combat.tick();
          if (!res.fired) return false;
          calls.push('combat:' + res.fired);
          return true;
        } },
      ], 'root'),
    });
    const paths = [];
    const actions = [];
    const ctx = { health: 100, mana: 40 };
    for (let i = 0; i < 5; i++) {
      const res = tree.tick(ctx);
      paths.push(res.path.map((p) => p.id + ':' + p.status).join(','));
      actions.push(res.action ? 'fired' : 'idle');
    }
    return { calls, paths, actions };
  };

  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first, second, 'two runs with the same seed/state produce identical call sequences, paths, and action markers');
  // Rotation semantics preserved inside the combat leaf: each rule fires once
  // per re-satisfaction (conditions never flip false -> exactly one fire each).
  assert.deepEqual(first.calls, ['cast-a', 'combat:cast-a', 'cast-b', 'combat:cast-b']);
});

test('2.3: determinism holds when the queue rng is seeded — identical fire schedules', () => {
  const { createQueue } = require('../../src/core/queue');
  const runOnce = () => {
    const rng = mulberry32(7);
    let t = 0;
    const q = createQueue({ minInterval: 150, jitter: { min: 50, max: 400 }, now: () => t, rng, dispatch: () => {} });
    const timeline = [];
    q.enqueue(() => {}, { kind: 'a' });
    t += 10;
    q.enqueue(() => {}, { kind: 'b' });
    q.enqueue(() => {}, { kind: 'c' });
    while (q.pendingCount() > 0) {
      t += 10;
      const done = q.drain();
      for (const e of done) timeline.push(t + ':' + e.kind + ':' + e.fireAt);
    }
    return timeline;
  };
  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first, second, 'seeded rng + fake clock => identical fire schedule');
  assert.ok(first.length === 3, 'all three entries eventually dispatched, none dropped');
});
