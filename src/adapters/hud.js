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
 *   [data-hud-status], [data-hud-every-casts], [data-hud-casts],
 *   [data-hud-eats], [data-hud-misses], [data-hud-words], [data-hud-log]
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

    // Forced eat cadence (food.everyCasts): show the configured N and the
    // casts remaining until the next forced eat. '—' when the cadence is off.
    const everyCasts = Number(snap.everyCasts) || 0;
    if (everyCasts > 0) {
      const since = Number(snap.castsSinceFood) || 0;
      setText('every-casts', `every ${everyCasts} (rem ${Math.max(0, everyCasts - since)})`);
    } else {
      setText('every-casts', '—');
    }

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
