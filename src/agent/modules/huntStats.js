'use strict';

const { createPremiumReader } = require('../../core/premium');

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

  // Eager premium read (REQ-22): panel-facing state computed on getState —
  // shared reader (core/premium) so every gated module exposes the same shape.
  const currentPremium = createPremiumReader(readPremium);

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
