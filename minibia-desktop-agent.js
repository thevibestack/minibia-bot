/* =========================================================================
 * minibia-desktop-agent.js — GENERATED in-page agent bundle (REQ-04/10/11/12).
 * Do NOT edit by hand: regenerate with `node tools/build-agent.js`.
 *
 * Registry: __mbModules / __mbRequire (same pattern as the userscript build).
 * Boot: the epilogue calls createAgent from src/agent/bootstrap.js and
 * exposes window.__mbAgent. The app injects this file with
 * Page.addScriptToEvaluateOnNewDocument so it survives reloads (REQ-04).
 * ========================================================================= */

/* =====================================================================

 * GENERATED BUNDLE — src modules (core + adapters + agent bootstrap).

 * Regenerate with `node tools/build-agent.js`.

 * ===================================================================== */

const __mbModules = Object.create(null);

function __mbRequire(name) {

  if (!__mbModules[name]) throw new Error('mb module not found: ' + name);

  return __mbModules[name];

}

__mbModules['core/jitter'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Jitter delay helpers (REQ-13).
 *
 * Firing delays are randomized per action within the configured range. Config
 * values are clamped to [50, 400] and inverted bounds are swapped. A range that
 * lies entirely outside the valid domain falls back to the default [50, 400].
 */

const JITTER_MIN = 50;
const JITTER_MAX = 400;
const DEFAULT_RANGE = { min: JITTER_MIN, max: JITTER_MAX };

/**
 * Normalize a jitter range: swap inverted bounds, clamp into [50, 400].
 *
 * @param {number} min - requested minimum delay (ms)
 * @param {number} max - requested maximum delay (ms)
 * @returns {{min: number, max: number, swapped: boolean, clamped: boolean}}
 *   Normalized bounds plus correction flags:
 *   - `swapped` is true when inverted bounds were exchanged.
 *   - `clamped` is true when values were corrected (out-of-domain, clamped,
 *     or a degenerate single-point range widened to stay non-constant).
 */
function clampJitter(min, max) {
  let swapped = false;
  let clamped = false;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ...DEFAULT_RANGE, swapped: false, clamped: true };
  }

  if (min > max) {
    [min, max] = [max, min];
    swapped = true;
  }

  // Entirely outside the valid domain -> default range.
  if (max < JITTER_MIN || min > JITTER_MAX) {
    return { ...DEFAULT_RANGE, swapped, clamped: true };
  }

  if (min < JITTER_MIN) {
    min = JITTER_MIN;
    clamped = true;
  }
  if (max > JITTER_MAX) {
    max = JITTER_MAX;
    clamped = true;
  }

  // A single-point range would produce constant delays; widen it by 1ms.
  if (min === max) {
    if (max < JITTER_MAX) {
      max += 1;
    } else {
      min -= 1;
    }
    clamped = true;
  }

  return { min, max, swapped, clamped };
}

/**
 * Pick a random integer delay within [min, max] (inclusive on both ends).
 *
 * @param {number} [min=50] - minimum delay (ms)
 * @param {number} [max=400] - maximum delay (ms)
 * @param {() => number} [rng=Math.random] - injectable RNG returning [0, 1)
 * @returns {number} delay in milliseconds
 */
function randomDelay(min = JITTER_MIN, max = JITTER_MAX, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  const spread = Math.max(1, hi - lo + 1);
  return lo + Math.floor(rng() * spread);
}

module.exports = { clampJitter, randomDelay, JITTER_MIN, JITTER_MAX };

return module.exports;
})();

__mbModules['core/config'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

const { clampJitter } = require('core/jitter');

/**
 * Config normalization (REQ-12/REQ-13).
 *
 * Produces the canonical config shape from raw UI/persistence input, applying
 * defaults for missing keys. Jitter clamp/swap semantics are delegated to
 * jitter.clampJitter. A spell threshold or reserve above maxMana is rejected
 * with an inline error (returned in `errors`) and the previous persisted value
 * is kept.
 *
 * Canonical shape (design data model):
 * {
 *   jitter: { min, max },
 *   firing: { mode: 'handleClick' | 'keyboard' },
 *   validation: { enabled, windowMs, pollMs },
 *   spells: [{ slot, word, validationWord, threshold, reserve, repeat, order, cooldownMs, sid }],
 *   food: { slot, cid, name, warningWindowSec, fallbackIntervalSec, everyCasts },
 * }
 */

const DEFAULT_CONFIG = Object.freeze({
  jitter: { min: 50, max: 400 },
  firing: { mode: 'handleClick' },
  validation: { enabled: true, windowMs: 2500, pollMs: 100 },
  spells: [],
  food: { slot: null, cid: null, name: '', warningWindowSec: 60, fallbackIntervalSec: 10, everyCasts: 0 },
});

const FIRING_MODES = new Set(['handleClick', 'keyboard']);

/** Coerce a value to a finite number, falling back when invalid. */
function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce a nullable slot value: null stays null, anything else must be a finite number. */
function toSlot(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize `food.everyCasts` (forced eat cadence): a non-negative integer,
 * where 0 disables the cadence. On invalid input (negative, fractional,
 * non-numeric) the previous persisted value is kept and an inline error is
 * recorded, mirroring the REQ-12 keep-previous pattern.
 *
 * @param {*} value - raw value from the UI or persistence
 * @param {object} prev - previous normalized config (values kept on rejection)
 * @param {string[]} errors - inline error accumulator
 * @param {(message: string) => void} warn - warning sink
 * @returns {number} normalized everyCasts
 */
function everyCastsOf(value, prev, errors, warn) {
  const prevValue = toNum(prev.food?.everyCasts, DEFAULT_CONFIG.food.everyCasts);
  const n = toNum(value, prevValue);
  if (Number.isInteger(n) && n >= 0) return n;
  errors.push(
    `Food everyCasts ${JSON.stringify(value)} is invalid; expected an integer >= 0; previous value kept (REQ-12)`,
  );
  warn(`food everyCasts ${JSON.stringify(value)} rejected: expected an integer >= 0`);
  return prevValue;
}

/**
 * Normalize a raw config object.
 *
 * @param {object} [input] - raw config from the UI or persistence
 * @param {object} [prev] - previously persisted config (values kept on rejection)
 * @param {number} [maxMana=Infinity] - player max mana used to reject threshold/reserve
 * @param {object} [log] - optional sink `{ warn(message) }` for non-fatal warnings
 * @returns {{config: object, errors: string[]}} normalized config and inline errors
 */
function normalizeConfig(input = {}, prev = DEFAULT_CONFIG, maxMana = Infinity, log = {}) {
  const errors = [];
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  // --- jitter (REQ-13): delegate clamp/swap semantics to jitter.js ---
  const jitter = clampJitter(
    toNum(input.jitter?.min, prev.jitter?.min ?? DEFAULT_CONFIG.jitter.min),
    toNum(input.jitter?.max, prev.jitter?.max ?? DEFAULT_CONFIG.jitter.max),
  );
  if (jitter.swapped) {
    warn(`jitter bounds were inverted; swapped to [${jitter.min}, ${jitter.max}]`);
  }
  if (jitter.clamped) {
    warn(`jitter bounds clamped to [${jitter.min}, ${jitter.max}] (REQ-13)`);
  }

  // --- firing mode ---
  const firingMode =
    FIRING_MODES.has(input.firing?.mode)
      ? input.firing.mode
      : FIRING_MODES.has(prev.firing?.mode)
        ? prev.firing.mode
        : DEFAULT_CONFIG.firing.mode;

  // --- validation ---
  const validation = {
    enabled: input.validation?.enabled ?? prev.validation?.enabled ?? DEFAULT_CONFIG.validation.enabled,
    windowMs: toNum(input.validation?.windowMs, prev.validation?.windowMs ?? DEFAULT_CONFIG.validation.windowMs),
    pollMs: toNum(input.validation?.pollMs, prev.validation?.pollMs ?? DEFAULT_CONFIG.validation.pollMs),
  };

  // --- spells (REQ-12: reject threshold/reserve > maxMana, keep previous) ---
  const prevSpells = Array.isArray(prev.spells) ? prev.spells : [];
  const rawSpells = Array.isArray(input.spells) ? input.spells : prevSpells;
  const spells = rawSpells.map((spell, index) => {
    const slot = toSlot(spell.slot);
    const prevSpell = prevSpells.find((p) => toSlot(p.slot) === slot);

    let threshold = toNum(spell.threshold, prevSpell?.threshold ?? 0);
    let reserve = toNum(spell.reserve, prevSpell?.reserve ?? 0);

    if (threshold > maxMana) {
      errors.push(
        `Spell slot ${slot}: threshold ${threshold} exceeds maxMana ${maxMana}; previous value kept (REQ-12)`,
      );
      warn(`slot ${slot} threshold ${threshold} rejected: exceeds maxMana ${maxMana}`);
      threshold = toNum(prevSpell?.threshold, 0);
    }
    if (reserve > maxMana) {
      errors.push(
        `Spell slot ${slot}: reserve ${reserve} exceeds maxMana ${maxMana}; previous value kept (REQ-12)`,
      );
      warn(`slot ${slot} reserve ${reserve} rejected: exceeds maxMana ${maxMana}`);
      reserve = toNum(prevSpell?.reserve, 0);
    }

    return {
      slot,
      word: typeof spell.word === 'string' ? spell.word : prevSpell?.word ?? '',
      validationWord:
        typeof spell.validationWord === 'string' ? spell.validationWord : prevSpell?.validationWord ?? spell.word ?? '',
      threshold,
      reserve,
      repeat: toNum(spell.repeat, prevSpell?.repeat ?? 1),
      order: toNum(spell.order, prevSpell?.order ?? index),
      cooldownMs: toNum(spell.cooldownMs, prevSpell?.cooldownMs ?? 0),
      sid: spell.sid ?? prevSpell?.sid ?? null,
    };
  });

  // --- food ---
  const food = {
    slot: toSlot(input.food?.slot ?? prev.food?.slot ?? DEFAULT_CONFIG.food.slot),
    cid: input.food?.cid ?? prev.food?.cid ?? DEFAULT_CONFIG.food.cid,
    name: typeof input.food?.name === 'string' ? input.food.name : prev.food?.name ?? DEFAULT_CONFIG.food.name,
    warningWindowSec: toNum(
      input.food?.warningWindowSec,
      prev.food?.warningWindowSec ?? DEFAULT_CONFIG.food.warningWindowSec,
    ),
    fallbackIntervalSec: toNum(
      input.food?.fallbackIntervalSec,
      prev.food?.fallbackIntervalSec ?? DEFAULT_CONFIG.food.fallbackIntervalSec,
    ),
    // Forced eat cadence (user-requested every-N-casts mode): integer >= 0;
    // 0 = disabled. Invalid values keep the previous persisted value (REQ-12
    // keep-previous pattern) with an inline error.
    everyCasts: everyCastsOf(input.food?.everyCasts, prev, errors, warn),
  };

  return {
    config: {
      jitter: { min: jitter.min, max: jitter.max },
      firing: { mode: firingMode },
      validation,
      spells,
      food,
    },
    errors,
  };
}

module.exports = { normalizeConfig, DEFAULT_CONFIG };

return module.exports;
})();

__mbModules['core/feasibility'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Mana feasibility gate (REQ-01).
 *
 * A spell fires only when `mana >= cost` AND `(mana - cost) >= reserve` when
 * reserve is ON (reserve > 0); otherwise the plain `mana >= cost` rule applies.
 * Equality passes in both checks. A spell with `cost > maxMana` is NEVER
 * feasible; a single warning is emitted per spell key (no per-tick spam).
 *
 * @typedef {Object} Verdict
 * @property {boolean} fire - whether the spell may fire this tick
 * @property {boolean} never - true when cost > maxMana (permanently infeasible)
 * @property {'ok'|'insufficient'|'reserve'|'never'} reason - outcome reason
 */

/**
 * Evaluate whether a spell can be cast given the current mana state.
 *
 * @param {object} opts
 * @param {number} opts.mana - current mana
 * @param {number} opts.cost - spell mana cost
 * @param {number} [opts.reserve=0] - mana kept after casting; 0 disables the reserve check
 * @param {number} [opts.maxMana=Infinity] - player max mana
 * @param {string} [opts.key] - unique spell identity for warning dedupe (e.g. "slot-4")
 * @param {Set<string>} [opts.warned] - persistent set of keys already warned (survives ticks)
 * @param {(message: string) => void} [opts.onWarn] - single-warning sink (REQ-01)
 * @returns {Verdict} evaluation verdict
 */
function canCast({ mana, cost, reserve = 0, maxMana = Infinity, key = null, warned = null, onWarn = null }) {
  if (cost > maxMana) {
    if (key !== null && warned && !warned.has(key) && typeof onWarn === 'function') {
      warned.add(key);
      onWarn(`spell ${key}: cost ${cost} exceeds maxMana ${maxMana}; never feasible (REQ-01)`);
    }
    return { fire: false, never: true, reason: 'never' };
  }

  if (mana < cost) {
    return { fire: false, never: false, reason: 'insufficient' };
  }

  if (reserve > 0 && mana - cost < reserve) {
    return { fire: false, never: false, reason: 'reserve' };
  }

  return { fire: true, never: false, reason: 'ok' };
}

module.exports = { canCast };

return module.exports;
})();

__mbModules['core/cooldown'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Cooldown gating (REQ-02).
 *
 * Before firing, the engine checks the client's `spellbook.cooldowns`
 * (per-spell bucket plus GLOBAL_COOLDOWN) and mirrors the client pre-fire gate.
 * Client data is authoritative: an active per-spell cooldown or an active
 * GLOBAL_COOLDOWN defers the fire. When client cooldown data is absent
 * (null/undefined), config-specified cooldown pacing is used as a fallback and
 * each fallback deferral is reported through the gap-log callback.
 *
 * @typedef {Object} CooldownVerdict
 * @property {boolean} fire - whether the spell may fire now
 * @property {'client'|'fallback'} source - where the decision came from
 * @property {'ok'|'global-cooldown'|'cooldown'|'fallback-pacing'} reason - outcome reason
 * @property {number} waitMs - remaining wait before the spell can fire
 */

/**
 * Evaluate whether a spell may fire right now.
 *
 * @param {object} opts
 * @param {{active: boolean, seconds?: number}|null|undefined} [opts.cooldown] -
 *   client per-spell cooldown state; null/undefined means client data absent
 * @param {{active: boolean, seconds?: number}|null|undefined} [opts.globalCooldown] -
 *   client GLOBAL_COOLDOWN state
 * @param {number} [opts.cooldownMs=0] - config fallback cooldown (ms)
 * @param {number|null} [opts.lastFiredAt=null] - epoch ms of the last successful
 *   fire; null/0 means never fired (fallback paces nothing on first cast)
 * @param {number} [opts.now=Date.now()] - current epoch ms (injectable clock)
 * @param {(message: string) => void} [opts.onGapLog] - gap log sink; called when
 *   client cooldown data is absent and fallback pacing defers the fire
 * @returns {CooldownVerdict} the cooldown verdict
 */
function canFire({
  cooldown = null,
  globalCooldown = null,
  cooldownMs = 0,
  lastFiredAt = null,
  now = Date.now(),
  onGapLog = null,
}) {
  // GLOBAL_COOLDOWN is authoritative: never fire during it.
  if (globalCooldown && globalCooldown.active) {
    return {
      fire: false,
      source: 'client',
      reason: 'global-cooldown',
      waitMs: Math.max(0, (globalCooldown.seconds ?? 0) * 1000),
    };
  }

  // Per-spell client cooldown.
  if (cooldown && cooldown.active) {
    return {
      fire: false,
      source: 'client',
      reason: 'cooldown',
      waitMs: Math.max(0, (cooldown.seconds ?? 0) * 1000),
    };
  }

  // Client cooldown data absent -> config fallback pacing (gap logged on defer).
  if (cooldown == null) {
    // Never fired: nothing to pace, allow the first cast.
    if (!lastFiredAt) {
      return { fire: true, source: 'fallback', reason: 'ok', waitMs: 0 };
    }
    const elapsed = now - lastFiredAt;
    const remaining = cooldownMs - elapsed;
    if (remaining > 0) {
      if (typeof onGapLog === 'function') {
        onGapLog(`cooldown data absent for spell; fallback pacing ${remaining}ms remaining (REQ-02)`);
      }
      return { fire: false, source: 'fallback', reason: 'fallback-pacing', waitMs: remaining };
    }
    return { fire: true, source: 'fallback', reason: 'ok', waitMs: 0 };
  }

  return { fire: true, source: 'client', reason: 'ok', waitMs: 0 };
}

module.exports = { canFire };

return module.exports;
})();

__mbModules['core/rotation'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

return module.exports;
})();

__mbModules['core/sated'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Food timer parsing (REQ-05).
 *
 * Satiety detection reads the food skill timer text ("MM:SS") from the skill
 * window and converts it to whole seconds. `null` input, unparseable text, and
 * a zero timer ("0:00") all mean "expired" and map to `null`, which triggers
 * the eat path.
 */

/**
 * Parse a "MM:SS" food timer into seconds.
 *
 * @param {string|null|undefined} text - timer text from the food skill window
 * @returns {number|null} remaining seconds, or null when the timer is expired
 *   (null input, invalid text, or 0:00).
 */
function parseFoodTimer(text) {
  if (text === null || text === undefined) return null;
  const match = String(text).trim().match(/^(\d+):([0-5]\d)$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

module.exports = { parseFoodTimer };

return module.exports;
})();

__mbModules['core/validation'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Echo validation state machine (REQ-09).
 *
 * After a words-path fire, `start(fireId)` begins polling for an echo entry
 * matching `isMatch` within `windowMs`. Outcomes:
 *
 *   - `pass`      — an echo matching the configured word/regex was observed.
 *   - `miss`      — the window expired without an echo; counted, NEVER refired.
 *   - `disabled`  — validation is off; no polling occurs at all.
 *
 * Validation is non-blocking: all timing flows through injectable
 * `schedule`/`clear`/`now`, so the engine tick never waits on it and tests
 * drive the machine deterministically without real timers. Candidates are
 * matched from the baseline snapshot taken at start, so pre-existing channel
 * history never validates a fresh fire.
 *
 * @typedef {Object} Validator
 * @property {(fireId: string|number) => string} start - begin validating an echo
 * @property {() => void} dispose - stop polling without emitting a result
 * @property {() => {state: string, fireId: string|number|null, startedAt: number, deadline: number}} getState
 */

/**
 * Create an echo validation state machine.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=2500] - echo wait window (ms)
 * @param {number} [opts.pollMs=100] - polling interval (ms)
 * @param {(candidate: object) => boolean} [opts.isMatch] - true when a candidate
 *   entry is the expected echo (name + word/regex check)
 * @param {() => Array<object>} [opts.getCandidates] - returns the current
 *   channel entries (full history; baseline handled internally)
 * @param {boolean} [opts.enabled=true] - validation enabled flag
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {(fn: () => void, ms: number) => object} [opts.schedule=setTimeout] - injectable timer
 * @param {(handle: object) => void} [opts.clear=clearTimeout] - injectable timer cancel
 * @param {({fireId, result, state}) => void} [opts.onResult] - result sink for pass/miss/disabled
 * @returns {Validator}
 */
function createValidator({
  windowMs = 2500,
  pollMs = 100,
  isMatch = () => false,
  getCandidates = () => [],
  enabled = true,
  now = Date.now,
  schedule = setTimeout,
  clear = clearTimeout,
  onResult = () => {},
} = {}) {
  let state = 'idle'; // idle | passing | pass | miss | disabled
  let timer = null;
  let fireId = null;
  let baselineCount = 0;
  let startedAt = 0;
  let deadline = 0;

  function stop() {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
  }

  function settle(nextState, result) {
    stop();
    state = nextState;
    onResult({ fireId, result, state: nextState });
  }

  function poll() {
    if (state !== 'passing') return;
    const candidates = getCandidates();
    for (let i = baselineCount; i < candidates.length; i++) {
      if (isMatch(candidates[i])) {
        settle('pass', 'pass');
        return;
      }
    }
    if (now() >= deadline) {
      settle('miss', 'miss');
      return;
    }
    timer = schedule(poll, pollMs);
  }

  return {
    /**
     * Begin validating the echo for a fired action.
     * @param {string|number} id - identifier of the fired action
     * @returns {string} initial state ('passing' or 'disabled')
     */
    start(id) {
      stop();
      fireId = id;
      if (!enabled) {
        state = 'disabled';
        onResult({ fireId: id, result: 'disabled', state: 'disabled' });
        return state;
      }
      startedAt = now();
      deadline = startedAt + windowMs;
      baselineCount = getCandidates().length;
      state = 'passing';
      timer = schedule(poll, pollMs);
      return state;
    },

    /** Cancel any pending polling; no result is emitted. */
    dispose() {
      stop();
      state = 'idle';
    },

    /** @returns {{state: string, fireId: string|number|null, startedAt: number, deadline: number}} */
    getState() {
      return { state, fireId, startedAt, deadline };
    },
  };
}

module.exports = { createValidator };

return module.exports;
})();

__mbModules['core/dedupe'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Unknown-cast observation tracker (REQ-15).
 *
 * Monitors the Default channel for the player's own messages that match no
 * configured word. When the SAME unknown word is observed >= 2 times within 5
 * minutes, the tracker reports an 'offer' exactly once. A declined word
 * becomes session-silent (no offer reappears). Words already configured are
 * ignored entirely.
 *
 * Observation outcomes:
 *   - 'ignored'  — empty input or the word is already configured
 *   - 'silenced' — the word was declined earlier this session
 *   - 'new'      — first observation within the current window
 *   - 'offer'    — >= 2 observations within the window; registration offered (once)
 *   - 'pending'  — already offered, not declined, waiting for user decision
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create an unknown-word dedupe tracker.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=300000] - observation window (ms)
 * @param {Set<string>} [opts.known] - words already configured in the rotation
 * @returns {{
 *   observe: (word: string, now?: number) => 'ignored'|'new'|'offer'|'pending'|'silenced',
 *   decline: (word: string) => void,
 *   markKnown: (word: string) => void,
 *   isSilenced: (word: string) => boolean,
 * }}
 */
function createDedupe({ windowMs = DEFAULT_WINDOW_MS, known = new Set() } = {}) {
  /** @type {Map<string, {count: number, firstAt: number, offeredAt: number|null}>} */
  const observations = new Map();
  const silenced = new Set();

  /**
   * Record an observation of an unknown word.
   *
   * @param {string} word - the unconfigured word observed in chat
   * @param {number} [now=Date.now()] - observation time (epoch ms)
   * @returns {'ignored'|'new'|'offer'|'pending'|'silenced'} outcome
   */
  function observe(word, now = Date.now()) {
    if (typeof word !== 'string' || word.length === 0) return 'ignored';
    if (known.has(word)) return 'ignored';
    if (silenced.has(word)) return 'silenced';

    let entry = observations.get(word);
    if (!entry || now - entry.firstAt > windowMs) {
      // Fresh window: first observation or previous window expired.
      entry = { count: 0, firstAt: now, offeredAt: null };
      observations.set(word, entry);
    }
    entry.count += 1;

    if (entry.count >= 2) {
      if (entry.offeredAt === null) {
        entry.offeredAt = now;
        return 'offer';
      }
      return 'pending';
    }
    return 'new';
  }

  /** Mark a word declined; it becomes session-silent. */
  function decline(word) {
    silenced.add(word);
    observations.delete(word);
  }

  /** Mark a word configured; the tracker stops observing it. */
  function markKnown(word) {
    known.add(word);
    observations.delete(word);
  }

  /** @returns {boolean} true when the word is session-silent */
  function isSilenced(word) {
    return silenced.has(word);
  }

  return { observe, decline, markKnown, isSilenced };
}

module.exports = { createDedupe, DEFAULT_WINDOW_MS };

return module.exports;
})();

__mbModules['core/tree'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Behavior tree decision core (REQ-10/11, design D3/D4).
 *
 * Pure, deterministic node evaluator: identical (state, config, clock, rng)
 * inputs produce identical ticks (REQ-11). Nodes carry no side effects other
 * than Action nodes, and a tick executes AT MOST ONE Action node (REQ-10:
 * "at most one action fires per tick") — evaluation HALTS immediately after
 * the first Action that runs, so a single tick can never enqueue two
 * server-bound actions, regardless of tree shape.
 *
 * Nodes (plain objects, so trees compose and serialize trivially):
 *
 *   { type: 'selector', children: [...], id? }
 *     Priority: run children in order, execute the FIRST child that succeeds
 *     and STOP (remaining children are never evaluated).
 *   { type: 'sequence', children: [...], id? }
 *     Gate: every child must succeed; FAILS FAST on the first failure.
 *   { type: 'condition', predicate: (ctx) => boolean, id? }
 *     Pure predicate; truthy -> success. No side effects.
 *   { type: 'action', run: (ctx) => boolean|void, id? }
 *     Side effect. `run` returning false (or throwing) means the action did
 *     NOT execute -> node failure, so a Selector falls through to the next
 *     child. Returning anything else (including undefined) means success.
 *     Once an Action succeeds, the tick halts (see above).
 *
 * Node helpers Selector/Sequence/Condition/Action are exported for
 * composition convenience; raw object literals work identically.
 *
 * tick(ctx) -> { action: Function|null, path: Array<{type, id, status}> }
 *   - `action` is the `run` function of the single executed Action (null when
 *     the tree evaluated to failure without executing anything).
 *   - `path` records every evaluated node in pre-order with its final status
 *     ('success' | 'failure') and `halted: true` on entries above the point
 *     where the tick stopped after the first executed Action.
 */

/**
 * @param {Function} predicate - (ctx) => boolean
 * @param {string} [id]
 * @returns {{type: 'condition', predicate: Function, id: string|undefined}}
 */
function Condition(predicate, id) {
  return { type: 'condition', predicate, id };
}

/**
 * @param {Function} run - (ctx) => boolean|void; false = did not execute
 * @param {string} [id]
 * @returns {{type: 'action', run: Function, id: string|undefined}}
 */
function Action(run, id) {
  return { type: 'action', run, id };
}

/**
 * @param {Array} children - child nodes
 * @param {string} [id]
 * @returns {{type: 'selector', children: Array, id: string|undefined}}
 */
function Selector(children, id) {
  return { type: 'selector', children, id };
}

/**
 * @param {Array} children - child nodes
 * @param {string} [id]
 * @returns {{type: 'sequence', children: Array, id: string|undefined}}
 */
function Sequence(children, id) {
  return { type: 'sequence', children, id };
}

/** Node type -> human label used in paths. */
function nodeLabel(node) {
  return String(node.id || node.type);
}

/**
 * Evaluate one node, mutating the shared tick state. After the first
 * successful Action the tick state carries `action` and every parent
 * short-circuits to success without evaluating further children.
 *
 * @param {object} node
 * @param {object} ctx
 * @param {{action: {id: string, run: Function}|null, path: Array}} tickState
 * @returns {{status: 'success'|'failure'}}
 */
function evaluate(node, ctx, tickState) {
  if (tickState.action) {
    // Halt: an action already executed earlier in this tick.
    return { status: 'success' };
  }

  switch (node.type) {
    case 'selector': {
      const entry = { type: 'selector', id: nodeLabel(node), status: 'running' };
      tickState.path.push(entry);
      for (const child of node.children || []) {
        const res = evaluate(child, ctx, tickState);
        if (tickState.action || res.status === 'success') {
          entry.status = 'success';
          if (tickState.action) entry.halted = true;
          return { status: 'success' };
        }
      }
      entry.status = 'failure';
      return { status: 'failure' };
    }

    case 'sequence': {
      const entry = { type: 'sequence', id: nodeLabel(node), status: 'running' };
      tickState.path.push(entry);
      for (const child of node.children || []) {
        const res = evaluate(child, ctx, tickState);
        if (tickState.action || res.status === 'failure') {
          entry.status = tickState.action ? 'success' : 'failure';
          if (tickState.action) entry.halted = true;
          return { status: entry.status };
        }
      }
      entry.status = 'success';
      return { status: 'success' };
    }

    case 'condition': {
      // Predicates are pure reads; a throw is a predicate bug and propagates
      // to the tick caller (codebase convention: engine conditions never
      // swallow errors).
      const ok = Boolean(node.predicate(ctx));
      tickState.path.push({ type: 'condition', id: nodeLabel(node), status: ok ? 'success' : 'failure' });
      return { status: ok ? 'success' : 'failure' };
    }

    case 'action': {
      // Same convention: action bugs propagate to the tick caller, which
      // (in the agent) records them per tick instead of crashing the page.
      const ok = node.run(ctx) !== false;
      tickState.path.push({ type: 'action', id: nodeLabel(node), status: ok ? 'success' : 'failure' });
      if (ok) tickState.action = { id: nodeLabel(node), run: node.run };
      return { status: ok ? 'success' : 'failure' };
    }

    default:
      throw new TypeError('tree: unknown node type ' + JSON.stringify(node.type));
  }
}

/**
 * Create the tree root. The root is any node; normally a Selector over the
 * priority branches (survival > combat > loot/training, REQ-11).
 *
 * @param {object} [opts]
 * @param {object} [opts.root] - root node (required)
 * @returns {{tick: (ctx?: object) => {action: Function|null, path: Array}, root: object}}
 */
function createTree({ root } = {}) {
  if (!root || typeof root.type !== 'string') {
    throw new TypeError('createTree requires a root node ({ type: ... })');
  }
  function tick(ctx = {}) {
    const tickState = { action: null, path: [] };
    evaluate(root, ctx, tickState);
    return { action: tickState.action ? tickState.action.run : null, path: tickState.path };
  }
  return { tick, root };
}

module.exports = { createTree, Condition, Action, Selector, Sequence };

return module.exports;
})();

__mbModules['core/queue'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

const { randomDelay } = require('core/jitter');

/**
 * Global single-dispatch action queue (REQ-12, design "Action Queue").
 *
 * Every server-bound action (hotbar click, eat, movement) MUST pass through
 * ONE queue instance that enforces a minimum global interval between ANY two
 * dispatched actions (default ~150ms, configurable). Properties:
 *
 *  - FIFO, single dispatch: entries dispatch in array order, one at a time,
 *    never concurrently (throttle=0 still serializes).
 *  - Priority classes (D1, REQ-29): entries carry `priority` ('normal' |
 *    'urgent', default 'normal'). Urgent entries head-insert BEFORE every
 *    normal entry (FIFO within the urgent class), so a preemptive heal
 *    enqueued AFTER in-flight rune/training/combat work still dispatches
 *    FIRST — the in-flight sequence defers to a later drain. Normal entries
 *    keep plain push-at-tail FIFO. Priority only reorders; it NEVER bypasses
 *    the throttle or the jitter (see below).
 *  - Global minimum interval: an entry's fire time is computed AT DRAIN TIME
 *    relative to the last actual dispatch — `lastDispatchAt + minInterval +
 *    jitterMs` — so two actions enqueued 10ms apart fire no earlier than
 *    ~150ms (plus jitter) apart regardless of when they were enqueued. The
 *    FIRST dispatch is anchored to the first entry's ENQUEUE time (a fixed
 *    reference, never the drain time — drain-time anchoring would drift and
 *    defer the entry forever).
 *  - Additive per-action jitter: each entry draws its own jitter delay from
 *    the configured range (50–400ms default) at ENQUEUE time (seeded rng =>
 *    deterministic schedules). The jitter is ADDED on top of the throttle
 *    gap, never subtracted: fire time is never earlier than the interval.
 *  - Defer, never drop, never reorder: entries whose fire time has not
 *    arrived stay pending and drain in a later call (an urgent jump DEFERS
 *    the skipped normals — it never drops them).
 *  - No bypass: the queue is the ONLY dispatch path; the wiring guarantees
 *    game-handler invocations happen exclusively inside dispatched closures.
 *
 * Injectable `now` (fake clock) + `rng` (seeded) make the queue fully
 * deterministic and unit-testable in node without real timers.
 *
 * createQueue(opts) -> {
 *   enqueue(action, { kind, priority, jitterMs }) -> entry,
 *   drain() -> Array<entry>,              // dispatched eligible prefix
 *   hasPending(predicate) -> boolean,
 *   pendingCount() -> number,
 *   stats() -> { enqueued, urgentEnqueued, dispatched, failed, pending,
 *                pendingUrgent, lastDispatchAt, minInterval }
 * }
 */

const DEFAULT_MIN_INTERVAL = 150;
const DEFAULT_JITTER = { min: 50, max: 400 };

/** Coerce a finite number >= 0, else the fallback. */
function finiteMin(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.minInterval=150] - minimum ms between ANY two actions
 * @param {{min: number, max: number}} [opts.jitter={min:50,max:400}] - additive
 *   per-action jitter range; 0,0 disables jitter
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {() => number} [opts.rng=Math.random] - injectable RNG for jitter draws
 * @param {(action: Function) => void} [opts.dispatch] - dispatch sink; the ONLY
 *   place game-handler calls may happen
 * @returns {object} queue handle (see module doc)
 */
function createQueue(opts = {}) {
  const minInterval = finiteMin(opts.minInterval, DEFAULT_MIN_INTERVAL);
  const jit = {
    min: Number.isFinite(opts.jitter && opts.jitter.min) ? opts.jitter.min : DEFAULT_JITTER.min,
    max: Number.isFinite(opts.jitter && opts.jitter.max) ? opts.jitter.max : DEFAULT_JITTER.max,
  };
  const nowFn = typeof opts.now === 'function' ? opts.now : (typeof Date !== 'undefined' ? Date.now : () => 0);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const dispatchFn = typeof opts.dispatch === 'function' ? opts.dispatch : () => {};

  let lastDispatchAt = null; // timestamp of the last actually dispatched action
  let pending = [];          // FIFO-by-class of { action, kind, priority, jitterMs, fireAt }
  const counters = { enqueued: 0, urgentEnqueued: 0, dispatched: 0, failed: 0 };

  /** Coerce the priority option: only 'urgent' is a class; anything else
   *  (missing, 'normal', unknown) normalizes to 'normal' (D1). */
  function coercePriority(value) {
    return value === 'urgent' ? 'urgent' : 'normal';
  }

  /** Draw this entry's jitter delay (enqueue time — deterministic w/ seed). */
  function drawJitter(override) {
    if (Number.isFinite(override)) return Math.max(0, override);
    return randomDelay(jit.min, jit.max, rng);
  }

  /**
   * Enqueue an action. The entry's jitter is drawn NOW; its fire time is
   * computed at drain time against the actual last dispatch so the global
   * interval holds no matter when enqueued. The first entry's fire base is
   * its OWN enqueue time (a fixed reference — never the drain time, which
   * would drift and defer it forever).
   *
   * Urgent entries (D1, REQ-29 preemption) head-insert right after the LAST
   * urgent entry — before every normal entry — so a preemptive heal jumps
   * in-flight work. FIFO holds within each priority class. Priority only
   * reorders dispatch order; the throttle + jitter still apply at drain.
   *
   * @param {Function} action - () => void; invoked ONLY through dispatch
   * @param {{kind?: string, priority?: 'normal'|'urgent', jitterMs?: number}} [entryOpts]
   * @returns {{action: Function, kind: string, priority: string, jitterMs: number}} the entry
   */
  function enqueue(action, entryOpts = {}) {
    if (typeof action !== 'function') {
      throw new TypeError('queue.enqueue requires a function action');
    }
    const entry = {
      action,
      kind: typeof entryOpts.kind === 'string' ? entryOpts.kind : 'action',
      priority: coercePriority(entryOpts.priority),
      jitterMs: drawJitter(entryOpts.jitterMs),
      enqueuedAt: nowFn(), // fixed reference for the first-dispatch slot
      fireAt: null,        // computed at drain time
    };
    if (entry.priority === 'urgent') {
      // Head-insert: find the boundary after the LAST urgent entry and splice
      // there — urgent stays FIFO among urgents and always precedes normals.
      let i = 0;
      while (i < pending.length && pending[i].priority === 'urgent') i += 1;
      pending.splice(i, 0, entry);
      counters.urgentEnqueued += 1;
    } else {
      pending.push(entry);
    }
    counters.enqueued += 1;
    return entry;
  }

  /**
   * Dispatch the eligible FIFO prefix. Fire time is recomputed per entry
   * against the running last-dispatch slot, so spacing is ALWAYS
   * >= minInterval + jitter even when entries were enqueued long ago.
   *
   * @returns {Array} the entries actually dispatched this call
   */
  function drain() {
    const now = nowFn();
    const dispatched = [];
    let slot = lastDispatchAt === null ? null : lastDispatchAt + minInterval;
    let i = 0;
    for (; i < pending.length; i++) {
      const entry = pending[i];
      const base = slot === null ? entry.enqueuedAt : slot;
      entry.fireAt = base + entry.jitterMs;
      if (entry.fireAt > now) break; // FIFO: the rest are later — defer all
      try {
        dispatchFn(entry.action);
      } catch (err) {
        counters.failed += 1;
      }
      lastDispatchAt = entry.fireAt;
      slot = entry.fireAt + minInterval;
      counters.dispatched += 1;
      dispatched.push(entry);
    }
    if (i > 0) pending = pending.slice(i);
    return dispatched;
  }

  /** True when a pending entry matches the predicate (re-arm guards). */
  function hasPending(predicate) {
    return pending.some(predicate);
  }

  /** @returns {number} entries still waiting for their fire time */
  function pendingCount() {
    return pending.length;
  }

  /** @returns {object} counters + pacing state */
  function stats() {
    return {
      enqueued: counters.enqueued,
      urgentEnqueued: counters.urgentEnqueued,
      dispatched: counters.dispatched,
      failed: counters.failed,
      pending: pending.length,
      pendingUrgent: pending.reduce(function (n, e) { return n + (e.priority === 'urgent' ? 1 : 0); }, 0),
      lastDispatchAt,
      minInterval,
    };
  }

  return { enqueue, drain, hasPending, pendingCount, stats };
}

module.exports = { createQueue, DEFAULT_MIN_INTERVAL, DEFAULT_JITTER };

return module.exports;
})();

__mbModules['core/items'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Container slot lookup (REQ-13/17, design "Heal items"/"Eat" module table).
 *
 * Pure, node-testable helpers for finding a usable item slot inside the
 * client's container state. The container SOURCES are live-probed (the
 * userscript resolves food slots from the same locations — see the eat rule
 * in tools/build-userscript.js): gameClient.containerPrototype,
 * gameClient.backpack, gameClient.interface.containerPrototype and
 * gameClient.player.containers (desktop-agent addition). Each source exposes
 * a `slots` array; slots carry `cid` (item id), `index` (mouse.use index) and
 * optionally a DOM `element`/`canvas.canvas` for the contextmenu path.
 *
 * Reads are pure: given the containers snapshot + the wanted cids, return the
 * first matching slot descriptor or null. Unknown container shapes degrade to
 * null ("no item") — the module then takes NO action (safe degrade, REQ-06
 * read-only boundary).
 */

/**
 * Resolve the list of container objects to scan, in probe order.
 * @param {object|null} gameClient - page gameClient
 * @returns {Array<object>} container objects (deduped, non-null)
 */
function readContainers(gameClient) {
  const gc = gameClient;
  if (!gc || typeof gc !== 'object') return [];
  const list = [
    gc.containerPrototype,
    gc.backpack,
    (gc.interface && gc.interface.containerPrototype) || null,
  ];
  const playerContainers = gc.player && gc.player.containers;
  if (Array.isArray(playerContainers)) {
    list.push.apply(list, playerContainers);
  } else if (playerContainers) {
    list.push(playerContainers);
  }
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Find the first container slot whose cid is in the wanted list.
 *
 * @param {Array<object>} containers - container objects (each with `.slots`)
 * @param {Array<number|string>} [cids] - item cids to match (numbers/strings)
 * @returns {{which: number, index: number, element: object|null}|null}
 *   - `which`: position of the container in the scan order
 *   - `index`: the slot's own mouse-use index (1-based), or its 1-based
 *     position in the slots array when the slot carries no index
 *   - `element`: the slot's DOM element when exposed (contextmenu path)
 *   Returns null when nothing matches or the shape is unknown.
 */
function findSlotByCid(containers, cids) {
  if (!Array.isArray(containers)) return null;
  const wanted = new Set((cids || []).map(Number).filter(Number.isFinite));
  if (wanted.size === 0) return null;
  for (let c = 0; c < containers.length; c++) {
    const container = containers[c];
    const slots = container && container.slots;
    if (!slots || !Array.isArray(slots)) continue;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || typeof slot !== 'object') continue;
      if (!wanted.has(Number(slot.cid))) continue;
      const ownIndex = Number(slot.index);
      return {
        which: c,
        index: Number.isFinite(ownIndex) ? ownIndex : i + 1,
        element: slot.element || (slot.canvas && slot.canvas.canvas) || null,
      };
    }
  }
  return null;
}

module.exports = { readContainers, findSlotByCid };

return module.exports;
})();

__mbModules['core/premium'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

return module.exports;
})();

__mbModules['core/kills'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Kill observation via active-creature diffs (REQ-21/REQ-19 feed, task 5.4).
 *
 * The game keeps the currently-active creatures on the client
 * (`world.activeCreatures`, live-probed surface obs 10320). A KILL is a
 * creature that was present in the previous scan and is absent now — a pure
 * diff over the active set. This observer feeds:
 *   - huntStats kills-per-hour + loot-per-hour (REQ-21),
 *   - loot routing (REQ-19): a killed creature with loot info routes to the
 *     configured destination.
 *
 * Feature-detect: `readActiveCreatures` returns the array or null. When the
 * array is absent (unprobed location, uninitialized world) the observer
 * reports `available: false` and produces no kills — the modules record the
 * honest "no kill data" degrade instead of inventing events.
 *
 * Pure node-testable: injectable reader + clock.
 */

/** Identity of a creature entry (stable across scans). */
function creatureId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.id !== undefined && entry.id !== null) return 'id|' + String(entry.id);
  if (entry.speciesId !== undefined && entry.speciesId !== null) return 'sid|' + String(entry.speciesId);
  if (entry.name !== undefined && entry.name !== null) return 'name|' + String(entry.name);
  return null;
}

/** Best-effort display name of a creature entry. */
function creatureName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.name === 'string' && entry.name) return entry.name;
  if (typeof entry.speciesName === 'string' && entry.speciesName) return entry.speciesName;
  if (typeof entry.type === 'string' && entry.type) return entry.type;
  return null;
}

/**
 * Loot availability for a creature: true/false when the entry exposes a
 * `loot` field; null when the field is absent (unknown — unprobed).
 */
function creatureLoot(entry) {
  if (!entry || typeof entry !== 'object' || entry.loot === undefined) return null;
  return Boolean(entry.loot);
}

/**
 * Create the kill observer.
 *
 * @param {object} [opts]
 * @param {() => Array<object>|null} [opts.readActiveCreatures] - feature-detect
 *   reader for the live active-creature list; null/absent => unavailable
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @returns {{
 *   scan: () => {kills: Array<{id: string, name: string|null, loot: boolean|null}>, available: boolean},
 *   reset: () => void,
 * }}
 */
function createKillObserver({ readActiveCreatures = () => null, now = Date.now } = {}) {
  let previous = new Map(); // id -> entry
  let initialized = false;

  /**
   * Diff the current active set against the previous scan. Kills = creatures
   * that disappeared since the last scan (player aggression or other causes —
   * the game does not distinguish; v1 counts disappearances, feature-detected
   * from the array). First scan only establishes the baseline.
   * @returns {{kills: Array<{id: string, name: string|null, loot: boolean|null}>, available: boolean}}
   */
  function scan() {
    const current = typeof readActiveCreatures === 'function' ? readActiveCreatures() : null;
    if (!Array.isArray(current)) {
      initialized = false;
      previous = new Map();
      return { kills: [], available: false };
    }
    const nowMap = new Map();
    const kills = [];
    for (const entry of current) {
      const id = creatureId(entry);
      if (id === null) continue;
      nowMap.set(id, entry);
    }
    if (initialized) {
      for (const [id, entry] of previous) {
        if (!nowMap.has(id)) {
          kills.push({ id, name: creatureName(entry), loot: creatureLoot(entry) });
        }
      }
    }
    previous = nowMap;
    initialized = true;
    return { kills, available: true };
  }

  /** Drop the baseline (agent rebuild / new session). */
  function reset() {
    previous = new Map();
    initialized = false;
  }

  return { scan, reset };
}

module.exports = { createKillObserver, creatureId, creatureName, creatureLoot };

return module.exports;
})();

__mbModules['core/log'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Ring-buffer activity log (design D8, REQ-26 "never raw JSON").
 *
 * The agent-side readable log: fire closures and log sinks push events
 * {ts, module, action, result}; the panel renders them as formatted rows.
 * The buffer is capped (default 200 entries, oldest evicted) and the clock
 * is injectable for tests. Pure module — no DOM, no network.
 */

/**
 * Create an activity-log ring buffer.
 *
 * @param {object} [opts]
 * @param {number} [opts.cap=200] - max entries held (positive integer)
 * @param {() => number} [opts.now=Date.now] - injectable clock (ts fallback)
 * @returns {{
 *   push: (event: {ts?: number, module: string, action: string, result?: *}) => number,
 *   read: () => Array<{ts: number, module: string, action: string, result: *}>,
 *   size: () => number,
 *   clear: () => number,
 * }}
 */
function createLogRing(opts = {}) {
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : 200;
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const entries = [];

  return {
    /**
     * Push one event. The entry is normalized (never mutated by the caller):
     * `ts` defaults to the injected clock; `module`/`action` are coerced to
     * strings; the oldest entry is evicted when the cap is reached.
     * @returns {number} new buffer length
     */
    push(event) {
      const src = event && typeof event === 'object' ? event : {};
      const ts = Number.isFinite(Number(src.ts)) ? Number(src.ts) : nowFn();
      entries.push({
        ts,
        module: String(src.module === undefined || src.module === null ? 'agent' : src.module),
        action: String(src.action === undefined || src.action === null ? 'event' : src.action),
        result: src.result !== undefined ? src.result : null,
      });
      while (entries.length > cap) entries.shift();
      return entries.length;
    },

    /** Snapshot copy of the buffer, oldest first. */
    read() {
      return entries.slice();
    },

    /** Number of entries currently held. */
    size() {
      return entries.length;
    },

    /** Drop every entry. @returns {number} 0 */
    clear() {
      entries.length = 0;
      return 0;
    },
  };
}

module.exports = { createLogRing };

return module.exports;
})();

__mbModules['adapters/gameClient'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Game client read adapter (REQ-01/02/14, design D3).
 *
 * All reads are state-first with DOM fallback and are RE-QUERIED on every call
 * (the game rebuilds DOM wholesale — never hold element references). Game
 * access is fully injectable through the `ctx` object so the module stays
 * thin and testable with jsdom:
 *
 *   ctx = { gameClient: <page gameClient>, document: <DOM document> }
 *
 * readStats()      -> { mana, maxMana, health, maxHealth, source }
 * readCooldown(sid)-> { cooldown, globalCooldown, source }
 */

/**
 * Coerce a value to a finite number, or null when missing/invalid.
 * @param {*} value
 * @returns {number|null}
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a bar element's last child text ("cur/max") into {cur, max}.
 * @param {Element|null} bar
 * @returns {{cur: number, max: number}|null}
 */
function parseBar(bar) {
  const text = bar?.lastElementChild?.textContent;
  if (!text) return null;
  const match = String(text).trim().match(/^(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return { cur: Number(match[1]), max: Number(match[2]) };
}

/**
 * Read current player stats: `player.state` primary, `#mana-bar`/`#health-bar`
 * DOM fallback, re-queried per read (REQ-01/14).
 *
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient (player.state read here)
 * @param {Document} [ctx.document] - DOM document for the bar fallback
 * @returns {{mana: number|null, maxMana: number|null, health: number|null,
 *   maxHealth: number|null, source: 'state'|'dom'|'none'}}
 */
function readStats(ctx = {}) {
  const state = ctx.gameClient?.player?.state;

  // Primary: player.state.
  if (state && (num(state.mana) !== null || num(state.health) !== null)) {
    return {
      mana: num(state.mana),
      maxMana: num(state.maxMana),
      health: num(state.health),
      maxHealth: num(state.maxHealth),
      source: 'state',
    };
  }

  // Fallback: bars, re-queried every read.
  const doc = ctx.document ?? (typeof document !== 'undefined' ? document : null);
  const mana = parseBar(doc?.querySelector?.('#mana-bar'));
  const health = parseBar(doc?.querySelector?.('#health-bar'));

  if (!mana && !health) {
    return { mana: null, maxMana: null, health: null, maxHealth: null, source: 'none' };
  }

  return {
    mana: mana?.cur ?? null,
    maxMana: mana?.max ?? null,
    health: health?.cur ?? null,
    maxHealth: health?.max ?? null,
    source: 'dom',
  };
}

/**
 * Read the player's rune CAP state (design D3, REQ-30): the rune-making
 * capacity vs its maximum. Feature-detects over the probed locations (open
 * probe: `player.state.__state.capacity` reads 209 while `maxCapacity` reads
 * 400 — the fields may sit at DIFFERENT locations), so each field is read
 * from both candidate locations and the first finite value wins:
 *   capacity:    state.__state.capacity | state.capacity
 *   maxCapacity: state.__state.maxCapacity | state.maxCapacity | player.maxCapacity
 *
 * ratio = capacity / maxCapacity, ratio-guarded (maxCapacity must be finite
 * and > 0). Absent or uncomputable data returns ratio null with an honest
 * source ('none' when nothing was read, 'partial' when only one side is
 * known) — callers degrade, never invent a ratio.
 *
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient (player.state read here)
 * @returns {{capacity: number|null, maxCapacity: number|null, ratio: number|null,
 *   source: 'state'|'partial'|'none'}}
 */
function readCap(ctx = {}) {
  const player = ctx.gameClient && ctx.gameClient.player;
  const state = player && player.state;
  if (!state || typeof state !== 'object') {
    return { capacity: null, maxCapacity: null, ratio: null, source: 'none' };
  }
  const sub = state.__state;
  const capacity = num(sub && sub.capacity) ?? num(state.capacity);
  const maxCapacity = num(sub && sub.maxCapacity)
    ?? num(state.maxCapacity)
    ?? num(player.maxCapacity);
  if (capacity === null && maxCapacity === null) {
    return { capacity: null, maxCapacity: null, ratio: null, source: 'none' };
  }
  if (capacity === null || maxCapacity === null || maxCapacity <= 0) {
    return { capacity, maxCapacity, ratio: null, source: 'partial' };
  }
  return { capacity, maxCapacity, ratio: capacity / maxCapacity, source: 'state' };
}

/**
 * Normalize a single cooldown bucket entry into {active, seconds}.
 * Supports {active, seconds}, a bare seconds number, and a seconds string.
 * @param {*} entry
 * @returns {{active: boolean, seconds: number}|null}
 */
function normalizeCooldown(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number' || typeof entry === 'string') {
    const seconds = num(entry);
    if (seconds === null) return null;
    return { active: seconds > 0, seconds };
  }
  if (typeof entry === 'object') {
    const seconds = num(entry.seconds);
    if (seconds === null) {
      // Object without seconds: honor an explicit active flag.
      if (typeof entry.active === 'boolean') return { active: entry.active, seconds: 0 };
      return null;
    }
    return { active: entry.active === undefined ? seconds > 0 : Boolean(entry.active), seconds };
  }
  return null;
}

/**
 * Read client cooldown state for a spell (REQ-02).
 *
 * Primary source: `gameClient.player.spellbook.cooldowns` (per-spell bucket keyed
 * by sid plus GLOBAL_COOLDOWN), mirroring the client pre-fire gate. When the
 * spellbook/cooldowns data is entirely absent the adapter returns nulls so the
 * core (cooldown.canFire) applies config fallback pacing with a gap log. When
 * the map EXISTS but has no entry for the sid, that is client-authoritative
 * "not on cooldown" ({active:false}) — never confused with "data absent".
 *
 * @param {number|string} spellSid - spell id keying the per-spell bucket
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient
 * @returns {{cooldown: {active: boolean, seconds: number}|null,
 *   globalCooldown: {active: boolean, seconds: number}|null,
 *   source: 'client'|'absent'}}
 */
function readCooldown(spellSid, ctx = {}) {
  const cooldowns = ctx.gameClient?.player?.spellbook?.cooldowns;
  if (cooldowns === null || cooldowns === undefined) {
    return { cooldown: null, globalCooldown: null, source: 'absent' };
  }

  const globalEntry = cooldowns.GLOBAL_COOLDOWN ?? cooldowns.globalCooldown;
  const spellEntry = cooldowns[spellSid];

  return {
    cooldown: normalizeCooldown(spellEntry) ?? { active: false, seconds: 0 },
    globalCooldown: normalizeCooldown(globalEntry) ?? { active: false, seconds: 0 },
    source: 'client',
  };
}

/**
 * Enumerate the client spell catalog (design D5, REQ-28): calls
 * `interface.getSpell(sid)` from sid 0 upward until `maxUnknown` consecutive
 * unknown sids (live probe: ~65 spells). Returns the RAW list plus the
 * player's level + vocation label so the PANEL can filter by what the
 * current character can actually cast. Returns null when the interface is
 * not ready (feature-detect — the picker degrades with an honest reason).
 *
 * Each spell normalizes the live-probed shape (obs 10457):
 *   {name, words, mana, level, vocations[]}  — vocations is an ARRAY OF
 *   STRINGS ("sorcerer"/"druid"/"paladin"/"knight"), never numeric.
 *
 * @param {object|null} gameClient - page gameClient (interface.getSpell)
 * @param {object} [opts]
 * @param {number} [opts.maxUnknown=30] - consecutive unknown sids that end the scan
 * @param {number} [opts.limit=400] - hard cap on the sid range scanned
 * @returns {{spells: Array<object>, playerLevel: number|null,
 *   vocationLabel: string|null}|null}
 */
function enumerateSpellCatalog(gameClient, opts = {}) {
  const maxUnknown = Number.isInteger(opts.maxUnknown) ? opts.maxUnknown : 30;
  const limit = Number.isInteger(opts.limit) ? opts.limit : 400;
  const intf = gameClient && gameClient.interface;
  if (!intf || typeof intf.getSpell !== 'function') return null;

  const spells = [];
  let unknownStreak = 0;
  for (let sid = 0; sid < limit && unknownStreak < maxUnknown; sid += 1) {
    let entry = null;
    try { entry = intf.getSpell(sid); } catch (e) { entry = null; }
    if (!entry || typeof entry !== 'object'
      || (entry.name === undefined && entry.words === undefined)) {
      unknownStreak += 1;
      continue;
    }
    unknownStreak = 0;
    spells.push({
      sid: sid,
      name: typeof entry.name === 'string' && entry.name ? entry.name : 'spell ' + sid,
      words: typeof entry.words === 'string' ? entry.words : '',
      mana: num(entry.mana),
      level: num(entry.level),
      vocations: Array.isArray(entry.vocations)
        ? entry.vocations.filter((v) => typeof v === 'string') : [],
    });
  }

  const player = (gameClient && gameClient.player) || {};
  const level = num(player.level);
  let label = null;
  try {
    // Live-probed location (obs 10457): hotbarManager.__VOCATION_NAMES maps
    // the numeric vocation id to its string label ("druid", "sorcerer", ...).
    const hb = (gameClient.interface && gameClient.interface.hotbarManager)
      || gameClient.hotbarManager || null;
    const table = hb && hb.__VOCATION_NAMES || null;
    if (table && player.vocation !== undefined && table[player.vocation]) {
      label = table[player.vocation];
    }
  } catch (e) { label = null; }

  return { spells, playerLevel: level, vocationLabel: label };
}

/**
 * Pure filter (design D5, REQ-28): keep only spells the given vocation label
 * + player level can cast — `vocations[]` includes the label (an EMPTY
 * vocations array means "no restriction") AND `level <= playerLevel`.
 * @param {Array<object>} spells - raw catalog rows ({sid, name, words, mana, level, vocations})
 * @param {object} [opts]
 * @param {string} [opts.vocationLabel] - current player's vocation label
 * @param {number|null} [opts.playerLevel] - current player level
 * @returns {Array<object>}
 */
function filterCatalogByVocation(spells, opts = {}) {
  const label = typeof opts.vocationLabel === 'string' ? opts.vocationLabel : '';
  const playerLevel = opts.playerLevel;
  return (Array.isArray(spells) ? spells : []).filter((s) => {
    if (!s || typeof s !== 'object') return false;
    const vocations = Array.isArray(s.vocations) ? s.vocations : [];
    if (label && vocations.length > 0 && vocations.indexOf(label) === -1) return false;
    if (playerLevel !== null && playerLevel !== undefined
      && Number.isFinite(Number(s.level)) && Number(s.level) > playerLevel) return false;
    return true;
  });
}

/**
 * Pure per-sid rejection (design D5/D6, REQ-27/28): WHY a spell cannot be
 * applied to the current character — or null when it can. Used by the panel
 * server for the cross-load rejection list (load-profile) and the mana
 * re-check on config save. `mana` is optional: the cross-load path validates
 * vocation/level only; the save path adds the live-mana check.
 * @param {object|null} spell - catalog row for the sid
 * @param {object} [ctx]
 * @param {string} [ctx.vocationLabel]
 * @param {number|null} [ctx.playerLevel]
 * @param {number|null} [ctx.mana] - current mana (save-path re-check only)
 * @returns {{reason: string}|null}
 */
function spellValidationError(spell, ctx = {}) {
  if (!spell || typeof spell !== 'object') return { reason: 'unknown spell' };
  const label = typeof ctx.vocationLabel === 'string' ? ctx.vocationLabel : '';
  const vocations = Array.isArray(spell.vocations) ? spell.vocations : [];
  if (label && vocations.length > 0 && vocations.indexOf(label) === -1) {
    return { reason: 'vocation mismatch — requires ' + vocations.join('/') };
  }
  if (ctx.playerLevel !== null && ctx.playerLevel !== undefined
    && Number.isFinite(Number(spell.level)) && Number(spell.level) > ctx.playerLevel) {
    return { reason: 'level too high — requires level ' + spell.level };
  }
  if (ctx.mana !== null && ctx.mana !== undefined
    && Number.isFinite(Number(spell.mana)) && Number(spell.mana) > ctx.mana) {
    return { reason: 'not enough mana — costs ' + spell.mana + ', you have ' + Math.floor(ctx.mana) };
  }
  return null;
}

module.exports = {
  readStats,
  readCooldown,
  readCap,
  enumerateSpellCatalog,
  filterCatalogByVocation,
  spellValidationError,
};

return module.exports;
})();

__mbModules['adapters/firing'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Spell firing adapter (REQ-07/08, design D1).
 *
 * Primary firing path: `hotbarManager.__handleClick(slot)` — the exact path a
 * real keypress takes (preset-independent; the client gate silently drops
 * packets on cooldown/mana, so calling it is safe). Slots are 1–12; anything
 * else is a logged no-op.
 *
 * Optional keyboard-simulation mode (config `firing.mode: "keyboard"`):
 *  1. blurs `document.activeElement` first (chat-input gate, REQ-08),
 *  2. looks up the slot in `keyboard.__hotbarKeybinds`,
 *  3. dispatches a synthetic `keydown` with that keyCode,
 *  4. falls back to `__handleClick` when no keybind exists or the injected
 *     `didCast(slot)` predicate reports no cast resulted.
 *
 * Everything is injected (`gameClient`, `document`, `didCast`, `log`) — no
 * hard-coded globals.
 */

/** Resolve the hotbar manager from the injected gameClient. */
function getHotbar(gameClient) {
  return gameClient?.interface?.hotbarManager ?? gameClient?.hotbarManager ?? null;
}

/** Resolve the keyboard state from the injected gameClient. */
function getKeyboard(gameClient) {
  return gameClient?.interface?.keyboard ?? gameClient?.keyboard ?? null;
}

/**
 * Create a synthetic keydown event carrying the keyCode.
 * @param {Document} doc
 * @param {number} keyCode
 * @returns {Event}
 */
function createKeydown(doc, keyCode) {
  const KeyEvent = doc?.defaultView?.KeyboardEvent;
  const init = { keyCode, which: keyCode, bubbles: true, cancelable: true };
  if (typeof KeyEvent === 'function') {
    try {
      return new KeyEvent('keydown', init);
    } catch {
      // Fall through to the plain event path.
    }
  }
  const evt = new doc.defaultView.Event('keydown', { bubbles: true, cancelable: true });
  evt.keyCode = keyCode;
  evt.which = keyCode;
  return evt;
}

/** Primary path: hotbarManager.__handleClick(slot). */
function fireHandleClick(slot, gameClient, error) {
  const hotbar = getHotbar(gameClient);
  if (!hotbar || typeof hotbar.__handleClick !== 'function') {
    error(`fireSlot: hotbarManager.__handleClick unavailable for slot ${slot}`);
    return false;
  }
  hotbar.__handleClick(slot);
  return true;
}

/**
 * Keyboard-simulation path: blur, keybind lookup, synthetic keydown, fallback.
 */
function fireKeyboard(slot, deps, error, warn) {
  const { gameClient, document: doc, didCast = null } = deps;

  // REQ-08: blur the focused element first (chat input gate).
  if (doc && doc.activeElement && doc.activeElement !== doc.body) {
    if (typeof doc.activeElement.blur === 'function') {
      doc.activeElement.blur();
    }
  }

  const keyboard = getKeyboard(gameClient);
  const keybinds = keyboard?.__hotbarKeybinds ?? {};
  const keyCode = keybinds[slot] ?? keybinds[String(slot)] ?? keybinds['F' + slot];

  // REQ-08: no keybind maps to the slot -> immediate fallback to __handleClick.
  if (keyCode === undefined || keyCode === null) {
    warn(`fireSlot: no keybind for slot ${slot}; falling back to __handleClick (REQ-08)`);
    return fireHandleClick(slot, gameClient, error);
  }

  doc.dispatchEvent(createKeydown(doc, keyCode));

  // REQ-08: if no cast results (injected predicate), fall back to REQ-07.
  if (typeof didCast === 'function' && didCast(slot) === false) {
    warn(`fireSlot: keydown for slot ${slot} produced no cast; falling back to __handleClick`);
    return fireHandleClick(slot, gameClient, error);
  }

  return true;
}

/**
 * Fire the spell bound to a hotbar slot.
 *
 * @param {number} slot - hotbar slot index (1–12)
 * @param {object} [deps]
 * @param {'handleClick'|'keyboard'} [deps.mode='handleClick'] - firing mode
 * @param {object} [deps.gameClient] - page gameClient (hotbarManager/keyboard)
 * @param {Document} [deps.document] - DOM document (keyboard mode)
 * @param {(slot: number) => boolean} [deps.didCast] - keyboard-mode predicate:
 *   false means the keydown produced no cast and __handleClick fallback runs
 * @param {{error?: Function, warn?: Function}} [deps.log] - log sinks
 * @returns {boolean} true when a fire path executed
 */
function fireSlot(slot, deps = {}) {
  const { mode = 'handleClick', gameClient = null, document: doc = null, log = {} } = deps;
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  // REQ-07: slots are 1–12; anything else is a logged no-op.
  if (!Number.isInteger(slot) || slot < 1 || slot > 12) {
    error(`fireSlot: slot ${slot} out of range 1-12; no-op (REQ-07)`);
    return false;
  }

  if (mode === 'keyboard' && doc) {
    return fireKeyboard(slot, { ...deps, gameClient, document: doc }, error, warn);
  }
  return fireHandleClick(slot, gameClient, error);
}

module.exports = { fireSlot };

return module.exports;
})();

__mbModules['adapters/eat'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Food eating adapter (REQ-05/06, design D2).
 *
 * Primary path: synthetic `contextmenu` on the food slot element, then click
 * the menu's "Use" entry. Fallback: `gameClient.mouse.use({which, index})`.
 * SATED is re-checked before (skip when already sated) and after (confirm the
 * attempt landed). When SATED data is unavailable, a successfully executed
 * attempt is trusted ('ate'), which is what enables the REQ-06 fallback
 * interval cadence. After `maxFailures` consecutive failed attempts the eater
 * pauses itself and surfaces a HUD alert (REQ-06).
 *
 * `eatFood(item, { force: true })` is the every-N-casts forced cadence mode
 * (user-requested): the SATED pre-check is SKIPPED so the food key is pressed
 * on cadence regardless of satiety, but SATED is still re-checked after for
 * confirmation accounting. An executed forced attempt is trusted like the
 * satedNow===null case (result 'ate'), so a forced attempt that lands while
 * SATED stays true is NOT counted as a failure.
 *
 * Fully injectable: `gameClient`, `document`, `isSated`, `findUseEntry`,
 * `setPaused`, `hudAlert`, `log` — no hard-coded globals.
 */

/**
 * Create the eater state machine.
 *
 * @param {object} [deps]
 * @param {object} [deps.gameClient] - page gameClient (mouse.use fallback)
 * @param {Document} [deps.document] - DOM document (contextmenu + menu lookup)
 * @param {() => boolean|null} [deps.isSated] - SATED check; null = unavailable
 * @param {number} [deps.maxFailures=3] - consecutive failures before pausing
 * @param {(doc: Document) => Element|null} [deps.findUseEntry] - menu scanner;
 *   default finds an element whose trimmed text is exactly "Use"
 * @param {(paused: boolean) => void} [deps.setPaused] - pause hook (REQ-06)
 * @param {(message: string) => void} [deps.hudAlert] - HUD alert hook (REQ-06)
 * @param {{error?: Function, warn?: Function}} [deps.log] - log sinks
 * @returns {{
 *   eatFood: (item: object|null, opts?: {force?: boolean}) =>
 *     {result: string, reason: string, attempts: number, paused: boolean},
 *   getFailures: () => number,
 *   resetFailures: () => void,
 *   isPaused: () => boolean,
 * }}
 */
function createEater(deps = {}) {
  const {
    gameClient = null,
    document: doc = null,
    isSated = null,
    maxFailures = 3,
    findUseEntry = defaultFindUseEntry,
    setPaused = null,
    hudAlert = null,
    log = {},
  } = deps;
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};

  let failures = 0;
  let paused = false;

  /** Dispatch a synthetic right-click contextmenu on the slot element. */
  function dispatchContextMenu(element) {
    const MouseEventCtor = doc?.defaultView?.MouseEvent;
    const init = { bubbles: true, cancelable: true, button: 2 };
    if (typeof MouseEventCtor === 'function') {
      element.dispatchEvent(new MouseEventCtor('contextmenu', init));
      return;
    }
    const evt = new doc.defaultView.Event('contextmenu', { bubbles: true, cancelable: true });
    evt.button = 2;
    element.dispatchEvent(evt);
  }

  /**
   * Attempt the proven contextmenu -> "Use" path.
   * @param {Element} element - the food backpack slot element
   * @returns {boolean} true when the "Use" menu entry was clicked
   */
  function tryContextMenuUse(element) {
    if (!element || typeof element.dispatchEvent !== 'function') return false;
    dispatchContextMenu(element);
    const useEntry = typeof findUseEntry === 'function' ? findUseEntry(doc) : null;
    if (!useEntry || typeof useEntry.click !== 'function') return false;
    useEntry.click();
    return true;
  }

  /** Fallback path: gameClient.mouse.use({which, index}). */
  function tryMouseUse(item) {
    const mouse = gameClient?.mouse;
    if (!mouse || typeof mouse.use !== 'function') return false;
    mouse.use({
      which: item?.which ?? 3, // right button
      index: item?.index ?? item?.slot?.index,
    });
    return true;
  }

  /**
   * Attempt to eat the given food item.
   *
   * @param {object|null} item - { slot: {element, index}, cid, which, index }
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - every-N-casts forced cadence: skip
   *   the SATED pre-check (REQ-05 exception for the user-requested forced
   *   cadence); an executed attempt is trusted regardless of the post-check.
   * @returns {{result: 'ate'|'failed'|'no-food', reason: string,
   *   attempts: number, paused: boolean}}
   */
  function eatFood(item = null, opts = {}) {
    const force = opts && opts.force === true;
    // REQ-05: re-check SATED before eating. The forced cadence deliberately
    // skips this pre-check — the user wants the food key pressed every N casts
    // even while sated (creating food does not necessarily flip SATED).
    if (!force && typeof isSated === 'function' && isSated() === true) {
      return { result: 'no-food', reason: 'already-sated', attempts: failures, paused };
    }

    const element = item?.slot?.element ?? null;
    const hasElementPath = element !== null && element !== undefined;
    const mouse = gameClient?.mouse;
    const hasMousePath = mouse !== null && mouse !== undefined && typeof mouse.use === 'function';

    if (!hasElementPath && !hasMousePath) {
      return { result: 'no-food', reason: 'no-food-source', attempts: failures, paused };
    }

    let executed = false;
    if (hasElementPath) {
      executed = tryContextMenuUse(element);
    }
    if (!executed && hasMousePath) {
      executed = tryMouseUse(item);
    }

    // REQ-05: re-check SATED after the attempt. A forced attempt is trusted
    // like the satedNow===null case: the execute landed, so it counts as an
    // eat even when SATED stays true (forced cadence creates food, which does
    // not necessarily flip SATED) — never a failure.
    const satedNow = typeof isSated === 'function' ? isSated() : null;
    if (executed && (satedNow === true || satedNow === null || force)) {
      failures = 0;
      return { result: 'ate', reason: satedNow === true ? 'sated' : 'attempted', attempts: 0, paused };
    }

    // REQ-06: consecutive failure accounting; pause + HUD alert at the cap.
    failures += 1;
    if (failures >= maxFailures && !paused) {
      paused = true;
      if (typeof setPaused === 'function') setPaused(true);
      const message = `eating failed ${failures} consecutive times; eating paused (REQ-06)`;
      if (typeof hudAlert === 'function') hudAlert(message);
      error(message);
    }
    return {
      result: 'failed',
      reason: executed ? (satedNow === false ? 'not-sated' : 'unconfirmed') : 'no-use-entry',
      attempts: failures,
      paused,
    };
  }

  return {
    eatFood,
    /** @returns {number} consecutive failed attempts */
    getFailures: () => failures,
    /** Reset the consecutive-failure counter (e.g. after SATED arrives). */
    resetFailures: () => {
      failures = 0;
    },
    /** @returns {boolean} whether eating is paused after repeated failures */
    isPaused: () => paused,
  };
}

/**
 * Default menu scanner: the first element whose trimmed text is exactly "Use".
 * @param {Document|null} doc
 * @returns {Element|null}
 */
function defaultFindUseEntry(doc) {
  if (!doc?.querySelectorAll) return null;
  const candidates = doc.querySelectorAll('div, li, button, span, a, td');
  for (const el of candidates) {
    if (el.textContent.trim() === 'Use') return el;
  }
  return null;
}

module.exports = { createEater };

return module.exports;
})();

__mbModules['adapters/chat'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Chat read adapter (REQ-09/15, design D4).
 *
 * Primary source: `channelManager.getChannel("Default").__contents` — the
 * channel's synchronous, filtered entry list `[{name, message, __time}]`.
 * Fallback: the `#chat-text-area` DOM node, re-queried on EVERY read (the game
 * rebuilds chat DOM wholesale — never hold references). Entries are normalized
 * to `{name, message, time}`; the echo-matching logic lives in the core
 * validation module.
 *
 * Fully injectable: `ctx = { gameClient, document }`.
 */

/** Normalize one channel entry to the canonical read shape. `type` is the
 *  raw speak-type field when the game exposes it (PR5/REQ-33: speak types 0
 *  and 2); null when absent (the anti-bot watcher treats a null type as a
 *  speak event — feature-detect, never block on unknown). */
function fromChannelEntry(entry) {
  return {
    name: entry?.name ?? null,
    message: entry?.message ?? '',
    time: entry?.__time ?? null,
    type: entry?.type ?? null,
    source: 'channel',
  };
}

/** Parse the #chat-text-area fallback: one "name: message" line per row. */
function fromDomArea(area) {
  const text = area?.textContent ?? '';
  const lines = text.split('\n');
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^:]{1,24}):\s*(.+)$/);
    if (match) {
      entries.push({ name: match[1], message: match[2], time: null, type: null, source: 'dom' });
    } else {
      entries.push({ name: null, message: line, time: null, type: null, source: 'dom' });
    }
  }
  return entries;
}

/**
 * Read the recent Default-channel messages (REQ-09/15).
 *
 * @param {object} [ctx] - injected context
 * @param {object} [ctx.gameClient] - page gameClient (channelManager read here)
 * @param {Document} [ctx.document] - DOM document for the #chat-text-area fallback
 * @returns {Array<{name: string|null, message: string, time: number|null,
 *   source: 'channel'|'dom'}>}
 */
function getRecentMessages(ctx = {}) {
  // Primary: Default channel __contents.
  try {
    const manager =
      ctx.gameClient?.interface?.channelManager ?? ctx.gameClient?.channelManager ?? null;
    const channel = typeof manager?.getChannel === 'function' ? manager.getChannel('Default') : null;
    const contents = channel?.__contents;
    if (Array.isArray(contents)) {
      return contents.map(fromChannelEntry);
    }
  } catch {
    // Channel read failed -> fall through to the DOM fallback.
  }

  // Fallback: #chat-text-area, re-queried per read.
  const doc = ctx.document ?? (typeof document !== 'undefined' ? document : null);
  const area = doc?.querySelector?.('#chat-text-area');
  if (area) {
    return fromDomArea(area);
  }

  return [];
}

module.exports = { getRecentMessages };

return module.exports;
})();

__mbModules['adapters/catalog'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Catalog loading adapter (REQ-10/11, design D5).
 *
 * The extracted catalog is a LOCAL file (generated by tools/extract-catalog.js
 * in the page) — minibia.com serves no catalog.json route, so a same-origin
 * fetch would 404 forever on the real game page. Runtime resolution order:
 *
 *   1. `localStorage['mb-catalog']` FIRST — the extraction seeds it when it
 *      runs in the page (REQ-10). Validated with the same entry normalizer as
 *      the fetch path; corrupt/empty falls through.
 *   2. Same-origin fetch of `catalog.json` as a fallback (kept for future
 *      hosted deployments; works under `@grant none` thanks to CORP
 *      same-origin).
 *   3. When neither is available, log a warning and return the sentinel
 *      `'corrupt'` so the bootstrap can continue in keybind-only mode
 *      (REQ-11).
 *
 * Storage and fetch are injectable so tests never touch a real localStorage
 * or the network:
 *   loadCatalog(url, { fetch, storage, log }) -> entries[] | 'corrupt'
 */

/** localStorage key the extraction seeds (tools/extract-catalog.js, REQ-10). */
const STORAGE_KEY = 'mb-catalog';

/**
 * Normalize raw JSON into catalog entries.
 * @param {*} data - array of entries or {cid: entry} map
 * @returns {Array<object>|null} valid entries, or null when unusable
 */
function normalizeEntries(data) {
  let raw = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : null;
  if (!raw) return null;

  const entries = raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      cid: e.cid ?? e.id ?? null,
      name: typeof e.name === 'string' ? e.name : null,
      article: e.article ?? null,
      type: e.type ?? null,
      weight: e.weight ?? null,
      runeSpellName: e.runeSpellName ?? null,
      imageDataURL: e.imageDataURL ?? e.image ?? null,
      npcTrades: Array.isArray(e.npcTrades) ? e.npcTrades : null,
    }))
    .filter((e) => e.cid !== null && e.cid !== undefined && e.name !== null);

  return entries.length > 0 ? entries : null;
}

/**
 * Read the locally-seeded catalog (the extraction stores it under
 * `mb-catalog`). Returns valid entries, or null when absent/corrupt/empty so
 * the caller falls through to the fetch fallback. Warnings name the failure
 * only when something WAS stored but unusable — absence is silent (the fetch
 * fallback is the expected path on first run).
 *
 * @param {object|null} storage - Storage-like object (localStorage contract)
 * @param {(msg: string) => void} warn - warning sink
 * @returns {Array<object>|null} valid entries, or null to fall through
 */
function readStoredCatalog(storage, warn) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (err) {
    warn('catalog: localStorage read failed (' + (err && err.message ? err.message : err) + '); falling back to fetch');
    return null;
  }
  if (raw === null || raw === undefined || raw === '') return null; // absent — silent fall-through
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    warn('catalog: stored mb-catalog is corrupt JSON (' + (err && err.message ? err.message : err) + '); falling back to fetch');
    return null;
  }
  const entries = normalizeEntries(data);
  if (!entries) {
    warn('catalog: stored mb-catalog has no usable entries; falling back to fetch');
    return null;
  }
  return entries;
}

/**
 * Load the catalog (localStorage seed first, same-origin fetch fallback).
 *
 * @param {string} [url='catalog.json'] - same-origin catalog URL
 * @param {object} [deps]
 * @param {Function} [deps.fetch] - fetch implementation (defaults to globalThis.fetch)
 * @param {object} [deps.storage] - Storage-like object (defaults to globalThis.localStorage)
 * @param {{warn?: Function}} [deps.log] - log sinks
 * @returns {Promise<Array<object>|'corrupt'>} normalized entries, or 'corrupt'
 *   when the catalog is missing/unreadable/invalid (REQ-11 keybind-only mode)
 */
async function loadCatalog(url = 'catalog.json', deps = {}) {
  const { log = {} } = deps;
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};
  const fetchImpl = deps.fetch !== undefined ? deps.fetch : globalThis.fetch;
  const storage = deps.storage !== undefined ? deps.storage : globalThis.localStorage;

  const stored = readStoredCatalog(storage, warn);
  if (stored) return stored; // localStorage-first (REQ-10 seed) — no fetch needed

  if (typeof fetchImpl !== 'function') {
    warn('catalog: no fetch available; continuing in keybind-only mode (REQ-11)');
    return 'corrupt';
  }

  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    warn(`catalog: fetch failed (${err?.message ?? err}); continuing in keybind-only mode (REQ-11)`);
    return 'corrupt';
  }

  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    warn(`catalog: HTTP ${res?.status ?? 'unknown'} (missing?); continuing in keybind-only mode (REQ-11)`);
    return 'corrupt';
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    warn(`catalog: corrupt JSON (${err?.message ?? err}); continuing in keybind-only mode (REQ-11)`);
    return 'corrupt';
  }

  const entries = normalizeEntries(data);
  if (!entries) {
    warn('catalog: no usable entries (empty or invalid shape); continuing in keybind-only mode (REQ-11)');
    return 'corrupt';
  }

  return entries;
}

module.exports = { loadCatalog, normalizeEntries, readStoredCatalog, STORAGE_KEY };

return module.exports;
})();

__mbModules['agent/modules/heal-items'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Heal-with-items module (REQ-13, design "Heal items" row).
 *
 * Optional, user-activated. Decision: when the player's health is at or below
 * the configured threshold and a potion whose cid is in `slotCids` is found in
 * the container state, the module decides a use-on-self action. Module OFF
 * (default) => the decision is always 'off' and no action can be enqueued
 * (toggle honored at the tree condition).
 *
 * Game action (REQ-06 handler boundary — never a state write):
 *   1. Primary: `hotbarManager.__useItemOnSelf({which, index})` — live-probed
 *      action (obs 10320). Signature best-effort; a throw falls through.
 *   2. Fallback: `gameClient.mouse.use({which: 3, index})` — the proven
 *      userscript right-click-use path (same shape as adapters/eat).
 * The fire() function is invoked ONLY inside a queue-dispatched closure
 * (REQ-12 no-bypass) — the module never touches handlers during a tree tick.
 *
 * Reads (container snapshot, health) are injectable so the decision logic is
 * fully node-testable; the default finder scans the live-probed container
 * sources (src/core/items.js).
 */

const { readContainers, findSlotByCid } = require('core/items');

/**
 * Default item finder: scan the probe-order container sources for the first
 * slot whose cid is in the configured list.
 * @param {object|null} gameClient - page gameClient
 * @param {Array<number>} cids - wanted item cids
 * @returns {{which: number, index: number, element: object|null}|null}
 */
function defaultFindSlot(gameClient, cids) {
  return findSlotByCid(readContainers(gameClient), cids);
}

/**
 * Create the heal-items decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized healItems config
 *   { on: boolean, threshold: number, slotCids: Array<number> }
 * @param {() => ({which: number, index: number}|null)} [opts.findSlot] -
 *   injected item finder (default: container-scan by slotCids)
 * @param {object|null} [opts.gameClient] - page gameClient (fire path);
 *   may be a lazy getter-compatible object (bootstrap passes a live object)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, item?: object},
 *   fire: (item: object) => boolean,
 *   isEnabled: () => boolean,
 * }}
 */
function createHealItems(opts = {}) {
  const { config, findSlot = null, gameClient = null, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  /**
   * Pure decision (REQ-13): health <= threshold AND item present -> fire.
   * @param {object} ctx - tick context { health }
   * @returns {{fire: boolean, reason: string, item?: object}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const threshold = Number(config.threshold);
    if (!Number.isFinite(threshold)) return { fire: false, reason: 'no-threshold' };
    if (ctx.health === null || ctx.health === undefined) return { fire: false, reason: 'no-health' };
    if (ctx.health > threshold) return { fire: false, reason: 'healthy' };
    const item = typeof findSlot === 'function' ? findSlot() : null;
    if (!item) return { fire: false, reason: 'no-item' };
    return { fire: true, reason: 'low-hp', item };
  }

  /**
   * Execute the use-on-self action (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{which: number, index: number}} item - found potion slot
   * @returns {boolean} true when a game handler executed
   */
  function fire(item) {
    const gc = typeof gameClient === 'function' ? gameClient() : gameClient;
    const hotbar = gc && ((gc.interface && gc.interface.hotbarManager) || gc.hotbarManager);
    // Primary: live-probed use-on-self action (obs 10320). Signature unprobed
    // => best-effort with a throw falling through to the proven mouse.use path.
    if (hotbar && typeof hotbar.__useItemOnSelf === 'function') {
      try {
        const result = hotbar.__useItemOnSelf({ which: item.which ?? 3, index: item.index });
        if (result !== false) return true;
      } catch (e) { /* fall through to mouse.use */ }
    }
    const mouse = gc && gc.mouse;
    if (mouse && typeof mouse.use === 'function') {
      mouse.use({ which: item.which ?? 3, index: item.index });
      return true;
    }
    error('heal-items: no game handler available (__useItemOnSelf / mouse.use)');
    return false;
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, isEnabled };
}

module.exports = { createHealItems, defaultFindSlot };

return module.exports;
})();

__mbModules['agent/modules/heal-magic'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Heal-with-magic module (REQ-14, design "Heal magic" row).
 *
 * Optional, user-activated. Decision: when health is at or below the
 * configured threshold, cast the configured heal spell on the hotbar slot via
 * the game's own spell path. Gates (in evaluation order):
 *   1. Vocation gate: live-probed `hotbarManager.__canPlayerCastSpell(sid)`
 *      (obs 10320 — checks the vocation). Feature-absent (null) => gate
 *      skipped, never blocks.
 *   2. Mana feasibility (core/feasibility, REQ-01 semantics): the spell cost
 *      is resolved from the client — spellbook first, then the live-probed
 *      `interface.getSpell(sid)` (probed: spellbook is empty for Druid
 *      Flamamex, obs 10320). Unknown cost => no fire ('no-cost', safe).
 *   3. Cooldowns: per-spell + GLOBAL_COOLDOWN via core/cooldown (REQ-14:
 *      GLOBAL_COOLDOWN defers to a later tick).
 * Echo validation (REQ-24) applies to words-path fires; the direct
 * __handleClick path produces no echo, so per REQ-24 validation is skipped for
 * this slice (design degrade "echo skip on direct cast" — echo carry-over
 * lands with slice 5.6).
 *
 * The fire() function runs ONLY inside a queue-dispatched closure (REQ-12
 * no-bypass) and calls `hotbarManager.__handleClick(slot)` via the proven
 * adapters/firing path.
 */

const FEAS_MOD = require('core/feasibility');
const CD_MOD = require('core/cooldown');
const FIRING_MOD = require('adapters/firing');

/**
 * Create the heal-magic decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized healMagic config
 *   { on: boolean, threshold: number, slot: number|null, sid: number|null }
 * @param {(sid: number|null) => number|null} [opts.getSpellCost] - cost
 *   resolver (client spellbook / interface.getSpell); null = unknown
 * @param {(sid: number|null) => boolean|null} [opts.canCastSpell] - live
 *   vocation gate; null = feature absent (skipped)
 * @param {(sid: number|null) => {cooldown: object|null, globalCooldown: object|null}}
 *   [opts.readCooldown] - client cooldown reader (adapters/gameClient)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number, priority?: string},
 *   fire: () => boolean,
 *   isEnabled: () => boolean,
 * }}
 */
function createHealMagic(opts = {}) {
  const { config, getSpellCost = null, canCastSpell = null, readCooldown = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  /**
   * Pure decision (REQ-14).
   * @param {object} ctx - tick context { health, mana, maxMana }
   * @returns {{fire: boolean, reason: string, slot?: number, priority?: string}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const threshold = Number(config.threshold);
    if (!Number.isFinite(threshold)) return { fire: false, reason: 'no-threshold' };
    if (ctx.health === null || ctx.health === undefined) return { fire: false, reason: 'no-health' };
    if (ctx.health > threshold) return { fire: false, reason: 'healthy' };
    const slot = Number(config.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return { fire: false, reason: 'no-slot' };

    // Vocation gate (live-probed hotbarManager.__canPlayerCastSpell).
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(config.sid) === false) return { fire: false, reason: 'vocation-gate' };
      } catch (e) { /* gate read failure => skip the gate, never block */ }
    }

    // Mana feasibility (REQ-14: "gated by mana feasibility (REQ-01 semantics)").
    // Per-module reserve (D2, REQ-31): healMagic.reserve — the cast must not
    // fire below cost + reserve.
    const cost = typeof getSpellCost === 'function' ? getSpellCost(config.sid) : null;
    if (cost === null) return { fire: false, reason: 'no-cost' };
    const feas = FEAS_MOD.canCast({
      mana: ctx.mana,
      cost,
      reserve: Number(config.reserve) || 0,
      maxMana: ctx.maxMana,
      key: 'heal-magic-' + slot,
      warned,
      onWarn: warn,
    });
    if (!feas.fire) {
      return { fire: false, reason: feas.reason === 'never' ? 'never' : feas.reason === 'reserve' ? 'reserve' : 'insufficient' };
    }

    // Cooldowns: GLOBAL_COOLDOWN defers to a later tick (REQ-14).
    if (typeof readCooldown === 'function') {
      const cd = readCooldown(config.sid) || {};
      const verdict = CD_MOD.canFire({
        cooldown: cd.cooldown,
        globalCooldown: cd.globalCooldown,
        cooldownMs: 0,
        lastFiredAt: null,
        now: now(),
        onGapLog: null,
      });
      if (!verdict.fire) {
        return { fire: false, reason: verdict.reason === 'global-cooldown' ? 'global-cooldown' : 'cooldown' };
      }
    }

    // D1 (REQ-29): the heal decision carries priority 'urgent' so the
    // bootstrap enqueues it head-inserted — it preempts in-flight rune/
    // training/attack work (the queue defers them to a later drain).
    return { fire: true, reason: 'low-hp', slot, priority: 'urgent' };
  }

  /**
   * Execute the cast (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{slot: number}} decision - the decided slot
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    return FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, isEnabled };
}

module.exports = { createHealMagic };

return module.exports;
})();

__mbModules['agent/modules/runes'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Rune module (REQ-15, design D7 "Runes" row).
 *
 * Optional, user-activated. Drives rune attack/heal INSIDE the game's own
 * native windows using the LIVE-PROBED timer fields
 * `hotbarManager.__runeAttackUntil` / `hotbarManager.__runeHealUntil`
 * (epoch-ms "window active until" timestamps; obs 10320).
 *
 * Semantics:
 *  - Native window ACTIVE (now < until) => the module DEFERS and never
 *    double-fires alongside the game's own rune automation.
 *  - Window EXPIRED (or never armed) + cooldown clear => a rune action is
 *    enqueued via `__handleClick(runeSlot)` (adapters/firing) to re-arm the
 *    native window.
 *  - FEATURE-DETECT: when the native rune timers are absent (fields
 *    undefined), the module records "no native rune data" and NEVER fires —
 *    the design's degrade path (D7), NOT an invented fallback loop.
 *  - Respects the global cooldown (spellbook GLOBAL_COOLDOWN) and, when
 *    exposed, `__getRuneEffectiveCooldown` and `player.attackSlowness` as a
 *    post-fire wait (feature-detected; absent => 0).
 *
 * Rune heal additionally requires `healThreshold` (design-extension setting):
 * the heal rune fires only while health <= healThreshold; when only
 * `attackSlot` is configured, the attack rune cycles on expiry.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const FIRING_MOD = require('adapters/firing');
const FEAS_MOD = require('core/feasibility'); // D2 (REQ-31): reserve gate

/** Coerce a timer value to epoch ms (number | Date | numeric string). */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create the rune decision module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized runes config
 *   { on: boolean, attackSlot: number|null, healSlot: number|null,
 *     healThreshold: number|null, reserve: number }
 * @param {() => {attackUntil: number|null, healUntil: number|null}|null}
 *   [opts.readRuneTimers] - native rune window reader; null = feature absent
 * @param {() => {active: boolean, seconds?: number}|null} [opts.readGlobalCooldown]
 * @param {() => number} [opts.readAfterFireWait] - post-fire wait ms
 *   (effective rune cooldown / attackSlowness); feature-detected, default 0
 * @param {(slot: number) => number|null} [opts.getSpellCost] - rune spell
 *   cost resolver for the fired slot (D2, REQ-31: reserve gate); null/absent
 *   cost = gate skipped, never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number, kind?: string},
 *   fire: (decision: object, deps: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createRunes(opts = {}) {
  const { config, readRuneTimers = null, readGlobalCooldown = null, readAfterFireWait = null, getSpellCost = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  const state = { lastFireAt: 0, available: true, reason: 'ok' };

  /**
   * Per-module mana reserve gate (D2, REQ-31): a rune cast must not fire
   * below `cost + config.reserve`. Only enforced when reserve > 0 AND the
   * rune spell cost resolves from the client AND mana is known — any unknown
   * side skips the gate (feature-detect, never blocks on absent data).
   * @param {object} ctx - tick context { mana, maxMana }
   * @param {number} slot - the slot the rune would fire on
   * @returns {string|null} 'rune-reserve' | 'rune-insufficient' when the cast
   *   is blocked, null when it may proceed (or the gate cannot prove
   *   infeasibility)
   */
  function manaFeasible(ctx, slot) {
    const reserve = Number(config.reserve) || 0;
    if (reserve <= 0) return null;
    if (ctx.mana === null || ctx.mana === undefined || !Number.isFinite(Number(ctx.mana))) return null;
    let cost = null;
    if (typeof getSpellCost === 'function') {
      try { cost = getSpellCost(slot); } catch (e) { cost = null; }
    }
    if (cost === null || !Number.isFinite(cost)) return null; // cost unknown -> skip
    const feas = FEAS_MOD.canCast({
      mana: Number(ctx.mana),
      cost,
      reserve,
      maxMana: ctx.maxMana,
      key: 'runes-slot-' + slot,
      warned,
      onWarn: warn,
    });
    return feas.fire ? null : (feas.reason === 'reserve' ? 'rune-reserve' : 'rune-insufficient');
  }

  /**
   * Pure decision (REQ-15).
   * @param {object} ctx - tick context { health }
   * @returns {{fire: boolean, reason: string, slot?: number, kind?: string}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const attackSlot = Number(config.attackSlot) || null;
    const healSlot = Number(config.healSlot) || null;
    if (!attackSlot && !healSlot) return { fire: false, reason: 'no-slot' };

    const timers = typeof readRuneTimers === 'function' ? readRuneTimers() : null;
    if (timers === null) {
      // Design D7 degrade: no native rune data => never fire, no fallback loop.
      state.available = false;
      state.reason = 'no native rune data';
      return { fire: false, reason: 'no-native-rune-data' };
    }
    state.available = true;
    state.reason = 'ok';

    const t = now();
    const healUntil = toMs(timers.healUntil);
    const attackUntil = toMs(timers.attackUntil);
    const healActive = healUntil !== null && t < healUntil;
    const attackActive = attackUntil !== null && t < attackUntil;

    // Coexistence: never fire while a native window is active (REQ-15).
    if (healActive || attackActive) return { fire: false, reason: 'native-window-active' };

    // Post-fire wait (effective rune cooldown / attackSlowness).
    if (typeof readAfterFireWait === 'function') {
      const wait = readAfterFireWait();
      if (Number.isFinite(wait) && wait > 0 && t - state.lastFireAt < wait) {
        return { fire: false, reason: 'after-fire-wait' };
      }
    }

    // Global cooldown (REQ-15: respect global cooldown).
    if (typeof readGlobalCooldown === 'function') {
      const g = readGlobalCooldown();
      if (g && g.active) return { fire: false, reason: 'global-cooldown' };
    }

    // Rune heal: only while health <= healThreshold (design extension setting).
    const healThreshold = Number(config.healThreshold);
    const wantHeal = Boolean(healSlot)
      && Number.isFinite(healThreshold)
      && ctx.health !== null
      && ctx.health !== undefined
      && ctx.health <= healThreshold;
    if (wantHeal) {
      const block = manaFeasible(ctx, healSlot);
      if (block !== null) {
        state.reason = block;
        return { fire: false, reason: block };
      }
      return { fire: true, reason: 'heal-window-expired', slot: healSlot, kind: 'rune-heal' };
    }

    if (attackSlot) {
      const block = manaFeasible(ctx, attackSlot);
      if (block !== null) {
        state.reason = block;
        return { fire: false, reason: block };
      }
      return { fire: true, reason: 'attack-window-expired', slot: attackSlot, kind: 'rune-attack' };
    }

    return { fire: false, reason: 'no-candidate' };
  }

  /**
   * Execute the rune slot click (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{slot: number, kind: string}} decision - decided rune action
   * @param {object} deps - { gameClient, document } for the firing adapter
   * @returns {boolean} true when __handleClick executed
   */
  function fire(decision, deps = {}) {
    const slot = Number(decision.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
    state.lastFireAt = now();
    const ok = FIRING_MOD.fireSlot(slot, {
      mode: 'handleClick',
      gameClient: deps.gameClient,
      document: deps.document,
      log,
    });
    if (!ok) error('runes: __handleClick failed for rune slot ' + slot);
    return ok;
  }

  /** @returns {object} module state (surface getRuneState, REQ-04/15) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      available: config && config.on === true ? state.available : false,
      reason: config && config.on === true ? state.reason : 'off',
      lastFireAt: state.lastFireAt,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createRunes, toMs };

return module.exports;
})();

__mbModules['agent/modules/training'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

const FEAS_MOD = require('core/feasibility');
const CD_MOD = require('core/cooldown');
const FIRING_MOD = require('adapters/firing');

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
      try { cap = readCap(); } catch (e) { cap = null; }
    }
    state.cap = cap && typeof cap === 'object' ? cap : null;
    const ratio = state.cap ? state.cap.ratio : null;
    if (ratio === null || !Number.isFinite(ratio)) return { full: false }; // degrade
    const threshold = Number(cc.capFullThreshold);
    const capFull = Number.isFinite(threshold) ? ratio >= threshold : ratio >= 1;
    if (!capFull) return { full: false };

    // Cap full: fallback slot cast when mana >= fallbackManaPct*maxMana
    // (ronda-1), else idle until mana recovers (REQ-30).
    const fallbackSlot = Number(cc.fallbackSlot);
    const pct = Number(cc.fallbackManaPct);
    const manaOk = Number.isFinite(pct)
      && ctx.mana !== null && ctx.mana !== undefined
      && Number.isFinite(ctx.maxMana) && ctx.maxMana > 0
      && ctx.mana >= pct * ctx.maxMana;
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
      } catch (e) { /* gate read failure => skip the gate, never block */ }
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

return module.exports;
})();

__mbModules['agent/modules/eat'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Eat module (REQ-17, design "Eat" row).
 *
 * Optional, user-activated. Food management adapted from the PROVEN userscript
 * logic (readFoodState / resolveFoodItem / every-N-casts rule in
 * tools/build-userscript.js) to the desktop agent context:
 *
 *  - SATED detection: `player.conditions.has('SATED')` primary, then the
 *    `#skill-window div[skill="food"] .skill` timer (core/sated) as fallback.
 *  - Decision (mirrors the userscript eat rule):
 *      1. everyCasts > 0 => forced cadence: eat when N confirmed casts have
 *         landed since the last forced eat; SATED/timer pre-checks BYPASSED
 *         (force mode), the counter resets after the attempt.
 *      2. else: eat when SATED is false ('flag'), when the timer is expired
 *         or <= warningWindowSec, or (SATED + timer both unavailable) when the
 *         configurable fallback interval (default 10s) has elapsed.
 *  - Attempt: the proven adapters/eat eater — contextmenu -> "Use" on the
 *    food slot element, with `mouse.use` fallback; 3 consecutive failures
 *    pause eating + surface a panel-facing alert through the module state and
 *    the agent log (REQ-17).
 *  - Food source: `config.slot` (userscript-style backpack index) or
 *    `config.cids` (cid search over the probe-order container sources,
 *    core/items). Both absent => 'no-food-source', no action.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const SATED_MOD = require('core/sated');
const EAT_MOD = require('adapters/eat');
const { readContainers, findSlotByCid } = require('core/items');

/**
 * Create the eat module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized eat config
 *   { on: boolean, everyCasts: number, warningWindowSec: number,
 *     fallbackIntervalSec: number, slot: number|null, cids: Array<number> }
 * @param {() => object|null} [opts.gameClient] - live gameClient accessor
 *   (the eater's mouse.use fallback is lazy through this getter)
 * @param {Document|null} [opts.document] - page DOM (timer + contextmenu)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, force?: boolean},
 *   fire: (ctx: object, decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createEatModule(opts = {}) {
  const { config, gameClient = null, document: doc = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  /** Live gameClient (lazy accessor or plain object). */
  function gcNow() {
    return typeof gameClient === 'function' ? gameClient() : gameClient;
  }

  /**
   * Proven userscript readFoodState (adapted): SATED flag primary,
   * #skill-window food timer fallback, {eat:null} when both unavailable.
   * @returns {{eat: boolean|null, source: string, sated: boolean|null, timerSec: number|null}}
   */
  function readFoodState() {
    let sated = null;
    try {
      const conditions = gcNow() && gcNow().player && gcNow().player.conditions;
      if (conditions && typeof conditions.has === 'function') {
        sated = conditions.has('SATED') === true;
      }
    } catch (e) { sated = null; }
    let timerEl = null;
    try { timerEl = doc && doc.querySelector('#skill-window div[skill="food"] .skill'); } catch (e) { timerEl = null; }
    let timerSec = null;
    if (timerEl) timerSec = SATED_MOD.parseFoodTimer(timerEl.textContent); // null = expired/unparseable
    if (sated === true) return { eat: false, source: 'sated', sated, timerSec };
    if (sated === false) return { eat: true, source: 'flag', sated, timerSec };
    if (timerEl) {
      return {
        eat: timerSec === null || timerSec <= (config.warningWindowSec || 60),
        source: timerSec === null ? 'expired' : 'timer',
        sated: null,
        timerSec,
      };
    }
    return { eat: null, source: 'none', sated: null, timerSec: null }; // fallback interval
  }

  /**
   * Proven userscript resolveFoodItem (adapted): food slot element by
   * config.slot index, plus the cid-search path over the probe-order
   * container sources. @returns {{element: object|null, index: number|null, cid: number|null}}
   */
  function resolveFoodItem() {
    const gc = gcNow();
    const cids = (config.cids || []).map(Number).filter(Number.isFinite);
    if (cids.length > 0) {
      const hit = findSlotByCid(readContainers(gc), cids);
      if (hit) return { element: hit.element, index: hit.index, cid: cids[0] };
    }
    const slotIndex = Number(config.slot);
    if (Number.isInteger(slotIndex) && slotIndex >= 1) {
      let element = null;
      try {
        const containers = readContainers(gc);
        for (let c = 0; c < containers.length; c++) {
          const slots = containers[c] && containers[c].slots;
          if (slots && Array.isArray(slots)) {
            const slot = slots[slotIndex - 1];
            if (slot) {
              element = slot.element || (slot.canvas && slot.canvas.canvas) || null;
              if (element) break;
            }
          }
        }
      } catch (e) { element = null; }
      if (!element) {
        try {
          const root = doc && doc.querySelector('#container-prototype');
          if (root) {
            const nodes = root.querySelectorAll('.slot, [data-slot], [class*="slot"]');
            element = nodes[slotIndex - 1] || nodes[slotIndex] || null;
          }
        } catch (e) { element = null; }
      }
      return { element, index: slotIndex, cid: null };
    }
    return { element: null, index: null, cid: null };
  }

  // The proven eater does the attempt + failure accounting + pause.
  // gameClient is LAZY (getter object) so the mouse.use fallback sees the
  // live client even though the eater is constructed before readiness.
  const eaterGameClient = {
    get mouse() { const gc = gcNow(); return gc ? gc.mouse : undefined; },
  };
  const state = { paused: false, alert: null, lastEatAt: 0 };
  const eater = EAT_MOD.createEater({
    gameClient: eaterGameClient,
    document: doc,
    isSated: () => readFoodState().sated,
    maxFailures: 3,
    setPaused: (p) => { state.paused = p; },
    hudAlert: (m) => { state.alert = m; warn(m); },
    log,
  });

  /**
   * Pure decision (REQ-17).
   * @param {object} ctx - tick context { castsSinceFood, lastEatAt }
   * @returns {{fire: boolean, reason: string, force?: boolean}}
   */
  function decide(ctx = {}) {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    if (eater.isPaused()) return { fire: false, reason: 'paused' };
    const everyCasts = Number(config.everyCasts) || 0;
    if (everyCasts > 0) {
      // Forced cadence: SATED/timer pre-checks bypassed (REQ-17 scenario 3).
      if ((ctx.castsSinceFood || 0) >= everyCasts) return { fire: true, reason: 'every-casts', force: true };
      return { fire: false, reason: 'waiting-casts' };
    }
    const fs = readFoodState();
    if (fs.eat === true) return { fire: true, reason: fs.source, force: false };
    if (fs.eat === false) return { fire: false, reason: 'sated' };
    // SATED + timer both unavailable => fallback interval (default 10s).
    const elapsed = now() - (ctx.lastEatAt || 0);
    if (elapsed >= (config.fallbackIntervalSec || 10) * 1000) {
      return { fire: true, reason: 'fallback-interval', force: false };
    }
    return { fire: false, reason: 'fallback-wait' };
  }

  /**
   * Execute the eat attempt (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {object} ctx - tick context (mutated: castsSinceFood / lastEatAt)
   * @param {{force?: boolean}} decision - decided attempt (force = cadence mode)
   * @returns {boolean} true when the attempt executed
   */
  function fire(ctx = {}, decision = {}) {
    const item = resolveFoodItem();
    const res = eater.eatFood(item, { force: decision.force === true });
    if (decision.force === true) ctx.castsSinceFood = 0; // forced cadence resets after the attempt (userscript semantics)
    if (res.result === 'ate') ctx.lastEatAt = now();
    return res.result === 'ate';
  }

  /** @returns {object} module state (pause/alert surfacing, REQ-17) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      paused: eater.isPaused(),
      failures: eater.getFailures(),
      alert: state.alert,
      lastEatAt: state.lastEatAt,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  return { decide, fire, getState, isEnabled };
}

module.exports = { createEatModule };

return module.exports;
})();

__mbModules['agent/modules/trade'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

return module.exports;
})();

__mbModules['agent/modules/loot'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Auto-loot list module (REQ-19, design "Loot" row, task 5.2).
 *
 * Ports the game's Hub -> Automations "Auto-Loot List" model: a destination
 * PER MONSTER plus a default destination for "everything without its own
 * destination" (mirror the game's Loot List, obs 10312). v1 = configuration
 * + decision module: when a monster is killed and loot is available, the
 * module routes the loot to the configured destination.
 *
 * - `route(monster)` (pure): per-monster destination wins; otherwise the
 *   default destination; none configured => no route (recorded, no fire).
 * - Kill feed: `observeKills(kills)` consumes kill observations from the
 *   shared active-creature diff observer (core/kills); only kills WITH loot
 *   info (`loot === true`) enter the bounded pending queue.
 * - Fire path: the game's loot-command surface is FEATURE-DETECTED
 *   (unprobed — tools/automations-probe.js 5.2 dumps candidates). When the
 *   surface is absent the module records "no native loot command" (honest
 *   panel state) and never invokes anything — degrade = record/no-op.
 * - Premium gate (REQ-22): the game's auto-loot is premium-gated; an
 *   explicit non-premium account reports "Premium required" and never fires.
 *   Unknown premium state never blocks.
 *
 * fire() runs ONLY inside a queue-dispatched closure (REQ-12 no-bypass).
 */

const PENDING_CAP = 50;

/**
 * Create the loot routing module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized loot config
 *   { on: boolean, defaultDest: string|null, perMonster: Object<string,string> }
 * @param {() => Function|null} [opts.readLootCommand] - feature-detected game
 *   loot-command function (monster, destination) => void; null = unavailable
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   route: (monster: string) => {dest: string|null, source: string},
 *   observeKills: (kills: Array<{name: string|null, loot: boolean|null}>) => void,
 *   decide: () => {fire: boolean, reason: string, item?: object, route?: object},
 *   fire: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createLootModule(opts = {}) {
  const { config, readLootCommand = null, readPremium = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  const state = {
    pending: [],
    available: true,
    reason: 'ok',
    lastRouted: null,
  };

  /** Eager premium read (REQ-22): panel-facing state computed on getState. */
  function currentPremium() {
    const p = typeof readPremium === 'function' ? readPremium() : null;
    return {
      gated: p ? p.gated : true,
      active: p ? p.active : null,
      blocked: Boolean(p && p.active === false),
    };
  }

  /**
   * Pure destination resolution (REQ-19): per-monster first, then the default
   * ("everything without its own destination"), else none.
   * @param {string} monster - killed monster name
   * @returns {{dest: string|null, source: 'per-monster'|'default'|'none'}}
   */
  function route(monster) {
    const name = String(monster || '');
    if (!name) return { dest: null, source: 'none' };
    const per = config && config.perMonster && config.perMonster[name];
    if (typeof per === 'string' && per.trim()) return { dest: per, source: 'per-monster' };
    const def = config && config.defaultDest;
    if (typeof def === 'string' && def.trim()) return { dest: def, source: 'default' };
    return { dest: null, source: 'none' };
  }

  /**
   * Consume kill observations (from the shared kill observer, core/kills).
   * Only kills WITH loot info (`loot === true`) can be routed; the pending
   * queue is bounded so a spammy feed cannot grow unboundedly.
   * @param {Array<{name: string|null, loot: boolean|null}>} kills
   */
  function observeKills(kills = []) {
    if (!Array.isArray(kills)) return;
    for (const kill of kills) {
      if (!kill || kill.loot !== true) continue; // no loot info => nothing to route
      const monster = kill.name || 'unknown';
      if (state.pending.some((p) => p.monster === monster && p.at === kill.at)) continue;
      state.pending.push({ monster, at: now() });
      if (state.pending.length > PENDING_CAP) state.pending.shift();
    }
  }

  /**
   * Pure decision: pending routable kill + a configured destination -> fire.
   * @returns {{fire: boolean, reason: string, item?: object, route?: object}}
   */
  function decide() {
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const premium = currentPremium();
    if (premium.blocked) {
      state.reason = 'premium-required';
      return { fire: false, reason: 'premium-required' };
    }
    if (state.available === false) return { fire: false, reason: 'no-native-loot-command' };
    if (state.pending.length === 0) return { fire: false, reason: 'no-pending' };
    const item = state.pending[0];
    const r = route(item.monster);
    if (!r.dest) return { fire: false, reason: 'no-destination' };
    state.reason = 'ok';
    return { fire: true, reason: 'routed', item, route: r };
  }

  /**
   * Execute the loot route (QUEUE-DISPATCHED ONLY, REQ-12). Degrade: no
   * native loot command => record + no-op, and the module stops deciding
   * (honest panel state; no re-enqueue churn). On success the pending item
   * drains.
   * @param {{item: {monster: string}, route: {dest: string}}} decision
   * @returns {boolean} true when the game loot command executed
   */
  function fire(decision = {}) {
    const cmd = typeof readLootCommand === 'function' ? readLootCommand() : null;
    if (typeof cmd !== 'function') {
      state.available = false;
      state.reason = 'no native loot command';
      error('loot: no native loot command surface — routing skipped (degrade)');
      return false;
    }
    state.available = true;
    state.reason = 'ok';
    const item = decision.item || {};
    try {
      cmd(item.monster, decision.route && decision.route.dest);
      state.pending.shift();
      state.lastRouted = { monster: item.monster, dest: decision.route && decision.route.dest, at: now() };
      return true;
    } catch (e) {
      error('loot: loot command failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const per = config && config.perMonster && typeof config.perMonster === 'object' ? config.perMonster : {};
    return {
      on: Boolean(config && config.on === true),
      available: config && config.on === true ? state.available : false,
      reason: config && config.on === true ? state.reason : 'off',
      defaultDest: (config && config.defaultDest) || null,
      perMonsterCount: Object.keys(per).length,
      pendingCount: state.pending.length,
      lastRouted: state.lastRouted,
      premium: currentPremium(),
    };
  }

  return { route, observeKills, decide, fire, getState, isEnabled };
}

module.exports = { createLootModule, PENDING_CAP };

return module.exports;
})();

__mbModules['agent/modules/spawns'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Monster spawn maps provider (REQ-20, design "Spawns" row, task 5.3).
 *
 * Ports the game's Hub -> Automations "monster spawn maps" data read ("Pick a
 * monster to see where it spawns"): v1 is a spawn-DATA PROVIDER that
 * feature-detects the game's spawn-data structure (implementation probe —
 * tools/automations-probe.js 5.3 dumps the candidates; the game loads spawn
 * maps on demand per obs 10320) and exposes monster -> spawn locations.
 * The panel displays the provider state via the live snapshot; the ROUTES
 * consumption of spawn data is explicitly slice 6 (design: "ground-map
 * overlay NOT required in v1").
 *
 * Degrade: when the game exposes no spawn data structure, the provider
 * reports "no spawn data" in its state and the panel shows exactly that —
 * never fails, never invents locations.
 *
 * Pure node-testable: the data reader is injected; the location normalizer is
 * exported pure.
 */

/**
 * Normalize a raw spawn-data read into a canonical location list
 * [{x, y, z?}]. Accepts:
 *   - an array of {x, y} / {x, y, z} / "x,y" strings
 *   - a single {x, y} point
 * Returns [] for shaped-but-empty data; null for unshaped garbage.
 * @param {unknown} raw
 * @returns {Array<{x: number, y: number, z?: number}>|null}
 */
function normalizeSpawnLocations(raw) {
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'object') {
      const x = Number(item.x);
      const y = Number(item.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const z = Number(item.z);
        out.push(Number.isFinite(z) ? { x, y, z } : { x, y });
        continue;
      }
      if (typeof item.name === 'string' && Array.isArray(item.locations)) {
        const nested = normalizeSpawnLocations(item.locations);
        if (nested !== null) out.push(...nested);
        continue;
      }
      return null; // shaped object we cannot interpret
    }
    if (typeof item === 'string') {
      const parts = item.split(',').map((s) => Number(s.trim()));
      if (parts.length >= 2 && parts.slice(0, 3).every(Number.isFinite)) {
        out.push(parts.length >= 3 ? { x: parts[0], y: parts[1], z: parts[2] } : { x: parts[0], y: parts[1] });
        continue;
      }
      return null;
    }
    return null;
  }
  return out.length > 0 ? out : null; // shaped-but-empty => "no spawn data"
}

/**
 * Create the spawn-data provider module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized spawns config { on: boolean }
 * @param {(monster: string) => unknown} [opts.readSpawnData] - feature-detected
 *   game spawn-data reader; null return/throw = "no spawn data"
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   query: (monster: string) => object,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createSpawnsModule(opts = {}) {
  const { config, readSpawnData = null, readPremium = null, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { lastQuery: null };

  /** Eager premium read (REQ-22): panel-facing state computed on getState. */
  function currentPremium() {
    const p = typeof readPremium === 'function' ? readPremium() : null;
    return {
      gated: p ? p.gated : true,
      active: p ? p.active : null,
      blocked: Boolean(p && p.active === false),
    };
  }

  /**
   * Query the spawn locations for a monster (read-only, REQ-20). The panel
   * picker drives this via the getSpawns surface RPC; the result lands in the
   * module state so the snapshot carries it into the panel live view.
   * @param {string} monster
   * @returns {{monster: string, locations: Array<{x:number,y:number,z?:number}>|null, available: boolean, reason: string}}
   */
  function query(monster) {
    const name = String(monster || '').trim();
    if (currentPremium().blocked) {
      state.lastQuery = { monster: name, locations: null, available: false, reason: 'premium-required' };
      return state.lastQuery;
    }
    if (!name) {
      state.lastQuery = { monster: name, locations: null, available: false, reason: 'no-monster' };
      return state.lastQuery;
    }
    let locations = null;
    try {
      const raw = typeof readSpawnData === 'function' ? readSpawnData(name) : null;
      locations = normalizeSpawnLocations(raw);
    } catch (e) {
      warn('spawns: spawn data read failed: ' + (e && e.message ? e.message : e));
      locations = null;
    }
    state.lastQuery = {
      monster: name,
      locations,
      available: locations !== null,
      reason: locations !== null ? 'ok' : 'no spawn data',
    };
    return state.lastQuery;
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const last = state.lastQuery || { monster: null, locations: null, available: false, reason: 'no spawn data' };
    return {
      on: Boolean(config && config.on === true),
      available: last.available,
      reason: last.reason,
      lastQuery: last,
      premium: currentPremium(),
    };
  }

  return { query, getState, isEnabled };
}

module.exports = { createSpawnsModule, normalizeSpawnLocations };

return module.exports;
})();

__mbModules['agent/modules/huntStats'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Hunt session stats module (REQ-21, design "Hunt stats" row, task 5.4).
 *
 * Ports the game's Hub -> Automations "hunt session tracker" ("Start one to
 * track XP, gold, kills, and loot per hour", obs 10312). The module is an
 * APP-SIDE accumulator fed by agent snapshots:
 *
 *   - `accumulate(scan)` runs once per engine tick (pre-tree, read-only) and
 *     samples: XP/gold via feature-detected player counters, kills + loot via
 *     the shared active-creature diff observer (core/kills).
 *   - Per-hour rates: (current - baseline) / elapsed hours since session
 *     start. The FIRST sample anchors the baseline.
 *   - Session control from the panel: the huntStats module TOGGLE is the
 *     session start/stop control (ON = start, OFF = stop+freeze). The module
 *     INSTANCE survives config rebuilds (`applyConfig` transitions): an
 *     unrelated config push while ON never resets a running session; only an
 *     explicit off->on transition starts a fresh one.
 *   - Counter sources are feature-detected (open probe 5.4,
 *     tools/automations-probe.js dumps the candidates). Missing sources are
 *     recorded per-metric in `available` (honest "no data" panel state) —
 *     the tracker never invents numbers.
 *
 * Premium gate (REQ-22): the game's session tracker is premium-gated; an
 * explicit non-premium account reports "Premium required" and stops
 * accumulating. Unknown premium state never blocks.
 *
 * Pure node-testable: injected counter reader, kill observer, and clock.
 */

/**
 * Create the hunt session stats module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized huntStats config { on: boolean }
 * @param {() => {xp: number|null, gold: number|null}} [opts.readCounters] -
 *   feature-detected XP/gold counters (null metric = source absent)
 * @param {object} [opts.killObserver] - core/kills observer (scan() per tick)
 * @param {() => {gated: boolean, active: boolean|null, source: string|null}}
 *   [opts.readPremium] - premium reader (REQ-22); unknown never blocks
 * @param {() => number} [opts.now=Date.now] - injectable clock (epoch ms)
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   accumulate: (scan: {kills: Array<object>, available: boolean}) => void,
 *   startSession: () => void,
 *   stopSession: () => void,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createHuntStats(opts = {}) {
  let config = opts.config; // mutable: applyConfig drives session transitions
  const { readCounters = null, killObserver = null, readPremium = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = {
    running: false,
    startedAt: 0,
    baseline: null,
    last: null, // {xp, gold, kills, loot, at}
    killTotals: { kills: 0, loot: 0 }, // accumulates scan DELTAS (see accumulate)
    totals: null, // {xp, gold, kills, loot} | null metric
    perHour: null, // {xp, gold, kills, loot} | null metric
    frozen: false,
    available: { xp: false, gold: false, kills: false, loot: false },
    lastSampleAt: 0,
  };

  /** Eager premium read (REQ-22): panel-facing state computed on getState. */
  function currentPremium() {
    const p = typeof readPremium === 'function' ? readPremium() : null;
    return {
      gated: p ? p.gated : true,
      active: p ? p.active : null,
      blocked: Boolean(p && p.active === false),
    };
  }

  /**
   * Sample the current raw counters + kill feed. Every metric is
   * feature-detected; absent sources yield null (never invented).
   * @param {{kills: Array<object>, available: boolean}} scan - kill observer scan
   * @returns {{xp: number|null, gold: number|null, kills: number|null, loot: number|null, at: number}}
   */
  function sample(scan) {
    const counters = typeof readCounters === 'function' ? readCounters() : null;
    const xpRaw = counters && counters.xp;
    const goldRaw = counters && counters.gold;
    // null/undefined counters mean the SOURCE is absent (never coerce: Number(null) === 0).
    const xp = (xpRaw !== null && xpRaw !== undefined && Number.isFinite(Number(xpRaw))) ? Number(xpRaw) : null;
    const gold = (goldRaw !== null && goldRaw !== undefined && Number.isFinite(Number(goldRaw))) ? Number(goldRaw) : null;
    const scanAvailable = Boolean(scan && scan.available && Array.isArray(scan.kills));
    const kills = scanAvailable ? scan.kills.length : null;
    // Loot v1 approximation (documented): counts kills whose entry carries
    // loot:true. Entries without a loot field (unprobed shape — probe 5.4
    // dumps the activeCreature entry keys) count 0. The source-level degrade
    // ("no kill data") covers an absent activeCreatures array.
    const loot = scanAvailable ? scan.kills.filter((k) => k && k.loot === true).length : null;
    return { xp, gold, kills, loot, at: now() };
  }

  /** Start a hunt session (panel toggle ON). The next sample anchors the baseline. */
  function startSession() {
    state.running = true;
    state.frozen = false;
    state.baseline = null;
    state.killTotals = { kills: 0, loot: 0 };
    state.startedAt = now();
  }

  /** Stop the session (panel toggle OFF): stats freeze at the stop point (REQ-21). */
  function stopSession() {
    state.running = false;
    state.frozen = true;
  }

  /**
   * Per-tick accumulation (READ-ONLY, runs pre-tree in the agent tick).
   *
   * Two measurement families (documented):
   *   - XP/gold are ABSOLUTE counters -> totals = current - baseline.
   *   - kills/loot come from the shared kill observer whose scan() returns
   *     DELTAS (creature disappearances since the last scan) -> totals
   *     ACCUMULATE the scan deltas; per-hour = accumulated / elapsed hours.
   *
   * On stop the last computed snapshot stays frozen (REQ-21).
   * @param {{kills: Array<object>, available: boolean}} scan
   */
  function accumulate(scan) {
    if (!state.running) return;
    if (currentPremium().blocked) {
      state.running = false;
      state.frozen = true; // frozen at the premium-block point, REQ-22
      return;
    }
    const s = sample(scan);
    state.lastSampleAt = s.at;
    // Kill/loot deltas accumulate regardless of the baseline state.
    if (s.kills !== null) state.killTotals.kills += s.kills;
    if (s.loot !== null) state.killTotals.loot += s.loot;
    if (!state.baseline) {
      state.baseline = s; // first sample anchors the XP/gold baseline
      state.available = {
        xp: s.xp !== null, gold: s.gold !== null, kills: s.kills !== null, loot: s.loot !== null,
      };
      return;
    }
    const base = state.baseline;
    // Elapsed hours; floored at 1 second so a same-tick rate cannot blow up
    // to infinity (REQ-21 "per hour" semantics; sub-hour windows scale the
    // rate accordingly, e.g. 0.5h doubles it).
    const hours = Math.max(1 / 3600000, (s.at - state.startedAt) / 3600000);
    const xp = s.xp !== null && base.xp !== null ? s.xp - base.xp : null;
    const gold = s.gold !== null && base.gold !== null ? s.gold - base.gold : null;
    // Kill/loot totals show ONLY while the kill source is live (honest
    // degrade: an absent activeCreatures array reports "no data", never 0).
    state.totals = {
      xp,
      gold,
      kills: s.kills !== null ? state.killTotals.kills : null,
      loot: s.loot !== null ? state.killTotals.loot : null,
    };
    state.perHour = {
      xp: xp !== null ? xp / hours : null,
      gold: gold !== null ? gold / hours : null,
      kills: s.kills !== null ? state.killTotals.kills / hours : null,
      loot: s.loot !== null ? state.killTotals.loot / hours : null,
    };
    state.available = {
      xp: xp !== null,
      gold: gold !== null,
      kills: s.kills !== null,
      loot: s.loot !== null,
    };
    state.last = s;
  }

  /**
   * Config transition (the bootstrap calls this on EVERY rebuild; the module
   * INSTANCE survives rebuilds so accumulated stats persist):
   *   - off -> on : a hunt session STARTS (fresh baseline).
   *   - on -> off : the session STOPS (stats freeze at the stop point,
   *     REQ-21).
   *   - on -> on : unrelated config pushes do NOT reset the running session.
   * @param {object} next - normalized huntStats config
   */
  function applyConfig(next) {
    const wasOn = Boolean(config && config.on === true);
    const isOn = Boolean(next && next.on === true);
    config = next || { on: false };
    if (isOn && !state.running) startSession();
    else if (!isOn && state.running) stopSession();
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    return {
      on: Boolean(config && config.on === true),
      running: state.running,
      startedAt: state.startedAt,
      frozen: state.frozen,
      totals: state.totals,
      perHour: state.perHour,
      available: state.available,
      lastSampleAt: state.lastSampleAt,
      premium: currentPremium(),
    };
  }

  // Construction with the toggle ON = a hunt session in progress (the panel
  // toggle is the start control; applyConfig drives later transitions).
  if (config && config.on === true) startSession();

  return { accumulate, applyConfig, startSession, stopSession, getState, isEnabled };
}

module.exports = { createHuntStats };

return module.exports;
})();

__mbModules['agent/modules/echo'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Echo validation module (REQ-24, design "Echo" row, task 5.6).
 *
 * Carries the PROVEN userscript validation mechanism into the agent:
 * src/core/validation.js (echo state machine, 2500ms window / 100ms poll) +
 * src/adapters/chat.js (Default-channel-first reads) — unchanged semantics:
 *
 *   - After a WORDS-PATH fire (a slot whose config carries a `word` — the
 *     game echoes the player's own typed word in the Default channel), the
 *     agent polls for a new {name === player.name, message matching word}
 *     entry within 2500ms (poll 100ms).
 *   - pass -> counter increments (log).
 *   - miss -> logged + the counter increments; NEVER refires (the validator
 *     has no fire path by construction).
 *   - skip -> when the firing path produces no echo (no `word` configured —
 *     direct cast), validation is skipped entirely (REQ-24).
 *
 * Non-blocking: all timing flows through the validator's injectable
 * schedule/clear/now; the engine tick never waits on it.
 *
 * Wire: bootstrap calls `startForFire(fireId, word)` from the heal-magic and
 * training queue closures when their config carries a word.
 */

const VALID_MOD = require('core/validation');
const CHAT_MOD = require('adapters/chat');

/**
 * Create the echo validation module.
 *
 * @param {object} opts
 * @param {() => string|null} [opts.playerName] - current player name accessor
 * @param {object|null} [opts.gameClient] - page gameClient (chat reads)
 * @param {Document|null} [opts.document] - page DOM (chat DOM fallback)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {(fn: () => void, ms: number) => object} [opts.schedule=setTimeout]
 * @param {(handle: object) => void} [opts.clear=clearTimeout]
 * @param {{error?: Function, warn?: Function, info?: Function}} [opts.log]
 * @returns {{
 *   startForFire: (fireId: string, word: string) => string,
 *   getState: () => object,
 * }}
 */
function createEchoModule(opts = {}) {
  const {
    playerName = () => null,
    gameClient = null,
    document: doc = null,
    now = Date.now,
    schedule = (typeof setTimeout === 'function' ? setTimeout : null),
    clear = (typeof clearTimeout === 'function' ? clearTimeout : null),
    log = {},
  } = opts;
  const info = typeof log.info === 'function' ? log.info : () => {};
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { passes: 0, misses: 0, active: false, lastResult: null, lastWord: null };

  /** Proven userscript matcher (build-userscript.js buildValidator):
   *  own message + exact word match, or /regex/ form. */
  function matchesWord(entry, word) {
    if (!entry || entry.name !== playerName()) return false;
    const trimmed = String(word || '').trim();
    if (!trimmed) return false;
    const m = trimmed.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]).test(entry.message); } catch (e) { return false; }
    }
    return entry.message === trimmed;
  }

  const validator = VALID_MOD.createValidator({
    windowMs: 2500, // REQ-24: echo window
    pollMs: 100,    // REQ-24: poll cadence
    enabled: true,
    now: now,       // injectable clock (non-blocking, deterministic tests)
    schedule: schedule,
    clear: clear,
    getCandidates: function () {
      return CHAT_MOD.getRecentMessages({ gameClient: gameClient, document: doc }); // channel-first (REQ-24)
    },
    isMatch: function (entry) { return matchesWord(entry, state.lastWord); },
    onResult: function (r) {
      state.active = false;
      state.lastResult = r.result;
      if (r.result === 'pass') {
        state.passes += 1;
        info('echo ok: ' + r.fireId);
      } else if (r.result === 'miss') {
        state.misses += 1; // REQ-24: miss MUST log + increment; NO refire
        warn('echo miss: ' + r.fireId + ' (REQ-24, no refire)');
      }
    },
  });

  /**
   * Start validating the echo for a words-path fire. Skips entirely when the
   * word is empty (no echo path — direct cast, REQ-24).
   * @param {string} fireId - fired action identifier (log/counter label)
   * @param {string} word - configured word (or /regex/)
   * @returns {string} validator state ('passing' | 'disabled')
   */
  function startForFire(fireId, word) {
    const trimmed = String(word || '').trim();
    if (!trimmed) {
      validator.dispose();
      return 'disabled'; // no echo path — skip (REQ-24)
    }
    state.lastWord = trimmed;
    state.active = true;
    return validator.start(fireId);
  }

  /** @returns {object} module state (snapshot -> panel live state) */
  function getState() {
    const v = validator.getState();
    return {
      active: state.active,
      passes: state.passes,
      misses: state.misses,
      lastResult: state.lastResult,
      lastWord: state.lastWord,
      validatorState: v.state,
      deadline: v.deadline,
    };
  }

  return { startForFire, getState };
}

module.exports = { createEchoModule };

return module.exports;
})();

__mbModules['agent/modules/learning'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

const DEDUPE_MOD = require('core/dedupe');
const CHAT_MOD = require('adapters/chat');

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

return module.exports;
})();

__mbModules['agent/modules/antibot'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
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

const CHAT_MOD = require('adapters/chat');

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

return module.exports;
})();

__mbModules['agent/modules/routes'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Routes v1 (REQ-23, design "Routes v1" row, tasks 6.1/6.2).
 *
 * v1 is a NATIVE AUTOWALK integration, not a route editor:
 *  - STATE READ (MUST): reads the game's own pathfinder autowalk fields
 *    (live-probed, obs 10320 — world.pathfinder):
 *      __isAutoWalking, __autoWalkStepsRemaining, __autowalkStartPosition,
 *      __minimapWaypoints.
 *    The panel shows remaining steps + destination; when the pathfinder is
 *    absent the module reports "no pathfinder data" (honest panel state,
 *    never invents data).
 *  - WALK-TO (SHOULD): issues walk-to ONLY through the native autowalk
 *    primitive (world.pathfinder.pathTo — the probed walk-to entry; never
 *    synthetic per-step input, REQ-23). The fire runs ONLY inside a
 *    queue-dispatched closure (REQ-12 movement no-bypass).
 *  - ROUTE RECORDING is explicitly FUTURE (REQ-23: "not v1"): the module
 *    exposes recording: 'future' and has NO recording surface; the panel
 *    marks it FUTURE in the UI.
 *
 * Not premium-gated: walking/autowalk state is not a gated automation
 * (REQ-22 keeps other modules functional; native walking is available to
 * every account).
 *
 * Pure node-testable: the pathfinder reader is injected; all normalization
 * is local.
 */

/**
 * Normalize walk-to coordinates: finite numbers only. null/undefined and
 * empty strings are rejected (Number(null) === 0 and Number('') === 0
 * would otherwise turn a missing input into a walk-to (0, 0)).
 * @param {unknown} x
 * @param {unknown} y
 * @returns {{x: number, y: number}|null}
 */
function normalizeCoords(x, y) {
  if (x === null || x === undefined || y === null || y === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  if (typeof y === 'string' && y.trim() === '') return null;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}

/** Walk-to method candidates on the pathfinder (probed surface, obs 10320). */
const WALK_TO_METHODS = ['pathTo', 'walkTo'];

/**
 * Resolve the native walk-to method on a pathfinder object.
 * @param {object} pf
 * @returns {Function|null}
 */
function resolveWalkToMethod(pf) {
  if (!pf || typeof pf !== 'object') return null;
  for (const name of WALK_TO_METHODS) {
    if (typeof pf[name] === 'function') return pf[name];
  }
  return null;
}

/**
 * Create the routes v1 module.
 *
 * @param {object} opts
 * @param {object} opts.config - normalized routes config { on: boolean }
 * @param {() => object|null} [opts.readPathfinder] - live-probed
 *   world.pathfinder accessor (obs 10320); null = "no pathfinder data"
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decideWalkTo: (x: unknown, y: unknown) => object,
 *   fireWalk: (decision: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createRoutesModule(opts = {}) {
  const { config, readPathfinder = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};

  const state = { lastWalkTo: null };

  /** Live pathfinder (lazy reader, feature-detected). */
  function pathfinder() {
    try {
      const pf = typeof readPathfinder === 'function' ? readPathfinder() : null;
      return pf && typeof pf === 'object' ? pf : null;
    } catch (e) {
      warn('routes: pathfinder read failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /**
   * Read the native autowalk state (all fields feature-detected).
   * @param {object|null} pf
   * @returns {object} canonical state shape
   */
  function readAutowalkState(pf) {
    if (!pf) {
      return {
        available: false,
        reason: 'no pathfinder data',
        isAutoWalking: false,
        stepsRemaining: null,
        startPosition: null,
        destination: null,
        waypoints: null,
      };
    }
    let stepsRemaining = null;
    if (pf.__autoWalkStepsRemaining !== undefined && pf.__autoWalkStepsRemaining !== null) {
      const n = Number(pf.__autoWalkStepsRemaining);
      if (Number.isFinite(n)) stepsRemaining = Math.max(0, Math.floor(n));
    }
    let startPosition = null;
    if (pf.__autowalkStartPosition && typeof pf.__autowalkStartPosition === 'object') {
      const x = Number(pf.__autowalkStartPosition.x);
      const y = Number(pf.__autowalkStartPosition.y);
      if (Number.isFinite(x) && Number.isFinite(y)) startPosition = { x, y };
    }
    let destination = null;
    if (Array.isArray(pf.__minimapWaypoints) && pf.__minimapWaypoints.length > 0) {
      const last = pf.__minimapWaypoints[pf.__minimapWaypoints.length - 1];
      if (last && typeof last === 'object') {
        const x = Number(last.x);
        const y = Number(last.y);
        if (Number.isFinite(x) && Number.isFinite(y)) destination = { x, y };
      }
    }
    return {
      available: true,
      reason: 'ok',
      isAutoWalking: pf.__isAutoWalking === true,
      stepsRemaining,
      startPosition,
      destination,
      waypoints: Array.isArray(pf.__minimapWaypoints) ? pf.__minimapWaypoints : null,
    };
  }

  /**
   * Decide a walk-to (REQ-23): native autowalk ONLY. The decision carries
   * the resolved native method; the bootstrap enqueues the fire closure
   * (REQ-12 no-bypass).
   * @param {unknown} x
   * @param {unknown} y
   * @returns {{fire: boolean, reason: string, x?: number, y?: number, method?: Function}}
   */
  function decideWalkTo(x, y) {
    if (!config || config.on !== true) return { fire: false, reason: 'off', x, y };
    const coords = normalizeCoords(x, y);
    if (!coords) return { fire: false, reason: 'invalid-coordinates', x, y };
    const pf = pathfinder();
    if (!pf) return { fire: false, reason: 'no pathfinder data', x: coords.x, y: coords.y };
    const method = resolveWalkToMethod(pf);
    if (!method) return { fire: false, reason: 'no walk-to method', x: coords.x, y: coords.y };
    return { fire: true, reason: 'native-autowalk', method, x: coords.x, y: coords.y };
  }

  /**
   * Fire the native walk-to (QUEUE-DISPATCHED ONLY, REQ-12).
   * @param {{x: number, y: number, method?: Function}} decision
   * @returns {boolean} true when the native call executed
   */
  function fireWalk(decision) {
    // Only a decided walk-to may fire (toggle OFF / invalid / degrade
    // decisions never reach the game — defense-in-depth on top of the
    // RPC's early return).
    if (!decision || decision.fire !== true) return false;
    if (!Number.isFinite(Number(decision.x)) || !Number.isFinite(Number(decision.y))) return false;
    const pf = pathfinder();
    const method = decision.method || (pf ? resolveWalkToMethod(pf) : null);
    if (!pf || !method) return false;
    try {
      method.call(pf, decision.x, decision.y);
      state.lastWalkTo = { x: decision.x, y: decision.y, at: now() };
      return true;
    } catch (e) {
      warn('routes: native walk-to failed: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return Boolean(config && config.on === true);
  }

  /** @returns {object} module state (snapshot -> panel live state, REQ-23) */
  function getState() {
    const pf = pathfinder();
    const autowalk = readAutowalkState(pf);
    const walkMethod = pf ? resolveWalkToMethod(pf) : null;
    return Object.assign({}, autowalk, {
      on: Boolean(config && config.on === true),
      walkTo: {
        available: walkMethod !== null,
        reason: !pf ? 'no pathfinder data' : (walkMethod ? 'ok' : 'no walk-to method'),
        method: walkMethod ? (walkMethod.name || 'native') : null,
      },
      lastWalkTo: state.lastWalkTo,
      // REQ-23: full route recording/editing is explicitly FUTURE (not v1).
      recording: 'future',
    });
  }

  return { decideWalkTo, fireWalk, getState, isEnabled };
}

module.exports = { createRoutesModule, normalizeCoords, resolveWalkToMethod };

return module.exports;
})();

__mbModules['agent/modules/attack'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Attack skeleton (REQ-35, design D10, task 6.1).
 *
 * ATTACK is a STATE-ONLY SKELETON in this slice:
 *  - Targeting choice (lowest HP / nearest; native ACTIONS) and offensive
 *    spell/rune pickers are CONFIG — the panel renders them, the config
 *    shape carries them (forward-compat with the full combat slice).
 *  - `skeleton: true` + disclosure "skeleton — limited": the module performs
 *    NO full combat loop (no tree node, no queue dispatch, no game calls —
 *    D10: "no tree loop"). The combat behavior slice lands later and wires
 *    the targeting decision into the tree.
 *
 * Pure node-testable: all normalization is local and exported for reuse by
 * the future combat slice.
 */

/** Targeting choices (REQ-35: "lowest HP / nearest"; native ACTIONS). */
const TARGETING_OPTIONS = ['lowest-hp', 'nearest'];

/** Default targeting when the config value is absent/invalid. */
const DEFAULT_TARGETING = 'lowest-hp';

/**
 * Normalize the targeting choice: only the known options pass through,
 * anything else (including undefined/null) falls back to the default —
 * a bad config never crashes the module.
 * @param {unknown} value
 * @returns {string} 'lowest-hp' | 'nearest'
 */
function normalizeTargeting(value) {
  return TARGETING_OPTIONS.indexOf(value) !== -1 ? value : DEFAULT_TARGETING;
}

/**
 * Normalize an offensive spell sid: non-negative integer only; anything
 * else (absent, string junk, negative) becomes null (no spell configured).
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeSid(value) {
  // Empty strings would Number() to 0 — a missing input must NOT become
  // "spell 0" (routes.js normalizeCoords guards the same trap).
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Normalize an offensive rune hotbar slot: integer 1-12 only; anything else
 * becomes null (no rune slot configured).
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeSlot(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * Create the attack skeleton module.
 *
 * @param {object} opts
 * @param {object} [opts.config] - normalized attack config
 *   { on: boolean, targeting: string, sid: number|null, runeSlot: number|null }
 * @returns {{
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createAttackModule(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};

  /**
   * Honest module state (snapshot -> panel live state, REQ-35).
   * `skeleton: true` + disclosure disclose the limited functionality;
   * `combatLoop: false` states plainly that no full combat loop runs.
   * @returns {object}
   */
  function getState() {
    return {
      skeleton: true,
      disclosure: 'skeleton — limited',
      on: config.on === true,
      targeting: normalizeTargeting(config.targeting),
      spell: { sid: normalizeSid(config.sid) },
      rune: { slot: normalizeSlot(config.runeSlot) },
      combatLoop: false, // REQ-35: no full combat loop in the skeleton
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return config.on === true;
  }

  return { getState, isEnabled };
}

module.exports = {
  createAttackModule,
  normalizeTargeting,
  normalizeSid,
  normalizeSlot,
  TARGETING_OPTIONS,
  DEFAULT_TARGETING,
};

return module.exports;
})();

__mbModules['agent/modules/cavebot'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Cavebot skeleton (REQ-36, design D10, task 6.2).
 *
 * CAVEBOT is a STATE-ONLY SKELETON in this slice:
 *  - RECORD: throttled position snapshots into a SESSION-scoped buffer
 *    (state.timers — survives config rebuilds, resets on agent restart).
 *    The bootstrap recording loop calls record() on a cadence; the module
 *    enforces the throttle (min gap between points) + dedupe + a cap.
 *  - SAVE: the recorded waypoints land in `config.routes` (the character
 *    config's top-level route list) via the panel save flow.
 *  - PAUSE: `config.paused` flag (panel-pushed) — a paused bot refuses
 *    start.
 *  - START: from the NEAREST recorded waypoint (euclidean min, pure
 *    helper below) via the game's NATIVE autowalk primitive — the
 *    bootstrap enqueues the walk (REQ-12 no-bypass), never synthetic input.
 *  - OBJECT DETECT: feature-detected reader (injected); when the game
 *    surface is absent the module reports honest "no object surface"
 *    state — the walk-to-object action stays a no-op state (open probe).
 *  - EDITING: explicitly FUTURE (REQ-36: full route editing is not v1).
 *  - `skeleton: true` + disclosure "skeleton — limited": no tree loop, no
 *    continuous auto-walking (D10: state only).
 *
 * Pure node-testable: the position/object readers are injected; all
 * normalization + the nearest-waypoint math are local.
 */

/** Recorded waypoint cap (oldest dropped first — bounded session memory). */
const MAX_ROUTE_POINTS = 500;

/** Default minimum gap between recorded snapshots (ms). */
const DEFAULT_RECORD_INTERVAL_MS = 1000;

/**
 * Normalize a position/waypoint: finite numbers only. null/undefined and
 * empty strings are rejected (Number(null) === 0 and Number('') === 0 would
 * otherwise turn a missing input into the origin — same trap routes.js
 * guards in normalizeCoords).
 * @param {unknown} p
 * @returns {{x: number, y: number}|null}
 */
function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const { x, y } = p;
  if (x === null || x === undefined || y === null || y === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  if (typeof y === 'string' && y.trim() === '') return null;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}

/**
 * Sanitize a saved route list: every entry normalizes to a finite {x, y}
 * point; junk entries are dropped (never crash, never a bogus waypoint).
 * @param {unknown} list
 * @returns {Array<{x: number, y: number}>}
 */
function sanitizeRouteList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const p = normalizePoint(entry);
    if (p) out.push(p);
    if (out.length >= MAX_ROUTE_POINTS) break;
  }
  return out;
}

/**
 * Euclidean distance between two points.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
function euclideanDistance(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

/**
 * Nearest waypoint to a position (REQ-36: "start from the nearest recorded
 * waypoint" — euclidean min). Tie-breaks to the FIRST nearest waypoint
 * (stable). Empty/unusable inputs -> null.
 * @param {{x: number, y: number}|null} position
 * @param {Array<{x: number, y: number}>} waypoints
 * @returns {{index: number, waypoint: {x: number, y: number}, distance: number}|null}
 */
function nearestWaypoint(position, waypoints) {
  const pos = normalizePoint(position);
  if (!pos || !Array.isArray(waypoints) || waypoints.length === 0) return null;
  let best = null;
  for (let i = 0; i < waypoints.length; i += 1) {
    const wp = normalizePoint(waypoints[i]);
    if (!wp) continue;
    const d = euclideanDistance(pos, wp);
    if (best === null || d < best.distance) best = { index: i, waypoint: wp, distance: d };
  }
  return best;
}

/**
 * Create the cavebot skeleton module.
 *
 * @param {object} opts
 * @param {object} [opts.config] - normalized cavebot config
 *   { on: boolean, paused: boolean, route: Array<{x,y}> }
 *   (route = the saved route list; panel-saved into config.routes)
 * @param {() => {x: number, y: number}|null} [opts.readPosition] - live
 *   player position reader (feature-detected; null when absent)
 * @param {() => Array<object>|null} [opts.readObjects] - live ground-object
 *   list reader (open probe: object-walk stays a no-op state)
 * @param {object} [opts.timers] - session-scoped state container (survives
 *   config rebuilds; the recording buffer lives here)
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {number} [opts.recordIntervalMs=1000] - min gap between snapshots
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   startRecording: () => object,
 *   stopRecording: () => object,
 *   isRecording: () => boolean,
 *   record: (point: unknown) => object,
 *   decideStart: () => object,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createCavebotModule(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const readPosition = typeof opts.readPosition === 'function' ? opts.readPosition : null;
  const readObjects = typeof opts.readObjects === 'function' ? opts.readObjects : null;
  const timers = opts.timers && typeof opts.timers === 'object' ? opts.timers : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const recordIntervalMs = Number.isFinite(Number(opts.recordIntervalMs))
    ? Math.max(0, Number(opts.recordIntervalMs))
    : DEFAULT_RECORD_INTERVAL_MS;
  const warn = typeof opts.log === 'object' && typeof opts.log.warn === 'function'
    ? opts.log.warn : () => {};

  // Session-scoped recording state (survives config rebuilds within the
  // session; agent restart = new session = fresh route buffer).
  if (!timers.cavebotRoute || typeof timers.cavebotRoute !== 'object') {
    timers.cavebotRoute = { recording: false, startedAt: null, points: [] };
  }
  const session = timers.cavebotRoute;

  /** Saved route (normalized waypoint list from the config). */
  function savedRoute() {
    return sanitizeRouteList(config.route);
  }

  /**
   * Start route recording. The bootstrap arms the recording loop on ok.
   * @returns {{ok: boolean, reason?: string}}
   */
  function startRecording() {
    if (session.recording) return { ok: false, reason: 'already-recording' };
    session.recording = true;
    session.startedAt = now();
    return { ok: true, startedAt: session.startedAt };
  }

  /** @returns {boolean} whether the recording loop should keep running */
  function isRecording() {
    return session.recording === true;
  }

  /**
   * Stop route recording and return the recorded waypoints (plain {x,y}
   * entries — the shape that saves into config.routes). The buffer resets
   * for the next recording session.
   * @returns {{ok: boolean, reason?: string, points?: Array<{x: number, y: number}>}}
   */
  function stopRecording() {
    if (!session.recording) return { ok: false, reason: 'not-recording' };
    session.recording = false;
    const points = session.points.map((p) => ({ x: p.x, y: p.y }));
    session.points = [];
    session.startedAt = null;
    return { ok: true, points, count: points.length };
  }

  /**
   * Record one position snapshot (called by the bootstrap recording loop).
   * The throttle: a point lands only when it differs from the last one AND
   * the min gap (recordIntervalMs) has passed — position snapshots are
   * throttled, never a raw firehose (REQ-36 "throttled position snapshots").
   * @param {unknown} point
   * @returns {{recorded: boolean, reason: string, count?: number}}
   */
  function record(point) {
    if (!session.recording) return { recorded: false, reason: 'not-recording' };
    const p = normalizePoint(point);
    if (!p) return { recorded: false, reason: 'invalid-point' };
    const t = now();
    const last = session.points[session.points.length - 1];
    if (last && last.x === p.x && last.y === p.y) return { recorded: false, reason: 'duplicate' };
    if (last && t - last.ts < recordIntervalMs) return { recorded: false, reason: 'throttled' };
    session.points.push({ x: p.x, y: p.y, ts: t });
    if (session.points.length > MAX_ROUTE_POINTS) session.points.shift();
    return { recorded: true, count: session.points.length };
  }

  /**
   * Decide the cavebot start: nearest recorded waypoint to the current
   * position (euclidean min). The walk itself is issued by the bootstrap
   * through the game's NATIVE autowalk primitive (queue-dispatched).
   * @returns {{fire: boolean, reason: string, x?: number, y?: number, index?: number, distance?: number}}
   */
  function decideStart() {
    if (config.on !== true) return { fire: false, reason: 'off' };
    if (config.paused === true) return { fire: false, reason: 'paused' };
    const route = savedRoute();
    if (route.length === 0) return { fire: false, reason: 'no-route' };
    let position = null;
    if (readPosition) {
      try { position = readPosition(); } catch (e) { position = null; }
    }
    if (!position) return { fire: false, reason: 'no-position' };
    const nw = nearestWaypoint(position, route);
    if (!nw) return { fire: false, reason: 'no-route' };
    return {
      fire: true,
      reason: 'nearest-waypoint',
      x: nw.waypoint.x,
      y: nw.waypoint.y,
      index: nw.index,
      distance: nw.distance,
    };
  }

  /** @returns {boolean} whether the module is configured ON */
  function isEnabled() {
    return config.on === true;
  }

  /**
   * Honest module state (snapshot -> panel live state, REQ-36): skeleton
   * disclosure, recording status, saved route summary, pause flag, start
   * availability and the feature-detected object-walk surface. `editing:
   * 'future'` states plainly that route editing is out of v1 scope.
   * @returns {object}
   */
  function getState() {
    const route = savedRoute();
    let objects = null;
    if (readObjects) {
      try { objects = readObjects(); } catch (e) { objects = null; }
    }
    const objectList = Array.isArray(objects) ? objects : null;
    return {
      skeleton: true,
      disclosure: 'skeleton — limited',
      on: config.on === true,
      recording: {
        active: session.recording === true,
        points: session.points.length,
        startedAt: session.startedAt,
      },
      savedRoute: {
        count: route.length,
        first: route.length > 0 ? route[0] : null,
        last: route.length > 0 ? route[route.length - 1] : null,
      },
      paused: config.paused === true,
      start: {
        available: config.on === true && config.paused !== true && route.length > 0,
        reason: config.on !== true ? 'off'
          : config.paused === true ? 'paused'
            : route.length === 0 ? 'no-route' : 'ok',
      },
      objectWalk: {
        available: objectList !== null,
        reason: objectList === null ? 'no object surface' : 'ok',
        count: objectList === null ? null : objectList.length,
      },
      // REQ-36: full route editing is explicitly FUTURE (not v1).
      editing: 'future',
    };
  }

  return { startRecording, stopRecording, isRecording, record, decideStart, getState, isEnabled };
}

module.exports = {
  createCavebotModule,
  normalizePoint,
  sanitizeRouteList,
  euclideanDistance,
  nearestWaypoint,
  MAX_ROUTE_POINTS,
  DEFAULT_RECORD_INTERVAL_MS,
};

return module.exports;
})();

__mbModules['agent/bootstrap'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * In-page agent bootstrap for the CDP-injected desktop app (REQ-04/10/11/12,
 * design D2/D3/D4).
 *
 * The engine SHAPE proven end to end:
 *
 *   gameClient + hotbarManager ready
 *        -> tree ticks in-page at jittered cadence, reads stats into ctx
 *        -> the tree executes AT MOST ONE action per tick (REQ-10)
 *        -> every action dispatches through the ONE global Action Queue
 *           (REQ-12, no bypass: game handlers are invoked ONLY inside
 *           queue-dispatched closures)
 *
 * Tree priority (REQ-11): heal items (REQ-13) > heal magic (REQ-14) >
 * legacy survival slot-heal (slices 2/3 sample leaf, retained for config
 * backward compatibility) > runes (REQ-15) > combat (rotation leaf, design
 * D4) > training (REQ-16) > eat (REQ-17) > loot (slice-5 stub).
 *
 * Slice-4 modules live in src/agent/modules/*.js — pure decision factories
 * (node-testable) wired here as tree nodes; each action enqueues a closure
 * that runs the module's game-handler call (REQ-12 no-bypass).
 *
 * Exposes window.__mbAgent with the REQ-04 surface:
 *   { readStats, readCooldown, fireSlot, eatFood, getChat,
 *     getRuneState, getWalkState, getPlayerInfo, applyConfig }
 *
 * In-page tick cadence: self-scheduling jittered setTimeout (50-400ms via
 * core/jitter), the SAME pattern the userscript uses (no Worker — the
 * desktop bot owns a dedicated visible window, REQ-04).
 */

const { createTree } = require('core/tree');
const { createQueue } = require('core/queue');
const JITTER_MOD = require('core/jitter');
const ROTATION_MOD = require('core/rotation');
const FEAS_MOD = require('core/feasibility');
const CD_MOD = require('core/cooldown');
const GC_MOD = require('adapters/gameClient');
const FIRING_MOD = require('adapters/firing');
const CHAT_MOD = require('adapters/chat');
const PREMIUM_MOD = require('core/premium');
const KILLS_MOD = require('core/kills');
const LOG_MOD = require('core/log'); // D8 (slice 1a): readable activity log ring
// Slice-4 modules (REQ-13..17) — pure decision modules, tree-wired below.
const HEAL_ITEMS_MOD = require('agent/modules/heal-items');
const HEAL_MAGIC_MOD = require('agent/modules/heal-magic');
const RUNES_MOD = require('agent/modules/runes');
const TRAINING_MOD = require('agent/modules/training');
const EAT_MODULE_MOD = require('agent/modules/eat');
// Slice-5 modules (REQ-18..22,24,25) — ported automations + carry-overs.
const TRADE_MOD = require('agent/modules/trade');
const LOOT_MOD = require('agent/modules/loot');
const SPAWNS_MOD = require('agent/modules/spawns');
const HUNT_STATS_MOD = require('agent/modules/huntStats');
const ECHO_MOD = require('agent/modules/echo');
const LEARNING_MOD = require('agent/modules/learning');
// PR5 (REQ-33/34, D9): anti-bot watcher + confirm-once chat replies — shares
// the Default-channel poll surface with echo/learning (REQ-24 MODIFIED).
const ANTIBOT_MOD = require('agent/modules/antibot');
// Slice-6 module (REQ-23): native autowalk state read + walk-to (routes v1).
const ROUTES_MOD = require('agent/modules/routes');
// PR6 (REQ-35/36, D10): state-only skeleton modules — attack targeting +
// pickers config and cavebot route record/save/pause/start; NO tree nodes.
const ATTACK_MOD = require('agent/modules/attack');
const CAVEBOT_MOD = require('agent/modules/cavebot');

/** Minimal slice-2 config shape (per-character store lands in slice 3). */
const DEFAULT_CONFIG = {
  queue: { minIntervalMs: 150 },
  jitter: { min: 50, max: 400 },
  survival: { on: true, threshold: 50, slot: null }, // legacy generic slot-heal leaf (slices 2/3 shape)
  rotation: { spells: [] },                          // combat leaf rules (userscript shape)
  // Slice-4 modules — ALL OFF by default (spec: "Optional, user-activated").
  // Shapes match app/store/characters.ts defaultConfig (slice 3) + additive
  // settings: runes.healThreshold, eat.slot, eat.cids (design extensions).
  healItems: { on: false, threshold: 50, slotCids: [] },
  healMagic: { on: false, threshold: 150, slot: null, sid: null, word: null, reserve: 0 },
  runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null, reserve: 0,
    capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
  training: { on: false, slot: null, sid: null, reserve: 0, word: null,
    eatWithMagic: { enabled: false, slot: null, sid: null } },
  eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
  // Slice-5 modules — ALL OFF by default (opt-in). Shapes match
  // app/store/characters.ts defaultConfig + additive: healMagic/training word
  // (echo validation REQ-24), learning.knownWords (REQ-25 registration).
  trade: { on: false, message: '', intervalMs: 180000 },
  loot: { on: false, defaultDest: null, perMonster: {} },
  spawns: { on: false },
  huntStats: { on: false },
  learning: { knownWords: [] },       // REQ-25: observation always runs while armed
  antibot: { on: false, replies: [] }, // PR5 (D9): anti-bot watcher + confirm-once replies (REQ-33/34)
  routes: { on: false },               // REQ-23 (slice 6): native autowalk read + walk-to; recording = FUTURE
  // PR6 (REQ-35/36, D10): state-only skeleton modules — ALL OFF by default
  // (opt-in). attack: targeting choice (lowest-hp/nearest) + offensive
  // spell/rune pickers; cavebot: pause flag + the saved route list (the
  // route lands here from the TOP-LEVEL `routes` array of the per-character
  // config — REQ-36 "save = config.routes").
  attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
  cavebot: { on: false, paused: false, route: [] },
  armed: false,                                      // interconnection gate (REQ-02, slice 3)
};

/**
 * Per-module config source (REQ-08 fix slice): the REAL app push path
 * delivers the per-character STORE shape — a NESTED `modules.<id>` object
 * (app/panel/server.ts pushes the store config unchanged; the panel's
 * buildPushConfig writes live toggles into the same nested shape). The
 * agent historically read FLAT top-level keys only, so in the real app
 * every module toggle stayed OFF. This helper merges the nested entry
 * OVER the flat one: the nested store shape WINS for the fields it
 * carries, while the flat keys (the established agent/test shape +
 * DEFAULT_CONFIG) stay the fallback when `modules` is absent or a module
 * has no nested entry. Arrays never merge — the top-level `routes` list
 * is the cavebot route DATA (REQ-36), not the routes module config.
 * @param {object} src raw config
 * @param {string} id module id
 * @returns {object} merged module source (empty when absent)
 */
function moduleSource(src, id) {
  const nested = src.modules && typeof src.modules === 'object' && !Array.isArray(src.modules)
    && src.modules[id] && typeof src.modules[id] === 'object' && !Array.isArray(src.modules[id])
    ? src.modules[id] : null;
  const flat = src[id] && typeof src[id] === 'object' && !Array.isArray(src[id]) ? src[id] : null;
  return Object.assign({}, flat || {}, nested || {});
}

/**
 * Deep-ish merge of known keys over the defaults (unknown keys dropped).
 * Module configs are read through moduleSource() (see above): the NESTED
 * per-module store shape wins per-field, flat top-level keys stay the
 * fallback — both shapes keep working (REQ-08). `queue`/`jitter` are
 * top-level in BOTH shapes (store SCOPED_KEYS; the panel never writes them
 * nested). `armed` is the REQ-02 gate flag: ONLY an explicit true arms the
 * engine — anything else leaves the agent disarmed ("not connected").
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: null, sid: null, word: null, reserve: 0 },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null, reserve: 0,
      capMode: 'strict', capFullThreshold: 1.0, fallbackSlot: null, fallbackManaPct: 0.5 },
    training: { on: false, slot: null, sid: null, reserve: 0, word: null,
      eatWithMagic: { enabled: false, slot: null, sid: null } },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
    trade: { on: false, message: '', intervalMs: 180000 },
    loot: { on: false, defaultDest: null, perMonster: {} },
    spawns: { on: false },
    huntStats: { on: false },
    learning: { knownWords: [] },
    antibot: { on: false, replies: [] },
    routes: { on: false },
    attack: { on: false, targeting: 'lowest-hp', sid: null, runeSlot: null },
    cavebot: { on: false, paused: false, route: [] },
    armed: false,
  };
  if (Number.isFinite(src.queue && src.queue.minIntervalMs) && src.queue.minIntervalMs >= 0) {
    cfg.queue.minIntervalMs = src.queue.minIntervalMs;
  }
  const j = JITTER_MOD.clampJitter(
    (src.jitter && src.jitter.min) || DEFAULT_CONFIG.jitter.min,
    (src.jitter && src.jitter.max) || DEFAULT_CONFIG.jitter.max,
  );
  cfg.jitter = { min: j.min, max: j.max };
  const sv = moduleSource(src, 'survival');
  if (typeof sv.on === 'boolean') cfg.survival.on = sv.on;
  if (Number.isFinite(sv.threshold)) cfg.survival.threshold = sv.threshold;
  if (Number.isInteger(sv.slot)) cfg.survival.slot = sv.slot;
  const ro = moduleSource(src, 'rotation');
  if (Array.isArray(ro.spells)) {
    cfg.rotation.spells = ro.spells.filter((s) => s && typeof s === 'object');
  }
  // --- Slice-4 module normalization (unknown keys dropped, invalid values default) ---
  const hi = moduleSource(src, 'healItems');
  if (typeof hi.on === 'boolean') cfg.healItems.on = hi.on;
  if (Number.isFinite(hi.threshold)) cfg.healItems.threshold = hi.threshold;
  if (Array.isArray(hi.slotCids)) cfg.healItems.slotCids = hi.slotCids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  const hm = moduleSource(src, 'healMagic');
  if (typeof hm.on === 'boolean') cfg.healMagic.on = hm.on;
  if (Number.isFinite(hm.threshold)) cfg.healMagic.threshold = hm.threshold;
  if (Number.isInteger(hm.slot)) cfg.healMagic.slot = hm.slot;
  if (Number.isInteger(hm.sid)) cfg.healMagic.sid = hm.sid;
  if (Number.isFinite(hm.reserve) && hm.reserve >= 0) cfg.healMagic.reserve = hm.reserve; // D2 (REQ-31)
  const rn = moduleSource(src, 'runes');
  if (typeof rn.on === 'boolean') cfg.runes.on = rn.on;
  if (Number.isInteger(rn.attackSlot)) cfg.runes.attackSlot = rn.attackSlot;
  if (Number.isInteger(rn.healSlot)) cfg.runes.healSlot = rn.healSlot;
  if (Number.isFinite(rn.healThreshold)) cfg.runes.healThreshold = rn.healThreshold;
  if (Number.isFinite(rn.reserve) && rn.reserve >= 0) cfg.runes.reserve = rn.reserve; // D2 (REQ-31)
  // Strict rune CAP + fallback (D3, REQ-30 — PR4): the trainer absorbs these
  // runes-module settings; invalid values fall back to the defaults.
  if (rn.capMode === 'strict' || rn.capMode === 'off') cfg.runes.capMode = rn.capMode;
  if (Number.isFinite(rn.capFullThreshold) && rn.capFullThreshold > 0 && rn.capFullThreshold <= 1) {
    cfg.runes.capFullThreshold = rn.capFullThreshold;
  }
  if (Number.isInteger(rn.fallbackSlot)) cfg.runes.fallbackSlot = rn.fallbackSlot;
  // NOTE: fallbackSid was DROPPED (post-chain maintenance, obs 10502): the
  // fallback fires SLOT-driven (fallbackSlot) like every other module; an
  // sid never resolved a slot, so carrying one implied behavior that did not
  // exist. Unknown keys are dropped by normalization anyway.
  if (Number.isFinite(rn.fallbackManaPct) && rn.fallbackManaPct >= 0 && rn.fallbackManaPct <= 1) {
    cfg.runes.fallbackManaPct = rn.fallbackManaPct;
  }
  const tr = moduleSource(src, 'training');
  if (typeof tr.on === 'boolean') cfg.training.on = tr.on;
  if (Number.isInteger(tr.slot)) cfg.training.slot = tr.slot;
  if (Number.isInteger(tr.sid)) cfg.training.sid = tr.sid;
  if (Number.isFinite(tr.reserve) && tr.reserve >= 0) cfg.training.reserve = tr.reserve;
  const ew = tr.eatWithMagic && typeof tr.eatWithMagic === 'object' ? tr.eatWithMagic : {};
  if (typeof ew.enabled === 'boolean') cfg.training.eatWithMagic.enabled = ew.enabled; // D4 (REQ-32)
  if (Number.isInteger(ew.slot)) cfg.training.eatWithMagic.slot = ew.slot;
  if (Number.isInteger(ew.sid)) cfg.training.eatWithMagic.sid = ew.sid;
  const ea = moduleSource(src, 'eat');
  if (typeof ea.on === 'boolean') cfg.eat.on = ea.on;
  if (Number.isFinite(ea.everyCasts) && ea.everyCasts >= 0) cfg.eat.everyCasts = Math.floor(ea.everyCasts);
  if (Number.isFinite(ea.warningWindowSec) && ea.warningWindowSec > 0) cfg.eat.warningWindowSec = ea.warningWindowSec;
  if (Number.isFinite(ea.fallbackIntervalSec) && ea.fallbackIntervalSec > 0) cfg.eat.fallbackIntervalSec = ea.fallbackIntervalSec;
  if (Number.isInteger(ea.slot)) cfg.eat.slot = ea.slot;
  if (Array.isArray(ea.cids)) cfg.eat.cids = ea.cids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  // --- Slice-5 module normalization (REQ-18..22,24,25) ---
  if (typeof hm.word === 'string') cfg.healMagic.word = hm.word; // echo validation (REQ-24)
  if (typeof tr.word === 'string') cfg.training.word = tr.word;   // echo validation (REQ-24)
  const td = moduleSource(src, 'trade');
  if (typeof td.on === 'boolean') cfg.trade.on = td.on;
  if (typeof td.message === 'string') cfg.trade.message = td.message;
  if (Number.isFinite(td.intervalMs) && td.intervalMs > 0) cfg.trade.intervalMs = td.intervalMs;
  const lt = moduleSource(src, 'loot');
  if (typeof lt.on === 'boolean') cfg.loot.on = lt.on;
  if (typeof lt.defaultDest === 'string') cfg.loot.defaultDest = lt.defaultDest;
  if (lt.perMonster && typeof lt.perMonster === 'object' && !Array.isArray(lt.perMonster)) {
    cfg.loot.perMonster = {};
    for (const key of Object.keys(lt.perMonster)) {
      if (typeof lt.perMonster[key] === 'string') cfg.loot.perMonster[key] = lt.perMonster[key];
    }
  }
  const sp = moduleSource(src, 'spawns');
  if (typeof sp.on === 'boolean') cfg.spawns.on = sp.on;
  const hs = moduleSource(src, 'huntStats');
  if (typeof hs.on === 'boolean') cfg.huntStats.on = hs.on;
  const le = moduleSource(src, 'learning');
  if (Array.isArray(le.knownWords)) {
    cfg.learning.knownWords = le.knownWords
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim());
  }
  // PR5 (REQ-33/34, D9): anti-bot watcher — {pattern, reply} entries with
  // non-empty trimmed parts; malformed entries are dropped (never crash).
  const ab = moduleSource(src, 'antibot');
  if (typeof ab.on === 'boolean') cfg.antibot.on = ab.on;
  if (Array.isArray(ab.replies)) {
    cfg.antibot.replies = ab.replies
      .filter((r) => r && typeof r === 'object'
        && typeof r.pattern === 'string' && r.pattern.trim()
        && typeof r.reply === 'string' && r.reply.trim())
      .map((r) => ({ pattern: r.pattern.trim(), reply: r.reply.trim() }));
  }
  const rt = moduleSource(src, 'routes');
  if (typeof rt.on === 'boolean') cfg.routes.on = rt.on;
  // PR6 (REQ-35/36, D10): skeleton module configs — attack targeting +
  // pickers; cavebot pause + saved route. The SAVED ROUTE LIST travels on
  // the per-character config at the TOP LEVEL (`routes: [...]` — the store
  // shape, REQ-36 "save = config.routes"); the flat agent/test shape may
  // also carry it as `cavebot.route`. Both normalize into cfg.cavebot.route
  // (sanitized: finite {x,y} waypoints only, junk dropped).
  const at = moduleSource(src, 'attack');
  if (typeof at.on === 'boolean') cfg.attack.on = at.on;
  cfg.attack.targeting = ATTACK_MOD.normalizeTargeting(at.targeting);
  cfg.attack.sid = ATTACK_MOD.normalizeSid(at.sid);
  cfg.attack.runeSlot = ATTACK_MOD.normalizeSlot(at.runeSlot);
  const cv = moduleSource(src, 'cavebot');
  if (typeof cv.on === 'boolean') cfg.cavebot.on = cv.on;
  if (typeof cv.paused === 'boolean') cfg.cavebot.paused = cv.paused;
  if (Array.isArray(cv.route)) cfg.cavebot.route = CAVEBOT_MOD.sanitizeRouteList(cv.route);
  if (Array.isArray(src.routes)) cfg.cavebot.route = CAVEBOT_MOD.sanitizeRouteList(src.routes);
  cfg.armed = src.armed === true; // REQ-02: only an explicit true arms
  return cfg;
}

/**
 * Create the in-page agent.
 *
 * @param {object} [opts]
 * @param {Window} [opts.win=window] - page window
 * @param {Document} [opts.document] - page document
 * @param {object} [opts.config] - initial config (defaults used when absent)
 * @param {number} [opts.pollIntervalMs=500] - readiness poll cadence
 * @param {boolean} [opts.autoStart=true] - arm the ticker once wired
 * @param {() => number} [opts.now] - injectable clock (tests)
 * @param {() => number} [opts.rng] - injectable RNG (tests)
 * @param {Function} [opts.setTimeout] [opts.clearTimeout] [opts.setInterval] [opts.clearInterval]
 * @param {object} [opts.log={error, warn, info}] - log sinks
 * @returns {object} agent handle (see module doc)
 */
function createAgent(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const doc = opts.document || (win && win.document) || null;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 500;
  const autoStart = opts.autoStart !== false;
  const nowFn = typeof opts.now === 'function' ? opts.now : (typeof Date !== 'undefined' ? Date.now : () => 0);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const setTimeoutFn = typeof opts.setTimeout === 'function' ? opts.setTimeout : (win && win.setTimeout ? win.setTimeout.bind(win) : null);
  const clearTimeoutFn = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (win && win.clearTimeout ? win.clearTimeout.bind(win) : null);
  const setIntervalFn = typeof opts.setInterval === 'function' ? opts.setInterval : (win && win.setInterval ? win.setInterval.bind(win) : null);
  const clearIntervalFn = typeof opts.clearInterval === 'function' ? opts.clearInterval : (win && win.clearInterval ? win.clearInterval.bind(win) : null);
  const baseLog = opts.log || {
    error: (m) => { state.errors.push(String(m)); try { if (win && win.console) win.console.error('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    warn: (m) => { state.warnings.push(String(m)); try { if (win && win.console) win.console.warn('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    info: (m) => { try { if (win && win.console) win.console.info('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
  };

  // D8 (slice 1a): session-scoped readable activity log. Every sink call and
  // every queue-dispatched fire closure pushes an entry; the panel renders
  // them as formatted rows (REQ-26 — never raw JSON). Session-scoped like
  // state.timers: survives config rebuilds, resets on agent restart.
  const logRing = LOG_MOD.createLogRing({ cap: 200, now: nowFn });

  /** Best-effort readable-log push — logging never breaks the agent. */
  function logEvent(module, action, result) {
    try {
      logRing.push({ ts: nowFn(), module: module, action: action, result: result });
    } catch (e) { /* best-effort */ }
  }

  // Mirror every sink into the ring (module 'agent', level as action) so
  // agent-level alerts/errors surface in the panel log too. Injected sinks
  // keep their exact call signature.
  const log = {
    error: (m) => { logEvent('agent', 'error', m); if (typeof baseLog.error === 'function') baseLog.error(m); },
    warn: (m) => { logEvent('agent', 'warn', m); if (typeof baseLog.warn === 'function') baseLog.warn(m); },
    info: (m) => { logEvent('agent', 'info', m); if (typeof baseLog.info === 'function') baseLog.info(m); },
  };

  const state = {
    ready: false,
    running: false,
    destroyed: false,
    armed: false, // REQ-02 gate: false until the panel confirms + pushes armed:true
    gameClient: null,
    config: null,
    tree: null,
    queue: null,
    engine: null,
    modules: null, // slice-4 module handles (built in rebuild)
    ctx: {},
    ticker: null,
    pollTimer: null,
    pollCount: 0,
    lastPath: [],
    lastDispatch: [],
    warnings: [],
    errors: [],
    // Session-scoped state (survives config rebuilds within a session,
    // reset on agent restart): the trade cadence anchor (REQ-18 "toggle
    // resets on logout") + the kill observer baseline.
    timers: { tradeLastSentAt: 0 },
    // D8 (slice 1a): readable activity log ring (cap 200) — fed by the log
    // sinks above and the fire closures below; carried in getState() so the
    // panel renders formatted rows (REQ-26, never raw JSON).
    logBuffer: logRing,
  };

  // Shared active-creature diff observer (core/kills): feeds huntStats
  // kills/loot (REQ-21) and loot routing (REQ-19). Baseline resets on every
  // rebuild (new session/config).
  state.killObserver = KILLS_MOD.createKillObserver({
    readActiveCreatures: readActiveCreatures,
    now: nowFn,
  });

  /* ------------------------------ tree + queue ----------------------------- */

  /** Combat rules (userscript spell shape) whose ACTIONS enqueue through the
   *  Action Queue — the rotation engine executes them inline, so enqueueing
   *  inside the action is the ONLY way to keep REQ-12's no-bypass promise. */
  function readSpellCost(spell) {
    let cost = null;
    try {
      const sb = state.gameClient && state.gameClient.player && state.gameClient.player.spellbook;
      if (sb && spell.sid !== null && spell.sid !== undefined) {
        const entry = (typeof sb.getSpell === 'function' ? sb.getSpell(spell.sid) : null)
          || (sb.spells && sb.spells[spell.sid]) || null;
        if (entry && entry.cost !== undefined) cost = Number(entry.cost);
      }
      // Slice-4 (probed, obs 10320): spellbook is EMPTY — spells resolve via
      // interface.getSpell(sid). Adds the probed location as a fallback.
      if ((cost === null || !Number.isFinite(cost)) && state.gameClient && state.gameClient.interface) {
        const intf = state.gameClient.interface;
        if (typeof intf.getSpell === 'function') {
          const entry = intf.getSpell(spell.sid);
          if (entry && entry.cost !== undefined) cost = Number(entry.cost);
        }
      }
    } catch (e) { cost = null; }
    if ((cost === null || !Number.isFinite(cost)) && Number.isFinite(Number(spell.cost))) cost = Number(spell.cost);
    return cost !== null && Number.isFinite(cost) ? cost : null;
  }

  /** Live-probed hotbar manager accessor (obs 10320 location). */
  function readHotbar() {
    const gc = state.gameClient;
    return gc && ((gc.interface && gc.interface.hotbarManager) || gc.hotbarManager) || null;
  }

  /** Live-probed vocation gate hotbarManager.__canPlayerCastSpell(sid)
   *  (obs 10320). Returns true/false when the gate exists; null when the
   *  feature is absent (callers skip the gate, never block). */
  function canCastSpell(sid) {
    try {
      const hb = readHotbar();
      if (hb && typeof hb.__canPlayerCastSpell === 'function') {
        return hb.__canPlayerCastSpell(sid) === true;
      }
    } catch (e) { /* gate read failure => unknown */ }
    return null;
  }

  /** Live rune-CAP read (design D3, REQ-30): adapters/gameClient.readCap over
   *  the probed `player.state.__state.capacity`/`maxCapacity` locations —
   *  feature-detected, ratio-guarded (see readCap). */
  function readCap() {
    return GC_MOD.readCap({ gameClient: state.gameClient });
  }

  /** Rune spell cost for a hotbar slot (D2, REQ-31 runes reserve): resolves
   *  slot -> spell sid -> client cost (spellbook first, interface fallback).
   *  Returns null when any link is absent (gate skipped, never blocks). */
  function readRuneCost(slot) {
    try {
      const hb = readHotbar();
      if (!hb || !Array.isArray(hb.slots)) return null;
      const entry = hb.slots[Number(slot) - 1];
      const sid = entry && entry.spell;
      if (sid === null || sid === undefined) return null;
      return readSpellCost({ sid: sid });
    } catch (e) { return null; }
  }

  /** Live-probed native rune windows: hotbarManager.__runeAttackUntil /
   *  __runeHealUntil (epoch-ms "active until"). Returns null when the fields
   *  are ABSENT (feature not present => the rune module degrades, design D7 —
   *  no invented fallback loop). */
  function readRuneTimers() {
    try {
      const hb = readHotbar();
      if (!hb) return null;
      const attackUntil = hb.__runeAttackUntil;
      const healUntil = hb.__runeHealUntil;
      if (attackUntil === undefined && healUntil === undefined) return null;
      return { attackUntil: attackUntil === undefined ? null : attackUntil, healUntil: healUntil === undefined ? null : healUntil };
    } catch (e) { return null; }
  }

  /** Post-rune-fire wait in ms: __getRuneEffectiveCooldown() when present,
   *  plus player attackSlowness when exposed (REQ-15 "respect global cooldown
   *  and player.attackSlowness"). Feature-detected; 0 when absent. */
  function readRuneAfterFireWait() {
    let wait = 0;
    try {
      const hb = readHotbar();
      if (hb && typeof hb.__getRuneEffectiveCooldown === 'function') {
        const v = hb.__getRuneEffectiveCooldown();
        if (Number.isFinite(Number(v))) wait = Math.max(wait, Number(v));
      }
    } catch (e) { /* best-effort */ }
    try {
      const p = state.gameClient && state.gameClient.player;
      const sl = (p && p.state && p.state.attackSlowness) !== undefined
        ? (p.state.attackSlowness) : (p && p.attackSlowness);
      if (Number.isFinite(Number(sl))) wait = Math.max(wait, Number(sl));
    } catch (e) { /* best-effort */ }
    return wait;
  }

  /* ------------------- slice-5 feature-detect readers (REQ-18..22) ------------------- */

  /** Premium gate (REQ-22, core/premium): feature-detect over the probed
   *  candidate locations; unknown state never blocks (no hard dependency). */
  function readPremium() {
    return PREMIUM_MOD.readPremiumState(state.gameClient, nowFn);
  }

  /** Live active-creature list (kill feed, REQ-21/19): world.activeCreatures
   *  probed (obs 10320); null when the array is absent (kill source degrade). */
  function readActiveCreatures() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const list = (world && world.activeCreatures) || (gc && gc.activeCreatures) || (world && world.creatures);
      return Array.isArray(list) ? list : null;
    } catch (e) { return null; }
  }

  /** XP/gold counters (REQ-21): player.state/player candidates, feature-detected. */
  function readHuntCounters() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return { xp: null, gold: null };
      const rawXp = (p.state && p.state.xp) || p.xp || (p.state && p.state.experience);
      const rawGold = (p.state && p.state.gold) || p.gold || (p.state && p.state.money);
      const xp = Number.isFinite(Number(rawXp)) ? Number(rawXp) : null;
      const gold = Number.isFinite(Number(rawGold)) ? Number(rawGold) : null;
      return { xp, gold };
    } catch (e) { return { xp: null, gold: null }; }
  }

  /** Trade-channel send surface (REQ-18, design D6): channelManager resolved
   *  by id 2 (Trade — live-probed channels, obs 10320) with the send method
   *  feature-detected. Returns {send, label} or null (degrade). */
  function readTradeChannel() {
    try {
      const gc = state.gameClient;
      const manager = (gc && ((gc.interface && gc.interface.channelManager) || gc.channelManager)) || null;
      if (!manager) return null;
      let channel = null;
      if (typeof manager.getChannelById === 'function') channel = manager.getChannelById(2);
      if (!channel && typeof manager.getChannel === 'function') {
        try { channel = manager.getChannel(2); } catch (e) { channel = null; }
      }
      if (!channel && manager.channels && manager.channels[2]) channel = manager.channels[2];
      if (!channel && typeof manager.getChannel === 'function') {
        try { channel = manager.getChannel('Trade'); } catch (e) { channel = null; }
      }
      if (!channel || typeof channel !== 'object') return null;
      const send = channel.send || channel.sendMessage || channel.sendChat
        || channel.message || channel.sendChannelMessage;
      if (typeof send !== 'function') return null;
      return { send: send.bind(channel), label: 'Trade(2)' };
    } catch (e) { return null; }
  }

  /** Default-channel send surface (PR5, REQ-34, design D9 open probe): the
   *  channelManager resolved for the Default channel (id 1/0 candidates, the
   *  'Default' name, or the channels map) with the send method feature-
   *  detected. Returns {send, label} or null — the anti-bot module degrades
   *  to ALERT-ONLY when null; a send path is never invented. */
  function readDefaultChannelSend() {
    try {
      const gc = state.gameClient;
      const manager = (gc && ((gc.interface && gc.interface.channelManager) || gc.channelManager)) || null;
      if (!manager) return null;
      const candidates = [];
      if (typeof manager.getChannelById === 'function') {
        for (const id of [1, 0]) {
          try {
            const c = manager.getChannelById(id);
            if (c) candidates.push(c);
          } catch (e) { /* try the next candidate */ }
        }
      }
      if (typeof manager.getChannel === 'function') {
        try {
          const c = manager.getChannel('Default');
          if (c) candidates.push(c);
        } catch (e) { /* try the next candidate */ }
      }
      if (manager.channels && typeof manager.channels === 'object') {
        const c = manager.channels.Default || manager.channels['Default']
          || manager.channels[1] || manager.channels[0];
        if (c) candidates.push(c);
      }
      for (const channel of candidates) {
        if (!channel || typeof channel !== 'object') continue;
        const send = channel.send || channel.sendMessage || channel.sendChat
          || channel.message || channel.sendChannelMessage;
        if (typeof send === 'function') return { send: send.bind(channel), label: 'Default' };
      }
      return null;
    } catch (e) { return null; }
  }

  /** Anti-bot player context (PR5, REQ-33, D9): position (`__position`),
   *  teleport flag (`__teleported`), health and damage tint (`__damageTint`)
   *  over the live-probed candidate locations — feature-detected; absent
   *  fields report null and the watcher never invents events. */
  function readAntibotContext() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return { position: null, teleported: null, health: null, damageTint: null };
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      const rawPos = st.__position || p.__position;
      let position = null;
      if (rawPos && typeof rawPos === 'object') {
        const x = Number(rawPos.x);
        const y = Number(rawPos.y);
        const z = Number(rawPos.z);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          position = { x, y, z: Number.isFinite(z) ? z : 0 };
        }
      }
      const teleported = (st.__teleported === true || p.__teleported === true) ? true : null;
      const rawHp = st.health !== undefined ? st.health : p.health;
      const health = Number.isFinite(Number(rawHp)) ? Number(rawHp) : null;
      const damageTint = (st.__damageTint === true || p.__damageTint === true) ? true : null;
      return { position, teleported, health, damageTint };
    } catch (e) { return { position: null, teleported: null, health: null, damageTint: null }; }
  }

  /** Player position reader (PR6, REQ-36): player.state.__position /
   *  p.__position over the live-probed locations (same surface the anti-bot
   *  context reads) — feature-detected; null when absent (the cavebot start
   *  degrades with 'no-position', never an invented location). */
  function readPosition() {
    try {
      const p = state.gameClient && state.gameClient.player;
      if (!p) return null;
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      const rawPos = st.__position || p.__position;
      if (!rawPos || typeof rawPos !== 'object') return null;
      const x = Number(rawPos.x);
      const y = Number(rawPos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch (e) { return null; }
  }

  /** Ground-object list reader (PR6, REQ-36 open probe): feature-detected
   *  candidates over the live game surfaces; null when absent ("no object
   *  surface" — the walk-to-object action stays a no-op state, never an
   *  invented source). */
  function readObjects() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const cands = [world && world.objects, gc && gc.objects,
        world && world.groundObjects, gc && gc.groundObjects,
        gc && gc.interface && gc.interface.objects];
      for (const c of cands) {
        if (Array.isArray(c)) return c;
      }
      return null;
    } catch (e) { return null; }
  }

  /** Loot-command surface (REQ-19): feature-detected game function
   *  (monster, destination) => void; null = unavailable (degrade). */
  function readLootCommand() {
    try {
      const gc = state.gameClient;
      const cands = [gc && gc.lootCommands, gc && gc.autoLoot, gc && gc.lootManager,
        gc && gc.interface && gc.interface.lootManager, gc && gc.loot];
      for (const c of cands) {
        if (!c) continue;
        for (const name of ['routeLoot', 'sendLoot', 'setDestination', 'route', 'assign', 'command']) {
          if (typeof c[name] === 'function') return c[name].bind(c);
        }
        if (typeof c === 'function') return c;
      }
      return null;
    } catch (e) { return null; }
  }

  /** Spawn-map data reader (REQ-20): feature-detect the game's spawn-data
   *  structure (open probe 5.3); returns raw locations or null ("no spawn
   *  data"). Pure normalization lives in the spawns module. */
  function readSpawnData(monster) {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const cands = [gc && gc.spawns, world && world.spawns, gc && gc.spawnMap,
        gc && gc.monsterSpawns, gc && gc.interface && gc.interface.spawnManager,
        world && world.spawnData, gc && gc.spawnLocations];
      for (const c of cands) {
        if (!c) continue;
        if (typeof c.query === 'function') {
          const r = c.query(monster);
          if (r !== null && r !== undefined) return r;
        } else if (typeof c.get === 'function') {
          const r = c.get(monster);
          if (r !== null && r !== undefined) return r;
        } else if (typeof c === 'object' && c[monster] !== undefined) {
          return c[monster];
        }
      }
      return null;
    } catch (e) { return null; }
  }

  /** Native pathfinder reader (REQ-23, live-probed location obs 10320:
   *  world.pathfinder holds the autowalk state + walk-to methods). Returns
   *  null when absent ("no pathfinder data" degrade). */
  function readPathfinder() {
    try {
      const gc = state.gameClient;
      const world = gc && gc.world;
      const pf = (world && world.pathfinder) || (gc && gc.pathfinder) || null;
      return pf && typeof pf === 'object' ? pf : null;
    } catch (e) { return null; }
  }

  /** Configured words for the learning observer (REQ-25): rotation spell
   *  words + healMagic/training words + previously registered words. */
  function configuredWords() {
    const words = new Set();
    const spells = (state.config && state.config.rotation && state.config.rotation.spells) || [];
    for (const s of spells) {
      if (s && typeof s.word === 'string' && s.word.trim()) words.add(s.word.trim());
    }
    const hm = state.config && state.config.healMagic;
    if (hm && typeof hm.word === 'string' && hm.word.trim()) words.add(hm.word.trim());
    const tr = state.config && state.config.training;
    if (tr && typeof tr.word === 'string' && tr.word.trim()) words.add(tr.word.trim());
    const le = state.config && state.config.learning;
    if (le && Array.isArray(le.knownWords)) {
      for (const w of le.knownWords) if (typeof w === 'string' && w.trim()) words.add(w.trim());
    }
    return words;
  }

  function buildCombatRules(cfg) {
    const spells = (cfg.rotation.spells || []).filter((s) => Number.isInteger(s.slot) && s.slot >= 1 && s.slot <= 12);
    return spells.map((spell, index) => ({
      id: 'cast-slot-' + spell.slot,
      order: Number.isFinite(spell.order) ? spell.order : spell.slot,
      condition: function (ctx) {
        if (ctx.mana === null || ctx.mana === undefined) return false;
        if (Number.isFinite(spell.threshold) && spell.threshold > 0 && ctx.mana < spell.threshold) return false;
        const cost = readSpellCost(spell);
        if (cost !== null) {
          const feas = FEAS_MOD.canCast({
            mana: ctx.mana,
            cost,
            reserve: spell.reserve || 0,
            maxMana: ctx.maxMana,
            key: 'slot-' + spell.slot,
            warned: new Set(),
            onWarn: function () {},
          });
          if (!feas.fire) return false;
        }
        const cd = GC_MOD.readCooldown(spell.sid, { gameClient: state.gameClient });
        if (!CD_MOD.canFire({
          cooldown: cd.cooldown,
          globalCooldown: cd.globalCooldown,
          cooldownMs: spell.cooldownMs || 0,
          lastFiredAt: ctx.lastFiredAt ? ctx.lastFiredAt[spell.slot] : null,
          now: Date.now(),
          onGapLog: function () {},
        }).fire) return false;
        return !state.queue.hasPending((e) => e.kind === 'combat-cast-slot-' + spell.slot);
      },
      action: function (ctx) {
        // NO-BYPASS (REQ-12): the real __handleClick call happens ONLY inside
        // the queue-dispatched closure, never inline.
        state.queue.enqueue(() => {
          FIRING_MOD.fireSlot(spell.slot, {
            mode: 'handleClick',
            gameClient: state.gameClient,
            document: doc,
            log,
          });
        }, { kind: 'combat-cast-slot-' + spell.slot });
        ctx.lastFiredAt = ctx.lastFiredAt || {};
        ctx.lastFiredAt[spell.slot] = nowFn();
        return true;
      },
      kind: 'cast',
      repeat: Math.max(1, Number(spell.repeat) || 1),
    }));
  }

  /** Rebuild tree + queue + modules from the current config (applyConfig path). */
  function rebuild(cfg) {
    state.config = cfg;
    state.armed = cfg.armed === true; // REQ-02: arm/keep-disarmed on every config push
    state.ctx = { mana: null, maxMana: null, health: null, lastFiredAt: {}, castsSinceFood: 0, lastEatAt: 0 };
    if (state.killObserver) state.killObserver.reset(); // new session/config -> fresh kill baseline
    state.queue = createQueue({
      minInterval: cfg.queue.minIntervalMs,
      jitter: cfg.jitter,
      now: nowFn,
      rng,
      dispatch: function (fn) { fn(); }, // the ONLY game-handler invocation point
    });
    state.engine = ROTATION_MOD.createEngine({ rules: buildCombatRules(cfg), ctx: state.ctx });

    /* -------- slice-4 modules (REQ-13..17): pure decision + queue-dispatch -------- */
    const healItems = HEAL_ITEMS_MOD.createHealItems({
      config: cfg.healItems,
      findSlot: function () { return HEAL_ITEMS_MOD.defaultFindSlot(state.gameClient, cfg.healItems.slotCids); },
      gameClient: function () { return state.gameClient; },
      log,
    });
    const healMagic = HEAL_MAGIC_MOD.createHealMagic({
      config: cfg.healMagic,
      getSpellCost: function (sid) { return readSpellCost({ sid: sid }); },
      canCastSpell: canCastSpell,
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      now: nowFn,
      log,
    });
    const runes = RUNES_MOD.createRunes({
      config: cfg.runes,
      readRuneTimers: readRuneTimers,
      readGlobalCooldown: function () { return GC_MOD.readCooldown(null, { gameClient: state.gameClient }).globalCooldown; },
      readAfterFireWait: readRuneAfterFireWait,
      getSpellCost: readRuneCost, // D2 (REQ-31): runes.reserve via canCast
      now: nowFn,
      log,
    });
    const training = TRAINING_MOD.createTraining({
      config: cfg.training,
      // D3 (REQ-30): the trainer absorbs the strict-CAP settings — the cap
      // fields live in the runes config shape (characters.ts defaults).
      capConfig: cfg.runes,
      readCap: readCap,
      getSpellCost: function (sid) { return readSpellCost({ sid: sid }); },
      canCastSpell: canCastSpell,
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      now: nowFn,
      log,
    });
    const eat = EAT_MODULE_MOD.createEatModule({
      config: cfg.eat,
      gameClient: function () { return state.gameClient; },
      document: doc,
      now: nowFn,
      log,
    });

    /* -------- slice-5 modules (REQ-18..22,24,25): ported automations -------- */

    // REQ-18: auto trade broadcast — cadence anchor lives in state.timers
    // (session-scoped, survives config rebuilds; agent restart = new session,
    // mirroring the game's "toggle resets to OFF on logout").
    const trade = TRADE_MOD.createTradeModule({
      config: cfg.trade,
      timers: state.timers,
      readChannel: readTradeChannel,
      readPremium: readPremium,
      now: nowFn,
      log,
    });
    // REQ-19: auto-loot list — per-monster destinations + default; the kill
    // feed comes from the shared observer (observeKills in tickOnce).
    const loot = LOOT_MOD.createLootModule({
      config: cfg.loot,
      readLootCommand: readLootCommand,
      readPremium: readPremium,
      now: nowFn,
      log,
    });
    // REQ-20: spawn maps — read-only provider; the panel queries it via the
    // getSpawns surface RPC; state flows through the snapshot.
    const spawns = SPAWNS_MOD.createSpawnsModule({
      config: cfg.spawns,
      readSpawnData: readSpawnData,
      readPremium: readPremium,
      log,
    });
    // REQ-21: hunt session stats — accumulator fed per tick (tickOnce). The
    // panel toggle is the session start/stop control (ON = start, OFF =
    // freeze). The module INSTANCE survives rebuilds (applyConfig
    // transitions), so unrelated config pushes never reset a running session.
    if (!state.huntStatsModule) {
      state.huntStatsModule = HUNT_STATS_MOD.createHuntStats({
        config: cfg.huntStats,
        readCounters: readHuntCounters,
        killObserver: state.killObserver,
        readPremium: readPremium,
        now: nowFn,
        log,
      });
    } else {
      state.huntStatsModule.applyConfig(cfg.huntStats);
    }
    const huntStats = state.huntStatsModule;
    // REQ-24: echo validation — carried-over validator, started from the
    // heal-magic/training queue closures when a word is configured.
    const echo = ECHO_MOD.createEchoModule({
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      gameClient: state.gameClient,
      document: doc,
      now: nowFn,
      log,
    });
    // REQ-25: unknown-word observation + registration offer (panel renders
    // offers from the module state; confirm/decline via server + RPC).
    const learning = LEARNING_MOD.createLearningModule({
      config: cfg.learning,
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      configuredWords: configuredWords,
      gameClient: state.gameClient,
      document: doc,
      now: nowFn,
      log,
    });
    // REQ-33/34 (PR5, D9): anti-bot watcher — reads the SAME Default-channel
    // surface as echo/learning (REQ-24 MODIFIED) + the player context; the
    // auto-reply send is feature-detected (degrade = alert-only). The
    // confirm-once session state lives in state.timers (survives rebuilds,
    // resets on agent restart — REQ-34 "per session").
    const antibot = ANTIBOT_MOD.createAntibotModule({
      config: cfg.antibot,
      playerName: function () { return (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null; },
      gameClient: state.gameClient,
      document: doc,
      readContext: readAntibotContext,
      readSend: readDefaultChannelSend,
      timers: state.timers,
      now: nowFn,
      log,
    });
    // REQ-23 (slice 6): routes v1 — native autowalk state read + walk-to
    // via the game's own pathfinder primitive (never synthetic per-step
    // input). Not a tree node: the read is passive (eager getState) and
    // walk-to is an app-driven RPC (queue-dispatched).
    const routes = ROUTES_MOD.createRoutesModule({
      config: cfg.routes,
      readPathfinder: readPathfinder,
      now: nowFn,
      log,
    });
    // REQ-35/36 (PR6, D10): state-only skeleton modules — attack targeting
    // + pickers config and the cavebot route recorder. NOT tree nodes: no
    // combat loop, no continuous auto-walking (getState discloses the
    // skeleton; the app-driven RPCs below drive record/start). The cavebot
    // recording buffer lives in state.timers (survives rebuilds).
    const attack = ATTACK_MOD.createAttackModule({ config: cfg.attack });
    const cavebot = CAVEBOT_MOD.createCavebotModule({
      config: cfg.cavebot,
      readPosition: readPosition,
      readObjects: readObjects,
      timers: state.timers,
      now: nowFn,
      recordIntervalMs: 100, // snapshot-loop cadence; the module throttles + dedupes
      log,
    });
    state.modules = {
      healItems: healItems, healMagic: healMagic, runes: runes, training: training, eat: eat,
      trade: trade, loot: loot, spawns: spawns, huntStats: huntStats, echo: echo, learning: learning,
      antibot: antibot, routes: routes, attack: attack, cavebot: cavebot,
    };

    /* -------- tree nodes: survival > combat > training > eat > loot (REQ-11) -------- */

    // REQ-13: heal with items — survival priority, queue-aware (no re-enqueue
    // while a heal-item action is pending).
    const healItemsNode = {
      type: 'sequence',
      id: 'heal-items',
      children: [
        {
          type: 'condition',
          id: 'heal-items-feasible',
          predicate: function (ctx) {
            if (!cfg.healItems.on) return false;
            const d = healItems.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'heal-item'; });
          },
        },
        {
          type: 'action',
          id: 'heal-items-use',
          run: function (ctx) {
            const d = healItems.decide(ctx);
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the real __useItemOnSelf/mouse.use call
            // happens ONLY inside the queue-dispatched closure. Priority
            // 'urgent' (D1, REQ-29): the heal jumps in-flight work.
            state.queue.enqueue(function () { healItems.fire(d.item); }, { kind: 'heal-item', priority: 'urgent' });
            logEvent('healItems', 'use-item', d.item && d.item.cid !== undefined ? d.item.cid : d.reason || 'heal');
            return true;
          },
        },
      ],
    };

    // REQ-14: heal with magic — hp threshold + mana feasibility +
    // GLOBAL_COOLDOWN defer (core/cooldown), queue-aware.
    const healMagicNode = {
      type: 'sequence',
      id: 'heal-magic',
      children: [
        {
          type: 'condition',
          id: 'heal-magic-feasible',
          predicate: function (ctx) {
            if (!cfg.healMagic.on) return false;
            const d = healMagic.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'heal-magic'; });
          },
        },
        {
          type: 'action',
          id: 'heal-magic-cast',
          run: function (ctx) {
            const d = healMagic.decide(ctx);
            if (!d.fire) return false;
            // D1 (REQ-29): the heal carries priority 'urgent' from the module
            // decision — head-inserted before ANY normal entry, so it
            // preempts rune/training/attack work already in flight (the
            // queue defers that work to a later drain). Throttle + jitter
            // still apply at drain (REQ-12 — no bypass, ever).
            state.queue.enqueue(function () {
              healMagic.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: words-path fires only (word configured);
              // direct casts without a word skip validation entirely.
              if (cfg.healMagic && typeof cfg.healMagic.word === 'string' && cfg.healMagic.word.trim()) {
                echo.startForFire('heal-magic', cfg.healMagic.word);
              }
              logEvent('healMagic', 'cast', d.reason || 'heal');
            }, { kind: 'heal-magic', priority: d.priority || 'normal' });
            return true;
          },
        },
      ],
    };

    const survival = {
      type: 'sequence',
      id: 'survival',
      children: [
        {
          type: 'condition',
          id: 'low-hp',
          predicate: function (ctx) {
            return Boolean(cfg.survival.on)
              && Number.isInteger(cfg.survival.slot)
              && ctx.health !== null
              && ctx.health <= cfg.survival.threshold
              && !state.queue.hasPending(function (e) { return e.kind === 'survival-heal'; });
          },
        },
        {
          type: 'action',
          id: 'heal',
          run: function (ctx) {
            // NO-BYPASS (REQ-12): the action enqueues a closure; the real
            // __handleClick call happens ONLY inside the queue-dispatched
            // closure, never inline during the tree tick. Priority 'urgent'
            // (D1, REQ-29): the legacy survival heal also preempts in-flight
            // rune/training/attack work.
            state.queue.enqueue(function () {
              FIRING_MOD.fireSlot(cfg.survival.slot, {
                mode: 'handleClick',
                gameClient: state.gameClient,
                document: doc,
                log,
              });
              logEvent('survival', 'fire-slot', cfg.survival.slot);
            }, { kind: 'survival-heal', priority: 'urgent' });
            return true;
          },
        },
      ],
    };

    // REQ-15: runes — defer while a native window is active; fire on expiry.
    // A single action node: the decision is made inside run() so a deferred
    // rune falls through to combat in the same tick.
    const runesNode = {
      type: 'action',
      id: 'runes',
      run: function (ctx) {
        if (!cfg.runes.on) return false;
        const d = runes.decide(ctx);
        if (!d.fire) return false;
        if (state.queue.hasPending(function (e) { return e.kind === d.kind; })) return false;
        state.queue.enqueue(function () {
          runes.fire(d, { gameClient: state.gameClient, document: doc });
          logEvent('runes', d.kind || 'runes', d.reason || null);
        }, { kind: d.kind });
        return true;
      },
    };

    const combat = {
      type: 'action',
      id: 'combat',
      run: function (ctx) {
        const result = state.engine.tick(); // at most one rule per tick (rotation semantics)
        return Boolean(result.fired);
      },
    };

    // REQ-16/30/32: training — cast-to-train cadence via the queue; a
    // training cast advances the every-N-casts food cadence (ctx.castsSinceFood).
    // The TRAINER decision may carry kind 'fallback' (REQ-30 cap-full) or
    // 'eat-magic' (REQ-32, D4) — each gets its own queue kind so re-arm
    // guards and the activity log stay distinct (normal eat is untouched).
    const trainingKind = (d) => (d.kind === 'eat-magic' ? 'eat-magic'
      : d.kind === 'fallback' ? 'training-fallback' : 'training-cast');
    const trainingNode = {
      type: 'sequence',
      id: 'training',
      children: [
        {
          type: 'condition',
          id: 'training-feasible',
          predicate: function (ctx) {
            if (!cfg.training.on) return false;
            const d = training.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === trainingKind(d); });
          },
        },
        {
          type: 'action',
          id: 'training-cast',
          run: function (ctx) {
            const d = training.decide(ctx);
            if (!d.fire) return false;
            const kind = trainingKind(d);
            state.queue.enqueue(function () {
              training.fire(d, { gameClient: state.gameClient, document: doc });
              // REQ-24 echo validation: only when a training word is configured
              // AND the action is a real training cast (fallback/eat-magic are
              // direct slot fires — no echo path).
              if (d.kind === 'training'
                && cfg.training && typeof cfg.training.word === 'string' && cfg.training.word.trim()) {
                echo.startForFire('training', cfg.training.word);
              }
              logEvent('training', kind, d.reason || null);
            }, { kind: kind });
            // The every-N-casts food cadence counts REAL training casts only.
            if (d.kind === 'training') ctx.castsSinceFood = (ctx.castsSinceFood || 0) + 1;
            return true;
          },
        },
      ],
    };

    // REQ-17: eat — proven SATED/timer/everyCasts/fallback-interval decision;
    // the queue-dispatched closure runs the proven eater attempt.
    const eatNode = {
      type: 'sequence',
      id: 'eat',
      children: [
        {
          type: 'condition',
          id: 'eat-feasible',
          predicate: function (ctx) {
            if (!cfg.eat.on) return false;
            const d = eat.decide(ctx);
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'eat'; });
          },
        },
        {
          type: 'action',
          id: 'eat-use',
          run: function (ctx) {
            const d = eat.decide(ctx);
            if (!d.fire) return false;
            state.queue.enqueue(function () { eat.fire(ctx, d); logEvent('eat', 'eat', d.reason || null); }, { kind: 'eat' });
            return true;
          },
        },
      ],
    };

    // REQ-19: auto-loot — route kills with loot to the configured destination
    // via the game's own loot-command surface (feature-detected; degrade =
    // record/no-op with honest panel state). Queue-aware, one route per tick.
    const lootNode = {
      type: 'sequence',
      id: 'loot',
      children: [
        {
          type: 'condition',
          id: 'loot-feasible',
          predicate: function () {
            if (!cfg.loot.on) return false;
            const d = loot.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'loot-route'; });
          },
        },
        {
          type: 'action',
          id: 'loot-collect',
          run: function () {
            const d = loot.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the game loot command runs ONLY inside the
            // queue-dispatched closure.
            state.queue.enqueue(function () { loot.fire(d); logEvent('loot', 'route', d.reason || null); }, { kind: 'loot-route' });
            return true;
          },
        },
      ],
    };

    // REQ-18: auto trade broadcast — 3-min cadence (default, mirror the game)
    // to the Trade channel via the game's own channel mechanism. Lowest
    // priority: a chat broadcast never pre-empts survival/combat (REQ-11).
    const tradeNode = {
      type: 'sequence',
      id: 'trade',
      children: [
        {
          type: 'condition',
          id: 'trade-due',
          predicate: function () {
            if (!cfg.trade.on) return false;
            const d = trade.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'trade-broadcast'; });
          },
        },
        {
          type: 'action',
          id: 'trade-send',
          run: function () {
            const d = trade.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the channel send runs ONLY inside the
            // queue-dispatched closure.
            state.queue.enqueue(function () { trade.fire(d); logEvent('trade', 'broadcast', d.reason || null); }, { kind: 'trade-broadcast' });
            return true;
          },
        },
      ],
    };

    // REQ-34 (PR5, D9): anti-bot auto-replies — the Default-channel send runs
    // ONLY inside a queue-dispatched closure (REQ-12 no-bypass). The watcher
    // (tickOnce observe) feeds the decision; when the send surface is absent
    // the module degrades to ALERT-ONLY (never an invented send path). Lowest
    // priority: a chat reply never pre-empts survival/combat (REQ-11).
    const antibotNode = {
      type: 'sequence',
      id: 'antibot',
      children: [
        {
          type: 'condition',
          id: 'antibot-feasible',
          predicate: function () {
            if (!cfg.antibot.on) return false;
            const d = antibot.decide();
            if (!d.fire) return false;
            return !state.queue.hasPending(function (e) { return e.kind === 'antibot-reply'; });
          },
        },
        {
          type: 'action',
          id: 'antibot-send',
          run: function () {
            const d = antibot.decide();
            if (!d.fire) return false;
            // NO-BYPASS (REQ-12): the real channel send happens ONLY inside
            // the queue-dispatched closure.
            state.queue.enqueue(function () {
              const ok = antibot.fire(d);
              logEvent('antibot', 'reply', ok ? d.pattern : 'send-failed');
            }, { kind: 'antibot-reply' });
            return true;
          },
        },
      ],
    };

    state.tree = createTree({
      root: {
        type: 'selector',
        id: 'priority-root',
        // heal (items + magic + legacy slot-heal) > runes > combat > training
        // > eat > loot > trade > antibot (REQ-11: survival/heal always beats
        // combat/loot/training; trade broadcast and anti-bot replies are the
        // lowest-priority chat actions).
        children: [healItemsNode, healMagicNode, survival, runesNode, combat, trainingNode, eatNode, lootNode, tradeNode, antibotNode],
      },
    });
  }

  /* ------------------------------ readiness ------------------------------- */

  function poll() {
    if (state.ready || state.destroyed) return state.ready;
    const gameClient = opts.gameClient !== undefined ? opts.gameClient : (win && win.gameClient);
    const hotbar = gameClient && ((gameClient.interface && gameClient.interface.hotbarManager) || gameClient.hotbarManager);
    if (!gameClient || !hotbar || typeof hotbar.__handleClick !== 'function') {
      state.pollCount += 1;
      if (state.pollCount * pollIntervalMs > 120000) {
        state.pollCount = 0;
        log.warn('bootstrap: gameClient/hotbarManager not found yet — still waiting');
      }
      return false;
    }
    state.gameClient = gameClient;
    state.ready = true;
    log.info('ready — player ' + ((gameClient.player && gameClient.player.name) || '?'));
    if (autoStart) start();
    return true;
  }

  /* ------------------------------ engine loop ----------------------------- */

  function createTicker() {
    let pending = null;
    function arm() {
      if (!state.running || pending !== null) return;
      const j = state.config.jitter;
      pending = setTimeoutFn(function () {
        pending = null;
        tickOnce();
        if (state.running) arm(); // self-scheduling jittered cadence (REQ-04)
      }, JITTER_MOD.randomDelay(j.min, j.max, rng));
    }
    return {
      start: function () {
        if (state.running) return;
        state.running = true;
        arm();
      },
      stop: function () {
        state.running = false;
        if (pending !== null) { clearTimeoutFn(pending); pending = null; }
      },
    };
  }

  /** One tree tick + queue drain. At most one action enqueued per tick
   *  (the tree halts after the first executed action; actions are
   *  queue-aware and enqueue themselves — REQ-12 no-bypass). No tick while
   *  disarmed: the REQ-02 gate refuses ANY module action pre-Connect. */
  function tickOnce() {
    if (!state.ready || !state.running || state.destroyed) return null;
    if (!state.armed) return null; // interconnection gate (REQ-02)
    try {
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      const ctx = state.ctx;
      if (stats.mana !== null) ctx.mana = stats.mana;
      if (stats.maxMana !== null) ctx.maxMana = stats.maxMana;
      ctx.health = stats.health;
      // Pre-tree READ-ONLY feeds (REQ-06: reads only — no actions here):
      //  - huntStats: per-tick accumulation (REQ-21)
      //  - loot: kill observations from the shared observer (REQ-19)
      //  - learning: Default-channel unknown-word observation (REQ-25)
      const killScan = state.killObserver ? state.killObserver.scan() : { kills: [], available: false };
      const m = state.modules;
      if (m.huntStats) m.huntStats.accumulate(killScan);
      if (m.loot) m.loot.observeKills(killScan.kills);
      if (m.learning) m.learning.observeChat();
      // REQ-33/34 (PR5): anti-bot watcher — the SAME Default-channel poll as
      // echo/learning (REQ-24 MODIFIED) + the player context; alerts ride the
      // snapshot, confirmed patterns queue auto-replies for the tree node.
      if (m.antibot) m.antibot.observe();
      const result = state.tree.tick(ctx);
      state.lastPath = result.path;
      state.lastDispatch = state.queue.drain(); // eligible entries fire here, in the queue
      return result;
    } catch (err) {
      state.errors.push('tick failed: ' + (err && err.message ? err.message : String(err)));
      log.error('tick failed: ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /* ------------------ PR6 cavebot recording loop (REQ-36) ------------------ */

  /** Passive route-recording sampler: while the cavebot module records, read
   *  the player position on a cadence and let the module throttle/dedupe the
   *  snapshots (REQ-36 "throttled position snapshots"). NOT a tree action and
   *  NOT a game call — a pure read loop. Session-scoped: the timer survives
   *  config rebuilds (the module state lives in state.timers) and is
   *  disarmed on stop/destroy (agent restart = new session). */
  let recordTimer = null;

  function armRecordLoop() {
    if (recordTimer !== null || !setIntervalFn) return;
    recordTimer = setIntervalFn(function () {
      const m = state.modules && state.modules.cavebot;
      if (!m || !m.isRecording()) { disarmRecordLoop(); return; }
      m.record(readPosition());
    }, 750);
  }

  function disarmRecordLoop() {
    if (recordTimer !== null) {
      clearIntervalFn(recordTimer);
      recordTimer = null;
    }
  }

  /* ------------------------------ __mbAgent surface ------------------------ */

  function readPlayerInfo() {
    const p = state.gameClient && state.gameClient.player;
    if (!p) return null;
    let label = null;
    try {
      // Live-probed location (obs 10320): hotbarManager.__VOCATION_NAMES.
      const hb = state.gameClient.interface && state.gameClient.interface.hotbarManager
        || state.gameClient.hotbarManager || null;
      const table = hb && hb.__VOCATION_NAMES || (win && win.__VOCATION_NAMES) || null;
      if (table && p.vocation !== undefined && table[p.vocation]) label = table[p.vocation];
    } catch (e) { label = null; }
    return { name: p.name !== undefined ? p.name : null, vocationId: p.vocation !== undefined ? p.vocation : null, vocationLabel: label };
  }

  function applyConfig(raw) {
    const cfg = normalizeConfig(raw || {});
    rebuild(cfg);
    log.info('applyConfig — queue minInterval ' + cfg.queue.minIntervalMs + 'ms, survival '
      + (cfg.survival.on ? 'on (hp<=' + cfg.survival.threshold + ')' : 'off'));
    return { ok: true, config: cfg };
  }

  function makeSurface() {
    return {
      readStats: function () { return GC_MOD.readStats({ gameClient: state.gameClient, document: doc }); },
      readCooldown: function (sid) { return GC_MOD.readCooldown(sid, { gameClient: state.gameClient }); },
      fireSlot: function (slot, mode) {
        // REQ-02 gate: app-driven RPC fires are refused before Connect.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        // REQ-12 no-bypass: even app-driven RPC fires go through the queue.
        state.queue.enqueue(function () {
          FIRING_MOD.fireSlot(slot, {
            mode: mode || 'handleClick',
            gameClient: state.gameClient,
            document: doc,
            log,
          });
          logEvent('rpc', 'fire-slot', slot);
        }, { kind: 'rpc-fire-slot-' + slot });
        return true;
      },
      eatFood: function () {
        // REQ-02 gate: app-driven RPC eats are refused before Connect.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.eat;
        if (!m || !m.isEnabled()) return { result: 'off' };
        // REQ-12 no-bypass: the real eat attempt runs inside the queue.
        state.queue.enqueue(function () {
          m.fire(state.ctx, { fire: true, reason: 'rpc', force: true });
          logEvent('eat', 'rpc-eat', 'queued');
        }, { kind: 'eat-rpc' });
        return { result: 'queued' };
      },
      getChat: function () { return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc }); },
      getRuneState: function () {
        const m = state.modules && state.modules.runes;
        return m ? m.getState() : null; // REQ-15 real module state (slice 4)
      },
      getSpawns: function (monster) {
        // REQ-20 read-only RPC: the panel queries spawn locations for a
        // monster through the app; result lands in the module state.
        const m = state.modules && state.modules.spawns;
        if (!m || !state.ready) return { available: false, reason: 'not ready', monster: String(monster || '') };
        return m.query(monster);
      },
      respondOffer: function (action, word) {
        // REQ-25: user decision on a learning offer. 'decline' silences the
        // word for the session (RPC, no rebuild); 'confirm' is handled by the
        // server via a config push (knownWords). Refused pre-Connect (REQ-02).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.learning;
        if (!m) return { ok: false, reason: 'not ready' };
        if (action === 'decline') {
          m.decline(word);
          return { ok: true, action: 'decline', word: String(word || '') };
        }
        if (action === 'confirm') {
          m.markKnown(word);
          return { ok: true, action: 'confirm', word: String(word || '') };
        }
        return { ok: false, reason: 'unknown action' };
      },
      confirmAntibot: function (pattern) {
        // REQ-34 (PR5): user confirmation on a pending anti-bot pattern — the
        // module moves it to session-confirmed (state.timers), enabling
        // auto-replies for later occurrences. Refused pre-Connect (REQ-02).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.antibot;
        if (!m) return { ok: false, reason: 'not ready' };
        return m.confirm(pattern);
      },
      getWalkState: function () {
        // REQ-23: real routes-v1 module state (slice 6) — autowalk read
        // (+ destination) or the honest "no pathfinder data" degrade.
        const m = state.modules && state.modules.routes;
        return m ? m.getState() : null;
      },
      walkTo: function (x, y) {
        // REQ-23 (slice 6): walk-to via the NATIVE autowalk primitive only
        // (world.pathfinder.pathTo — live-probed, obs 10320); never
        // synthetic per-step input. REQ-02 gate + REQ-12 no-bypass: the
        // native call happens ONLY inside a queue-dispatched closure.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.routes;
        if (!m) return { ok: false, reason: 'not ready' };
        const d = m.decideWalkTo(x, y);
        if (!d.fire) return { ok: false, reason: d.reason };
        state.queue.enqueue(function () { m.fireWalk(d); logEvent('routes', 'walk-to', String(d.x) + ',' + String(d.y)); }, { kind: 'walk-to' });
        return {
          ok: true,
          method: d.method && d.method.name ? d.method.name : 'native-autowalk',
          x: d.x,
          y: d.y,
          queued: true,
        };
      },
      getPlayerInfo: readPlayerInfo,
      startRouteRecording: function () {
        // REQ-36 (PR6): begin cavebot route recording — the passive position
        // sampler loop arms here (REQ-12 untouched: this loop never touches
        // game handlers). REQ-02 gate like every RPC.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const res = m.startRecording();
        if (res.ok) armRecordLoop();
        return res;
      },
      stopRouteRecording: function () {
        // REQ-36 (PR6): stop recording and return the recorded waypoints
        // (plain {x,y} — the panel saves them into config.routes).
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const res = m.stopRecording();
        if (res.ok) disarmRecordLoop();
        return res;
      },
      cavebotStart: function () {
        // REQ-36 (PR6): start from the NEAREST recorded waypoint (euclidean
        // min) via the game's NATIVE autowalk primitive only (REQ-23 surface,
        // never synthetic per-step input). REQ-02 gate + REQ-12 no-bypass:
        // the native call happens ONLY inside a queue-dispatched closure.
        if (!state.armed) return { ok: false, reason: 'not connected' };
        const m = state.modules && state.modules.cavebot;
        if (!m) return { ok: false, reason: 'not ready' };
        const d = m.decideStart();
        if (!d.fire) return { ok: false, reason: d.reason };
        const pf = readPathfinder();
        const method = pf ? ROUTES_MOD.resolveWalkToMethod(pf) : null;
        if (!pf || !method) return { ok: false, reason: 'no walk-to method' };
        state.queue.enqueue(function () {
          try {
            method.call(pf, d.x, d.y);
            logEvent('cavebot', 'start', 'waypoint ' + d.index + ' (' + d.x + ',' + d.y + ')');
          } catch (e) {
            log.warn('cavebot: start walk failed: ' + (e && e.message ? e.message : e));
          }
        }, { kind: 'cavebot-start' });
        return {
          ok: true,
          waypoint: d.index,
          x: d.x,
          y: d.y,
          distance: d.distance,
          method: method.name || 'native-autowalk',
          queued: true,
        };
      },
      getSpellCatalog: function () {
        // REQ-28 (slice 1b, design D5): client spell catalog RPC — enumerates
        // interface.getSpell(sid) until 30 consecutive unknown sids and
        // returns the RAW list + player context (level, vocation label). The
        // PANEL/server filters it by what the current character can cast;
        // the page never filters here so one RPC serves every vocation.
        // Returns null while the game client is not ready (degrade).
        if (!state.gameClient) return null;
        return GC_MOD.enumerateSpellCatalog(state.gameClient, { maxUnknown: 30, limit: 400 });
      },
      applyConfig: applyConfig,
    };
  }

  /* ------------------------------ lifecycle ------------------------------- */

  function start() {
    if (!state.ready) { log.warn('start: agent not ready — game client not found yet'); return false; }
    state.ticker.start();
    return true;
  }

  function stop() {
    if (state.ticker) state.ticker.stop();
    return true;
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.pollTimer !== null) clearIntervalFn(state.pollTimer);
    if (state.ticker) state.ticker.stop();
    disarmRecordLoop(); // PR6 (REQ-36): the route sampler is session-scoped
  }

  function getState() {
    const modules = state.modules || {};
    return {
      ready: state.ready,
      running: state.running,
      armed: state.armed,
      playerName: (state.gameClient && state.gameClient.player && state.gameClient.player.name) || null,
      health: state.ctx.health,
      mana: state.ctx.mana,
      queue: state.queue ? state.queue.stats() : null,
      lastPath: state.lastPath,
      castsSinceFood: state.ctx.castsSinceFood || 0,
      modules: {
        runes: modules.runes ? modules.runes.getState() : null,
        // REQ-30 (D3): the trainer's cap state (capFull) rides the snapshot
        // so the panel raises the ALERT + beep on the rising edge.
        training: modules.training ? modules.training.getState() : null,
        eat: modules.eat ? modules.eat.getState() : null,
        trade: modules.trade ? modules.trade.getState() : null,
        loot: modules.loot ? modules.loot.getState() : null,
        spawns: modules.spawns ? modules.spawns.getState() : null,
        huntStats: modules.huntStats ? modules.huntStats.getState() : null,
        echo: modules.echo ? modules.echo.getState() : null,
        learning: modules.learning ? modules.learning.getState() : null,
        antibot: modules.antibot ? modules.antibot.getState() : null, // PR5 (REQ-33/34): alerts + pending confirm
        routes: modules.routes ? modules.routes.getState() : null,
        // PR6 (REQ-35/36): state-only skeleton flags — attack targeting +
        // pickers; cavebot recording/saved-route/pause/start + object walk.
        attack: modules.attack ? modules.attack.getState() : null,
        cavebot: modules.cavebot ? modules.cavebot.getState() : null,
      },
      warnings: state.warnings.slice(),
      errors: state.errors.slice(),
      logBuffer: state.logBuffer.read(), // D8 (slice 1a): readable log rows for the panel
    };
  }

  /* ------------------------------ wiring ---------------------------------- */

  rebuild(normalizeConfig(opts.config));
  state.ticker = createTicker();
  state.pollTimer = setIntervalFn(poll, pollIntervalMs);

  return {
    poll,
    isReady: function () { return state.ready; },
    start,
    stop,
    destroy,
    tickOnce,
    getState,
    applyConfig,
    getQueue: function () { return state.queue; },
    surface: makeSurface(),
  };
}

module.exports = { createAgent, normalizeConfig, DEFAULT_CONFIG };

return module.exports;
})();

/* =========================================================================
 * AGENT AUTO-BOOT — the bootstrap module is bundled above; this epilogue
 * boots it on the real page and exposes window.__mbAgent (REQ-04). The
 * surface re-establishes after every navigation because the whole file is
 * injected via Page.addScriptToEvaluateOnNewDocument.
 * ========================================================================= */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return;
  if (window.__mbAgent) return; // guard: never double-boot in one document
  try {
    var AGENT = __mbRequire('agent/bootstrap');
    if (typeof AGENT.createAgent !== 'function') return;
    var handle = AGENT.createAgent({ win: window, document: window.document });
    window.__mbAgent = handle.surface;      // REQ-04 RPC surface
    window.__mbAgentHandle = handle;        // full handle (tests + app control)
  } catch (err) {
    if (window.console && typeof window.console.error === 'function') {
      window.console.error('__mbAgent boot failed:', err && err.message ? err.message : err);
    }
  }
})();
