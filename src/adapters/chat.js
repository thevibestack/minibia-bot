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
