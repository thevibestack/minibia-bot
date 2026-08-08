'use strict';

/**
 * Userscript bundle builder (tasks 4.3 + 5.3).
 *
 * Assembles `minibia-rotation-bot.user.js`: the Tampermonkey metadata block,
 * the usage header (install -> run extraction once -> configure -> start;
 * Reset clears all `mb-*` keys), the bundled src modules (core + adapters)
 * and the hand-written bootstrap that polls for the game client, wires the
 * engine, drives the jittered ticker (Web Worker when the tab is hidden,
 * graceful degrade + warning — REQ-04) and connects Start/Pause/Reset to the
 * UI.
 *
 * Single source of truth: the committed userscript is GENERATED from
 * `src/**` by this tool. `node tools/build-userscript.js` regenerates it;
 * `--check` fails when the committed file drifted from the build (also
 * asserted by test/userscript-build.test.js, so `npm test` guards it).
 *
 * Module sources are wrapped in a tiny registry (`__mbModules` +
 * `__mbRequire`) with relative `require('./x')` calls rewritten to registry
 * keys, so the exact CommonJS modules under test run in the page unchanged.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'minibia-rotation-bot.user.js');

/** Registry name -> source path. Order matters for the registry (deps first). */
const MODULES = [
  ['core/jitter', 'src/core/jitter.js'],
  ['core/config', 'src/core/config.js'],
  ['core/feasibility', 'src/core/feasibility.js'],
  ['core/cooldown', 'src/core/cooldown.js'],
  ['core/rotation', 'src/core/rotation.js'],
  ['core/sated', 'src/core/sated.js'],
  ['core/validation', 'src/core/validation.js'],
  ['core/dedupe', 'src/core/dedupe.js'],
  ['adapters/gameClient', 'src/adapters/gameClient.js'],
  ['adapters/firing', 'src/adapters/firing.js'],
  ['adapters/eat', 'src/adapters/eat.js'],
  ['adapters/chat', 'src/adapters/chat.js'],
  ['adapters/catalog', 'src/adapters/catalog.js'],
  ['adapters/hud', 'src/adapters/hud.js'],
  ['adapters/persist', 'src/adapters/persist.js'],
  ['adapters/ui', 'src/adapters/ui.js'],
];

const HEADER = `// ==UserScript==
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
 * 3. CONFIGURE — the panel opens as a 5-step wizard: (1) welcome with the
 *    detected character, (2) pick the hotbar slot + spell word (search the
 *    catalog by name with images, or type the word yourself), (3) when to
 *    cast (mana threshold + how much mana to keep saved), (4) how many casts
 *    before switching + optional food automation ("eat every N casts" — 0 =
 *    by food timer only; food slot empty = food automation off), (5) review
 *    the plain-language summary and press Start playing. The panel collapses
 *    to a small bar (bot state, mana, casts) and hides behind a tiny handle,
 *    so it never blocks the game. Advanced options (firing mode, random
 *    delay range, food timer window/fallback) sit under the review step.
 * 4. START — press Start playing (or Start); Pause freezes the counters
 *    (REQ-14); Reset stops the engine AND clears every mb-* key (persisted
 *    config + state, REQ-12).
 *
 * NOTE: Reset is destructive — it wipes your saved configuration too.
 * ------------------------------------------------------------------------- */

`;

/**
 * Wrap one module source into a registry entry with a local require that
 * resolves relative requires to registry keys.
 * @param {string} regName - registry key, e.g. 'core/config'
 * @param {string} source - original CommonJS module source
 * @returns {string} wrapped registry assignment
 */
function wrapModule(regName, source) {
  const dir = regName.split('/')[0];
  const rewritten = source.replace(/require\(\s*'\.\/([\w-]+)'\s*\)/g, (m, name) => {
    return "require('" + dir + '/' + name + "')";
  });
  return (
    "__mbModules['" + regName + "'] = (function () {\n"
    + "'use strict';\n"
    + "const module = { exports: {} };\n"
    + "const exports = module.exports;\n"
    + "const require = __mbRequire;\n"
    + rewritten + '\n'
    + 'return module.exports;\n'
    + '})();'
  );
}

/** Bundle every src module into the registry. @returns {string} */
function bundleModules() {
  const parts = [
    '/* =====================================================================',
    ' * GENERATED BUNDLE — src modules (core + adapters). Do NOT edit by hand:',
    ' * regenerate with `node tools/build-userscript.js`.',
    ' * ===================================================================== */',
    "const __mbModules = Object.create(null);",
    'function __mbRequire(name) {',
    "  if (!__mbModules[name]) throw new Error('mb module not found: ' + name);",
    '  return __mbModules[name];',
    '}',
  ];
  for (const [regName, file] of MODULES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    parts.push(wrapModule(regName, source));
  }
  return parts.join('\n\n');
}

/* =========================================================================
 * BOOTSTRAP (task 4.3) — hand-written wiring on top of the bundled modules.
 * ========================================================================= */
const BOOTSTRAP = `/* =========================================================================
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
          if (!fired) return false;
          ctx.lastFiredAt = ctx.lastFiredAt || {};
          ctx.lastFiredAt[spell.slot] = Date.now();
          state.hud.increment('casts');
          state.hud.addLog('cast slot ' + spell.slot);
          if (spell.word) {
            state.lastFiredWord = spell.word;
            state.validator.start('slot-' + spell.slot); // REQ-09 words-path echo check
          }
          return true; // confirmed execution — advances the every-Casts cadence counter
        },
        kind: 'cast',
        repeat: Math.max(1, Number(spell.repeat) || 1),
      };
    }

    function makeEatRule(foodCfg) {
      const everyCasts = Number(foodCfg.everyCasts) || 0; // 0 = disabled
      return {
        id: 'eat-food',
        order: 1000, // after the configured spell order
        condition: function (ctx) {
          if (state.eater.isPaused()) return false;
          if (everyCasts > 0) {
            // Forced cadence (user-requested every-N-casts mode): eat when N
            // confirmed magic casts have landed since the last forced eat.
            // Timer/SATED logic is bypassed in this mode.
            return (ctx.castsSinceFood || 0) >= everyCasts;
          }
          const fs = readFoodState(foodCfg);
          if (fs.eat === true) return true;
          if (fs.eat === false) return false;
          const elapsed = Date.now() - (ctx.lastEatAt || 0);
          return elapsed >= (foodCfg.fallbackIntervalSec || 10) * 1000; // REQ-06
        },
        action: function (ctx) {
          const opts = everyCasts > 0 ? { force: true } : {};
          const res = state.eater.eatFood(resolveFoodItem(foodCfg), opts);
          if (everyCasts > 0) ctx.castsSinceFood = 0; // forced cadence resets after the attempt
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
          const m = trimmed.match(/^\\/(.+)\\/([a-z]*)$/);
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
        playerName: state.playerName,
        casts: state.hud ? state.hud.getCounters().casts : 0,
        nextAction: ctx.nextAction || null,
        foodSec,
        cooldownSec,
        everyCasts: (state.config && state.config.food && Number(state.config.food.everyCasts)) || 0,
        castsSinceFood: ctx.castsSinceFood || 0,
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
          getSnapshot: function () {
            // The mini bar / status dot live off the SAME 500ms cadence —
            // no extra timers, no layout thrash (paintMini only writes text).
            const snap = buildSnapshot();
            if (state.ui) state.ui.paintMini(snap);
            return snap;
          },
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
`;

/** Assemble the full userscript source. @returns {string} */
function buildUserscript() {
  return HEADER + bundleModules() + '\n\n' + BOOTSTRAP;
}

/** Write the userscript to disk. @returns {string} output path */
function run() {
  fs.writeFileSync(OUTPUT, buildUserscript(), 'utf8');
  return OUTPUT;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const built = buildUserscript();
    const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;
    if (committed === built) {
      process.stdout.write('userscript up to date: ' + OUTPUT + '\n');
    } else {
      process.stderr.write('DRIFT: ' + OUTPUT + ' differs from the build. Run `node tools/build-userscript.js` and commit the result.\n');
      process.exit(1);
    }
  } else {
    process.stdout.write('wrote ' + run() + '\n');
  }
}

module.exports = { buildUserscript, run, MODULES, wrapModule, bundleModules };
