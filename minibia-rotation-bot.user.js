// ==UserScript==
// @name         Minibia Rotation Bot
// @namespace    minibia-rotation-bot
// @version      0.1.0
// @description  Auto-rotation for minibia.com/play: hotbar spell rotation, food management, jittered cadence, echo validation, catalog-backed UI.
// @match        https://minibia.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ---------------------------------------------------------------------------
 * USAGE (task 5.3)
 *
 * 1. INSTALL — add this script to Tampermonkey (it matches https://minibia.com/*).
 * 2. RUN THE CATALOG EXTRACTION ONCE — the catalog cannot be shipped in the
 *    script (it is built from live game data). Run
 *        node tools/extract-catalog.js
 *    and paste the printed snippet into the minibia.com/play console (logged
 *    in). It seeds the catalog into localStorage (mb-catalog) AND downloads
 *    catalog.json. The bot reads the seed first on start; the same-origin
 *    "catalog.json" fetch is the fallback for future hosted deployments.
 *    Until either is available the bot runs in keybind-only mode with a
 *    warning (REQ-10/11).
 * 3. CONFIGURE — use the floating panel: add spell rows (slot, threshold,
 *    reserve, repeat, order, word), set the food entry, jitter range and
 *    firing mode, then press Save.
 * 4. START — press Start; Pause freezes the counters (REQ-14); Reset stops
 *    the engine AND clears every mb-* key (persisted config + state, REQ-12).
 *
 * NOTE: Reset is destructive — it wipes your saved configuration too.
 * ------------------------------------------------------------------------- */

/* =====================================================================

 * GENERATED BUNDLE — src modules (core + adapters). Do NOT edit by hand:

 * regenerate with `node tools/build-userscript.js`.

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
 *   food: { slot, cid, name, warningWindowSec, fallbackIntervalSec },
 * }
 */

const DEFAULT_CONFIG = Object.freeze({
  jitter: { min: 50, max: 400 },
  firing: { mode: 'handleClick' },
  validation: { enabled: true, windowMs: 2500, pollMs: 100 },
  spells: [],
  food: { slot: null, cid: null, name: '', warningWindowSec: 60, fallbackIntervalSec: 10 },
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
 *     condition: (ctx) => boolean,       // is this rule feasible this tick?
 *     action: (ctx) => void,             // side effect; at most one per tick
 *     repeat?: number,                   // executions before completion (default 1)
 *   }
 *
 * The shared `ctx` is a mutable context object (mana, cooldowns, timers, ...)
 * that conditions read and actions write.
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
      rule.action(ctx);
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
 *   eatFood: (item: object|null) => {result: string, reason: string, attempts: number, paused: boolean},
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
   * @returns {{result: 'ate'|'failed'|'no-food', reason: string,
   *   attempts: number, paused: boolean}}
   */
  function eatFood(item = null) {
    // REQ-05: re-check SATED before eating.
    if (typeof isSated === 'function' && isSated() === true) {
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

    // REQ-05: re-check SATED after the attempt.
    const satedNow = typeof isSated === 'function' ? isSated() : null;
    if (executed && (satedNow === true || satedNow === null)) {
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

__mbModules['adapters/hud'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * HUD controller (REQ-14, design D8).
 *
 * Renders mana, next action, food/cooldown timers, counters (casts, eats,
 * validation misses, unknown words) and a recent log into a plain-DOM panel.
 * Refreshes on a default 500ms cadence (`start()`) plus an immediate
 * post-action `refresh()` the engine calls after each action. DOM reads are
 * re-queried on every refresh (chat is rebuilt wholesale — never hold refs).
 *
 * Pause FREEZES the counters (they keep their last rendered values while mana
 * and timers keep updating); Reset ZEROES the counters and re-renders them
 * (REQ-14). Everything is injectable (`document`, `getSnapshot`, timers) so
 * jsdom drives the full behavior deterministically.
 *
 * DOM contract for the panel (implemented by ui.js, Slice 3):
 *   [data-hud-mana], [data-hud-next], [data-hud-food], [data-hud-cooldown],
 *   [data-hud-status], [data-hud-casts], [data-hud-eats], [data-hud-misses],
 *   [data-hud-words], [data-hud-log]
 * Missing elements are skipped; rendering never throws.
 */

const COUNTER_FIELDS = {
  casts: 'casts',
  eats: 'eats',
  validationMisses: 'misses',
  unknownWords: 'words',
};

/** Format seconds as a short label; null/undefined -> em dash. */
function fmtSeconds(sec) {
  return sec === null || sec === undefined || !Number.isFinite(Number(sec)) ? '—' : `${sec}s`;
}

/**
 * Create the HUD controller.
 *
 * @param {object} [deps]
 * @param {Document|Element} [deps.document] - panel owner document (or container)
 * @param {() => object} [deps.getSnapshot] - reads current state, e.g.
 *   {mana, maxMana, health, foodSec, cooldownSec, nextAction, status}
 * @param {number} [deps.cadenceMs=500] - refresh cadence (REQ-14)
 * @param {(fn: Function, ms: number) => object} [deps.schedule=setInterval]
 * @param {(handle: object) => void} [deps.clear=clearInterval]
 * @param {number} [deps.maxLog=6] - log lines kept
 * @returns {{
 *   start: () => void, stop: () => void, refresh: () => void,
 *   pause: () => void, resume: () => void, isPaused: () => boolean,
 *   reset: () => void, increment: (which: string) => void,
 *   setCounters: (partial: object) => void, getCounters: () => object,
 *   addLog: (message: string) => void, getLog: () => Array<object>,
 * }}
 */
function createHud(deps = {}) {
  const {
    document: doc = null,
    getSnapshot = () => ({}),
    cadenceMs = 500,
    schedule = setInterval,
    clear = clearInterval,
    maxLog = 6,
  } = deps;

  const counters = { casts: 0, eats: 0, validationMisses: 0, unknownWords: 0 };
  const log = [];
  let timer = null;
  let paused = false;

  /** Query a single panel element (re-queried every render). */
  function el(attr) {
    return doc?.querySelector?.(`[data-hud-${attr}]`) ?? null;
  }

  /** Write text into a panel element when present. */
  function setText(attr, text) {
    const node = el(attr);
    if (node) node.textContent = text;
  }

  /** Render one refresh cycle (REQ-14). */
  function refresh() {
    const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};

    // Live reads: mana, timers, next action, status — always rendered.
    const mana = Number(snap.mana);
    const maxMana = Number(snap.maxMana);
    setText(
      'mana',
      Number.isFinite(mana) && Number.isFinite(maxMana) ? `${mana}/${maxMana}` : '—',
    );
    setText('next', snap.nextAction ?? '—');
    setText('food', fmtSeconds(snap.foodSec));
    setText('cooldown', fmtSeconds(snap.cooldownSec));
    setText('status', snap.status ?? (paused ? 'paused' : 'idle'));

    // Counters: frozen while paused (REQ-14), rendered otherwise.
    if (!paused) {
      setText(COUNTER_FIELDS.casts, String(counters.casts));
      setText(COUNTER_FIELDS.eats, String(counters.eats));
      setText(COUNTER_FIELDS.validationMisses, String(counters.validationMisses));
      setText(COUNTER_FIELDS.unknownWords, String(counters.unknownWords));
    }

    // Recent log.
    const logNode = el('log');
    if (logNode) {
      logNode.textContent = log.map((entry) => `${entry.message}`).join('\n');
    }
  }

  return {
    /** Begin the 500ms refresh cadence. */
    start() {
      if (timer !== null) return;
      timer = schedule(refresh, cadenceMs);
    },

    /** Stop the cadence. */
    stop() {
      if (timer !== null) {
        clear(timer);
        timer = null;
      }
    },

    /** Immediate refresh (engine calls this after each action, REQ-14). */
    refresh,

    /** Freeze the counters at their last rendered values (REQ-14). */
    pause() {
      paused = true;
    },

    /** Unfreeze the counters. */
    resume() {
      paused = false;
    },

    /** @returns {boolean} whether counters are frozen */
    isPaused: () => paused,

    /** Zero every counter and re-render them (REQ-14). */
    reset() {
      counters.casts = 0;
      counters.eats = 0;
      counters.validationMisses = 0;
      counters.unknownWords = 0;
      log.length = 0;
      refresh();
    },

    /** Increment one counter: casts | eats | validationMisses | unknownWords. */
    increment(which) {
      if (Object.prototype.hasOwnProperty.call(counters, which)) counters[which] += 1;
    },

    /** Merge partial counter values (e.g. restored from persistence). */
    setCounters(partial = {}) {
      for (const [key, value] of Object.entries(partial)) {
        if (Object.prototype.hasOwnProperty.call(counters, key) && Number.isFinite(Number(value))) {
          counters[key] = Number(value);
        }
      }
    },

    /** @returns {object} current counter values */
    getCounters: () => ({ ...counters }),

    /** Append a log line, keeping at most `maxLog` entries. */
    addLog(message) {
      log.push({ time: Date.now(), message: String(message) });
      if (log.length > maxLog) log.splice(0, log.length - maxLog);
    },

    /** @returns {Array<object>} recent log entries */
    getLog: () => [...log],
  };
}

module.exports = { createHud };

return module.exports;
})();

__mbModules['adapters/persist'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Persistence adapter (REQ-12, design D7).
 *
 * Capability probe: when GM APIs are present and functional they are used;
 * under `@grant none` (no GM at all) the adapter falls back to localStorage.
 * All keys are stored under the `mb-` prefix (REQ-12). Reset calls `clear()`,
 * which removes EVERY `mb-*` key. Both backends store JSON-encoded values and
 * expose the same shape, so swapping backends is invisible to callers.
 *
 * GM_* implementations may be synchronous (Tampermonkey) or promise-based
 * (Greasemonkey), so all methods are async and the probe awaits both styles.
 * Backends are injectable: `createPersist({ gm, storage, prefix })`.
 */

const PROBE_KEY = 'mb-__probe__';
const DEFAULT_PREFIX = 'mb-';

/** Namespace a raw key under the prefix (already-prefixed keys pass through). */
function nsKey(prefix, key) {
  return String(key).startsWith(prefix) ? String(key) : prefix + key;
}

/** Resolve a possibly-promise value. */
async function resolve(value) {
  return value && typeof value.then === 'function' ? value : value;
}

/**
 * Probe whether GM_getValue/GM_setValue actually work (sync or async).
 * @returns {Promise<boolean>}
 */
async function probeGm(gm) {
  if (!gm || typeof gm.setValue !== 'function' || typeof gm.getValue !== 'function') return false;
  try {
    const ret = gm.setValue(PROBE_KEY, '__probe__');
    if (ret && typeof ret.then === 'function') await ret;
    const got = await resolve(gm.getValue(PROBE_KEY));
    return got === '__probe__';
  } catch {
    return false;
  }
}

/** localStorage backend (operative under @grant none, REQ-12). */
function createLocalStorageBackend(storage, prefix) {
  return {
    async get(key) {
      try {
        const raw = storage.getItem(nsKey(prefix, key));
        if (raw === null || raw === undefined) return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        storage.setItem(nsKey(prefix, key), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    async clear(prefixOverride) {
      const p = prefixOverride ?? prefix;
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && String(k).startsWith(p)) keys.push(k);
      }
      for (const k of keys) storage.removeItem(k);
    },
  };
}

/** GM_setValue backend (used when the probe succeeds). */
function createGmBackend(gm, prefix) {
  const written = new Set(); // keys written through this adapter

  return {
    async get(key) {
      try {
        const raw = await resolve(gm.getValue(nsKey(prefix, key)));
        if (raw === null || raw === undefined) return null;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch {
            return raw; // not JSON-encoded (written by another tool)
          }
        }
        return raw;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        const ns = nsKey(prefix, key);
        const ret = gm.setValue(ns, JSON.stringify(value));
        if (ret && typeof ret.then === 'function') await ret;
        written.add(ns);
        return true;
      } catch {
        return false;
      }
    },
    async clear(prefixOverride) {
      const p = prefixOverride ?? prefix;
      // GM_listValues gives full coverage; the registry covers keys this
      // adapter wrote when listValues is unavailable.
      const listed = typeof gm.listValues === 'function' ? await resolve(gm.listValues()) : null;
      const keys = Array.isArray(listed)
        ? listed.filter((k) => String(k).startsWith(p))
        : [...written].filter((k) => String(k).startsWith(p));
      for (const k of keys) {
        try {
          const ret = gm.deleteValue ? gm.deleteValue(k) : null;
          if (ret && typeof ret.then === 'function') await ret;
        } catch {
          // Best-effort removal; a lingering key is non-fatal.
        }
        written.delete(k);
      }
    },
  };
}

/**
 * Create the persistence backend (async: GM capability probe).
 *
 * @param {object} [deps]
 * @param {object} [deps.gm] - GM object: {setValue, getValue, deleteValue?, listValues?}
 * @param {Storage|null} [deps.storage] - localStorage-like backend; defaults to
 *   globalThis.localStorage when available
 * @param {string} [deps.prefix='mb-'] - key prefix (REQ-12)
 * @returns {Promise<{get: (key: string) => Promise<*>,
 *   set: (key: string, value: *) => Promise<boolean>,
 *   clear: (prefix?: string) => Promise<void>,
 *   backend: 'gm'|'localStorage'|'none'}>}
 */
async function createPersist(deps = {}) {
  const { gm = null, storage = null, prefix = DEFAULT_PREFIX } = deps;

  if (await probeGm(gm)) {
    return { ...createGmBackend(gm, prefix), backend: 'gm' };
  }

  const ls = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
    return { ...createLocalStorageBackend(ls, prefix), backend: 'localStorage' };
  }

  return {
    backend: 'none',
    get: async () => null,
    set: async () => false,
    clear: async () => {},
  };
}

module.exports = { createPersist };

return module.exports;
})();

__mbModules['adapters/ui'] = (function () {
'use strict';
const module = { exports: {} };
const exports = module.exports;
const require = __mbRequire;
'use strict';

/**
 * Floating panel UI adapter (REQ-11/12, design D8).
 *
 * A plain-DOM, draggable, `position: fixed` panel that implements the
 * `[data-hud-*]` element contract documented in `hud.js` (mana, next action,
 * food/cooldown timers, status, counters, log) plus the configuration
 * surface: catalog search with image picker (REQ-11), spell entries
 * (slot/threshold/reserve/repeat/order/word), food entry (slot/cid/name,
 * warning window, fallback interval), jitter range and firing mode
 * (REQ-12/13), and Start/Pause/Reset/Save controls.
 *
 * The panel is a thin shell: every behavior is injectable.
 *   - `getCatalog()` feeds the search; `getSnapshot()` feeds the HUD fields.
 *   - `saveConfig(raw, prev)` performs validation + persistence. It returns
 *     `{ok, errors?, config?}`; a non-ok result renders the errors inline
 *     (REQ-12: threshold/reserve > maxMana rejected, previous value kept)
 *     and the previous saved config is retained.
 *   - `onStart/onPause/onReset` are wired to the buttons; the caller owns the
 *     engine lifecycle (the panel does not manage state on its own).
 *
 * No framework, no globals: `document`, `mount`, timers, log sinks are all
 * injected so jsdom drives the full behavior deterministically.
 */

/** Coerce an input value to a finite number, or null when empty/invalid. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a cid input: numeric strings become numbers, empty becomes null. */
function cid(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** Create an element with text and a data attribute. */
function el(doc, tag, attr, text) {
  const node = doc.createElement(tag);
  if (attr) node.setAttribute(attr, '');
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Create a labelled row: label text + an input element. */
function field(doc, labelText, input) {
  const row = el(doc, 'label');
  row.textContent = labelText;
  input.style.marginLeft = '4px';
  row.style.display = 'block';
  row.style.marginBottom = '3px';
  row.appendChild(input);
  return row;
}

/** Clamp a value into [min, max]. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Create the floating panel.
 *
 * @param {object} [deps]
 * @param {Document} [deps.document] - owner document (default globalThis.document)
 * @param {Element} [deps.mount] - container the panel is appended to
 *   (default document.body)
 * @param {() => Array<object>|null} [deps.getCatalog] - searchable catalog
 *   entries (null/undefined => keybind-only hint, REQ-11)
 * @param {() => object} [deps.getSnapshot] - HUD snapshot
 *   {mana, maxMana, health, foodSec, cooldownSec, nextAction, status}
 * @param {number} [deps.cadenceMs=500] - HUD refresh cadence (REQ-14)
 * @param {(fn: Function, ms: number) => object} [deps.schedule=setInterval]
 * @param {(handle: object) => void} [deps.clear=clearInterval]
 * @param {number} [deps.maxLog=6]
 * @param {(raw: object, prev: object) => Promise<{ok: boolean, errors?: string[], config?: object}>}
 *   [deps.saveConfig] - validate + persist the raw config (REQ-12)
 * @param {() => void} [deps.onStart] - Start button handler
 * @param {() => void} [deps.onPause] - Pause button handler
 * @param {() => void} [deps.onReset] - Reset button handler
 * @param {{warn?: Function, error?: Function}} [deps.log] - log sinks
 * @returns {{
 *   panel: Element, getHud: () => object,
 *   setConfig: (config: object) => void, getRawConfig: () => object,
 *   save: () => Promise<{ok: boolean, errors: string[], config?: object}>,
 *   setRunning: (running: boolean) => void, search: (query: string) => number,
 *   setErrors: (messages: string[]) => void, destroy: () => void,
 * }}
 */
function createUi(deps = {}) {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : null);
  const mount = deps.mount ?? doc?.body ?? null;
  const getCatalog = typeof deps.getCatalog === 'function' ? deps.getCatalog : () => null;
  const getSnapshot = typeof deps.getSnapshot === 'function' ? deps.getSnapshot : () => ({});
  const saveConfig = typeof deps.saveConfig === 'function' ? deps.saveConfig : null;
  const onStart = typeof deps.onStart === 'function' ? deps.onStart : null;
  const onPause = typeof deps.onPause === 'function' ? deps.onPause : null;
  const onReset = typeof deps.onReset === 'function' ? deps.onReset : null;
  const log = deps.log ?? {};
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};

  const panel = el(doc, 'div', 'data-ui-panel');
  let lastSaved = null; // last persisted/normalized config (REQ-12 keep-previous)
  let destroyed = false;

  // ---- panel shell styles: fixed, floating, readable over the game page ----
  Object.assign(panel.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    width: '320px',
    maxHeight: '90vh',
    overflowY: 'auto',
    zIndex: '2147483000',
    background: 'rgba(24, 26, 32, 0.96)',
    color: '#e8e8e8',
    font: '12px/1.45 system-ui, sans-serif',
    border: '1px solid #444',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    padding: '0 0 8px 0',
    userSelect: 'none',
  });

  // ---- header (drag handle) ----
  const header = el(doc, 'div', 'data-ui-header', 'Minibia Rotation Bot');
  Object.assign(header.style, {
    padding: '6px 10px',
    cursor: 'move',
    fontWeight: '600',
    borderBottom: '1px solid #444',
    marginBottom: '8px',
    userSelect: 'none',
  });
  panel.appendChild(header);

  // ---- status + live reads ([data-hud-*] contract, REQ-14) ----
  const statusRow = el(doc, 'div');
  statusRow.style.padding = '0 10px';
  statusRow.appendChild(field(doc, 'status', el(doc, 'span', 'data-hud-status', 'idle')));
  statusRow.appendChild(field(doc, 'mana', el(doc, 'span', 'data-hud-mana', '—')));
  statusRow.appendChild(field(doc, 'next', el(doc, 'span', 'data-hud-next', '—')));
  statusRow.appendChild(field(doc, 'food', el(doc, 'span', 'data-hud-food', '—')));
  statusRow.appendChild(field(doc, 'cooldown', el(doc, 'span', 'data-hud-cooldown', '—')));
  panel.appendChild(statusRow);

  // ---- counters (freeze on Pause, zero on Reset — REQ-14) ----
  const countersRow = el(doc, 'div');
  countersRow.style.padding = '0 10px';
  countersRow.appendChild(field(doc, 'casts', el(doc, 'span', 'data-hud-casts', '0')));
  countersRow.appendChild(field(doc, 'eats', el(doc, 'span', 'data-hud-eats', '0')));
  countersRow.appendChild(field(doc, 'misses', el(doc, 'span', 'data-hud-misses', '0')));
  countersRow.appendChild(field(doc, 'words', el(doc, 'span', 'data-hud-words', '0')));
  panel.appendChild(countersRow);

  // ---- log (recent lines, REQ-14) ----
  const logEl = el(doc, 'div', 'data-hud-log', '');
  Object.assign(logEl.style, {
    margin: '4px 10px',
    padding: '4px 6px',
    background: 'rgba(0,0,0,0.35)',
    borderRadius: '4px',
    whiteSpace: 'pre-wrap',
    maxHeight: '72px',
    overflowY: 'auto',
    fontFamily: 'ui-monospace, monospace',
  });
  panel.appendChild(logEl);

  // ---- controls ----
  const controls = el(doc, 'div');
  controls.style.padding = '0 10px';
  const startBtn = el(doc, 'button', 'data-ui-start', 'Start');
  const pauseBtn = el(doc, 'button', 'data-ui-pause', 'Pause');
  const resetBtn = el(doc, 'button', 'data-ui-reset', 'Reset');
  const saveBtn = el(doc, 'button', 'data-ui-save', 'Save');
  for (const btn of [startBtn, pauseBtn, resetBtn, saveBtn]) {
    btn.style.marginRight = '6px';
    btn.style.marginBottom = '6px';
    controls.appendChild(btn);
  }
  panel.appendChild(controls);
  pauseBtn.disabled = true;

  // ---- catalog search + image picker (REQ-11) ----
  const catalogSection = el(doc, 'div');
  catalogSection.style.padding = '0 10px';
  catalogSection.appendChild(el(doc, 'div', null, 'Catalog'));
  const searchInput = el(doc, 'input', 'data-ui-search');
  searchInput.type = 'text';
  searchInput.placeholder = 'search item by name…';
  searchInput.style.width = '100%';
  searchInput.style.boxSizing = 'border-box';
  searchInput.style.marginBottom = '4px';
  catalogSection.appendChild(searchInput);
  const resultsEl = el(doc, 'div', 'data-ui-search-results');
  resultsEl.style.maxHeight = '120px';
  resultsEl.style.overflowY = 'auto';
  catalogSection.appendChild(resultsEl);
  panel.appendChild(catalogSection);

  // ---- spell entries (REQ-12) ----
  const spellsSection = el(doc, 'div');
  spellsSection.style.padding = '0 10px';
  const spellsTitle = el(doc, 'div', null, 'Spells');
  spellsTitle.style.display = 'inline-block';
  spellsSection.appendChild(spellsTitle);
  const addSpellBtn = el(doc, 'button', 'data-ui-add-spell', '+ spell');
  addSpellBtn.style.marginLeft = '8px';
  addSpellBtn.style.marginBottom = '4px';
  spellsSection.appendChild(addSpellBtn);
  const spellsEl = el(doc, 'div', 'data-ui-spells');
  spellsSection.appendChild(spellsEl);
  panel.appendChild(spellsSection);
  // One empty row by default so the editor is discoverable.
  addSpellRow();

  // ---- food entry (REQ-05/12) ----
  const foodSection = el(doc, 'div');
  foodSection.style.padding = '0 10px';
  foodSection.appendChild(el(doc, 'div', null, 'Food'));
  const foodSlot = el(doc, 'input', 'data-ui-food-slot');
  foodSlot.type = 'number';
  foodSlot.min = '1';
  foodSlot.max = '12';
  const foodCid = el(doc, 'input', 'data-ui-food-cid');
  foodCid.type = 'text';
  const foodName = el(doc, 'input', 'data-ui-food-name');
  foodName.type = 'text';
  const foodWindow = el(doc, 'input', 'data-ui-food-window');
  foodWindow.type = 'number';
  const foodFallback = el(doc, 'input', 'data-ui-food-fallback');
  foodFallback.type = 'number';
  for (const input of [foodSlot, foodCid, foodName, foodWindow, foodFallback]) {
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    foodSection.appendChild(field(doc, input === foodSlot ? 'slot (1-12)' : input === foodCid ? 'cid' : input === foodName ? 'name' : input === foodWindow ? 'warning window (s)' : 'fallback interval (s)', input));
  }
  panel.appendChild(foodSection);

  // ---- jitter + firing mode (REQ-13) ----
  const jitterSection = el(doc, 'div');
  jitterSection.style.padding = '0 10px';
  jitterSection.appendChild(el(doc, 'div', null, 'Jitter (ms, clamped 50-400)'));
  const jitterMin = el(doc, 'input', 'data-ui-jitter-min');
  jitterMin.type = 'number';
  const jitterMax = el(doc, 'input', 'data-ui-jitter-max');
  jitterMax.type = 'number';
  jitterSection.appendChild(field(doc, 'min', jitterMin));
  jitterSection.appendChild(field(doc, 'max', jitterMax));
  const firingMode = el(doc, 'select', 'data-ui-firing-mode');
  for (const [value, label] of [['handleClick', 'click'], ['keyboard', 'keyboard']]) {
    const opt = el(doc, 'option');
    opt.value = value;
    opt.textContent = label;
    firingMode.appendChild(opt);
  }
  jitterSection.appendChild(field(doc, 'fire via', firingMode));
  panel.appendChild(jitterSection);

  // ---- inline errors (REQ-12) ----
  const errorsEl = el(doc, 'div', 'data-ui-errors');
  Object.assign(errorsEl.style, {
    display: 'none',
    margin: '6px 10px',
    padding: '4px 6px',
    background: 'rgba(160, 40, 40, 0.4)',
    border: '1px solid #a33',
    borderRadius: '4px',
    whiteSpace: 'pre-wrap',
    color: '#ffd9d9',
  });
  panel.appendChild(errorsEl);

  // ---- HUD controller (REQ-14): renders the [data-hud-*] elements ----
  const { createHud } = require('adapters/hud');
  const hud = createHud({
    document: doc,
    getSnapshot,
    cadenceMs: deps.cadenceMs ?? 500,
    schedule: deps.schedule,
    clear: deps.clear,
    maxLog: deps.maxLog,
  });

  // ---- spell row editor ----
  function addSpellRow(spell = null, { append = true } = {}) {
    const row = el(doc, 'div', 'data-ui-spell-row');
    row.style.border = '1px solid #555';
    row.style.borderRadius = '4px';
    row.style.padding = '4px 6px';
    row.style.marginBottom = '4px';

    const slot = el(doc, 'input', 'data-ui-spell-slot');
    slot.type = 'number';
    slot.min = '1';
    slot.max = '12';
    const threshold = el(doc, 'input', 'data-ui-spell-threshold');
    threshold.type = 'number';
    const reserve = el(doc, 'input', 'data-ui-spell-reserve');
    reserve.type = 'number';
    const repeat = el(doc, 'input', 'data-ui-spell-repeat');
    repeat.type = 'number';
    repeat.min = '1';
    const order = el(doc, 'input', 'data-ui-spell-order');
    order.type = 'number';
    const word = el(doc, 'input', 'data-ui-spell-word');
    word.type = 'text';

    const removeBtn = el(doc, 'button', 'data-ui-spell-remove', '✕');
    removeBtn.title = 'remove spell';
    removeBtn.style.float = 'right';

    const inputs = [
      [slot, 'slot'],
      [threshold, 'thr'],
      [reserve, 'rsv'],
      [repeat, 'rep'],
      [order, 'ord'],
      [word, 'word'],
    ];
    for (const [input, label] of inputs) {
      input.style.width = '72px';
      input.style.margin = '0 6px 3px 0';
      input.placeholder = label;
      row.appendChild(input);
    }
    row.appendChild(removeBtn);
    if (append) spellsEl.appendChild(row);

    if (spell) {
      slot.value = spell.slot ?? '';
      threshold.value = spell.threshold ?? '';
      reserve.value = spell.reserve ?? '';
      repeat.value = spell.repeat ?? '';
      order.value = spell.order ?? '';
      word.value = spell.word ?? '';
    }

    removeBtn.addEventListener('click', () => {
      row.remove();
    });

    return row;
  }

  // ---- config collection / application ----
  function collectSpells() {
    const rows = spellsEl.querySelectorAll('[data-ui-spell-row]');
    const spells = [];
    for (const row of rows) {
      spells.push({
        slot: num(row.querySelector('[data-ui-spell-slot]').value),
        threshold: num(row.querySelector('[data-ui-spell-threshold]').value) ?? 0,
        reserve: num(row.querySelector('[data-ui-spell-reserve]').value) ?? 0,
        repeat: num(row.querySelector('[data-ui-spell-repeat]').value) ?? 1,
        order: num(row.querySelector('[data-ui-spell-order]').value) ?? spells.length,
        word: row.querySelector('[data-ui-spell-word]').value.trim(),
      });
    }
    return spells;
  }

  /** Collect the raw config straight from the inputs (not normalized). */
  function getRawConfig() {
    return {
      jitter: { min: num(jitterMin.value) ?? 0, max: num(jitterMax.value) ?? 0 },
      firing: { mode: firingMode.value },
      spells: collectSpells(),
      food: {
        slot: num(foodSlot.value),
        cid: cid(foodCid.value),
        name: foodName.value.trim(),
        warningWindowSec: num(foodWindow.value) ?? 60,
        fallbackIntervalSec: num(foodFallback.value) ?? 10,
      },
    };
  }

  /** Populate every input from a (normalized) config. */
  function setConfig(config) {
    if (!config) return;
    lastSaved = config;
    jitterMin.value = config.jitter?.min ?? '';
    jitterMax.value = config.jitter?.max ?? '';
    firingMode.value = config.firing?.mode ?? 'handleClick';
    spellsEl.textContent = '';
    for (const spell of config.spells ?? []) addSpellRow(spell);
    if (config.spells?.length === 0) addSpellRow();
    foodSlot.value = config.food?.slot ?? '';
    foodCid.value = config.food?.cid ?? '';
    foodName.value = config.food?.name ?? '';
    foodWindow.value = config.food?.warningWindowSec ?? '';
    foodFallback.value = config.food?.fallbackIntervalSec ?? '';
    setErrors([]);
  }

  // ---- inline errors (REQ-12: rejected values keep the previous config) ----
  function setErrors(messages) {
    if (!messages || messages.length === 0) {
      errorsEl.style.display = 'none';
      errorsEl.textContent = '';
      return;
    }
    errorsEl.style.display = 'block';
    errorsEl.textContent = messages.join('\n');
  }

  async function save() {
    if (typeof saveConfig !== 'function') {
      setErrors(['saveConfig not wired']);
      return { ok: false, errors: ['saveConfig not wired'] };
    }
    try {
      const res = await saveConfig(getRawConfig(), lastSaved ?? {});
      if (res && res.ok) {
        lastSaved = res.config ?? getRawConfig();
        setErrors([]);
        return { ok: true, errors: [], config: lastSaved };
      }
      const errors = res?.errors ?? ['save rejected'];
      setErrors(errors);
      return { ok: false, errors, config: lastSaved ?? undefined };
    } catch (err) {
      const message = `save failed: ${err?.message ?? err}`;
      error(message);
      setErrors([message]);
      return { ok: false, errors: [message] };
    }
  }

  // ---- search + image picker (REQ-11) ----
  const SEARCH_LIMIT = 30;

  function renderSearch(query) {
    resultsEl.textContent = '';
    const catalog = getCatalog();
    if (!catalog) {
      const hint = el(doc, 'div', null, 'catalog missing — keybind-only mode (REQ-11)');
      hint.style.color = '#ffb3a0';
      resultsEl.appendChild(hint);
      return 0;
    }
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return 0;
    let count = 0;
    for (const entry of catalog) {
      if (count >= SEARCH_LIMIT) break;
      const name = String(entry.name ?? '');
      if (!name.toLowerCase().includes(q)) continue;
      const item = el(doc, 'div', 'data-ui-search-result');
      item.style.cursor = 'pointer';
      item.style.padding = '2px 4px';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.gap = '6px';
      if (typeof entry.imageDataURL === 'string') {
        const img = doc.createElement('img');
        img.src = entry.imageDataURL;
        img.alt = entry.name;
        img.width = 24;
        img.height = 24;
        item.appendChild(img);
      }
      const label = el(doc, 'span', null, `${entry.name} (${entry.cid})`);
      item.appendChild(label);
      item.addEventListener('click', () => {
        foodCid.value = entry.cid ?? '';
        foodName.value = entry.name ?? '';
        setErrors([]);
      });
      resultsEl.appendChild(item);
      count += 1;
    }
    if (count === 0) {
      resultsEl.appendChild(el(doc, 'div', null, 'no matches'));
    }
    return count;
  }

  // ---- dragging ----
  let drag = null;
  function onHeaderDown(e) {
    if (e.button !== 0) return;
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: parseFloat(panel.style.left) || 0,
      origTop: parseFloat(panel.style.top) || 0,
    };
    e.preventDefault();
  }
  function onDocMove(e) {
    if (!drag) return;
    const viewportW = doc.defaultView?.innerWidth ?? 0;
    const viewportH = doc.defaultView?.innerHeight ?? 0;
    const width = panel.getBoundingClientRect().width || 320;
    const height = panel.getBoundingClientRect().height || 240;
    const left = clamp(drag.origLeft + e.clientX - drag.startX, 0, Math.max(0, viewportW - width));
    const top = clamp(drag.origTop + e.clientY - drag.startY, 0, Math.max(0, viewportH - height));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  }
  function onDocUp() {
    drag = null;
  }
  header.addEventListener('mousedown', onHeaderDown);
  if (doc?.addEventListener) {
    doc.addEventListener('mousemove', onDocMove);
    doc.addEventListener('mouseup', onDocUp);
  }

  // ---- buttons ----
  startBtn.addEventListener('click', () => onStart?.());
  pauseBtn.addEventListener('click', () => onPause?.());
  resetBtn.addEventListener('click', () => onReset?.());
  saveBtn.addEventListener('click', () => {
    save().catch((err) => error(`save threw: ${err?.message ?? err}`));
  });
  addSpellBtn.addEventListener('click', () => addSpellRow());
  searchInput.addEventListener('input', () => renderSearch(searchInput.value));

  /** Reflect the engine running state on the button enablement. */
  function setRunning(running) {
    startBtn.disabled = Boolean(running);
    pauseBtn.disabled = !running;
  }

  // ---- mount ----
  if (mount && typeof mount.appendChild === 'function') {
    mount.appendChild(panel);
  } else {
    error('ui: no mount container; panel not attached');
  }
  // Render the initial HUD state once (mana/timers/counters on first paint).
  hud.refresh();

  /** Remove the panel and every listener. */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    hud.stop();
    if (doc?.removeEventListener) {
      doc.removeEventListener('mousemove', onDocMove);
      doc.removeEventListener('mouseup', onDocUp);
    }
    header.removeEventListener('mousedown', onHeaderDown);
    panel.remove();
  }

  return {
    panel,
    getHud: () => hud,
    setConfig,
    getRawConfig,
    save,
    setRunning,
    search: renderSearch,
    setErrors,
    destroy,
  };
}

module.exports = { createUi };

return module.exports;
})();

/* =========================================================================
 * BOOTSTRAP (task 4.3)
 *
 * Polls for window.gameClient + gameClient.interface.hotbarManager, then
 * wires core + adapters (await createPersist — the GM capability probe is
 * async), builds the rotation rules from the persisted config, drives a
 * jittered ticker (Web Worker when the tab is hidden, graceful degrade +
 * warning when workers are unsupported — REQ-04) and connects Start/Pause/
 * Reset to the floating panel (REQ-12).
 *
 * Internal handle: window.__minibiaBot — {poll, isReady, start, pause,
 * reset, destroy, getState, tickOnce}. window.__mbBootConfig may override
 * boot parameters (used by the jsdom wiring smoke tests).
 * ========================================================================= */
(function () {
  'use strict';

  const CONFIG_MOD = __mbRequire('core/config');
  const JITTER_MOD = __mbRequire('core/jitter');
  const FEAS_MOD = __mbRequire('core/feasibility');
  const CD_MOD = __mbRequire('core/cooldown');
  const ROTATION_MOD = __mbRequire('core/rotation');
  const SATED_MOD = __mbRequire('core/sated');
  const VALID_MOD = __mbRequire('core/validation');
  const GC_MOD = __mbRequire('adapters/gameClient');
  const FIRING_MOD = __mbRequire('adapters/firing');
  const EAT_MOD = __mbRequire('adapters/eat');
  const CHAT_MOD = __mbRequire('adapters/chat');
  const CATALOG_MOD = __mbRequire('adapters/catalog');
  const HUD_MOD = __mbRequire('adapters/hud');
  const PERSIST_MOD = __mbRequire('adapters/persist');
  const UI_MOD = __mbRequire('adapters/ui');

  function createBot(opts = {}) {
    const win = opts.win || window;
    const doc = opts.document || win.document;
    const pollIntervalMs = opts.pollIntervalMs !== undefined ? opts.pollIntervalMs : 500;
    const readyTimeoutMs = opts.readyTimeoutMs !== undefined ? opts.readyTimeoutMs : 120000;

    const setIntervalFn = opts.setInterval || win.setInterval.bind(win);
    const clearIntervalFn = opts.clearInterval || win.clearInterval.bind(win);
    const setTimeoutFn = opts.setTimeout || win.setTimeout.bind(win);
    const clearTimeoutFn = opts.clearTimeout || win.clearTimeout.bind(win);
    const WorkerCtor = opts.Worker !== undefined ? opts.Worker : win.Worker;
    const BlobCtor = opts.Blob !== undefined ? opts.Blob : win.Blob;
    const URLRef = opts.URL !== undefined ? opts.URL : win.URL;
    const fetchImpl = opts.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);

    const state = {
      ready: false,
      running: false,
      startedAt: 0,
      destroyed: false,
      gameClient: null,
      playerName: null,
      config: null,
      persist: null,
      catalog: null,
      hud: null,
      ui: null,
      eater: null,
      validator: null,
      engine: null,
      ticker: null,
      pollTimer: null,
      pollCount: 0,
      lastFiredWord: '',
      warnings: [],
      errors: [],
    };
    const warnedSet = new Set();

    const logSinks = {
      warn: function (m) {
        state.warnings.push(String(m));
        if (state.hud) state.hud.addLog('warn: ' + m);
      },
      error: function (m) {
        state.errors.push(String(m));
        if (state.hud) state.hud.addLog('error: ' + m);
      },
    };
    function warn(m) { logSinks.warn(m); }

    /* ---------- readiness polling (design: gameClient + hotbarManager) ---------- */
    function poll() {
      if (state.ready || state.destroyed) return state.ready;
      const gameClient = opts.gameClient !== undefined ? opts.gameClient : win.gameClient;
      const hotbar = gameClient && ((gameClient.interface && gameClient.interface.hotbarManager) || gameClient.hotbarManager);
      if (!gameClient || !hotbar || typeof hotbar.__handleClick !== 'function') {
        state.pollCount += 1;
        if (state.pollCount * pollIntervalMs > readyTimeoutMs) {
          state.pollCount = 0;
          warn('bootstrap: gameClient/hotbarManager not found yet — still waiting');
        }
        return false;
      }
      state.gameClient = gameClient;
      wire(gameClient);
      return true;
    }

    /* ---------- live reads ---------- */
    function readMaxMana() {
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      return stats.maxMana !== null ? stats.maxMana : null;
    }

    /** Best-effort spell cost from the client spellbook, else spell.cost. */
    function readSpellCost(spell) {
      let cost = null;
      try {
        const sb = state.gameClient && state.gameClient.player && state.gameClient.player.spellbook;
        if (sb && spell.sid !== null && spell.sid !== undefined) {
          const entry = (typeof sb.getSpell === 'function' ? sb.getSpell(spell.sid) : null)
            || (sb.spells && sb.spells[spell.sid]) || null;
          if (entry && entry.cost !== undefined) cost = Number(entry.cost);
        }
      } catch (e) { cost = null; }
      if ((cost === null || !Number.isFinite(cost)) && Number.isFinite(Number(spell.cost))) cost = Number(spell.cost);
      return cost !== null && Number.isFinite(cost) ? cost : null;
    }

    /** Food state: SATED flag primary, #skill-window timer fallback (REQ-05/06). */
    function readFoodState(foodCfg) {
      let sated = null;
      try {
        const conditions = state.gameClient && state.gameClient.player && state.gameClient.player.conditions;
        if (conditions && typeof conditions.has === 'function') sated = conditions.has('SATED') === true;
      } catch (e) { sated = null; }
      let timerEl = null;
      try { timerEl = doc.querySelector('#skill-window div[skill="food"] .skill'); } catch (e) { timerEl = null; }
      let timerSec = null;
      if (timerEl) timerSec = SATED_MOD.parseFoodTimer(timerEl.textContent); // null = expired/unparseable (REQ-05)
      if (sated === true) return { eat: false, source: 'sated', sated, timerSec };
      if (sated === false) return { eat: true, source: 'flag', sated, timerSec };
      if (timerEl) {
        return {
          eat: timerSec === null || timerSec <= (foodCfg.warningWindowSec || 60),
          source: timerSec === null ? 'expired' : 'timer',
          sated: null,
          timerSec,
        };
      }
      return { eat: null, source: 'none', sated: null, timerSec: null }; // REQ-06 fallback interval
    }

    /** Best-effort food slot element (client containers, then DOM window). */
    function resolveFoodItem(foodCfg) {
      let element = null;
      const index = foodCfg.slot;
      try {
        const gc = state.gameClient;
        const containers = [gc.containerPrototype, gc.backpack, (gc.interface && gc.interface.containerPrototype) || null];
        for (let c = 0; c < containers.length; c++) {
          const slots = containers[c] && containers[c].slots;
          if (slots && Array.isArray(slots)) {
            const slot = slots[index - 1];
            if (slot) {
              element = slot.element || (slot.canvas && slot.canvas.canvas) || null;
              if (element) break;
            }
          }
        }
      } catch (e) { element = null; }
      if (!element) {
        try {
          const root = doc.querySelector('#container-prototype');
          if (root) {
            const nodes = root.querySelectorAll('.slot, [data-slot], [class*="slot"]');
            element = nodes[index - 1] || nodes[index] || null;
          }
        } catch (e) { element = null; }
      }
      return { element, index, cid: foodCfg.cid };
    }

    /* ---------- rules (CastSpell, EatFood — design D9) ---------- */
    function makeCastRule(spell) {
      return {
        id: 'cast-slot-' + spell.slot,
        order: Number.isFinite(spell.order) ? spell.order : spell.slot,
        condition: function (ctx) {
          if (ctx.mana === null || ctx.mana === undefined) return false;
          if (spell.threshold > 0 && ctx.mana < spell.threshold) return false;
          const cost = readSpellCost(spell);
          if (cost !== null) {
            const feas = FEAS_MOD.canCast({
              mana: ctx.mana,
              cost,
              reserve: spell.reserve || 0,
              maxMana: ctx.maxMana,
              key: 'slot-' + spell.slot,
              warned: warnedSet,
              onWarn: function (m) { if (state.hud) state.hud.addLog(m); },
            });
            if (!feas.fire) return false;
          }
          const cd = GC_MOD.readCooldown(spell.sid, { gameClient: state.gameClient });
          const verdict = CD_MOD.canFire({
            cooldown: cd.cooldown,
            globalCooldown: cd.globalCooldown,
            cooldownMs: spell.cooldownMs || 0,
            lastFiredAt: ctx.lastFiredAt ? ctx.lastFiredAt[spell.slot] : null,
            now: Date.now(),
            onGapLog: function (m) { if (state.hud) state.hud.addLog(m); },
          });
          return verdict.fire;
        },
        action: function (ctx) {
          const fired = FIRING_MOD.fireSlot(spell.slot, {
            mode: state.config.firing.mode,
            gameClient: state.gameClient,
            document: doc,
            log: logSinks,
          });
          if (!fired) return;
          ctx.lastFiredAt = ctx.lastFiredAt || {};
          ctx.lastFiredAt[spell.slot] = Date.now();
          state.hud.increment('casts');
          state.hud.addLog('cast slot ' + spell.slot);
          if (spell.word) {
            state.lastFiredWord = spell.word;
            state.validator.start('slot-' + spell.slot); // REQ-09 words-path echo check
          }
        },
        repeat: Math.max(1, Number(spell.repeat) || 1),
      };
    }

    function makeEatRule(foodCfg) {
      return {
        id: 'eat-food',
        order: 1000, // after the configured spell order
        condition: function (ctx) {
          if (state.eater.isPaused()) return false;
          const fs = readFoodState(foodCfg);
          if (fs.eat === true) return true;
          if (fs.eat === false) return false;
          const elapsed = Date.now() - (ctx.lastEatAt || 0);
          return elapsed >= (foodCfg.fallbackIntervalSec || 10) * 1000; // REQ-06
        },
        action: function (ctx) {
          const res = state.eater.eatFood(resolveFoodItem(foodCfg));
          if (res.result === 'ate') {
            ctx.lastEatAt = Date.now();
            state.hud.increment('eats');
            state.hud.addLog('ate (' + res.reason + ')');
          } else if (res.result === 'failed') {
            state.hud.addLog('eat failed: ' + res.reason);
          }
        },
        repeat: 1,
      };
    }

    function buildRules(config) {
      const rules = [];
      const spells = (config.spells || []).filter(function (s) {
        return Number.isInteger(s.slot) && s.slot >= 1 && s.slot <= 12;
      });
      for (let i = 0; i < spells.length; i++) rules.push(makeCastRule(spells[i]));
      if (config.food && Number.isInteger(config.food.slot)) rules.push(makeEatRule(config.food));
      return rules;
    }

    /* ---------- echo validator (REQ-09) ---------- */
    function buildValidator() {
      const vcfg = state.config.validation || {};
      return VALID_MOD.createValidator({
        windowMs: vcfg.windowMs !== undefined ? vcfg.windowMs : 2500,
        pollMs: vcfg.pollMs !== undefined ? vcfg.pollMs : 100,
        enabled: vcfg.enabled !== false,
        getCandidates: function () {
          return CHAT_MOD.getRecentMessages({ gameClient: state.gameClient, document: doc });
        },
        isMatch: function (entry) {
          if (!entry || entry.name !== state.playerName) return false;
          const raw = state.lastFiredWord || '';
          const trimmed = raw.trim();
          if (!trimmed) return false;
          const m = trimmed.match(/^\/(.+)\/([a-z]*)$/);
          if (m) {
            try { return new RegExp(m[1], m[2]).test(entry.message); } catch (e) { return false; }
          }
          return entry.message === trimmed;
        },
        onResult: function (r) {
          if (r.result === 'pass') state.hud.addLog('echo ok: ' + r.fireId);
          if (r.result === 'miss') {
            state.hud.increment('validationMisses');
            state.hud.addLog('echo miss: ' + r.fireId + ' (REQ-09, no refire)');
          }
        },
      });
    }

    /* ---------- ticker (REQ-04/13): jittered cadence, Worker when hidden ---------- */
    function createTicker() {
      let pending = null;
      let worker = null;
      let hidden = false;

      function jitterRange() {
        const j = (state.config && state.config.jitter) || { min: 50, max: 400 };
        return { min: j.min, max: j.max };
      }
      function stopAll() {
        if (pending !== null) { clearTimeoutFn(pending); pending = null; }
        if (worker) { try { worker.terminate(); } catch (e) { /* best-effort */ } worker = null; }
      }
      function arm() {
        if (!state.running || pending !== null) return;
        const j = jitterRange();
        pending = setTimeoutFn(function () {
          pending = null;
          tickOnce();
          if (state.running) arm(); // self-scheduling jittered cadence (REQ-13)
        }, JITTER_MOD.randomDelay(j.min, j.max));
      }
      function startWorker() {
        try {
          if (typeof WorkerCtor !== 'function' || typeof BlobCtor !== 'function'
            || !URLRef || typeof URLRef.createObjectURL !== 'function') {
            throw new Error('Web Worker unsupported');
          }
          const j = jitterRange();
          const src = 'var lo=' + j.min + ',hi=' + j.max + ';'
            + '(function post(){postMessage("tick");setTimeout(post,lo+Math.floor(Math.random()*(hi-lo+1)));})();';
          const url = URLRef.createObjectURL(new BlobCtor([src], { type: 'application/javascript' }));
          const instance = new WorkerCtor(url);
          instance.onmessage = function () { if (state.running) tickOnce(); };
          worker = instance;
          return true;
        } catch (err) {
          worker = null;
          return false;
        }
      }
      return {
        start: function () { stopAll(); arm(); },
        stop: stopAll,
        toHidden: function () {
          if (hidden) return;
          hidden = true;
          if (!state.running) return;
          stopAll();
          if (!startWorker()) {
            warn('hidden-tab ticker unavailable (' + (WorkerCtor ? 'worker failed' : 'no Worker API') + '); degrading to page timer (REQ-04)');
            arm(); // graceful degrade — cadence continues, throttled by the browser
          }
        },
        toVisible: function () {
          if (!hidden) return;
          hidden = false;
          stopAll();
          if (state.running) arm();
        },
        usesWorker: function () { return worker !== null; },
      };
    }

    /* ---------- one engine tick ---------- */
    function describeNext() {
      try {
        const rules = state.engine.rules;
        const ctx = state.engine.getCtx();
        for (let i = 0; i < rules.length; i++) {
          if (rules[i].condition(ctx)) {
            return rules[i].id === 'eat-food' ? 'eat' : ('cast slot ' + rules[i].id.replace('cast-slot-', ''));
          }
        }
        return null;
      } catch (e) { return null; }
    }

    function tickOnce() {
      if (!state.running || !state.ready) return;
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      const ctx = state.engine.getCtx();
      ctx.mana = stats.mana !== null ? stats.mana : ctx.mana;
      ctx.maxMana = stats.maxMana !== null ? stats.maxMana : ctx.maxMana;
      ctx.health = stats.health;
      ctx.nextAction = describeNext();
      const result = state.engine.tick(); // at most one action per tick (REQ-03)
      if (result.fired) state.hud.refresh();
    }

    function buildSnapshot() {
      const stats = GC_MOD.readStats({ gameClient: state.gameClient, document: doc });
      const ctx = state.engine ? state.engine.getCtx() : {};
      let foodSec = null;
      let cooldownSec = null;
      try {
        if (state.config && state.config.food && Number.isInteger(state.config.food.slot)) {
          const fs = readFoodState(state.config.food);
          if (fs.timerSec !== null && fs.timerSec !== undefined) foodSec = fs.timerSec;
        }
        const spells = (state.config && state.config.spells) || [];
        for (let i = 0; i < spells.length; i++) {
          const cd = GC_MOD.readCooldown(spells[i].sid, { gameClient: state.gameClient });
          const entry = (cd.globalCooldown && cd.globalCooldown.active) ? cd.globalCooldown
            : (cd.cooldown && cd.cooldown.active) ? cd.cooldown : null;
          if (entry) cooldownSec = Math.max(cooldownSec || 0, entry.seconds || 0);
        }
      } catch (e) { /* snapshot is best-effort */ }
      const status = !state.ready ? 'waiting' : state.running ? 'running' : (state.startedAt ? 'paused' : 'idle');
      return {
        mana: stats.mana,
        maxMana: stats.maxMana,
        health: stats.health,
        status,
        nextAction: ctx.nextAction || null,
        foodSec,
        cooldownSec,
      };
    }

    /* ---------- controls ---------- */
    function start() {
      if (!state.ready) { warn('start: bot not ready — game client not found yet'); return false; }
      if (state.running) return true;
      state.running = true;
      state.startedAt = Date.now();
      state.hud.resume();
      state.ticker.start();
      state.hud.addLog('started');
      state.ui.setRunning(true);
      return true;
    }

    function pause() {
      if (!state.running) return false;
      state.running = false;
      state.ticker.stop();
      state.hud.pause(); // counters freeze (REQ-14)
      state.hud.refresh();
      state.hud.addLog('paused — counters frozen (REQ-14)');
      state.ui.setRunning(false);
      return true;
    }

    async function reset() {
      state.running = false;
      state.ticker.stop();
      state.hud.reset(); // counters zeroed + re-rendered (REQ-14)
      if (state.persist) {
        try { await state.persist.clear(); } catch (e) { warn('reset: clear failed (' + (e && e.message ? e.message : e) + ')'); }
      }
      state.engine = ROTATION_MOD.createEngine({ rules: buildRules(state.config), ctx: {} });
      state.eater = EAT_MOD.createEater(eaterDeps());
      state.startedAt = 0;
      state.hud.addLog('reset — all mb-* keys cleared (REQ-12)');
      state.ui.setRunning(false);
      return true;
    }

    /* ---------- config save (REQ-12: reject threshold/reserve > maxMana) ---------- */
    async function saveConfig(raw, prev) {
      const maxMana = readMaxMana();
      const out = CONFIG_MOD.normalizeConfig(
        raw || {},
        prev || CONFIG_MOD.DEFAULT_CONFIG,
        maxMana !== null ? maxMana : Infinity,
        logSinks,
      );
      if (out.errors.length > 0) return { ok: false, errors: out.errors };
      await state.persist.set('config', out.config);
      state.config = out.config;
      state.engine = ROTATION_MOD.createEngine({ rules: buildRules(out.config), ctx: {} });
      state.validator = buildValidator();
      return { ok: true, errors: [], config: out.config };
    }

    function eaterDeps() {
      return {
        gameClient: state.gameClient,
        document: doc,
        isSated: function () { return readFoodState(state.config.food).sated; },
        setPaused: function () { warn('eating paused after consecutive failures (REQ-06)'); },
        hudAlert: function (m) { if (state.hud) state.hud.addLog(m); },
        log: logSinks,
      };
    }

    function onVisibility() {
      if (doc.hidden) state.ticker.toHidden();
      else state.ticker.toVisible();
    }

    /* ---------- wiring (await createPersist — it is async) ---------- */
    async function wire(gameClient) {
      try {
        state.playerName = (gameClient.player && gameClient.player.name) || null;
        state.persist = await PERSIST_MOD.createPersist({
          gm: win.GM,
          storage: opts.localStorage !== undefined ? opts.localStorage : win.localStorage,
        });
        state.catalog = await CATALOG_MOD.loadCatalog('catalog.json', {
          fetch: fetchImpl,
          storage: opts.localStorage !== undefined ? opts.localStorage : win.localStorage,
          log: logSinks,
        });
        if (!state.catalog || state.catalog === 'corrupt') {
          state.catalog = null;
          warn('catalog unavailable — keybind-only mode (REQ-11)');
        }

        const saved = await state.persist.get('config');
        const maxMana = readMaxMana();
        const out = CONFIG_MOD.normalizeConfig(
          saved || {},
          CONFIG_MOD.DEFAULT_CONFIG,
          maxMana !== null ? maxMana : Infinity,
          logSinks,
        );
        state.config = out.config;

        state.hud = HUD_MOD.createHud({
          document: doc,
          getSnapshot: buildSnapshot,
          cadenceMs: 500,
          schedule: setIntervalFn,
          clear: clearIntervalFn,
        });
        state.ui = UI_MOD.createUi({
          document: doc,
          mount: doc.body,
          getCatalog: function () { return state.catalog; },
          getSnapshot: buildSnapshot,
          saveConfig,
          onStart: start,
          onPause: pause,
          onReset: reset,
          log: logSinks,
          schedule: setIntervalFn,
          clear: clearIntervalFn,
        });
        state.ui.setConfig(state.config);
        state.hud.start();

        state.eater = EAT_MOD.createEater(eaterDeps());
        state.validator = buildValidator();
        state.engine = ROTATION_MOD.createEngine({ rules: buildRules(state.config), ctx: {} });
        state.ticker = createTicker();
        if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);

        state.ready = true;
        state.hud.addLog('ready — player ' + (state.playerName || '?') + (state.catalog ? ', catalog loaded' : ', keybind-only mode'));
      } catch (err) {
        state.errors.push('wire failed: ' + (err && err.message ? err.message : String(err)));
        warn('bootstrap wiring failed: ' + (err && err.message ? err.message : err));
      }
    }

    /* ---------- lifecycle ---------- */
    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      if (state.pollTimer !== null) clearIntervalFn(state.pollTimer);
      state.running = false;
      if (state.ticker) state.ticker.stop();
      if (state.hud) state.hud.stop();
      if (state.ui) state.ui.destroy();
      if (state.validator) state.validator.dispose();
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
    }

    function getState() {
      return {
        ready: state.ready,
        running: state.running,
        startedAt: state.startedAt,
        warnings: state.warnings.slice(),
        errors: state.errors.slice(),
        persistBackend: state.persist ? state.persist.backend : null,
        catalogMode: state.catalog ? 'full' : 'keybind-only',
        playerName: state.playerName,
        pollCount: state.pollCount,
        tickerWorker: state.ticker ? state.ticker.usesWorker() : false,
      };
    }

    state.pollTimer = setIntervalFn(poll, pollIntervalMs);

    return {
      poll,
      isReady: function () { return state.ready; },
      start,
      pause,
      reset,
      destroy,
      tickOnce,
      getState,
    };
  }

  /* ---------- auto-boot on the real page ---------- */
  function boot() {
    let cfg = {};
    try {
      if (window.__mbBootConfig && typeof window.__mbBootConfig === 'object') cfg = window.__mbBootConfig;
    } catch (e) { /* keep defaults */ }
    const bot = createBot(cfg);
    window.__minibiaBot = bot; // polling is armed inside createBot
  }

  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    boot();
  }
})();
