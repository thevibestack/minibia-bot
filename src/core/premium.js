'use strict';

/**
 * Premium-gating detection (REQ-22, task 5.5).
 *
 * The game gates its native automations behind Premium ("Premium active — all
 * automation features unlocked", live inventory obs 10312). The desktop bot
 * mirrors that: gated modules (trade, loot, spawns, huntStats) read the
 * account's premium state at runtime and report a "Premium required" state in
 * the panel when the account explicitly lacks Premium; they stay disabled
 * then. The app MUST NOT hard-depend on any gated feature and MUST keep other
 * modules functional (REQ-22).
 *
 * Semantics of `active`:
 *   - true  — an explicit premium flag / active subscription field is present.
 *   - false — an explicit non-premium flag is present (module reports
 *             "Premium required" and never fires).
 *   - null  — NO premium field is exposed on the client (feature absent). The
 *             account may still have Premium (the field location is unprobed —
 *             tools/automations-probe.js dumps candidates). Per REQ-22
 *             "MUST NOT hard-depend", an unknown state NEVER blocks: the
 *             module proceeds with its normal degrade paths.
 *
 * Pure node-testable: `readPremiumState` takes a gameClient-shaped object and
 * an optional clock.
 */

/**
 * Coerce a "valid until" value (number epoch-ms | Date | numeric string) to
 * epoch ms. Returns null when unparseable.
 */
function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Feature-detect the account's premium state over the live-probed candidate
 * locations (obs 10312: the Hub shows the Premium banner; the exact client
 * field is an open probe — automations-probe 5.5 dumps the candidates).
 *
 * @param {object|null} gameClient - page gameClient
 * @param {() => number} [now=Date.now] - injectable clock (epoch ms)
 * @returns {{gated: true, active: boolean|null, source: string|null}}
 */
function readPremiumState(gameClient, now = Date.now) {
  if (!gameClient || typeof gameClient !== 'object') return { gated: true, active: null, source: null };
  const p = gameClient.player;
  const acct = gameClient.account;
  const intf = gameClient.interface;

  // Boolean flags first (explicit answer).
  const booleanCandidates = [
    ['player.premium', p && p.premium],
    ['player.state.premium', p && p.state && p.state.premium],
    ['player.vip', p && p.vip],
    ['account.premium', acct && acct.premium],
    ['gameClient.premium', gameClient.premium],
    ['interface.premium', intf && intf.premium],
  ];
  for (const [source, value] of booleanCandidates) {
    if (typeof value === 'boolean') return { gated: true, active: value, source };
  }

  // "Valid until" timestamps (premiumUntil / days-left numeric).
  const untilCandidates = [
    ['player.premiumUntil', p && p.premiumUntil],
    ['player.state.premiumUntil', p && p.state && p.state.premiumUntil],
    ['account.premiumUntil', acct && acct.premiumUntil],
    ['gameClient.premiumUntil', gameClient.premiumUntil],
  ];
  for (const [source, value] of untilCandidates) {
    const t = toEpochMs(value);
    if (t !== null) return { gated: true, active: t > now(), source };
  }

  // String status fields ("Premium active", "inactive", "active", "none").
  const stringCandidates = [
    ['player.premiumStatus', p && p.premiumStatus],
    ['account.subscription', acct && acct.subscription],
    ['gameClient.premiumStatus', gameClient.premiumStatus],
  ];
  for (const [source, value] of stringCandidates) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const s = value.trim().toLowerCase();
    let active = null;
    if (s.includes('premium')) {
      active = !(s.includes('no ') || s.startsWith('inactive') || s === 'inactive');
    } else if (/^(inactive|expired|none|no)/.test(s)) {
      active = false;
    } else if (/^(active|yes|enabled|true)/.test(s)) {
      active = true;
    }
    if (active !== null) return { gated: true, active, source };
  }

  // Feature absent: unknown. NEVER blocks (REQ-22 no hard dependency).
  return { gated: true, active: null, source: null };
}

/**
 * REQ-22 gate predicate: a gated module is blocked ONLY when the account
 * explicitly reports no Premium. Unknown state (null) is not blocked.
 * @param {{gated?: boolean, active?: boolean|null}} state
 * @returns {boolean}
 */
function isPremiumBlocked(state) {
  return Boolean(state && state.gated && state.active === false);
}

module.exports = { readPremiumState, isPremiumBlocked, toEpochMs };
