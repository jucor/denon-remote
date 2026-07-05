'use strict';
// End-to-end: drive the real frontend in a browser against the real radio router
// (only radio-browser.info is stubbed). Verifies type -> search -> add -> the station
// lands in yTuner's stations file and the "My Stations" list, then remove.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { createRadioRouter } = require('../../lib/radioRoutes');

const CANNED = [
  { uuid: 'u1', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', codec: 'MP3', bitrate: 128, country: 'France', favicon: '', votes: 99 },
  { uuid: 'u2', name: 'Radio Nova', url: 'http://cdn/nova.mp3', codec: 'AAC', bitrate: 96, country: 'France', favicon: '', votes: 40 },
];

test('radio search -> add -> list -> remove (browser E2E)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');

  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({
    stationsFile,
    category: 'Julien',
    search: async (q) => (q ? CANNED : []),
  }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(base);

    // Search
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result');
    const resultNames = await page.$$eval('#radio-results .radio-result', (els) =>
      els.map((e) => e.querySelector('.radio-name').textContent.trim()));
    assert.deepEqual(resultNames, ['FIP Jazz', 'Radio Nova']);

    // Add the first result
    await page.click('#radio-results .radio-result:first-child .radio-add');
    await page.waitForSelector('#radio-mystations .radio-mine');

    const mineNames = await page.$$eval('#radio-mystations .radio-mine', (els) =>
      els.map((e) => e.querySelector('.radio-name').textContent.trim()));
    assert.deepEqual(mineNames, ['FIP Jazz']);

    // Persisted to the yTuner stations file
    const onDisk = fs.readFileSync(stationsFile, 'utf8');
    assert.match(onDisk, /\[Julien\]/);
    assert.match(onDisk, /FIP Jazz=http:\/\/cdn\/jazz\.mp3/);

    // Remove it
    await page.click('#radio-mystations .radio-mine:first-child .radio-remove');
    await page.waitForFunction(() =>
      document.querySelectorAll('#radio-mystations .radio-mine').length === 0);
    assert.deepEqual(require('../../lib/stations').listStations(fs.readFileSync(stationsFile, 'utf8')), []);
  } finally {
    await browser.close();
    await new Promise((r) => srv.close(r));
  }
});
