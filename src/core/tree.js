'use strict';

/**
 * Behavior tree decision core (REQ-10/11, design D3/D4).
 *
 * Pure, deterministic node evaluator: identical (state, config, clock, rng)
 * inputs produce identical ticks (REQ-11). Nodes carry no side effects other
 * than Action nodes, and a tick executes AT MOST ONE Action node (REQ-10:
 * "at most one action fires per tick") — evaluation HALTS immediately after
 * the first Action that runs, so a single tick can never enqueue two
 * server-bound actions, regardless of tree shape.
 *
 * Nodes (plain objects, so trees compose and serialize trivially):
 *
 *   { type: 'selector', children: [...], id? }
 *     Priority: run children in order, execute the FIRST child that succeeds
 *     and STOP (remaining children are never evaluated).
 *   { type: 'sequence', children: [...], id? }
 *     Gate: every child must succeed; FAILS FAST on the first failure.
 *   { type: 'condition', predicate: (ctx) => boolean, id? }
 *     Pure predicate; truthy -> success. No side effects.
 *   { type: 'action', run: (ctx) => boolean|void, id? }
 *     Side effect. `run` returning false (or throwing) means the action did
 *     NOT execute -> node failure, so a Selector falls through to the next
 *     child. Returning anything else (including undefined) means success.
 *     Once an Action succeeds, the tick halts (see above).
 *
 * Node helpers Selector/Sequence/Condition/Action are exported for
 * composition convenience; raw object literals work identically.
 *
 * tick(ctx) -> { action: Function|null, path: Array<{type, id, status}> }
 *   - `action` is the `run` function of the single executed Action (null when
 *     the tree evaluated to failure without executing anything).
 *   - `path` records every evaluated node in pre-order with its final status
 *     ('success' | 'failure') and `halted: true` on entries above the point
 *     where the tick stopped after the first executed Action.
 */

/**
 * @param {Function} predicate - (ctx) => boolean
 * @param {string} [id]
 * @returns {{type: 'condition', predicate: Function, id: string|undefined}}
 */
function Condition(predicate, id) {
  return { type: 'condition', predicate, id };
}

/**
 * @param {Function} run - (ctx) => boolean|void; false = did not execute
 * @param {string} [id]
 * @returns {{type: 'action', run: Function, id: string|undefined}}
 */
function Action(run, id) {
  return { type: 'action', run, id };
}

/**
 * @param {Array} children - child nodes
 * @param {string} [id]
 * @returns {{type: 'selector', children: Array, id: string|undefined}}
 */
function Selector(children, id) {
  return { type: 'selector', children, id };
}

/**
 * @param {Array} children - child nodes
 * @param {string} [id]
 * @returns {{type: 'sequence', children: Array, id: string|undefined}}
 */
function Sequence(children, id) {
  return { type: 'sequence', children, id };
}

/** Node type -> human label used in paths. */
function nodeLabel(node) {
  return String(node.id || node.type);
}

/**
 * Evaluate one node, mutating the shared tick state. After the first
 * successful Action the tick state carries `action` and every parent
 * short-circuits to success without evaluating further children.
 *
 * @param {object} node
 * @param {object} ctx
 * @param {{action: {id: string, run: Function}|null, path: Array}} tickState
 * @returns {{status: 'success'|'failure'}}
 */
function evaluate(node, ctx, tickState) {
  if (tickState.action) {
    // Halt: an action already executed earlier in this tick.
    return { status: 'success' };
  }

  switch (node.type) {
    case 'selector': {
      const entry = { type: 'selector', id: nodeLabel(node), status: 'running' };
      tickState.path.push(entry);
      for (const child of node.children || []) {
        const res = evaluate(child, ctx, tickState);
        if (tickState.action || res.status === 'success') {
          entry.status = 'success';
          if (tickState.action) entry.halted = true;
          return { status: 'success' };
        }
      }
      entry.status = 'failure';
      return { status: 'failure' };
    }

    case 'sequence': {
      const entry = { type: 'sequence', id: nodeLabel(node), status: 'running' };
      tickState.path.push(entry);
      for (const child of node.children || []) {
        const res = evaluate(child, ctx, tickState);
        if (tickState.action || res.status === 'failure') {
          entry.status = tickState.action ? 'success' : 'failure';
          if (tickState.action) entry.halted = true;
          return { status: entry.status };
        }
      }
      entry.status = 'success';
      return { status: 'success' };
    }

    case 'condition': {
      // Predicates are pure reads; a throw is a predicate bug and propagates
      // to the tick caller (codebase convention: engine conditions never
      // swallow errors).
      const ok = Boolean(node.predicate(ctx));
      tickState.path.push({ type: 'condition', id: nodeLabel(node), status: ok ? 'success' : 'failure' });
      return { status: ok ? 'success' : 'failure' };
    }

    case 'action': {
      // Same convention: action bugs propagate to the tick caller, which
      // (in the agent) records them per tick instead of crashing the page.
      const ok = node.run(ctx) !== false;
      tickState.path.push({ type: 'action', id: nodeLabel(node), status: ok ? 'success' : 'failure' });
      if (ok) tickState.action = { id: nodeLabel(node), run: node.run };
      return { status: ok ? 'success' : 'failure' };
    }

    default:
      throw new TypeError('tree: unknown node type ' + JSON.stringify(node.type));
  }
}

/**
 * Create the tree root. The root is any node; normally a Selector over the
 * priority branches (survival > combat > loot/training, REQ-11).
 *
 * @param {object} [opts]
 * @param {object} [opts.root] - root node (required)
 * @returns {{tick: (ctx?: object) => {action: Function|null, path: Array}, root: object}}
 */
function createTree({ root } = {}) {
  if (!root || typeof root.type !== 'string') {
    throw new TypeError('createTree requires a root node ({ type: ... })');
  }
  function tick(ctx = {}) {
    const tickState = { action: null, path: [] };
    evaluate(root, ctx, tickState);
    return { action: tickState.action ? tickState.action.run : null, path: tickState.path };
  }
  return { tick, root };
}

module.exports = { createTree, Condition, Action, Selector, Sequence };
