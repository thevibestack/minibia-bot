'use strict';

/**
 * Ordered rule registry rotation engine (REQ-03, design D9).
 *
 * The engine evaluates configured rules per tick in configured order and fires
 * AT MOST ONE action per tick. When two rules are feasible, the earlier in
 * order wins and the other is deferred to the next tick. `repeat` keeps a rule
 * eligible on subsequent ticks while feasible, up to N executions; the rule
 * then completes and stays dormant until its condition re-satisfies (it must
 * be observed false, then true again — e.g. mana re-crossing the threshold) or
 * it is explicitly re-armed via `rearm(ruleId)`.
 *
 * Rule shape:
 *   {
 *     id: string,
 *     order?: number,                    // lower runs first; defaults to index
 *     kind?: 'cast',                     // cast-kind rules advance the global
 *                                       // casts-since-food counter (forced eat
 *                                       // cadence) when their action returns
 *                                       // true (confirmed execution)
 *     condition: (ctx) => boolean,       // is this rule feasible this tick?
 *     action: (ctx) => boolean|void,     // side effect; at most one per tick.
 *                                       // cast-kind rules MUST return true to
 *                                       // confirm the cast actually executed
 *     repeat?: number,                   // executions before completion (default 1)
 *   }
 *
 * The shared `ctx` is a mutable context object (mana, cooldowns, timers, ...)
 * that conditions read and actions write. Cast-kind executions are tracked in
 * `ctx.castsSinceFood`: incremented ONLY when the rule fires AND its action
 * confirms execution (returns true) — skipped/infeasible rules never advance
 * it. The EatFood rule consumes it for the every-N-casts cadence.
 */

/**
 * Create a rotation engine over an ordered rule registry.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.rules=[]] - rule descriptors (see shape above)
 * @param {object} [opts.ctx={}] - initial shared context
 * @returns {{
 *   tick: () => {fired: string|null, action: Function|null, deferred: string[]},
 *   rearm: (ruleId: string) => boolean,
 *   getCtx: () => object,
 *   setCtx: (partial: object) => object,
 *   rules: Array<object>,
 * }}
 */
function createEngine({ rules = [], ctx = {} } = {}) {
  const state = new Map();
  const ordered = [...rules]
    .map((rule, index) => ({ ...rule, order: Number.isFinite(rule.order) ? rule.order : index }))
    .sort((a, b) => a.order - b.order);

  for (const rule of ordered) {
    state.set(rule.id, { executions: 0, completed: false });
  }

  /**
   * Run one tick: evaluate rules in configured order, fire the first feasible
   * rule (at most one action per tick) and defer the rest.
   *
   * @returns {{fired: string|null, action: Function|null, deferred: string[]}}
   */
  function tick() {
    const deferred = [];
    for (let i = 0; i < ordered.length; i++) {
      const rule = ordered[i];
      const st = state.get(rule.id);

      if (!rule.condition(ctx)) {
        // Condition false: re-arm the rule so a future satisfaction counts as
        // a re-satisfaction (threshold re-arm, REQ-03).
        st.executions = 0;
        st.completed = false;
        continue;
      }

      if (st.completed) {
        // Completed: dormant until the condition re-satisfies.
        continue;
      }

      st.executions += 1;
      if (st.executions >= (rule.repeat ?? 1)) {
        st.completed = true;
      }
      const confirmed = rule.action(ctx) === true;
      if (rule.kind === 'cast' && confirmed) {
        // Forced eat cadence (food.everyCasts): count only casts that actually
        // executed — skipped rules never reach this line, and a cast-kind
        // action returning false means the fire path did not run.
        ctx.castsSinceFood = (ctx.castsSinceFood || 0) + 1;
      }
      for (let j = i + 1; j < ordered.length; j++) {
        deferred.push(ordered[j].id);
      }
      return { fired: rule.id, action: rule.action, deferred };
    }
    return { fired: null, action: null, deferred };
  }

  /**
   * Force-reset a rule so it may fire again without waiting for its condition
   * to go false first (explicit threshold re-arm).
   *
   * @param {string} ruleId - id of the rule to re-arm
   * @returns {boolean} true when the rule existed and was re-armed
   */
  function rearm(ruleId) {
    const st = state.get(ruleId);
    if (!st) return false;
    st.executions = 0;
    st.completed = false;
    return true;
  }

  /** @returns {object} the shared context */
  function getCtx() {
    return ctx;
  }

  /** Merge a partial context into the shared context. @returns {object} ctx */
  function setCtx(partial) {
    Object.assign(ctx, partial);
    return ctx;
  }

  return { tick, rearm, getCtx, setCtx, rules: ordered };
}

module.exports = { createEngine };
