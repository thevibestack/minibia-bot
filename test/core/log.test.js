'use strict';

/**
 * core/log unit tests (task 1.1, design D8): ring-buffer semantics —
 * push/read shape and order, cap eviction, injectable clock, clear.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLogRing } = require('../../src/core/log');

test('1.1: push stores {ts, module, action, result} and read returns them oldest-first', () => {
  const ring = createLogRing({ cap: 10, now: () => 1000 });
  ring.push({ module: 'healMagic', action: 'cast', result: 'heal' });
  ring.push({ module: 'training', action: 'cast', result: { sid: 50 } });

  const rows = ring.read();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ts: 1000, module: 'healMagic', action: 'cast', result: 'heal' });
  assert.deepEqual(rows[1], { ts: 1000, module: 'training', action: 'cast', result: { sid: 50 } });
});

test('1.1: read returns a copy — mutating it never touches the buffer', () => {
  const ring = createLogRing({ cap: 10, now: () => 1 });
  ring.push({ module: 'eat', action: 'eat' });
  const rows = ring.read();
  rows.length = 0;
  assert.equal(ring.size(), 1, 'buffer unaffected by caller mutation');
});

test('1.1: cap eviction — oldest entries are dropped beyond the cap', () => {
  const ring = createLogRing({ cap: 3, now: () => 5 });
  ring.push({ module: 'a', action: '1' });
  ring.push({ module: 'b', action: '2' });
  ring.push({ module: 'c', action: '3' });
  ring.push({ module: 'd', action: '4' });
  ring.push({ module: 'e', action: '5' });

  const rows = ring.read();
  assert.equal(rows.length, 3, 'buffer never exceeds the cap');
  assert.deepEqual(rows.map((r) => r.module), ['c', 'd', 'e'], 'oldest evicted, order kept');
});

test('1.1: injectable clock is the ts fallback; an explicit ts wins', () => {
  let now = 42;
  const ring = createLogRing({ cap: 10, now: () => now });
  ring.push({ module: 'agent', action: 'ready' });
  ring.push({ module: 'agent', action: 'config', ts: 9999 });

  const rows = ring.read();
  assert.equal(rows[0].ts, 42, 'clock used when ts omitted');
  assert.equal(rows[1].ts, 9999, 'explicit ts honored');
});

test('1.1: missing fields normalize to defaults — module agent, action event, result null', () => {
  const ring = createLogRing({ cap: 10, now: () => 7 });
  ring.push({});
  ring.push(null);

  assert.deepEqual(ring.read(), [
    { ts: 7, module: 'agent', action: 'event', result: null },
    { ts: 7, module: 'agent', action: 'event', result: null },
  ]);
});

test('1.1: clear drops everything and returns 0; push works after', () => {
  const ring = createLogRing({ cap: 10, now: () => 1 });
  ring.push({ module: 'a', action: '1' });
  assert.equal(ring.clear(), 0);
  assert.equal(ring.size(), 0);
  ring.push({ module: 'b', action: '2' });
  assert.equal(ring.size(), 1);
});

test('1.1: invalid caps fall back to the default 200', () => {
  for (const bad of [0, -1, 3.5, 'x', null, undefined]) {
    const ring = createLogRing({ cap: bad, now: () => 1 });
    for (let i = 0; i < 205; i += 1) ring.push({ module: 'm', action: 'a' + i });
    assert.equal(ring.size(), 200, 'cap falls back to 200 for ' + JSON.stringify(bad));
  }
});
