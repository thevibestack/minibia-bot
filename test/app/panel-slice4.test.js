'use strict';

/**
 * PR 4 — TRAINER tab panel tests (REQ-30/31/32, D2/D3/D4): the TRAINER
 * settings form (cap mode, cap % -> ratio conversion, fallback slot + mana %,
 * reserve, eat-with-magic), gate refusals and the cap-full live-state line.
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
function saveTrainer(state, form) {
  let next = state;
  for (const key of Object.keys(form)) {
    next = P.panelReducer(next, { type: 'UPDATE_TRAINER_INPUT', key, value: form[key] }).state;
  }
  return P.panelReducer(next, { type: 'SAVE_TRAINER_SETTINGS' });
}

const VALID_FORM = {
  capMode: 'strict', capFullThreshold: '100', fallbackSlot: '3',
  fallbackManaPct: '50', reserve: '30', eatMagic: 'true', eatMagicSlot: '5',
};

test('REQ-30/31/32 (PR4): UPDATE_TRAINER_INPUT preserves the raw form values across re-renders', () => {
  let state = armedState();
  for (const key of Object.keys(VALID_FORM)) {
    state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key, value: VALID_FORM[key] }).state;
  }
  assert.deepEqual(state.trainerForm, VALID_FORM);
  const r = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'capFullThreshold', value: '' });
  assert.equal(r.state.trainerForm.capFullThreshold, '');
  assert.equal(r.state.trainerForm.capMode, 'strict', 'other keys untouched');
  // Unknown keys are ignored.
  assert.deepEqual(P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'bogus', value: '1' }).state.trainerForm, state.trainerForm);
});

test('REQ-30/31/32 (PR4): SAVE_TRAINER_SETTINGS refused pre-Connect (not connected)', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'SAVE_TRAINER_SETTINGS' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-30/31/32 (PR4): SAVE_TRAINER_SETTINGS converts % to ratios and writes runes + training config', () => {
  const r = saveTrainer(armedState(), VALID_FORM);
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.refusal, null);
  const runes = r.state.config.modules.runes;
  assert.equal(runes.capMode, 'strict');
  assert.equal(runes.capFullThreshold, 1, '100% -> ratio 1.0');
  assert.equal(runes.fallbackSlot, 3);
  assert.equal(runes.fallbackManaPct, 0.5, '50% -> ratio 0.5');
  const training = r.state.config.modules.training;
  assert.equal(training.reserve, 30);
  assert.equal(training.eatWithMagic.enabled, true);
  assert.equal(training.eatWithMagic.slot, 5);
  assert.deepEqual(r.state.trainerForm, VALID_FORM, 'committed values shown back');
});

test('REQ-30/31/32 (PR4): SAVE_TRAINER_SETTINGS refuses invalid values with a visible reason — no config write', () => {
  const bad = [
    { form: Object.assign({}, VALID_FORM, { capMode: 'bogus' }), why: 'cap mode not strict/off' },
    { form: Object.assign({}, VALID_FORM, { capFullThreshold: '150' }), why: 'cap % over 100' },
    { form: Object.assign({}, VALID_FORM, { capFullThreshold: '' }), why: 'empty cap %' },
    { form: Object.assign({}, VALID_FORM, { fallbackSlot: '13' }), why: 'fallback slot above 12' },
    { form: Object.assign({}, VALID_FORM, { fallbackManaPct: '-5' }), why: 'negative fallback %' },
    { form: Object.assign({}, VALID_FORM, { reserve: '-1' }), why: 'negative reserve' },
    { form: Object.assign({}, VALID_FORM, { reserve: '' }), why: 'empty reserve' },
    { form: Object.assign({}, VALID_FORM, { eatMagic: 'maybe' }), why: 'eat-magic not true/false' },
    { form: Object.assign({}, VALID_FORM, { eatMagic: 'true', eatMagicSlot: '' }), why: 'eat-magic on without a slot' },
    { form: Object.assign({}, VALID_FORM, { eatMagic: 'true', eatMagicSlot: '0' }), why: 'magic food slot below 1' },
  ];
  for (const { form, why } of bad) {
    const r = saveTrainer(armedState(), form);
    assert.equal(r.effects.length, 0, 'no push for: ' + why);
    assert.equal(r.state.config, null, 'no config write for: ' + why);
    assert.match(r.state.refusal.reason, /invalid trainer settings/, 'visible reason for: ' + why);
  }
});

test('REQ-30/31/32 (PR4): eat-with-magic OFF allows an empty magic-food slot', () => {
  const r = saveTrainer(armedState(), Object.assign({}, VALID_FORM, { eatMagic: 'false', eatMagicSlot: '' }));
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.training.eatWithMagic.enabled, false);
  assert.equal(r.state.config.modules.training.eatWithMagic.slot, null);
});

test('REQ-30/31/32 (PR4): renderConfigForm shows the TRAINER form when armed and hides it pre-Connect', () => {
  const armed = P.renderConfigForm(armedState());
  assert.match(armed, /id="trainer-cap-mode"/);
  assert.match(armed, /id="trainer-cap-threshold"/);
  assert.match(armed, /id="trainer-fallback-slot"/);
  assert.match(armed, /id="trainer-fallback-pct"/);
  assert.match(armed, /id="trainer-reserve"/);
  assert.match(armed, /id="trainer-eat-magic"/);
  assert.match(armed, /id="trainer-eat-magic-slot"/);
  assert.match(armed, /id="trainer-save-btn"/);
  assert.match(armed, /Rune cap mode/);
  const unarmed = P.renderConfigForm(P.createInitialState());
  assert.match(unarmed, /Configuration unlocks after Connect/);
  assert.ok(!unarmed.includes('trainer-save-btn'), 'no TRAINER form pre-Connect');
});

test('REQ-30/31/32 (PR4): the TRAINER form renders the saved config as percent values', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: {
      character: 'Flamamex',
      modules: {
        runes: { on: false, capMode: 'strict', capFullThreshold: 0.8, fallbackSlot: 2, fallbackManaPct: 0.25 },
        training: { on: false, reserve: 10, eatWithMagic: { enabled: true, slot: 6, sid: 12 } },
      },
    },
  }).state;
  const html = P.renderConfigForm(state);
  assert.match(html, /id="trainer-cap-threshold" [^>]*value="80"/, 'ratio 0.8 -> 80%');
  assert.match(html, /id="trainer-fallback-slot" [^>]*value="2"/);
  assert.match(html, /id="trainer-fallback-pct" [^>]*value="25"/, 'ratio 0.25 -> 25%');
  assert.match(html, /id="trainer-reserve" [^>]*value="10"/);
  assert.match(html, /id="trainer-eat-magic-slot" [^>]*value="6"/);
  assert.match(html, /id="trainer-eat-magic" checked/, 'enabled -> checkbox checked');
});

test('REQ-30 (PR4): renderLiveState shows the cap-full alert line from the snapshot module state', () => {
  let state = armedState();
  state = Object.assign({}, state, {
    snapshot: { agent: { modules: { training: { on: true, capFull: true, cap: { capacity: 400, maxCapacity: 400, ratio: 1 } } } } },
  });
  assert.match(P.renderLiveState(state), /Rune cap full — rune-making stopped/);
  const clear = Object.assign({}, state, {
    snapshot: { agent: { modules: { training: { on: true, capFull: false } } } },
  });
  assert.ok(!P.renderLiveState(clear).includes('Rune cap full'), 'no alert line when the cap is not full');
});

test('REQ-30 (PR4): trainerFormFromConfig falls back to the forward-compat defaults', () => {
  const derived = P.trainerFormFromConfig({ config: { modules: { runes: {}, training: {} } } });
  assert.deepEqual(derived, {
    capMode: 'strict', capFullThreshold: '100', fallbackSlot: '',
    fallbackManaPct: '50', reserve: '', eatMagic: 'false', eatMagicSlot: '',
  });
});
