'use strict';

/**
 * CDP bridge — target discovery (task 1.5, REQ-01/05).
 *
 * Secondary path: scan a small default port set (9222-9224, configurable)
 * via GET /json/list on 127.0.0.1 and filter for minibia.com `type:"page"`
 * targets the user can pick. The primary path (launch own instance) lives
 * in app/cdp/launch.ts + app/main.ts.
 *
 * Safety: scan URLs are built ONLY from validated ports (validateDebugPort)
 * and ALWAYS against 127.0.0.1 (REQ-05 local-only). scanPorts never throws:
 * per-port failures become actionable error entries for the picker (REQ-01
 * "GIVEN no target found AND launch fails, THEN an actionable error shows").
 */

const { validateDebugPort } = require('./launch.ts');

/** Default port set to scan (REQ-01: 9222-9224, configurable). @readonly */
const DEFAULT_SCAN_PORTS = Object.freeze([9222, 9223, 9224]);

/** Game origin used to filter candidate targets. @readonly */
const GAME_ORIGIN = 'minibia.com';

/** Local loopback hosts to scan. Chrome may bind DevTools to IPv4 or IPv6. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]']);

/** Validate that a scan host is loopback-only. */
function normalizeLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return '127.0.0.1';
  const value = String(host);
  if (value === '127.0.0.1') return '127.0.0.1';
  if (value === '::1' || value === '[::1]') return '[::1]';
  throw new RangeError('scan host must be local loopback, got ' + JSON.stringify(host));
}

/**
 * Build the /json/list scan URL for a port. Throws RangeError for any
 * invalid port/host — scan URLs are ONLY built from validated ports and
 * loopback hosts (127.0.0.1 or [::1], REQ-05 local-only boundary).
 * @param {number|string} port
 * @param {string} [host='127.0.0.1']
 * @returns {string}
 */
function buildScanUrl(port, host) {
  const validated = validateDebugPort(port);
  if (validated === null) {
    throw new RangeError('scan port must be an integer in 1024..65535, got ' + JSON.stringify(port));
  }
  return 'http://' + normalizeLoopbackHost(host) + ':' + validated + '/json/list';
}

/**
 * Filter raw /json/list payloads to attachable game targets:
 * `type === 'page'` whose url includes the game origin (REQ-01). Tolerates
 * malformed entries (skipped, never throws).
 * @param {unknown} list - parsed /json/list body (array expected)
 * @param {{origin?: string}} [opts]
 * @returns {Array<{type: string, title: string, url: string, webSocketDebuggerUrl: string}>}
 */
function filterTargets(list, opts = {}) {
  const origin = (opts.origin || GAME_ORIGIN).toLowerCase();
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type !== 'page') continue;
    if (typeof entry.url !== 'string' || entry.url.toLowerCase().indexOf(origin) === -1) continue;
    out.push({
      type: 'page',
      title: typeof entry.title === 'string' ? entry.title : '',
      url: entry.url,
      webSocketDebuggerUrl: typeof entry.webSocketDebuggerUrl === 'string' ? entry.webSocketDebuggerUrl : '',
    });
  }
  return out;
}

/**
 * Scan a list of ports for game targets. Never throws: every per-port
 * failure becomes an actionable error entry. Every URL fetched is built by
 * buildScanUrl (validated 127.0.0.1 only).
 * @param {number[]} ports
 * @param {{fetchImpl?: Function, origin?: string}} [opts]
 * @returns {Promise<{targets: object[], errors: Array<{port: number, message: string}>}>}
 */
async function scanPorts(ports, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const origin = opts.origin || GAME_ORIGIN;
  const hosts = (Array.isArray(opts.hosts) && opts.hosts.length > 0 ? opts.hosts : LOOPBACK_HOSTS)
    .map((h) => normalizeLoopbackHost(h));
  const targets = [];
  const errors = [];
  for (const port of ports) {
    const validated = validateDebugPort(port);
    if (validated === null) {
      errors.push({ port: Number(port) || port, host: null, message: 'invalid port ' + JSON.stringify(port) + ' — must be 1024..65535' });
      continue;
    }
    if (!fetchImpl) {
      errors.push({ port: validated, host: null, message: 'no fetch available — cannot scan port ' + validated });
      continue;
    }
    for (const host of hosts) {
      const url = buildScanUrl(validated, host);
      try {
        const res = await fetchImpl(url);
        if (!res || typeof res.ok !== 'undefined' && res.ok === false) {
          errors.push({ port: validated, host, message: host + ':' + validated + ' answered with HTTP ' + (res && res.status !== undefined ? res.status : '?') + ' — no CDP endpoint there' });
          continue;
        }
        const body = typeof res.json === 'function' ? await res.json() : res;
        const found = filterTargets(body, { origin });
        targets.push(...found);
      } catch (e) {
        errors.push({
          port: validated,
          host,
          message: host + ':' + validated + ' not reachable (' + ((e && e.message) || e || 'connection refused') + ') — no debug-capable target there',
        });
      }
    }
  }
  return { targets, errors };
}

/**
 * Build the picker state for the scan result. When nothing is selectable the
 * message tells the user the concrete next step (REQ-01 actionable error).
 * @param {{targets: object[], errors: Array<{port: number, message: string}>, ports: number[]}} input
 * @returns {{selectable: boolean, targets: object[], message: string}}
 */
function describePickerResult({ targets, errors, ports }) {
  const selectable = Array.isArray(targets) && targets.length > 0;
  if (selectable) {
    return { selectable: true, targets, message: targets.length + ' game window' + (targets.length === 1 ? '' : 's') + ' found — pick one to attach.' };
  }
  const portList = (Array.isArray(ports) && ports.length > 0 ? ports : DEFAULT_SCAN_PORTS).join(', ');
  const detail = (Array.isArray(errors) && errors.length > 0)
    ? errors.map((e) => '  - ' + e.message).join('\n')
    : '';
  return {
    selectable: false,
    targets: [],
    message: 'No minibia.com window found on ports ' + portList + '.\n'
      + 'Either click "Launch" to start a dedicated game window, or start your own '
      + 'browser with --remote-debugging-port=<port> and --user-data-dir=<any non-default dir> (Chrome 136+ ignores debug flags on the default profile).'
      + (detail ? '\nScan details:\n' + detail : ''),
  };
}

module.exports = {
  DEFAULT_SCAN_PORTS,
  GAME_ORIGIN,
  LOOPBACK_HOSTS,
  normalizeLoopbackHost,
  buildScanUrl,
  filterTargets,
  scanPorts,
  describePickerResult,
};
