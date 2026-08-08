'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createValidator } = require('../../src/core/validation');

/** Deterministic fake clock + timer scheduler for driving the state machine. */
function fakeClock() {
  let t = 0;
  const jobs = [];
  return {
    now: () => t,
    schedule: (fn, ms) => {
      const job = { fn, at: t + ms, cancelled: false };
      jobs.push(job);
      return job;
    },
    clear: (job) => {
      job.cancelled = true;
    },
    advance: (ms) => {
      t += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const job of [...jobs]) {
          if (!job.cancelled && job.at <= t) {
            job.cancelled = true;
            job.fn();
            progressed = true;
          }
        }
      }
    },
    pending: () => jobs.filter((j) => !j.cancelled),
  };
}

function makeHarness({ enabled = true, windowMs = 2500, pollMs = 100 } = {}) {
  const clock = fakeClock();
  const results = [];
  let candidates = [];
  const validator = createValidator({
    windowMs,
    pollMs,
    enabled,
    isMatch: (c) => c.name === 'Flamamex' && c.message === 'adori',
    getCandidates: () => candidates,
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
    onResult: (r) => results.push(r),
  });
  return { clock, validator, results, setCandidates: (c) => (candidates = c) };
}

test('REQ-09: echo arrives at 400ms -> validation passes and the counter sinks a pass', () => {
  const { clock, validator, results, setCandidates } = makeHarness();
  assert.equal(validator.start('fire-1'), 'passing');
  clock.advance(300); // polls at 100, 200, 300 — no echo yet
  assert.equal(validator.getState().state, 'passing');
  setCandidates([{ name: 'Flamamex', message: 'adori', time: 400 }]);
  clock.advance(100); // poll at 400 sees the echo
  assert.equal(validator.getState().state, 'pass');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { fireId: 'fire-1', result: 'pass', state: 'pass' });
});

test('REQ-09: no echo within 2500ms -> miss logged, counted, and NEVER refired', () => {
  const { clock, validator, results } = makeHarness();
  assert.equal(validator.start('fire-2'), 'passing');
  clock.advance(2600); // window expires at 2500
  assert.equal(validator.getState().state, 'miss');
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'miss');
  // No refire: nothing further happens after the miss settles.
  clock.advance(5000);
  assert.equal(results.length, 1, 'no refire or re-validation after miss');
  assert.equal(clock.pending().length, 0, 'no timers left running');
});

test('REQ-09: polling happens every 100ms within the window', () => {
  const clock = fakeClock();
  const validator = createValidator({
    pollMs: 100,
    windowMs: 2500,
    getCandidates: () => [],
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
  });
  validator.start('fire-3');
  clock.advance(0);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0].at, 100, 'first poll scheduled 100ms after start');
  clock.advance(1200);
  // Polls re-schedule themselves one at a time; after 1200ms several ran already.
  assert.equal(validator.getState().state, 'passing', 'still polling before deadline');
});

test('REQ-09: validation disabled -> no polling occurs', () => {
  const { clock, validator, results } = makeHarness({ enabled: false });
  assert.equal(validator.start('fire-4'), 'disabled');
  assert.equal(validator.getState().state, 'disabled');
  assert.equal(clock.pending().length, 0, 'no timers scheduled when disabled');
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'disabled');
});

test('REQ-09: pre-existing matching history is not treated as a fresh echo', () => {
  const { clock, validator, results, setCandidates } = makeHarness();
  // The echo already exists BEFORE the fire: baseline must exclude it.
  setCandidates([{ name: 'Flamamex', message: 'adori', time: -1000 }]);
  validator.start('fire-5');
  clock.advance(2600);
  assert.equal(validator.getState().state, 'miss', 'old history must not validate');
  assert.equal(results[0].result, 'miss');
});

test('REQ-09: window default is 2500ms from start', () => {
  const clock = fakeClock();
  const validator = createValidator({
    getCandidates: () => [],
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
  });
  clock.advance(1234);
  validator.start('fire-6');
  assert.equal(validator.getState().deadline, 1234 + 2500);
});

test('REQ-09: dispose cancels polling without emitting a result', () => {
  const { clock, validator, results } = makeHarness();
  validator.start('fire-7');
  clock.advance(250);
  validator.dispose();
  assert.equal(clock.pending().length, 0, 'timer cancelled');
  assert.equal(validator.getState().state, 'idle');
  clock.advance(10000);
  assert.equal(results.length, 0, 'no result emitted after dispose');
});

test('REQ-09: restarting replaces the previous validation', () => {
  const { clock, validator, results, setCandidates } = makeHarness();
  validator.start('fire-a');
  clock.advance(200);
  validator.start('fire-b'); // restart before any echo
  setCandidates([{ name: 'Flamamex', message: 'adori', time: 300 }]);
  clock.advance(500);
  assert.equal(results.length, 1);
  assert.equal(results[0].fireId, 'fire-b', 'only the latest fire validates');
  assert.equal(results[0].result, 'pass');
});
