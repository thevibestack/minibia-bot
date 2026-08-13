'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PHASES,
  REASON_CODES,
  createRuntimeStatus,
  transitionRuntimeStatus,
} = require('../../src/core/runtime-status');

test('runtime status: creates the complete waiting envelope with stable reason data', () => {
  const status = createRuntimeStatus({
    phase: PHASES.WAITING,
    reasonCode: REASON_CODES.MANA_WAIT,
    reasonArgs: { required: 240, current: 96 },
    nextAction: 'CAST_RUNE',
  }, () => 1_000);

  assert.deepEqual(status, {
    phase: 'waiting',
    reasonCode: 'MANA_WAIT',
    reasonArgs: { required: 240, current: 96 },
    nextAction: 'CAST_RUNE',
    since: 1_000,
    attemptId: null,
    evidence: [],
  });
});

test('runtime status: pending actions carry attempt identity and copied evidence', () => {
  const evidence = [{ type: 'mana_before', value: 270 }];
  const status = createRuntimeStatus({
    phase: PHASES.PENDING,
    reasonCode: REASON_CODES.ACTION_CONFIRMING,
    nextAction: 'CONFIRM_RUNE',
    attemptId: 'trainer-7',
    evidence,
  }, () => 2_000);

  evidence.push({ type: 'mutated-after-create' });
  assert.equal(status.attemptId, 'trainer-7');
  assert.deepEqual(status.evidence, [{ type: 'mana_before', value: 270 }], 'snapshot evidence is not aliased');
});

test('runtime status: transitions preserve since only while phase and reason remain stable', () => {
  const waiting = createRuntimeStatus({
    phase: PHASES.WAITING,
    reasonCode: REASON_CODES.MANA_WAIT,
    reasonArgs: { required: 240, current: 96 },
    nextAction: 'CAST_RUNE',
  }, () => 100);

  const stillWaiting = transitionRuntimeStatus(waiting, {
    phase: PHASES.WAITING,
    reasonCode: REASON_CODES.MANA_WAIT,
    reasonArgs: { required: 240, current: 120 },
  }, () => 200);
  assert.equal(stillWaiting.since, 100);
  assert.equal(stillWaiting.reasonArgs.current, 120);

  const pending = transitionRuntimeStatus(stillWaiting, {
    phase: PHASES.PENDING,
    reasonCode: REASON_CODES.ACTION_CONFIRMING,
    nextAction: 'CONFIRM_RUNE',
    attemptId: 'trainer-8',
  }, () => 300);
  assert.equal(pending.since, 300);
  assert.equal(pending.phase, 'pending');
});

test('runtime status: rejects unknown phases instead of leaking free-form states', () => {
  assert.throws(
    () => createRuntimeStatus({ phase: 'kind-of-running' }),
    /unknown runtime phase/,
  );
});
