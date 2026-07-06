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
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({ stationsFile, category: 'Julien', search: async (q) => (q ? CANNED : []) }));
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
