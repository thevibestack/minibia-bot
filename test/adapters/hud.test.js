'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHud } = require('../../src/adapters/hud');

const PANEL = `
  <div id="hud">
    <span data-hud-mana></span>
    <span data-hud-next></span>
    <span data-hud-food></span>
    <span data-hud-cooldown></span>
    <span data-hud-status></span>
    <span data-hud-casts></span>
    <span data-hud-eats></span>
    <span data-hud-misses></span>
    <span data-hud-words></span>
    <pre data-hud-log></pre>
  </div>`;

function makeHud({ snapshot = () => ({}), schedule, clear } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${PANEL}</body></html>`);
  const hud = createHud({
    document: dom.window.document,
    getSnapshot: snapshot,
    schedule,
    clear,
  });
  return { dom, hud };
}

test('REQ-14: renders mana and timers from the snapshot', () => {
  const { dom, hud } = makeHud({
    snapshot: () => ({ mana: 80, maxMana: 120, foodSec: 12, cooldownSec: 0.4, nextAction: 'adori', status: 'running' }),
  });
  hud.refresh();
  const $ = (s) => dom.window.document.querySelector(s);
  assert.equal($('[data-hud-mana]').textContent, '80/120');
  assert.equal($('[data-hud-next]').textContent, 'adori');
  assert.equal($('[data-hud-food]').textContent, '12s');
  assert.equal($('[data-hud-cooldown]').textContent, '0.4s');
  assert.equal($('[data-hud-status]').textContent, 'running');
});

test('REQ-14: missing timer data renders em dash', () => {
  const { dom, hud } = makeHud({ snapshot: () => ({ mana: 80, maxMana: 120 }) });
  hud.refresh();
  const $ = (s) => dom.window.document.querySelector(s);
  assert.equal($('[data-hud-food]').textContent, '—');
  assert.equal($('[data-hud-cooldown]').textContent, '—');
  assert.equal($('[data-hud-next]').textContent, '—');
});

test('REQ-14: cast counter increments and renders (post-action refresh)', () => {
  const { dom, hud } = makeHud();
  hud.increment('casts');
  hud.increment('casts');
  hud.increment('eats');
  hud.refresh();
  const $ = (s) => dom.window.document.querySelector(s);
  assert.equal($('[data-hud-casts]').textContent, '2');
  assert.equal($('[data-hud-eats]').textContent, '1');
  assert.equal($('[data-hud-misses]').textContent, '0');
});

test('REQ-14: 500ms cadence re-reads the snapshot via schedule', () => {
  let registered = null;
  const schedule = (fn, ms) => {
    registered = { fn, ms };
    return { id: 1 };
  };
  const cleared = [];
  const clear = (h) => cleared.push(h);
  const reads = [];
  const { hud } = makeHud({
    snapshot: () => {
      reads.push(1);
      return { mana: reads.length, maxMana: 10 };
    },
    schedule,
    clear,
  });

  hud.start();
  assert.equal(registered.ms, 500, 'cadence is 500ms (REQ-14)');
  assert.equal(reads.length, 0, 'no read until the first cadence fires');
  registered.fn();
  assert.equal(reads.length, 1);

  hud.stop();
  assert.equal(cleared.length, 1);
});

test('REQ-14: Pause freezes counters but mana keeps refreshing', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${PANEL}</body></html>`);
  let mana = 80;
  const hud = createHud({
    document: dom.window.document,
    getSnapshot: () => ({ mana, maxMana: 120 }),
  });
  const $ = (s) => dom.window.document.querySelector(s);

  hud.increment('casts');
  hud.refresh();
  assert.equal($('[data-hud-casts]').textContent, '1');

  hud.pause();
  hud.increment('casts');
  mana = 90; // world moves while paused
  hud.refresh();

  assert.equal($('[data-hud-casts]').textContent, '1', 'counter frozen on Pause');
  assert.equal($('[data-hud-mana]').textContent, '90/120', 'mana still updates');
  assert.equal(hud.isPaused(), true);
});

test('REQ-14: Resume unfreezes counters', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${PANEL}</body></html>`);
  const hud = createHud({ document: dom.window.document });
  const $ = (s) => dom.window.document.querySelector(s);
  hud.increment('casts');
  hud.refresh();
  hud.pause();
  hud.increment('casts');
  hud.refresh();
  assert.equal($('[data-hud-casts]').textContent, '1');
  hud.resume();
  hud.refresh();
  assert.equal($('[data-hud-casts]').textContent, '2');
});

test('REQ-14: Reset zeroes counters and re-renders them', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${PANEL}</body></html>`);
  const hud = createHud({ document: dom.window.document });
  const $ = (s) => dom.window.document.querySelector(s);

  hud.increment('casts');
  hud.increment('eats');
  hud.increment('validationMisses');
  hud.increment('unknownWords');
  hud.refresh();
  assert.equal($('[data-hud-casts]').textContent, '1');

  hud.reset();
  assert.deepEqual(hud.getCounters(), { casts: 0, eats: 0, validationMisses: 0, unknownWords: 0 });
  assert.equal($('[data-hud-casts]').textContent, '0');
  assert.equal($('[data-hud-eats]').textContent, '0');
  assert.equal($('[data-hud-words]').textContent, '0');
});

test('REQ-14: recent log renders with bounded size', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${PANEL}</body></html>`);
  const hud = createHud({ document: dom.window.document, maxLog: 3 });
  const $ = (s) => dom.window.document.querySelector(s);

  hud.addLog('cast adori');
  hud.addLog('validation miss');
  hud.addLog('ate food');
  hud.addLog('fourth');
  hud.refresh();

  const lines = $('[data-hud-log]').textContent.split('\n');
  assert.deepEqual(lines, ['validation miss', 'ate food', 'fourth'], 'oldest dropped at the cap');
  assert.equal(hud.getLog().length, 3);
});

test('HUD: missing panel elements never throw', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div></div></body></html>');
  const hud = createHud({ document: dom.window.document });
  hud.refresh();
  hud.addLog('x');
  hud.refresh();
  assert.equal(hud.getLog().length, 1);
});

test('HUD: increment ignores unknown counters; setCounters restores persisted values', () => {
  const { hud } = makeHud();
  hud.increment('bogus');
  assert.deepEqual(hud.getCounters(), { casts: 0, eats: 0, validationMisses: 0, unknownWords: 0 });
  hud.setCounters({ casts: 7, eats: '3', bogus: 99 });
  assert.deepEqual(hud.getCounters(), { casts: 7, eats: 3, validationMisses: 0, unknownWords: 0 });
});
