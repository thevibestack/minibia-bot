'use strict';

/**
 * Shared MockWebSocket for CDP bridge tests (test/app/*).
 * NO real Chrome or WebSocket is used in unit tests.
 */

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.closed = false;
  }
  send(data) {
    this.sent.push(data);
    return true;
  }
  close() { this.closed = true; if (this.onclose) this.onclose({}); }
  /** Simulate the server answering a command (id -> result/error). */
  answer(id, result, error) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ id, result, error }) });
  }
  /** Simulate an event message from the browser. */
  emitEvent(method, params) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ method, params }) });
  }
  /** Simulate the connection opening. */
  open() { if (this.onopen) this.onopen({}); }
}

/**
 * A WebSocket constructor factory that records every instance and
 * auto-opens asynchronously (a real CDP endpoint accepts the connection
 * after connect — attachTarget constructs the socket internally, so the
 * connection must open without test intervention).
 *
 * Auto-answering: with `autoAnswer: true` every command is answered
 * immediately with the CDP result shape `{result: {type, value}}` (so
 * Runtime.evaluate probes see a truthy value and resolve). With
 * `autoAnswerFor: ['Page.enable', ...]` only the listed methods are
 * auto-answered — the rest stay manual for assertion flows.
 * @param {{autoAnswer?: boolean, autoAnswerFor?: string[]}} [opts]
 * @returns {{ctor: Function, instances: MockWebSocket[]}}
 */
function makeMockWebSocket(opts = {}) {
  const autoAnswerMethods = Array.isArray(opts.autoAnswerFor) ? new Set(opts.autoAnswerFor) : null;
  const instances = [];
  class RecordingMockWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      instances.push(this);
      setImmediate(() => this.open()); // server accepts asynchronously
    }
    send(data) {
      super.send(data);
      const frame = JSON.parse(data);
      const shouldAnswer = opts.autoAnswer === true
        || (autoAnswerMethods !== null && autoAnswerMethods.has(frame.method));
      if (shouldAnswer) {
        // Answer with the CDP result shape so Runtime.evaluate-based probes
        // see a truthy value ({}) and resolve immediately.
        setImmediate(() => this.answer(frame.id, { result: { type: 'object', value: {} } }));
      }
      return true;
    }
  }
  return { ctor: RecordingMockWebSocket, instances };
}

module.exports = { MockWebSocket, makeMockWebSocket };
