'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHttpStatus, httpStatusChanges } = require('../lib/httpStatus');

const XML = `<?xml version="1.0" encoding="utf-8" ?>
<item>
<Power><value>ON</value></Power>
<InputFuncSelect><value>NET</value></InputFuncSelect>
<MasterVolume><value>-74.0</value></MasterVolume>
<Mute><value>off</value></Mute>
</item>`;

test('parseHttpStatus converts dB volume to the 0-60 scale and upper-cases mute', () => {
  assert.deepEqual(parseHttpStatus(XML), { power: 'ON', input: 'NET', volume: '06', mute: 'OFF' });
});

test('changes are reported only for fields that differ from current state', () => {
  const state = { power: 'ON', input: 'CD', volume: '06', mute: 'OFF' };
  assert.deepEqual(httpStatusChanges(parseHttpStatus(XML), state, { telnetConnected: false }), { input: 'NET' });
});

test('while telnet is connected, a late HTTP poll never overrides telnet state', () => {
  // Race seen live: telnet reports SIIRADIO, then the in-flight HTTP poll returns "NET"
  // and the page drops every display line.
  const state = { power: 'ON', input: 'IRADIO', volume: '10', mute: 'OFF' };
  assert.deepEqual(httpStatusChanges(parseHttpStatus(XML), state, { telnetConnected: true }), {});
});
