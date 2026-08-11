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
  for (const key of Object.keys(VALID_FORM)) {
    assert.equal(state.trainerForm[key], VALID_FORM[key], key + ' preserved');
  }
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
  const committed = r.state.trainerForm;
  assert.equal(committed.capMode, 'strict');
  assert.equal(committed.capFullThreshold, '100');
  assert.equal(committed.fallbackSlot, '3');
  assert.equal(committed.fallbackManaPct, '50');
  assert.equal(committed.reserve, '30');
  assert.equal(committed.eatMagic, 'true');
  assert.equal(committed.eatMagicSlot, '5', 'committed values shown back');
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
  assert.match(armed, /When CAP is Full/);
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
    runeSid: '', runeKey: 'F4', fallbackKey: 'F5', autoFallback: 'false',
    stopRuneMaking: 'false', stopBotting: 'false',
  });
});

test('REQ-41 (PR A): renderLiveState shows the localized rune-check banner + resume button when active', () => {
  let state = armedState();
  state = Object.assign({}, state, {
    snapshot: { agent: { runeCheck: { active: true, at: 1, kind: 'chat', lastSeenAt: 1 } } },
  });
  const html = P.renderLiveState(state);
  assert.match(html, /Rune check detected — botting paused/, 'localized banner (EN default)');
  assert.match(html, /id="runecheck-resume-btn"/, 'resume button rendered');
  assert.match(html, /Resume botting/, 'localized resume label');
  const clear = Object.assign({}, state, { snapshot: { agent: { runeCheck: null } } });
  assert.ok(!P.renderLiveState(clear).includes('runecheck-resume-btn'), 'no banner when no active rune check');
});

test('REQ-41 (PR A): renderLiveState shows the Spanish banner when the panel language is ES', () => {
  let state = armedState();
  state = Object.assign({}, state, { lang: 'es' });
  state = Object.assign({}, state, {
    snapshot: { agent: { runeCheck: { active: true, at: 1, kind: 'chat', lastSeenAt: 1 } } },
  });
  const html = P.renderLiveState(state);
  assert.match(html, /Check de runas detectado/, 'ES banner text');
  assert.match(html, /Reanudar bot/, 'ES resume label');
});

test('REQ-41 (PR A): RUNECHECK_RESUME is armed-gated and emits the runecheck-resume effect', () => {
  const armed = P.panelReducer(armedState(), { type: 'RUNECHECK_RESUME' });
  assert.deepEqual(armed.effects, [{ type: 'runecheck-resume' }]);
  assert.equal(armed.state.refusal, null);
  const unarmed = P.panelReducer(P.createInitialState(), { type: 'RUNECHECK_RESUME' });
  assert.equal(unarmed.effects.length, 0, 'no effect pre-Connect');
  assert.equal(unarmed.state.refusal.reason, 'not connected', 'visible refusal (REQ-02)');
});

test('REQ-42 (B): the TRAINER form renders a 2-column grid with every kept + new field', () => {
  const html = P.renderConfigForm(armedState());
  assert.match(html, /class="trainer-grid"/, 'two-column grid container');
  assert.ok((html.match(/class="trainer-col"/g) || []).length === 2, 'two columns');
  // Kept ids (rollback contract) + Slice B ids all present.
  for (const id of ['trainer-cap-mode', 'trainer-cap-threshold', 'trainer-fallback-slot',
    'trainer-fallback-pct', 'trainer-reserve', 'trainer-eat-magic', 'trainer-eat-magic-slot',
    'trainer-save-btn']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'kept id ' + id);
  }
  for (const id of ['trainer-rune-select', 'trainer-rune-key', 'trainer-rune-assign',
    'trainer-fallback-key', 'trainer-fallback-assign', 'trainer-sound-alert',
    'trainer-auto-fallback', 'trainer-stop-runes', 'trainer-stop-botting']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'new id ' + id);
  }
  assert.match(html, /data-bar="mana"/, 'mana bar rendered');
  assert.match(html, /data-bar="cap"/, 'CAP bar rendered');
  assert.match(html, /Select Rune to Create/, 'rune select label');
  assert.match(html, /If Mana &gt;= cost \+ reserve/, 'cast logic label');
  assert.match(html, /Rune Hotkey/, 'rune hotkey label');
  assert.match(html, /Fallback Hotkey/, 'fallback hotkey label');
  assert.match(html, /Assign/, 'assign button label');
  assert.match(html, /Sound Alert/, 'sound alert toggle label');
  assert.match(html, /Auto Fallback Magic/, 'auto fallback toggle label');
  assert.match(html, /Stop Rune-Making/, 'stop rune-making toggle label');
  assert.match(html, /Stop Botting Entirely/, 'stop botting toggle label');
});

test('REQ-42 (B): the 2-col TRAINER form localizes every new label in Spanish', () => {
  let state = armedState();
  state = Object.assign({}, state, { lang: 'es' });
  const html = P.renderConfigForm(state);
  assert.match(html, /Elegir runa a crear/, 'ES rune select label');
  assert.match(html, /Si Maná &gt;= coste \+ reserva/, 'ES cast logic label');
  assert.match(html, /Tecla de runa/, 'ES rune hotkey label');
  assert.match(html, /Tecla de alternativa/, 'ES fallback hotkey label');
  assert.match(html, /Asignar/, 'ES assign label');
  assert.match(html, /Tu maná/, 'ES mana bar label');
  assert.match(html, /Capacidad actual/, 'ES cap bar label');
  assert.match(html, /Alerta sonora/, 'ES sound alert toggle');
  assert.match(html, /Magia alternativa automática/, 'ES auto fallback toggle');
  assert.match(html, /Detener fabricación de runas/, 'ES stop rune-making toggle');
  assert.match(html, /Detener el bot por completo/, 'ES stop botting toggle');
});

test('REQ-43 (B): snapshotCap reads the training module cap snapshot', () => {
  assert.deepEqual(P.snapshotCap({
    agent: { modules: { training: { cap: { capacity: 400, maxCapacity: 500, ratio: 0.8 } } } },
  }), { capacity: 400, maxCapacity: 500, ratio: 0.8 });
  assert.equal(P.snapshotCap(null), null);
  assert.equal(P.snapshotCap({ agent: { modules: { training: { cap: null } } } }), null);
  assert.equal(P.snapshotCap({ agent: { modules: { training: {} } } }), null, 'missing cap degrades to null');
});

test('REQ-43 (B): the mana and CAP bars render values, percent and fill width from the snapshot', () => {
  let state = armedState();
  state = Object.assign({}, state, {
    snapshot: {
      stats: { health: 100, mana: 400, maxMana: 500, maxHealth: 200 },
      agent: { modules: { training: { on: true, cap: { capacity: 400, maxCapacity: 500, ratio: 0.8 } } } },
    },
  });
  const html = P.renderConfigForm(state);
  const manaBar = html.match(/<div class="bar mana-bar"[\s\S]*?<\/div><\/div><\/div>/)[0];
  assert.match(manaBar, /Your mana: <strong>80%<\/strong>/, 'mana percent shown');
  assert.match(manaBar, /400 \/ 500/, 'mana cur/max shown');
  assert.match(manaBar, /style="width:80%"/, 'mana fill width');
  const capBar = html.match(/<div class="bar cap-bar"[\s\S]*?<\/div><\/div><\/div>/)[0];
  assert.match(capBar, /Current cap: <strong>80%<\/strong>/, 'cap percent shown');
  assert.match(capBar, /400 \/ 500/, 'cap cur/max shown');
  assert.match(capBar, /style="width:80%"/, 'cap fill width');
});

test('REQ-42 (B): the inline rune catalog filter matches /rune/i on name or words with a full-list fallback', () => {
  const catalog = {
    spells: [
      { sid: 1, name: 'Blank Rune', words: 'adori vita' },
      { sid: 2, name: 'Sudden Death Rune', words: 'adori tera' },
      { sid: 3, name: 'Light Heal', words: 'exura' },
      { sid: 4, name: 'Great Light', words: 'exura gran rune' }, // words carry 'rune'
    ],
  };
  const r = P.filterRuneCatalog({ catalog });
  assert.deepEqual(r.runes.map((s) => s.sid), [1, 2, 4], 'name OR words match');
  assert.equal(r.fallback, false);
  assert.deepEqual(r.list.map((s) => s.sid), [1, 2, 4]);
  const noRune = P.filterRuneCatalog({ catalog: { spells: [{ sid: 9, name: 'Haste', words: 'utevo hur' }] } });
  assert.equal(noRune.runes.length, 0);
  assert.equal(noRune.fallback, true, 'full-list fallback when no rune matches');
  assert.deepEqual(noRune.list.map((s) => s.sid), [9], 'full list when no rune matches');
  assert.deepEqual(P.filterRuneCatalog({}), { runes: [], list: [], fallback: false }, 'no catalog -> empty');
});

test('REQ-42 (B): SAVE_TRAINER_SETTINGS refuses a rune sid outside the catalog (PICK_SPELL pattern)', () => {
  const spells = [
    { sid: 42, name: 'Blank Rune', words: 'adori vita', mana: 100, level: 1, vocations: [] },
  ];
  const state = P.panelReducer(armedState(), { type: 'SPELL_CATALOG', spells }).state;
  const saveWithRune = (runeSid) => {
    const committed = saveTrainer(state, VALID_FORM).state;
    const trainerForm = Object.assign({}, committed.trainerForm, { runeSid: String(runeSid) });
    return P.panelReducer(Object.assign({}, committed, { trainerForm }), { type: 'SAVE_TRAINER_SETTINGS' });
  };
  const bad = saveWithRune(999);
  assert.equal(bad.effects.length, 0, 'no push for an unknown rune sid');
  assert.match(bad.state.refusal.reason, /rune spell not available for druid/, 'visible refusal (vocation label)');
  const nonNumeric = saveWithRune('abc');
  assert.equal(nonNumeric.effects.length, 0);
  assert.match(nonNumeric.state.refusal.reason, /rune spell id must be a number/, 'non-numeric refused');
  const ok = saveWithRune(42);
  assert.deepEqual(ok.effects, [{ type: 'push-config' }], 'a catalog sid passes');
  assert.equal(ok.state.refusal, null);
});

test('REQ-44 (B): UPDATE_TRAINER_INPUT accepts the toggle switches', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'autoFallback', value: 'true' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'stopRuneMaking', value: 'true' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'stopBotting', value: 'false' }).state;
  assert.equal(state.trainerForm.autoFallback, 'true');
  assert.equal(state.trainerForm.stopRuneMaking, 'true');
  assert.equal(state.trainerForm.stopBotting, 'false');
  assert.equal(state.trainerForm.capMode, '', 'other keys untouched');
});

test('REQ-44 (B): the Sound Alert toggle maps to SET_SOUND and reflects in the form', () => {
  let state = armedState();
  const r = P.panelReducer(state, { type: 'SET_SOUND', enabled: false });
  assert.equal(r.state.soundEnabled, false);
  assert.deepEqual(r.effects, [{ type: 'sound-set', enabled: false }]);
  const html = P.renderConfigForm(r.state);
  assert.ok(!/id="trainer-sound-alert" checked/.test(html), 'checkbox unchecked when sound off');
  assert.match(P.renderConfigForm(state), /id="trainer-sound-alert" checked/, 'checkbox checked by default');
});

test('REQ-44 (B): Auto Fallback Magic ON requires a fallback slot on save', () => {
  const refused = saveTrainer(armedState(), Object.assign({}, VALID_FORM, { fallbackSlot: '', autoFallback: 'true' }));
  assert.equal(refused.effects.length, 0, 'no push without a fallback slot');
  assert.match(refused.state.refusal.reason, /auto fallback magic needs a fallback slot/, 'visible refusal');
  const ok = saveTrainer(armedState(), Object.assign({}, VALID_FORM, { autoFallback: 'true' }));
  assert.deepEqual(ok.effects, [{ type: 'push-config' }], 'ON with a slot passes');
  assert.equal(ok.state.refusal, null);
});

test('REQ-44 (B): Stop Rune-Making turns ONLY the runes module off — heal/eat continue', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'healItems', on: true }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'eat', on: true }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'runes', on: true }).state;
  const r = saveTrainer(state, Object.assign({}, VALID_FORM, { stopRuneMaking: 'true' }));
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.modules.runes, false, 'runes off');
  assert.equal(r.state.modules.healItems, true, 'healing continues');
  assert.equal(r.state.modules.eat, true, 'eating continues');
  assert.equal(r.state.refusal, null);
});

test('REQ-45 (B): Stop Botting Entirely is gated by the confirm overlay and heal/eat continue', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'healItems', on: true }).state;
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'runes', on: true }).state;
  const pending = saveTrainer(state, Object.assign({}, VALID_FORM, { stopBotting: 'true' }));
  assert.deepEqual(pending.effects, [], 'no push while the confirm is pending');
  assert.equal(pending.state.confirmStop.pending, true, 'confirm overlay armed');
  assert.equal(pending.state.config, state.config, 'config untouched while pending');
  assert.equal(pending.state.modules.runes, true, 'runes still on while pending');
  const yes = P.panelReducer(pending.state, { type: 'CONFIRM_STOP' });
  assert.deepEqual(yes.effects, [{ type: 'push-config' }]);
  assert.equal(yes.state.confirmStop, null, 'overlay cleared after commit');
  assert.equal(yes.state.modules.runes, false, 'runes module off after confirm');
  assert.equal(yes.state.modules.healItems, true, 'healing continues');
  assert.match(P.renderConfigForm(yes.state), /Botting stopped — rune-making is off/, 'persistent banner after confirm');
});

test('REQ-45 (B): the confirm overlay No (CANCEL_STOP) drops the pending save without committing', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'runes', on: true }).state;
  const pending = saveTrainer(state, Object.assign({}, VALID_FORM, { stopBotting: 'true' }));
  const no = P.panelReducer(pending.state, { type: 'CANCEL_STOP' });
  assert.deepEqual(no.effects, [], 'no push');
  assert.equal(no.state.confirmStop, null, 'overlay cleared');
  assert.equal(no.state.modules.runes, true, 'runes untouched');
  assert.equal(no.state.config, state.config, 'config untouched');
  const again = P.panelReducer(no.state, { type: 'SAVE_TRAINER_SETTINGS' });
  assert.equal(again.state.confirmStop.pending, true, 'destructive actions are always re-confirmed');
});

test('REQ-45 (B): a save while the confirm is pending commits directly (CONFIRM_STOP path)', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'TOGGLE_MODULE', module: 'runes', on: true }).state;
  const pending = saveTrainer(state, Object.assign({}, VALID_FORM, { stopBotting: 'true' }));
  const r = P.panelReducer(pending.state, { type: 'SAVE_TRAINER_SETTINGS' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }], 'a pending confirm commits on the next save');
  assert.equal(r.state.confirmStop, null);
  assert.equal(r.state.modules.runes, false);
});

test('REQ-45 (B): the confirm overlay renders when pending with localized Yes/No', () => {
  let state = armedState();
  state = Object.assign({}, state, { confirmStop: { pending: true, at: 1 } });
  const html = P.renderConfigForm(state);
  assert.match(html, /Stop botting entirely\?/, 'EN confirm title');
  assert.match(html, /This turns rune-making off/, 'EN confirm body');
  assert.match(html, /id="confirm-stop-yes"/, 'Yes button');
  assert.match(html, /id="confirm-stop-no"/, 'No button');
  const esHtml = P.renderConfigForm(Object.assign({}, state, { lang: 'es' }));
  assert.match(esHtml, /¿Detener el bot por completo\?/, 'ES confirm title');
  assert.match(esHtml, /Sí, detener el bot/, 'ES Yes button');
  assert.match(esHtml, /Cancelar/, 'ES No button');
  assert.ok(!P.renderConfigForm(armedState()).includes('confirm-stop-yes'), 'no overlay when nothing is pending');
});

test('REQ-42/46 (B): UPDATE_TRAINER_INPUT accepts the rune sid and hotkey F-keys', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'runeSid', value: '42' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'runeKey', value: 'F6' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_TRAINER_INPUT', key: 'fallbackKey', value: 'F7' }).state;
  assert.equal(state.trainerForm.runeSid, '42');
  assert.equal(state.trainerForm.runeKey, 'F6');
  assert.equal(state.trainerForm.fallbackKey, 'F7');
  assert.equal(state.trainerForm.reserve, '', 'other keys untouched');
});

test('REQ-42/46 (B): SAVE_TRAINER_SETTINGS persists the rune sid, hotkeys and stop flags', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'SPELL_CATALOG',
    spells: [
      { sid: 42, name: 'Blank Rune', words: 'adori vita', mana: 100, level: 1, vocations: [] },
    ],
  }).state;
  const r = saveTrainer(state, Object.assign({}, VALID_FORM, {
    runeSid: '42', runeKey: 'F6', fallbackKey: 'F7', stopRuneMaking: 'true', stopBotting: 'false',
  }));
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  const training = r.state.config.modules.training;
  assert.equal(training.sid, 42, 'rune sid persisted to training.sid');
  assert.deepEqual(training.hotkeys, { runeKey: 'F6', fallbackKey: 'F7' }, 'hotkey F-keys persisted');
  assert.equal(training.stopRuneMaking, true, 'stop rune-making flag persisted');
  assert.equal(training.stopBotting, false, 'stop botting flag persisted');
  assert.equal(r.state.modules.runes, false, 'runes module off after the stop save');
  const committed = r.state.trainerForm;
  assert.equal(committed.runeSid, '42');
  assert.equal(committed.runeKey, 'F6');
  assert.equal(committed.fallbackKey, 'F7');
});

test('REQ-46 (B): SAVE_TRAINER_SETTINGS refuses a hotkey outside F1-F12', () => {
  const r = saveTrainer(armedState(), Object.assign({}, VALID_FORM, { runeKey: 'F13' }));
  assert.equal(r.effects.length, 0);
  assert.match(r.state.refusal.reason, /hotkeys must be F1-F12/, 'visible refusal');
});

test('REQ-46 (B): ASSIGN_HOTKEY is armed-gated and emits the hotkey-assign effect', () => {
  const armed = P.panelReducer(armedState(), { type: 'ASSIGN_HOTKEY', which: 'rune' });
  assert.deepEqual(armed.effects, [{ type: 'hotkey-assign', which: 'rune' }]);
  assert.equal(armed.state.refusal, null);
  const fallback = P.panelReducer(armedState(), { type: 'ASSIGN_HOTKEY', which: 'fallback' });
  assert.deepEqual(fallback.effects, [{ type: 'hotkey-assign', which: 'fallback' }]);
  const unarmed = P.panelReducer(P.createInitialState(), { type: 'ASSIGN_HOTKEY', which: 'rune' });
  assert.equal(unarmed.effects.length, 0, 'no effect pre-Connect');
  assert.equal(unarmed.state.refusal.reason, 'not connected', 'visible refusal (REQ-02)');
});

test('REQ-46 (B): HOTKEY_RESULT surfaces a visible refusal on failure and clears on success', () => {
  const fail = P.panelReducer(armedState(), { type: 'HOTKEY_RESULT', ok: false, which: 'rune', reason: 'keyboard surface unavailable' });
  assert.equal(fail.state.refusal.action, 'ASSIGN_HOTKEY');
  assert.equal(fail.state.refusal.reason, 'keyboard surface unavailable');
  const ok = P.panelReducer(fail.state, { type: 'HOTKEY_RESULT', ok: true, which: 'rune' });
  assert.equal(ok.state.refusal, null);
});

test('REQ-46 (B): HOTKEYS_LOADED records the surface availability for the display-only degrade', () => {
  const loaded = P.panelReducer(armedState(), {
    type: 'HOTKEYS_LOADED',
    available: false,
    reason: 'no keyboard surface',
    configured: { runeKey: 'F6', fallbackKey: 'F7' },
  });
  assert.equal(loaded.state.hotkeys.available, false);
  assert.deepEqual(loaded.state.hotkeys.configured, { runeKey: 'F6', fallbackKey: 'F7' });
  // Display-only degrade: the hotkey selects are disabled + honest note.
  const html = P.renderConfigForm(loaded.state);
  assert.match(html, /id="trainer-rune-key" disabled/, 'rune hotkey select disabled');
  assert.match(html, /id="trainer-fallback-key" disabled/, 'fallback hotkey select disabled');
  assert.match(html, /id="trainer-rune-assign" disabled/, 'assign button disabled');
  assert.match(html, /Hotkeys unavailable — the game keyboard surface is not exposed/, 'honest degrade note');
});

test('REQ-42 (B): the form derives the rune sid, hotkeys and toggles from the saved config', () => {
  let state = armedState();
  state = P.panelReducer(state, {
    type: 'PREFILL_CONFIG',
    config: {
      character: 'Flamamex',
      modules: {
        runes: { on: false, capMode: 'strict', capFullThreshold: 0.8, fallbackSlot: 2, fallbackManaPct: 0.25 },
        training: {
          on: false, reserve: 10, sid: 42,
          eatWithMagic: { enabled: true, slot: 6, sid: 12 },
          hotkeys: { runeKey: 'F6', fallbackKey: 'F7' },
          stopRuneMaking: true, stopBotting: true,
        },
      },
    },
  }).state;
  state = P.panelReducer(state, {
    type: 'SPELL_CATALOG',
    spells: [
      { sid: 42, name: 'Blank Rune', words: 'adori vita', mana: 100, level: 1, vocations: [] },
      { sid: 43, name: 'Sudden Death Rune', words: 'adori tera', mana: 120, level: 2, vocations: [] },
    ],
  }).state;
  const html = P.renderConfigForm(state);
  assert.match(html, /id="trainer-rune-select"[\s\S]*?<option value="42" selected/, 'rune sid selected from config');
  assert.match(html, /id="trainer-rune-key"[\s\S]*?<option value="F6" selected/, 'rune hotkey restored');
  assert.match(html, /id="trainer-fallback-key"[\s\S]*?<option value="F7" selected/, 'fallback hotkey restored');
  assert.match(html, /id="trainer-stop-runes" checked/, 'stop rune-making derived checked');
  assert.match(html, /id="trainer-stop-botting" checked/, 'stop botting derived checked');
  assert.match(html, /Botting stopped — rune-making is off/, 'persistent stop-botting banner');
});
