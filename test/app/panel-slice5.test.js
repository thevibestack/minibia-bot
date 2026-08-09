'use strict';

/**
 * Slice-5 panel tests (REQ-22/25): pure state helpers + jsdom shell —
 * premium notice rendering, learning offer rendering with Confirm/Decline,
 * offer actions gated pre-Connect, effect emission when armed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_DIR = path.join(__dirname, '..', '..', 'app', 'panel');
const INDEX_HTML = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');
const STATE_JS = fs.readFileSync(path.join(PANEL_DIR, 'state.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PANEL_DIR, 'app.js'), 'utf8');

const P = require('../../app/panel/state.js');
const FLAMAMEX = { name: 'Flamamex', vocationId: 4, vocationLabel: 'druid' };

/** Snapshot payload shaped like the app's SNAPSHOT_EXPRESSION result. */
function snapshotWith(modules) {
  return { stats: { health: 42 }, agent: { modules } };
}

function gatedState(blocked) {
  return { on: true, premium: { gated: true, active: !blocked, blocked } };
}

test('REQ-22: premiumBlockedModules lists gated modules reporting premium-blocked', () => {
  const snap = snapshotWith({
    trade: gatedState(true),
    loot: gatedState(false),
    spawns: gatedState(true),
    huntStats: gatedState(false),
    healItems: { on: true },
  });
  const blocked = P.premiumBlockedModules(snap);
  assert.deepEqual(blocked.map((b) => b.id), ['trade', 'spawns']);
  assert.equal(P.premiumBlockedModules(null).length, 0);
  assert.equal(P.premiumBlockedModules(snapshotWith({})).length, 0);
});

test('REQ-25: snapshotOffers reads learning offers from the live snapshot', () => {
  const snap = snapshotWith({ learning: { offers: [{ word: 'exura', ts: 123, sid: 24 }] } });
  assert.deepEqual(P.snapshotOffers(snap), [{ word: 'exura', ts: 123, sid: 24 }]);
  assert.deepEqual(P.snapshotOffers(snapshotWith({})), []);
  assert.deepEqual(P.snapshotOffers(null), []);
});

test('REQ-25: renderOffer escapes the word and renders Confirm/Decline with data attributes', () => {
  const html = P.renderOffer({ word: '<script>', ts: 0, sid: 24 });
  assert.ok(!html.includes('<script>'), 'word HTML-escaped');
  assert.match(html, /data-offer-action="confirm"/);
  assert.match(html, /data-offer-action="decline"/);
  assert.ok(html.includes('24'), 'best-effort sid shown');
  const noSid = P.renderOffer({ word: 'exura', ts: 0, sid: null });
  assert.ok(!noSid.includes('sid '), 'no sid -> omitted');
});

test('REQ-22/25: renderLiveState shows the premium notice and offer buttons from the snapshot', () => {
  const state = P.createInitialState();
  state.snapshot = snapshotWith({
    trade: gatedState(true),
    learning: { offers: [{ word: 'exura', ts: 123, sid: null }] },
  });
  const html = P.renderLiveState(state);
  assert.match(html, /Premium required/);
  assert.match(html, /Auto trade broadcast/);
  assert.match(html, /Registration offers/);
  assert.match(html, /data-offer-action="confirm"/);
  assert.match(html, /data-offer-action="decline"/);
});

test('REQ-22: no blocked modules -> no premium notice; no offers -> no offers section', () => {
  const state = P.createInitialState();
  state.snapshot = snapshotWith({ trade: gatedState(false), learning: { offers: [] } });
  const html = P.renderLiveState(state);
  assert.ok(!html.includes('Premium required'));
  assert.ok(!html.includes('Registration offers'));
});

test('REQ-25: CONFIRM_OFFER / DECLINE_OFFER refused pre-Connect ("not connected")', () => {
  const state = P.createInitialState();
  const r = P.panelReducer(state, { type: 'CONFIRM_OFFER', word: 'exura' });
  assert.equal(r.effects.length, 0);
  assert.equal(r.state.refusal.reason, 'not connected');
  const r2 = P.panelReducer(state, { type: 'DECLINE_OFFER', word: 'exura' });
  assert.equal(r2.state.refusal.reason, 'not connected');
});

test('REQ-25: armed gate -> offer actions emit the server effects with the word', () => {
  let state = P.createInitialState();
  state = P.panelReducer(state, { type: 'PROBE_START' }).state;          // probing
  state = P.panelReducer(state, { type: 'PROBE_RESULT', identity: FLAMAMEX }).state; // confirmed
  state = P.panelReducer(state, { type: 'CONNECT' }).state; // armed
  const c = P.panelReducer(state, { type: 'CONFIRM_OFFER', word: 'exura' });
  assert.deepEqual(c.effects, [{ type: 'offer-confirm', word: 'exura' }]);
  const d = P.panelReducer(state, { type: 'DECLINE_OFFER', word: 'exura' });
  assert.deepEqual(d.effects, [{ type: 'offer-decline', word: 'exura' }]);
});

/* ------------------------- jsdom shell integration ------------------------- */

function makePanel({ fetchStub } = {}) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://127.0.0.1:9222/',
    runScripts: 'dangerously',
  });
  if (fetchStub) {
    dom.window.fetch = async (url, opts) => fetchStub(dom.window, url, opts);
  }
  dom.window.eval(STATE_JS);
  dom.window.eval(APP_JS);
  return dom;
}

function teardown(dom) {
  try {
    if (dom.window.__mbPanel && typeof dom.window.__mbPanel.stop === 'function') dom.window.__mbPanel.stop();
  } catch { /* best-effort */ }
  dom.window.close();
}

function clickOffer(dom, action, word) {
  const btn = dom.window.document.querySelector(
    '.offer-btn[data-offer-action="' + action + '"][data-word="' + word + '"]',
  );
  assert.ok(btn, 'offer button rendered for ' + action + ':' + word);
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

test('REQ-25 (jsdom): offers render from the polled snapshot; Confirm dispatches the armed effect via fetch', async () => {
  const requests = [];
  const dom = makePanel({
    fetchStub: async (win, url, opts) => {
      if (url === '/api/identity' && !opts) {
        return { json: async () => ({ identity: FLAMAMEX }) };
      }
      if (url === '/api/snapshot') {
        return {
          json: async () => snapshotWith({ learning: { offers: [{ word: 'exura', ts: 123, sid: null }] } }),
        };
      }
      requests.push({ url, method: opts && opts.method, body: opts && opts.body });
      if (url === '/api/connect') return { json: async () => ({ ok: true, identity: FLAMAMEX, config: null }) };
      if (url === '/api/offer') return { json: async () => ({ ok: true }) };
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    const panel = dom.window.__mbPanel;
    // Poll identity -> confirmed; Connect -> armed (fetch stub).
    await new Promise((r) => setTimeout(r, 200));
    clickById(dom, 'connect-btn');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(panel.getState().gate, 'armed');

    // A snapshot carrying an offer arrives with the next poll.
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(dom.window.document.querySelector('.offer-btn'), 'offer buttons rendered from the snapshot');

    clickOffer(dom, 'confirm', 'exura');
    await new Promise((r) => setTimeout(r, 200));
    const offerReq = requests.find((rq) => rq.url === '/api/offer');
    assert.ok(offerReq, 'confirm posts to /api/offer');
    const body = JSON.parse(offerReq.body);
    assert.equal(body.action, 'confirm');
    assert.equal(body.word, 'exura');

    clickOffer(dom, 'decline', 'exura');
    await new Promise((r) => setTimeout(r, 200));
    const declines = requests.filter((rq) => rq.url === '/api/offer' && JSON.parse(rq.body).action === 'decline');
    assert.equal(declines.length, 1, 'decline posts to /api/offer');
  } finally {
    teardown(dom);
  }
});

test('REQ-22 (jsdom): a premium-blocked snapshot renders the "Premium required" notice', async () => {
  const dom = makePanel({
    fetchStub: async (win, url) => {
      if (url === '/api/identity') return { json: async () => ({ identity: FLAMAMEX }) };
      if (url === '/api/snapshot') {
        return { json: async () => snapshotWith({ trade: gatedState(true), huntStats: gatedState(true) }) };
      }
      return { json: async () => ({ ok: true }) };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 700));
    const live = dom.window.document.getElementById('live-state');
    assert.match(live.textContent, /Premium required/);
    assert.match(live.textContent, /Auto trade broadcast/);
    assert.match(live.textContent, /Hunt stats/);
  } finally {
    teardown(dom);
  }
});

function clickById(dom, id) {
  const btn = dom.window.document.getElementById(id);
  assert.ok(btn, 'button ' + id + ' rendered');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}
