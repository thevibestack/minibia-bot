'use strict';

/**
 * Slice-1b panel state tests (REQ-27/28, design D5/D6): profile cross-load
 * state + rejection rendering, the filtered spell picker with mana/vocation
 * rejection, and the catalog/profile actions. Pure-reducer tests; jsdom
 * interaction lives in panel-slice1b-dom.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../app/panel/state.js');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/** Catalog rows already filtered by the server for a level-20 druid. */
const CATALOG = [
  { sid: 0, name: 'Light', words: 'utevo lux', mana: 20, level: 0, vocations: ['sorcerer', 'druid'], description: 'Surround yourself with light' },
  { sid: 1, name: 'Explosion Rune', words: 'adori mas', mana: 120, level: 6, vocations: ['druid'], description: 'Creates an Explosion Rune' },
  { sid: 2, name: 'Force Strike', words: 'exori mort', mana: 20, level: 2, vocations: ['druid'], description: 'Strike with physical force' },
  { sid: 3, name: 'Intense Healing', words: 'exura gran', mana: 170, level: 8, vocations: ['druid'], description: 'Heal Damage' },
];

function run(actions, fromState) {
  let state = fromState || P.createInitialState();
  let effects = [];
  for (const a of actions) {
    const r = P.panelReducer(state, a);
    state = r.state;
    effects = effects.concat(r.effects);
  }
  return { state, effects };
}

function armedState(extraActions = []) {
  return run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'CONNECT' },
    { type: 'SPELL_CATALOG', spells: CATALOG },
  ].concat(extraActions)).state;
}

/** State with a live snapshot carrying known mana. */
function armedWithMana(mana, extra = {}) {
  const state = armedState();
  state.snapshot = Object.assign({ stats: { health: 42, mana, maxMana: 300 } }, extra);
  return state;
}

/* ------------------------ profiles (REQ-27) ------------------------ */

test('2.5: initial state carries the slice-1b shape (profiles/catalog/picker/profileLoad)', () => {
  const s = P.createInitialState();
  assert.deepEqual(s.profiles, []);
  assert.deepEqual(s.catalog, { spells: [], loaded: false, reason: null });
  assert.deepEqual(s.picker, { module: 'healMagic', query: '' });
  assert.equal(s.profileLoad, null);
  assert.deepEqual(P.PICKER_MODULES, ['healMagic', 'training'], 'visible picker targets (attack hidden)');
});

test('2.5: PROFILES_LOADED stores the sorted profile names', () => {
  const r = run([{ type: 'PROFILES_LOADED', names: ['Rooker', 'Gobernador', 'Flamamex'] }]);
  assert.deepEqual(r.state.profiles, ['Flamamex', 'Gobernador', 'Rooker']);
  const none = run([{ type: 'PROFILES_LOADED', names: 'nope' }]);
  assert.deepEqual(none.state.profiles, []);
});

test('2.5: LOAD_PROFILE is armed-gated and emits the load-profile effect', () => {
  const unarmed = run([{ type: 'LOAD_PROFILE', from: 'Gobernador' }]);
  assert.equal(unarmed.effects.length, 0);
  assert.equal(unarmed.state.refusal.reason, 'not connected');

  const armed = run([{ type: 'LOAD_PROFILE', from: 'Gobernador' }], armedState());
  assert.deepEqual(armed.effects, [{ type: 'load-profile', from: 'Gobernador' }]);
  assert.equal(armed.state.refusal, null);
});

test('2.5: LOAD_PROFILE with an empty from is ignored', () => {
  const r = run([{ type: 'LOAD_PROFILE', from: '  ' }], armedState());
  assert.deepEqual(r.effects, []);
});

test('2.5: PROFILE_LOAD_RESULT stores the rejection list for the visible render', () => {
  const r = run([{
    type: 'PROFILE_LOAD_RESULT',
    ok: true,
    from: 'Gobernador',
    rejected: [{ key: 'healMagic.sid', reason: 'vocation mismatch — requires sorcerer' }],
  }]);
  assert.equal(r.state.profileLoad.ok, true);
  assert.equal(r.state.profileLoad.from, 'Gobernador');
  assert.deepEqual(r.state.profileLoad.rejected,
    [{ key: 'healMagic.sid', reason: 'vocation mismatch — requires sorcerer' }]);
});

test('2.5: renderConfigForm shows the cross-load select (excluding current) + rejection list when armed', () => {
  let state = armedState([
    { type: 'PROFILES_LOADED', names: ['Flamamex', 'Gobernador', 'Rooker'] },
    {
      type: 'PROFILE_LOAD_RESULT',
      ok: true,
      from: 'Gobernador',
      rejected: [{ key: 'healMagic.sid', reason: 'vocation mismatch — requires sorcerer' }],
    },
  ]);
  const html = P.renderConfigForm(state);
  assert.match(html, /id="profile-select"/, 'cross-load select rendered');
  assert.ok(!html.includes('value="Flamamex"'), 'current character excluded from the list');
  assert.ok(html.includes('value="Gobernador"') && html.includes('value="Rooker"'), 'other profiles offered');
  assert.match(html, /id="profile-load-btn"/);
  assert.match(html, /healMagic\.sid/, 'rejected key visible');
  assert.match(html, /vocation mismatch — requires sorcerer/, 'rejection reason visible');
});

test('2.5: renderConfigForm degrades — no profiles and failed loads render honest text', () => {
  const noProfiles = P.renderConfigForm(armedState([{ type: 'PROFILES_LOADED', names: ['Flamamex'] }]));
  assert.match(noProfiles, /No saved configs for other characters yet/);
  assert.ok(!noProfiles.includes('profile-select'), 'no select without other profiles');

  const failed = P.renderConfigForm(armedState([{
    type: 'PROFILE_LOAD_RESULT',
    ok: false,
    from: 'Gobernador',
    reason: 'spell catalog unavailable',
  }]));
  assert.match(failed, /Could not load Gobernador(&#39;|')s config: spell catalog unavailable/);
});

/* ------------------------ spell picker (REQ-28) ------------------------ */

test('2.7: SPELL_CATALOG stores the filtered list; a degrade reason renders', () => {
  const loaded = run([{ type: 'SPELL_CATALOG', spells: CATALOG }]);
  assert.equal(loaded.state.catalog.loaded, true);
  assert.equal(loaded.state.catalog.spells.length, 4);
  assert.equal(loaded.state.catalog.reason, null);

  const degraded = run([{ type: 'SPELL_CATALOG', spells: [], reason: 'spell catalog unavailable' }]);
  assert.match(P.renderSpellPicker(degraded.state), /spell catalog unavailable/);
});

test('2.7: renderSpellPicker lists castable spells by selected category', () => {
  const html = P.renderSpellPicker(armedState());
  assert.match(html, /Intense Healing/, 'heal category lists healing spells');
  assert.ok(!html.includes('Explosion Rune'), 'rune makers stay out of heal category');
  assert.ok(!html.includes('Light</span>'), 'utility spells stay out of heal category');
  assert.match(html, /mana 170, level 8/, 'cost + level badges');
  assert.match(html, /data-pick-spell="3"/, 'pick button carries the sid');

  const training = P.panelReducer(armedState(), { type: 'PICKER_SET_MODULE', module: 'training' }).state;
  const trainingHtml = P.renderSpellPicker(training);
  assert.match(trainingHtml, /Explosion Rune/, 'training category lists rune-making spells');
  assert.ok(!trainingHtml.includes('Intense Healing'), 'healing stays out of rune-making category');

  const attack = P.panelReducer(armedState(), { type: 'PICKER_SET_MODULE', module: 'attack' }).state;
  const attackHtml = P.renderSpellPicker(attack);
  assert.match(attackHtml, /Intense Healing/, 'hidden attack module is not a picker target — list stays on the heal category');
  assert.doesNotMatch(attackHtml, /Force Strike/, 'no offensive picker for the hidden attack module');
});

test('2.7: PICKER_SEARCH narrows the rendered list; PICKER_SET_MODULE switches target', () => {
  let state = run([{ type: 'PICKER_SEARCH', query: 'healing' }], armedState()).state;
  const html = P.renderSpellPicker(state);
  assert.match(html, /Intense Healing/);
  assert.equal((html.match(/class="picker-row"/g) || []).length, 1, 'only the matching spell row remains');

  state = P.panelReducer(state, { type: 'PICKER_SET_MODULE', module: 'training' }).state;
  const html2 = P.renderSpellPicker(state);
  assert.match(html2, /Rune-making spell/, 'training target button active');
});

test('2.7: PICK_SPELL refused pre-Connect ("not connected")', () => {
  const r = run([{ type: 'PICK_SPELL', module: 'healMagic', sid: 0 }]);
  assert.equal(r.state.refusal.reason, 'not connected');
  assert.equal(r.effects.length, 0);
});

test('2.7: PICK_SPELL with a sid outside the castable list is refused with the vocation reason', () => {
  const state = armedState();
  const r = P.panelReducer(state, { type: 'PICK_SPELL', module: 'healMagic', sid: 4 });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.action, 'PICK_SPELL');
  assert.match(r.state.refusal.reason, /spell not available for druid/);
  assert.equal(r.state.config, null, 'config untouched');
});

test('2.7: PICK_SPELL whose cost exceeds current mana still persists the rule for runtime waiting', () => {
  const state = armedWithMana(80); // Intense Healing costs 170
  const r = P.panelReducer(state, { type: 'PICK_SPELL', module: 'healMagic', sid: 3 });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.healMagic.sid, 3);
  assert.equal(r.state.refusal, null);
});

test('2.7: PICK_SPELL within mana applies the sid and pushes the config', () => {
  const state = armedWithMana(200);
  const r = P.panelReducer(state, { type: 'PICK_SPELL', module: 'healMagic', sid: 3 });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.healMagic.sid, 3, 'sid written into the config');
  assert.equal(r.state.refusal, null);
  assert.match(P.renderSpellPicker(r.state), /current/, 'current pick marked in the list');
});

test('2.7: PICK_SPELL works for the training module too; unknown module ignored', () => {
  const state = armedWithMana(200);
  const r = P.panelReducer(state, { type: 'PICK_SPELL', module: 'training', sid: 0 });
  assert.equal(r.state.config.modules.training.sid, 0);
  const bad = P.panelReducer(state, { type: 'PICK_SPELL', module: 'loot', sid: 0 });
  assert.equal(bad.effects.length, 0, 'unknown module ignored');
});

test('2.7: mana unknown (no snapshot yet) -> pick allowed (agent gates casts by feasibility)', () => {
  const state = armedState(); // snapshot null
  const r = P.panelReducer(state, { type: 'PICK_SPELL', module: 'healMagic', sid: 3 });
  assert.deepEqual(r.effects, [{ type: 'push-config' }], 'no mana data -> no mana rejection');
});

test('configuration feedback: refresh and a successful save clear stale save errors', () => {
  let state = armedState();
  state.lastError = 'stale error';
  state.refusal = { action: 'SAVE_CONFIGURATION', reason: 'stale refusal', at: 1 };
  state = P.panelReducer(state, { type: 'REFRESH_GAME_DATA' }).state;
  assert.equal(state.lastError, null);
  assert.equal(state.refusal, null);
  state.lastError = 'another stale error';
  state.refusal = { action: 'SAVE_CONFIGURATION', reason: 'stale refusal', at: 1 };
  state = P.panelReducer(state, { type: 'CONFIG_SAVE_RESULT', ok: true }).state;
  assert.equal(state.lastError, null);
  assert.equal(state.refusal, null);
});

test('2.7: picker + loader render inside the config form only when armed', () => {
  const unarmed = P.renderConfigForm(P.createInitialState());
  assert.ok(!unarmed.includes('spell-picker'), 'picker hidden pre-Connect');
  assert.ok(!unarmed.includes('profile-loader'), 'loader hidden pre-Connect');

  const armed = P.renderConfigForm(armedState());
  assert.match(armed, /class="spell-picker"/);
  assert.match(armed, /class="profile-loader"/);
  assert.doesNotMatch(armed, /route-walk-btn/, 'routes form removed with the hidden routes module');
});
