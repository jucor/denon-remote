'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNseLine, ScreenAssembler } = require('../lib/nseScreen');

// Real lines captured from the RCD-N9 (via yTuner), 2026-10-04.
const JULIEN = [
  'NSE0Julien',
  'NSE1\x09Big R Radio - 80s Metal FM',
  'NSE2\x01Exclusively Elvis Presley',
  'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8',
];
const MY_STATIONS = [
  'NSE0My Stations', 'NSE1\x0aJulien',
  'NSE2', 'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8\x20  [    1/1    ]',
];
const NOW_PLAYING = [
  'NSE0Now Playing',
  'NSE1\x20Big R Radio - Back After This Message',
  'NSE2\x09Big R Radio - 80s Metal FM',
  'NSE3', 'NSE4\x01', 'NSE5\x20  000:01     100%', 'NSE6', 'NSE7', 'NSE8',
];

function assemble(lines) {
  const a = new ScreenAssembler();
  let screen = null;
  for (const l of lines) screen = a.feed(l) || screen;
  return screen;
}

test('parseNseLine splits index, info byte and text', () => {
  assert.deepEqual(parseNseLine('NSE1\x09Big R Radio'), { idx: 1, info: 0x09, text: 'Big R Radio' });
  assert.deepEqual(parseNseLine('NSE0Julien'), { idx: 0, info: 0, text: 'Julien' });
  assert.deepEqual(parseNseLine('NSE3'), { idx: 3, info: 0, text: '' });
  assert.deepEqual(parseNseLine('NSA2\x01Elvis\x00junk'), { idx: 2, info: 0x01, text: 'Elvis' });
  assert.equal(parseNseLine('MV50'), null);
});

test('a screen is emitted only once line 8 arrives', () => {
  const a = new ScreenAssembler();
  for (const l of JULIEN.slice(0, 8)) assert.equal(a.feed(l), null);
  assert.ok(a.feed(JULIEN[8]));
});

test('station rows (info 0x01) are items, and the cursor is found', () => {
  const s = assemble(JULIEN);
  assert.equal(s.title, 'Julien');
  assert.deepEqual(s.items.map((i) => [i.idx, i.text, i.cursor]), [
    [1, 'Big R Radio - 80s Metal FM', true],
    [2, 'Exclusively Elvis Presley', false],
  ]);
  assert.equal(s.cursor, 1);
  assert.equal(s.loading, false);
});

test('folder rows (0x02) are items; the [1/1] page indicator (0x20) is not', () => {
  const s = assemble(MY_STATIONS);
  assert.deepEqual(s.items.map((i) => i.text), ['Julien']);
  assert.deepEqual(s.page, { current: 1, total: 1 });
});

test('info-only (0x20) and empty rows on Now Playing are not items', () => {
  const s = assemble(NOW_PLAYING);
  assert.equal(s.title, 'Now Playing');
  assert.deepEqual(s.items.map((i) => i.text), ['Big R Radio - 80s Metal FM']);
  assert.equal(s.cursor, 2);
});

test('"---- empty ----" marks a list that is still loading', () => {
  const s = assemble([
    'NSE0My Stations', 'NSE1\x08---- empty ----',
    'NSE2', 'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8\x20  [    0/0    ]',
  ]);
  assert.equal(s.loading, true);
  assert.deepEqual(s.items, []);
});

test('a new line 0 starts a fresh screen (no rows leak from the previous one)', () => {
  const a = new ScreenAssembler();
  for (const l of JULIEN) a.feed(l);
  let s = null;
  for (const l of MY_STATIONS) s = a.feed(l) || s;
  assert.deepEqual(s.items.map((i) => i.text), ['Julien']);
});
