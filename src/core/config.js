'use strict';

const { clampJitter } = require('./jitter');

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
