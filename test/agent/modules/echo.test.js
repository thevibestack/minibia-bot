'use strict';

/**
 * Echo validation carry-over tests (REQ-24, task 5.6): the PROVEN
 * core/validation.js state machine + adapters/chat.js channel-first reads
 * wired into the agent. Miss -> log + counter, NO refire (the validator has
 * no fire path by construction); skip when no echo path (no word).
 * Non-blocking: injectable schedule/clear/now drive the machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEchoModule } = require('../../../src/agent/modules/echo');

/** Manual fake scheduler: run() advances time + fires due timers in order. */
function makeFakeTimers() {
  let nowT = 0;
  const timers = [];
  return {
    now: () => nowT,
    schedule: (fn, ms) => { const t = { at: nowT + ms, fn, handle: { at: nowT + ms, fn } }; timers.push(t); return t.handle; },
    clear: (handle) => { const i = timers.findIndex((t) => t.handle === handle); if (i !== -1) timers.splice(i, 1); },
    advance: (ms) => {
      nowT += ms;
      // Fire due timers (sorted), repeatedly (a fired timer may schedule more).
      let guard = 0;
      for (;;) {
        const due = timers.filter((t) => t.at <= nowT).sort((a, b) => a.at - b.at);
        if (due.length === 0 || guard++ > 100) break;
        for (const t of due.splice(0)) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
    pending: () => timers.length,
  };
}

function makeModule(overrides = {}) {
  const clock = makeFakeTimers();
  let contents = overrides.contents !== undefined ? overrides.contents : [];
  const mod = createEchoModule({
    playerName: () => overrides.playerName || 'Flamamex',
    gameClient: {
      interface: { channelManager: { getChannel: (name) => (name === 'Default' ? { __contents: contents } : null) } },
    },
    document: null,
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
    log: overrides.log || { warn: () => {}, info: () => {} },
  });
  return {
    mod, clock,
    setContents: (c) => { contents = c; },
  };
}

test('REQ-24: echo arrives within 2500ms -> pass; counter increments', () => {
  const { mod, clock, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }]);
  assert.equal(mod.startForFire('heal-magic', 'exura'), 'passing');
  assert.equal(mod.getState().active, true);
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 }]);
  clock.advance(400); // poll at 100/200/300/400 -> echo found
  const st = mod.getState();
  assert.equal(st.passes, 1, 'pass counted');
  assert.equal(st.lastResult, 'pass');
  assert.equal(st.active, false);
});

test('REQ-24: miss -> logged + counter increments, NO refire (validator has no fire path)', () => {
  const warns = [];
  const { mod, clock } = makeModule({ log: { warn: (m) => warns.push(m), info: () => {} } });
  assert.equal(mod.startForFire('training', 'utani'), 'passing');
  clock.advance(2600); // window expires without an echo
  const st = mod.getState();
  assert.equal(st.misses, 1, 'miss counter incremented');
  assert.equal(st.lastResult, 'miss');
  assert.equal(warns.length, 1, 'miss logged (REQ-24)');
  assert.ok(warns[0].includes('no refire'), 'log states the no-refire rule');
  assert.equal(clock.pending(), 0, 'no polling continues after the miss');
  assert.equal(st.passes, 0);
});

test('REQ-24: skip when the firing path produces no echo (no word)', () => {
  const { mod, clock } = makeModule();
  assert.equal(mod.startForFire('heal-magic', '  '), 'disabled', 'empty word -> skipped');
  assert.equal(clock.pending(), 0, 'no polling starts');
  const st = mod.getState();
  assert.equal(st.active, false);
  assert.equal(st.misses, 0);
});

test('REQ-24: the echo must be the player\'s OWN message (name check) and match the word', () => {
  const { mod, clock, setContents } = makeModule();
  setContents([{ name: 'OtherGuy', message: 'exura', __time: 1 }]);
  assert.equal(mod.startForFire('heal-magic', 'exura'), 'passing');
  clock.advance(500);
  setContents([{ name: 'OtherGuy', message: 'exura', __time: 2 }, { name: 'Flamamex', message: 'exura', __time: 3 }]);
  clock.advance(200);
  assert.equal(mod.getState().passes, 1, 'only the player\'s own echo validates');
});

test('REQ-24: /regex/ words match by pattern (proven userscript matcher)', () => {
  const { mod, clock, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura gran', __time: 1 }]);
  assert.equal(mod.startForFire('heal-magic', '/^exura/i'), 'passing');
  clock.advance(300);
  setContents([{ name: 'Flamamex', message: 'exura gran', __time: 1 }, { name: 'Flamamex', message: 'exura gran', __time: 2 }]);
  clock.advance(100);
  assert.equal(mod.getState().passes, 1);
});

test('REQ-24: channel-first reads — the Default channel __contents is the candidate source', () => {
  // The module must read through the channel (adapters/chat channel-first);
  // a channel WITHOUT __contents falls back to the DOM (#chat-text-area) and
  // then to no candidates — the miss path stays honest.
  const clock = makeFakeTimers();
  const mod = createEchoModule({
    playerName: () => 'Flamamex',
    gameClient: { channelManager: { getChannel: () => null } },
    document: null,
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
    log: {},
  });
  assert.equal(mod.startForFire('heal-magic', 'exura'), 'passing');
  clock.advance(2600);
  assert.equal(mod.getState().lastResult, 'miss', 'no channel data -> honest miss, no refire');
});

test('REQ-24: restarting validation replaces the previous one (single active validation)', () => {
  const { mod, clock } = makeModule();
  assert.equal(mod.startForFire('a', 'exura'), 'passing');
  assert.equal(mod.startForFire('b', 'utani'), 'passing', 'restart replaces');
  clock.advance(2600);
  const st = mod.getState();
  assert.equal(st.lastResult, 'miss');
  assert.equal(st.misses, 1, 'only the latest validation counted');
  assert.equal(clock.pending(), 0);
});
