'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseFoodTimer } = require('../../src/core/sated');

test('REQ-05: "MM:SS" parses to seconds', () => {
  assert.equal(parseFoodTimer('0:58'), 58);
  assert.equal(parseFoodTimer('1:00'), 60);
  assert.equal(parseFoodTimer('12:34'), 754);
  assert.equal(parseFoodTimer('60:00'), 3600);
});

test('REQ-05: timer equal to the warning window parses as a real value', () => {
  assert.equal(parseFoodTimer('1:00'), 60);
});

test('REQ-05: null input means expired', () => {
  assert.equal(parseFoodTimer(null), null);
  assert.equal(parseFoodTimer(undefined), null);
});

test('REQ-05: "0:00" means expired', () => {
  assert.equal(parseFoodTimer('0:00'), null);
  assert.equal(parseFoodTimer('00:00'), null);
});

test('REQ-05: unparseable text means expired', () => {
  for (const bad of ['', '  ', 'abc', '12:75', '5:7', '1:2:3', ':30', '12:', '12;30', '-1:00', '1:00x']) {
    assert.equal(parseFoodTimer(bad), null, `expected ${JSON.stringify(bad)} to be expired`);
  }
});

test('REQ-05: whitespace around the timer is tolerated', () => {
  assert.equal(parseFoodTimer('  3:45  '), 225);
});
