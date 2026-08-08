'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDedupe, DEFAULT_WINDOW_MS } = require('../../src/core/dedupe');

const MIN5 = DEFAULT_WINDOW_MS;

test('REQ-15: same unknown word observed twice within 5 minutes -> offer registration', () => {
  const tracker = createDedupe();
  assert.equal(tracker.observe('utori', 1000), 'new', 'first observation is not an offer');
  assert.equal(tracker.observe('utori', 4000), 'offer', 'second observation within window offers');
});

test('REQ-15: word observed only once -> no offer, even after the window passes', () => {
  const tracker = createDedupe();
  assert.equal(tracker.observe('exevo', 0), 'new');
  // Window passes without a second observation.
  assert.equal(tracker.observe('exevo', MIN5 + 1), 'new', 'expired window restarts counting, no offer');
  assert.equal(tracker.observe('exevo', MIN5 + 2000), 'offer', 'second observation inside the new window');
});

test('REQ-15: already-configured word is ignored', () => {
  const tracker = createDedupe({ known: new Set(['adori']) });
  assert.equal(tracker.observe('adori', 0), 'ignored');
  assert.equal(tracker.observe('adori', 100), 'ignored');
});

test('REQ-15: declined word never offers again this session', () => {
  const tracker = createDedupe();
  assert.equal(tracker.observe('gran', 0), 'new');
  assert.equal(tracker.observe('gran', 100), 'offer');
  tracker.decline('gran');
  assert.equal(tracker.isSilenced('gran'), true);
  // Observed again later: no offer reappears.
  assert.equal(tracker.observe('gran', 5000), 'silenced');
  assert.equal(tracker.observe('gran', 6000), 'silenced');
});

test('REQ-15: offer happens exactly once before a decision', () => {
  const tracker = createDedupe();
  tracker.observe('sio', 0);
  assert.equal(tracker.observe('sio', 100), 'offer');
  assert.equal(tracker.observe('sio', 200), 'pending', 'no second offer while undecided');
  assert.equal(tracker.observe('sio', 300), 'pending');
});

test('REQ-15: markKnown stops tracking a word', () => {
  const tracker = createDedupe();
  tracker.observe('utani', 0);
  assert.equal(tracker.observe('utani', 100), 'offer');
  tracker.markKnown('utani');
  assert.equal(tracker.observe('utani', 200), 'ignored');
});

test('REQ-15: words are tracked independently', () => {
  const tracker = createDedupe();
  assert.equal(tracker.observe('alpha', 0), 'new');
  assert.equal(tracker.observe('beta', 0), 'new');
  assert.equal(tracker.observe('alpha', 50), 'offer', 'alpha offers on its second observation');
  assert.equal(tracker.observe('beta', 60), 'offer', 'beta offers on its second observation');
});

test('REQ-15: empty or non-string input is ignored', () => {
  const tracker = createDedupe();
  assert.equal(tracker.observe('', 0), 'ignored');
  assert.equal(tracker.observe(null, 0), 'ignored');
  assert.equal(tracker.observe(42, 0), 'ignored');
});
