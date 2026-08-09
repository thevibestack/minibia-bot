'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createQueue } = require('../../src/core/queue');

/** Fake clock + seeded rng harness. */
function makeHarness({ minInterval, jitter = { min: 50, max: 400 }, rng = () => 0 } = {}) {
  let t = 0;
  const dispatched = [];
  const queue = createQueue({
    minInterval,
    jitter,
    now: () => t,
    rng,
    dispatch: (fn) => {
      dispatched.push(fn);
      fn();
    },
  });
  return {
    queue, dispatched,
    t: () => t,
    advance: (ms) => { t += ms; },
    setTime: (v) => { t = v; },
  };
}

/** Record fireAt times of dispatched entries (fire-time evidence). */
function fireTimesOf(h, ms) {
  h.advance(ms);
  const done = h.queue.drain();
  return done.map((e) => e.fireAt);
}

test('2.2: two actions enqueued 10ms apart fire no earlier than ~150ms apart (REQ-12)', () => {
  const h = makeHarness({ minInterval: 150, jitter: { min: 0, max: 0 } }); // zero jitter isolates the throttle
  const fired = [];
  h.queue.enqueue(() => fired.push('A'), { kind: 'a' });
  h.advance(10);
  h.queue.enqueue(() => fired.push('B'), { kind: 'b' });

  assert.deepEqual(h.queue.drain().map((e) => e.fireAt), [0], 'A fires at its enqueue anchor (jitter 0)');
  assert.deepEqual(fired, ['A']);

  h.advance(139); // t=149: B's slot is 150 — deferred
  assert.deepEqual(h.queue.drain(), [], 'B deferred: no earlier than 150ms after A');
  assert.equal(h.queue.pendingCount(), 1);

  h.advance(1); // t=150
  assert.deepEqual(h.queue.drain().map((e) => e.fireAt), [150], 'B fires exactly 150ms after A');
  assert.deepEqual(fired, ['A', 'B']);
  assert.equal(h.queue.pendingCount(), 0);
});

test('2.2: fire time derives from the ACTUAL last dispatch, not from enqueue time', () => {
  const h = makeHarness({ minInterval: 150, jitter: { min: 0, max: 0 } });
  const fired = [];
  h.queue.enqueue(() => fired.push('A'), { kind: 'a' });
  assert.deepEqual(fireTimesOf(h, 0), [0], 'A dispatched at its anchor (t=0)');

  h.advance(100); // t=100 — B enqueued LONG after A actually dispatched
  h.queue.enqueue(() => fired.push('B'), { kind: 'b' });
  // B's slot is A's actual dispatch (0) + 150 = 150. At t=149 it must wait —
  // the naive enqueue-time anchor (100+150=250) would be equally deferred,
  // but the SPACING from the real dispatch is what the queue guarantees.
  h.advance(49);
  assert.deepEqual(h.queue.drain(), [], 'B deferred: its slot is 150 (after A@0), not 250');
  h.advance(1); // t=150
  assert.deepEqual(fireTimesOf(h, 0), [150], 'B fires at the interval measured from A\'s actual dispatch');
  assert.deepEqual(fired, ['A', 'B']);
});

test('2.2: defer, never drop, never reorder under backlog', () => {
  const h = makeHarness({ minInterval: 200, jitter: { min: 0, max: 0 } });
  const fired = [];
  h.queue.enqueue(() => fired.push('A'), { kind: 'a' });
  assert.deepEqual(fireTimesOf(h, 0), [0], 'A fires at its anchor');
  h.queue.enqueue(() => fired.push('B'), { kind: 'b' }); // t=0: slot 200
  h.advance(10);
  h.queue.enqueue(() => fired.push('C'), { kind: 'c' }); // t=10: slot after B = 400

  h.advance(190); // t=200: B eligible, C not
  assert.deepEqual(h.queue.drain().map((e) => e.kind), ['b']);
  assert.deepEqual(fired, ['A', 'B']);
  assert.equal(h.queue.pendingCount(), 1, 'C deferred, never dropped');

  h.advance(199); // t=399: C slot is 400
  assert.deepEqual(h.queue.drain(), [], 'C still deferred');
  h.advance(1);
  assert.deepEqual(h.queue.drain().map((e) => e.kind), ['c']);
  assert.deepEqual(fired, ['A', 'B', 'C'], 'FIFO order preserved end to end');
});

test('2.2: jitter is additive on top of the throttle gap (REQ-12 "plus jitter")', () => {
  // rng sequence (valid [0,1) domain): 0.0 -> jitter 50, 0.999999 -> 400, 0.5 -> 225
  const rngSeq = [0.0, 0.999999, 0.5];
  const h = makeHarness({ minInterval: 150, jitter: { min: 50, max: 400 }, rng: () => rngSeq.shift() });
  h.queue.enqueue(() => {}, { kind: 'a' }); // anchor 0 -> fireAt 50
  h.advance(10);
  h.queue.enqueue(() => {}, { kind: 'b' }); // slot 50+150=200 -> fireAt 600
  h.queue.enqueue(() => {}, { kind: 'c' }); // slot 600+150=750 -> fireAt 975

  assert.deepEqual(fireTimesOf(h, 200), [50], 'A fires at anchor + jitter 50');   // t=210
  assert.deepEqual(fireTimesOf(h, 389), [], 'B deferred until 600');              // t=599
  assert.deepEqual(fireTimesOf(h, 1), [600], 'B fires 150+400 after A — additive jitter'); // t=600
  assert.deepEqual(fireTimesOf(h, 374), [], 'C deferred until 975');              // t=974
  assert.deepEqual(fireTimesOf(h, 1), [975], 'C fires 150+225 after B');          // t=975
});

test('2.2: throttle=0 still serializes one at a time (no concurrent dispatch)', () => {
  const h = makeHarness({ minInterval: 0, jitter: { min: 0, max: 0 } });
  const fired = [];
  h.queue.enqueue(() => fired.push('A'), { kind: 'a' });
  h.queue.enqueue(() => fired.push('B'), { kind: 'b' });
  const done = h.queue.drain(); // both eligible immediately — dispatched IN ORDER, synchronously
  assert.deepEqual(fired, ['A', 'B'], 'serialized sequential dispatch, never concurrent');
  assert.equal(done.length, 2);
  const stats = h.queue.stats();
  assert.equal(stats.minInterval, 0);
  assert.equal(stats.pending, 0);
});

test('2.2: per-entry jitterMs override pins an entry to a specific delay', () => {
  const h = makeHarness({ minInterval: 150, jitter: { min: 50, max: 400 }, rng: () => 1 });
  const fired = [];
  h.queue.enqueue(() => fired.push('A'), { kind: 'a', jitterMs: 0 });
  h.queue.enqueue(() => fired.push('B'), { kind: 'b', jitterMs: 0 });
  assert.deepEqual(fireTimesOf(h, 0), [0], 'A at its 0-jitter anchor');
  h.advance(149);
  assert.deepEqual(h.queue.drain(), []);
  h.advance(1);
  assert.deepEqual(fireTimesOf(h, 0), [150], 'B at 150 despite the default rng jitter');
  assert.deepEqual(fired, ['A', 'B']);
});

test('2.2: enqueue validates its action; invalid options normalize to defaults', () => {
  const h = makeHarness({ minInterval: -5, jitter: { min: 'x', max: null } });
  assert.throws(() => h.queue.enqueue('not a function'), /requires a function/);
  assert.equal(h.queue.stats().minInterval, 150, 'negative interval falls back to the default');
  const done = [];
  h.queue.enqueue(() => done.push('A')); // jitter normalized to default 50-400; rng=0 -> 50
  assert.deepEqual(fireTimesOf(h, 50), [50], 'normalized jitter still schedules the entry');
});

test('2.2: hasPending reports pending entries by predicate (no-bypass re-arm guard)', () => {
  const h = makeHarness({ minInterval: 150, jitter: { min: 50, max: 50 } }); // fixed 50ms jitter
  assert.equal(h.queue.hasPending(() => true), false, 'empty queue has nothing pending');
  h.queue.enqueue(() => {}, { kind: 'survival-heal' }); // anchor 0 -> 50
  h.queue.enqueue(() => {}, { kind: 'combat-cast' });   // slot 50+150=200 -> 250
  assert.equal(h.queue.hasPending((e) => e.kind === 'survival-heal'), true);
  assert.equal(h.queue.hasPending((e) => e.kind === 'loot'), false);
  assert.deepEqual(fireTimesOf(h, 150), [50], 'survival-heal dispatched at 50');
  assert.equal(h.queue.hasPending((e) => e.kind === 'survival-heal'), false);
  assert.equal(h.queue.hasPending((e) => e.kind === 'combat-cast'), true, 'combat-cast deferred, still pending');
});

test('2.2: a throwing dispatch is counted, never retried, and does not block the queue', () => {
  const h = makeHarness({ minInterval: 0, jitter: { min: 0, max: 0 } });
  let boom = true;
  h.queue.enqueue(() => {
    if (boom) { boom = false; throw new Error('dispatch boom'); }
  }, { kind: 'explosive' });
  h.queue.enqueue(() => {}, { kind: 'after' });
  h.queue.drain();
  const stats = h.queue.stats();
  assert.equal(stats.failed, 1, 'throwing action counted as failed');
  assert.equal(stats.dispatched, 2, 'both entries left the queue (no retry, no blockage)');
  assert.equal(stats.pending, 0);
});

test('2.2: stats track enqueued/dispatched/pending/lastDispatchAt', () => {
  const h = makeHarness({ minInterval: 150, jitter: { min: 0, max: 0 } });
  h.queue.enqueue(() => {}, { kind: 'a' });
  h.queue.enqueue(() => {}, { kind: 'b' });
  let stats = h.queue.stats();
  assert.equal(stats.enqueued, 2);
  assert.equal(stats.pending, 2);
  assert.equal(stats.lastDispatchAt, null);
  assert.deepEqual(fireTimesOf(h, 300), [0, 150]);
  stats = h.queue.stats();
  assert.equal(stats.dispatched, 2);
  assert.equal(stats.pending, 0);
  assert.equal(stats.lastDispatchAt, 150);
});
