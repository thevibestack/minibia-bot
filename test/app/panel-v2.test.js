'use strict';

/**
 * Slice-1a panel tests (REQ-26, design D7/D8): the product shell — 5 tabs
 * with per-tab module regrouping, ES/EN i18n (default EN), the first-run
 * tutorial stepper, and the readable activity log (never raw JSON).
 * Pure-reducer tests here; jsdom interaction tests live in panel-v2-dom.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../app/panel/state.js');

const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

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

/* ---------------------------------- tabs ---------------------------------- */

test('1.3: initial state has 4 visible tabs, dashboard active, full module registry intact', () => {
  const s = P.createInitialState();
  assert.deepEqual(P.TAB_IDS, ['dashboard', 'heal', 'trainer', 'others']);
  assert.equal(s.tab, 'dashboard', 'dashboard tab active by default');
  assert.equal(P.MODULE_IDS.length, 13, 'all 13 module ids stay in the registry (config round-trip safety)');
  const flat = P.TABS.flatMap((t) => t.modules).sort();
  assert.deepEqual(flat, ['eat', 'healMagic', 'runes', 'training'], 'only the visible modules land in a tab');
  for (const id of ['attack', 'cavebot', 'trade', 'loot', 'spawns', 'huntStats', 'routes', 'healItems', 'manaItems']) {
    assert.equal(P.HIDDEN_MODULES.has(id), true, id + ' is hidden');
  }
  // REQ-26 per-module On/Off: the FULL grouping stays intact for the render filter.
  assert.deepEqual(P.MODULE_BY_TAB.heal.map((d) => d.id), ['healItems', 'manaItems', 'healMagic']);
  assert.deepEqual(P.MODULE_BY_TAB.trainer.map((d) => d.id), ['runes', 'training']);
});

test('1.3: SET_TAB switches the active tab; unknown ids ignored', () => {
  const r = run([{ type: 'SET_TAB', tab: 'trainer' }]);
  assert.equal(r.state.tab, 'trainer');
  const r2 = run([{ type: 'SET_TAB', tab: 'nope' }]);
  assert.equal(r2.state.tab, 'dashboard', 'unknown tab ignored');
  assert.equal(r2.effects.length, 0);
});

test('1.3: renderModuleList renders the dashboard first + 3 config tabs; hidden modules never render', () => {
  const html = P.renderModuleList(P.createInitialState());
  assert.equal((html.match(/class="tab-btn/g) || []).length, 4, '4 tab buttons');
  assert.equal((html.match(/class="module-toggle"/g) || []).length, 4, 'only the 4 visible tab toggles');
  assert.equal((html.match(/data-dashboard-card="/g) || []).length, 4, '4 dashboard quick-access cards');
  assert.ok(html.indexOf('data-tab="dashboard"') !== -1 && html.indexOf('data-tab="dashboard"') < html.indexOf('data-tab="heal"'),
    'dashboard is the first tab button');
  for (const id of P.HIDDEN_MODULES) {
    assert.doesNotMatch(html, new RegExp('data-module="' + id + '"'), id + ' toggle never rendered');
  }
  assert.ok(html.includes('data-tab-panel="dashboard"') && !html.includes('data-tab-panel="dashboard" hidden'),
    'dashboard panel visible by default');
  assert.match(html, /data-tab-panel="trainer"[^>]*hidden/, 'inactive panels hidden');
  assert.doesNotMatch(html, /Skeleton — limited/, 'no stale skeleton disclosure');
});

test('1.3: toggle state survives tab switching (same reducer state, panel hidden in DOM)', () => {
  let s = P.createInitialState();
  s = P.panelReducer(s, { type: 'PROBE_START' }).state;
  s = P.panelReducer(s, { type: 'PROBE_RESULT', identity: FLAMAMEX }).state;
  s = P.panelReducer(s, { type: 'CONNECT' }).state;
  s = P.panelReducer(s, { type: 'TOGGLE_MODULE', module: 'runes', on: true }).state;
  s = P.panelReducer(s, { type: 'SET_TAB', tab: 'others' }).state;
  assert.equal(s.modules.runes, true, 'toggle kept when its tab is hidden');
  const html = P.renderModuleList(s);
  assert.match(html, /data-module="runes" checked/, 'checked state rendered inside its tab panel');
});

/* ---------------------------------- i18n ---------------------------------- */

test('1.4: default lang is EN; SET_LANG switches to ES and back', () => {
  assert.equal(P.createInitialState().lang, 'en', 'default EN (REQ-26)');
  assert.equal(run([{ type: 'SET_LANG', lang: 'es' }]).state.lang, 'es');
  assert.equal(run([{ type: 'SET_LANG', lang: 'fr' }]).state.lang, 'en', 'unknown lang falls back to EN');
});

test('1.4: t() resolves keys for the state lang with EN fallback', () => {
  const en = P.createInitialState();
  const es = run([{ type: 'SET_LANG', lang: 'es' }]).state;
  assert.equal(P.t(en, 'gate.armed'), 'Connected');
  assert.equal(P.t(es, 'gate.armed'), 'Conectado');
  assert.equal(P.t(es, 'activityLog'), 'Registro de actividad');
  assert.equal(P.t(es, 'missing.key'), 'missing.key', 'missing key returns the key itself');
});

test('1.4: tVar substitutes %reason% placeholders', () => {
  const en = P.createInitialState();
  const es = run([{ type: 'SET_LANG', lang: 'es' }]).state;
  assert.equal(P.tVar(en, 'refused', { reason: 'not connected' }), 'refused: not connected');
  assert.equal(P.tVar(es, 'refused', { reason: 'no conectado' }), 'rechazado: no conectado');
});

test('1.4: status bar + module labels render Spanish after SET_LANG (ES render test)', () => {
  let state = run([
    { type: 'PROBE_START' },
    { type: 'PROBE_RESULT', identity: FLAMAMEX },
    { type: 'SET_LANG', lang: 'es' },
  ]).state;
  const bar = P.renderStatusBar(state);
  assert.match(bar, /Confirmando conexión/, 'gate label ES');
  assert.match(bar, /Conectar/, 'connect button ES');
  assert.match(bar, /Idioma/, 'language switcher ES');

  state = P.panelReducer(state, { type: 'CONNECT' }).state;
  assert.match(P.renderStatusBar(state), /Conectado/);
  const list = P.renderModuleList(state);
  assert.match(list, /Curar con magia/, 'module label ES');
  assert.match(list, /OTROS/, 'tab label ES');
  assert.match(P.renderConfigForm(state), /Configuración/);
  assert.match(P.renderLiveState(state), /Estado en vivo/);
  assert.match(P.renderLog(state), /Registro de actividad/);
});


test('link-first button is available before a game session is confirmed', () => {
  const disconnected = P.createInitialState();
  assert.match(P.renderStatusBar(disconnected), /id="link-first-btn"/);
  assert.match(P.renderStatusBar(disconnected), /Link first PWA/);

  const probing = run([{ type: 'PROBE_START' }]).state;
  assert.match(P.renderStatusBar(probing), /id="link-first-btn"/);

  const confirmed = run([{ type: 'PROBE_START' }, { type: 'PROBE_RESULT', identity: FLAMAMEX }]).state;
  assert.doesNotMatch(P.renderStatusBar(confirmed), /id="link-first-btn"/);
});

test('ATTACH_FIRST enters probing and emits the attach-first effect', () => {
  const result = run([{ type: 'ATTACH_FIRST' }]);
  assert.equal(result.state.gate, P.GATE_PROBING);
  assert.deepEqual(result.effects, [{ type: 'attach-first' }]);
  const failed = P.panelReducer(result.state, { type: 'ATTACH_FIRST_FAILED', message: 'no PWA' }).state;
  assert.equal(failed.gate, P.GATE_DISCONNECTED);
  assert.equal(failed.lastError, 'no PWA');
});

/* -------------------------------- tutorial -------------------------------- */

test('1.5: TUTORIAL_START opens the ordered interactive guide; Next walks real-control tabs and finishes with tutorial-seen', () => {
  const r = run([{ type: 'TUTORIAL_START' }]);
  assert.deepEqual(r.state.tutorial, { step: 0 }, 'starts at the intro step');
  assert.equal(P.TUTORIAL_STEPS.length, 8, 'connect, survival, trainer and verification steps');

  let state = r.state;
  const seenTabs = [];
  for (let i = 1; i < P.TUTORIAL_STEPS.length; i += 1) {
    const next = P.panelReducer(state, { type: 'TUTORIAL_NEXT' });
    state = next.state;
    assert.equal(state.tutorial.step, i, 'step ' + i);
    if (P.TUTORIAL_STEPS[i].tab !== null) seenTabs.push(state.tab);
  }
  assert.deepEqual([...new Set(seenTabs)], ['heal', 'trainer'],
    'the guide walks every visible configuration tab with a real control');

  const done = P.panelReducer(state, { type: 'TUTORIAL_NEXT' });
  assert.equal(done.state.tutorial, null, 'last step closes the tour');
  assert.deepEqual(done.effects, [{ type: 'tutorial-seen' }], 'finish emits the persist effect');
});

test('1.5: tutorial resolves only existing controls and explains unavailable live data', () => {
  let state = P.createInitialState();
  let step = P.tutorialStepFor(state, 2);
  assert.equal(step.target, '#status-bar', 'disconnected catalog step highlights connection status, not a missing picker');
  assert.equal(step.body, 'tutorial.connectRequired');
  assert.equal(step.unavailable, true);

  state.gate = P.GATE_ARMED;
  state.catalog = { loaded: true, spells: [{ sid: 2, name: 'Healing' }] };
  state.hotbar = { available: false, slots: [] };
  state.inventory = { loaded: true, containers: [] };
  step = P.tutorialStepFor(state, 3);
  assert.equal(step.target, '#heal-save-btn', 'missing hotbar highlights the real save validation path');
  assert.equal(step.body, 'tutorial.hotbarUnavailable');

  state.hotbar = { available: true, slots: [{ slot: 2, sid: 2 }] };
  step = P.tutorialStepFor(state, 3);
  assert.equal(step.target, '#heal-items-refresh', 'empty BP state highlights its real refresh control');
  assert.equal(step.body, 'tutorial.inventoryUnavailable');

  state.inventory = { loaded: true, containers: [{ items: [{ cid: 7618, name: 'Health Potion' }] }] };
  step = P.tutorialStepFor(state, 3);
  assert.equal(step.target, '#heal-save-btn');
  assert.equal(step.unavailable, false);
});

test('1.5: TUTORIAL_BACK is navigation-only and returns to the prior step/tab', () => {
  let state = run([{ type: 'TUTORIAL_START' }]).state;
  state = P.panelReducer(state, { type: 'TUTORIAL_NEXT' }).state;
  state = P.panelReducer(state, { type: 'TUTORIAL_NEXT' }).state;
  assert.equal(state.tutorial.step, 2);
  assert.equal(state.tab, 'heal');
  const back = P.panelReducer(state, { type: 'TUTORIAL_BACK' });
  assert.equal(back.state.tutorial.step, 1);
  assert.equal(back.state.tab, 'heal');
  assert.deepEqual(back.effects, [], 'back never saves or invokes bot work');
});

test('1.5: TUTORIAL_DISMISS closes the tour with the persist effect; NEXT before start is a no-op', () => {
  const start = run([{ type: 'TUTORIAL_START' }]).state;
  const dismissed = P.panelReducer(start, { type: 'TUTORIAL_DISMISS' });
  assert.equal(dismissed.state.tutorial, null);
  assert.deepEqual(dismissed.effects, [{ type: 'tutorial-seen' }]);

  const noop = P.panelReducer(P.createInitialState(), { type: 'TUTORIAL_NEXT' });
  assert.equal(noop.state.tutorial, null, 'NEXT without START ignored');
  assert.equal(noop.effects.length, 0);

  const again = P.panelReducer(P.createInitialState(), { type: 'TUTORIAL_START' });
  assert.deepEqual(again.state.tutorial, { step: 0 });
  const twice = P.panelReducer(again.state, { type: 'TUTORIAL_START' });
  assert.deepEqual(twice.state.tutorial, { step: 0 }, 'START while running is a no-op');
});

test('1.5: renderTutorial shows the step card with localized title, progress and accessible navigation', () => {
  const state = run([{ type: 'TUTORIAL_START' }, { type: 'TUTORIAL_NEXT' }]).state;
  const html = P.renderTutorial(state);
  assert.match(html, /data-tutorial/, 'overlay rendered');
  assert.match(html, /data-tutorial-action="next"/);
  assert.match(html, /data-tutorial-action="back"/);
  assert.match(html, /data-tutorial-action="dismiss"/);
  assert.match(html, /2 \/ 8/, 'progress');
  assert.match(html, /Load live data/, 'step title is actionable');
  assert.equal(P.renderTutorial(P.createInitialState()), '', 'no overlay when not running');
});

/* ----------------------------------- log ---------------------------------- */

test('1.7: renderLog renders snapshot logBuffer rows as readable text — never JSON', () => {
  const state = P.createInitialState();
  state.snapshot = {
    logBuffer: [
      { ts: 1000, module: 'healMagic', action: 'cast', result: 'heal' },
      { ts: 2000, module: 'training', action: 'cast', result: { sid: 50, reason: 'cadence' } },
      { ts: 3000, module: 'agent', action: 'error', result: 'tick failed' },
    ],
  };
  const html = P.renderLog(state);
  assert.match(html, /Heal with magic/, 'module id mapped to its readable label');
  assert.match(html, /cast/, 'action shown');
  assert.match(html, /heal/, 'primitive result shown');
  assert.match(html, /sid 50/, 'object result rendered as readable fields');
  assert.match(html, /reason cadence/, 'object fields joined without JSON syntax');
  assert.match(html, /tick failed/, 'sink entries render');
  assert.ok(!html.includes('{'), 'no raw JSON');
  assert.ok(!html.includes('live-payload'), 'legacy JSON dump gone');
  const rows = (html.match(/class="log-row"/g) || []).length;
  assert.equal(rows, 3, 'one row per entry');
});

test('1.7: renderLog reads the agent-carried buffer and escapes everything', () => {
  const state = P.createInitialState();
  state.snapshot = { agent: { logBuffer: [{ ts: 1, module: 'loot', action: 'route', result: '<script>' }] } };
  const html = P.renderLog(state);
  assert.match(html, /&lt;script&gt;/, 'results HTML-escaped (XSS-safe)');
  assert.doesNotMatch(html, /<script>/, 'never raw');
  const empty = P.renderLog(P.createInitialState());
  assert.match(empty, /Activity log/);
  assert.match(empty, /No activity yet\./, 'empty state');
});

test('1.7: formatLogResult never produces JSON syntax', () => {
  assert.equal(P.formatLogResult('heal'), 'heal');
  assert.equal(P.formatLogResult(42), '42');
  assert.equal(P.formatLogResult(null), '');
  assert.equal(P.formatLogResult({ sid: 50, ok: true }), 'sid 50, ok true');
  assert.equal(P.formatLogResult({ nested: { a: 1 }, keep: 'x' }), 'keep x', 'nested objects skipped');
  assert.equal(P.formatLogResult({}), '', 'empty object -> empty text');
});

test('1.7: snapshotStats reads app/agent/legacy shapes without inventing zeros', () => {
  assert.deepEqual(P.snapshotStats({ stats: { health: 42, mana: 80, maxMana: 100 } }),
    { health: 42, mana: 80, maxHealth: null, maxMana: 100 }, 'app shape');
  assert.deepEqual(P.snapshotStats({ agent: { health: 10, mana: 5 } }),
    { health: 10, mana: 5, maxHealth: null, maxMana: null }, 'agent shape');
  assert.deepEqual(P.snapshotStats({ health: 7, mana: 9 }),
    { health: 7, mana: 9, maxHealth: null, maxMana: null }, 'legacy flat shape');
  assert.deepEqual(P.snapshotStats(null), { health: null, mana: null, maxHealth: null, maxMana: null });
  assert.deepEqual(P.snapshotStats({}), { health: null, mana: null, maxHealth: null, maxMana: null });
});

test('1.7: renderLiveState renders the stats line without raw JSON', () => {
  const state = P.createInitialState();
  state.snapshot = { stats: { health: 42, maxHealth: 200, mana: 80, maxMana: 100 } };
  const html = P.renderLiveState(state);
  assert.match(html, /Health 42 \/ 200/);
  assert.match(html, /Mana 80 \/ 100/);
  assert.ok(!html.includes('{'), 'no JSON braces');
  assert.ok(!html.includes('live-payload'), 'legacy JSON dump gone');
});

/* --------------------- audit: alerts + sound toggle --------------------- */

test('audit: SET_SOUND toggles soundEnabled (default ON) with a persist effect', () => {
  assert.equal(P.createInitialState().soundEnabled, true, 'sound defaults ON');
  const off = run([{ type: 'SET_SOUND', enabled: false }]);
  assert.equal(off.state.soundEnabled, false);
  assert.deepEqual(off.effects, [{ type: 'sound-set', enabled: false }], 'persist effect emitted');
  const on = run([{ type: 'SET_SOUND', enabled: true }]);
  assert.equal(on.state.soundEnabled, true);
  assert.deepEqual(on.effects, [{ type: 'sound-set', enabled: true }]);
});

test('audit: renderStatusBar renders the sound toggle checked/unchecked', () => {
  const on = P.createInitialState();
  const onHtml = P.renderStatusBar(on);
  assert.match(onHtml, /id="sound-toggle" checked/, 'checked when soundEnabled');
  assert.match(onHtml, /Alert sounds/, 'localized label (EN)');
  const off = run([{ type: 'SET_SOUND', enabled: false }]).state;
  assert.match(P.renderStatusBar(off), /id="sound-toggle"/);
  assert.doesNotMatch(P.renderStatusBar(off), /id="sound-toggle" checked/, 'unchecked when muted');
});

test('audit: renderAlerts shows a bounded, escaped list with localized kind labels', () => {
  const state = run([
    { type: 'ALERT', kind: 'cap-full', message: 'Rune cap full — stopped', at: 1000 },
    { type: 'ALERT', kind: 'antibot-speak', message: '<script>alert(1)</script>', at: 2000 },
    { type: 'ALERT', kind: 'mystery', message: 'mystery event', at: 3000 },
  ]).state;
  assert.equal(state.alerts.length, 3, 'reducer keeps every alert (under the 20 cap)');
  const html = P.renderAlerts(state);
  assert.match(html, /Alerts/, 'section header');
  assert.match(html, /Rune cap full/, 'localized cap-full kind label');
  assert.match(html, /Anti-bot: speak/, 'localized antibot kind label');
  assert.match(html, /mystery/, 'unknown kind falls back to the raw kind');
  assert.match(html, /&lt;script&gt;/, 'messages HTML-escaped (XSS-safe)');
  assert.doesNotMatch(html, /<script>/, 'never raw');
  assert.equal(P.renderAlerts(P.createInitialState()).includes('No alerts yet.'), true, 'empty state');

  // Bound: only the last 8 render even with more in state.
  const many = run(Array.from({ length: 25 }, (_, i) => ({ type: 'ALERT', kind: 'info', message: 'm' + i, at: i }))).state;
  assert.equal(many.alerts.length, 20, 'reducer caps at 20');
  assert.equal((P.renderAlerts(many).match(/class="panel-alert"/g) || []).length, 8, 'render bounds to 8');
});

test('audit: ES renders the alerts section and sound label in Spanish', () => {
  const state = run([
    { type: 'SET_LANG', lang: 'es' },
    { type: 'ALERT', kind: 'cap-full', message: 'Tope lleno', at: 1 },
  ]).state;
  assert.match(P.renderAlerts(state), /Tope de runas lleno/, 'kind label ES');
  assert.match(P.renderAlerts(state), /Alertas/, 'section header ES');
  assert.match(P.renderStatusBar(state), /Sonidos de alerta/, 'sound label ES');
});
