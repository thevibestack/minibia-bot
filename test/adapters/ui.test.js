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

/** Build a UI instance with default-ish deps. */
function makeUi(dom, overrides = {}) {
  const calls = { start: 0, pause: 0, reset: 0, saved: undefined };
  const ui = createUi({
    document: dom.window.document,
    getCatalog: () => overrides.catalog ?? null,
    getSnapshot: () => ({ mana: 100, maxMana: 120, status: 'idle' }),
    saveConfig: async (raw, prev) => {
      calls.saved = { raw, prev };
      return overrides.saveResult ?? { ok: true, config: { ...prev, ...raw } };
    },
    onStart: () => calls.start++,
    onPause: () => calls.pause++,
    onReset: () => calls.reset++,
    ...overrides.deps,
  });
  return { dom, ui, calls };
}

test('REQ-14: panel renders every [data-hud-*] contract element plus controls', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  for (const attr of [
    'mana', 'next', 'food', 'cooldown', 'status', 'every-casts',
    'casts', 'eats', 'misses', 'words', 'log',
  ]) {
    assert.ok(d.querySelector(`[data-hud-${attr}]`), `missing [data-hud-${attr}]`);
  }
  for (const attr of [
    'start', 'pause', 'reset', 'save', 'search', 'search-results',
    'spells', 'add-spell', 'food-slot', 'food-cid', 'food-name',
    'food-window', 'food-fallback', 'food-every-casts', 'jitter-min', 'jitter-max',
    'firing-mode', 'errors',
  ]) {
    assert.ok(d.querySelector(`[data-ui-${attr}]`), `missing [data-ui-${attr}]`);
  }
  assert.ok(d.querySelector('[data-ui-panel]'), 'panel container present');
  assert.match(d.querySelector('[data-ui-panel]').style.position, /fixed/);
  assert.equal(d.querySelector('[data-hud-mana]').textContent, '100/120', 'hud snapshot rendered');
  ui.destroy();
});

test('REQ-12: start/pause/reset buttons invoke their callbacks', () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-start]').click(); // enabled while idle
  ui.setRunning(true); // pause becomes enabled once the engine runs
  d.querySelector('[data-ui-pause]').click();
  d.querySelector('[data-ui-reset]').click();
  assert.deepEqual(calls, { start: 1, pause: 1, reset: 1, saved: undefined });
  ui.destroy();
});

test('REQ-12: save() passes raw config + previous config to saveConfig and stores result', async () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-jitter-min]').value = '100';
  d.querySelector('[data-ui-jitter-max]').value = '300';
  d.querySelector('[data-ui-spell-slot]').value = '4';
  d.querySelector('[data-ui-spell-threshold]').value = '20';
  d.querySelector('[data-ui-food-cid]').value = '3582';

  const res = await ui.save();
  assert.equal(res.ok, true);
  assert.deepEqual(calls.saved.raw, {
    jitter: { min: 100, max: 300 },
    firing: { mode: 'handleClick' },
    spells: [
      { slot: 4, threshold: 20, reserve: 0, repeat: 1, order: 0, word: '' },
    ],
    food: { slot: null, cid: 3582, name: '', warningWindowSec: 60, fallbackIntervalSec: 10, everyCasts: 0 },
  });
  assert.equal(d.querySelector('[data-ui-errors]').style.display, 'none');
  ui.destroy();
});

test('REQ-12: rejected save renders inline errors and keeps the previous config', async () => {
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

test('REQ-12: setConfig populates jitter, firing mode, food and spell rows', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setConfig({
    jitter: { min: 50, max: 400 },
    firing: { mode: 'keyboard' },
    spells: [
      { slot: 4, threshold: 20, reserve: 30, repeat: 2, order: 1, word: 'adori' },
      { slot: 5, threshold: 0, reserve: 0, repeat: 1, order: 2, word: 'exura' },
    ],
    food: { slot: 3, cid: 3582, name: 'seasoned ham', warningWindowSec: 60, fallbackIntervalSec: 10 },
  });
  assert.equal(d.querySelector('[data-ui-jitter-min]').value, '50');
  assert.equal(d.querySelector('[data-ui-firing-mode]').value, 'keyboard');
  assert.equal(d.querySelector('[data-ui-food-cid]').value, '3582');
  assert.equal(d.querySelector('[data-ui-food-name]').value, 'seasoned ham');
  assert.equal(d.querySelectorAll('[data-ui-spell-row]').length, 2);
  assert.equal(d.querySelector('[data-ui-spell-word]').value, 'adori');
  ui.destroy();
});

test('REQ-12: spell rows can be added and removed; collection keeps DOM order', async () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-add-spell]').click();
  const rows = d.querySelectorAll('[data-ui-spell-row]');
  assert.equal(rows.length, 2, 'default row + added row');
  rows[0].querySelector('[data-ui-spell-slot]').value = '4';
  rows[0].querySelector('[data-ui-spell-word]').value = 'adori';
  rows[1].querySelector('[data-ui-spell-slot]').value = '7';
  rows[1].querySelector('[data-ui-spell-word]').value = 'exura';
  rows[1].querySelector('[data-ui-spell-remove]').click();
  const raw = ui.getRawConfig();
  assert.equal(raw.spells.length, 1);
  assert.deepEqual(raw.spells[0], {
    slot: 4, threshold: 0, reserve: 0, repeat: 1, order: 0, word: 'adori',
  });
  ui.destroy();
});

test('REQ-11: search filters catalog by name (case-insensitive) and renders images', () => {
  const { dom, ui } = makeUi(makeDom(), {
    catalog: [
      { cid: 3582, name: 'Seasoned Ham', imageDataURL: 'data:image/png;base64,AAA' },
      { cid: 5, name: 'Fishing Rod', imageDataURL: null },
    ],
  });
  const d = dom.window.document;
  const count = ui.search('ham');
  assert.equal(count, 1);
  const results = d.querySelectorAll('[data-ui-search-result]');
  assert.equal(results.length, 1);
  assert.match(results[0].textContent, /Seasoned Ham \(3582\)/);
  const img = results[0].querySelector('img');
  assert.ok(img, 'image rendered for entries with imageDataURL');
  assert.equal(img.src, 'data:image/png;base64,AAA');
  ui.destroy();
});

test('REQ-11: clicking a search result fills the food cid + name inputs', () => {
  const { dom, ui } = makeUi(makeDom(), {
    catalog: [{ cid: 3582, name: 'Seasoned Ham', imageDataURL: null }],
  });
  const d = dom.window.document;
  ui.search('ham');
  d.querySelector('[data-ui-search-result]').click();
  assert.equal(d.querySelector('[data-ui-food-cid]').value, '3582');
  assert.equal(d.querySelector('[data-ui-food-name]').value, 'Seasoned Ham');
  ui.destroy();
});

test('REQ-11: search with a missing catalog shows the keybind-only hint', () => {
  const { dom, ui } = makeUi(makeDom(), { catalog: null });
  const d = dom.window.document;
  const count = ui.search('ham');
  assert.equal(count, 0);
  assert.match(d.querySelector('[data-ui-search-results]').textContent, /keybind-only/);
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
  assert.equal(panel.style.top, '62px', 'initial top 12px + 50px drag delta');
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

test('REQ-14: hud renders snapshot values into the panel elements', () => {
  const { dom, ui } = makeUi(makeDom(), {
    deps: {
      getSnapshot: () => ({
        mana: 80, maxMana: 120, health: 90, foodSec: 58,
        cooldownSec: 1.5, nextAction: 'cast slot 4', status: 'running',
      }),
    },
  });
  const d = dom.window.document;
  ui.getHud().refresh();
  assert.equal(d.querySelector('[data-hud-mana]').textContent, '80/120');
  assert.equal(d.querySelector('[data-hud-food]').textContent, '58s');
  assert.equal(d.querySelector('[data-hud-next]').textContent, 'cast slot 4');
  assert.equal(d.querySelector('[data-hud-status]').textContent, 'running');
  ui.destroy();
});

test('REQ-14: setRunning toggles the Start/Pause button enablement', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  ui.setRunning(true);
  assert.equal(d.querySelector('[data-ui-start]').disabled, true);
  assert.equal(d.querySelector('[data-ui-pause]').disabled, false);
  ui.setRunning(false);
  assert.equal(d.querySelector('[data-ui-start]').disabled, false);
  assert.equal(d.querySelector('[data-ui-pause]').disabled, true);
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

test('food.everyCasts: input present with 0 = off and round-trips through setConfig/getRawConfig', () => {
  const { dom, ui } = makeUi(makeDom());
  const d = dom.window.document;
  const input = d.querySelector('[data-ui-food-every-casts]');
  assert.ok(input, 'field present in the Food block');
  assert.equal(input.type, 'number');
  assert.equal(input.min, '0');
  assert.equal(input.placeholder, 'every N casts');

  input.value = '5';
  assert.equal(ui.getRawConfig().food.everyCasts, 5, 'raw config collects the value');

  input.value = '';
  assert.equal(ui.getRawConfig().food.everyCasts, 0, 'empty input -> 0 (off)');

  ui.setConfig({ food: { everyCasts: 7 } });
  assert.equal(d.querySelector('[data-ui-food-every-casts]').value, '7', 'setConfig populates the field');
  ui.destroy();
});

test('food.everyCasts: save round-trips the value through saveConfig', async () => {
  const { dom, ui, calls } = makeUi(makeDom());
  const d = dom.window.document;
  d.querySelector('[data-ui-food-every-casts]').value = '4';
  const res = await ui.save();
  assert.equal(res.ok, true);
  assert.equal(calls.saved.raw.food.everyCasts, 4);
  ui.destroy();
});
