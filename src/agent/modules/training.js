'use strict';

/**
 * MiniTibia Trainer runtime.
 *
 * A native hotbar handler is only an attempt, never a successful game action.
 * This module therefore holds the loop in explicit confirmation states:
 * mana loss confirms spells, a first-20-slot delta confirms food creation, and
 * a subsequent slot delta confirms consumption. Any missing signal stops the
 * loop safely instead of repeating casts against stale client state.
 */

const FEAS_MOD = require('../../core/feasibility');
const CD_MOD = require('../../core/cooldown');
const FIRING_MOD = require('../../adapters/firing');
const ITEMS_MOD = require('../../core/items');

function createTraining(opts = {}) {
  const {
    config, capConfig = null, readCap = null, getSpellCost = null,
    canCastSpell = null, readCooldown = null, readHotbarSlotSid = null,
    now = Date.now, log = {}, readVisibleSlots = null, consumeItem = null,
    foodArrivalTimeoutMs = 4000, actionConfirmationTimeoutMs = 2500,
    // PR 3 (REQ-01): the food-magic config is INJECTED from the unified
    // modules.eat.magic — the machine never reads config.eatWithMagic.
    foodMagicConfig = null,
  } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();
  const state = {
    lastFiredAt: 0, lastReason: null, capFull: false, cap: null,
    successfulRuneCreations: 0, foodMagicPending: false,
    foodCycle: 'idle', foodBaseline: null, foodDeadlineAt: null,
    requiredMana: null, waitingForMana: false,
    pendingAction: null, createdFood: null, blockedReason: null,
  };

  function cooldownVerdict(sid) {
    if (typeof readCooldown !== 'function') return { fire: true };
    const cd = readCooldown(sid) || {};
    return CD_MOD.canFire({ cooldown: cd.cooldown, globalCooldown: cd.globalCooldown,
      cooldownMs: 0, lastFiredAt: null, now: now(), onGapLog: null });
  }

  function currentVisibleSlots() {
    if (typeof readVisibleSlots !== 'function') return [];
    try {
      const slots = readVisibleSlots();
      return Array.isArray(slots) ? slots.slice(0, 20) : [];
    } catch (e) {
      warn('training: visible inventory read failed: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  function stopSafely(reason) {
    state.pendingAction = null;
    state.foodMagicPending = false;
    state.foodBaseline = null;
    state.foodDeadlineAt = null;
    state.createdFood = null;
    state.foodCycle = 'blocked';
    state.blockedReason = reason;
    state.lastReason = reason;
    return { fire: false, reason };
  }

  function manaSpent(pending, mana) {
    const observed = Number(mana);
    return Number.isFinite(observed) && Number.isFinite(pending.manaBefore)
      && observed <= pending.manaBefore - pending.cost;
  }

  /** Resolve a pending native action from a later live game snapshot. */
  function confirmPending(ctx) {
    const pending = state.pendingAction;
    if (!pending) return null;
    const timedOut = now() >= pending.deadlineAt;

    if (pending.kind === 'consume-created-food') {
      if (ITEMS_MOD.didCreatedSlotConsume(pending.item, currentVisibleSlots())) {
        state.pendingAction = null;
        state.foodCycle = 'idle';
        state.createdFood = null;
        state.lastReason = 'created-food-consumed';
        return { fire: false, reason: 'created-food-consumed' };
      }
      if (timedOut) return stopSafely('created-food-consume-not-confirmed');
      state.lastReason = 'waiting-created-food-consumption';
      return { fire: false, reason: 'waiting-created-food-consumption' };
    }

    const spent = manaSpent(pending, ctx.mana);
    if (pending.kind === 'training') {
      if (spent) {
        state.pendingAction = null;
        noteRuneCreated();
        // The general Eat module keeps its own every-N confirmed-casts rule.
        // Advance it only after MiniTibia has proved the rune consumed mana;
        // a handler click by itself must never make normal eating fire.
        ctx.castsSinceFood = (Number(ctx.castsSinceFood) || 0) + 1;
        state.lastReason = 'rune-cast-confirmed';
        return { fire: false, reason: 'rune-cast-confirmed' };
      }
      if (timedOut) return stopSafely('rune-cast-no-mana-effect');
      state.lastReason = 'waiting-rune-confirmation';
      return { fire: false, reason: 'waiting-rune-confirmation' };
    }

    if (pending.kind === 'fallback') {
      if (spent) {
        state.pendingAction = null;
        state.lastReason = 'fallback-cast-confirmed';
        return { fire: false, reason: 'fallback-cast-confirmed' };
      }
      if (timedOut) return stopSafely('fallback-cast-no-mana-effect');
      state.lastReason = 'waiting-fallback-confirmation';
      return { fire: false, reason: 'waiting-fallback-confirmation' };
    }

    // Food must prove both the mana spend and that exactly one new/changed
    // item appeared in the playable 20-slot surface before it can be eaten.
    const created = Array.isArray(pending.baseline)
      ? ITEMS_MOD.findCreatedSlotDelta(pending.baseline, currentVisibleSlots()) : null;
    if (spent && created) {
      state.pendingAction = null;
      state.foodMagicPending = false;
      state.foodBaseline = null;
      state.foodDeadlineAt = null;
      state.createdFood = created;
      state.foodCycle = 'created-food-ready';
      state.lastReason = 'food-created-confirmed';
      return { fire: false, reason: 'food-created-confirmed' };
    }
    if (timedOut) {
      return stopSafely(spent ? 'food-not-created-timeout' : 'food-cast-no-mana-effect');
    }
    state.lastReason = spent ? 'waiting-created-food' : 'waiting-food-confirmation';
    return { fire: false, reason: state.lastReason };
  }

  function foodMagicDecision(ctx) {
    if (state.foodCycle === 'created-food-ready') {
      if (!state.createdFood) return stopSafely('created-food-missing');
      state.lastReason = 'consume-created-food';
      return { fire: true, kind: 'consume-created-food', item: state.createdFood,
        reason: 'consume-created-food' };
    }
    if (!state.foodMagicPending) return null;
    const ew = typeof foodMagicConfig === 'function' ? (foodMagicConfig() || {}) : {}; // PR 3: injected unified source
    const slot = Number(ew.slot);
    const sid = Number(ew.sid);
    if (ew.enabled !== true || !Number.isInteger(slot) || slot < 1 || slot > 12 || !Number.isInteger(sid)) {
      state.lastReason = 'food-magic-invalid';
      return { fire: false, reason: 'food-magic-invalid' };
    }
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(sid) === false) return { fire: false, reason: 'food-magic-vocation-gate' };
      } catch (e) { warn('training: food magic vocation gate read failed: ' + (e && e.message ? e.message : e)); }
    }
    const cost = typeof getSpellCost === 'function' ? getSpellCost(sid) : null;
    if (!Number.isFinite(Number(cost)) || Number(cost) <= 0) {
      return { fire: false, reason: 'food-magic-no-confirmable-cost' };
    }
    const feasible = FEAS_MOD.canCast({ mana: ctx.mana, cost: Number(cost), reserve: 0,
      maxMana: ctx.maxMana, key: 'training-food-' + slot, warned, onWarn: warn });
    if (!feasible.fire) return { fire: false, reason: 'food-magic-insufficient' };
    const cd = cooldownVerdict(sid);
    if (!cd.fire) return { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
    return { fire: true, kind: 'eat-magic', slot, sid, cost: Number(cost), reason: 'eat-magic' };
  }

  function evaluateCap(ctx) {
    const cc = capConfig && typeof capConfig === 'object' ? capConfig : {};
    state.cap = null;
    if (cc.capMode !== 'strict') return { full: false };
    let cap = null;
    if (typeof readCap === 'function') {
      try { cap = readCap(); } catch (e) { warn('training: cap read failed: ' + (e && e.message ? e.message : e)); }
    }
    state.cap = cap && typeof cap === 'object' ? cap : null;
    const ratio = state.cap ? state.cap.ratio : null;
    if (!Number.isFinite(ratio)) return { full: false };
    const threshold = Number(cc.capFullThreshold);
    if (!(ratio >= (Number.isFinite(threshold) ? threshold : 1))) return { full: false };

    const slot = Number(cc.fallbackSlot);
    const sid = Number(cc.fallbackSid);
    const cost = typeof getSpellCost === 'function' ? getSpellCost(slot) : null;
    const pct = Number(cc.fallbackManaPct);
    const manaKnown = Number.isFinite(Number(ctx.mana)) && Number.isFinite(Number(ctx.maxMana)) && Number(ctx.maxMana) > 0;
    if (!Number.isInteger(slot) || slot < 1 || slot > 12 || !Number.isInteger(sid)) {
      return { full: true, decision: { fire: false, reason: 'fallback-hotbar-unmapped' } };
    }
    if (!Number.isFinite(Number(cost)) || Number(cost) <= 0 || !manaKnown) {
      return { full: true, decision: { fire: false, reason: 'fallback-no-confirmable-cost' } };
    }
    const percentageOk = Number.isFinite(pct) && Number(ctx.mana) >= pct * Number(ctx.maxMana);
    const feasible = FEAS_MOD.canCast({ mana: ctx.mana, cost: Number(cost), reserve: Number(config.reserve) || 0,
      maxMana: ctx.maxMana, key: 'training-fallback-' + slot, warned, onWarn: warn });
    if (!percentageOk || !feasible.fire) return { full: true, decision: { fire: false, reason: 'cap-full-idle' } };
    const cd = cooldownVerdict(sid);
    if (!cd.fire) return { full: true, decision: { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' } };
    return { full: true, decision: { fire: true, kind: 'fallback', slot, sid, cost: Number(cost), reason: 'cap-full-fallback' } };
  }

  function decide(ctx = {}) {
    state.lastReason = null;
    state.requiredMana = null;
    state.waitingForMana = false;
    state.capFull = false;
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    if (state.blockedReason) return { fire: false, reason: state.blockedReason };
    const pending = confirmPending(ctx);
    if (pending) return pending;
    const slot = Number(config.slot);
    const sid = Number(config.sid);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12 || !Number.isInteger(sid)) return { fire: false, reason: 'no-slot' };
    if (typeof canCastSpell === 'function') {
      try { if (canCastSpell(sid) === false) return { fire: false, reason: 'vocation-gate' }; }
      catch (e) { warn('training: vocation gate read failed — gate skipped: ' + (e && e.message ? e.message : e)); }
    }
    const food = foodMagicDecision(ctx);
    if (food) { state.lastReason = food.reason; return food; }
    const cap = evaluateCap(ctx);
    if (cap.full) { state.capFull = true; state.lastReason = cap.decision.reason; return cap.decision; }
    const cost = typeof getSpellCost === 'function' ? getSpellCost(sid) : null;
    if (!Number.isFinite(Number(cost)) || Number(cost) <= 0) return { fire: false, reason: 'no-cost' };
    state.requiredMana = Number(cost) + Math.max(0, Number(config.reserve) || 0);
    const feasible = FEAS_MOD.canCast({ mana: ctx.mana, cost: Number(cost), reserve: Number(config.reserve) || 0,
      maxMana: ctx.maxMana, key: 'training-' + slot, warned, onWarn: warn });
    if (!feasible.fire) {
      state.waitingForMana = feasible.reason === 'reserve' || feasible.reason === 'insufficient';
      return { fire: false, reason: feasible.reason === 'reserve' ? 'reserve' : 'insufficient' };
    }
    const cd = cooldownVerdict(sid);
    if (!cd.fire) return { fire: false, reason: cd.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
    state.lastReason = 'train';
    return { fire: true, kind: 'training', slot, sid, cost: Number(cost), reason: 'train' };
  }

  function liveHotbarMatches(slot, sid) {
    if (typeof readHotbarSlotSid !== 'function') return false;
    try { return Number(readHotbarSlotSid(slot)) === Number(sid); }
    catch (e) { warn('training: hotbar mapping read failed: ' + (e && e.message ? e.message : e)); return false; }
  }

  /** Invoke exactly once, then wait for the next live observation to confirm it. */
  function fire(decision, deps = {}) {
    if (!decision || state.pendingAction) return false;
    if (decision.kind === 'consume-created-food') {
      if (!decision.item || typeof consumeItem !== 'function') return false;
      const baseline = currentVisibleSlots();
      try {
        if (consumeItem(decision.item) === false) return false;
      } catch (e) { warn('training: created food consume invocation failed: ' + (e && e.message ? e.message : e)); return false; }
      state.pendingAction = { kind: 'consume-created-food', item: decision.item,
        baseline, deadlineAt: now() + Math.max(250, Number(actionConfirmationTimeoutMs) || 2500) };
      state.lastFiredAt = now();
      state.lastReason = 'consume-invoked-awaiting-confirmation';
      return true;
    }
    const slot = Number(decision.slot);
    const sid = Number(decision.sid);
    const cost = Number(decision.cost);
    const manaBefore = Number(deps.mana);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12 || !Number.isInteger(sid) || !Number.isFinite(cost) || cost <= 0) return false;
    if (!Number.isFinite(manaBefore)) return stopSafely('runtime-mana-unavailable').fire;
    if (!liveHotbarMatches(slot, sid)) return stopSafely('stale-hotbar-slot-' + slot + '-expected-sid-' + sid).fire;
    const baseline = decision.kind === 'eat-magic' ? currentVisibleSlots() : null;
    const invoked = FIRING_MOD.fireSlot(slot, { mode: 'handleClick', gameClient: deps.gameClient, document: deps.document, log });
    if (!invoked) return false;
    const timeout = decision.kind === 'eat-magic' ? foodArrivalTimeoutMs : actionConfirmationTimeoutMs;
    state.pendingAction = { kind: decision.kind, slot, sid, cost, manaBefore, baseline,
      deadlineAt: now() + Math.max(250, Number(timeout) || 2500) };
    state.lastFiredAt = now();
    state.lastReason = decision.kind + '-invoked-awaiting-confirmation';
    return true;
  }

  /** A rune counts only after the mana snapshot confirmed its cast. PR 3:
   * the Runes card counter stays; the everyRunes food-magic arming is gone
   * (REQ-06 — food magic is requested explicitly by the eat module). */
  function noteRuneCreated() {
    state.successfulRuneCreations += 1;
  }

  /* -------- PR 3 thin food facade (REQ-01/02) — the machine itself is
   * never rewritten; these are additive entry points the bootstrap food
   * node uses so eat can drive the SAME confirmation machine. -------- */

  /** Explicit magic-food request (replaces the everyRunes arming). */
  function requestFoodMagic() {
    state.foodMagicPending = true;
  }

  /** One machine step: confirm a pending action first, else decide the next
   * food-magic action. Mirrors exactly what training.decide would run for
   * the food branch (confirmPending || foodMagicDecision). */
  function foodStep(ctx) {
    return confirmPending(ctx) || foodMagicDecision(ctx);
  }

  /** Clear the food cycle + any food-prefixed blocked reason (the eat module
   * calls this when the machine blocks so the NORMAL food path can serve). */
  function resetFoodCycle() {
    state.foodMagicPending = false;
    state.foodBaseline = null;
    state.foodDeadlineAt = null;
    state.createdFood = null;
    state.foodCycle = 'idle';
    if (state.pendingAction && /food|created-food/.test(state.pendingAction.kind)) {
      state.pendingAction = null;
    }
    if (!state.blockedReason || /food|created-food/.test(state.blockedReason)) {
      state.blockedReason = null;
    }
  }

  // Compatibility entrypoints retained for direct module consumers. They do
  // not imply game success; runtime uses pendingAction confirmation above.
  function captureFoodBaseline() { return currentVisibleSlots().map((slot) => Object.assign({}, slot)); }
  function noteFoodMagicCast() { state.lastReason = 'food-invocation-awaits-runtime-confirmation'; }
  function noteCreatedFoodConsumed() { state.lastReason = 'consume-invocation-awaits-runtime-confirmation'; }

  function getState() {
    return {
      on: Boolean(config && config.on === true), lastFiredAt: state.lastFiredAt,
      lastReason: state.lastReason, capFull: Boolean(state.capFull),
      successfulRuneCreations: state.successfulRuneCreations, foodMagicPending: state.foodMagicPending,
      foodCycle: state.foodCycle, foodDeadlineAt: state.foodDeadlineAt,
      requiredMana: state.requiredMana, waitingForMana: state.waitingForMana,
      pendingAction: state.pendingAction && state.pendingAction.kind,
      blockedReason: state.blockedReason,
      cap: state.cap ? { capacity: state.cap.capacity, maxCapacity: state.cap.maxCapacity,
        ratio: state.cap.ratio, source: state.cap.source } : null,
    };
  }

  return { decide, fire, noteRuneCreated, captureFoodBaseline, noteFoodMagicCast,
    noteCreatedFoodConsumed, requestFoodMagic, foodStep, resetFoodCycle,
    getState, isEnabled: () => Boolean(config && config.on === true) };
}

module.exports = { createTraining };
