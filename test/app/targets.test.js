'use strict';

/**
 * Tests for app/cdp/targets.ts (task 1.5, REQ-01/05).
 *
 * - scan URLs are built ONLY from validated ports and ALWAYS against
 *   loopback hosts (127.0.0.1 / [::1], REQ-05 local-only boundary);
 * - filter keeps minibia.com `type:"page"` targets only;
 * - scanPorts never throws; per-port failures become actionable errors;
 * - the picker error is actionable (REQ-01 "GIVEN no target found...").
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const targets = require(path.join(__dirname, '..', '..', 'app', 'cdp', 'targets.ts'));

const SAMPLE_LIST = [
  { type: 'page', title: 'Minibia', url: 'https://minibia.com/play', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A' },
  { type: 'page', title: 'Other tab', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/B' },
  { type: 'webview', title: 'Minibia embed', url: 'https://minibia.com/embed', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/C' },
  { type: 'page', url: 'https://minibia.com/play' }, // missing ws url — still listed for the picker
  { type: 'page', title: 'No url field' },
  'junk',
  null,
];

test('REQ-01: buildScanUrl builds loopback URLs from validated ports only', () => {
  assert.strictEqual(targets.buildScanUrl(9222), 'http://127.0.0.1:9222/json/list');
  assert.strictEqual(targets.buildScanUrl('9223'), 'http://127.0.0.1:9223/json/list');
  assert.strictEqual(targets.buildScanUrl(9222, '[::1]'), 'http://[::1]:9222/json/list');
  assert.strictEqual(targets.buildScanUrl(9222, '::1'), 'http://[::1]:9222/json/list');
  for (const bad of [0, 80, 1023, 65536, 'abc', '9222.5', null, undefined, -1]) {
    assert.throws(() => targets.buildScanUrl(bad), RangeError, `port ${JSON.stringify(bad)} must be rejected`);
  }
  for (const badHost of ['localhost', '0.0.0.0', 'example.com', '192.168.1.1']) {
    assert.throws(() => targets.buildScanUrl(9222, badHost), RangeError, `host ${badHost} must be rejected`);
  }
});

test('REQ-01: every URL a scan can fetch is loopback-only', async () => {
  const fetched = [];
  await targets.scanPorts([9222, 9223, 9224], {
    fetchImpl: async (url) => { fetched.push(url); return []; },
  });
  assert.strictEqual(fetched.length, 6);
  for (const url of fetched) {
    assert.ok(url.startsWith('http://127.0.0.1:') || url.startsWith('http://[::1]:'), 'scan URL must be local-only: ' + url);
  }
});

test('REQ-01: filterTargets keeps only minibia.com type:page entries', () => {
  const out = targets.filterTargets(SAMPLE_LIST);
  assert.strictEqual(out.length, 2);
  for (const t of out) {
    assert.strictEqual(t.type, 'page');
    assert.ok(t.url.includes('minibia.com'));
  }
});

test('REQ-01: filterTargets tolerates malformed payloads without throwing', () => {
  assert.deepStrictEqual(targets.filterTargets(null), []);
  assert.deepStrictEqual(targets.filterTargets(undefined), []);
  assert.deepStrictEqual(targets.filterTargets('nope'), []);
  assert.deepStrictEqual(targets.filterTargets({}), []);
});

test('REQ-01: scanPorts collects targets from reachable ports', async () => {
  const { targets: found, errors } = await targets.scanPorts([9222, 9223], {
    fetchImpl: async (url) => {
      if (url.includes('127.0.0.1:9222')) return SAMPLE_LIST;
      throw new Error('connection refused');
    },
  });
  assert.strictEqual(found.length, 2);
  assert.strictEqual(errors.length, 3);
  assert.strictEqual(errors[0].port, 9222);
  assert.strictEqual(errors[1].port, 9223);
  assert.match(errors[0].message, /not reachable/);
});

test('REQ-01: scanPorts finds Chrome when DevTools binds only to IPv6 loopback', async () => {
  const ipv6List = [{
    type: 'page',
    title: 'Minibia',
    url: 'https://minibia.com/play',
    webSocketDebuggerUrl: 'ws://[::1]:9222/devtools/page/A',
  }];
  const { targets: found, errors } = await targets.scanPorts([9222], {
    fetchImpl: async (url) => {
      if (url.startsWith('http://127.0.0.1:')) return { ok: false, status: 404 };
      if (url.startsWith('http://[::1]:')) return ipv6List;
      throw new Error('unexpected url ' + url);
    },
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].webSocketDebuggerUrl, 'ws://[::1]:9222/devtools/page/A');
  assert.strictEqual(errors.length, 1, 'IPv4 miss is recorded, IPv6 hit still succeeds');
});

test('REQ-01: scanPorts never throws — total failure resolves with errors', async () => {
  const { targets: found, errors } = await targets.scanPorts([9222, 9223, 9224], {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.deepStrictEqual(found, []);
  assert.strictEqual(errors.length, 6);
});

test('REQ-01: scanPorts reports invalid configured ports without fetching them', async () => {
  let fetched = 0;
  const { targets: found, errors } = await targets.scanPorts([80, 'abc', 9222], {
    fetchImpl: async () => { fetched += 1; return []; },
  });
  assert.strictEqual(fetched, 2, 'only the valid port is fetched on both loopback hosts');
  assert.strictEqual(found.length, 0);
  assert.strictEqual(errors.length, 2);
});

test('REQ-01: scanPorts turns non-JSON answers into actionable errors', async () => {
  const { targets: found, errors } = await targets.scanPorts([9222], {
    fetchImpl: async () => ({ status: 403, ok: false }),
  });
  assert.strictEqual(found.length, 0);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0].message, /HTTP 403/);
});

test('REQ-01: picker result is actionable when nothing is found', () => {
  const { targets: found, errors } = { targets: [], errors: [{ port: 9222, message: 'port 9222 not reachable' }] };
  const res = targets.describePickerResult({ targets: found, errors, ports: [9222, 9223, 9224] });
  assert.strictEqual(res.selectable, false);
  assert.match(res.message, /No minibia\.com window found/);
  assert.match(res.message, /--remote-debugging-port/); // next step is concrete
  assert.match(res.message, /Launch/);                  // primary path is named
  assert.match(res.message, /port 9222 not reachable/); // per-port detail
});

test('REQ-01: picker lists found targets as selectable', () => {
  const picked = targets.filterTargets(SAMPLE_LIST);
  const res = targets.describePickerResult({ targets: picked, errors: [], ports: [9222] });
  assert.strictEqual(res.selectable, true);
  assert.strictEqual(res.targets.length, 2);
  assert.match(res.message, /2 game windows found/);
});
