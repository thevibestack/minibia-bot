'use strict';

/**
 * Wizard-style configuration panel UI adapter (REQ-11/12/14, D8 — redesigned).
 *
 * User feedback (2026-08-08): the original dense form panel was rejected —
 * "la interfaz es una locura", "no tengo cómo ocultarlo", "el bot no debe
 * robar la pantalla". This rewrite replaces the raw form with a guided 5-step
 * wizard, adds collapse-to-bar and hide-to-handle states, keeps the panel
 * small and bottom-right, and uses plain-language copy everywhere (no cryptic
 * placeholders like thr/rsv/rep/ord).
 *
 * Wizard flow (inside the panel, no modals):
 *   1 WELCOME — "This assistant configures your auto-rotation. Detected
 *     character: <name>." Shows a Resume button when a config exists.
 *   2 SPELLS — pick hotbar slot (1-12) + spell word, via catalog search with
 *     images or typed manually ("This is the magic you'll auto-cast").
 *   3 WHEN — mana threshold ("Cast when your mana reaches:") + optional
 *     reserve ("Keep this much mana saved — useful for escape/heal").
 *   4 REPEAT + FOOD — "How many casts before switching:" + "Eat every N
 *     casts:" (0 = by food timer only) + optional food slot/name.
 *   5 REVIEW + START — plain-language summary + Save / Start playing.
 *
 * Panel anatomy (all inside the [data-ui-panel] root):
 *   - header: drag handle + status dot + minimize/hide buttons
 *   - body: the wizard OR the run view ([data-hud-*] fields + Start/Pause/
 *     Configure/Reset)
 *   - mini bar: status dot + mana + casts + expand/hide (bot keeps running)
 *   - floating handle: tiny square that fully hides the panel from the game
 *   - shared inline error area (friendly, plain language)
 *
 * Non-blocking guarantees:
 *   - position: fixed, bottom-right, 280px wide; header-draggable and
 *     viewport-clamped
 *   - no overlays or modals — the wizard lives inside the panel itself
 *   - pointer-events are only ever active on the panel box (or the 28px
 *     handle); everything outside passes straight to the game
 *   - the mini bar + status dot ride the existing 500ms HUD cadence via the
 *     paintMini(snapshot) hook — no extra timers, no layout thrash
 *
 * Contracts preserved (tests + bootstrap depend on them):
 *   - [data-ui-panel] root and the [data-hud-*] contract (hud.js)
 *   - createUi API: panel, getHud, setConfig, getRawConfig, save, setRunning,
 *     search, setErrors, paintMini, destroy
 *   - the exact raw config shape consumed by saveConfig (REQ-12 pipeline):
 *     { jitter, firing, spells[], food } — spells get `order` = list index.
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

/** Create an element with a text and an optional single data attribute. */
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
  row.style.marginBottom = '4px';
  row.appendChild(input);
  return row;
}

/** Clamp a value into [min, max]. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Format mana as "cur/max", em dash when unknown. */
function fmtMana(mana, maxMana) {
  const m = Number(mana);
  const mx = Number(maxMana);
  return Number.isFinite(m) && Number.isFinite(mx) ? `${m}/${mx}` : '—';
}

/** Compact panel button styling. */
function styleButton(btn) {
  Object.assign(btn.style, {
    background: '#2b2f36',
    color: '#e8e8e8',
    border: '1px solid #555',
    borderRadius: '4px',
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: '12px',
  });
}

/**
 * Create the wizard panel.
 *
 * @param {object} [deps]
 * @param {Document} [deps.document] - owner document (default globalThis.document)
 * @param {Element} [deps.mount] - container the panel is appended to
 *   (default document.body)
 * @param {() => Array<object>|null} [deps.getCatalog] - searchable catalog
 *   entries (null/undefined => manual-word hint, REQ-11)
 * @param {() => object} [deps.getSnapshot] - HUD snapshot
 *   {mana, maxMana, playerName, status, ...}
 * @param {number} [deps.cadenceMs=500] - HUD refresh cadence (REQ-14)
 * @param {(fn: Function, ms: number) => object} [deps.schedule=setInterval]
 * @param {(handle: object) => void} [deps.clear=clearInterval]
 * @param {number} [deps.maxLog=6]
 * @param {(raw: object, prev: object) => Promise<{ok: boolean, errors?: string[], config?: object}>}
 *   [deps.saveConfig] - validate + persist the raw config (REQ-12)
 * @param {(action: 'register'|'ignore', offer: {word: string, at: number, sid: number|null}, slot?: string) => void}
 *   [deps.onOfferAction] - REQ-15 decision callback: 'register' writes the word
 *   into the rotation (user-confirmed), 'ignore' keeps it silent this session.
 *   Nothing is written to config without the user's explicit confirmation.
 * @param {() => void} [deps.onStart] - Start button handler
 * @param {() => void} [deps.onPause] - Pause button handler
 * @param {() => void} [deps.onReset] - Reset button handler
 * @param {{warn?: Function, error?: Function}} [deps.log] - log sinks
 * @returns {{
 *   panel: Element, getHud: () => object,
 *   setConfig: (config: object) => void, getRawConfig: () => object,
 *   save: () => Promise<{ok: boolean, errors: string[], config?: object}>,
 *   setRunning: (running: boolean) => void,
 *   search: (query: string, rowIndex?: number) => number,
 *   setErrors: (messages: string[]) => void, paintMini: (snapshot: object) => void,
 *   showOffer: (offer: {word: string, at: number, sid: number|null}) => void,
 *   destroy: () => void,
 * }}
 */
function createUi(deps = {}) {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : null);
  const mount = deps.mount ?? doc?.body ?? null;
  const getCatalog = typeof deps.getCatalog === 'function' ? deps.getCatalog : () => null;
  const baseGetSnapshot = typeof deps.getSnapshot === 'function' ? deps.getSnapshot : () => ({});
  const saveConfig = typeof deps.saveConfig === 'function' ? deps.saveConfig : null;
  const onStart = typeof deps.onStart === 'function' ? deps.onStart : null;
  const onPause = typeof deps.onPause === 'function' ? deps.onPause : null;
  const onReset = typeof deps.onReset === 'function' ? deps.onReset : null;
  const onOfferAction = typeof deps.onOfferAction === 'function' ? deps.onOfferAction : null;
  const log = deps.log ?? {};
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};

  const panel = el(doc, 'div', 'data-ui-panel');
  const SEARCH_LIMIT = 30;
  const STEP_TITLES = ['', 'Welcome', 'Your spells', 'When to cast', 'Repeating & food', 'Review'];
  const PANEL_WIDTH = '280px';
  const PANEL_MAX_HEIGHT = 'calc(100vh - 24px)';
  let lastSaved = null; // last persisted/normalized config (REQ-12 keep-previous)
  let destroyed = false;
  let step = 1;
  let hasSavedConfig = false; // a real rotation was persisted (Resume offered)

  // ---- panel shell: fixed, compact, bottom-right, never full-screen ----
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    width: PANEL_WIDTH,
    maxHeight: PANEL_MAX_HEIGHT,
    overflowY: 'auto',
    zIndex: '2147483000',
    background: 'rgba(24, 26, 32, 0.96)',
    color: '#e8e8e8',
    font: '12px/1.45 system-ui, sans-serif',
    border: '1px solid #444',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    padding: '0',
    userSelect: 'none',
  });

  // ---- header (drag handle): title + status dot + minimize/hide ----
  const header = el(doc, 'div', 'data-ui-header');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    cursor: 'move',
    fontWeight: '600',
    borderBottom: '1px solid #444',
    userSelect: 'none',
  });
  const dot = el(doc, 'span', 'data-ui-status-dot');
  Object.assign(dot.style, {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#9e9e9e',
    display: 'inline-block',
    flex: '0 0 auto',
  });
  const headerTitle = el(doc, 'span', null, 'Minibia Rotation Bot');
  headerTitle.style.flex = '1';
  const minimizeBtn = el(doc, 'button', 'data-ui-minimize', '–');
  minimizeBtn.title = 'Minimize';
  const hideBtn = el(doc, 'button', 'data-ui-hide', 'Hide');
  hideBtn.title = 'Hide panel completely';
  for (const b of [minimizeBtn, hideBtn]) styleButton(b);
  header.appendChild(dot);
  header.appendChild(headerTitle);
  header.appendChild(minimizeBtn);
  header.appendChild(hideBtn);
  panel.appendChild(header);

  // ---- body: wizard OR run view ----
  const body = el(doc, 'div', 'data-ui-body');
  panel.appendChild(body);

  // ---- shared friendly inline errors (REQ-12) ----
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
  body.appendChild(errorsEl);

  /* =====================================================================
   * WIZARD
   * ===================================================================== */
  const wizard = el(doc, 'div', 'data-ui-wizard');
  const indicator = el(doc, 'div', 'data-ui-step-indicator', 'Step 1 of 5');
  indicator.style.padding = '6px 10px 0 10px';
  indicator.style.fontWeight = '600';
  const wizTitle = el(doc, 'div', 'data-ui-wizard-title', 'Welcome');
  wizTitle.style.padding = '2px 10px 4px 10px';
  wizTitle.style.opacity = '0.85';
  const steps = el(doc, 'div', 'data-ui-wizard-steps');
  steps.style.padding = '0 10px';
  const welcomeStep = el(doc, 'section', 'data-ui-step-welcome');
  const spellStep = el(doc, 'section', 'data-ui-step-spell');
  const whenStep = el(doc, 'section', 'data-ui-step-when');
  const repeatStep = el(doc, 'section', 'data-ui-step-repeat');
  const reviewStep = el(doc, 'section', 'data-ui-step-review');
  for (const s of [welcomeStep, spellStep, whenStep, repeatStep, reviewStep]) {
    s.style.display = 'none';
    s.style.marginTop = '6px';
    steps.appendChild(s);
  }
  const nav = el(doc, 'div', 'data-ui-wizard-nav');
  nav.style.padding = '6px 10px 8px 10px';
  const backBtn = el(doc, 'button', 'data-ui-wizard-back', 'Back');
  const nextBtn = el(doc, 'button', 'data-ui-wizard-next', 'Next');
  for (const b of [backBtn, nextBtn]) styleButton(b);
  nav.appendChild(backBtn);
  nav.appendChild(nextBtn);
  wizard.appendChild(indicator);
  wizard.appendChild(wizTitle);
  wizard.appendChild(steps);
  wizard.appendChild(nav);
  body.appendChild(wizard);

  // ---- step 1: welcome ----
  const welcomeIntro = el(doc, 'p', null, 'This assistant configures your auto-rotation.');
  welcomeIntro.style.margin = '4px 0';
  const welcomeName = el(doc, 'p', null, 'Detected character: ');
  const nameSpan = el(doc, 'span', 'data-ui-welcome-name', 'your character');
  welcomeName.appendChild(nameSpan);
  welcomeName.style.margin = '4px 0';
  const savedHint = el(doc, 'p', null, 'You already have a rotation configured.');
  savedHint.style.margin = '8px 0 4px 0';
  const welcomeStart = el(doc, 'button', 'data-ui-welcome-start', 'Get started');
  const resumeBtn = el(doc, 'button', 'data-ui-resume', 'Resume configured rotation');
  const reconfigureBtn = el(doc, 'button', 'data-ui-reconfigure', 'Configure again');
  for (const b of [welcomeStart, resumeBtn, reconfigureBtn]) {
    styleButton(b);
    b.style.display = 'block';
    b.style.marginBottom = '6px';
    b.style.width = '100%';
  }
  welcomeStep.appendChild(welcomeIntro);
  welcomeStep.appendChild(welcomeName);
  welcomeStep.appendChild(savedHint);
  welcomeStep.appendChild(welcomeStart);
  welcomeStep.appendChild(resumeBtn);
  welcomeStep.appendChild(reconfigureBtn);

  // ---- step 2: spells (slot + word, catalog search per row) ----
  const spellHelp = el(
    doc,
    'p',
    null,
    "These are the spells you'll auto-cast, in order. Find a spell in the catalog or type its word yourself.",
  );
  spellHelp.style.margin = '4px 0';
  const spellRowsEl = el(doc, 'div', 'data-ui-spell-rows');
  const addSpellBtn = el(doc, 'button', 'data-ui-add-spell', '+ Add another spell');
  styleButton(addSpellBtn);
  spellStep.appendChild(spellHelp);
  spellStep.appendChild(spellRowsEl);
  spellStep.appendChild(addSpellBtn);

  // ---- step 3: when to cast (threshold + reserve per spell) ----
  const whenHelp = el(
    doc,
    'p',
    null,
    'When should each spell fire? Leave 0 to cast whenever your mana allows.',
  );
  whenHelp.style.margin = '4px 0';
  const whenRowsEl = el(doc, 'div', 'data-ui-when-rows');
  const whenNote = el(
    doc,
    'p',
    null,
    'Keeping mana saved is useful for escape or heal spells. Leave 0 to use everything.',
  );
  whenNote.style.margin = '6px 0 4px 0';
  whenNote.style.opacity = '0.8';
  whenStep.appendChild(whenHelp);
  whenStep.appendChild(whenRowsEl);
  whenStep.appendChild(whenNote);

  // ---- step 4: repeat + food ----
  const repeatHelp = el(
    doc,
    'p',
    null,
    'How long should the bot keep casting each spell before switching?',
  );
  repeatHelp.style.margin = '4px 0';
  const repeatRowsEl = el(doc, 'div', 'data-ui-repeat-rows');
  const foodTitle = el(doc, 'div', null, 'Food (optional)');
  foodTitle.style.fontWeight = '600';
  foodTitle.style.marginTop = '8px';
  const foodHelp = el(
    doc,
    'p',
    null,
    'Leave the food slot empty to disable food automation entirely.',
  );
  foodHelp.style.margin = '4px 0';
  foodHelp.style.opacity = '0.8';
  const foodSlot = el(doc, 'select', 'data-ui-food-slot');
  const emptyFoodOpt = el(doc, 'option');
  emptyFoodOpt.value = '';
  emptyFoodOpt.textContent = '— off —';
  foodSlot.appendChild(emptyFoodOpt);
  for (let i = 1; i <= 12; i++) {
    const opt = el(doc, 'option');
    opt.value = String(i);
    opt.textContent = String(i);
    foodSlot.appendChild(opt);
  }
  const foodCid = el(doc, 'input', 'data-ui-food-cid');
  foodCid.type = 'text';
  foodCid.style.display = 'none'; // set by the catalog picker; kept for the config pipeline
  const foodName = el(doc, 'input', 'data-ui-food-name');
  foodName.type = 'text';
  foodName.placeholder = 'e.g. seasoned ham';
  const foodFindBtn = el(doc, 'button', 'data-ui-food-find', 'Find in catalog');
  styleButton(foodFindBtn);
  const foodSearchWrap = el(doc, 'div');
  foodSearchWrap.style.display = 'none';
  const foodSearchInput = el(doc, 'input', 'data-ui-food-search');
  foodSearchInput.type = 'text';
  foodSearchInput.placeholder = 'search item by name…';
  foodSearchInput.style.width = '100%';
  foodSearchInput.style.boxSizing = 'border-box';
  const foodSearchResults = el(doc, 'div', 'data-ui-food-results');
  Object.assign(foodSearchResults.style, {
    maxHeight: '90px',
    overflowY: 'auto',
  });
  foodSearchWrap.appendChild(foodSearchInput);
  foodSearchWrap.appendChild(foodSearchResults);
  const foodEveryCasts = el(doc, 'input', 'data-ui-food-every-casts');
  foodEveryCasts.type = 'number';
  foodEveryCasts.min = '0';
  foodEveryCasts.placeholder = '0 = food timer only';
  const everyCastsHint = el(
    doc,
    'p',
    null,
    '0 = eat by the food timer only. With a number, the bot also eats every N magic casts.',
  );
  everyCastsHint.style.margin = '2px 0 4px 0';
  everyCastsHint.style.opacity = '0.8';
  const foodAdvToggle = el(doc, 'button', 'data-ui-advanced-toggle', 'Advanced food options');
  styleButton(foodAdvToggle);
  const foodAdv = el(doc, 'div', 'data-ui-food-advanced');
  foodAdv.style.display = 'none';
  const foodWindow = el(doc, 'input', 'data-ui-food-window');
  foodWindow.type = 'number';
  const foodFallback = el(doc, 'input', 'data-ui-food-fallback');
  foodFallback.type = 'number';
  foodAdv.appendChild(field(doc, 'Eat when the food timer is under (seconds):', foodWindow));
  foodAdv.appendChild(field(doc, 'No timer data? Try eating every (seconds):', foodFallback));
  repeatStep.appendChild(repeatHelp);
  repeatStep.appendChild(repeatRowsEl);
  repeatStep.appendChild(foodTitle);
  repeatStep.appendChild(foodHelp);
  repeatStep.appendChild(field(doc, 'Food slot:', foodSlot));
  repeatStep.appendChild(foodCid);
  repeatStep.appendChild(field(doc, 'Food name:', foodName));
  repeatStep.appendChild(foodFindBtn);
  repeatStep.appendChild(foodSearchWrap);
  repeatStep.appendChild(field(doc, 'Eat every N casts:', foodEveryCasts));
  repeatStep.appendChild(everyCastsHint);
  repeatStep.appendChild(foodAdvToggle);
  repeatStep.appendChild(foodAdv);

  // ---- step 5: review + start ----
  const reviewSummary = el(doc, 'pre', 'data-ui-review-summary', '');
  Object.assign(reviewSummary.style, {
    whiteSpace: 'pre-wrap',
    margin: '4px 0 8px 0',
    fontFamily: 'inherit',
  });
  const advToggle = el(doc, 'button', 'data-ui-advanced-toggle', 'Advanced options');
  styleButton(advToggle);
  const adv = el(doc, 'div', 'data-ui-advanced');
  adv.style.display = 'none';
  const jitterMin = el(doc, 'input', 'data-ui-jitter-min');
  jitterMin.type = 'number';
  const jitterMax = el(doc, 'input', 'data-ui-jitter-max');
  jitterMax.type = 'number';
  const firingMode = el(doc, 'select', 'data-ui-firing-mode');
  for (const [value, label] of [
    ['handleClick', 'Game click (recommended)'],
    ['keyboard', 'Keyboard (F-key)'],
  ]) {
    const opt = el(doc, 'option');
    opt.value = value;
    opt.textContent = label;
    firingMode.appendChild(opt);
  }
  adv.appendChild(field(doc, 'Random delay between actions (ms) — min:', jitterMin));
  adv.appendChild(field(doc, 'Random delay between actions (ms) — max:', jitterMax));
  adv.appendChild(field(doc, 'Fire spells via:', firingMode));
  const saveBtn = el(doc, 'button', 'data-ui-save', 'Save configuration');
  const startBtn = el(doc, 'button', 'data-ui-start', 'Start playing');
  for (const b of [saveBtn, startBtn]) styleButton(b);
  const startHint = el(
    doc,
    'p',
    null,
    'Start playing saves your settings and shrinks the panel so it never blocks the game.',
  );
  startHint.style.margin = '4px 0 0 0';
  startHint.style.opacity = '0.8';
  reviewStep.appendChild(reviewSummary);
  reviewStep.appendChild(advToggle);
  reviewStep.appendChild(adv);
  reviewStep.appendChild(saveBtn);
  reviewStep.appendChild(startBtn);
  reviewStep.appendChild(startHint);

  // ---- run view: live HUD contract + engine controls ----
  const run = el(doc, 'div', 'data-ui-run');
  run.style.display = 'none';
  run.style.padding = '0 10px';
  const hudStatusRow = el(doc, 'div');
  hudStatusRow.appendChild(field(doc, 'status', el(doc, 'span', 'data-hud-status', 'idle')));
  hudStatusRow.appendChild(field(doc, 'mana', el(doc, 'span', 'data-hud-mana', '—')));
  hudStatusRow.appendChild(field(doc, 'next', el(doc, 'span', 'data-hud-next', '—')));
  hudStatusRow.appendChild(field(doc, 'food', el(doc, 'span', 'data-hud-food', '—')));
  hudStatusRow.appendChild(field(doc, 'eat every', el(doc, 'span', 'data-hud-every-casts', '—')));
  hudStatusRow.appendChild(field(doc, 'cooldown', el(doc, 'span', 'data-hud-cooldown', '—')));
  run.appendChild(hudStatusRow);
  const hudCountersRow = el(doc, 'div');
  hudCountersRow.appendChild(field(doc, 'casts', el(doc, 'span', 'data-hud-casts', '0')));
  hudCountersRow.appendChild(field(doc, 'eats', el(doc, 'span', 'data-hud-eats', '0')));
  hudCountersRow.appendChild(field(doc, 'misses', el(doc, 'span', 'data-hud-misses', '0')));
  hudCountersRow.appendChild(field(doc, 'words', el(doc, 'span', 'data-hud-words', '0')));
  run.appendChild(hudCountersRow);

  // ---- REQ-15 registration offer (run view): word + time (+ sid) + explicit
  // Register/Ignore — config is NEVER written without user confirmation ----
  let currentOffer = null; // the offer currently on screen (if any)
  const offer = el(doc, 'div', 'data-ui-offer');
  Object.assign(offer.style, {
    display: 'none',
    margin: '6px 0',
    padding: '6px 8px',
    background: 'rgba(43, 108, 176, 0.25)',
    border: '1px solid #2b6cb0',
    borderRadius: '6px',
  });
  const offerText = el(doc, 'div', 'data-ui-offer-text', '');
  offerText.style.marginBottom = '4px';
  const offerSlot = el(doc, 'select', 'data-ui-offer-slot');
  const offerSlotEmpty = el(doc, 'option');
  offerSlotEmpty.value = '';
  offerSlotEmpty.textContent = '— choose —';
  offerSlot.appendChild(offerSlotEmpty);
  for (let i = 1; i <= 12; i++) {
    const opt = el(doc, 'option');
    opt.value = String(i);
    opt.textContent = String(i);
    offerSlot.appendChild(opt);
  }
  const offerRegister = el(doc, 'button', 'data-ui-offer-register', 'Register');
  const offerIgnore = el(doc, 'button', 'data-ui-offer-ignore', 'Ignore');
  for (const b of [offerRegister, offerIgnore]) styleButton(b);
  const offerRow = el(doc, 'div');
  offerRow.appendChild(field(doc, 'Add to hotbar slot:', offerSlot));
  offerRow.appendChild(offerRegister);
  offerRow.appendChild(offerIgnore);
  offer.appendChild(offerText);
  offer.appendChild(offerRow);
  run.appendChild(offer);

  const logEl = el(doc, 'div', 'data-hud-log', '');
  Object.assign(logEl.style, {
    margin: '4px 0',
    padding: '4px 6px',
    background: 'rgba(0,0,0,0.35)',
    borderRadius: '4px',
    whiteSpace: 'pre-wrap',
    maxHeight: '72px',
    overflowY: 'auto',
    fontFamily: 'ui-monospace, monospace',
  });
  run.appendChild(logEl);
  const runControls = el(doc, 'div');
  const runStartBtn = el(doc, 'button', 'data-ui-start', 'Start');
  const runPauseBtn = el(doc, 'button', 'data-ui-pause', 'Pause');
  const runConfigureBtn = el(doc, 'button', 'data-ui-configure', 'Configure');
  const runResetBtn = el(doc, 'button', 'data-ui-reset', 'Reset');
  for (const b of [runStartBtn, runPauseBtn, runConfigureBtn, runResetBtn]) {
    styleButton(b);
    b.style.marginRight = '6px';
    b.style.marginBottom = '6px';
    runControls.appendChild(b);
  }
  run.appendChild(runControls);
  runPauseBtn.disabled = true;
  body.appendChild(run);

  // ---- mini bar (collapsed): dot + mana + casts + expand/hide ----
  const mini = el(doc, 'div', 'data-ui-mini');
  Object.assign(mini.style, {
    display: 'none',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    fontWeight: '600',
  });
  const miniDot = el(doc, 'span', 'data-ui-status-dot');
  Object.assign(miniDot.style, {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#9e9e9e',
    display: 'inline-block',
    flex: '0 0 auto',
  });
  const miniMana = el(doc, 'span', 'data-ui-mini-mana', '—');
  miniMana.style.flex = '0 0 auto';
  const miniCasts = el(doc, 'span', 'data-ui-mini-casts', '0 casts');
  miniCasts.style.flex = '1';
  miniCasts.style.textAlign = 'right';
  const miniExpand = el(doc, 'button', 'data-ui-mini-expand', 'Expand');
  const miniHide = el(doc, 'button', 'data-ui-mini-hide', 'Hide');
  for (const b of [miniExpand, miniHide]) styleButton(b);
  mini.appendChild(miniDot);
  mini.appendChild(miniMana);
  mini.appendChild(miniCasts);
  mini.appendChild(miniExpand);
  mini.appendChild(miniHide);
  panel.appendChild(mini);

  // ---- floating handle (hidden state): tiny square, zero obstruction ----
  const handle = el(doc, 'button', 'data-ui-handle', '⚙');
  handle.title = 'Open Rotation Bot';
  Object.assign(handle.style, {
    display: 'none',
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    borderRadius: '6px',
    fontSize: '15px',
    cursor: 'pointer',
    padding: '0',
  });
  styleButton(handle);
  panel.appendChild(handle);

  // ---- HUD controller (REQ-14) ----
  const { createHud } = require('./hud');
  const hud = createHud({
    document: doc,
    getSnapshot: baseGetSnapshot,
    cadenceMs: deps.cadenceMs ?? 500,
    schedule: deps.schedule,
    clear: deps.clear,
    maxLog: deps.maxLog,
  });

  /* ---------------------------------------------------------------------
   * panel states: full <-> mini <-> handle (never blocks the game)
   * ------------------------------------------------------------------- */
  function setPanelState(next) {
    if (next === 'full') {
      panel.style.width = PANEL_WIDTH;
      panel.style.maxHeight = PANEL_MAX_HEIGHT;
      panel.style.background = 'rgba(24, 26, 32, 0.96)';
      panel.style.border = '1px solid #444';
      panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      panel.style.borderRadius = '8px';
      header.style.display = 'flex';
      body.style.display = '';
      mini.style.display = 'none';
      handle.style.display = 'none';
    } else if (next === 'mini') {
      panel.style.width = PANEL_WIDTH;
      panel.style.maxHeight = PANEL_MAX_HEIGHT;
      panel.style.background = 'rgba(24, 26, 32, 0.96)';
      panel.style.border = '1px solid #444';
      panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      panel.style.borderRadius = '8px';
      header.style.display = 'none';
      body.style.display = 'none';
      mini.style.display = 'flex';
      handle.style.display = 'none';
    } else {
      // handle: shrink the shell to the tiny square so no invisible box
      // blocks clicks on the game underneath.
      panel.style.width = '28px';
      panel.style.maxHeight = '28px';
      panel.style.height = '28px';
      panel.style.background = 'rgba(24, 26, 32, 0.96)';
      panel.style.border = '1px solid #444';
      panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      panel.style.borderRadius = '6px';
      header.style.display = 'none';
      body.style.display = 'none';
      mini.style.display = 'none';
      handle.style.display = 'block';
    }
  }

  function showWizard() {
    wizard.style.display = '';
    run.style.display = 'none';
  }

  function showRun() {
    run.style.display = '';
    wizard.style.display = 'none';
  }

  /* ---------------------------------------------------------------------
   * wizard navigation
   * ------------------------------------------------------------------- */
  function goTo(n) {
    step = n;
    indicator.textContent = `Step ${n} of 5`;
    wizTitle.textContent = STEP_TITLES[n] ?? '';
    const sections = [
      [welcomeStep, 1],
      [spellStep, 2],
      [whenStep, 3],
      [repeatStep, 4],
      [reviewStep, 5],
    ];
    for (const [section, num] of sections) {
      section.style.display = num === n ? '' : 'none';
    }
    backBtn.disabled = n === 1;
    nextBtn.style.display = n === 5 ? 'none' : '';
    if (n === 1) renderWelcome();
    if (n === 3) renderWhenLabels();
    if (n === 4) renderRepeatLabels();
    if (n === 5) renderReview();
  }

  /** Step 1: welcome copy — detected character + resume when configured. */
  function renderWelcome() {
    const snap = baseGetSnapshot();
    nameSpan.textContent = snap.playerName || 'your character';
    savedHint.style.display = hasSavedConfig ? '' : 'none';
    welcomeStart.style.display = hasSavedConfig ? 'none' : '';
    resumeBtn.style.display = hasSavedConfig ? '' : 'none';
    reconfigureBtn.style.display = hasSavedConfig ? '' : 'none';
  }

  /** Plain-language description of one spell row (labels on steps 3/4). */
  function spellInfo(i) {
    const rows = spellRowsEl.querySelectorAll('[data-ui-spell-row]');
    const row = rows[i];
    if (!row) return '—';
    const slot = row.querySelector('[data-ui-spell-slot]').value;
    const word = row.querySelector('[data-ui-spell-word]').value.trim();
    if (!slot && !word) return 'not set yet';
    return `slot ${slot || '?'}${word ? ` — "${word}"` : ' (no word)'}`;
  }

  /** Refresh step-3 row labels (slot/word may have changed on step 2). */
  function renderWhenLabels() {
    const rows = whenRowsEl.querySelectorAll('[data-ui-when-row]');
    rows.forEach((row, i) => {
      row.querySelector('[data-ui-when-label]').textContent = `Spell ${i + 1} (${spellInfo(i)}):`;
    });
  }

  /** Refresh step-4 row labels. */
  function renderRepeatLabels() {
    const rows = repeatRowsEl.querySelectorAll('[data-ui-repeat-row]');
    rows.forEach((row, i) => {
      row.querySelector('[data-ui-repeat-label]').textContent = `Spell ${i + 1} (${spellInfo(i)}):`;
    });
  }

  /* ---------------------------------------------------------------------
   * spell rows + their mirrors on steps 3/4
   * ------------------------------------------------------------------- */
  function addSpellRow(spell = null) {
    // --- step 2 row: slot + word + catalog find + remove ---
    const row = el(doc, 'div', 'data-ui-spell-row');
    Object.assign(row.style, {
      border: '1px solid #555',
      borderRadius: '6px',
      padding: '6px',
      marginBottom: '6px',
    });
    const slot = el(doc, 'select', 'data-ui-spell-slot');
    const emptyOpt = el(doc, 'option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— choose —';
    slot.appendChild(emptyOpt);
    for (let i = 1; i <= 12; i++) {
      const opt = el(doc, 'option');
      opt.value = String(i);
      opt.textContent = String(i);
      slot.appendChild(opt);
    }
    const word = el(doc, 'input', 'data-ui-spell-word');
    word.type = 'text';
    word.placeholder = 'e.g. adori';
    const findBtn = el(doc, 'button', 'data-ui-spell-find', 'Find in catalog');
    styleButton(findBtn);
    const searchWrap = el(doc, 'div');
    searchWrap.style.display = 'none';
    const searchInput = el(doc, 'input', 'data-ui-search');
    searchInput.type = 'text';
    searchInput.placeholder = 'search item by name…';
    searchInput.style.width = '100%';
    searchInput.style.boxSizing = 'border-box';
    const searchResults = el(doc, 'div', 'data-ui-search-results');
    Object.assign(searchResults.style, { maxHeight: '90px', overflowY: 'auto' });
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchResults);
    const removeBtn = el(doc, 'button', 'data-ui-spell-remove', 'Remove');
    styleButton(removeBtn);
    removeBtn.style.float = 'right';
    row.appendChild(field(doc, 'Hotbar slot:', slot));
    row.appendChild(field(doc, 'Spell word:', word));
    row.appendChild(findBtn);
    row.appendChild(removeBtn);
    row.appendChild(searchWrap);

    // --- step 3 mirror row: threshold + reserve ---
    const whenRow = el(doc, 'div', 'data-ui-when-row');
    whenRow.style.borderTop = '1px dashed #444';
    whenRow.style.padding = '4px 0';
    const whenLabel = el(doc, 'div', 'data-ui-when-label', '');
    const wThr = el(doc, 'input', 'data-ui-spell-threshold');
    wThr.type = 'number';
    wThr.min = '0';
    const wRsv = el(doc, 'input', 'data-ui-spell-reserve');
    wRsv.type = 'number';
    wRsv.min = '0';
    whenRow.appendChild(whenLabel);
    whenRow.appendChild(field(doc, 'Cast when your mana reaches:', wThr));
    whenRow.appendChild(field(doc, 'Keep this much mana saved:', wRsv));

    // --- step 4 mirror row: repeat ---
    const repeatRow = el(doc, 'div', 'data-ui-repeat-row');
    repeatRow.style.borderTop = '1px dashed #444';
    repeatRow.style.padding = '4px 0';
    const repeatLabel = el(doc, 'div', 'data-ui-repeat-label', '');
    const rRep = el(doc, 'input', 'data-ui-spell-repeat');
    rRep.type = 'number';
    rRep.min = '1';
    repeatRow.appendChild(repeatLabel);
    repeatRow.appendChild(field(doc, 'Casts before switching:', rRep));

    if (spell) {
      slot.value = spell.slot ?? '';
      word.value = spell.word ?? '';
      wThr.value = spell.threshold ?? '';
      wRsv.value = spell.reserve ?? '';
      rRep.value = spell.repeat ?? '';
    }

    spellRowsEl.appendChild(row);
    whenRowsEl.appendChild(whenRow);
    repeatRowsEl.appendChild(repeatRow);

    // --- row behaviors ---
    row.addEventListener('click', () => highlightRow(row));
    findBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      highlightRow(row);
      searchWrap.style.display = searchWrap.style.display === 'none' ? '' : 'none';
    });
    searchInput.addEventListener('input', () =>
      renderSearchInto(searchInput, searchResults, (entry) => {
        word.value = entry.name ?? '';
        showErrors([]);
      }),
    );
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRow(row);
    });

    highlightRow(row);
    return row;
  }

  /** Mark one spell row as the active row (catalog search fills it). */
  function highlightRow(target) {
    for (const row of spellRowsEl.querySelectorAll('[data-ui-spell-row]')) {
      const active = row === target;
      row.dataset.active = active ? 'true' : 'false';
      row.style.borderColor = active ? '#2b6cb0' : '#555';
    }
  }

  /** Remove a spell row and its step-3/4 mirrors (positional alignment). */
  function removeRow(row) {
    const rows = spellRowsEl.querySelectorAll('[data-ui-spell-row]');
    const i = Array.prototype.indexOf.call(rows, row);
    if (i === -1) return;
    row.remove();
    whenRowsEl.querySelectorAll('[data-ui-when-row]')[i]?.remove();
    repeatRowsEl.querySelectorAll('[data-ui-repeat-row]')[i]?.remove();
    const remaining = spellRowsEl.querySelectorAll('[data-ui-spell-row]');
    highlightRow(remaining[0] ?? null);
    showErrors([]);
  }

  /* ---------------------------------------------------------------------
   * per-step friendly validation (plain language, never cryptic)
   * ------------------------------------------------------------------- */
  function validateStep(n) {
    const errors = [];
    const maxMana = Number(baseGetSnapshot().maxMana);
    if (n === 2) {
      const rows = spellRowsEl.querySelectorAll('[data-ui-spell-row]');
      let slotCount = 0;
      rows.forEach((row, i) => {
        const slot = row.querySelector('[data-ui-spell-slot]').value;
        const word = row.querySelector('[data-ui-spell-word]').value.trim();
        if (slot) slotCount += 1;
        if (word && !slot) {
          errors.push(
            `Spell ${i + 1}: you typed "${word}" but no hotbar slot is selected. Pick the slot the spell lives on.`,
          );
        }
      });
      if (slotCount === 0) {
        errors.push(
          'Please add at least one spell: pick a hotbar slot and enter its spell word (or search the catalog).',
        );
      }
    }
    if (n === 3) {
      const rows = whenRowsEl.querySelectorAll('[data-ui-when-row]');
      rows.forEach((row, i) => {
        const threshold = num(row.querySelector('[data-ui-spell-threshold]').value);
        const reserve = num(row.querySelector('[data-ui-spell-reserve]').value);
        const where = `Spell ${i + 1}`;
        if (threshold !== null && threshold < 0) {
          errors.push(`${where}: the mana threshold can't be negative.`);
        }
        if (reserve !== null && reserve < 0) {
          errors.push(`${where}: the saved mana can't be negative.`);
        }
        if (Number.isFinite(maxMana)) {
          if (threshold !== null && threshold > maxMana) {
            errors.push(
              `${where}: your mana can't reach ${threshold} — the maximum is ${maxMana}. Lower the value or leave it at 0.`,
            );
          }
          if (reserve !== null && reserve > maxMana) {
            errors.push(`${where}: you can't keep ${reserve} mana saved — your maximum is ${maxMana}.`);
          }
        }
      });
    }
    if (n === 4) {
      const rows = repeatRowsEl.querySelectorAll('[data-ui-repeat-row]');
      rows.forEach((row, i) => {
        const repeat = num(row.querySelector('[data-ui-spell-repeat]').value);
        if (repeat !== null && repeat < 1) {
          errors.push(`Spell ${i + 1}: at least 1 cast before switching.`);
        }
      });
      const foodSlotValue = foodSlot.value;
      if (foodSlotValue !== '' && (Number(foodSlotValue) < 1 || Number(foodSlotValue) > 12)) {
        errors.push('The food slot must be between 1 and 12 — or leave it empty to turn food automation off.');
      }
      const everyCasts = num(foodEveryCasts.value);
      if (everyCasts !== null && everyCasts < 0) {
        errors.push('Use 0 to eat by the food timer only, or a number of casts greater than 0.');
      }
      const win = num(foodWindow.value);
      const fb = num(foodFallback.value);
      if (win !== null && win < 0) errors.push("The food timer window can't be negative.");
      if (fb !== null && fb < 0) errors.push("The fallback eating interval can't be negative.");
    }
    return errors;
  }

  /** Shared friendly inline errors (REQ-12 keep-previous pattern). */
  function showErrors(messages) {
    if (!messages || messages.length === 0) {
      errorsEl.style.display = 'none';
      errorsEl.textContent = '';
      return;
    }
    errorsEl.style.display = 'block';
    errorsEl.textContent = messages.join('\n');
  }

  /* ---------------------------------------------------------------------
   * config collection / application (exact REQ-12 pipeline shape)
   * ------------------------------------------------------------------- */
  function collectSpells() {
    const rows = spellRowsEl.querySelectorAll('[data-ui-spell-row]');
    const whenRows = whenRowsEl.querySelectorAll('[data-ui-when-row]');
    const repeatRows = repeatRowsEl.querySelectorAll('[data-ui-repeat-row]');
    const spells = [];
    rows.forEach((row, i) => {
      spells.push({
        slot: num(row.querySelector('[data-ui-spell-slot]').value),
        word: row.querySelector('[data-ui-spell-word]').value.trim(),
        threshold: num(whenRows[i]?.querySelector('[data-ui-spell-threshold]').value) ?? 0,
        reserve: num(whenRows[i]?.querySelector('[data-ui-spell-reserve]').value) ?? 0,
        repeat: num(repeatRows[i]?.querySelector('[data-ui-spell-repeat]').value) ?? 1,
        order: i,
      });
    });
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
        everyCasts: num(foodEveryCasts.value) ?? 0,
      },
    };
  }

  /** Populate every input from a (normalized) config. */
  function setConfig(config) {
    if (!config) return;
    lastSaved = config;
    spellRowsEl.textContent = '';
    whenRowsEl.textContent = '';
    repeatRowsEl.textContent = '';
    const list = Array.isArray(config.spells) ? config.spells : [];
    for (const spell of list) addSpellRow(spell);
    if (list.length === 0) addSpellRow(null);
    highlightRow(spellRowsEl.querySelector('[data-ui-spell-row]'));
    foodSlot.value = config.food?.slot ?? '';
    foodCid.value = config.food?.cid ?? '';
    foodName.value = config.food?.name ?? '';
    foodWindow.value = config.food?.warningWindowSec ?? '';
    foodFallback.value = config.food?.fallbackIntervalSec ?? '';
    foodEveryCasts.value = config.food?.everyCasts ?? '';
    jitterMin.value = config.jitter?.min ?? '';
    jitterMax.value = config.jitter?.max ?? '';
    firingMode.value = config.firing?.mode ?? 'handleClick';
    const foodSlotValue = config.food?.slot ?? null;
    hasSavedConfig = list.length > 0 || (foodSlotValue !== null && foodSlotValue !== '');
    showErrors([]);
    if (step === 1) renderWelcome();
  }

  async function save() {
    if (typeof saveConfig !== 'function') {
      showErrors(['saveConfig not wired']);
      return { ok: false, errors: ['saveConfig not wired'] };
    }
    try {
      const res = await saveConfig(getRawConfig(), lastSaved ?? {});
      if (res && res.ok) {
        lastSaved = res.config ?? getRawConfig();
        showErrors([]);
        return { ok: true, errors: [], config: lastSaved };
      }
      const errors = res?.errors ?? ['save rejected'];
      showErrors(errors);
      return { ok: false, errors, config: lastSaved ?? undefined };
    } catch (err) {
      const message = `save failed: ${err?.message ?? err}`;
      error(message);
      showErrors([message]);
      return { ok: false, errors: [message] };
    }
  }

  /** Step 5 action: save, start the engine, switch to the run view. */
  async function startPlaying() {
    const res = await save();
    if (!res.ok) return res;
    onStart?.();
    showRun();
    setPanelState('full');
    return res;
  }

  /* ---------------------------------------------------------------------
   * catalog search (REQ-11): images + click-to-fill, capped at 30 entries
   * ------------------------------------------------------------------- */
  function renderSearchInto(inputEl, resultsEl, onPick) {
    resultsEl.textContent = '';
    const catalog = getCatalog();
    if (!catalog) {
      const hint = el(doc, 'div', null, 'Catalog not loaded — type the spell word manually.');
      hint.style.color = '#ffb3a0';
      resultsEl.appendChild(hint);
      return 0;
    }
    const q = String(inputEl.value ?? '').trim().toLowerCase();
    if (!q) return 0;
    let count = 0;
    for (const entry of catalog) {
      if (count >= SEARCH_LIMIT) break;
      const name = String(entry.name ?? '');
      if (!name.toLowerCase().includes(q)) continue;
      const item = el(doc, 'div', 'data-ui-search-result');
      Object.assign(item.style, {
        cursor: 'pointer',
        padding: '2px 4px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      });
      if (typeof entry.imageDataURL === 'string') {
        const img = doc.createElement('img');
        img.src = entry.imageDataURL;
        img.alt = entry.name;
        img.width = 24;
        img.height = 24;
        item.appendChild(img);
      }
      item.appendChild(el(doc, 'span', null, `${entry.name} (${entry.cid})`));
      item.addEventListener('click', () => {
        onPick(entry);
        showErrors([]);
      });
      resultsEl.appendChild(item);
      count += 1;
    }
    if (count === 0) {
      resultsEl.appendChild(el(doc, 'div', null, 'No matches. Try another name, or type it yourself.'));
    }
    return count;
  }

  /** Public search helper (tests): search row `rowIndex` (default 0). */
  function search(query, rowIndex = 0) {
    const row = spellRowsEl.querySelectorAll('[data-ui-spell-row]')[rowIndex];
    if (!row) return 0;
    const input = row.querySelector('[data-ui-search]');
    const results = row.querySelector('[data-ui-search-results]');
    input.value = query ?? '';
    return renderSearchInto(input, results, (entry) => {
      row.querySelector('[data-ui-spell-word]').value = entry.name ?? '';
      showErrors([]);
    });
  }

  /* ---------------------------------------------------------------------
   * mini bar + status dot (driven by paintMini on the existing HUD cadence)
   * ------------------------------------------------------------------- */
  function paintMini(snap) {
    const status = String(snap?.status ?? 'idle');
    const colors = { running: '#4caf50', paused: '#ffb300', waiting: '#ff9800' };
    const color = colors[status] || '#9e9e9e';
    for (const d of doc.querySelectorAll('[data-ui-status-dot]')) d.style.background = color;
    miniMana.textContent = fmtMana(snap?.mana, snap?.maxMana);
    const casts = snap?.casts ?? (hud ? hud.getCounters().casts : 0);
    miniCasts.textContent = `${casts} casts`;
  }

  /* ---------------------------------------------------------------------
   * REQ-15 registration offer: word + timestamp (+ sid when inferable) with
   * an explicit Register / Ignore choice. Registering writes the word into
   * the rotation (user-confirmed); ignoring keeps it session-silent.
   * ------------------------------------------------------------------- */
  /** Preselect the first hotbar slot not already used by the wizard rows. */
  function firstFreeSlot() {
    const used = new Set(
      (getRawConfig().spells || [])
        .map((s) => s.slot)
        .filter((v) => Number.isInteger(v)),
    );
    for (let i = 1; i <= 12; i++) {
      if (!used.has(i)) return i;
    }
    return null;
  }

  /**
   * Surface a REQ-15 registration offer in the run view.
   * @param {{word: string, at: number, sid: number|null}} data - observed
   *   unknown word, first-sighting timestamp and best-effort spell id
   */
  function showOffer(data) {
    currentOffer = data;
    const sidPart = Number.isInteger(data?.sid) ? ` (spell id ${data.sid})` : '';
    const timePart = Number.isFinite(data?.at) ? ` at ${new Date(data.at).toLocaleTimeString()}` : '';
    offerText.textContent =
      `You cast "${data?.word ?? '?'}" twice in 5 minutes${sidPart} without a configured word${timePart}. ` +
      'Add it to your rotation?';
    const free = firstFreeSlot();
    offerSlot.value = free !== null ? String(free) : '';
    offer.style.display = '';
  }

  /** Hide the offer banner after a decision (or when superseded). */
  function hideOffer() {
    currentOffer = null;
    offer.style.display = 'none';
  }

  /* ---------------------------------------------------------------------
   * dragging (header only, viewport-clamped)
   * ------------------------------------------------------------------- */
  let drag = null;
  function onHeaderDown(e) {
    if (e.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left || 0,
      origTop: rect.top || 0,
    };
    e.preventDefault();
  }
  function onDocMove(e) {
    if (!drag) return;
    const viewportW = doc.defaultView?.innerWidth ?? 0;
    const viewportH = doc.defaultView?.innerHeight ?? 0;
    const width = panel.getBoundingClientRect().width || 280;
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

  /* ---------------------------------------------------------------------
   * wiring
   * ------------------------------------------------------------------- */
  backBtn.addEventListener('click', () => {
    showErrors([]);
    goTo(Math.max(1, step - 1));
  });
  nextBtn.addEventListener('click', () => {
    const errs = validateStep(step);
    if (errs.length) {
      showErrors(errs);
      return;
    }
    showErrors([]);
    goTo(step + 1);
  });
  welcomeStart.addEventListener('click', () => {
    showErrors([]);
    goTo(2);
  });
  resumeBtn.addEventListener('click', () => {
    showErrors([]);
    goTo(5);
  });
  reconfigureBtn.addEventListener('click', () => {
    showErrors([]);
    goTo(2);
  });
  addSpellBtn.addEventListener('click', () => addSpellRow(null));
  foodFindBtn.addEventListener('click', () => {
    foodSearchWrap.style.display = foodSearchWrap.style.display === 'none' ? '' : 'none';
  });
  foodSearchInput.addEventListener('input', () =>
    renderSearchInto(foodSearchInput, foodSearchResults, (entry) => {
      foodCid.value = entry.cid ?? '';
      foodName.value = entry.name ?? '';
      showErrors([]);
    }),
  );
  advToggle.addEventListener('click', () => {
    adv.style.display = adv.style.display === 'none' ? '' : 'none';
  });
  foodAdvToggle.addEventListener('click', () => {
    foodAdv.style.display = foodAdv.style.display === 'none' ? '' : 'none';
  });
  minimizeBtn.addEventListener('click', () => setPanelState('mini'));
  hideBtn.addEventListener('click', () => setPanelState('handle'));
  miniExpand.addEventListener('click', () => setPanelState('full'));
  miniHide.addEventListener('click', () => setPanelState('handle'));
  handle.addEventListener('click', () => setPanelState('full'));
  offerRegister.addEventListener('click', () => {
    if (!currentOffer) return;
    if (!offerSlot.value) {
      showErrors(['Pick the hotbar slot the spell lives on before registering.']);
      return;
    }
    const decided = currentOffer;
    const slot = offerSlot.value;
    hideOffer();
    onOfferAction?.('register', decided, slot);
  });
  offerIgnore.addEventListener('click', () => {
    if (!currentOffer) return;
    const decided = currentOffer;
    hideOffer();
    onOfferAction?.('ignore', decided);
  });
  runStartBtn.addEventListener('click', () => onStart?.());
  runPauseBtn.addEventListener('click', () => onPause?.());
  runResetBtn.addEventListener('click', () => onReset?.());
  runConfigureBtn.addEventListener('click', () => {
    showWizard();
    setPanelState('full');
    goTo(1);
  });
  saveBtn.addEventListener('click', () => {
    save().catch((err) => error(`save threw: ${err?.message ?? err}`));
  });
  startBtn.addEventListener('click', () => {
    startPlaying().catch((err) => error(`start threw: ${err?.message ?? err}`));
  });

  /** Reflect the engine running state on the Start/Pause buttons. */
  function setRunning(running) {
    for (const b of doc.querySelectorAll('[data-ui-start]')) b.disabled = Boolean(running);
    for (const b of doc.querySelectorAll('[data-ui-pause]')) b.disabled = !running;
  }

  /** Step 5: plain-language summary of the configured rotation. */
  function renderReview() {
    const raw = getRawConfig();
    const lines = [];
    if (raw.spells.length === 0) {
      lines.push('No spells yet — go back to step 2 and add one.');
    }
    raw.spells.forEach((s, i) => {
      const label = s.slot ? `Slot ${s.slot}` : 'No slot';
      const wordPart = s.word ? `"${s.word}"` : 'no word (keybind only)';
      const whenPart = s.threshold > 0 ? `when mana reaches ${s.threshold}` : 'whenever mana allows';
      const reservePart = s.reserve > 0 ? `, keeping ${s.reserve} saved` : '';
      const repeatPart = `${Math.max(1, s.repeat)} cast(s) before switching`;
      lines.push(`• Spell ${i + 1}: ${label} — ${wordPart}; cast ${whenPart}${reservePart}; ${repeatPart}.`);
    });
    const food = raw.food;
    if (food.slot) {
      const namePart = food.name ? ` (${food.name})` : '';
      const cadence = Number(food.everyCasts) > 0 ? `, plus an extra eat every ${food.everyCasts} casts` : '';
      lines.push(`• Food: eat from slot ${food.slot}${namePart} when the timer is under ${food.warningWindowSec}s${cadence}.`);
    } else {
      lines.push('• Food: off (no food slot selected).');
    }
    lines.push(`• Random delay between actions: ${raw.jitter.min}-${raw.jitter.max} ms.`);
    lines.push(`• Fires via: ${raw.firing.mode === 'keyboard' ? 'keyboard' : 'game click'}.`);
    lines.push('Press Start playing to save and shrink the panel.');
    reviewSummary.textContent = lines.join('\n');
  }

  // ---- mount ----
  if (mount && typeof mount.appendChild === 'function') {
    mount.appendChild(panel);
  } else {
    error('ui: no mount container; panel not attached');
  }
  showWizard();
  setPanelState('full');
  addSpellRow(null); // one editable spell row by default
  goTo(1);
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
    search,
    setErrors: showErrors,
    paintMini,
    showOffer,
    destroy,
  };
}

module.exports = { createUi };
