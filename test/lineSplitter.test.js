'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LineSplitter } = require('../lib/lineSplitter');

const STREAM = 'NSE0Julien\rNSE1\x09Big R Radio - 80s Metal FM\rNSE2\x01Exclusively Elvis Presley\rMV50\r';
const LINES = ['NSE0Julien', 'NSE1\x09Big R Radio - 80s Metal FM', 'NSE2\x01Exclusively Elvis Presley', 'MV50'];

test('whole chunks split on CR', () => {
  assert.deepEqual(new LineSplitter().push(STREAM), LINES);
});

test('a line split across two chunks at any offset is reassembled', () => {
  for (let cut = 1; cut < STREAM.length; cut++) {
    const s = new LineSplitter();
    const got = [...s.push(STREAM.slice(0, cut)), ...s.push(STREAM.slice(cut))];
    assert.deepEqual(got, LINES, `cut at ${cut}`);
  }
});

test('leading info bytes and spaces inside a line are kept; empty lines dropped', () => {
  assert.deepEqual(new LineSplitter().push('\r\rNSE5\x20  000:01\r'), ['NSE5\x20  000:01']);
});
