'use strict';

/** Canonical values used when the PWA exposes or omits a live datum. */
const AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
});

/** Convert a raw PWA scalar to a finite number without inventing zero. */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Keep only a plain serializable metadata object. */
function serializableObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalize the different spell shapes exposed by MiniTibia at the boundary.
 * `cost` and `mana` are accepted only here; all internal consumers use
 * `manaCost` so a client shape change cannot silently disable casting.
 */
function normalizeLiveSpell(raw = {}, opts = {}) {
  const source = typeof opts.source === 'string'
    ? opts.source
    : (typeof raw.source === 'string' ? raw.source : 'unknown');
  const sidCandidate = raw.sid === undefined ? opts.sid : raw.sid;
  const sidNumber = finiteNumber(sidCandidate);
  const manaCandidate = raw.manaCost ?? raw.cost ?? raw.mana;
  const manaCost = finiteNumber(manaCandidate);
  const level = finiteNumber(raw.level);
  const vocations = Array.isArray(raw.vocations)
    ? raw.vocations.filter((value) => typeof value === 'string')
    : [];

  return {
    sid: Number.isInteger(sidNumber) ? sidNumber : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    words: typeof raw.words === 'string' ? raw.words : '',
    manaCost,
    level,
    vocations,
    category: typeof raw.category === 'string' && raw.category ? raw.category : null,
    icon: serializableObject(raw.icon),
    imageDataURL: typeof raw.imageDataURL === 'string' && raw.imageDataURL.indexOf('data:image/') === 0
      ? raw.imageDataURL
      : null,
    source,
  };
}

/** Normalize the CAP reader shape into an explicit availability contract. */
function normalizeCapacity(raw = {}) {
  const value = finiteNumber(raw.capacity ?? raw.value);
  const maximum = finiteNumber(raw.maxCapacity ?? raw.maximum);
  const suppliedRatio = finiteNumber(raw.ratio);
  const ratio = suppliedRatio !== null
    ? suppliedRatio
    : (value !== null && maximum !== null && maximum > 0 ? value / maximum : null);
  const availability = value !== null && maximum !== null && ratio !== null
    ? AVAILABILITY.AVAILABLE
    : AVAILABILITY.UNAVAILABLE;

  return {
    value,
    maximum,
    ratio,
    source: typeof raw.source === 'string' ? raw.source : 'none',
    availability,
  };
}

/**
 * Compose primitive stat/CAP readers into the serializable live contract.
 * Missing values stay null and are marked unavailable; they never become 0.
 */
function normalizeLiveStats(stats = {}, cap = {}) {
  const health = finiteNumber(stats.health);
  const maxHealth = finiteNumber(stats.maxHealth);
  const mana = finiteNumber(stats.mana);
  const maxMana = finiteNumber(stats.maxMana);
  const capacity = normalizeCapacity(cap);

  return {
    health,
    maxHealth,
    mana,
    maxMana,
    capacity,
    source: typeof stats.source === 'string' ? stats.source : 'none',
    availability: {
      health: health !== null && maxHealth !== null ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
      mana: mana !== null && maxMana !== null ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
      capacity: capacity.availability,
    },
  };
}

module.exports = {
  AVAILABILITY,
  finiteNumber,
  normalizeLiveSpell,
  normalizeCapacity,
  normalizeLiveStats,
};
