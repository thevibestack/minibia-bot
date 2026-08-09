'use strict';

/**
 * Unknown-word observation + registration offer (REQ-25, design "Learning"
 * row, task 5.7).
 *
 * Carries the PROVEN userscript REQ-15 mechanism (src/core/dedupe.js +
 * src/adapters/chat.js Default-channel reads, build-userscript.js
 * observeUnknownWords/configuredWords/inferSid) into the agent, adapted to
 * the desktop panel:
 *
 *   - Observe the Default channel for name === player.name messages matching
 *     NO configured word (rotation spell words + healMagic/training words +
 *     previously registered words). Entries are observed ONCE via the time
 *     watermark (bounded identity-set fallback for entries without a time),
 *     exactly like the userscript.
 *   - The SAME unknown word seen >= 2x within 5 minutes (core/dedupe) ->
 *     a registration OFFER {word, ts, sid} surfaces in the panel through the
 *     module state (snapshot) — never written to config without the user.
 *   - Confirm (panel button -> server -> config push): the word appends to
 *     `learning.knownWords` in the per-character config and persists via the
 *     REQ-09 store; the rebuilt module treats it as configured.
 *   - Decline (panel button -> server -> respondOffer RPC): the word becomes
 *     session-silent (core/dedupe.decline) — no offer reappears this session.
 *
 * Observation always runs while the agent is armed (REQ-25 MUST observe);
 * the module has no toggle. `learning.knownWords` is the only persisted part.
 */

const DEDUPE_MOD = require('../../core/dedupe');
const CHAT_MOD = require('../../adapters/chat');

const SEEN_KEYS_CAP = 500;

/**
 * Create the learning module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized learning config
 *   { knownWords: Array<string> }
 * @param {() => string|null} [opts.playerName] - current player name accessor
 * @param {() => Set<string>} [opts.configuredWords] - words considered
 *   configured (rotation + healMagic + training + knownWords)
 * @param {object|null} [opts.gameClient] - page gameClient (chat + sid infer)
 * @param {Document|null} [opts.document] - page DOM (chat DOM fallback)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   observeChat: () => Array<{word: string, ts: number, sid: number|null}>,
 *   decline: (word: string) => void,
 *   markKnown: (word: string) => void,
 *   getState: () => object,
 * }}
 */
function createLearningModule(opts = {}) {
  const {
    config,
    playerName = () => null,
    configuredWords = () => new Set(),
    gameClient = null,
    document: doc = null,
    now = Date.now,
    log = {},
  } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { offers: [], chatWatermark: 0, seenChatKeys: new Set() };
  const dedupe = DEDUPE_MOD.createDedupe({ windowMs: DEDUPE_MOD.DEFAULT_WINDOW_MS, known: configuredWords() });

  /** Best-effort spell id for an observed word (spellbook entries; the live
   *  spellbook is empty per obs 10320 — inference returns null, REQ-25
   *  "best-effort sid"). */
  function inferSid(word) {
    try {
      const sb = gameClient && gameClient.player && gameClient.player.spellbook;
      const spells = sb && sb.spells;
      if (!spells) return null;
      const keys = Object.keys(spells);
      for (let i = 0; i < keys.length; i += 1) {
        const entry = spells[keys[i]] || {};
        const raw = entry.words || entry.word || entry.runeSpellName || null;
        if (typeof raw === 'string' && raw.trim() === word) return Number(keys[i]) || null;
        if (Array.isArray(raw) && raw.indexOf(word) !== -1) return Number(keys[i]) || null;
      }
    } catch (e) { /* inference is best-effort */ }
    return null;
  }

  /**
   * Per-tick observation of the Default channel (REQ-25). Entries are
   * observed once (time watermark; bounded identity set fallback). New
   * offers append to the module state for the panel to render.
   * @returns {Array<{word: string, ts: number, sid: number|null}>} new offers
   */
  function observeChat() {
    const newOffers = [];
    if (!configuredWords) return newOffers;
    let entries = [];
    try {
      entries = CHAT_MOD.getRecentMessages({ gameClient: gameClient, document: doc });
    } catch (e) { return newOffers; }
    for (const entry of entries) {
      if (!entry || entry.name !== playerName()) continue;
      const msg = String(entry.message || '').trim();
      if (!msg) continue;
      const t = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null;
      if (t !== null) {
        if (t <= state.chatWatermark) continue; // already observed
        state.chatWatermark = t;
      } else {
        const key = 'c|' + entry.name + '|' + msg;
        if (state.seenChatKeys.has(key)) continue;
        if (state.seenChatKeys.size >= SEEN_KEYS_CAP) state.seenChatKeys.clear(); // bounded
        state.seenChatKeys.add(key);
      }
      const outcome = dedupe.observe(msg, t !== null ? t : now());
      if (outcome === 'offer') {
        const offer = { word: msg, ts: t !== null ? t : now(), sid: inferSid(msg) };
        state.offers.push(offer);
        if (state.offers.length > 20) state.offers.shift();
        newOffers.push(offer);
        warn('unknown word "' + msg + '" seen twice in 5 min — registration offered (REQ-25)');
      }
    }
    return newOffers;
  }

  /** Decline an offer: session-silent for the word (REQ-25). */
  function decline(word) {
    const w = String(word || '').trim();
    if (!w) return;
    dedupe.decline(w);
    state.offers = state.offers.filter((o) => o.word !== w);
  }

  /** Mark a word configured (confirm path; the rebuild also refreshes known). */
  function markKnown(word) {
    const w = String(word || '').trim();
    if (!w) return;
    dedupe.markKnown(w);
    state.offers = state.offers.filter((o) => o.word !== w);
  }

  /** @returns {object} module state (snapshot -> panel live state + offers) */
  function getState() {
    return {
      on: true, // observation always runs while armed (REQ-25 MUST)
      offers: state.offers.map((o) => ({ word: o.word, ts: o.ts, sid: o.sid })),
      knownWords: Array.from(configuredWords()).sort(),
      silencedCount: 0,
    };
  }

  return { observeChat, decline, markKnown, getState };
}

module.exports = { createLearningModule, SEEN_KEYS_CAP };
