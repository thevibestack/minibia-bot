'use strict';

/**
 * Tests for the interconnection data contract (task 1.6, REQ-02 prep):
 * the live-probed __VOCATION_NAMES mapping, the {name, vocationId,
 * vocationLabel} identity shape, and the page-side read expression
 * evaluated against a mocked window (vm sandbox — no browser needed).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');

const identity = require(path.join(__dirname, '..', '..', 'app', 'cdp', 'identity.ts'));

/** Evaluate the page-side expression against a fake window.gameClient. */
function readWithFakeClient(gameClient) {
  const sandbox = { window: { gameClient } };
  vm.runInNewContext('', sandbox); // ensure the sandbox object is contextualized
  const value = vm.runInNewContext(identity.PLAYER_IDENTITY_EXPRESSION, sandbox);
  return identity.normalizeIdentity(value);
}

test('REQ-02: vocationLabel maps the live-probed table (1-8 + 0)', () => {
  assert.strictEqual(identity.vocationLabel(1), 'knight');
  assert.strictEqual(identity.vocationLabel(2), 'paladin');
  assert.strictEqual(identity.vocationLabel(3), 'sorcerer');
  assert.strictEqual(identity.vocationLabel(4), 'druid');
  // promoted ids map to the same vocation names (probe: 5-8 = promoted)
  assert.strictEqual(identity.vocationLabel(5), 'knight');
  assert.strictEqual(identity.vocationLabel(6), 'paladin');
  assert.strictEqual(identity.vocationLabel(7), 'sorcerer');
  assert.strictEqual(identity.vocationLabel(8), 'druid');
  assert.strictEqual(identity.vocationLabel(0), 'none');
});

test('REQ-02: vocationLabel is "none" for unknown/malformed ids', () => {
  for (const bad of [undefined, null, NaN, 99, -1, 2.5, 'abc', '4.5', '', {}, []]) {
    assert.strictEqual(identity.vocationLabel(bad), 'none', JSON.stringify(bad));
  }
  assert.strictEqual(identity.vocationLabel('4'), 'druid', 'numeric strings are tolerated');
});

test('REQ-02: VOCATION_NAMES is frozen (contract, not config)', () => {
  assert.ok(Object.isFrozen(identity.VOCATION_NAMES));
  assert.throws(() => { identity.VOCATION_NAMES[4] = 'hacker'; }, TypeError);
});

test('REQ-02: normalizeIdentity returns the exact contract shape', () => {
  assert.deepStrictEqual(identity.normalizeIdentity({ name: 'Flamamex', vocationId: 4 }), {
    name: 'Flamamex',
    vocationId: 4,
    vocationLabel: 'druid',
  });
  assert.deepStrictEqual(identity.normalizeIdentity({ name: 'Flamamex', vocationId: '4' }), {
    name: 'Flamamex',
    vocationId: 4,
    vocationLabel: 'druid',
  });
});

test('REQ-02: normalizeIdentity returns null when the name is unusable', () => {
  assert.strictEqual(identity.normalizeIdentity(null), null);
  assert.strictEqual(identity.normalizeIdentity(undefined), null);
  assert.strictEqual(identity.normalizeIdentity({}), null);
  assert.strictEqual(identity.normalizeIdentity({ name: '' }), null);
  assert.strictEqual(identity.normalizeIdentity({ name: '   ' }), null);
  assert.strictEqual(identity.normalizeIdentity({ name: 123 }), null);
});

test('REQ-02: missing vocationId yields "none" label but keeps the name', () => {
  const id = identity.normalizeIdentity({ name: 'Flamamex' });
  assert.strictEqual(id.name, 'Flamamex');
  assert.strictEqual(id.vocationId, null);
  assert.strictEqual(id.vocationLabel, 'none');
});

test('REQ-02: page expression reads the LIVE __VOCATION_NAMES table (Flamamex = 4 = druid)', () => {
  const id = readWithFakeClient({
    player: { name: 'Flamamex', vocation: 4 },
    interface: { hotbarManager: { __VOCATION_NAMES: identity.VOCATION_NAMES } },
  });
  assert.deepStrictEqual(id, { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' });
});

test('REQ-02: page expression returns nulls when the client is not ready (CF page)', () => {
  assert.strictEqual(readWithFakeClient(null), null);
  assert.strictEqual(readWithFakeClient({}), null);
});

test('REQ-02: missing page table falls back to the app-side probed mapping', () => {
  const id = readWithFakeClient({ player: { name: 'Flamamex', vocation: 4 } });
  assert.strictEqual(id.name, 'Flamamex');
  assert.strictEqual(id.vocationId, 4);
  assert.strictEqual(id.vocationLabel, 'druid'); // fallback VOCATION_NAMES[4]
});

test('REQ-02: page label is authoritative when the table answers', () => {
  const id = readWithFakeClient({
    player: { name: 'Flamamex', vocation: 4 },
    interface: { hotbarManager: { __VOCATION_NAMES: { 4: 'druid' } } },
  });
  assert.strictEqual(id.vocationLabel, 'druid');
});

test('REQ-02: unknown page-table id degrades to "none" (label unconfirmed)', () => {
  const id = readWithFakeClient({
    player: { name: 'Flamamex', vocation: 9 },
    interface: { hotbarManager: { __VOCATION_NAMES: { 4: 'druid' } } },
  });
  assert.strictEqual(id.vocationLabel, 'none');
});
