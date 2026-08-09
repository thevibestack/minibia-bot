'use strict';

/**
 * Unknown-word observation + registration offer tests (REQ-25, task 5.7):
 * the PROVEN core/dedupe.js mechanism carried into the agent. Same unknown
 * word >= 2x within 5 min -> offer; declined = session-silent; confirmed
 * words join the configured set (the store persistence path is tested in the
 * panel-server slice-5 suite).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLearningModule } = require('../../../src/agent/modules/learning');

function makeModule(overrides = {}) {
  const now = { t: 0 };
  let contents = overrides.contents !== undefined ? overrides.contents : [];
  const known = overrides.known || new Set();
  const mod = createLearningModule({
    config: { knownWords: Array.from(known) },
    playerName: () => overrides.playerName || 'Flamamex',
    configuredWords: () => known,
    gameClient: {
      interface: { channelManager: { getChannel: (name) => (name === 'Default' ? { __contents: contents } : null) } },
      player: { spellbook: { spells: { 24: { words: ['exura'] } } } },
    },
    document: null,
    now: () => now.t,
    log: {},
  });
  return {
    mod, now,
    setContents: (c) => { contents = c; },
    known,
  };
}

test('REQ-25: same unknown word seen twice within 5 minutes -> offer with word + ts + sid', () => {
  const { mod, now, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }]);
  mod.observeChat();
  assert.equal(mod.getState().offers.length, 0, 'first sighting is not an offer');
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 }]);
  now.t = 2;
  const offers = mod.observeChat();
  assert.equal(offers.length, 1, 'second sighting within the window -> offer');
  assert.equal(offers[0].word, 'exura');
  assert.equal(offers[0].ts, 2);
  assert.equal(offers[0].sid, 24, 'best-effort sid inferred from the spellbook');
  const st = mod.getState();
  assert.equal(st.offers.length, 1);
  assert.equal(st.offers[0].word, 'exura');
});

test('REQ-25: sightings further apart than 5 minutes never offer', () => {
  const { mod, now, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'utani', __time: 1 }]);
  mod.observeChat();
  setContents([{ name: 'Flamamex', message: 'utani', __time: 1 }, { name: 'Flamamex', message: 'utani', __time: 301_001 }]);
  now.t = 301_001;
  assert.equal(mod.observeChat().length, 0, 'window expired -> fresh window, still 1 sighting');
});

test('REQ-25: declined -> session-silent, no offer reappears this session', () => {
  const { mod, now, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }]);
  mod.observeChat();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 }]);
  now.t = 2;
  assert.equal(mod.observeChat().length, 1, 'offer fires');
  mod.decline('exura');
  assert.equal(mod.getState().offers.length, 0, 'declined offer leaves the list');
  // The word appears twice more -> no offer (session-silent).
  setContents([
    { name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 },
    { name: 'Flamamex', message: 'exura', __time: 3 }, { name: 'Flamamex', message: 'exura', __time: 4 },
  ]);
  now.t = 4;
  assert.equal(mod.observeChat().length, 0, 'silenced word never offers again (REQ-25)');
});

test('REQ-25: configured words are never offered (rotation/heal/training/knownWords)', () => {
  const { mod, setContents } = makeModule({ known: new Set(['exura']) });
  setContents([
    { name: 'Flamamex', message: 'exura', __time: 1 },
    { name: 'Flamamex', message: 'exura', __time: 2 },
  ]);
  assert.equal(mod.observeChat().length, 0, 'configured word ignored');
  assert.equal(mod.getState().offers.length, 0);
});

test('REQ-25: confirm marks the word known and drops its offers (store write happens on the server side)', () => {
  const { mod, now, setContents, known } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }]);
  mod.observeChat();
  setContents([{ name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 }]);
  now.t = 2;
  assert.equal(mod.observeChat().length, 1);
  mod.markKnown('exura');
  known.add('exura');
  assert.equal(mod.getState().offers.length, 0);
  setContents([
    { name: 'Flamamex', message: 'exura', __time: 1 }, { name: 'Flamamex', message: 'exura', __time: 2 },
    { name: 'Flamamex', message: 'exura', __time: 3 }, { name: 'Flamamex', message: 'exura', __time: 4 },
  ]);
  now.t = 4;
  assert.equal(mod.observeChat().length, 0, 'confirmed word is configured -> no further offers');
});

test('REQ-25: only the player\'s OWN messages are observed', () => {
  const { mod, setContents } = makeModule();
  setContents([
    { name: 'OtherGuy', message: 'exura', __time: 1 },
    { name: 'OtherGuy', message: 'exura', __time: 2 },
  ]);
  assert.equal(mod.observeChat().length, 0);
  assert.equal(mod.getState().offers.length, 0);
});

test('REQ-25: entries are observed ONCE (time watermark; re-reads never double-count)', () => {
  const { mod, now, setContents } = makeModule();
  const entries = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Flamamex', message: 'exura', __time: i + 1 }));
  setContents(entries(2));
  mod.observeChat();
  assert.equal(mod.getState().offers.length, 1, 'two sightings within one batch -> one offer');
  setContents(entries(2)); // same contents re-read
  now.t = 2;
  assert.equal(mod.observeChat().length, 0, 'watermark skip -> no double-count');
  setContents(entries(4)); // more sightings of the SAME word
  now.t = 4;
  assert.equal(mod.observeChat().length, 0, 'already offered -> pending, never re-offered (REQ-25)');
  assert.equal(mod.getState().offers.length, 1, 'a single offer total');
});

test('REQ-25: unknown-word entries without a time are deduped by a bounded key set', () => {
  const { mod, setContents } = makeModule();
  setContents([{ name: 'Flamamex', message: 'exura', __time: null }, { name: 'Flamamex', message: 'exura', __time: null }]);
  assert.equal(mod.observeChat().length, 0, 'identical untimed entries dedupe to one observation');
  assert.equal(mod.getState().offers.length, 0);
});
