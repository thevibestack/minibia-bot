'use strict';

/**
 * Ring-buffer activity log (design D8, REQ-26 "never raw JSON").
 *
 * The agent-side readable log: fire closures and log sinks push events
 * {ts, module, action, result}; the panel renders them as formatted rows.
 * The buffer is capped (default 200 entries, oldest evicted) and the clock
 * is injectable for tests. Pure module — no DOM, no network.
 */

/**
 * Create an activity-log ring buffer.
 *
 * @param {object} [opts]
 * @param {number} [opts.cap=200] - max entries held (positive integer)
 * @param {() => number} [opts.now=Date.now] - injectable clock (ts fallback)
 * @returns {{
 *   push: (event: {ts?: number, module: string, action: string, result?: *}) => number,
 *   read: () => Array<{ts: number, module: string, action: string, result: *}>,
 *   size: () => number,
 *   clear: () => number,
 * }}
 */
function createLogRing(opts = {}) {
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : 200;
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const entries = [];

  return {
    /**
     * Push one event. The entry is normalized (never mutated by the caller):
     * `ts` defaults to the injected clock; `module`/`action` are coerced to
     * strings; the oldest entry is evicted when the cap is reached.
     * @returns {number} new buffer length
     */
    push(event) {
      const src = event && typeof event === 'object' ? event : {};
      const ts = Number.isFinite(Number(src.ts)) ? Number(src.ts) : nowFn();
      entries.push({
        ts,
        module: String(src.module === undefined || src.module === null ? 'agent' : src.module),
        action: String(src.action === undefined || src.action === null ? 'event' : src.action),
        result: src.result !== undefined ? src.result : null,
      });
      while (entries.length > cap) entries.shift();
      return entries.length;
    },

    /** Snapshot copy of the buffer, oldest first. */
    read() {
      return entries.slice();
    },

    /** Number of entries currently held. */
    size() {
      return entries.length;
    },

    /** Drop every entry. @returns {number} 0 */
    clear() {
      entries.length = 0;
      return 0;
    },
  };
}

module.exports = { createLogRing };
