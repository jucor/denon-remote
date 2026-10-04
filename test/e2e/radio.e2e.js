'use strict';
// End-to-end: drive the real frontend in a browser against the real radio router
// (only radio-browser.info is stubbed). Verifies type -> search -> add -> the station
// lands in yTuner's stations file and the "My Stations" list, then remove; plus the
// Clear and Syntax-help controls.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { createRadioRouter } = require('../../lib/radioRoutes');
const { listStations } = require('../../lib/stations');

const CANNED = [
  { uuid: 'u1', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', codec: 'MP3', bitrate: 128, country: 'France', favicon: '', votes: 99 },
  { uuid: 'u2', name: 'Radio Nova', url: 'http://cdn/nova.mp3', codec: 'AAC', bitrate: 96, country: 'France', favicon: '', votes: 40 },
];

// Boot a throwaway app (static frontend + radio router) and a browser page.
async function boot({ play, stationsText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');
  if (stationsText) fs.writeFileSync(stationsFile, stationsText);
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({ stationsFile, category: 'Julien', search: async (q) => (q ? CANNED : []), play }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}`);
  const close = async () => { await browser.close(); await new Promise((r) => srv.close(r)); };
  return { page, stationsFile, close };
}

test('radio search -> add -> list -> remove (browser E2E)', async () => {
  const { page, stationsFile, close } = await boot();
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result');
    const resultNames = await page.$$eval('#radio-results .radio-result', (els) =>
      els.map((e) => e.querySelector('.radio-name').textContent.trim()));
    assert.deepEqual(resultNames, ['FIP Jazz', 'Radio Nova']);

    await page.click('#radio-results .radio-result:first-child .radio-add');
    await page.waitForSelector('#radio-mystations .radio-mine');
    const mineNames = await page.$$eval('#radio-mystations .radio-mine', (els) =>
      els.map((e) => e.querySelector('.radio-name').textContent.trim()));
    assert.deepEqual(mineNames, ['FIP Jazz']);

    const onDisk = fs.readFileSync(stationsFile, 'utf8');
    assert.match(onDisk, /\[Julien\]/);
    assert.match(onDisk, /FIP Jazz=http:\/\/cdn\/jazz\.mp3/);

    await page.click('#radio-mystations .radio-mine:first-child .radio-remove');
    await page.waitForFunction(() =>
      document.querySelectorAll('#radio-mystations .radio-mine').length === 0);
    assert.deepEqual(listStations(fs.readFileSync(stationsFile, 'utf8')), []);
  } finally {
    await close();
  }
});

test('radio: syntax help toggles and Clear resets the search (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result');

    // Help panel is hidden until requested, then shown.
    assert.equal(await page.isVisible('#radio-help'), false);
    await page.click('#radio-help-btn');
    assert.equal(await page.isVisible('#radio-help'), true);

    // Clear empties the input and the results (but not the help toggle state).
    await page.click('#radio-reset-btn');
    assert.equal(await page.inputValue('#radio-q'), '');
    assert.equal(await page.$$eval('#radio-results .radio-result', (els) => els.length), 0);
  } finally {
    await close();
  }
});

const TWO_STATIONS = '[Julien]\nBig R Radio - 80s Metal FM=http://bigr/5186_128\nExclusively Elvis Presley=http://elvis/icecast.audio\n';

test('My Stations: each row has a visible Play button that plays it on the receiver (browser E2E)', async () => {
  const calls = [];
  const { page, close } = await boot({ stationsText: TWO_STATIONS, play: async (s) => { calls.push(s); } });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine');
    const buttons = await page.$$eval('#radio-mystations .radio-mine .radio-play', (els) =>
      els.map((e) => e.textContent.trim()));
    assert.deepEqual(buttons, ['▶ Play', '▶ Play']);

    await page.click('#radio-mystations .radio-mine:nth-child(2) .radio-play');
    await page.waitForFunction(() => /Playing/.test(document.getElementById('radio-mine-status').textContent));
    assert.deepEqual(calls, [{ name: 'Exclusively Elvis Presley', category: 'Julien' }]);

    // Clicking the row itself (not just the button) plays it too.
    await page.click('#radio-mystations .radio-mine:nth-child(1) .radio-name');
    await page.waitForFunction(() => /Big R Radio/.test(document.getElementById('radio-mine-status').textContent));
    assert.equal(calls[1].name, 'Big R Radio - 80s Metal FM');
  } finally {
    await close();
  }
});

test('My Stations: a failed Play shows the reason next to the list (browser E2E)', async () => {
  const play = async () => { throw Object.assign(new Error('Needs the telnet connection — press Connect'), { status: 503 }); };
  const { page, close } = await boot({ stationsText: TWO_STATIONS, play });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine');
    await page.click('#radio-mystations .radio-mine:first-child .radio-play');
    await page.waitForFunction(() => /telnet/.test(document.getElementById('radio-mine-status').textContent));
    assert.match(await page.getAttribute('#radio-mine-status', 'class'), /error/);
    assert.equal(await page.textContent('#radio-mystations .radio-mine:first-child .radio-play'), '▶ Play');
  } finally {
    await close();
  }
});

test('Receiver display: cursor row is marked and every menu row is tappable, incl. stations (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    // Lines captured from the RCD-N9: stations carry info byte 0x01, not 0x02.
    await page.evaluate(() => {
      updateInput('IRADIO');
      ['NSE0Julien', 'NSE1\x01Big R Radio - 80s Metal FM', 'NSE2\x09Exclusively Elvis Presley',
        'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8\x20  [    1/1    ]'].forEach(handleDisplay);
    });
    const rows = await page.$$eval('#receiver-display .display-line', (els) => els.map((e) => ({
      text: e.textContent.trim(), cursor: e.classList.contains('cursor'), tappable: e.classList.contains('selectable'),
    })));
    assert.deepEqual(rows, [
      { text: 'Julien', cursor: false, tappable: false },
      { text: 'Big R Radio - 80s Metal FM', cursor: false, tappable: true },
      { text: '▶ Exclusively Elvis Presley', cursor: true, tappable: true },
      { text: '[    1/1    ]', cursor: false, tappable: false },
    ]);
  } finally {
    await close();
  }
});

test('Receiver display: shown for the HTTP API input name "NET" too (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await page.evaluate(() => {
      updateInput('NET');
      ['NSE0Julien', 'NSE1\x09Big R Radio - 80s Metal FM', 'NSE2', 'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8'].forEach(handleDisplay);
    });
    assert.match(await page.textContent('#receiver-display'), /Big R Radio/);
  } finally {
    await close();
  }
});
