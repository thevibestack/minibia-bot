'use strict';

/**
 * PR 5 — OTHERS tab panel tests (REQ-33/34, D9): the OTHERS settings form
 * (food slot + every-N-casts, loot default destination, anti-bot
 * `pattern => reply` list), gate refusals, the anti-bot confirm prompt and
 * the anti-bot live-state lines.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../app/panel/state.js');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/** Drive the pure state to armed. */
function armedState() {
  let state = P.createInitialState();
  state = P.panelReducer(state, { type: 'PROBE_START' }).state;
  state = P.panelReducer(state, { type: 'PROBE_RESULT', identity: FLAMAMEX }).state;
  state = P.panelReducer(state, { type: 'CONNECT' }).state;
  return state;
}

/** Dispatch a raw form fill + save; returns the reducer result. */
function saveOthers(state, form) {
  let next = state;
  for (const key of Object.keys(form)) {
    next = P.panelReducer(next, { type: 'UPDATE_OTHERS_INPUT', key, value: form[key] }).state;
  }
  return P.panelReducer(next, { type: 'SAVE_OTHERS_SETTINGS' });
}

const VALID_FORM = {
  foodSlot: '2',
  everyCasts: '5',
  lootDest: 'Loot bag',
  antibotReplies: 'verify your account => ok then\n/^stop bot/i => sorry',
};

test('REQ-33/34 (PR5): UPDATE_OTHERS_INPUT preserves the raw form values across re-renders', () => {
  let state = armedState();
  for (const key of Object.keys(VALID_FORM)) {
    state = P.panelReducer(state, { type: 'UPDATE_OTHERS_INPUT', key, value: VALID_FORM[key] }).state;
  }
  assert.deepEqual(state.othersForm, VALID_FORM);
  const r = P.panelReducer(state, { type: 'UPDATE_OTHERS_INPUT', key: 'lootDest', value: '' });
  assert.equal(r.state.othersForm.lootDest, '');
  assert.equal(r.state.othersForm.foodSlot, '2', 'other keys untouched');
  assert.deepEqual(P.panelReducer(state, { type: 'UPDATE_OTHERS_INPUT', key: 'bogus', value: '1' }).state.othersForm, state.othersForm);
});

test('REQ-33/34 (PR5): SAVE_OTHERS_SETTINGS refused pre-Connect (not connected)', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'SAVE_OTHERS_SETTINGS' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-33/34 (PR5): SAVE_OTHERS_SETTINGS writes eat/loot/antibot config and pushes', () => {
  const r = saveOthers(armedState(), VALID_FORM);
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.refusal, null);
  assert.equal(r.state.config.modules.eat.slot, 2);
  assert.equal(r.state.config.modules.eat.everyCasts, 5);
  assert.equal(r.state.config.modules.loot.defaultDest, 'Loot bag');
  assert.deepEqual(r.state.config.modules.antibot.replies, [
    { pattern: 'verify your account', reply: 'ok then' },
    { pattern: '/^stop bot/i', reply: 'sorry' },
  ]);
  assert.deepEqual(r.state.othersForm, VALID_FORM, 'committed values shown back');
});

test('REQ-33/34 (PR5): SAVE_OTHERS_SETTINGS refuses malformed replies with a visible reason — no config write', () => {
  const bad = [
    { form: Object.assign({}, VALID_FORM, { antibotReplies: 'no separator here' }), why: 'line without =>' },
    { form: Object.assign({}, VALID_FORM, { antibotReplies: 'pattern => ' }), why: 'missing reply' },
    { form: Object.assign({}, VALID_FORM, { antibotReplies: ' => reply' }), why: 'missing pattern' },
    { form: Object.assign({}, VALID_FORM, { foodSlot: '0' }), why: 'food slot below 1' },
    { form: Object.assign({}, VALID_FORM, { foodSlot: '-2' }), why: 'negative food slot' },
    { form: Object.assign({}, VALID_FORM, { foodSlot: 'abc' }), why: 'non-numeric food slot' },
    { form: Object.assign({}, VALID_FORM, { everyCasts: '-1' }), why: 'negative every-casts' },
  ];
  for (const { form, why } of bad) {
    const r = saveOthers(armedState(), form);
    assert.equal(r.effects.length, 0, 'no push for: ' + why);
    assert.equal(r.state.config, null, 'no config write for: ' + why);
    assert.match(r.state.refusal.reason, /invalid (other settings|anti-bot replies)/, 'visible reason for: ' + why);
  }
});

test('Hidden-module scope: an empty OTHERS form preserves the hidden loot/antibot config', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: {
      character: 'Flamamex',
      modules: {
        eat: { on: false, slot: null, everyCasts: 0 },
        loot: { on: false, defaultDest: 'Dust bag', perMonster: {} },
        antibot: { on: false, replies: [{ pattern: 'hi', reply: 'hello' }] },
      },
    },
  }).state;
  const r = P.panelReducer(state, { type: 'SAVE_OTHERS_SETTINGS' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.eat.slot, null);
  assert.equal(r.state.config.modules.eat.everyCasts, 0);
  assert.equal(r.state.config.modules.loot.defaultDest, 'Dust bag', 'hidden loot config preserved');
  assert.deepEqual(r.state.config.modules.antibot.replies, [{ pattern: 'hi', reply: 'hello' }],
    'hidden anti-bot replies preserved');
});

test('REQ-34 (PR5): CONFIRM_ANTIBOT is armed-gated and emits the antibot-confirm effect', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'CONFIRM_ANTIBOT', pattern: 'verify your account' });
  assert.equal(r.state.refusal.reason, 'not connected');
  const armed = P.panelReducer(armedState(), { type: 'CONFIRM_ANTIBOT', pattern: 'verify your account' });
  assert.deepEqual(armed.effects, [{ type: 'antibot-confirm', pattern: 'verify your account' }]);
  const empty = P.panelReducer(armedState(), { type: 'CONFIRM_ANTIBOT', pattern: '' });
  assert.deepEqual(empty.effects, [], 'empty pattern ignored');
});

test('REQ-33/34 (PR5): othersFormFromConfig derives the form from the saved config', () => {
  const state = P.panelReducer(armedState(), {
    type: 'PREFILL_CONFIG',
    config: {
      character: 'Flamamex',
      modules: {
        eat: { on: false, slot: 3, everyCasts: 4 },
        loot: { on: false, defaultDest: 'Dust bag', perMonster: {} },
        antibot: { on: false, replies: [{ pattern: 'hi', reply: 'hello' }] },
      },
    },
  }).state;
  assert.deepEqual(P.othersFormFromConfig(state), {
    foodSlot: '3', everyCasts: '4', lootDest: 'Dust bag', antibotReplies: 'hi => hello',
  });
});

test('Hidden-module scope: renderConfigForm shows the food-only OTHERS form when armed', () => {
  const armed = P.renderConfigForm(armedState());
  assert.match(armed, /id="others-food-slot"/);
  assert.match(armed, /id="others-every-casts"/);
  assert.match(armed, /id="others-save-btn"/);
  assert.doesNotMatch(armed, /others-loot-dest/, 'loot destination hidden');
  assert.doesNotMatch(armed, /others-replies/, 'anti-bot replies hidden');
  assert.doesNotMatch(armed, /Anti-bot chat replies/, 'no anti-bot section');
  const unarmed = P.renderConfigForm(P.createInitialState());
  assert.match(unarmed, /Configuration unlocks after Connect/);
  assert.ok(!unarmed.includes('others-save-btn'), 'no OTHERS form pre-Connect');
});

test('REQ-33/34 (PR5): renderLiveState shows the confirm prompt, alerts and the send degrade', () => {
  let state = armedState();
  state = Object.assign({}, state, {
    snapshot: {
      agent: {
        modules: {
          antibot: {
            on: true,
            pendingConfirm: { pattern: 'verify your account', reply: 'ok then', at: 1 },
            sendAvailable: false,
            sendReason: 'no Default-channel send surface — alert only',
            alerts: [
              { id: 1, kind: 'speak', message: 'GM-Test speaks: "verify your account"', at: 1 },
              { id: 2, kind: 'moved', message: 'player moved to (100, 200)', at: 2 },
            ],
          },
        },
      },
    },
  });
  const html = P.renderLiveState(state);
  assert.match(html, /Anti-bot pattern &quot;verify your account&quot; seen — confirm to auto-reply &quot;ok then&quot;\?/);
  assert.match(html, /data-antibot-confirm="verify your account"/);
  assert.match(html, /Auto-replies unavailable/);
  assert.match(html, /GM-Test speaks/);
  assert.match(html, /player moved to \(100, 200\)/);
  const empty = Object.assign({}, armedState(), {
    snapshot: { agent: { modules: { antibot: { on: true, pendingConfirm: null, alerts: [] } } } },
  });
  assert.match(P.renderLiveState(empty), /No anti-bot events yet\./);
  const none = Object.assign({}, armedState(), { snapshot: null });
  assert.ok(!P.renderLiveState(none).includes('antibot-confirm-btn'), 'no prompt without a snapshot');
});
