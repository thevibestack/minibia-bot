'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalog, normalizeEntries } = require('../../src/adapters/catalog');

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function loadWith(fetchImpl, { url = 'catalog.json', log = {} } = {}) {
  return loadCatalog(url, { fetch: fetchImpl, log });
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
