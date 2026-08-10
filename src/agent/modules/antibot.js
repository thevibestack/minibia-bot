'use strict';

/**
 * Anti-bot watcher module (REQ-33/34, design D9, tasks 5.1/5.2).
 *
 * Watches the SAME Default-channel poll as echo validation and word learning
 * (REQ-24 MODIFIED shared surface — src/adapters/chat.js) plus the live
 * player context, and raises ALERTS + drives confirm-once chat responses:
 *
 *   1. Alerts (REQ-33): on every observe() the module reads the Default
 *      channel and the player context and detects:
 *      - speak: an entry from another speaker (name != player.name) with a
 *        non-empty message. The raw entry may carry the game's speak `type`
 *        (feature-detect): when a type is present only 0/2 count as speak;
 *        when absent the message counts (degrade-open, never blocks).
 *      - moved: the player's `__position` changed between polls, or the
 *        `__teleported` flag rose (feature-detect; steady state is silent).
 *      - attacked: `health` dropped between polls, or `__damageTint` rose
 *        (feature-detect; each event alerts once — edge-driven, no spam).
 *      Every event pushes a bounded alert {id, kind, message, at} the panel
 *      renders (and rings its beep once per NEW alert id, D3 alert path).
 *
 *   2. Confirm-once (REQ-34): configured `antibot.replies = [{pattern,
 *      reply}]` — on the FIRST occurrence of a pattern this session the
 *      module raises a PENDING CONFIRM (the panel shows the prompt); after
 *      the user confirms (panel -> POST /api/antibot-confirm -> confirmAntibot
 *      RPC) the pattern becomes session-confirmed and LATER occurrences
 *      auto-reply. Session-scoped: the confirmed set + pending queue live in
 *      the injected `timers` (bootstrap state.timers) — they survive config
 *      rebuilds and reset on agent restart.
 *
 * Auto-reply fires ONLY inside a queue-dispatched closure (REQ-12 no-bypass)
 * and ONLY through the feature-detected Default-channel send surface (the
 * open probe): when no send surface exists the module degrades to ALERT-ONLY
 * and reports `sendAvailable:false` honestly — it never invents a send path.
 */

const CHAT_MOD = require('../../adapters/chat');

const ALERTS_CAP = 20;
const PENDING_CAP = 3;
const SEEN_KEYS_CAP = 500;

/**
 * Create the anti-bot watcher module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized antibot config
 *   { on: boolean, replies: Array<{pattern: string, reply: string}> }
 * @param {() => string|null} [opts.playerName] - current player name accessor
 * @param {object|null} [opts.gameClient] - page gameClient (chat reads)
 * @param {Document|null} [opts.document] - page DOM (chat DOM fallback)
 * @param {() => {position: {x,y,z}|null, teleported: boolean|null,
 *   health: number|null, damageTint: boolean|null}} [opts.readContext] -
 *   live player-context reader (feature-detected fields)
 * @param {() => {send: Function, label: string}|null} [opts.readSend] -
 *   feature-detected Default-channel send surface; null = alert-only degrade
 * @param {object} [opts.timers] - session-scoped state (bootstrap state.timers):
 *   { antibotConfirmed: Array<string>, antibotPendingQueue: Array<{pattern, at}> }
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function, info?: Function}} [opts.log]
 * @returns {{
 *   observe: () => {alerts: Array<object>},
 *   confirm: (pattern: string) => {ok: boolean, reason?: string, ...},
 *   decide: () => {fire: boolean, reason: string, pattern?: string, text?: string},
 *   fire: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createAntibotModule(opts = {}) {
  const {
    config,
    playerName = () => null,
    gameClient = null,
    document: doc = null,
    readContext = null,
    readSend = null,
    timers = {},
    now = Date.now,
    log = {},
  } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const info = typeof log.info === 'function' ? log.info : () => {};

  // Session-scoped confirm-once state (REQ-34): lives in the injected timers
  // (bootstrap state.timers) — survives rebuilds, resets on agent restart.
  if (!Array.isArray(timers.antibotConfirmed)) timers.antibotConfirmed = [];
  if (!Array.isArray(timers.antibotPendingQueue)) timers.antibotPendingQueue = [];

  const state = {
    seq: 0,
    alerts: [],
    counters: { speaks: 0, moves: 0, attacks: 0 },
    pendingReplies: [],       // auto-replies ready to fire (decide -> queue)
    sendAvailable: null,      // null = not probed yet; false = alert-only
    sendReason: null,
    lastChatWatermark: -1,  // -1: a legit __time 0 entry still counts as new
    seenChatKeys: new Set(),
    lastPosition: null,
    lastTeleported: false,
    lastHealth: null,
    lastDamageTint: false,
  };

  /** Push a bounded alert with a monotonic id (the panel beeps per new id). */
  function pushAlert(kind, message) {
    state.seq += 1;
    state.alerts.push({ id: state.seq, kind, message, at: now() });
    if (state.alerts.length > ALERTS_CAP) state.alerts.shift();
  }

  /** Proven matcher style (echo/learning): plain string or /regex/ form. */
  function matchesPattern(pattern, message) {
    const p = String(pattern || '').trim();
    if (!p) return false;
    const m = p.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]).test(message); } catch (e) { return false; }
    }
    return message === p;
  }

  /** Speak event? Another speaker (name != player) with a non-empty message;
   *  typed entries (raw `type` present) count ONLY types 0/2 (REQ-33). */
  function isSpeakEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const name = entry.name;
    if (name === null || name === undefined || name === '') return false;
    if (String(name) === String(playerName() || '')) return false;
    const msg = String(entry.message || '').trim();
    if (!msg) return false;
    const t = entry.type;
    if (t !== null && t !== undefined && t !== 0 && t !== 2) return false;
    return true;
  }

  /**
   * Speak handling: dedupe (time watermark, bounded identity-set fallback),
   * alert once per message, then run the confirm-once pattern matcher.
   * @param {Array<object>} entries - normalized Default-channel entries
   */
  function observeChat(entries) {
    for (const entry of entries) {
      if (!isSpeakEntry(entry)) continue;
      const msg = String(entry.message || '').trim();
      const t = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null;
      if (t !== null) {
        if (t <= state.lastChatWatermark) continue; // already observed
        state.lastChatWatermark = t;
      } else {
        const key = 's|' + entry.name + '|' + msg;
        if (state.seenChatKeys.has(key)) continue;
        if (state.seenChatKeys.size >= SEEN_KEYS_CAP) state.seenChatKeys.clear(); // bounded
        state.seenChatKeys.add(key);
      }
      state.counters.speaks += 1;
      const short = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
      pushAlert('speak', String(entry.name) + ' speaks: "' + short + '"');
      handlePatterns(msg);
    }
  }

  /**
   * Confirm-once (REQ-34): first occurrence of a configured pattern this
   * session -> pending confirm; later occurrences while pending stay pending;
   * CONFIRMED patterns queue an auto-reply (feature-detected send; when the
   * send surface is absent the module degrades to ALERT-ONLY and says so).
   * @param {string} msg - the speak message to match patterns against
   */
  function handlePatterns(msg) {
    const replies = config && Array.isArray(config.replies) ? config.replies : [];
    for (const r of replies) {
      if (!r || typeof r !== 'object') continue;
      const pattern = String(r.pattern || '').trim();
      const reply = String(r.reply || '').trim();
      if (!pattern || !reply) continue;
      if (!matchesPattern(pattern, msg)) continue;
      if (timers.antibotConfirmed.indexOf(pattern) !== -1) {
        // Session-confirmed: auto-reply through the feature-detected send.
        const send = typeof readSend === 'function' ? readSend() : null;
        if (send && typeof send.send === 'function') {
          state.sendAvailable = true;
          state.sendReason = null;
          state.pendingReplies.push({ pattern, text: reply, at: now() });
        } else {
          state.sendAvailable = false;
          state.sendReason = 'no Default-channel send surface — alert only';
          warn('antibot: ' + state.sendReason + ' (REQ-34)');
        }
        continue;
      }
      // First occurrence this session: pending confirm once per pattern.
      if (timers.antibotPendingQueue.some((p) => p.pattern === pattern)) continue;
      if (timers.antibotPendingQueue.length >= PENDING_CAP) continue; // bounded
      timers.antibotPendingQueue.push({ pattern, at: now() });
      warn('antibot: pattern "' + pattern + '" first seen — confirmation pending (REQ-34)');
    }
  }

  /**
   * Move/attack detection (REQ-33): edge-driven on the live player context —
   * position delta / teleported rising edge => moved; health drop / damage
   * tint rising edge => attacked. Steady state never re-alerts.
   */
  function observeContext() {
    let ctx = null;
    if (typeof readContext === 'function') {
      try { ctx = readContext(); } catch (e) { ctx = null; }
    }
    if (!ctx || typeof ctx !== 'object') return;

    const pos = ctx.position;
    if (pos && typeof pos === 'object'
      && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
      const key = Number(pos.x) + ',' + Number(pos.y) + ',' + Number(pos.z);
      if (state.lastPosition === null) {
        state.lastPosition = key; // first read = baseline, never an event
      } else if (state.lastPosition !== key) {
        state.lastPosition = key;
        state.counters.moves += 1;
        pushAlert('moved', 'player moved to (' + Number(pos.x) + ', ' + Number(pos.y) + ')');
      }
    }
    if (ctx.teleported === true && state.lastTeleported !== true) {
      state.lastTeleported = true;
      state.counters.moves += 1;
      pushAlert('moved', 'player teleported');
    } else if (ctx.teleported !== true) {
      state.lastTeleported = false; // falling edge re-arms the detector
    }
    const health = Number.isFinite(Number(ctx.health)) ? Number(ctx.health) : null;
    if (health !== null) {
      if (state.lastHealth !== null && health < state.lastHealth) {
        state.counters.attacks += 1;
        pushAlert('attacked', 'player attacked — health dropped to ' + health);
      }
      state.lastHealth = health;
    }
    if (ctx.damageTint === true && state.lastDamageTint !== true) {
      state.lastDamageTint = true;
      state.counters.attacks += 1;
      pushAlert('attacked', 'player under attack (damage tint)');
    } else if (ctx.damageTint !== true) {
      state.lastDamageTint = false;
    }
  }

  /**
   * Per-tick watcher (bootstrap tickOnce, pre-tree read-only section): reads
   * the SAME Default-channel surface as echo/learning (REQ-24 MODIFIED) +
   * the player context. No-op while the module is OFF.
   * @returns {{alerts: Array<object>}} the current alert window
   */
  function observe() {
    if (!config || config.on !== true) return { alerts: [] };
    let entries = [];
    try {
      entries = CHAT_MOD.getRecentMessages({ gameClient: gameClient, document: doc });
    } catch (e) { entries = []; }
    observeChat(entries);
    observeContext();
    return { alerts: state.alerts.slice() };
  }

  /** Head of the pending-confirm FIFO, surfaced to the panel prompt. */
  function pendingConfirm() {
    if (timers.antibotPendingQueue.length === 0) return null;
    const head = timers.antibotPendingQueue[0];
    const replies = config && Array.isArray(config.replies) ? config.replies : [];
    const entry = replies.filter((r) => r && String(r.pattern || '').trim() === head.pattern)[0] || null;
    return {
      pattern: head.pattern,
      reply: entry ? String(entry.reply || '') : '',
      at: head.at,
    };
  }

  /**
   * Confirm a pattern (user action: panel prompt -> POST /api/antibot-confirm
   * -> confirmAntibot RPC). The pattern leaves the pending queue and becomes
   * session-confirmed: later occurrences auto-reply (REQ-34).
   * @param {string} pattern
   * @returns {{ok: boolean, reason?: string, pattern?: string, already?: boolean,
   *   confirmed?: Array<string>}}
   */
  function confirm(pattern) {
    const p = String(pattern || '').trim();
    if (!p) return { ok: false, reason: 'pattern required' };
    const idx = timers.antibotPendingQueue.findIndex((q) => q.pattern === p);
    if (idx === -1) {
      if (timers.antibotConfirmed.indexOf(p) !== -1) return { ok: true, already: true, pattern: p };
      return { ok: false, reason: 'no pending pattern' };
    }
    timers.antibotPendingQueue.splice(idx, 1);
    timers.antibotConfirmed.push(p);
    info('antibot: pattern "' + p + '" confirmed — auto-reply enabled (REQ-34)');
    return { ok: true, pattern: p, confirmed: timers.antibotConfirmed.slice() };
  }

  /**
   * Pure decision: a pending auto-reply -> fire. The reply send runs ONLY
   * inside a queue-dispatched closure (bootstrap antibotNode, REQ-12).
   * @returns {{fire: boolean, reason: string, pattern?: string, text?: string}}
   */
  function decide() {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    if (state.pendingReplies.length === 0) return { fire: false, reason: 'no-auto-reply' };
    const item = state.pendingReplies[0];
    return { fire: true, kind: 'auto-reply', pattern: item.pattern, text: item.text };
  }

  /**
   * Execute the auto-reply send (QUEUE-DISPATCHED ONLY, REQ-12). Degrade:
   * send surface absent => record the alert-only state, never invent a path.
   * @param {{text: string}} decision - decided auto-reply
   * @returns {boolean} true when the Default-channel send executed
   */
  function fire(decision = {}) {
    const send = typeof readSend === 'function' ? readSend() : null;
    if (!send || typeof send.send !== 'function') {
      state.sendAvailable = false;
      state.sendReason = 'no Default-channel send surface — alert only';
      return false;
    }
    state.pendingReplies.shift();
    try {
      send.send(String(decision.text || ''));
      return true;
    } catch (e) {
      warn('antibot: auto-reply send failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {object} module state (snapshot -> panel alerts/prompt/live) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      alerts: state.alerts.slice(),
      counters: Object.assign({}, state.counters),
      pendingConfirm: pendingConfirm(),
      pendingQueueCount: timers.antibotPendingQueue.length,
      confirmed: timers.antibotConfirmed.slice(),
      sendAvailable: state.sendAvailable,
      sendReason: state.sendReason,
      replyPendingCount: state.pendingReplies.length,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { observe, confirm, decide, fire, getState, isEnabled };
}

module.exports = { createAntibotModule, ALERTS_CAP, PENDING_CAP };
