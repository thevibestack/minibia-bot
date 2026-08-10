'use strict';

/**
 * PR 6 — ATTACK + CAVEBOT skeleton panel tests (REQ-35/36, D10): the ATTACK
 * settings form (targeting + rune slot, spell via picker), the CAVEBOT
 * controls (record/stop/save/pause/resume/start), gate refusals, the
 * config.routes save shape and the skeleton disclosures. Pure reducer +
 * render strings — no DOM.
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

/* -------------------------------- ATTACK --------------------------------- */

test('REQ-35: UPDATE_ATTACK_INPUT preserves the raw form values across re-renders', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'targeting', value: 'nearest' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'runeSlot', value: '4' }).state;
  assert.deepEqual(state.attackForm, { targeting: 'nearest', runeSlot: '4' });
  const r = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'bogus', value: '1' });
  assert.deepEqual(r.state.attackForm, state.attackForm, 'unknown key ignored');
});

test('REQ-35: SAVE_ATTACK_SETTINGS refused pre-Connect (not connected)', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'SAVE_ATTACK_SETTINGS' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-35: SAVE_ATTACK_SETTINGS rejects invalid targeting and rune slot with a reason', () => {
  const badTarget = P.panelReducer(armedState(), { type: 'SAVE_ATTACK_SETTINGS' });
  // Untouched form -> targeting defaults to lowest-hp, slot empty -> valid.
  assert.equal(badTarget.effects.length, 1, 'defaults save cleanly');
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'targeting', value: 'random' }).state;
  const rejected = P.panelReducer(state, { type: 'SAVE_ATTACK_SETTINGS' });
  assert.equal(rejected.effects.length, 0);
  assert.equal(rejected.state.refusal.module, 'attack');
  assert.match(rejected.state.refusal.reason, /targeting/);
  state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'runeSlot', value: '13' }).state;
  const badSlot = P.panelReducer(state, { type: 'SAVE_ATTACK_SETTINGS' });
  assert.equal(badSlot.effects.length, 0);
  assert.match(badSlot.state.refusal.reason, /1-12/);
});

test('REQ-35: SAVE_ATTACK_SETTINGS commits targeting + rune slot into config.modules.attack and pushes', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'targeting', value: 'nearest' }).state;
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'runeSlot', value: '4' }).state;
  const r = P.panelReducer(state, { type: 'SAVE_ATTACK_SETTINGS' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.equal(r.state.config.modules.attack.targeting, 'nearest');
  assert.equal(r.state.config.modules.attack.runeSlot, 4);
  assert.deepEqual(r.state.attackForm, { targeting: 'nearest', runeSlot: '4' });
});

test('REQ-35: empty rune slot saves as null (no rune configured)', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'UPDATE_ATTACK_INPUT', key: 'runeSlot', value: '' }).state;
  const r = P.panelReducer(state, { type: 'SAVE_ATTACK_SETTINGS' });
  assert.equal(r.state.config.modules.attack.runeSlot, null);
});

test('REQ-35: attackFormFromConfig derives the form from the saved config', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'PREFILL_CONFIG', config: {
    modules: { attack: { on: true, targeting: 'nearest', sid: 12, runeSlot: 5 } },
  } }).state;
  assert.deepEqual(P.attackFormFromConfig(state), { targeting: 'nearest', runeSlot: '5' });
});

test('REQ-35: renderAttackForm discloses the skeleton + renders the picker controls', () => {
  const state = armedState();
  const html = P.renderAttackForm(state);
  assert.match(html, /skeleton/, 'disclosure renders');
  assert.match(html, /attack-targeting/, 'targeting select');
  assert.match(html, /attack-rune-slot/, 'rune slot input');
  assert.match(html, /attack-save-btn/, 'save button');
});

/* -------------------------------- CAVEBOT --------------------------------- */

test('REQ-36: CAVEBOT_COMMAND refused pre-Connect (not connected)', () => {
  const r = P.panelReducer(P.createInitialState(), { type: 'CAVEBOT_COMMAND', command: 'record' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
});

test('REQ-36: record/start/stop emit the cavebot-command effect (server RPC)', () => {
  const s = armedState();
  assert.deepEqual(P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'record' }).effects,
    [{ type: 'cavebot-command', command: 'record-start' }]);
  assert.deepEqual(P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'start' }).effects,
    [{ type: 'cavebot-command', command: 'start' }]);
  assert.deepEqual(P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'stop' }).effects,
    [{ type: 'cavebot-command', command: 'record-stop' }]);
  assert.deepEqual(P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'bogus' }).effects, []);
});

test('REQ-36: CAVEBOT_RECORDED stores the stopped recording for Save', () => {
  const r = P.panelReducer(armedState(), { type: 'CAVEBOT_RECORDED', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  assert.equal(r.state.cavebotRecorded.points.length, 2);
  const empty = P.panelReducer(armedState(), { type: 'CAVEBOT_RECORDED', points: 'junk' });
  assert.deepEqual(empty.state.cavebotRecorded.points, []);
});

test('REQ-36: Save writes config.routes from the recorded points and pushes (REQ-36 "save = config.routes")', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'CAVEBOT_RECORDED', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }).state;
  const r = P.panelReducer(state, { type: 'CAVEBOT_COMMAND', command: 'save' });
  assert.deepEqual(r.effects, [{ type: 'push-config' }]);
  assert.deepEqual(r.state.config.routes, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});

test('REQ-36: Save with nothing recorded is a no-op (no silent empty route)', () => {
  const s = armedState();
  const r = P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'save' });
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.config, s.config, 'config untouched');
});

test('REQ-36: pause/resume toggle config.modules.cavebot.paused and push', () => {
  const s = armedState();
  const paused = P.panelReducer(s, { type: 'CAVEBOT_COMMAND', command: 'pause' });
  assert.deepEqual(paused.effects, [{ type: 'push-config' }]);
  assert.equal(paused.state.config.modules.cavebot.paused, true);
  const resumed = P.panelReducer(paused.state, { type: 'CAVEBOT_COMMAND', command: 'resume' });
  assert.equal(resumed.state.config.modules.cavebot.paused, false);
});

test('REQ-36: renderCavebotForm renders the controls + FUTURE disclosure + honest status', () => {
  let state = armedState();
  state = P.panelReducer(state, { type: 'SNAPSHOT', data: {
    agent: { modules: { cavebot: {
      on: true, paused: true, recording: { active: true, points: 3 },
      savedRoute: { count: 5 },
    } } },
  } }).state;
  const html = P.renderCavebotForm(state);
  assert.match(html, /data-cavebot-command="record"/);
  assert.match(html, /data-cavebot-command="stop"/);
  assert.match(html, /data-cavebot-command="save"/);
  assert.match(html, /data-cavebot-command="start"/);
  assert.match(html, /FUTURE/, 'route editing disclosure');
  assert.match(html, /Recording — 3 waypoints/);
  assert.match(html, /Saved route: 5 waypoints/);
  assert.match(html, /Paused/);
});

test('REQ-36: renderCavebotForm without a snapshot shows the idle status (no crash)', () => {
  const html = P.renderCavebotForm(armedState());
  assert.match(html, /data-cavebot-command="record"/);
  assert.match(html, /FUTURE/);
});

/* ------------------------------ tab disclosure ----------------------------- */

test('REQ-35/36: the ATTACK + CAVEBOT tabs keep the skeleton disclosure under the toggles', () => {
  const state = armedState();
  const html = P.renderModuleList(state);
  assert.match(html, /data-module="attack"/, 'attack toggle rendered');
  assert.match(html, /data-module="cavebot"/, 'cavebot toggle rendered');
  assert.match(html, /Skeleton — limited/, 'disclosure visible');
});

test('REQ-35/36: MODULE_IDS grows to 12 with attack + cavebot', () => {
  assert.equal(P.MODULE_IDS.length, 12);
  assert.equal(P.MODULE_IDS.indexOf('attack') !== -1, true);
  assert.equal(P.MODULE_IDS.indexOf('cavebot') !== -1, true);
});
