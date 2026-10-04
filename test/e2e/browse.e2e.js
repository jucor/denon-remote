'use strict';
// End-to-end: "Browse by genre / country" dropdowns under the radio search bar. Drives the real
// frontend against the real radio router; only radio-browser.info (tags, countries, search)
// is stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { createRadioRouter } = require('../../lib/radioRoutes');
const { parseSearchQuery } = require('../../lib/radiobrowser');

const CANNED = [
  { uuid: 'u1', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', codec: 'MP3', bitrate: 128, country: 'France', favicon: '', votes: 99 },
  { uuid: 'u2', name: 'Radio Nova', url: 'http://cdn/nova.mp3', codec: 'AAC', bitrate: 96, country: 'France', favicon: '', votes: 40 },
];

const TAGS = [
  { name: 'jazz', stationcount: 2345 },
  { name: 'smooth jazz', stationcount: 1200 },
  { name: 'pop', stationcount: 1234567 },
  // Filler: a long list must still fit in one compact control.
  ...Array.from({ length: 47 }, (_, i) => ({ name: `genre${i + 1}`, stationcount: 100 - i })),
];

const COUNTRIES = [
  { name: 'France', code: 'FR', stationcount: 1500 },
  { name: 'The United Kingdom Of Great Britain And Northern Ireland', code: 'GB', stationcount: 3100 },
  { name: 'Nowhereland', stationcount: 3 },
];

async function boot({ listTags, listCountries } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-e2e-'));
  const stats = { tags: 0, countries: 0, searches: [] };
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({
    stationsFile: path.join(dir, 'stations.ini'),
    category: 'Julien',
    search: async (q) => { stats.searches.push(q); return CANNED; },
    listTags: listTags || (async () => { stats.tags++; return TAGS; }),
    listCountries: listCountries || (async () => { stats.countries++; return COUNTRIES; }),
  }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}`);
  const close = async () => { await browser.close(); await new Promise((r) => srv.close(r)); };
  return { page, stats, close };
}

const optionTexts = (page, sel) => page.$$eval(`${sel} option`, (els) => els.map((e) => e.textContent.trim()));
const waitLoaded = (page) => page.waitForFunction(() =>
  document.querySelectorAll('#browse-genre option').length > 1 && document.querySelectorAll('#browse-country option').length > 1);

test('browse: two labelled dropdowns on one compact line — no wall of chips (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await waitLoaded(page);
    assert.equal(await page.isVisible('#browse-genre'), true);
    assert.equal(await page.isVisible('#browse-country'), true);
    assert.equal(await page.textContent('label[for=browse-genre]'), 'Genre');
    assert.equal(await page.textContent('label[for=browse-country]'), 'Country');
    assert.equal(await page.$$eval('#radio-browse .browse-chip', (e) => e.length), 0);
    const height = await page.$eval('#radio-browse', (e) => e.getBoundingClientRect().height);
    assert.ok(height < 80, `browse block is ${Math.round(height)} px tall`);
  } finally { await close(); }
});

test('browse: genres by popularity, countries alphabetical with flags, counts with commas, "Any" first (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await waitLoaded(page);
    const genres = await optionTexts(page, '#browse-genre');
    assert.deepEqual(genres.slice(0, 4), ['Any genre', 'pop · 1,234,567', 'jazz · 2,345', 'smooth jazz · 1,200']);
    assert.equal(genres.length, 1 + TAGS.length);
    assert.deepEqual(await optionTexts(page, '#browse-country'), [
      'Any country', '🇫🇷 France · 1,500', '🌐 Nowhereland · 3',
      '🇬🇧 The United Kingdom Of Great Britain And Northern Ireland · 3,100',
    ]);
  } finally { await close(); }
});

test('browse: picking a genre writes the query and searches; a country combines with it (browser E2E)', async () => {
  const { page, stats, close } = await boot();
  try {
    await waitLoaded(page);
    await page.selectOption('#browse-genre', { label: 'smooth jazz · 1,200' });
    await page.waitForFunction(() => document.querySelectorAll('#radio-results .radio-result').length > 0);
    assert.equal(await page.inputValue('#radio-q'), 'tag:smooth\\ jazz');
    assert.deepEqual(parseSearchQuery(stats.searches.at(-1)), { tag: 'smooth jazz' });

    await page.selectOption('#browse-country', { label: '🇫🇷 France · 1,500' });
    await page.waitForFunction(() => /cc:fr/.test(document.getElementById('radio-q').value));
    assert.equal(await page.inputValue('#radio-q'), 'tag:smooth\\ jazz cc:fr');
    for (let i = 0; i < 20 && stats.searches.at(-1) !== 'tag:smooth\\ jazz cc:fr'; i++) await page.waitForTimeout(50);
    assert.deepEqual(parseSearchQuery(stats.searches.at(-1)), { tag: 'smooth jazz', countrycode: 'fr' });
  } finally { await close(); }
});

test('browse: words typed in the box are kept; "Any" removes only its own filter (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await waitLoaded(page);
    await page.fill('#radio-q', 'fip');
    await page.selectOption('#browse-genre', { label: 'jazz · 2,345' });
    await page.waitForFunction(() => document.getElementById('radio-q').value === 'fip tag:jazz');
    await page.selectOption('#browse-country', { label: '🌐 Nowhereland · 3' });
    await page.waitForFunction(() => document.getElementById('radio-q').value === 'fip tag:jazz country:Nowhereland');
    await page.selectOption('#browse-genre', { label: 'Any genre' });
    await page.waitForFunction(() => document.getElementById('radio-q').value === 'fip country:Nowhereland');
  } finally { await close(); }
});

test('browse: a list that fails to load says so, with a Retry button (browser E2E)', async () => {
  let fail = true;
  const { page, close } = await boot({ listTags: async () => { if (fail) throw new Error('radio-browser is down'); return TAGS; } });
  try {
    await page.waitForSelector('#browse-status .browse-retry');
    assert.match(await page.textContent('#browse-status'), /genres.*radio-browser is down/i);
    fail = false;
    await page.click('#browse-status .browse-retry');
    await page.waitForFunction(() => document.querySelectorAll('#browse-genre option').length > 1);
    assert.equal(await page.isVisible('#browse-status .browse-retry'), false);
  } finally { await close(); }
});
