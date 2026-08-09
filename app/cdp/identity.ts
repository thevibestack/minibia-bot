'use strict';

/**
 * Interconnection data contract (task 1.6, REQ-02 prep).
 *
 * The bridge exposes `getPlayerIdentity()` -> {name, vocationId,
 * vocationLabel} (design D5, spec REQ-02). The actual page call is wired in
 * app/cdp/bridge.ts; THIS module defines the pure contract: the live-probed
 * vocation table, the page-side read expression, and the normalization of a
 * raw page read into the confirmed-identity shape.
 *
 * Live probe (obs 10320): hotbarManager.__VOCATION_NAMES =
 *   {0:none, 1:knight, 2:paladin, 3:sorcerer, 4:druid,
 *    5:knight, 6:paladin, 7:sorcerer, 8:druid}  (5-8 = promoted/elite)
 * Flamamex = 4 = druid. Battle-window letters: D/P/K/S base,
 * ED/EK/MS/RP promoted — the label here mirrors the probed table; the gate
 * (slice 3) decides how to present it.
 */

/**
 * Live-probed vocation table (hotbarManager.__VOCATION_NAMES). Frozen:
 * the mapping is a contract, not mutable configuration.
 * @readonly
 */
const VOCATION_NAMES = Object.freeze({
  0: 'none',
  1: 'knight',
  2: 'paladin',
  3: 'sorcerer',
  4: 'druid',
  5: 'knight',   // promoted (elite)
  6: 'paladin',  // promoted (royal)
  7: 'sorcerer', // promoted (master)
  8: 'druid',    // promoted (elder)
});

/**
 * Map a numeric vocation id to its label. Unknown/missing/malformed values
 * map to 'none' — the gate treats 'none' as "not confirmed" (REQ-02:
 * modules arm only after the label is confirmed). Tolerates numeric strings.
 * @param {unknown} vocationId
 * @returns {string}
 */
function vocationLabel(vocationId) {
  if (typeof vocationId === 'string' && /^\d+$/.test(vocationId)) vocationId = Number(vocationId);
  if (typeof vocationId !== 'number' || !Number.isInteger(vocationId)) return 'none';
  return VOCATION_NAMES[vocationId] || 'none';
}

/**
 * Normalize a raw page read into the confirmed-identity contract shape.
 * Returns null when the player name is missing/unusable (page not ready —
 * e.g. Cloudflare challenge, REQ-02 "waiting for game").
 *
 * Label resolution order (design D5): the page's own __VOCATION_NAMES table
 * (raw.vocationLabel) is authoritative; when the page table is missing or
 * lacks the id, the app-side probed table (VOCATION_NAMES) is the fallback.
 * @param {{name?: unknown, vocationId?: unknown, vocationLabel?: unknown}} raw
 * @returns {{name: string, vocationId: number|null, vocationLabel: string}|null}
 */
function normalizeIdentity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  let vocationId = null;
  if (raw.vocationId !== null && raw.vocationId !== undefined) {
    if (typeof raw.vocationId === 'string' && /^\d+$/.test(raw.vocationId)) {
      vocationId = Number(raw.vocationId);
    } else if (typeof raw.vocationId === 'number' && Number.isInteger(raw.vocationId)) {
      vocationId = raw.vocationId;
    }
  }
  let label = typeof raw.vocationLabel === 'string' ? raw.vocationLabel.trim() : '';
  if (!label) label = vocationLabel(vocationId); // app-side probed fallback
  return { name, vocationId, vocationLabel: label || 'none' };
}

/**
 * Page-side read expression evaluated via Runtime.evaluate (bridge.ts).
 * Reads gameClient.player.{name,vocation} and the LIVE probed
 * __VOCATION_NAMES table from the hotbar manager (design D5 — the label
 * equals the character's true vocation, REQ-02). Returns nulls when the
 * client is not ready yet.
 * @readonly
 */
const PLAYER_IDENTITY_EXPRESSION = [
  '(() => {',
  '  var gc = window.gameClient;',
  '  var player = gc && gc.player || null;',
  '  var hotbar = gc && gc.interface && gc.interface.hotbarManager || (gc && gc.hotbarManager) || null;',
  '  var names = hotbar && hotbar.__VOCATION_NAMES || null;',
  '  var vocationId = player && player.vocation !== null && player.vocation !== undefined ? player.vocation : null;',
  '  var label = null;',
  '  if (vocationId !== null && names) {',
  '    var raw = names[vocationId];',
  '    label = typeof raw === "string" && raw.length > 0 ? raw : null;',
  '  }',
  '  return {',
  '    name: player && typeof player.name === "string" ? player.name : null,',
  '    vocationId: vocationId,',
  '    vocationLabel: label,',
  '  };',
  '})()',
].join('\n');

module.exports = {
  VOCATION_NAMES,
  vocationLabel,
  normalizeIdentity,
  PLAYER_IDENTITY_EXPRESSION,
};
