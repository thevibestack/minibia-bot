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
 *  - FIFO, single dispatch: entries dispatch in enqueue order, one at a time,
 *    never concurrently (throttle=0 still serializes).
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
 *    arrived stay pending and drain in a later call.
 *  - No bypass: the queue is the ONLY dispatch path; the wiring guarantees
 *    game-handler invocations happen exclusively inside dispatched closures.
 *
 * Injectable `now` (fake clock) + `rng` (seeded) make the queue fully
 * deterministic and unit-testable in node without real timers.
 *
 * createQueue(opts) -> {
 *   enqueue(action, { kind, jitterMs }) -> entry,
 *   drain() -> Array<entry>,              // dispatched eligible prefix
 *   hasPending(predicate) -> boolean,
 *   pendingCount() -> number,
 *   stats() -> { enqueued, dispatched, failed, pending, lastDispatchAt, minInterval }
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
  let pending = [];          // FIFO of { action, kind, jitterMs, fireAt }
  const counters = { enqueued: 0, dispatched: 0, failed: 0 };

  /** Draw this entry's jitter delay (enqueue time — deterministic w/ seed). */
  function drawJitter(override) {
    if (Number.isFinite(override)) return Math.max(0, override);
    return randomDelay(jit.min, jit.max, rng);
  }

  /**
   * Enqueue an action. The entry's jitter is drawn NOW; its fire time is
   * computed at drain time against the actual last dispatch so the global
   * interval holds no matter when enqueue happened. The first entry's fire
   * base is its OWN enqueue time (a fixed reference — never the drain time,
   * which would drift and defer it forever).
   *
   * @param {Function} action - () => void; invoked ONLY through dispatch
   * @param {{kind?: string, jitterMs?: number}} [entryOpts]
   * @returns {{action: Function, kind: string, jitterMs: number}} the entry
   */
  function enqueue(action, entryOpts = {}) {
    if (typeof action !== 'function') {
      throw new TypeError('queue.enqueue requires a function action');
    }
    const entry = {
      action,
      kind: typeof entryOpts.kind === 'string' ? entryOpts.kind : 'action',
      jitterMs: drawJitter(entryOpts.jitterMs),
      enqueuedAt: nowFn(), // fixed reference for the first-dispatch slot
      fireAt: null,        // computed at drain time
    };
    pending.push(entry);
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
      dispatched: counters.dispatched,
      failed: counters.failed,
      pending: pending.length,
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

module.exports = { readStats, readCooldown };

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

/** Normalize one channel entry to the canonical read shape. */
function fromChannelEntry(entry) {
  return {
    name: entry?.name ?? null,
    message: entry?.message ?? '',
    time: entry?.__time ?? null,
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
      entries.push({ name: match[1], message: match[2], time: null, source: 'dom' });
    } else {
      entries.push({ name: null, message: line, time: null, source: 'dom' });
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
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number},
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
   * @returns {{fire: boolean, reason: string, slot?: number}}
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
    const cost = typeof getSpellCost === 'function' ? getSpellCost(config.sid) : null;
    if (cost === null) return { fire: false, reason: 'no-cost' };
    const feas = FEAS_MOD.canCast({
      mana: ctx.mana,
      cost,
      reserve: 0,
      maxMana: ctx.maxMana,
      key: 'heal-magic-' + slot,
      warned,
      onWarn: warn,
    });
    if (!feas.fire) return { fire: false, reason: feas.reason === 'never' ? 'never' : 'insufficient' };

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

    return { fire: true, reason: 'low-hp', slot };
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
 *     healThreshold: number|null }
 * @param {() => {attackUntil: number|null, healUntil: number|null}|null}
 *   [opts.readRuneTimers] - native rune window reader; null = feature absent
 * @param {() => {active: boolean, seconds?: number}|null} [opts.readGlobalCooldown]
 * @param {() => number} [opts.readAfterFireWait] - post-fire wait ms
 *   (effective rune cooldown / attackSlowness); feature-detected, default 0
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
  const { config, readRuneTimers = null, readGlobalCooldown = null, readAfterFireWait = null, now = Date.now, log = {} } = opts;
  const error = typeof log.error === 'function' ? log.error : () => {};

  const state = { lastFireAt: 0, available: true, reason: 'ok' };

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
    if (wantHeal) return { fire: true, reason: 'heal-window-expired', slot: healSlot, kind: 'rune-heal' };

    if (attackSlot) return { fire: true, reason: 'attack-window-expired', slot: attackSlot, kind: 'rune-attack' };

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
 * Magic training module (REQ-16, design "Training" row).
 *
 * Optional, user-activated. Repeats casts of the configured training spell at
 * the safe cadence imposed by the Action Queue + jitter (REQ-12/16 — one cast
 * per queue slot, never faster). Gates (in evaluation order):
 *   1. Vocation gate: live-probed `hotbarManager.__canPlayerCastSpell(sid)`
 *      (obs 10320). Feature-absent (null) => gate skipped, never blocks.
 *   2. Mana feasibility: cost resolved from the client (spellbook first, then
 *      the live-probed `interface.getSpell(sid)` — obs 10320: spellbook is
 *      empty). Unknown cost => pause ('no-cost', safe). Below cost+reserve =>
 *      pause until mana recovers (REQ-16).
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
 *   { on: boolean, slot: number|null, sid: number|null, reserve: number }
 * @param {(sid: number|null) => number|null} [opts.getSpellCost] - cost
 *   resolver; null = unknown (pause)
 * @param {(sid: number|null) => boolean|null} [opts.canCastSpell] - live
 *   vocation gate; null = feature absent (skipped)
 * @param {(sid: number|null) => {cooldown: object|null, globalCooldown: object|null}}
 *   [opts.readCooldown] - client cooldown reader
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{error?: Function, warn?: Function}} [opts.log] - log sinks
 * @returns {{
 *   decide: (ctx: object) => {fire: boolean, reason: string, slot?: number},
 *   fire: (decision: object, deps: object) => boolean,
 *   getState: () => object,
 *   isEnabled: () => boolean,
 * }}
 */
function createTraining(opts = {}) {
  const { config, getSpellCost = null, canCastSpell = null, readCooldown = null, now = Date.now, log = {} } = opts;
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const warned = new Set();

  const state = { lastFiredAt: 0, lastReason: null };

  /**
   * Pure decision (REQ-16): cast while the vocation gate passes and mana
   * feasibility holds; pause below cost+reserve.
   * @param {object} ctx - tick context { mana, maxMana }
   * @returns {{fire: boolean, reason: string, slot?: number}}
   */
  function decide(ctx = {}) {
    state.lastReason = null;
    if (!config || config.on !== true) return { fire: false, reason: 'off' };
    const slot = Number(config.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) return { fire: false, reason: 'no-slot' };

    // Vocation gate (live-probed hotbarManager.__canPlayerCastSpell).
    if (typeof canCastSpell === 'function') {
      try {
        if (canCastSpell(config.sid) === false) return { fire: false, reason: 'vocation-gate' };
      } catch (e) { /* gate read failure => skip the gate, never block */ }
    }

    // Mana feasibility: pause below cost+reserve (REQ-16).
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
      return { fire: false, reason: feas.reason === 'reserve' ? 'reserve' : 'insufficient' };
    }

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

    state.lastReason = 'train';
    return { fire: true, reason: 'train', slot };
  }

  /**
   * Execute the training cast (QUEUE-DISPATCHED ONLY, REQ-12).
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
// Slice-4 modules (REQ-13..17) — pure decision modules, tree-wired below.
const HEAL_ITEMS_MOD = require('agent/modules/heal-items');
const HEAL_MAGIC_MOD = require('agent/modules/heal-magic');
const RUNES_MOD = require('agent/modules/runes');
const TRAINING_MOD = require('agent/modules/training');
const EAT_MODULE_MOD = require('agent/modules/eat');

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
  healMagic: { on: false, threshold: 150, slot: null, sid: null },
  runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
  training: { on: false, slot: null, sid: null, reserve: 0 },
  eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
  armed: false,                                      // interconnection gate (REQ-02, slice 3)
};

/**
 * Deep-ish merge of known keys over the defaults (unknown keys dropped).
 * `armed` is the REQ-02 gate flag: ONLY an explicit true arms the engine —
 * anything else leaves the agent disarmed ("not connected").
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    queue: { minIntervalMs: 150 },
    jitter: { min: 50, max: 400 },
    survival: { on: true, threshold: 50, slot: null },
    rotation: { spells: [] },
    healItems: { on: false, threshold: 50, slotCids: [] },
    healMagic: { on: false, threshold: 150, slot: null, sid: null },
    runes: { on: false, attackSlot: null, healSlot: null, healThreshold: null },
    training: { on: false, slot: null, sid: null, reserve: 0 },
    eat: { on: false, everyCasts: 0, warningWindowSec: 60, fallbackIntervalSec: 10, slot: null, cids: [] },
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
  if (src.survival && typeof src.survival === 'object') {
    if (typeof src.survival.on === 'boolean') cfg.survival.on = src.survival.on;
    if (Number.isFinite(src.survival.threshold)) cfg.survival.threshold = src.survival.threshold;
    if (Number.isInteger(src.survival.slot)) cfg.survival.slot = src.survival.slot;
  }
  if (src.rotation && Array.isArray(src.rotation.spells)) {
    cfg.rotation.spells = src.rotation.spells.filter((s) => s && typeof s === 'object');
  }
  // --- Slice-4 module normalization (unknown keys dropped, invalid values default) ---
  const hi = src.healItems && typeof src.healItems === 'object' ? src.healItems : {};
  if (typeof hi.on === 'boolean') cfg.healItems.on = hi.on;
  if (Number.isFinite(hi.threshold)) cfg.healItems.threshold = hi.threshold;
  if (Array.isArray(hi.slotCids)) cfg.healItems.slotCids = hi.slotCids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
  const hm = src.healMagic && typeof src.healMagic === 'object' ? src.healMagic : {};
  if (typeof hm.on === 'boolean') cfg.healMagic.on = hm.on;
  if (Number.isFinite(hm.threshold)) cfg.healMagic.threshold = hm.threshold;
  if (Number.isInteger(hm.slot)) cfg.healMagic.slot = hm.slot;
  if (Number.isInteger(hm.sid)) cfg.healMagic.sid = hm.sid;
  const rn = src.runes && typeof src.runes === 'object' ? src.runes : {};
  if (typeof rn.on === 'boolean') cfg.runes.on = rn.on;
  if (Number.isInteger(rn.attackSlot)) cfg.runes.attackSlot = rn.attackSlot;
  if (Number.isInteger(rn.healSlot)) cfg.runes.healSlot = rn.healSlot;
  if (Number.isFinite(rn.healThreshold)) cfg.runes.healThreshold = rn.healThreshold;
  const tr = src.training && typeof src.training === 'object' ? src.training : {};
  if (typeof tr.on === 'boolean') cfg.training.on = tr.on;
  if (Number.isInteger(tr.slot)) cfg.training.slot = tr.slot;
  if (Number.isInteger(tr.sid)) cfg.training.sid = tr.sid;
  if (Number.isFinite(tr.reserve) && tr.reserve >= 0) cfg.training.reserve = tr.reserve;
  const ea = src.eat && typeof src.eat === 'object' ? src.eat : {};
  if (typeof ea.on === 'boolean') cfg.eat.on = ea.on;
  if (Number.isFinite(ea.everyCasts) && ea.everyCasts >= 0) cfg.eat.everyCasts = Math.floor(ea.everyCasts);
  if (Number.isFinite(ea.warningWindowSec) && ea.warningWindowSec > 0) cfg.eat.warningWindowSec = ea.warningWindowSec;
  if (Number.isFinite(ea.fallbackIntervalSec) && ea.fallbackIntervalSec > 0) cfg.eat.fallbackIntervalSec = ea.fallbackIntervalSec;
  if (Number.isInteger(ea.slot)) cfg.eat.slot = ea.slot;
  if (Array.isArray(ea.cids)) cfg.eat.cids = ea.cids.map(Number).filter(Number.isInteger).filter((n) => n >= 0);
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
  const log = opts.log || {
    error: (m) => { state.errors.push(String(m)); try { if (win && win.console) win.console.error('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    warn: (m) => { state.warnings.push(String(m)); try { if (win && win.console) win.console.warn('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
    info: (m) => { try { if (win && win.console) win.console.info('[__mbAgent] ' + m); } catch (e) { /* best-effort */ } },
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
  };

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
      now: nowFn,
      log,
    });
    const training = TRAINING_MOD.createTraining({
      config: cfg.training,
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
    state.modules = { healItems: healItems, healMagic: healMagic, runes: runes, training: training, eat: eat };

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
            // happens ONLY inside the queue-dispatched closure.
            state.queue.enqueue(function () { healItems.fire(d.item); }, { kind: 'heal-item' });
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
            state.queue.enqueue(function () {
              healMagic.fire(d, { gameClient: state.gameClient, document: doc });
            }, { kind: 'heal-magic' });
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
            // closure, never inline during the tree tick.
            state.queue.enqueue(function () {
              FIRING_MOD.fireSlot(cfg.survival.slot, {
                mode: 'handleClick',
                gameClient: state.gameClient,
                document: doc,
                log,
              });
            }, { kind: 'survival-heal' });
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

    // REQ-16: training — cast-to-train cadence via the queue; a training cast
    // advances the every-N-casts food cadence (ctx.castsSinceFood).
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
            return !state.queue.hasPending(function (e) { return e.kind === 'training-cast'; });
          },
        },
        {
          type: 'action',
          id: 'training-cast',
          run: function (ctx) {
            const d = training.decide(ctx);
            if (!d.fire) return false;
            state.queue.enqueue(function () {
              training.fire(d, { gameClient: state.gameClient, document: doc });
            }, { kind: 'training-cast' });
            ctx.castsSinceFood = (ctx.castsSinceFood || 0) + 1; // every-N-casts counts training casts
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
            state.queue.enqueue(function () { eat.fire(ctx, d); }, { kind: 'eat' });
            return true;
          },
        },
      ],
    };

    const loot = {
      type: 'sequence',
      id: 'loot',
      children: [
        { type: 'condition', id: 'loot-feasible', predicate: function () { return false; } }, // slice 5
        { type: 'action', id: 'loot-collect', run: function () { return false; } },
      ],
    };
    state.tree = createTree({
      root: {
        type: 'selector',
        id: 'priority-root',
        // heal (items + magic + legacy slot-heal) > runes > combat > training
        // > eat > loot (REQ-11: survival/heal always beats combat/loot/training).
        children: [healItemsNode, healMagicNode, survival, runesNode, combat, trainingNode, eatNode, loot],
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
        }, { kind: 'eat-rpc' });
        return { result: 'queued' };
      },
      getChat: function () { return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc }); },
      getRuneState: function () {
        const m = state.modules && state.modules.runes;
        return m ? m.getState() : null; // REQ-15 real module state (slice 4)
      },
      getWalkState: function () { return null; }, // slice 6
      getPlayerInfo: readPlayerInfo,
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
        eat: modules.eat ? modules.eat.getState() : null,
      },
      warnings: state.warnings.slice(),
      errors: state.errors.slice(),
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
