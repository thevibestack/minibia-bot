'use strict';

/**
 * Magic training module (REQ-16, design "Training" row) — the TRAINER module:
 * REQ-16 training casts PLUS the strict rune CAP with fallback (REQ-30, D3).
 *
 * Optional, user-activated. Repeats casts of the configured training spell at
 * the safe cadence imposed by the Action Queue + jitter (REQ-12/16 — one cast
 * per queue slot, never faster). Gates (in evaluation order):
 *   0. Strict rune CAP (REQ-30, design D3): when the RUNES cap config says
 *      `capMode:'strict'` and the live-probed capacity/maxCapacity ratio
 *      (adapters/gameClient.readCap) reaches `capFullThreshold` (1.0 =
 *      100%), rune-making STOPS: the trainer casts the configured fallback
 *      spell (slot) when `mana >= fallbackManaPct * maxMana`, otherwise it
 *      IDLES until mana recovers. Cap data absent => no cap enforcement
 *      (feature-detect degrade, never an invented ratio). `state.capFull`
 *      flows into the snapshot so the panel raises the ALERT + beep (D3).
 *   1. Vocation gate: live-probed `hotbarManager.__canPlayerCastSpell(sid)`
 *      (obs 10320). Feature-absent (null) => gate skipped, never blocks.
 *   2. Mana feasibility: cost resolved from the client (spellbook first, then
 *      the live-probed `interface.getSpell(sid)` — obs 10320: spellbook is
 *      empty). Unknown cost => pause ('no-cost', safe). Below cost+reserve =>
 *      pause until mana recovers (REQ-16/31). When eat-with-magic is
 *      configured (REQ-32, D4) the trainer enqueues the magic-food slot
 *      instead of waiting; when disabled it waits.
 *   3. Cooldowns: per-spell + GLOBAL_COOLDOWN via core/cooldown.
 * Echo validation is deliberately NOT applied to training casts (REQ-16: echo
 * "MAY be disabled for training" — disabled here; the __handleClick path
 * produces no echo anyway).
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 * Training casts advance the every-N-casts food cadence (ctx.castsSinceFood)
 * so the eat module counts them like combat casts.
 */

const FEAS_MOD = require('../../core/feasibility');
const CD_MOD = require('../../core/cooldown');
const FIRING_MOD = require('../../adapters/firing');

/**
 * Create the training decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized training config
 *   { on: boolean, slot: number|null, sid: number|null, reserve: number,
 *     eatWithMagic: {enabled, slot, sid} }
 * @param {object|null} [opts.capConfig] - the RUNES module's cap settings
 *   (D3, REQ-30): { capMode: 'strict'|'off', capFullThreshold: number,
 *     fallbackSlot: number|null, fallbackManaPct: number } — the trainer
 *     absorbs the strict-CAP concern (fallbackSid was DROPPED post-chain:
 *     the fallback is slot-driven only, obs 10502)
 * @param {() => {capacity: number|null, maxCapacity: number|null,
 *   ratio: number|null}|null} [opts.readCap] - live cap reader
 *   (adapters/gameClient.readCap); null/ratio null = cap data absent (no
 *   enforcement)
 * @param {(sid: number|null) => number|null} [opts.getSpellCost] - cost
 *   resolver; null = unknown (pause)
 * @param {(sid: number|null) => boolean|null} [opts.canCastSpell] - live
 *   vocation gate; null = feature absent (skipped)
 * @param {(sid: number|null) => {cooldown: object|null, globalCooldown: object|null}}
 *   [opts.readCooldown] - client cooldown reader
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number,
 *     kind?: 'training'|'fallback'|'eat-magic'},
 *   fire: (decision: object, deps: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createTraining(opts = {}) {
  const { config, capConfig = null, readCap = null, getSpellCost = null, canCastSpell = null, readCooldown = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  const state = { lastFiredAt: 0, lastReason: null, capFull: false, cap: null };

  /** Client cooldown verdict for a spell (per-spell + GLOBAL_COOLDOWN). */
  function cooldownVerdict(sid) {
    if (typeof readCooldown !== 'function') return { fire: true };
    const cd = readCooldown(sid) || {};
    return CD_MOD.canFire({
      cooldown: cd.cooldown,
      globalCooldown: cd.globalCooldown,
      cooldownMs: 0,
      lastFiredAt: null,
      now: now(),
      onGapLog: null,
    });
  }

  /**
   * Strict rune CAP evaluation (REQ-30, design D3). Cap data absent (no
   * capConfig / capMode not 'strict' / readCap absent / ratio null) => NOT
   * full — never block on unknown. Full => the fallback cast when configured
   * AND mana >= fallbackManaPct * maxMana, else idle.
   * @param {object} ctx - tick context { mana, maxMana }
   * @returns {{full: boolean, decision?: {fire: boolean, reason: string, slot?: number, kind?: string}}}
   */
  function evaluateCap(ctx) {
    const cc = capConfig && typeof capConfig === 'object' ? capConfig : {};
    state.cap = null;
    if (cc.capMode !== 'strict') return { full: false };
    let cap = null;
    if (typeof readCap === 'function') {
      try { cap = readCap(); } catch (e) { warn('training: cap read failed: ' + (e && e.message ? e.message : e)); cap = null; }
    }
    state.cap = cap && typeof cap === 'object' ? cap : null;
    const ratio = state.cap ? state.cap.ratio : null;
    if (ratio === null || !Number.isFinite(ratio)) return { full: false }; // degrade
    const threshold = Number(cc.capFullThreshold);
    const capFull = Number.isFinite(threshold) ? ratio >= threshold : ratio >= 1;
    if (!capFull) return { full: false };

    // Cap full: fallback slot cast when the fallback is AFFORDABLE — its REAL
    // spell cost (resolved from the slot via getSpellCost) + reserve must be
    // covered by the current mana (FEAS_MOD.canCast, the same pattern the
    // training cast uses). When the cost cannot be resolved (slot mapping
    // absent) the v1 %-of-maxMana behavior stands — degrade safe (REQ-30).
    const fallbackSlot = Number(cc.fallbackSlot);
    const pct = Number(cc.fallbackManaPct);
    const manaKnown = ctx.mana !== null && ctx.mana !== undefined
      && Number.isFinite(ctx.maxMana) && ctx.maxMana > 0;
    let manaOk = Number.isFinite(pct) && manaKnown && ctx.mana >= pct * ctx.maxMana;
    if (manaKnown && Number.isInteger(fallbackSlot) && fallbackSlot >= 1 && fallbackSlot <= 12
      && typeof getSpellCost === 'function') {
      let fallbackCost = null;
      try { fallbackCost = getSpellCost(fallbackSlot); } catch (e) { fallbackCost = null; }
      if (fallbackCost !== null && fallbackCost !== undefined
        && Number.isFinite(Number(fallbackCost)) && Number(fallbackCost) >= 0) {
        const feas = FEAS_MOD.canCast({
          mana: ctx.mana,
          cost: Number(fallbackCost),
          reserve: Number(config.reserve) || 0,
          maxMana: ctx.maxMana,
          key: 'training-fallback-' + fallbackSlot,
          warned,
          onWarn: warn,
        });
        manaOk = feas.fire;
      }
    }
    if (Number.isInteger(fallbackSlot) && fallbackSlot >= 1 && fallbackSlot <= 12 && manaOk) {
      // Honest cooldown verdict for the fallback (fallbackSid dropped, obs
      // 10502): the fallback fires SLOT-driven and never carried a resolvable
      // sid, so there is NO per-spell cooldown check — null sid yields the
      // v1 no-cooldown verdict. GLOBAL_COOLDOWN still gates (readCooldown
      // carries it), and the queue's min-interval throttle + jitter hold at
      // drain — the fallback never bypasses pacing.
      const cd = cooldownVerdict(null);
      if (!cd.fire) {
        const reason = cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown';
        state.lastReason = reason;
        return { full: true, decision: { fire: false, reason } };
      }
      state.lastReason = 'cap-full-fallback';
      return { full: true, decision: { fire: true, kind: 'fallback', slot: fallbackSlot, reason: 'cap-full-fallback' } };
    }
    state.lastReason = 'cap-full-idle';
    return { full: true, decision: { fire: false, reason: 'cap-full-idle' } };
  }

  /**
   * Pure decision (REQ-16/30/32): cast while the vocation gate passes and
   * mana feasibility holds; pause below cost+reserve; strict-CAP stops
   * rune-making with the fallback/idle split; eat-with-magic recovers mana.
   * @param {object} ctx - tick context { mana, maxMana }
   * @returns {{fire: boolean, reason: string, slot?: number, kind?: string}}
   */
  function decide(ctx = {}) {
    state.lastReason = null;
    state.capFull = false; // recomputed below — never stale across ticks
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const slot = Number(config.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return { fire: false, reason: 'no-slot' };

    // Vocation gate (live-probed hotbarManager.__canPlayerCastSpell).
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(config.sid) === false) return { fire: false, reason: 'vocation-gate' };
      } catch (e) {
        warn('training: vocation gate read failed — gate skipped: ' + (e && e.message ? e.message : e));
      }
    }

    // REQ-30 (D3): strict rune CAP stops rune-making at the cap threshold —
    // the fallback spell casts when mana allows, otherwise the trainer idles.
    const cap = evaluateCap(ctx);
    if (cap.full) {
      state.capFull = true;
      return cap.decision;
    }

    // Mana feasibility: pause below cost+reserve (REQ-16, REQ-31/D2).
    const cost = typeof getSpellCost === 'function' ? getSpellCost(config.sid) : null;
    if (cost === null) return { fire: false, reason: 'no-cost' };
    const feas = FEAS_MOD.canCast({
      mana: ctx.mana,
      cost,
      reserve: Number(config.reserve) || 0,
      maxMana: ctx.maxMana,
      key: 'training-' + slot,
      warned,
      onWarn: warn,
    });
    if (!feas.fire) {
      // REQ-32 (D4): eat-with-magic — when mana is low and configured, an
      // eat action (magic-food slot) enqueues INSTEAD of casting; the trainer
      // waits when disabled. Never triggers on unknown cost (no-cost above).
      const ew = config.eatWithMagic && typeof config.eatWithMagic === 'object' ? config.eatWithMagic : {};
      const eatSlot = Number(ew.slot);
      if (ew.enabled === true && Number.isInteger(eatSlot) && eatSlot >= 1 && eatSlot <= 12) {
        const cd = cooldownVerdict(ew.sid === null || ew.sid === undefined ? null : Number(ew.sid));
        if (!cd.fire) {
          return { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
        }
        state.lastReason = 'eat-magic';
        return { fire: true, kind: 'eat-magic', slot: eatSlot, reason: 'eat-magic' };
      }
      return { fire: false, reason: feas.reason === 'reserve' ? 'reserve' : 'insufficient' };
    }

    const cd = cooldownVerdict(config.sid);
    if (!cd.fire) {
      return { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
    }

    state.lastReason = 'train';
    return { fire: true, kind: 'training', reason: 'train', slot };
  }

  /**
   * Execute the training cast (QUEUE-DISPATCHED ONLY, REQ-12). Fires the
   * decided slot — the training spell, the fallback spell, or the magic-food
   * slot for eat-with-magic (D4) — through the proven firing adapter.
   * @param {{slot: number}} decision - decided slot
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    state.lastFiredAt = now();
    return FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
  }

  /** @returns {object} module state (surface/getState visibility) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      lastFiredAt: state.lastFiredAt,
      lastReason: state.lastReason,
      // REQ-30 (D3): capFull flows to the snapshot -> panel ALERT + beep.
      capFull: Boolean(state.capFull),
      cap: state.cap ? {
        capacity: state.cap.capacity,
        maxCapacity: state.cap.maxCapacity,
        ratio: state.cap.ratio,
        source: state.cap.source,
      } : null,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createTraining };
