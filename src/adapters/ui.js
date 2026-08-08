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
  const { createHud } = require('./hud');
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
