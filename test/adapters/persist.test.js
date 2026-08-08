'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPersist } = require('../../src/adapters/persist');

/** Minimal GM object (synchronous, Tampermonkey-style). */
function makeGm(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    setValue: (k, v) => store.set(k, v),
    getValue: (k) => store.get(k),
    deleteValue: (k) => store.delete(k),
    listValues: () => [...store.keys()],
    _store: store,
  };
}

test('REQ-12: GM probe round-trip -> gm backend used', async () => {
  const gm = makeGm();
  const persist = await createPersist({ gm });
  assert.equal(persist.backend, 'gm');
  assert.equal(await persist.set('config', { spells: [1, 2] }), true);
  assert.deepEqual(await persist.get('config'), { spells: [1, 2] });
});

/** jsdom with an http origin so window.localStorage is available. */
function makeDom() {
  return new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://minibia.test/play' });
}

test('REQ-12: GM absent (@grant none) -> localStorage fallback, same shape', async () => {
  const dom = makeDom();
  const persist = await createPersist({ storage: dom.window.localStorage });
  assert.equal(persist.backend, 'localStorage');
  assert.equal(await persist.set('config', { threshold: 20 }), true);
  assert.deepEqual(await persist.get('config'), { threshold: 20 });
  assert.equal(dom.window.localStorage.getItem('mb-config'), JSON.stringify({ threshold: 20 }));
});

test('REQ-12: keys are stored under the mb- prefix (localStorage)', async () => {
  const dom = makeDom();
  const ls = dom.window.localStorage;
  const persist = await createPersist({ storage: ls });
  await persist.set('config', { a: 1 });
  await persist.set('food', 'ham');
  assert.equal(ls.getItem('mb-config'), '{"a":1}');
  assert.equal(ls.getItem('mb-food'), '"ham"');
  assert.equal(ls.length, 2, 'no unprefixed keys written');
});

test('REQ-12: already-prefixed keys pass through without double prefixing', async () => {
  const dom = makeDom();
  const ls = dom.window.localStorage;
  const persist = await createPersist({ storage: ls });
  await persist.set('mb-config', { a: 1 });
  assert.equal(ls.getItem('mb-config'), '{"a":1}');
  assert.equal(ls.length, 1);
});

test('REQ-12: Reset clears ALL mb-* keys, including ones written outside the adapter', async () => {
  const dom = makeDom();
  const ls = dom.window.localStorage;
  ls.setItem('mb-config', '{"a":1}');
  ls.setItem('mb-foo', 'x');
  ls.setItem('other-key', 'keep me'); // unrelated key survives
  const persist = await createPersist({ storage: ls });

  await persist.clear();

  assert.equal(ls.getItem('mb-config'), null);
  assert.equal(ls.getItem('mb-foo'), null);
  assert.equal(ls.getItem('other-key'), 'keep me');
});

test('REQ-12: clear honors a custom prefix override', async () => {
  const dom = makeDom();
  const ls = dom.window.localStorage;
  ls.setItem('mb-a', '1');
  ls.setItem('mbx-b', '2');
  const persist = await createPersist({ storage: ls });
  await persist.clear('mbx-');
  assert.equal(ls.getItem('mb-a'), '1');
  assert.equal(ls.getItem('mbx-b'), null);
});

test('persist: get on missing key -> null; corrupted JSON -> null', async () => {
  const dom = makeDom();
  const ls = dom.window.localStorage;
  ls.setItem('mb-broken', '{not json');
  const persist = await createPersist({ storage: ls });
  assert.equal(await persist.get('missing'), null);
  assert.equal(await persist.get('broken'), null);
});

test('persist: GM backend supports promise-based implementations (Greasemonkey-style)', async () => {
  const store = new Map();
  const gm = {
    setValue: async (k, v) => store.set(k, v),
    getValue: async (k) => store.get(k),
    deleteValue: async (k) => store.delete(k),
    listValues: async () => [...store.keys()],
  };
  const persist = await createPersist({ gm });
  assert.equal(persist.backend, 'gm');
  assert.equal(await persist.set('config', { b: 2 }), true);
  assert.deepEqual(await persist.get('config'), { b: 2 });
});

test('persist: GM probe failure (setValue throws) -> localStorage fallback', async () => {
  const dom = makeDom();
  const gm = { setValue: () => { throw new Error('no storage'); }, getValue: () => null };
  const persist = await createPersist({ gm, storage: dom.window.localStorage });
  assert.equal(persist.backend, 'localStorage');
  assert.equal(await persist.set('config', 1), true);
});

test('persist: GM backend clear uses listValues when available', async () => {
  const gm = makeGm({ 'mb-a': '1', 'mb-b': '2', 'other': 'x' });
  const persist = await createPersist({ gm });
  await persist.clear();
  assert.equal(gm._store.has('mb-a'), false);
  assert.equal(gm._store.has('mb-b'), false);
  assert.equal(gm._store.has('other'), true);
});

test('persist: GM backend without listValues clears keys it wrote', async () => {
  const gm = makeGm();
  delete gm.listValues;
  const persist = await createPersist({ gm });
  await persist.set('config', 1);
  await persist.clear();
  assert.equal(await persist.get('config'), null);
});

test('persist: no GM and no storage -> none backend, no throw', async () => {
  const persist = await createPersist({ gm: null, storage: null });
  assert.equal(persist.backend, 'none');
  assert.equal(await persist.get('config'), null);
  assert.equal(await persist.set('config', 1), false);
  await persist.clear();
});
