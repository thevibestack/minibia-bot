'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { getRecentMessages } = require('../../src/adapters/chat');

function makeDom(bodyHtml = '') {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
}

function makeGameClient(contents) {
  return {
    interface: {
      channelManager: {
        getChannel: (name) => (name === 'Default' ? { __contents: contents } : null),
      },
    },
  };
}

test('REQ-09: reads Default channel __contents as primary source', () => {
  const ctx = {
    gameClient: makeGameClient([
      { name: 'Flamamex', message: 'adori', __time: 123 },
      { name: 'Otto', message: 'hi', __time: 456 },
    ]),
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { name: 'Flamamex', message: 'adori', time: 123, type: null, source: 'channel' });
  assert.deepEqual(entries[1], { name: 'Otto', message: 'hi', time: 456, type: null, source: 'channel' });
});

test('REQ-33 (PR5): the raw speak type passes through when the game exposes it', () => {
  const ctx = {
    gameClient: makeGameClient([
      { name: 'GM-Test', message: 'stop botting', __time: 1, type: 0 },
      { name: 'Otto', message: 'hi', __time: 2, type: 2 },
      { name: 'Sys', message: 'msg', __time: 3, type: 6 },
    ]),
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries[0].type, 0, 'type 0 passthrough (speak)');
  assert.equal(entries[1].type, 2, 'type 2 passthrough (speak)');
  assert.equal(entries[2].type, 6, 'non-speak type preserved for the watcher');
  assert.equal(entries[0].source, 'channel');
});

test('REQ-09: empty channel contents -> empty list', () => {
  const entries = getRecentMessages({ gameClient: makeGameClient([]) });
  assert.deepEqual(entries, []);
});

test('REQ-09: channel entries tolerate missing fields', () => {
  const ctx = { gameClient: makeGameClient([{ name: 'X' }, { message: 'hello' }, {}]) };
  const entries = getRecentMessages(ctx);
  assert.equal(entries[0].message, '');
  assert.equal(entries[0].time, null);
  assert.equal(entries[1].name, null);
  assert.equal(entries[2].name, null);
  assert.equal(entries[2].message, '');
});

test('REQ-37: Date-object __time normalizes to epoch ms (real client shape)', () => {
  const ctx = {
    gameClient: makeGameClient([
      { name: 'Cipfried', message: 'verify you are human', __time: new Date(123456789), type: 2 },
      { name: 'Otto', message: 'hi', __time: new Date(987654321) },
    ]),
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].time, 123456789, 'Date -> getTime()');
  assert.equal(entries[1].time, 987654321);
  assert.equal(entries[0].type, 2, 'other fields untouched');
  assert.equal(entries[0].source, 'channel');
});

test('REQ-37: numeric __time passes through unchanged', () => {
  const ctx = {
    gameClient: makeGameClient([
      { name: 'Otto', message: 'hi', __time: 456 },
      { name: 'Sys', message: 'msg', __time: 0 },
    ]),
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries[0].time, 456, 'numeric passthrough');
  assert.equal(entries[1].time, 0, 'legit epoch 0 is NOT nulled');
});

test('REQ-37: missing/null/invalid __time is null-safe — no throw', () => {
  const ctx = {
    gameClient: makeGameClient([
      { name: 'X', message: 'no time' },
      { name: 'Y', message: 'null time', __time: null },
      { name: 'Z', message: 'bogus time', __time: 'nope' },
      { name: 'W', message: 'invalid date', __time: new Date(NaN) },
    ]),
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries.length, 4);
  for (const e of entries) assert.equal(e.time, null, 'null-safe time for ' + e.name);
});

test('REQ-09: no channel -> #chat-text-area fallback parsed per line', () => {
  const dom = makeDom('<div id="chat-text-area">Flamamex: adori\nOtto: hello there</div>');
  const entries = getRecentMessages({ document: dom.window.document });
  assert.deepEqual(entries, [
    { name: 'Flamamex', message: 'adori', time: null, type: null, source: 'dom' },
    { name: 'Otto', message: 'hello there', time: null, type: null, source: 'dom' },
  ]);
});

test('REQ-09: DOM fallback is re-queried per read (chat is rebuilt wholesale)', () => {
  const dom = makeDom('<div id="chat-text-area">Flamamex: adori</div>');
  const doc = dom.window.document;
  assert.equal(getRecentMessages({ document: doc }).length, 1);
  doc.querySelector('#chat-text-area').textContent = 'Flamamex: exura\nFlamamex: utamo';
  const entries = getRecentMessages({ document: doc });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].message, 'utamo');
});

test('chat fallback: line without "name:" prefix -> name null, raw message kept', () => {
  const dom = makeDom('<div id="chat-text-area">  \njust some system text\n</div>');
  const entries = getRecentMessages({ document: dom.window.document });
  assert.deepEqual(entries, [{ name: null, message: 'just some system text', time: null, type: null, source: 'dom' }]);
});

test('chat: getChannel not a function -> DOM fallback', () => {
  const dom = makeDom('<div id="chat-text-area">Flamamex: adori</div>');
  const ctx = {
    gameClient: { interface: { channelManager: { getChannel: 'nope' } } },
    document: dom.window.document,
  };
  const entries = getRecentMessages(ctx);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'dom');
});

test('chat: neither channel nor #chat-text-area -> empty list', () => {
  assert.deepEqual(getRecentMessages({}), []);
  assert.deepEqual(getRecentMessages({ document: makeDom().window.document }), []);
});
