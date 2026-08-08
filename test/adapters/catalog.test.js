'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalog, normalizeEntries, readStoredCatalog, STORAGE_KEY } = require('../../src/adapters/catalog');

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

/** Minimal Storage-like object over a plain map (getItem contract only). */
function storageWith(map) {
  return { getItem: (k) => (k in map ? map[k] : null) };
}

function loadWith(fetchImpl, { url = 'catalog.json', log = {}, storage } = {}) {
  return loadCatalog(url, { fetch: fetchImpl, log, storage });
}

test('REQ-11: loads and normalizes catalog entries from same-origin fetch', async () => {
  const fetchImpl = async (u) => {
    assert.equal(u, 'catalog.json');
    return jsonResponse([
      { cid: 3582, name: 'seasoned ham', article: 'a', type: 'food', weight: 1.5, runeSpellName: null },
      { cid: 24, name: 'adori', article: '', type: 'rune', runeSpellName: 'adori' },
    ]);
  };
  const entries = await loadWith(fetchImpl);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cid, 3582);
  assert.equal(entries[0].name, 'seasoned ham');
  assert.equal(entries[0].type, 'food');
  assert.equal(entries[1].runeSpellName, 'adori');
  assert.equal(entries[1].imageDataURL, null);
});

test('REQ-11: accepts a {cid: entry} map shape', async () => {
  const fetchImpl = async () =>
    jsonResponse({ 3582: { cid: 3582, name: 'seasoned ham' }, 24: { cid: 24, name: 'adori' } });
  const entries = await loadWith(fetchImpl);
  assert.equal(entries.length, 2);
  const ham = entries.find((e) => e.cid === 3582);
  assert.equal(ham.name, 'seasoned ham');
});

test('REQ-11: HTTP 404 (catalog.json not generated yet) -> corrupt + warning', async () => {
  const warns = [];
  const result = await loadWith(async () => jsonResponse(null, { ok: false, status: 404 }), {
    log: { warn: (m) => warns.push(m) },
  });
  assert.equal(result, 'corrupt');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /keybind-only mode \(REQ-11\)/);
});

test('REQ-11: invalid JSON -> corrupt + warning', async () => {
  const warns = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });
  const result = await loadWith(fetchImpl, { log: { warn: (m) => warns.push(m) } });
  assert.equal(result, 'corrupt');
  assert.match(warns[0], /corrupt JSON/);
});

test('REQ-11: network rejection -> corrupt + warning', async () => {
  const warns = [];
  const result = await loadWith(
    async () => {
      throw new TypeError('Failed to fetch');
    },
    { log: { warn: (m) => warns.push(m) } },
  );
  assert.equal(result, 'corrupt');
  assert.match(warns[0], /fetch failed/);
});

test('REQ-11: non-array, non-object payload -> corrupt', async () => {
  const result = await loadWith(async () => jsonResponse('garbage'));
  assert.equal(result, 'corrupt');
});

test('REQ-11: empty catalog -> corrupt (nothing searchable)', async () => {
  const warns = [];
  const result = await loadWith(async () => jsonResponse([]), { log: { warn: (m) => warns.push(m) } });
  assert.equal(result, 'corrupt');
  assert.match(warns[0], /no usable entries/);
});

test('REQ-11: entries without cid or name are filtered; all-invalid -> corrupt', async () => {
  const result = await loadWith(async () =>
    jsonResponse([{ cid: 1, name: 'ok' }, { name: 'no-cid' }, { cid: 2 }, 'junk', null]),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'ok');

  const allInvalid = await loadWith(async () => jsonResponse([{ name: 'no-cid' }, { cid: 2 }]));
  assert.equal(allInvalid, 'corrupt');
});

test('REQ-11: no fetch available -> corrupt + warning (keybind-only)', async () => {
  const warns = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const result = await loadCatalog('catalog.json', { fetch: undefined, log: { warn: (m) => warns.push(m) } });
    assert.equal(result, 'corrupt');
    assert.match(warns[0], /no fetch available/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('normalizeEntries: object without usable values -> null', () => {
  assert.equal(normalizeEntries(null), null);
  assert.equal(normalizeEntries('x'), null);
  assert.equal(normalizeEntries({}), null);
  assert.equal(normalizeEntries([{ id: null, name: 'no-id' }]), null, 'null id rejected');
});

test('REQ-10/11: localStorage seed (mb-catalog) wins — fetch is never called', async () => {
  const entries = [
    { cid: 3582, name: 'seasoned ham', imageDataURL: null, npcTrades: [] },
    { cid: 24, name: 'adori', imageDataURL: null, npcTrades: [] },
  ];
  const result = await loadWith(
    async () => { throw new Error('fetch must not be called when the seed is valid'); },
    { storage: storageWith({ [STORAGE_KEY]: JSON.stringify(entries) }) },
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'seasoned ham');
  assert.equal(result[1].runeSpellName, null);
});

test('REQ-11: corrupt stored JSON falls through to the fetch fallback', async () => {
  const warns = [];
  const fetchImpl = async () => jsonResponse([{ cid: 1, name: 'from fetch' }]);
  const result = await loadWith(fetchImpl, {
    storage: storageWith({ [STORAGE_KEY]: '{not json' }),
    log: { warn: (m) => warns.push(m) },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'from fetch');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /stored mb-catalog is corrupt JSON/);
});

test('REQ-11: empty stored catalog (no usable entries) falls through to fetch', async () => {
  const fetchImpl = async () => jsonResponse([{ cid: 7, name: 'rope' }]);
  const result = await loadWith(fetchImpl, {
    storage: storageWith({ [STORAGE_KEY]: JSON.stringify([]) }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'rope');
});

test('REQ-11: corrupt seed AND fetch 404 -> corrupt + warning (keybind-only)', async () => {
  const warns = [];
  const result = await loadWith(
    async () => jsonResponse(null, { ok: false, status: 404 }),
    {
      storage: storageWith({ [STORAGE_KEY]: 'garbage' }),
      log: { warn: (m) => warns.push(m) },
    },
  );
  assert.equal(result, 'corrupt');
  assert.ok(warns.some((m) => /stored mb-catalog is corrupt JSON/.test(m)));
  assert.ok(warns.some((m) => /keybind-only mode \(REQ-11\)/.test(m)));
});

test('REQ-11: absent seed key -> fetch used silently (no storage warning)', async () => {
  const warns = [];
  const fetchImpl = async () => jsonResponse([{ cid: 3, name: 'wrench' }]);
  const result = await loadWith(fetchImpl, { storage: storageWith({}), log: { warn: (m) => warns.push(m) } });
  assert.equal(result.length, 1);
  assert.equal(warns.length, 0, 'absence is silent — fetch fallback is the expected first-run path');
});

test('REQ-11: storage read failure -> warning + fetch fallback', async () => {
  const warns = [];
  const fetchImpl = async () => jsonResponse([{ cid: 9, name: 'torch' }]);
  const brokenStorage = { getItem: () => { throw new Error('SecurityError'); } };
  const result = await loadWith(fetchImpl, { storage: brokenStorage, log: { warn: (m) => warns.push(m) } });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'torch');
  assert.match(warns[0], /localStorage read failed/);
});

test('readStoredCatalog: returns null on absence and validates stored payloads', () => {
  const noWarn = () => {};
  assert.equal(readStoredCatalog(null, noWarn), null, 'no storage -> null');
  assert.equal(readStoredCatalog({ getItem: () => null }, noWarn), null, 'absent key -> null');
  assert.equal(readStoredCatalog({ getItem: () => 'not-json' }, noWarn), null, 'corrupt JSON -> null');
  const entries = readStoredCatalog(
    { getItem: () => JSON.stringify([{ cid: 1, name: 'ok' }, { name: 'no-cid' }]) },
    noWarn,
  );
  assert.equal(entries.length, 1, 'invalid entries filtered like the fetch path');
  assert.equal(entries[0].name, 'ok');
});
