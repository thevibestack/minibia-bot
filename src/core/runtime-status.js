'use strict';

const PHASES = Object.freeze({
  OFF: 'off',
  READY: 'ready',
  WAITING: 'waiting',
  PENDING: 'pending',
  BLOCKED: 'blocked',
  ERROR: 'error',
});

const REASON_CODES = Object.freeze({
  MANA_WAIT: 'MANA_WAIT',
  COOLDOWN_WAIT: 'COOLDOWN_WAIT',
  HOTBAR_SPELL_UNMAPPED: 'HOTBAR_SPELL_UNMAPPED',
  LIVE_MANA_UNAVAILABLE: 'LIVE_MANA_UNAVAILABLE',
  ACTION_CONFIRMING: 'ACTION_CONFIRMING',
  ACTION_UNCONFIRMED: 'ACTION_UNCONFIRMED',
  CAP_UNAVAILABLE_NONBLOCKING: 'CAP_UNAVAILABLE_NONBLOCKING',
});

const PHASE_VALUES = new Set(Object.values(PHASES));

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function copyReasonArgs(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.assign({}, value)
    : {};
}

function copyEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.assign({}, item)
      : item
  ));
}

/** Create the only runtime envelope modules are allowed to publish. */
function createRuntimeStatus(input = {}, now = Date.now) {
  const phase = input.phase === undefined ? PHASES.OFF : input.phase;
  if (!PHASE_VALUES.has(phase)) {
    throw new TypeError('unknown runtime phase: ' + String(phase));
  }

  return {
    phase,
    reasonCode: typeof input.reasonCode === 'string' && input.reasonCode ? input.reasonCode : null,
    reasonArgs: copyReasonArgs(input.reasonArgs),
    nextAction: typeof input.nextAction === 'string' && input.nextAction ? input.nextAction : null,
    since: Number.isFinite(Number(input.since)) ? Number(input.since) : timestamp(now),
    attemptId: input.attemptId === null || input.attemptId === undefined ? null : String(input.attemptId),
    evidence: copyEvidence(input.evidence),
  };
}

/**
 * Transition an existing runtime snapshot. `since` is stable while the
 * semantic state (phase + reason) is unchanged and resets on a real change.
 */
function transitionRuntimeStatus(previous, patch = {}, now = Date.now) {
  const prior = previous && typeof previous === 'object'
    ? previous
    : createRuntimeStatus({}, now);
  const merged = Object.assign({}, prior, patch);
  const sameSemanticState = merged.phase === prior.phase && merged.reasonCode === prior.reasonCode;
  merged.since = patch.since !== undefined
    ? patch.since
    : (sameSemanticState ? prior.since : timestamp(now));
  return createRuntimeStatus(merged, now);
}

module.exports = {
  PHASES,
  REASON_CODES,
  createRuntimeStatus,
  transitionRuntimeStatus,
};
