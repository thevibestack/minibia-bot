'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { fireSlot } = require('../../src/adapters/firing');

function makeDom(bodyHtml = '') {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
}

function makeGameClient(overrides = {}) {
  const gameClient = {
    interface: {
      hotbarManager: { __handleClick: () => {} },
      keyboard: { __hotbarKeybinds: {} },
    },
  };
  if (overrides.hotbar === 'none') delete gameClient.interface.hotbarManager;
  if (overrides.hotbarFn === 'none') gameClient.interface.hotbarManager = {};
  if (overrides.keyboard === 'none') delete gameClient.interface.keyboard;
  if (overrides.keybinds) gameClient.interface.keyboard.__hotbarKeybinds = overrides.keybinds;
  return gameClient;
}

test('REQ-07: handleClick mode fires via hotbarManager.__handleClick(slot)', () => {
  const clicked = [];
  const gameClient = makeGameClient();
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based
  const ok = fireSlot(4, { gameClient });
  assert.equal(ok, true);
  assert.deepEqual(clicked, [4]);
});

test('REQ-07: slot > 12 is a logged no-op, __handleClick never called', () => {
  const clicked = [];
  const errors = [];
  const gameClient = makeGameClient();
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based
  const ok = fireSlot(13, { gameClient, log: { error: (m) => errors.push(m) } });
  assert.equal(ok, false);
  assert.deepEqual(clicked, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /out of range 1-12/);
});

test('REQ-07: slot 0 and non-integer slots are logged no-ops', () => {
  const errors = [];
  const gameClient = makeGameClient();
  assert.equal(fireSlot(0, { gameClient, log: { error: (m) => errors.push(m) } }), false);
  assert.equal(fireSlot(2.5, { gameClient, log: { error: (m) => errors.push(m) } }), false);
  assert.equal(errors.length, 2);
});

test('fireSlot: missing hotbarManager -> false with logged error', () => {
  const errors = [];
  const ok = fireSlot(3, { gameClient: {}, log: { error: (m) => errors.push(m) } });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /__handleClick unavailable/);
});

test('REQ-08: keyboard mode blurs a focused INPUT before dispatching', () => {
  const dom = makeDom('<input id="chat" />');
  const { document } = dom.window;
  const input = document.querySelector('#chat');
  input.focus();
  assert.equal(document.activeElement, input);

  const keydowns = [];
  const blurred = [];
  input.blur = () => {
    blurred.push(input.id);
    input.blur = dom.window.HTMLInputElement.prototype.blur; // restore for later
    // jsdom blur() sets activeElement to body via the prototype; call it:
    dom.window.HTMLInputElement.prototype.blur.call(input);
  };
  document.addEventListener('keydown', (e) => keydowns.push(e));

  const gameClient = makeGameClient({ keybinds: { 4: 70 } }); // 70 = F7 keyCode
  const ok = fireSlot(4, { mode: 'keyboard', gameClient, document, log: {} });

  assert.equal(ok, true);
  assert.deepEqual(blurred, ['chat']);
  assert.equal(keydowns.length, 1);
  assert.equal(keydowns[0].keyCode, 70);
  assert.equal(keydowns[0].which, 70);
});

test('REQ-08: keyboard mode does not blur when nothing is focused', () => {
  const dom = makeDom();
  const { document } = dom.window;
  assert.equal(document.activeElement, document.body);

  const keydowns = [];
  document.addEventListener('keydown', (e) => keydowns.push(e));

  const gameClient = makeGameClient({ keybinds: { 1: 49 } });
  const ok = fireSlot(1, { mode: 'keyboard', gameClient, document });
  assert.equal(ok, true);
  assert.equal(keydowns.length, 1);
});

test('REQ-08: no keybind for the slot -> immediate fallback to __handleClick', () => {
  const dom = makeDom();
  const clicked = [];
  const warns = [];
  const gameClient = makeGameClient({ keybinds: { 2: 50 } }); // no bind for slot 4
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based

  const keydowns = [];
  dom.window.document.addEventListener('keydown', (e) => keydowns.push(e));

  const ok = fireSlot(4, {
    mode: 'keyboard',
    gameClient,
    document: dom.window.document,
    log: { warn: (m) => warns.push(m) },
  });

  assert.equal(ok, true);
  assert.deepEqual(clicked, [4], 'falls back to REQ-07 path');
  assert.equal(keydowns.length, 0, 'no keydown dispatched without a keybind');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /no keybind for slot 4/);
});

test('REQ-08: keybind fires but no cast results -> __handleClick fallback', () => {
  const dom = makeDom();
  const clicked = [];
  const gameClient = makeGameClient({ keybinds: { 4: 70 } });
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based

  const ok = fireSlot(4, {
    mode: 'keyboard',
    gameClient,
    document: dom.window.document,
    didCast: () => false,
  });

  assert.equal(ok, true);
  assert.deepEqual(clicked, [4]);
});

test('keyboard mode keeps the dispatch result when didCast reports a cast', () => {
  const dom = makeDom();
  const clicked = [];
  const gameClient = makeGameClient({ keybinds: { 4: 70 } });
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based

  const ok = fireSlot(4, {
    mode: 'keyboard',
    gameClient,
    document: dom.window.document,
    didCast: () => true,
  });

  assert.equal(ok, true);
  assert.deepEqual(clicked, [], 'no fallback when the keydown produced a cast');
});

test('keyboard mode without keybind and without hotbar -> false', () => {
  const dom = makeDom();
  const ok = fireSlot(4, { mode: 'keyboard', gameClient: {}, document: dom.window.document });
  assert.equal(ok, false);
});

test('keybind lookup tolerates string slot keys', () => {
  const dom = makeDom();
  const keydowns = [];
  dom.window.document.addEventListener('keydown', (e) => keydowns.push(e));
  const gameClient = makeGameClient({ keybinds: { '4': 70 } });
  const ok = fireSlot(4, { mode: 'keyboard', gameClient, document: dom.window.document });
  assert.equal(ok, true);
  assert.equal(keydowns[0].keyCode, 70);
});

test('handleClick mode is unaffected by a missing document', () => {
  const clicked = [];
  const gameClient = makeGameClient();
  gameClient.interface.hotbarManager.__handleClick = (index) => clicked.push(index + 1); // real client is 0-based
  assert.equal(fireSlot(2, { gameClient }), true);
  assert.deepEqual(clicked, [2]);
});
