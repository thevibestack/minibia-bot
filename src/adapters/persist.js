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
