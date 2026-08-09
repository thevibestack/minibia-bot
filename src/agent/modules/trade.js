'use strict';

/**
 * Auto trade broadcast module (REQ-18, design D6 "Trade" row, task 5.1).
 *
 * Ports the game's native Hub -> Automations "Auto Trade Broadcast": send a
 * configured message to the Trade channel every N minutes (default 3, mirror
 * the game). The send goes through the game's OWN channel mechanism
 * (channelManager) — feature-detected; never an invented protocol write.
 *
 * Session semantics (mirror the game): the toggle resets to OFF on session
 * end. The desktop mirror: the panel/agent NEVER persist `trade.on` — the
 * saved per-character config always carries `on:false` (server strips it
 * before saving; disconnect clears it). Within a session, the cadence anchor
 * (`timers.tradeLastSentAt`) lives in agent-owned state so config pushes do
 * not reset the 3-minute clock; a fresh session (agent restart) restarts it —
 * exactly like the game's logout reset.
 *
 * Degrade (unprobed send API): when the game's channel/send surface is
 * absent, the module records "no native trade channel" in its state (panel
 * sees it) and NEVER sends — no invented fallback.
 *
 * Premium gate (REQ-22): the game's trade automation is premium-gated; when
 * the account explicitly lacks Premium the module reports "Premium required"
 * and never sends. Unknown premium state never blocks.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

/**
 * Create the trade broadcast module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized trade config
 *   { on: boolean, message: string, intervalMs: number }
 * @param {object} [opts.timers] - shared session timers
 *   { tradeLastSentAt: number } (agent-owned; survives config rebuilds)
 * @param {() => {send: Function, label: string}|null} [opts.readChannel] -
 *   feature-detected Trade-channel send accessor; null = unavailable
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, message?: string},
 *   fire: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createTradeModule(opts = {}) {
  const { config, timers = null, readChannel = null, readPremium = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  const state = { available: true, reason: 'ok' };

  /** Eager premium read (REQ-22): the panel-facing state is computed on
   *  getState — fresh regardless of whether the tree reached this module. */
  function currentPremium() {
    const p = typeof readPremium === 'function' ? readPremium() : null;
    return {
      gated: p ? p.gated : true,
      active: p ? p.active : null,
      blocked: Boolean(p && p.active === false),
    };
  }

  /**
   * Pure decision (REQ-18): ON + message configured + interval elapsed since
   * the last send (default 3 minutes, mirror the game).
   * @param {object} ctx - tick context (unused; cadence lives in timers)
   * @returns {{fire: boolean, reason: string, message?: string}}
   */
  function decide() {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const premium = currentPremium();
    if (premium.blocked) {
      state.reason = 'premium-required';
      return { fire: false, reason: 'premium-required' };
    }
    const message = String(config.message || '').trim();
    if (!message) return { fire: false, reason: 'no-message' };
    const intervalMs = Number(config.intervalMs) > 0 ? Number(config.intervalMs) : 180000; // 3 min default
    const lastSentAt = timers ? Number(timers.tradeLastSentAt) || 0 : 0;
    if (now() - lastSentAt < intervalMs) return { fire: false, reason: 'cooldown' };
    state.reason = 'ok';
    return { fire: true, reason: 'due', message };
  }

  /**
   * Execute the Trade-channel send (QUEUE-DISPATCHED ONLY, REQ-12). The real
   * send happens ONLY through the game's own channel mechanism (REQ-06
   * handler boundary). Degrade: surface absent => record + no-op, never send.
   * @param {{message: string}} decision - decided broadcast
   * @returns {boolean} true when the channel send executed
   */
  function fire(decision = {}) {
    const channel = typeof readChannel === 'function' ? readChannel() : null;
    if (!channel || typeof channel.send !== 'function') {
      state.available = false;
      state.reason = 'no native trade channel';
      error('trade: no native Trade-channel send surface — broadcast skipped (degrade)');
      return false;
    }
    state.available = true;
    state.reason = 'ok';
    if (timers) timers.tradeLastSentAt = now();
    try {
      channel.send(decision.message);
      return true;
    } catch (e) {
      error('trade: channel send failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      available: config && config.on === true ? state.available : false,
      reason: config && config.on === true ? state.reason : 'off',
      message: String((config && config.message) || ''),
      intervalMs: Number(config && config.intervalMs) > 0 ? Number(config.intervalMs) : 180000,
      lastSentAt: timers ? Number(timers.tradeLastSentAt) || 0 : 0,
      premium: currentPremium(),
    };
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createTradeModule };
