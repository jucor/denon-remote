'use strict';
// End-to-end: "Browse by genre / country" chips under the radio search bar. Drives the real
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
  // Filler so we can check that only the top 40 are shown.
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

const chipTexts = (page, panel) =>
  page.$$eval(`${panel} .browse-chip`, (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')));

test('browse: a visible toggle opens two real tabs, Genres active, nothing fetched until opened', async () => {
  const { page, stats, close } = await boot();
  try {
    assert.equal(await page.isVisible('#radio-browse-toggle'), true);
    assert.match(await page.textContent('#radio-browse-toggle'), /Browse by genre \/ country/);
    assert.equal(await page.getAttribute('#radio-browse-toggle', 'aria-expanded'), 'false');
    assert.equal(stats.tags, 0, 'lazy: no request before the panel is opened');

    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    assert.equal(await page.getAttribute('#radio-browse-toggle', 'aria-expanded'), 'true');

    // ARIA structure
    assert.equal(await page.getAttribute('#radio-browse [role=tablist]', 'aria-label'), 'Browse stations by');
    const tabs = await page.$$eval('#radio-browse [role=tab]', (els) =>
      els.map((e) => ({ text: e.textContent.trim(), selected: e.getAttribute('aria-selected'), controls: e.getAttribute('aria-controls') })));
    assert.deepEqual(tabs.map((t) => t.text), ['Genres', 'Countries']);
    assert.deepEqual(tabs.map((t) => t.selected), ['true', 'false']);
    assert.equal(await page.getAttribute('#browse-panel-genres', 'role'), 'tabpanel');
    assert.equal(await page.getAttribute('#browse-panel-genres', 'aria-labelledby'), 'browse-tab-genres');
    assert.equal(tabs[0].controls, 'browse-panel-genres');

    // Materialised: visible border on both, and the active one is styled differently.
    const style = (sel) => page.$eval(sel, (e) => {
      const c = getComputedStyle(e);
      return { border: c.borderTopWidth, bg: c.backgroundColor, weight: c.fontWeight };
    });
    const active = await style('#browse-tab-genres');
    const inactive = await style('#browse-tab-countries');
    assert.notEqual(active.border, '0px');
    assert.notEqual(inactive.border, '0px');
    assert.notEqual(active.bg, inactive.bg);

    // Only the active panel is visible.
    assert.equal(await page.isVisible('#browse-panel-genres'), true);
    assert.equal(await page.isVisible('#browse-panel-countries'), false);
    assert.equal(stats.countries, 0, 'countries load lazily too');
  } finally {
    await close();
  }
});

test('browse: chips show thousands-separated counts and only the top 40 genres', async () => {
  const { page, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    const texts = await chipTexts(page, '#browse-panel-genres');
    assert.equal(texts.length, 40);
    assert.equal(texts[0], 'jazz · 2,345');
    assert.equal(texts[1], 'smooth jazz · 1,200');
    assert.equal(texts[2], 'pop · 1,234,567');
  } finally {
    await close();
  }
});

test('browse: switching to Countries by click shows flags, counts and updates the active state', async () => {
  const { page, stats, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    await page.click('#browse-tab-countries');
    await page.waitForSelector('#browse-panel-countries .browse-chip');
    assert.equal(await page.getAttribute('#browse-tab-countries', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('#browse-tab-genres', 'aria-selected'), 'false');
    assert.equal(await page.isVisible('#browse-panel-genres'), false);
    assert.equal(await page.isVisible('#browse-panel-countries'), true);
    const texts = await chipTexts(page, '#browse-panel-countries');
    assert.deepEqual(texts, [
      '🇫🇷 France · 1,500',
      '🇬🇧 The United Kingdom Of Great Britain And Northern Ireland · 3,100',
      '🌐 Nowhereland · 3',
    ]);
    // Back to Genres: no second fetch.
    await page.click('#browse-tab-genres');
    assert.equal(await page.isVisible('#browse-panel-genres'), true);
    await page.click('#browse-tab-countries');
    assert.equal(stats.countries, 1);
    assert.equal(stats.tags, 1);
  } finally {
    await close();
  }
});

test('browse: tabs follow the WAI-ARIA keyboard pattern (arrows, Home, End, roving tabindex)', async () => {
  const { page, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    await page.focus('#browse-tab-genres');
    assert.equal(await page.getAttribute('#browse-tab-genres', 'tabindex'), '0');
    assert.equal(await page.getAttribute('#browse-tab-countries', 'tabindex'), '-1');

    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('#browse-panel-countries .browse-chip');
    assert.equal(await page.getAttribute('#browse-tab-countries', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'browse-tab-countries');
    assert.equal(await page.getAttribute('#browse-tab-countries', 'tabindex'), '0');

    await page.keyboard.press('ArrowRight'); // wraps around
    assert.equal(await page.getAttribute('#browse-tab-genres', 'aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await page.getAttribute('#browse-tab-countries', 'aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getAttribute('#browse-tab-genres', 'aria-selected'), 'true');
    await page.keyboard.press('ArrowLeft'); // wraps backwards
    assert.equal(await page.getAttribute('#browse-tab-countries', 'aria-selected'), 'true');
  } finally {
    await close();
  }
});

test('browse: clicking a genre chip fills #radio-q with tag:<name> and shows results', async () => {
  const { page, stats, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    await page.click('#browse-panel-genres .browse-chip:first-child');
    await page.waitForSelector('#radio-results .radio-result');
    assert.equal(await page.inputValue('#radio-q'), 'tag:jazz');
    assert.deepEqual(stats.searches, ['tag:jazz']);
    const names = await page.$$eval('#radio-results .radio-result .radio-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(names, ['FIP Jazz', 'Radio Nova']);
    // The clicked chip shows as selected.
    assert.equal(await page.getAttribute('#browse-panel-genres .browse-chip:first-child', 'aria-pressed'), 'true');
  } finally {
    await close();
  }
});

test('browse: a multi-word genre stays ONE tag value (space is backslash-escaped for parseSearchQuery)', async () => {
  const { page, stats, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    await page.click('#browse-panel-genres .browse-chip:nth-child(2)');
    await page.waitForSelector('#radio-results .radio-result');
    assert.equal(await page.inputValue('#radio-q'), 'tag:smooth\\ jazz');
    assert.deepEqual(parseSearchQuery(stats.searches[0]), { tag: 'smooth jazz' });
  } finally {
    await close();
  }
});

test('browse: clicking a country chip fills #radio-q with cc:<code> (or country:<name> without a code)', async () => {
  const { page, stats, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.click('#browse-tab-countries');
    await page.waitForSelector('#browse-panel-countries .browse-chip');
    await page.click('#browse-panel-countries .browse-chip:first-child');
    await page.waitForSelector('#radio-results .radio-result');
    assert.equal(await page.inputValue('#radio-q'), 'cc:fr');

    await page.click('#browse-panel-countries .browse-chip:nth-child(3)');
    await page.waitForFunction(() => document.getElementById('radio-q').value === 'country:Nowhereland');
    assert.deepEqual(stats.searches, ['cc:fr', 'country:Nowhereland']);
  } finally {
    await close();
  }
});

test('browse: shows a loading state, then a visible error with a working Retry', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, close } = await boot({
    listTags: async () => {
      calls++;
      if (calls === 1) { await gate; throw new Error('upstream exploded'); }
      return TAGS;
    },
  });
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForFunction(() => /Loading/.test(document.getElementById('browse-status').textContent));
    assert.equal(await page.isVisible('#browse-status'), true);
    release();
    await page.waitForFunction(() => /upstream exploded/.test(document.getElementById('browse-status').textContent));
    assert.equal(await page.getAttribute('#browse-status', 'role'), 'alert');
    assert.equal(await page.$$eval('#browse-panel-genres .browse-chip', (e) => e.length), 0);

    await page.click('#browse-retry');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    assert.equal(await page.textContent('#browse-status'), '');
  } finally {
    await close();
  }
});

test('browse: the toggle collapses the panel again without refetching', async () => {
  const { page, stats, close } = await boot();
  try {
    await page.click('#radio-browse-toggle');
    await page.waitForSelector('#browse-panel-genres .browse-chip');
    await page.click('#radio-browse-toggle');
    assert.equal(await page.getAttribute('#radio-browse-toggle', 'aria-expanded'), 'false');
    assert.equal(await page.isVisible('#browse-panel-genres'), false);
    await page.click('#radio-browse-toggle');
    assert.equal(await page.isVisible('#browse-panel-genres'), true);
    assert.equal(stats.tags, 1);
  } finally {
    await close();
  }
});
