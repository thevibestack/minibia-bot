'use strict';

/**
 * PR 5 — anti-bot wiring e2e tests (REQ-33/34 + REQ-24 MODIFIED, D9):
 * the watcher rides the REAL committed agent bundle, reading the SAME
 * Default-channel poll as echo/learning; speak events raise alerts in the
 * snapshot; first pattern occurrence raises a pending confirm; the
 * confirmAntibot RPC enables auto-replies (queue-dispatched send); with no
 * send surface the module degrades to ALERT-ONLY (the open probe); the
 * confirmation is session-scoped across config rebuilds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', '..', 'minibia-desktop-agent.js'), 'utf8');

async function waitFor(fn, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Fresh page: mocked gameClient with a Default channel carrying a mutable
 *  __contents list + a recording send method (the feature-detected surface). */
function makePage(contents, opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://minibia.com/play',
    runScripts: 'dangerously',
  });
  const sends = [];
  const gameClient = {
    player: {
      name: 'Flamamex',
      vocation: 4,
      state: { mana: 100, maxMana: 120, health: 100, maxHealth: 100 },
      spellbook: { cooldowns: { GLOBAL_COOLDOWN: { active: false } }, spells: {} },
    },
    interface: {
      hotbarManager: {
        __VOCATION_NAMES: { 4: 'druid' },
        __handleClick: () => {},
        __canPlayerCastSpell: () => true,
      },
      channelManager: opts.channelManager !== undefined ? opts.channelManager : {
        getChannel: (name) => (name === 'Default'
          ? { __contents: contents, send: (text) => sends.push(text) }
          : null),
      },
    },
    mouse: { use: () => {} },
  };
  dom.window.gameClient = gameClient;
  dom.window.eval(BUNDLE);
  return { dom, sends, gameClient, contents };
}

function teardown(dom) {
  try {
    if (dom.window.__mbAgentHandle && typeof dom.window.__mbAgentHandle.destroy === 'function') {
      dom.window.__mbAgentHandle.destroy();
    }
  } catch { /* best-effort */ }
  dom.window.close();
}

function antibotConfig(overrides = {}) {
  return Object.assign({
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: 1 },
    rotation: { spells: [] },
    armed: true,
    antibot: { on: true, replies: [{ pattern: 'are you bot?', reply: 'ok then' }] },
  }, overrides);
}

test('REQ-33 (PR5, e2e): GM speak in the Default channel raises an alert that rides the snapshot', async () => {
  const contents = [];
  const { dom, contents: c } = makePage(contents);
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(antibotConfig());
    c.push({ name: 'GM-Test', message: 'stop botting', __time: 1, type: 2 });
    const ok = await waitFor(() => {
      const m = handle.getState().modules.antibot;
      return m && m.counters && m.counters.speaks >= 1;
    });
    assert.equal(ok, true, 'watcher sees the speak event on the shared poll');
    const st = handle.getState().modules.antibot;
    assert.ok(st.alerts.some((a) => a.kind === 'speak'), 'speak alert in the snapshot');
    assert.equal(st.on, true);
  } finally {
    teardown(dom);
  }
});

test('REQ-34 (PR5, e2e): first occurrence -> pending confirm; confirmAntibot RPC -> auto-reply through the queue', async () => {
  const contents = [];
  const { dom, sends, contents: c } = makePage(contents);
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(antibotConfig());

    // First occurrence: pending confirm surfaces in the snapshot.
    c.push({ name: 'GM-Test', message: 'are you bot?', __time: 10, type: 2 });
    const pending = await waitFor(() => {
      const m = handle.getState().modules.antibot;
      return m && m.pendingConfirm && m.pendingConfirm.pattern === 'are you bot?';
    });
    assert.equal(pending, true, 'pending confirm raised (REQ-34 first occurrence)');
    assert.equal(handle.getState().modules.antibot.replyPendingCount, 0, 'no auto-reply before confirm');
    assert.equal(sends.length, 0);

    // Confirm via the RPC (the panel -> /api/antibot-confirm path).
    const res = dom.window.__mbAgent.confirmAntibot('are you bot?');
    assert.equal(res.ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(handle.getState().modules.antibot.confirmed)),
      ['are you bot?'],
    );

    // Next occurrence: the auto-reply fires through the queue-dispatched send.
    c.push({ name: 'GM-Test', message: 'are you bot?', __time: 20, type: 2 });
    const sent = await waitFor(() => sends.length > 0);
    assert.equal(sent, true, 'auto-reply dispatched through the queue (REQ-12)');
    assert.deepEqual(sends, ['ok then'], 'the configured reply text reached the Default channel send');
    const q = handle.getState().queue;
    assert.ok(q.enqueued >= 1 && q.dispatched >= 1, 'the send ran inside a queue-dispatch closure');
  } finally {
    teardown(dom);
  }
});

test('REQ-34 (PR5, e2e): session-scoped — the confirmation survives an applyConfig rebuild', async () => {
  const contents = [];
  const { dom, sends, contents: c } = makePage(contents);
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(antibotConfig());
    c.push({ name: 'GM-Test', message: 'are you bot?', __time: 5, type: 2 });
    await waitFor(() => {
      const m = handle.getState().modules.antibot;
      return m && m.pendingConfirm;
    });
    dom.window.__mbAgent.confirmAntibot('are you bot?');

    // Rebuild (applyConfig again) — session state (state.timers) survives.
    dom.window.__mbAgent.applyConfig(antibotConfig({ antibot: { on: true, replies: [{ pattern: 'are you bot?', reply: 'ok then' }] } }));
    c.push({ name: 'GM-Test', message: 'are you bot?', __time: 15, type: 2 });
    const sent = await waitFor(() => sends.length > 0);
    assert.equal(sent, true, 'confirmed pattern auto-replies after the rebuild (session-scoped)');
  } finally {
    teardown(dom);
  }
});

test('REQ-34 (PR5, e2e, open probe): no Default-channel send surface -> alert-only degrade, never an invented path', async () => {
  const contents = [];
  const { dom, sends } = makePage(contents, {
    channelManager: { getChannel: (name) => (name === 'Default' ? { __contents: contents } : null) },
  });
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(antibotConfig());
    // Confirm directly (the pending prompt flow would take the same path).
    contents.push({ name: 'GM-Test', message: 'are you bot?', __time: 1, type: 2 });
    await waitFor(() => {
      const m = handle.getState().modules.antibot;
      return m && m.pendingConfirm;
    });
    dom.window.__mbAgent.confirmAntibot('are you bot?');
    contents.push({ name: 'GM-Test', message: 'are you bot?', __time: 2, type: 2 });
    await new Promise((r) => setTimeout(r, 900)); // several tick cadences
    const st = handle.getState().modules.antibot;
    assert.equal(st.sendAvailable, false, 'honest degrade: no send surface');
    assert.match(st.sendReason, /alert only/);
    assert.equal(st.replyPendingCount, 0, 'nothing queued');
    assert.equal(sends.length, 0, 'no invented send path (open probe: alert-only branch)');
  } finally {
    teardown(dom);
  }
});

test('REQ-34 (PR5, e2e): confirmAntibot RPC is refused pre-Connect', async () => {
  const { dom } = makePage([]);
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    const res = dom.window.__mbAgent.confirmAntibot('are you bot?');
    assert.deepEqual(JSON.parse(JSON.stringify(res)), { ok: false, reason: 'not connected' });
  } finally {
    teardown(dom);
  }
});

test('REQ-40/41 (e2e): Cipfried verification message pauses the queue + snapshot.runeCheck; resumeRuneCheck unpauses', async () => {
  const contents = [];
  const { dom, contents: c } = makePage(contents);
  try {
    const handle = dom.window.__mbAgentHandle;
    await waitFor(() => handle.isReady());
    dom.window.__mbAgent.applyConfig(antibotConfig());

    c.push({ name: 'Cipfried', message: 'Please verify you are human by clicking the correct images', __time: 10, type: 2 });
    const paused = await waitFor(() => {
      const st = handle.getState();
      return st.runeCheck && st.runeCheck.active === true;
    });
    assert.equal(paused, true, 'snapshot.runeCheck active (REQ-40)');
    const st = handle.getState();
    assert.equal(st.runeCheck.kind, 'chat');
    assert.equal(st.queue.paused, true, 'queue gate paused on detection');
    assert.ok(st.modules.antibot.alerts.some((a) => a.kind === 'runecheck'), 'runecheck alert rides the module alerts');

    // Steady state: repeated wording keeps the pause, never double-counts.
    c.push({ name: 'Cipfried', message: 'Please verify you are human by clicking the correct images', __time: 20, type: 2 });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(handle.getState().queue.paused, true, 'still paused while the wording continues');
    assert.equal(
      handle.getState().modules.antibot.alerts.filter((a) => a.kind === 'runecheck').length,
      1,
      'one runecheck alert — no double-count',
    );

    // Manual resume RPC: unpauses + clears the state.
    const res = dom.window.__mbAgent.resumeRuneCheck();
    assert.equal(res.ok, true);
    const resumed = await waitFor(() => {
      const s = handle.getState();
      return s.queue.paused !== true && s.runeCheck === null;
    });
    assert.equal(resumed, true, 'manual resume unpauses and clears the snapshot state');
  } finally {
    teardown(dom);
  }
});
