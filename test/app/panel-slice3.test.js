'use strict';

/**
 * PR 3 — HEAL tab panel tests (REQ-29, design D1/D2): the HEAL settings form
 * (threshold % -> absolute hp conversion via snapshot maxHealth, slot,
 * reserve), gate refusals, independent module toggles and the live state line.
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
  state = P.panelReducer(state, { type: 'PREFILL_CONFIG', config: { character: 'Flamamex', modules: { healMagic: { on: false, sid: 2 }, healItems: { on: false }, manaItems: { on: false } } } }).state;
  state = P.panelReducer(state, { type: 'HOTBAR_CATALOG', ok: true, available: true, slots: [{ slot: 2, sid: 2, name: 'Healing', mana: 25 }] }).state;
  return state;
}

/** Dispatch a raw form fill + save; returns the reducer result. */
function saveHeal(state, form, snapshot) {
  let next = Object.assign({}, state, { snapshot: snapshot === undefined ? { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } } : snapshot });
  for (const key of Object.keys(form)) {
    next = P.panelReducer(next, { type: 'UPDATE_HEAL_INPUT', key, value: form[key] }).state;
  }
  return P.panelReducer(next, { type: 'SAVE_HEAL_SETTINGS' });
}

test('REQ-29 (PR3): UPDATE_HEAL_INPUT preserves the raw form values across re-renders', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'threshold', value: '30' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'reserve', value: '10' }).state;
  assert.deepEqual(state.healForm, { mode: '', threshold: '30', reserve: '10', itemThreshold: '', itemCids: '', manaEnabled: '', manaItemThreshold: '', manaItemCids: '' });
  const r = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'threshold', value: '' });
  assert.deepEqual(r.state.healForm, { mode: '', threshold: '', reserve: '10', itemThreshold: '', itemCids: '', manaEnabled: '', manaItemThreshold: '', manaItemCids: '' });
  // Unknown keys are ignored.
  assert.deepEqual(P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'bogus', value: '1' }).state.healForm, state.healForm);
});

test('REQ-29 (PR3): SAVE_HEAL_SETTINGS refused pre-Connect (not connected)', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'SAVE_HEAL_SETTINGS' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-29 (PR3): SAVE_HEAL_SETTINGS converts threshold % to absolute hp and pushes the config', () => {
  const state = armedState();
  const r = saveHeal(state, { threshold: '50', reserve: '10' }, { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.refusal, null);
  assert.equal(r.state.config.modules.healMagic.threshold, 100, '50% of maxHealth 200 -> absolute 100');
  assert.equal(r.state.config.modules.healMagic.slot, 2);
  assert.equal(r.state.config.modules.healMagic.reserve, 10);
  assert.deepEqual(r.state.healForm, { mode: 'magic', threshold: '50', reserve: '10', itemThreshold: '', itemCids: '', manaEnabled: 'false', manaItemThreshold: '', manaItemCids: '' }, 'committed values shown back');
});


test('Survival flow: item-only mode persists selected live item CIDs and disables magic', () => {
  let state = armedState();
  state = Object.assign({}, state, {
    snapshot: { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } },
    inventory: { loaded: true, containers: [{ items: [{ cid: 7618, name: 'Health Potion', count: 20 }] }], reason: null },
  });
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'mode', value: 'items' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'itemThreshold', value: '45' }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_HEAL_ITEM', cid: 7618 }).state;
  const r = P.panelReducer(state, { type: 'SAVE_HEAL_SETTINGS' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.modules.healMagic, false);
  assert.equal(r.state.modules.healItems, true);
  assert.equal(r.state.config.modules.healItems.threshold, 90);
  assert.deepEqual(r.state.config.modules.healItems.slotCids, [7618]);
});

test('REQ-29 (PR3): SAVE_HEAL_SETTINGS refuses invalid values with a visible reason — no config write', () => {
  const bad = [
    { form: { threshold: '150', reserve: '10' }, why: 'threshold over 100' },
    { form: { threshold: '50', reserve: '-5' }, why: 'negative reserve' },
  ];
  for (const { form, why } of bad) {
    const r = saveHeal(armedState(), form, { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } });
    assert.equal(r.effects.length, 0, 'no push for: ' + why);
    assert.equal(r.state.config.modules.healMagic.sid, 2, 'existing config remains unchanged for: ' + why);
    assert.match(r.state.refusal.reason, /invalid magic heal/, 'visible reason for: ' + why);
  }
});

test('REQ-29 (PR3): SAVE_HEAL_SETTINGS with unknown max health is refused — no silent % misread', () => {
  const r = saveHeal(armedState(), { threshold: '50', reserve: '10' }, null);
  assert.equal(r.effects.length, 0);
  assert.match(r.state.refusal.reason, /unknown max health/);
  assert.equal(r.state.config.modules.healMagic.sid, 2, 'existing config remains unchanged');
});

test('REQ-29 (PR3): renderConfigForm shows the HEAL form when armed and hides it pre-Connect', () => {
  const armed = P.renderConfigForm(armedState());
  assert.match(armed, /id="heal-threshold"/);
  assert.match(armed, /heal-mana-enabled/);
  assert.doesNotMatch(armed, /id="heal-slot"/, 'slot comes only from the live hotbar');
  assert.match(armed, /id="heal-reserve"/);
  assert.match(armed, /id="heal-save-btn"/);
  assert.match(armed, /Health threshold %/);
  const unarmed = P.renderConfigForm(P.createInitialState());
  assert.match(unarmed, /Configuration unlocks after Connect/);
  assert.ok(!unarmed.includes('heal-save-btn'), 'no HEAL form pre-Connect');
});

test('REQ-29 (PR3): the HEAL form renders the threshold as PERCENT of the saved absolute value', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: { character: 'Flamamex', modules: { healMagic: { on: true, threshold: 150, sid: 2, slot: 2, reserve: 10 }, manaItems: { on: false } } },
  }).state;
  state = Object.assign({}, state, { snapshot: { stats: { health: 100, maxHealth: 300, mana: 100, maxMana: 100 } } });
  const html = P.renderConfigForm(state);
  assert.match(html, /id="heal-threshold" [^>]*value="50"/, '150 of 300 -> 50%');
  assert.match(html, /Mapped to live hotbar slot F2/);
  assert.match(html, /id="heal-reserve" [^>]*value="10"/);
});

test('REQ-29 (PR3): renderLiveState shows the heal magic line — on with hp% and off', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: { character: 'Flamamex', modules: { healMagic: { on: true, threshold: 100, slot: 2 } } },
  }).state;
  state = Object.assign({}, state, { snapshot: { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } } });
  const onHtml = P.renderLiveState(state);
  assert.match(onHtml, /Heal magic on — hp 15% of 200, fires at 50% \(slot 2\)/, '30/200 hp, threshold 100/200');

  const offState = Object.assign({}, state, {
    config: { character: 'Flamamex', modules: { healMagic: { on: false, threshold: 100, slot: 2 } } },
  });
  assert.match(P.renderLiveState(offState), /Heal magic off — no heal actions/);
});

test('REQ-29 (PR3): the healMagic toggle is independent — toggling healItems leaves healMagic untouched', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: { character: 'Flamamex', modules: { healItems: { on: false }, healMagic: { on: true } } },
  }).state;
  assert.equal(state.modules.healMagic, true);
  const r = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'healItems', on: true });
  assert.equal(r.state.modules.healItems, true);
  assert.equal(r.state.modules.healMagic, true, 'healMagic toggle state untouched by the healItems flip');
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
});


test('Survival flow: mana potions persist a distinct threshold and BP CID list', () => {
  let state = armedState();
  state = Object.assign({}, state, { snapshot: { stats: { health: 30, maxHealth: 200, mana: 80, maxMana: 100 } }, inventory: { loaded: true, containers: [{ items: [{ cid: 268, name: 'Mana Potion', count: 20 }] }], reason: null } });
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'mode', value: 'items' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'itemThreshold', value: '50' }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_HEAL_ITEM', cid: 268, kind: 'hp' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'manaEnabled', value: 'true' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_HEAL_INPUT', key: 'manaItemThreshold', value: '35' }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_HEAL_ITEM', cid: 268, kind: 'mana' }).state;
  const r = P.panelReducer(state, { type: 'SAVE_HEAL_SETTINGS' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.manaItems.threshold, 35);
  assert.deepEqual(r.state.config.modules.manaItems.slotCids, [268]);
});

test('Survival flow refuses a selected healing spell that has no live hotbar slot', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'HOTBAR_CATALOG', ok: true, available: true, slots: [] }).state;
  const r = saveHeal(state, { threshold: '50', reserve: '10' });
  assert.match(r.state.refusal.reason, /not in the live hotbar/);
});
