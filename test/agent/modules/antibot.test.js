'use strict';

/**
 * PR 5 — anti-bot watcher module tests (REQ-33/34, D9, tasks 5.1/5.2):
 * speak/move/attack alerts over the shared Default-channel poll + live player
 * context (feature-detected, edge-driven, no spam), and confirm-once chat
 * responses — first occurrence pending, confirm -> auto-reply, session-scoped
 * via the injected timers, alert-only degrade when the send surface is absent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAntibotModule } = require('../../../src/agent/modules/antibot');

/** Channel entries (raw game shape incl. `type` — chat.js passes it through). */
function entry(name, message, opts = {}) {
  return Object.assign({ name, message, __time: opts.time ?? null, type: opts.type ?? null }, opts);
}

/** gameClient with a Default channel carrying the given raw __contents. */
function gcWith(contents) {
  return {
    interface: {
      channelManager: {
        getChannel: (name) => (name === 'Default' ? { __contents: contents } : null),
      },
    },
  };
}

function makeModule(overrides = {}) {
  const now = { t: 1000000 };
  const sends = [];
  const timers = overrides.timers !== undefined ? overrides.timers : {};
  const mod = createAntibotModule({
    config: Object.assign({ on: true, replies: [] }, overrides.config),
    playerName: overrides.playerName || (() => 'Flamamex'),
    gameClient: overrides.gameClient !== undefined ? overrides.gameClient : gcWith([]),
    document: null,
    readContext: overrides.readContext || (() => ({ position: null, teleported: null, health: null, damageTint: null })),
    readSend: overrides.readSend !== undefined
      ? overrides.readSend
      : () => ({ send: (text) => sends.push(text), label: 'Default' }),
    timers,
    now: () => now.t,
    log: {},
  });
  return { mod, now, sends, timers };
}

test('REQ-33: another player speaks -> speak alert + counter (shared Default poll)', () => {
  const { mod } = makeModule({ gameClient: gcWith([entry('Gobernador', 'hello there')]) });
  mod.observe();
  const st = mod.getState();
  assert.equal(st.counters.speaks, 1);
  assert.equal(st.alerts.length, 1);
  assert.equal(st.alerts[0].kind, 'speak');
  assert.match(st.alerts[0].message, /Gobernador speaks/);
});

test('REQ-33: the player OWN message never alerts (name == player)', () => {
  const { mod } = makeModule({ gameClient: gcWith([entry('Flamamex', 'exura')]) });
  mod.observe();
  assert.equal(mod.getState().alerts.length, 0);
});

test('REQ-33: typed entries — speak types 0 and 2 alert; other types are ignored', () => {
  const { mod } = makeModule({
    gameClient: gcWith([
      entry('GM-Test', 'say something', { type: 0 }),
      entry('Gobernador', 'hello', { type: 2 }),
      entry('System', 'server message', { type: 6 }),
    ]),
  });
  mod.observe();
  assert.equal(mod.getState().counters.speaks, 2, 'types 0 and 2 speak; type 6 not');
});

test('REQ-33: duplicate speak entries alert once (time watermark)', () => {
  const { mod } = makeModule({
    gameClient: gcWith([entry('Gobernador', 'hello', { time: 10 }), entry('Gobernador', 'hello', { time: 10 })]),
  });
  mod.observe();
  mod.observe();
  assert.equal(mod.getState().counters.speaks, 1, 'same message seen twice -> one alert');
});

test('REQ-33: position delta -> moved alert; same position -> no repeat', () => {
  let pos = { x: 100, y: 200, z: 7 };
  const { mod } = makeModule({ readContext: () => ({ position: pos, teleported: null, health: 80, damageTint: false }) });
  mod.observe();
  assert.equal(mod.getState().alerts.length, 0, 'first read is the baseline');
  pos = { x: 101, y: 200, z: 7 };
  mod.observe();
  let st = mod.getState();
  assert.equal(st.counters.moves, 1);
  assert.equal(st.alerts[st.alerts.length - 1].kind, 'moved');
  pos = { x: 101, y: 200, z: 7 };
  mod.observe();
  assert.equal(mod.getState().counters.moves, 1, 'steady position never re-alerts');
});

test('REQ-33: __teleported rising edge -> moved alert once; cleared -> re-arms', () => {
  let teleported = false;
  const { mod } = makeModule({ readContext: () => ({ position: null, teleported, health: 80, damageTint: false }) });
  mod.observe();
  teleported = true;
  mod.observe();
  assert.equal(mod.getState().counters.moves, 1);
  assert.equal(mod.getState().alerts[mod.getState().alerts.length - 1].kind, 'moved');
  mod.observe();
  assert.equal(mod.getState().counters.moves, 1, 'steady teleported -> no repeat');
  teleported = false;
  mod.observe();
  teleported = true;
  mod.observe();
  assert.equal(mod.getState().counters.moves, 2, 'falling edge re-arms the detector');
});

test('REQ-33: health drop -> attacked alert; recovery -> no alert', () => {
  let health = 80;
  const { mod } = makeModule({ readContext: () => ({ position: null, teleported: null, health, damageTint: false }) });
  mod.observe();
  health = 45;
  mod.observe();
  let st = mod.getState();
  assert.equal(st.counters.attacks, 1);
  assert.equal(st.alerts[st.alerts.length - 1].kind, 'attacked');
  assert.match(st.alerts[st.alerts.length - 1].message, /health dropped to 45/);
  health = 90; // recovery (heal) is NOT an attack
  mod.observe();
  assert.equal(mod.getState().counters.attacks, 1);
});

test('REQ-33: __damageTint rising edge -> attacked alert once; steady -> silent', () => {
  let tint = false;
  const { mod } = makeModule({ readContext: () => ({ position: null, teleported: null, health: 80, damageTint: tint }) });
  mod.observe();
  tint = true;
  mod.observe();
  assert.equal(mod.getState().counters.attacks, 1);
  mod.observe();
  assert.equal(mod.getState().counters.attacks, 1, 'steady tint -> no repeat');
});

test('REQ-34: first pattern occurrence -> pending confirm, NO auto-reply yet', () => {
  const { mod, sends } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
  });
  mod.observe();
  const st = mod.getState();
  assert.deepEqual(st.pendingConfirm, { pattern: 'verify your account', reply: 'ok', at: 1000000 });
  assert.equal(st.pendingQueueCount, 1);
  assert.equal(st.confirmed.length, 0);
  assert.equal(mod.decide().fire, false, 'no auto-reply before confirm (REQ-34)');
  assert.equal(sends.length, 0);
});

test('REQ-34: after confirm the SAME pattern auto-replies on later occurrences', () => {
  const { mod, sends } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok then' }] },
  });
  mod.observe();
  const c = mod.confirm('verify your account');
  assert.equal(c.ok, true);
  assert.deepEqual(mod.getState().confirmed, ['verify your account']);
  assert.equal(mod.getState().pendingConfirm, null, 'pending prompt clears');

  // A NEW occurrence (higher watermark) in a module that shares the session
  // (timers) drives the auto-reply for the confirmed pattern.
  const { mod: mod2, sends: sends2 } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2, time: 99 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok then' }] },
    timers: { antibotConfirmed: ['verify your account'], antibotPendingQueue: [] },
  });
  mod2.observe();
  const d = mod2.decide();
  assert.equal(d.fire, true, 'confirmed pattern -> auto-reply decision');
  assert.equal(d.text, 'ok then');
  assert.equal(mod2.fire(d), true);
  assert.deepEqual(sends2, ['ok then'], 'reply sent through the feature-detected surface');
});

test('REQ-34: an unconfirmed pattern recurring stays pending (no auto-reply)', () => {
  const { mod } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
  });
  mod.observe();
  mod.observe();
  const st = mod.getState();
  assert.equal(st.pendingQueueCount, 1, 'one pending entry for the pattern');
  assert.equal(mod.decide().fire, false);
});

test('REQ-34: session-scoped — confirmed patterns survive a config rebuild (shared timers)', () => {
  const timers = { antibotConfirmed: ['verify your account'], antibotPendingQueue: [] };
  const { mod } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2, time: 5 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
    timers,
  });
  mod.observe();
  assert.equal(mod.decide().fire, true, 'confirmed in a previous rebuild -> auto-reply now');
  // A FRESH session (new timers) asks again — session-scoped (REQ-34).
  const fresh = createAntibotModule({
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
    playerName: () => 'Flamamex',
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2, time: 5 })]),
    document: null,
    readContext: () => ({ position: null, teleported: null, health: null, damageTint: null }),
    readSend: () => null,
    timers: {},
    now: () => 0,
    log: {},
  });
  fresh.observe();
  assert.ok(fresh.getState().pendingConfirm, 'new session -> first occurrence asks again');
});

test('REQ-34: alert-only degrade — no send surface -> no invented send path', () => {
  const { mod } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2 })]),
    config: { on: true, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
    readSend: () => null,
    timers: { antibotConfirmed: ['verify your account'], antibotPendingQueue: [] },
  });
  mod.observe();
  const st = mod.getState();
  assert.equal(st.sendAvailable, false, 'honest degrade state');
  assert.match(st.sendReason, /alert only/);
  assert.equal(st.replyPendingCount, 0, 'nothing queued for a nonexistent send path');
  assert.equal(mod.decide().fire, false);
  assert.equal(mod.fire({ text: 'ok' }), false, 'fire never invents a send');
});

test('REQ-34: regex patterns match by test; literal patterns match exactly', () => {
  const { mod } = makeModule({
    gameClient: gcWith([entry('GM-Test', 'stop botting now', { type: 2 })]),
    config: { on: true, replies: [{ pattern: '/^stop bot/i', reply: 'sorry' }] },
  });
  mod.observe();
  assert.ok(mod.getState().pendingConfirm, 'regex pattern matched the message');
  assert.equal(mod.getState().pendingConfirm.pattern, '/^stop bot/i');
});

test('REQ-33: module OFF -> observe is a no-op and decide refuses', () => {
  const { mod } = makeModule({
    config: { on: false, replies: [{ pattern: 'verify your account', reply: 'ok' }] },
    gameClient: gcWith([entry('GM-Test', 'verify your account', { type: 2 })]),
  });
  mod.observe();
  const st = mod.getState();
  assert.equal(st.alerts.length, 0);
  assert.equal(st.pendingConfirm, null);
  assert.equal(mod.decide().reason, 'off');
});

test('REQ-33: alerts are bounded (spammy channel cannot grow the list unboundedly)', () => {
  const contents = [];
  for (let i = 0; i < 30; i += 1) contents.push(entry('GM-' + i, 'message ' + i, { type: 2, time: i }));
  const { mod } = makeModule({ gameClient: gcWith(contents) });
  mod.observe();
  assert.ok(mod.getState().alerts.length <= 20, 'bounded by ALERTS_CAP');
  assert.equal(mod.getState().counters.speaks, 30, 'counter still counts everything');
});
