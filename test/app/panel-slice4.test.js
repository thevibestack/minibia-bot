'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../app/panel/state.js');

const IDENTITY = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };
const CATALOG = [
  { sid: 35, name: 'Heavy Magic Missile Rune', words: 'adori gran', mana: 210, level: 3, imageDataURL: 'data:image/png;base64,rune' },
  { sid: 2, name: 'Healing', words: 'exura', mana: 25, level: 1, imageDataURL: 'data:image/png;base64,heal' },
  { sid: 12, name: 'Food', words: 'exevo pan', mana: 0, level: 1, imageDataURL: 'data:image/png;base64,food' },
];

function armedLiveState(slots = [{ slot: 4, sid: 35 }, { slot: 7, sid: 2 }, { slot: 8, sid: 12 }]) {
  let state = P.createInitialState();
  state = P.panelReducer(state, { type: 'PROBE_START' }).state;
  state = P.panelReducer(state, { type: 'PROBE_RESULT', identity: IDENTITY }).state;
  state = P.panelReducer(state, { type: 'CONNECT' }).state;
  state = P.panelReducer(state, { type: 'SPELL_CATALOG', spells: CATALOG }).state;
  state = P.panelReducer(state, { type: 'HOTBAR_CATALOG', ok: true, available: true, slots }).state;
  return state;
}

function save(state, values = {}) {
  const form = Object.assign({
    runeSid: '35', reserve: '30', capMode: 'strict', capFullThreshold: '100',
    autoFallback: 'true', fallbackSid: '2', fallbackManaPct: '50',
    stopRuneMaking: 'false', stopBotting: 'false',
  }, values);
  for (const [key, value] of Object.entries(form)) {
    state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key, value }).state;
  }
  return P.panelReducer(state, { type: 'SAVE_TRAINER_SETTINGS' });
}

test('trainer saves live rune/fallback SIDs with their actual hotbar slots and cost+reserve rule', () => {
  const result = save(armedLiveState());
  assert.deepEqual(result.effects, [{ type: 'push-config' }]);
  assert.equal(result.state.config.modules.training.sid, 35);
  assert.equal(result.state.config.modules.training.slot, 4, 'rune slot is resolved from live hotbar');
  assert.equal(result.state.config.modules.training.reserve, 30);
  assert.equal(result.state.config.modules.training.word, 'adori gran');
  assert.equal(result.state.config.modules.training.eatWithMagic, undefined,
    'trainer save no longer writes or keeps eatWithMagic (REQ-01)');
  assert.equal(result.state.config.modules.eat, undefined, 'trainer save never touches the eat module');
  assert.equal(result.state.config.modules.runes.fallbackSid, 2);
  assert.equal(result.state.config.modules.runes.fallbackSlot, 7, 'fallback slot is resolved from live hotbar');
  assert.equal(result.state.config.modules.runes.fallbackManaPct, 0.5);
});

test('trainer refuses an unhotbarred selected rune with an actionable error', () => {
  const result = save(armedLiveState([{ slot: 7, sid: 2 }]));
  assert.deepEqual(result.effects, []);
  assert.match(result.state.refusal.reason, /Add the selected rune spell to F1–F12/i);
  assert.match(result.state.refusal.reason, /refresh Live hotbar/i);
});

test('trainer refuses an unhotbarred automatic fallback with an actionable error', () => {
  const result = save(armedLiveState([{ slot: 4, sid: 35 }]));
  assert.deepEqual(result.effects, []);
  assert.match(result.state.refusal.reason, /Add the selected fallback spell to F1–F12/i);
});

test('trainer only accepts rune makers as the main spell and non-runes as automatic fallback', () => {
  const badRune = save(armedLiveState(), { runeSid: '2' });
  assert.match(badRune.state.refusal.reason, /live rune-making spell/i);
  const badFallback = save(armedLiveState(), { fallbackSid: '35' });
  assert.match(badFallback.state.refusal.reason, /non-rune fallback/i);
});

test('trainer rendering puts live execution first and keeps optional settings compact', () => {
  let state = armedLiveState();
  const result = save(state);
  state = result.state;
  const html = P.renderConfigForm(state);
  assert.match(html, /Heavy Magic Missile Rune/);
  assert.match(html, /adori gran/);
  assert.match(html, /MP 210/);
  assert.match(html, /Live execution/);
  assert.match(html, /Required/);
  assert.match(html, /F4/);
  assert.match(html, /Fallback magic \(optional\)/);
  assert.match(html, /Capacity: unavailable/);
  assert.ok(!html.includes('SID 35'), 'implementation ids are not shown in the compact card');
  assert.ok(!html.includes('trainer-rune-slot'), 'no invented rune F-slot input');
  assert.ok(!html.includes('trainer-fallback-slot'), 'no invented fallback F-slot input');
  assert.ok(!html.includes('trainer-eat-magic-slot'), 'no fake food slot input');
});

test('trainer execution card explains its next action from the live mana snapshot', () => {
  let state = armedLiveState();
  state.snapshot = { stats: { mana: 220, maxMana: 270 } };
  state = save(state).state;
  const html = P.renderConfigForm(state);
  assert.match(html, /220 \/ 270/);
  assert.match(html, /Waiting for mana: 220\/240 MP/);
  assert.match(html, /Refresh data/);
});


test('REQ-01 (PR4): trainer food-magic fields are dead — save ignores them and leaves no eatWithMagic', () => {
  // The legacy trainer food surface is GONE: UPDATE_TRAINER_INPUT no longer
  // accepts food keys and the save never writes training.eatWithMagic. The
  // unified surface lives in Others (panel-slice-others.test.js).
  let state = armedLiveState();
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'foodMagicEnabled', value: 'true' }).state;
  assert.equal(state.trainerForm.foodMagicEnabled, undefined, 'food keys are no longer trainer form values');
  state = save(state).state;
  assert.equal(state.config.modules.training.eatWithMagic, undefined, 'valid trainer save writes no eatWithMagic');
  // A stale legacy key present in the saved config is DELETED by a re-save
  // (REQ-01: SHALL NOT leave training.eatWithMagic).
  state.config.modules.training.eatWithMagic = { enabled: true, slot: 8, sid: 12, everyRunes: 1 };
  const result = P.panelReducer(state, { type: 'SAVE_TRAINER_SETTINGS' });
  assert.deepEqual(result.effects, [{ type: 'push-config' }]);
  assert.equal(result.state.refusal, null);
  assert.equal(result.state.config.modules.training.eatWithMagic, undefined,
    'stale legacy key removed by the trainer save');
});

test('REQ-01 (PR4): filterFoodCatalog still exposes live food spells for the Others form', () => {
  assert.deepEqual(P.filterFoodCatalog(armedLiveState()).map((spell) => spell.sid), [12],
    'the food catalog filter is kept — the Others form consumes it');
  const result = save(armedLiveState(), { foodMagicEnabled: 'true', foodMagicSid: '12', foodEveryRunes: '1' });
  assert.equal(result.state.refusal, null, 'trainer no longer validates food fields');
  assert.equal(result.state.config.modules.training.eatWithMagic, undefined);
});

test('REQ-01 (PR4): renderConfigForm shows the trainer without the legacy food-magic block (REQ-12 kept surfaces)', () => {
  let state = armedLiveState();
  const result = save(state);
  state = result.state;
  const html = P.renderConfigForm(state);
  assert.doesNotMatch(html, /trainer-food-magic-enabled|trainer-food-magic-select|trainer-food-every-runes/,
    'no legacy food-magic controls in the trainer form');
  assert.doesNotMatch(html, /Food created by magic|Comida creada por magia/);
  assert.match(html, /Live execution/, 'execution card stays');
  assert.match(html, /id="trainer-rune-select"/, 'rune select stays');
  assert.match(html, /id="trainer-auto-fallback"/, 'auto fallback stays');
  assert.match(html, /id="trainer-stop-runes"/, 'stop-rune toggle stays');
  assert.match(html, /id="trainer-save-btn"/, 'save stays');
});

test('live hotbar refresh remaps Trainer SIDs by SID and pushes the safe current F-slots', () => {
  let state = save(armedLiveState()).state;
  const result = P.panelReducer(state, {
    type: 'HOTBAR_CATALOG', ok: true, available: true,
    slots: [{ slot: 9, sid: 35 }, { slot: 6, sid: 2 }, { slot: 11, sid: 12 }],
  });
  assert.deepEqual(result.effects, [{ type: 'push-config' }]);
  assert.equal(result.state.config.modules.training.slot, 9);
  assert.equal(result.state.config.modules.runes.fallbackSlot, 6);
  assert.equal(result.state.config.modules.training.eatWithMagic, undefined,
    'hotbar reconcile no longer maintains the legacy food mapping');
  assert.equal(result.state.trainerHotbarIssue, null);
});

test('missing Trainer hotbar mapping disarms before an old slot can fire another spell', () => {
  let state = save(armedLiveState()).state;
  state.modules.training = true;
  state.config.modules.training.on = true;
  const result = P.panelReducer(state, {
    type: 'HOTBAR_CATALOG', ok: true, available: true, slots: [{ slot: 7, sid: 2 }],
  });
  assert.deepEqual(result.effects, [{ type: 'push-config' }]);
  assert.equal(result.state.modules.training, false);
  assert.equal(result.state.config.modules.training.on, false);
  assert.equal(result.state.trainerHotbarIssue.key, 'rune');
  const live = P.renderTrainerRuntimeStatus(result.state, null, { mana: 270 });
  assert.match(live, /Stale hotbar|Hotbar desactualizado/);
});

test('profile prefill resets old unsaved Trainer draft values', () => {
  let state = armedLiveState();
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'reserve', value: '99' }).state;
  const cfg = { character: 'OtherProfile', modules: { training: { on: false, sid: 35, slot: 4, reserve: 30 } } };
  state = P.panelReducer(state, { type: 'PREFILL_CONFIG', config: cfg }).state;
  assert.equal(state.trainerForm.reserve, '');
  assert.equal(P.trainerFormFromConfig(state).reserve, '30');
});

test('Trainer runtime status is bilingual and actionable for food/cooldown/confirmation states', () => {
  let state = armedLiveState();
  const stats = { mana: 72 };
  assert.match(P.renderTrainerRuntimeStatus(state, { lastReason: 'cooldown' }, stats), /Waiting for the game cooldown/);
  assert.match(P.renderTrainerRuntimeStatus(state, { foodCycle: 'waiting-for-created-food' }, stats), /first 20 slots/);
  assert.match(P.renderTrainerRuntimeStatus(state, { lastReason: 'food-not-created-timeout' }, stats), /No new food item/);
  assert.match(P.renderTrainerRuntimeStatus(state, { lastReason: 'created-food-consume-failed' }, stats), /did not accept consuming/);
  assert.match(P.renderTrainerRuntimeStatus(state, { lastReason: 'confirmation-timeout' }, stats), /did not confirm/);
  state = P.panelReducer(state, { type: 'SET_LANG', lang: 'es' }).state;
  assert.match(P.renderTrainerRuntimeStatus(state, { waitingForMana: true, requiredMana: 240 }, stats), /Esperando maná: 72\/240 MP/);
});

test('trainer clears a prior save refusal as soon as the user changes a trainer control', () => {
  let state = armedLiveState();
  state.refusal = { action: 'SAVE_TRAINER_SETTINGS', module: 'training', reason: 'old error', at: 1 };
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'reserve', value: '30' }).state;
  assert.equal(state.refusal, null);
});

test('trainer CAP unavailable defaults safely and does not reject an unchanged save', () => {
  const result = save(armedLiveState(), { capFullThreshold: '' });
  assert.deepEqual(result.effects, [{ type: 'push-config' }]);
  assert.equal(result.state.config.modules.runes.capFullThreshold, 1);
});
