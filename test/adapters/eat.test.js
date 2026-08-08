'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createEater } = require('../../src/adapters/eat');

function makeDom(bodyHtml = '') {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
}

/** Build a clickable element and return dispatch/click spies. */
function makeSlotElement(dom) {
  const el = dom.window.document.createElement('div');
  const events = { contextmenu: [], clicks: 0 };
  el.dispatchEvent = (evt) => {
    if (evt.type === 'contextmenu') events.contextmenu.push(evt);
    return true;
  };
  el.click = () => {
    events.clicks += 1;
  };
  return { el, events };
}

test('REQ-05: contextmenu -> "Use" primary path; sated after -> ate', () => {
  const dom = makeDom('<ul><li>Use</li><li>Inspect</li></ul>');
  const { el, events } = makeSlotElement(dom);
  const menuClicks = [];
  dom.window.document.querySelector('li').addEventListener('click', () => menuClicks.push('use'));

  const satedCalls = [];
  const eater = createEater({
    gameClient: { mouse: { use: () => assert.fail('mouse.use must not run') } },
    document: dom.window.document,
    isSated: () => {
      satedCalls.push('x');
      // before-check false, after-check true (food lands)
      return satedCalls.length > 1;
    },
  });

  const r = eater.eatFood({ slot: { element: el, index: 2 }, cid: 3582 });

  assert.equal(events.contextmenu.length, 1, 'contextmenu dispatched on slot element');
  assert.equal(events.contextmenu[0].button, 2);
  assert.equal(menuClicks.length, 1, 'menu "Use" entry clicked');
  assert.equal(r.result, 'ate');
  assert.equal(r.reason, 'sated');
  assert.equal(r.attempts, 0);
  assert.equal(satedCalls.length, 2, 'SATED re-checked before and after');
});

test('REQ-05: menu lacks "Use" -> mouse.use fallback', () => {
  const dom = makeDom('<ul><li>Inspect</li><li>Drop</li></ul>');
  const { el, events } = makeSlotElement(dom);
  const uses = [];
  let satedCheck = 0;
  const eater = createEater({
    gameClient: { mouse: { use: (args) => uses.push(args) } },
    document: dom.window.document,
    isSated: () => ++satedCheck > 1, // before false, after true
  });

  const r = eater.eatFood({ slot: { element: el, index: 3 } });

  assert.equal(events.contextmenu.length, 1, 'contextmenu still dispatched first');
  assert.deepEqual(uses, [{ which: 3, index: 3 }], 'mouse.use fallback with right button');
  assert.equal(r.result, 'ate');
  assert.equal(r.reason, 'sated');
});

test('eatFood: already sated before -> no-food, nothing dispatched', () => {
  const dom = makeDom();
  const { el, events } = makeSlotElement(dom);
  const uses = [];
  const eater = createEater({
    gameClient: { mouse: { use: (args) => uses.push(args) } },
    document: dom.window.document,
    isSated: () => true,
  });

  const r = eater.eatFood({ slot: { element: el } });

  assert.equal(r.result, 'no-food');
  assert.equal(r.reason, 'already-sated');
  assert.equal(events.contextmenu.length, 0);
  assert.equal(uses.length, 0);
});

test('eatFood: no item and no sources -> no-food', () => {
  const eater = createEater({});
  assert.equal(eater.eatFood(null).result, 'no-food');
  assert.equal(eater.eatFood({ slot: {} }).result, 'no-food');
});

test('REQ-06: 3 consecutive failures -> paused, setPaused(true) and HUD alert', () => {
  const dom = makeDom();
  const { el } = makeSlotElement(dom);
  const alerts = [];
  const pausedStates = [];
  const eater = createEater({
    gameClient: { mouse: { use: () => {} } },
    document: dom.window.document,
    isSated: () => false, // never sated -> attempts never confirm
    setPaused: (p) => pausedStates.push(p),
    hudAlert: (m) => alerts.push(m),
  });

  const r1 = eater.eatFood({ slot: { element: el } });
  assert.equal(r1.result, 'failed');
  assert.equal(r1.attempts, 1);
  assert.equal(r1.paused, false);

  const r2 = eater.eatFood({ slot: { element: el } });
  assert.equal(r2.attempts, 2);

  const r3 = eater.eatFood({ slot: { element: el } });
  assert.equal(r3.result, 'failed');
  assert.equal(r3.attempts, 3);
  assert.equal(r3.paused, true);
  assert.deepEqual(pausedStates, [true]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /3 consecutive times/);
  assert.equal(eater.isPaused(), true);
});

test('REQ-06: success resets the consecutive-failure counter', () => {
  const dom = makeDom('<li>Use</li>');
  let satedCheck = 0;
  const { el } = makeSlotElement(dom);
  const eater = createEater({
    gameClient: { mouse: { use: () => {} } },
    document: dom.window.document,
    // Two failing attempts (before+after false each), then the third attempt's
    // after-check sees SATED land (false before, true after).
    isSated: () => (++satedCheck === 6 ? true : false),
  });

  eater.eatFood({ slot: { element: el } }); // fails (not sated)
  eater.eatFood({ slot: { element: el } }); // fails
  assert.equal(eater.getFailures(), 2);

  const r = eater.eatFood({ slot: { element: el } }); // 6th check -> sated after
  assert.equal(r.result, 'ate');
  assert.equal(eater.getFailures(), 0, 'counter reset after success');
});

test('REQ-06: no SATED data -> executed attempt is trusted (fallback cadence)', () => {
  const dom = makeDom('<li>Use</li>');
  const { el } = makeSlotElement(dom);
  const eater = createEater({
    document: dom.window.document,
    isSated: null, // data unavailable
  });

  const r = eater.eatFood({ slot: { element: el } });
  assert.equal(r.result, 'ate');
  assert.equal(r.reason, 'attempted');
  assert.equal(eater.getFailures(), 0);
});

test('eatFood: element present, no Use entry, no mouse.use -> failed (no-use-entry)', () => {
  const dom = makeDom('<li>Inspect</li>');
  const { el } = makeSlotElement(dom);
  const eater = createEater({
    document: dom.window.document,
    isSated: () => false,
  });

  const r = eater.eatFood({ slot: { element: el } });
  assert.equal(r.result, 'failed');
  assert.equal(r.reason, 'no-use-entry');
});

test('eatFood: mouse.use only (no element) works and confirms via sated', () => {
  const uses = [];
  let satedCheck = 0;
  const eater = createEater({
    gameClient: { mouse: { use: (args) => uses.push(args) } },
    isSated: () => ++satedCheck > 1, // before false, after true
  });

  const r = eater.eatFood({ index: 5 });
  assert.equal(r.result, 'ate');
  assert.deepEqual(uses, [{ which: 3, index: 5 }]);
});

test('resetFailures clears the counter without pausing state', () => {
  const dom = makeDom();
  const { el } = makeSlotElement(dom);
  const eater = createEater({ document: dom.window.document, isSated: () => false });
  eater.eatFood({ slot: { element: el } });
  eater.eatFood({ slot: { element: el } });
  assert.equal(eater.getFailures(), 2);
  eater.resetFailures();
  assert.equal(eater.getFailures(), 0);
});
