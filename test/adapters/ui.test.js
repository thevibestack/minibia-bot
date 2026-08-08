'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createUi } = require('../../src/adapters/ui');

/** Fresh jsdom document with the panel mountable into body. */
function makeDom() {
  return new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
  });
}

/** Build a UI instance with default-ish deps (HUD cadence kept inert). */
function makeUi(dom, overrides = {}) {
  const calls = { start: 0, pause: 0, reset: 0, saved: undefined };
  const ui = createUi({
    document: dom.window.document,
    getCatalog: () => overrides.catalog ?? null,
    getSnapshot: () =>
      typeof overrides.snapshot === 'function'
        ? overrides.snapshot()
        : overrides.snapshot ?? { mana: 100, maxMana: 120, status: 'idle', playerName: 'Flamamex' },
    saveConfig: async (raw, prev) => {
      calls.saved = { raw, prev };
      return overrides.saveResult ?? { ok: true, config: { ...prev, ...raw } };
    },
    onStart: () => calls.start++,
    onPause: () => calls.pause++,
    onReset: () => calls.reset++,
    schedule: () => ({ id: 0 }),
    clear: () => {},
    ...overrides.deps,
  });
  return { dom, ui, calls };
}

/** Current wizard step number from the indicator. */
function curStep(d) {
  return Number(d.querySelector('[data-ui-step-indicator]').textContent.match(/Step (\d) of 5/)[1]);
}

/** Click Next when possible; returns the resulting step. */
function clickNext(d) {
  d.querySelector('[data-ui-wizard-next]').click();
  return curStep(d);
}

/** Click Back when possible; returns the resulting step. */
function clickBack(d) {
  d.querySelector('[data-ui-wizard-back]').click();
  return curStep(d);
}

/** Fill the first spell row with a valid slot + word. */
function fillFirstSpell(d, { slot = '4', word = 'adori' } = {}) {
  d.querySelector('[data-ui-spell-slot]').value = slot;
  d.querySelector('[data-ui-spell-word]').value = word;
}

/** Navigate to a step, filling valid defaults when validation would block. */
function goTo(d, n) {
  while (curStep(d) < n) {
    if (curStep(d) === 2) fillFirstSpell(d);
    clickNext(d);
  }
}

test('wizard: shell renders the panel, all five steps, HUD contract and controls', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  assert.ok(d.querySelector('[data-ui-panel]'), 'panel container present');
  assert.ok(d.querySelector('[data-ui-wizard]'), 'wizard container present');
  assert.equal(d.querySelector('[data-ui-step-indicator]').textContent, 'Step 1 of 5');
  for (const attr of ['step-welcome', 'step-spell', 'step-when', 'step-repeat', 'step-review']) {
    assert.ok(d.querySelector(`[data-ui-${attr}]`), `missing [data-ui-${attr}]`);
  }
  for (const attr of [
    'wizard-next', 'wizard-back', 'minimize', 'hide', 'run', 'mini', 'handle',
    'add-spell', 'spell-rows', 'errors', 'food-slot', 'food-cid', 'food-name',
    'food-search', 'food-results', 'food-find', 'food-every-casts', 'food-window',
    'food-fallback', 'food-advanced', 'jitter-min', 'jitter-max', 'firing-mode',
    'review-summary', 'save', 'start', 'pause', 'configure', 'reset', 'status-dot',
  ]) {
    assert.ok(d.querySelector(`[data-ui-${attr}]`), `missing [data-ui-${attr}]`);
  }
  // [data-hud-*] contract stays present (run view, hidden during the wizard)
  for (const attr of [
    'mana', 'next', 'food', 'cooldown', 'status', 'every-casts',
    'casts', 'eats', 'misses', 'words', 'log',
  ]) {
    assert.ok(d.querySelector(`[data-hud-${attr}]`), `missing [data-hud-${attr}]`);
  }
  ui.destroy();
});

test('wizard: welcome shows the detected character; fresh config offers Get started', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  assert.equal(d.querySelector('[data-ui-welcome-name]').textContent, 'Flamamex');
  assert.equal(d.querySelector('[data-ui-welcome-start]').style.display, '');
  assert.equal(d.querySelector('[data-ui-resume]').style.display, 'none');
  assert.equal(d.querySelector('[data-ui-step-welcome]').style.display, '');
  assert.equal(d.querySelector('[data-ui-step-spell]').style.display, 'none');
  ui.destroy();
});

test('wizard: existing config offers Resume and jumps to Review', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setConfig({
    spells: [{ slot: 4, word: 'adori', threshold: 20, reserve: 0, repeat: 5, order: 1 }],
    food: { slot: 3, cid: 3582, name: 'seasoned ham' },
  });
  assert.equal(d.querySelector('[data-ui-resume]').style.display, '');
  assert.equal(d.querySelector('[data-ui-welcome-start]').style.display, 'none');
  d.querySelector('[data-ui-resume]').click();
  assert.equal(curStep(d), 5, 'Resume jumps straight to the review step');
  assert.match(d.querySelector('[data-ui-review-summary]').textContent, /Slot 4/);
  assert.match(d.querySelector('[data-ui-review-summary]').textContent, /adori/);
  d.querySelector('[data-ui-wizard-back]').click();
  assert.equal(curStep(d), 4);
  d.querySelector('[data-ui-wizard-back]').click();
  assert.equal(curStep(d), 3);
  d.querySelector('[data-ui-wizard-back]').click();
  assert.equal(curStep(d), 2);
  d.querySelector('[data-ui-wizard-back]').click();
  assert.equal(curStep(d), 1);
  d.querySelector('[data-ui-reconfigure]').click();
  assert.equal(curStep(d), 2, 'Configure again restarts the wizard at step 2');
  ui.destroy();
});

test('wizard: Next/Back walk all steps with the indicator; nav states per step', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  assert.equal(d.querySelector('[data-ui-wizard-back]').disabled, true, 'Back disabled on step 1');
  assert.equal(clickNext(d), 2);
  assert.equal(d.querySelector('[data-ui-wizard-back]').disabled, false);
  fillFirstSpell(d);
  assert.equal(clickNext(d), 3);
  assert.equal(clickNext(d), 4);
  assert.equal(clickNext(d), 5);
  assert.equal(d.querySelector('[data-ui-wizard-next]').style.display, 'none', 'Next hidden on step 5');
  assert.equal(clickBack(d), 4);
  assert.equal(clickBack(d), 3);
  assert.equal(clickBack(d), 2);
  assert.equal(clickBack(d), 1);
  ui.destroy();
});

test('wizard: step 2 blocks Next with a friendly error until a slot is chosen', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  clickNext(d); // welcome -> spells
  assert.equal(curStep(d), 2);
  assert.equal(clickNext(d), 2, 'stays on step 2');
  assert.match(d.querySelector('[data-ui-errors]').textContent, /at least one spell/i);
  assert.equal(d.querySelector('[data-ui-errors]').style.display, 'block');
  fillFirstSpell(d);
  assert.equal(clickNext(d), 3, 'valid row lets the wizard continue');
  ui.destroy();
});

test('wizard: step 2 warns when a word has no hotbar slot', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  clickNext(d);
  d.querySelector('[data-ui-spell-word]').value = 'adori';
  assert.equal(clickNext(d), 2);
  assert.match(d.querySelector('[data-ui-errors]').textContent, /no hotbar slot is selected/i);
  ui.destroy();
});

test('wizard: step 3 friendly validation rejects a threshold above max mana', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  goTo(d, 3);
  d.querySelector('[data-ui-spell-threshold]').value = '999';
  assert.equal(clickNext(d), 3, 'stays on step 3');
  assert.match(d.querySelector('[data-ui-errors]').textContent, /can't reach 999/);
  assert.match(d.querySelector('[data-ui-errors]').textContent, /maximum is 120/);
  d.querySelector('[data-ui-spell-threshold]').value = '20';
  assert.equal(clickNext(d), 4);
  ui.destroy();
});

test('wizard: step 4 friendly validation rejects repeat 0 and negative every-casts', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  goTo(d, 4);
  d.querySelector('[data-ui-spell-repeat]').value = '0';
  d.querySelector('[data-ui-food-every-casts]').value = '-1';
  assert.equal(clickNext(d), 4, 'stays on step 4');
  const errs = d.querySelector('[data-ui-errors]').textContent;
  assert.match(errs, /at least 1 cast before switching/);
  assert.match(errs, /use 0 to eat by the food timer only/i);
  d.querySelector('[data-ui-spell-repeat]').value = '5';
  d.querySelector('[data-ui-food-every-casts]').value = '4';
  assert.equal(clickNext(d), 5);
  ui.destroy();
});

test('wizard: configured values round-trip through getRawConfig and save', async () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  goTo(d, 3);
  d.querySelector('[data-ui-spell-threshold]').value = '20';
  d.querySelector('[data-ui-spell-reserve]').value = '30';
  clickNext(d);
  d.querySelector('[data-ui-spell-repeat]').value = '5';
  d.querySelector('[data-ui-food-slot]').value = '3';
  d.querySelector('[data-ui-food-name]').value = 'seasoned ham';
  d.querySelector('[data-ui-food-every-casts]').value = '4';
  clickNext(d);
  assert.equal(curStep(d), 5);
  const raw = ui.getRawConfig();
  assert.deepEqual(raw, {
    jitter: { min: 0, max: 0 }, // empty -> 0 (normalized by saveConfig)
    firing: { mode: 'handleClick' },
    spells: [{ slot: 4, word: 'adori', threshold: 20, reserve: 30, repeat: 5, order: 0 }],
    food: {
      slot: 3, cid: null, name: 'seasoned ham',
      warningWindowSec: 60, fallbackIntervalSec: 10, everyCasts: 4,
    },
  });
  const res = await ui.save();
  assert.equal(res.ok, true);
  assert.deepEqual(calls.saved.raw, raw, 'saveConfig receives the exact raw shape');
  assert.equal(d.querySelector('[data-ui-errors]').style.display, 'none');
  ui.destroy();
});

test('wizard: Start playing saves, starts the engine and shows the run view', async () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  goTo(d, 5);
  d.querySelector('[data-ui-start]').click();
  await new Promise((r) => setTimeout(r, 0)); // startPlaying awaits saveConfig
  assert.equal(calls.start, 1, 'onStart invoked');
  assert.equal(calls.saved.raw.spells[0].slot, 4, 'config saved before starting');
  assert.equal(d.querySelector('[data-ui-run]').style.display, '', 'run view visible');
  assert.equal(d.querySelector('[data-ui-wizard]').style.display, 'none', 'wizard hidden');
  ui.destroy();
});

test('wizard: Save alone persists without starting the engine', async () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  goTo(d, 5);
  d.querySelector('[data-ui-save]').click();
  assert.equal(calls.saved.raw.spells[0].slot, 4);
  assert.equal(calls.start, 0, 'Save does not start the engine');
  ui.destroy();
});

test('REQ-12: rejected save renders the inline error and keeps the previous config', async () => {
  const { dom, ui } = makeUi(makeDom(), {
    saveResult: { ok: false, errors: ['Spell slot 4: threshold 999 exceeds maxMana 120 (REQ-12)'] },
  });
  const d = dom.window.document;
  ui.setConfig({ jitter: { min: 50, max: 400 }, firing: { mode: 'handleClick' }, spells: [], food: {} });
  d.querySelector('[data-ui-spell-slot]').value = '4';
  d.querySelector('[data-ui-spell-threshold]').value = '999';
  const res = await ui.save();
  assert.equal(res.ok, false);
  assert.match(d.querySelector('[data-ui-errors]').textContent, /exceeds maxMana/);
  assert.equal(d.querySelector('[data-ui-errors]').style.display, 'block');
  assert.deepEqual(res.config?.spells ?? [], [], 'previous config untouched');
  ui.destroy();
});

test('panel: collapse to the mini bar; expand restores (works while running)', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setRunning(true); // collapse must work while the bot is running
  d.querySelector('[data-ui-minimize]').click();
  assert.equal(d.querySelector('[data-ui-body]').style.display, 'none');
  assert.equal(d.querySelector('[data-ui-header]').style.display, 'none');
  assert.equal(d.querySelector('[data-ui-mini]').style.display, 'flex');
  ui.paintMini({ mana: 80, maxMana: 120, status: 'running', casts: 7 });
  assert.equal(d.querySelector('[data-ui-mini-mana]').textContent, '80/120');
  assert.equal(d.querySelector('[data-ui-mini-casts]').textContent, '7 casts');
  d.querySelector('[data-ui-mini-expand]').click();
  assert.equal(d.querySelector('[data-ui-body]').style.display, '');
  assert.equal(d.querySelector('[data-ui-header]').style.display, 'flex');
  assert.equal(d.querySelector('[data-ui-mini]').style.display, 'none');
  ui.destroy();
});

test('panel: hide shrinks to the floating handle; clicking it restores; mini can hide too', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-hide]').click();
  assert.equal(d.querySelector('[data-ui-handle]').style.display, 'block');
  assert.equal(d.querySelector('[data-ui-body]').style.display, 'none');
  assert.equal(d.querySelector('[data-ui-panel]').style.width, '28px', 'shell shrinks to the handle');
  d.querySelector('[data-ui-handle]').click();
  assert.equal(d.querySelector('[data-ui-handle]').style.display, 'none');
  assert.equal(d.querySelector('[data-ui-body]').style.display, '');
  assert.equal(d.querySelector('[data-ui-panel]').style.width, '280px');
  // hide from the mini bar
  d.querySelector('[data-ui-minimize]').click();
  d.querySelector('[data-ui-mini-hide]').click();
  assert.equal(d.querySelector('[data-ui-handle]').style.display, 'block');
  ui.destroy();
});

test('REQ-11: catalog search renders images and fills the active spell row', () => {
  const { dom, ui } = makeUi(makeDom(), {
    catalog: [
      { cid: 3582, name: 'Seasoned Ham', imageDataURL: 'data:image/png;base64,AAA' },
      { cid: 5, name: 'Fishing Rod', imageDataURL: null },
    ],
  });
  const d = dom.window.document;
  clickNext(d); // welcome -> spells
  const count = ui.search('ham');
  assert.equal(count, 1);
  const results = d.querySelectorAll('[data-ui-search-result]');
  assert.equal(results.length, 1);
  assert.match(results[0].textContent, /Seasoned Ham \(3582\)/);
  const img = results[0].querySelector('img');
  assert.ok(img, 'image rendered for entries with imageDataURL');
  assert.equal(img.src, 'data:image/png;base64,AAA');
  results[0].click();
  assert.equal(d.querySelector('[data-ui-spell-word]').value, 'Seasoned Ham');
  ui.destroy();
});

test('REQ-11: missing catalog shows the manual-word hint', () => {
  const { dom, ui } = makeUi(makeDom(), { catalog: null });
  const d = dom.window.document;
  clickNext(d);
  const count = ui.search('ham');
  assert.equal(count, 0);
  assert.match(d.querySelector('[data-ui-search-results]').textContent, /type the spell word manually/i);
  ui.destroy();
});

test('REQ-11: food catalog search fills the food name and cid', () => {
  const { dom, ui } = makeUi(makeDom(), {
    catalog: [{ cid: 3582, name: 'Seasoned Ham', imageDataURL: null }],
  });
  const d = dom.window.document;
  goTo(d, 4);
  d.querySelector('[data-ui-food-find]').click();
  const input = d.querySelector('[data-ui-food-search]');
  input.value = 'ham';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(d.querySelectorAll('[data-ui-food-results] [data-ui-search-result]').length, 1);
  d.querySelector('[data-ui-food-results] [data-ui-search-result]').click();
  assert.equal(d.querySelector('[data-ui-food-cid]').value, '3582');
  assert.equal(d.querySelector('[data-ui-food-name]').value, 'Seasoned Ham');
  ui.destroy();
});

test('wizard: add/remove spell rows keeps steps 3/4 in sync and preserves order', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-add-spell]').click();
  const rows = d.querySelectorAll('[data-ui-spell-row]');
  assert.equal(rows.length, 2, 'default row + added row');
  assert.equal(d.querySelectorAll('[data-ui-when-row]').length, 2);
  assert.equal(d.querySelectorAll('[data-ui-repeat-row]').length, 2);
  rows[0].querySelector('[data-ui-spell-slot]').value = '4';
  rows[0].querySelector('[data-ui-spell-word]').value = 'adori';
  rows[1].querySelector('[data-ui-spell-slot]').value = '7';
  rows[1].querySelector('[data-ui-spell-word]').value = 'exura';
  rows[1].querySelector('[data-ui-spell-remove]').click();
  assert.equal(d.querySelectorAll('[data-ui-spell-row]').length, 1);
  assert.equal(d.querySelectorAll('[data-ui-when-row]').length, 1, 'when rows stay aligned');
  assert.equal(d.querySelectorAll('[data-ui-repeat-row]').length, 1, 'repeat rows stay aligned');
  const raw = ui.getRawConfig();
  assert.equal(raw.spells.length, 1);
  assert.deepEqual(raw.spells[0], {
    slot: 4, word: 'adori', threshold: 0, reserve: 0, repeat: 1, order: 0,
  });
  ui.destroy();
});

test('wizard: setConfig pre-fills every field and multiple spells; Resume offered', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setConfig({
    jitter: { min: 50, max: 400 },
    firing: { mode: 'keyboard' },
    spells: [
      { slot: 4, word: 'adori', threshold: 20, reserve: 30, repeat: 2, order: 1 },
      { slot: 5, word: 'exura', threshold: 0, reserve: 0, repeat: 1, order: 2 },
    ],
    food: { slot: 3, cid: 3582, name: 'seasoned ham', warningWindowSec: 60, fallbackIntervalSec: 10, everyCasts: 6 },
  });
  assert.equal(d.querySelectorAll('[data-ui-spell-row]').length, 2);
  assert.equal(d.querySelectorAll('[data-ui-when-row]').length, 2);
  assert.equal(d.querySelectorAll('[data-ui-repeat-row]').length, 2);
  assert.equal(d.querySelector('[data-ui-spell-word]').value, 'adori');
  assert.equal(d.querySelectorAll('[data-ui-spell-word]')[1].value, 'exura');
  assert.equal(d.querySelector('[data-ui-spell-threshold]').value, '20');
  assert.equal(d.querySelectorAll('[data-ui-spell-repeat]')[1].value, '1');
  assert.equal(d.querySelector('[data-ui-food-slot]').value, '3');
  assert.equal(d.querySelector('[data-ui-food-cid]').value, '3582');
  assert.equal(d.querySelector('[data-ui-food-name]').value, 'seasoned ham');
  assert.equal(d.querySelector('[data-ui-food-every-casts]').value, '6');
  assert.equal(d.querySelector('[data-ui-jitter-min]').value, '50');
  assert.equal(d.querySelector('[data-ui-firing-mode]').value, 'keyboard');
  assert.equal(d.querySelector('[data-ui-resume]').style.display, '', 'saved config -> Resume offered');
  ui.destroy();
});

test('food.everyCasts: field present with 0 = off and round-trips through setConfig/getRawConfig', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  const input = d.querySelector('[data-ui-food-every-casts]');
  assert.ok(input, 'field present in the Food block');
  assert.equal(input.type, 'number');
  assert.equal(input.min, '0');
  input.value = '5';
  assert.equal(ui.getRawConfig().food.everyCasts, 5, 'raw config collects the value');
  input.value = '';
  assert.equal(ui.getRawConfig().food.everyCasts, 0, 'empty input -> 0 (off)');
  ui.setConfig({ food: { everyCasts: 7 } });
  assert.equal(d.querySelector('[data-ui-food-every-casts]').value, '7', 'setConfig populates the field');
  ui.destroy();
});

test('panel: dragging the header moves the panel (fixed position updates)', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  const header = d.querySelector('[data-ui-header]');
  const panel = d.querySelector('[data-ui-panel]');
  header.dispatchEvent(new d.defaultView.MouseEvent('mousedown', { button: 0, clientX: 40, clientY: 40 }));
  d.dispatchEvent(new d.defaultView.MouseEvent('mousemove', { clientX: 140, clientY: 90 }));
  d.dispatchEvent(new d.defaultView.MouseEvent('mouseup', {}));
  assert.equal(panel.style.left, '100px');
  assert.equal(panel.style.top, '50px');
  assert.equal(panel.style.right, 'auto');
  ui.destroy();
});

test('panel: dragging does not start on a non-left mouse button', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  const header = d.querySelector('[data-ui-header]');
  header.dispatchEvent(new d.defaultView.MouseEvent('mousedown', { button: 2, clientX: 40, clientY: 40 }));
  d.dispatchEvent(new d.defaultView.MouseEvent('mousemove', { clientX: 300, clientY: 200 }));
  assert.equal(d.querySelector('[data-ui-panel]').style.left, '');
  ui.destroy();
});

test('REQ-14: hud renders snapshot values into the run view contract elements', () => {
  const { dom, ui } = makeUi(makeDom(), {
    snapshot: () => ({
      mana: 80, maxMana: 120, health: 90, foodSec: 58,
      cooldownSec: 1.5, nextAction: 'cast slot 4', status: 'running',
    }),
  });
  const d = dom.window.document;
  ui.getHud().refresh();
  assert.equal(d.querySelector('[data-hud-mana]').textContent, '80/120');
  assert.equal(d.querySelector('[data-hud-food]').textContent, '58s');
  assert.equal(d.querySelector('[data-hud-next]').textContent, 'cast slot 4');
  assert.equal(d.querySelector('[data-hud-status]').textContent, 'running');
  ui.destroy();
});

test('REQ-14: paintMini keeps the mini bar live (dot color, mana, casts)', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.paintMini({ status: 'paused', mana: 55, maxMana: 120, casts: 3 });
  assert.equal(d.querySelector('[data-ui-mini-mana]').textContent, '55/120');
  assert.equal(d.querySelector('[data-ui-mini-casts]').textContent, '3 casts');
  const dots = d.querySelectorAll('[data-ui-status-dot]');
  assert.equal(dots.length, 2, 'header dot + mini dot');
  // jsdom normalizes hex colors to rgb()
  for (const dot of dots) assert.equal(dot.style.background, 'rgb(255, 179, 0)', 'paused -> amber');
  ui.paintMini({ status: 'running' });
  assert.equal(d.querySelector('[data-ui-status-dot]').style.background, 'rgb(76, 175, 80)');
  ui.destroy();
});

test('setRunning toggles Start/Pause enablement across wizard and run views', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setRunning(true);
  for (const b of d.querySelectorAll('[data-ui-start]')) assert.equal(b.disabled, true);
  for (const b of d.querySelectorAll('[data-ui-pause]')) assert.equal(b.disabled, false);
  ui.setRunning(false);
  for (const b of d.querySelectorAll('[data-ui-start]')) assert.equal(b.disabled, false);
  for (const b of d.querySelectorAll('[data-ui-pause]')) assert.equal(b.disabled, true);
  ui.destroy();
});

test('panel: non-blocking defaults — fixed, bottom-right, compact, single box', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  const panel = d.querySelector('[data-ui-panel]');
  assert.equal(panel.style.position, 'fixed');
  assert.equal(panel.style.right, '12px');
  assert.equal(panel.style.bottom, '12px');
  assert.equal(panel.style.width, '280px');
  assert.equal(panel.style.maxHeight, 'calc(100vh - 24px)');
  const bodyChildren = [...d.body.children].filter((n) => n.tagName === 'DIV');
  assert.equal(bodyChildren.length, 1, 'only the panel is mounted — no overlays');
  ui.destroy();
});

test('panel: destroy removes the panel from the DOM', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  assert.ok(d.querySelector('[data-ui-panel]'));
  ui.destroy();
  assert.equal(d.querySelector('[data-ui-panel]'), null);
});

test('panel: numeric cid strings become numbers, empty becomes null', async () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-food-cid]').value = '3582';
  let raw = ui.getRawConfig();
  assert.equal(raw.food.cid, 3582);
  d.querySelector('[data-ui-food-cid]').value = '';
  raw = ui.getRawConfig();
  assert.equal(raw.food.cid, null);
  ui.destroy();
});
