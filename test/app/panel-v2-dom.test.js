'use strict';

/**
 * Slice-1a panel jsdom tests (REQ-26, design D7/D8): the product shell in a
 * real DOM — 5-tab navigation, ES/EN switcher, first-run tutorial with
 * localStorage persistence, readable log rendering from the snapshot
 * (never raw JSON), and the feature-detected audio stub.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');

/**
 * jsdom page with the real shell. `preEval(win)` runs right before app.js
 * evaluates (used to pre-seed localStorage / patch AudioContext). fetch is
 * stubbed to an empty 200 so polling never errors.
 */
function makePanel({ preEval } = {}) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  dom.window.fetch = async () => ({ json: async () => ({ identity: null }) });
  dom.window.eval(STATE_JS);
  if (preEval) preEval(dom.window);
  dom.window.eval(APP_JS);
  return dom;
}

async function teardown(dom) {
  // Let in-flight poll promises settle before closing the window (their
  // dispatch would otherwise throw on the closed document).
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  dom.window.close();
}

function click(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  assert.ok(el, 'element ' + selector + ' rendered');
  el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

const tabBtn = (id) => '.tab-btn[data-tab="' + id + '"]';
const panelOf = (dom, id) => dom.window.document.querySelector('.tab-panel[data-tab-panel="' + id + '"]');

/* ---------------------------------- tabs ---------------------------------- */

test('1.6: shell renders the dashboard first + 3 config tabs, 4 visible toggles, dashboard panel active', async () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.tab-btn').length, 4, '4 tab buttons');
    const ids = [...doc.querySelectorAll('.tab-btn')].map((b) => b.getAttribute('data-tab'));
    assert.deepEqual(ids, ['dashboard', 'heal', 'trainer', 'others'], 'dashboard is the first tab');
    for (const hidden of ['attack', 'cavebot']) {
      assert.equal(doc.querySelector('.tab-btn[data-tab="' + hidden + '"]'), null, hidden + ' tab absent');
    }
    assert.equal(doc.querySelectorAll('input[data-module]').length, 8, '4 dashboard cards + 4 visible tab toggles');
    assert.equal(doc.querySelectorAll('.dashboard-card').length, 4, 'dashboard card grid rendered');
    assert.equal(panelOf(dom, 'dashboard').hidden, false, 'dashboard panel visible by default');
    assert.equal(panelOf(dom, 'trainer').hidden, true, 'inactive panels hidden');
    assert.match(doc.querySelector('.dashboard-card[data-dashboard-card="training"]').textContent, /Magic training/);
  } finally {
    await teardown(dom);
  }
});

test('1.6: clicking a tab switches the active panel and the reducer state (pre-Connect, no gate)', async () => {
  const dom = makePanel();
  try {
    click(dom, tabBtn('trainer'));
    let s = dom.window.__mbPanel.getState();
    assert.equal(s.tab, 'trainer');
    assert.equal(panelOf(dom, 'trainer').hidden, false, 'trainer panel now visible');
    assert.equal(panelOf(dom, 'heal').hidden, true, 'heal panel hidden');

    click(dom, tabBtn('others'));
    s = dom.window.__mbPanel.getState();
    assert.equal(s.tab, 'others');
    assert.equal(panelOf(dom, 'others').hidden, false);
  } finally {
    await teardown(dom);
  }
});

test('1.6: each tab panel holds only the visible module toggles; hidden modules never render', async () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    const healModules = doc.querySelectorAll('.tab-panel[data-tab-panel="heal"] input[data-module]');
    assert.deepEqual([...healModules].map((i) => i.getAttribute('data-module')), ['healMagic'],
      'heal owns only healMagic (items + mana potions hidden)');
    const trainerModules = doc.querySelectorAll('.tab-panel[data-tab-panel="trainer"] input[data-module]');
    assert.deepEqual([...trainerModules].map((i) => i.getAttribute('data-module')), ['runes', 'training']);
    const othersModules = doc.querySelectorAll('.tab-panel[data-tab-panel="others"] input[data-module]');
    assert.deepEqual([...othersModules].map((i) => i.getAttribute('data-module')), ['eat'], 'others owns only eat');
    for (const hidden of ['attack', 'cavebot', 'trade', 'loot', 'spawns', 'huntStats', 'routes', 'healItems', 'manaItems']) {
      assert.equal(doc.querySelector('input[data-module="' + hidden + '"]'), null, hidden + ' toggle absent');
    }
  } finally {
    await teardown(dom);
  }
});

/* ---------------------------------- i18n ---------------------------------- */

test('1.4: ES switcher re-renders the panel in Spanish; EN is the default', async () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    // The fetch stub polls identity:null -> the gate sits at probing, whose
    // label localizes too (deterministic with the stub).
    assert.match(doc.getElementById('status-bar').textContent, /Waiting for game…/, 'default EN');
    assert.match(doc.querySelector('.lang-btn[data-lang="en"]').className, /active/);

    click(dom, '.lang-btn[data-lang="es"]');
    assert.equal(dom.window.__mbPanel.getState().lang, 'es');
    assert.match(doc.getElementById('status-bar').textContent, /Esperando al juego…/, 'gate label ES');
    assert.match(doc.querySelector('.tab-btn[data-tab="dashboard"]').textContent, /INICIO/, 'dashboard tab label ES');
    assert.match(doc.querySelector('.tab-btn[data-tab="heal"]').textContent, /CURAR/, 'tab label ES');
    assert.match(doc.querySelector('.tab-panel[data-tab-panel="heal"]').textContent, /Curar con magia/);

    click(dom, '.lang-btn[data-lang="en"]');
    assert.equal(dom.window.__mbPanel.getState().lang, 'en');
    assert.match(doc.getElementById('status-bar').textContent, /Waiting for game…/, 'back to EN');
  } finally {
    await teardown(dom);
  }
});

test('1.4: the language choice persists to localStorage and is restored on boot', async () => {
  const first = makePanel();
  try {
    click(first, '.lang-btn[data-lang="es"]');
    assert.equal(first.window.__mbPanel.getState().lang, 'es');
    assert.equal(first.window.localStorage.getItem('mb-panel-lang'), 'es', 'lang persisted on SET_LANG');
  } finally {
    await teardown(first);
  }
  // A fresh page pre-seeded with the saved lang opens in Spanish.
  const second = makePanel({
    preEval: (win) => { win.localStorage.setItem('mb-panel-lang', 'es'); },
  });
  try {
    assert.equal(second.window.__mbPanel.getState().lang, 'es', 'stored lang restored on boot');
    assert.match(second.window.document.getElementById('status-bar').textContent, /Esperando al juego…/);
  } finally {
    await teardown(second);
  }
});

/* -------------------------------- tutorial -------------------------------- */

test('1.5: first run shows the tutorial; Next walks every tab; Dismiss persists tutorialSeen', async () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    assert.ok(doc.querySelector('[data-tutorial]'), 'tutorial overlay on first run');
    assert.equal(dom.window.__mbPanel.getState().tutorial.step, 0);

    // Next -> live-data step. A disconnected guide stays on the real status
    // control rather than pretending configuration data already exists.
    click(dom, '[data-tutorial-action="next"]');
    assert.equal(dom.window.__mbPanel.getState().tutorial.step, 1);
    assert.ok(doc.querySelector('#status-bar').classList.contains('tutorial-target'));

    // Walk through every real-control step, then finish.
    let s = dom.window.__mbPanel.getState();
    while (s.tutorial && s.tutorial.step < dom.window.MbPanelState.TUTORIAL_STEPS.length - 1) {
      click(dom, '[data-tutorial-action="next"]');
      s = dom.window.__mbPanel.getState();
    }
    assert.equal(s.tab, 'trainer', 'last configuration step remains trainer before verification');
    click(dom, '[data-tutorial-action="next"]'); // Finish
    s = dom.window.__mbPanel.getState();
    assert.equal(s.tutorial, null, 'tour closed');
    assert.equal(dom.window.localStorage.getItem('tutorialSeen'), '1', 'finish persists tutorialSeen');
    assert.ok(!doc.querySelector('[data-tutorial]'), 'overlay removed');
  } finally {
    await teardown(dom);
  }
});

test('1.5: Dismiss skips the tour and persists tutorialSeen', async () => {
  const dom = makePanel();
  try {
    const doc = dom.window.document;
    assert.ok(doc.querySelector('[data-tutorial]'), 'overlay shown');
    click(dom, '[data-tutorial-action="dismiss"]');
    assert.equal(dom.window.__mbPanel.getState().tutorial, null);
    assert.equal(dom.window.localStorage.getItem('tutorialSeen'), '1');
    assert.ok(!doc.querySelector('[data-tutorial]'), 'overlay gone after dismiss');
  } finally {
    await teardown(dom);
  }
});

test('1.5: tutorial highlights the current real control, supports Back and can be restarted', async () => {
  const dom = makePanel();
  try {
    click(dom, '[data-tutorial-action="next"]');
    const status = dom.window.document.querySelector('#status-bar');
    assert.ok(status.classList.contains('tutorial-target'), 'live-data step highlights the real connection status');
    assert.equal(status.getAttribute('data-tutorial-active'), 'true');
    click(dom, '[data-tutorial-action="back"]');
    assert.equal(dom.window.__mbPanel.getState().tutorial.step, 0, 'Back returns without saving');

    click(dom, '[data-tutorial-action="dismiss"]');
    assert.equal(dom.window.__mbPanel.getState().tutorial, null);
    click(dom, '[data-tutorial-action="restart"]');
    assert.equal(dom.window.__mbPanel.getState().tutorial.step, 0, 'Guide starts the tutorial again after dismissal');
    assert.ok(dom.window.document.querySelector('#link-first-btn').classList.contains('tutorial-target'), 'restart returns to the real link control');
  } finally {
    await teardown(dom);
  }
});

test('1.5: tutorialSeen already set -> no overlay on boot', async () => {
  const dom = makePanel({ preEval: (win) => win.localStorage.setItem('tutorialSeen', '1') });
  try {
    assert.ok(!dom.window.document.querySelector('[data-tutorial]'), 'no overlay when seen before');
    assert.equal(dom.window.__mbPanel.getState().tutorial, null);
  } finally {
    await teardown(dom);
  }
});

test('1.5: tutorial steps are localized — ES shows the Spanish step text', async () => {
  const dom = makePanel();
  try {
    click(dom, '.lang-btn[data-lang="es"]');
    click(dom, '[data-tutorial-action="next"]');
    const card = dom.window.document.querySelector('.tutorial-card');
    assert.match(card.textContent, /Cargá los datos vivos/, 'ES step body');
    assert.match(card.textContent, /Atrás/, 'ES back label');
    assert.match(card.textContent, /Omitir tutorial/, 'ES dismiss label');
    assert.match(card.textContent, /Siguiente/, 'ES next label');
  } finally {
    await teardown(dom);
  }
});

/* ---------------------------------- log ----------------------------------- */

test('1.7: snapshot logBuffer renders formatted rows — never raw JSON', async () => {
  const dom = makePanel();
  try {
    dom.window.__mbPanel.dispatch({
      type: 'SNAPSHOT',
      data: {
        agent: {
          logBuffer: [
            { ts: 1000, module: 'healMagic', action: 'cast', result: 'heal' },
            { ts: 2000, module: 'training', action: 'cast', result: { sid: 50, reason: 'cadence' } },
          ],
        },
      },
    });
    const text = dom.window.document.getElementById('activity-log').textContent;
    assert.match(text, /Activity log/);
    assert.match(text, /Heal with magic/, 'module id mapped to its readable label');
    assert.match(text, /cast/, 'action rendered');
    assert.match(text, /sid 50/, 'object result rendered as readable fields');
    assert.ok(!text.includes('{') && !text.includes('}'), 'no JSON braces in the log');
    assert.equal(dom.window.document.querySelectorAll('#activity-log .log-row').length, 2);
    assert.ok(!dom.window.document.querySelector('#activity-log .live-payload'), 'legacy JSON dump gone');
  } finally {
    await teardown(dom);
  }
});

test('1.7: empty log state renders a placeholder; rows escape HTML', async () => {
  const dom = makePanel();
  try {
    const log = dom.window.document.getElementById('activity-log');
    assert.match(log.textContent, /No activity yet/);
    dom.window.__mbPanel.dispatch({
      type: 'SNAPSHOT',
      data: { logBuffer: [{ ts: 1, module: 'loot', action: 'route', result: '<script>' }] },
    });
    assert.match(log.innerHTML, /&lt;script&gt;/);
    assert.ok(!log.innerHTML.includes('<script>'), 'result HTML-escaped');
  } finally {
    await teardown(dom);
  }
});

/* -------------------------------- audio stub ------------------------------- */

test('1.7: beep stub is exposed and feature-detects — silent no-op without AudioContext', async () => {
  const dom = makePanel();
  try {
    const panel = dom.window.__mbPanel;
    assert.equal(typeof panel.beep, 'function', 'audio hook exposed');
    assert.equal(panel.beep(), false, 'jsdom has no AudioContext -> degrade, never throw');
  } finally {
    await teardown(dom);
  }
});

test('1.7: an ALERT dispatch rings the beep when AudioContext exists; the sound toggle silences it', async () => {
  let contexts = 0;
  let starts = 0;
  const dom = makePanel({
    preEval: (win) => {
      win.AudioContext = function () {
        contexts += 1;
        return {
          currentTime: 0,
          destination: {},
          createOscillator: () => ({
            type: '', frequency: {}, connect: () => {}, start: () => { starts += 1; },
            stop: () => {}, onended: null,
          }),
          createGain: () => ({ gain: {}, connect: () => {} }),
          close: async () => {},
        };
      };
    },
  });
  try {
    dom.window.__mbPanel.dispatch({ type: 'ALERT', kind: 'info', message: 'test alert' });
    assert.equal(contexts, 1, 'alert dispatch scheduled a beep');
    assert.equal(starts, 1, 'oscillator started');
    assert.equal(dom.window.__mbPanel.getState().alerts.length, 1);

    // Audit: sound toggle OFF -> the beep must NOT play; visual alerts still show.
    dom.window.__mbPanel.dispatch({ type: 'SET_SOUND', enabled: false });
    assert.equal(dom.window.__mbPanel.getState().soundEnabled, false);
    dom.window.__mbPanel.dispatch({ type: 'ALERT', kind: 'info', message: 'silent alert' });
    assert.equal(contexts, 1, 'no beep while sound is disabled');
    assert.equal(starts, 1, 'oscillator never started again');
    assert.equal(dom.window.__mbPanel.getState().alerts.length, 2, 'visual alerts still recorded');

    // Re-enable -> the beep rings again.
    dom.window.__mbPanel.dispatch({ type: 'SET_SOUND', enabled: true });
    dom.window.__mbPanel.dispatch({ type: 'ALERT', kind: 'info', message: 'audible again' });
    assert.equal(contexts, 2, 'beep restored after re-enabling sound');
  } finally {
    await teardown(dom);
  }
});

test('audit: the sound toggle persists to localStorage and is restored on boot', async () => {
  const first = makePanel();
  try {
    const toggle = first.window.document.getElementById('sound-toggle');
    assert.ok(toggle, 'sound toggle rendered in the status bar');
    assert.equal(toggle.checked, true, 'sound ON by default');
    toggle.checked = false;
    toggle.dispatchEvent(new first.window.Event('change', { bubbles: true }));
    assert.equal(first.window.__mbPanel.getState().soundEnabled, false);
    assert.equal(first.window.localStorage.getItem('mb-panel-sound'), '0', 'preference persisted');
  } finally {
    await teardown(first);
  }
  // A fresh page pre-seeded with the muted preference opens silent.
  const second = makePanel({
    preEval: (win) => { win.localStorage.setItem('mb-panel-sound', '0'); },
  });
  try {
    assert.equal(second.window.__mbPanel.getState().soundEnabled, false, 'muted state restored on boot');
    assert.equal(second.window.document.getElementById('sound-toggle').checked, false);
  } finally {
    await teardown(second);
  }
});
