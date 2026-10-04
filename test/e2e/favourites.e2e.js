'use strict';
// End-to-end: the "On the receiver · Favourites" list and the "☆ Favourites" button on
// search results, driven in a real browser against the real radio router (only
// radio-browser.info and the receiver's play are stubbed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { createRadioRouter } = require('../../lib/radioRoutes');
const bookmarks = require('../../lib/bookmarks');

const CANNED = [
  { uuid: '960e57c5-0601-11e8-ae97-52543be04c81', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', codec: 'MP3', bitrate: 128, country: 'France', favicon: '', votes: 99 },
  { uuid: 'u2', name: 'Radio Nova', url: 'http://cdn/nova.mp3', codec: 'AAC', bitrate: 96, country: 'France', favicon: '', votes: 40 },
];

// Boot a throwaway app (static frontend + radio router) and a browser page.
async function boot({ play, favourites = [], withBookmarks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');
  const bookmarksFile = path.join(dir, 'bookmark.xml');
  for (const f of favourites) await bookmarks.add(bookmarksFile, f);
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({
    stationsFile, bookmarksFile: withBookmarks ? bookmarksFile : undefined, category: 'Julien',
    search: async (q) => (q ? CANNED : []), play,
  }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const playBodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/radio/play')) playBodies.push(JSON.parse(req.postData()));
  });
  await page.goto(`http://127.0.0.1:${srv.address().port}`);
  const close = async () => { await browser.close(); await new Promise((r) => srv.close(r)); };
  return { page, bookmarksFile, playBodies, close };
}

const TWO = [
  { name: 'Big R Radio - 80s Metal FM', url: 'http://bigr/5186_128' },
  { name: 'Exclusively Elvis Presley', url: 'http://elvis/icecast.audio' },
];
const names = (page) => page.$$eval('#radio-favourites .fav-row .radio-name', (els) => els.map((e) => e.textContent.trim()));
const status = (page) => page.textContent('#radio-fav-status');

test('Favourites: titled list with a visible Play and a remove button on every row (browser E2E)', async () => {
  const { page, close } = await boot({ favourites: TWO, play: async () => {} });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    assert.match(await page.textContent('#radio-favourites .radio-mine-title'), /On the receiver · Favourites/);
    assert.deepEqual(await names(page), ['Big R Radio - 80s Metal FM', 'Exclusively Elvis Presley']);
    assert.deepEqual(await page.$$eval('#radio-favourites .fav-play', (els) => els.map((e) => e.textContent.trim())), ['▶ Play', '▶ Play']);
    assert.deepEqual(await page.$$eval('#radio-favourites .fav-remove', (els) => els.map((e) => e.textContent.trim())), ['×', '×']);
    // Real, named buttons — nothing hover-only.
    assert.deepEqual(await page.$$eval('#radio-favourites .fav-play', (els) => els.map((e) => [e.tagName, e.getAttribute('aria-label')])),
      [['BUTTON', 'Play Big R Radio - 80s Metal FM'], ['BUTTON', 'Play Exclusively Elvis Presley']]);
    assert.deepEqual(await page.$$eval('#radio-favourites .fav-remove', (els) => els.map((e) => e.getAttribute('aria-label'))),
      ['Remove Big R Radio - 80s Metal FM from Favourites', 'Remove Exclusively Elvis Presley from Favourites']);
    assert.equal(await page.getAttribute('#radio-fav-status', 'role'), 'status');
  } finally { await close(); }
});

test('Favourites: Play and a click anywhere on the row POST {name, path:["Favourites"]} and show the result (browser E2E)', async () => {
  const { page, playBodies, close } = await boot({ favourites: TWO, play: async () => {} });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await page.evaluate(() => updateConnection('connected'));
    await page.click('#radio-favourites .fav-row:nth-child(2) .fav-play');
    await page.waitForFunction(() => /^Playing “Exclusively Elvis/.test(document.getElementById('radio-fav-status').textContent));
    // Clicking the name (not the button) plays too.
    await page.click('#radio-favourites .fav-row:nth-child(1) .radio-name');
    await page.waitForFunction(() => /^Playing “Big R/.test(document.getElementById('radio-fav-status').textContent));
    assert.deepEqual(playBodies, [
      { name: 'Exclusively Elvis Presley', path: ['Favourites'] },
      { name: 'Big R Radio - 80s Metal FM', path: ['Favourites'] },
    ]);
    assert.equal(await page.textContent('#radio-favourites .fav-row:nth-child(1) .fav-play'), '▶ Play');
  } finally { await close(); }
});

test('Favourites: a failed Play shows the server reason in the status line (browser E2E)', async () => {
  const play = async () => { throw Object.assign(new Error('Needs the telnet connection — press Connect'), { status: 503 }); };
  const { page, close } = await boot({ favourites: TWO, play });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await page.evaluate(() => updateConnection('connected'));
    await page.click('#radio-favourites .fav-row:first-child .fav-play');
    await page.waitForFunction(() => /telnet/.test(document.getElementById('radio-fav-status').textContent));
    assert.match(await page.getAttribute('#radio-fav-status', 'class'), /error/);
    assert.match(await status(page), /^Could not play “Big R Radio/);
  } finally { await close(); }
});

test('Favourites: Play is disabled with a visible reason until telnet is connected (browser E2E)', async () => {
  const { page, playBodies, close } = await boot({ favourites: TWO, play: async () => {} });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await page.evaluate(() => updateConnection('disconnected', '', true, true));
    assert.deepEqual(await page.$$eval('.fav-play', (els) => els.map((e) => e.disabled)), [true, true]);
    assert.match(await status(page), /Connect/);
    await page.click('#radio-favourites .fav-row:first-child .radio-name'); // row click must not play either
    assert.equal(playBodies.length, 0);
    await page.evaluate(() => updateConnection('connected'));
    assert.deepEqual(await page.$$eval('.fav-play', (els) => els.map((e) => e.disabled)), [false, false]);
    assert.equal(await status(page), '');
  } finally { await close(); }
});

test('Favourites: × removes a favourite from the list and from bookmark.xml; the last one deletes the file (browser E2E)', async () => {
  const { page, bookmarksFile, close } = await boot({ favourites: TWO });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await page.click('#radio-favourites .fav-row:first-child .fav-remove');
    await page.waitForFunction(() => document.querySelectorAll('#radio-favourites .fav-row').length === 1);
    assert.deepEqual(bookmarks.list(bookmarksFile).map((f) => f.name), ['Exclusively Elvis Presley']);
    await page.click('#radio-favourites .fav-row:first-child .fav-remove');
    await page.waitForFunction(() => document.querySelectorAll('#radio-favourites .fav-row').length === 0);
    assert.equal(fs.existsSync(bookmarksFile), false);
    // An empty list still says how to fill it.
    assert.match(await page.textContent('#radio-favourites'), /No favourites yet/);
  } finally { await close(); }
});

test('Favourites: every search result gets a "☆ Favourites" button that adds it (browser E2E)', async () => {
  const { page, bookmarksFile, close } = await boot();
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result .fav-add');
    assert.deepEqual(await page.$$eval('#radio-results .radio-result .fav-add', (els) => els.map((e) => [e.tagName, e.textContent.trim()])),
      [['BUTTON', '☆ Favourites'], ['BUTTON', '☆ Favourites']]);
    // The existing "+ Add" button is still there, untouched.
    assert.equal(await page.$$eval('#radio-results .radio-add', (els) => els.length), 2);

    await page.click('#radio-results .radio-result:first-child .fav-add');
    await page.waitForSelector('#radio-favourites .fav-row');
    assert.deepEqual(await names(page), ['FIP Jazz']);
    assert.match(await page.textContent('#radio-status'), /Added “FIP Jazz” to Favourites/);
    assert.equal(await page.textContent('#radio-results .radio-result:first-child .fav-add'), '★ In Favourites');
    assert.equal(await page.isDisabled('#radio-results .radio-result:first-child .fav-add'), true);

    const onDisk = bookmarks.parse(fs.readFileSync(bookmarksFile, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.deepEqual(onDisk[0].fields.find(([t]) => t === 'StationUrl'), ['StationUrl', 'http://cdn/jazz.mp3']);
    assert.deepEqual(onDisk[0].fields.find(([t]) => t === 'StationId'), ['StationId', 'RBB960E57C50601']);

    // A second search re-renders the results: the buttons come back (observer, not one-shot).
    await page.click('#radio-search-btn');
    await page.waitForFunction(() => document.querySelectorAll('#radio-results .radio-result .fav-add').length === 2);
  } finally { await close(); }
});

test('Favourites: adding the same station twice says it is already there (browser E2E)', async () => {
  const { page, close } = await boot({ favourites: [{ name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', uuid: '960e57c5-0601-11e8-ae97-52543be04c81' }] });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .fav-add');
    await page.click('#radio-results .radio-result:first-child .fav-add');
    await page.waitForFunction(() => /already/.test(document.getElementById('radio-status').textContent));
    assert.deepEqual(await names(page), ['FIP Jazz']);
  } finally { await close(); }
});

test('Favourites: a refused add shows the reason and keeps the button usable (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .fav-add');
    await page.route('**/api/radio/favourites', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Favourites are full (100 at most)' }) })
      : route.continue());
    await page.click('#radio-results .radio-result:first-child .fav-add');
    await page.waitForFunction(() => /full/.test(document.getElementById('radio-status').textContent));
    assert.match(await page.getAttribute('#radio-status', 'class'), /error/);
    assert.equal(await page.textContent('#radio-results .radio-result:first-child .fav-add'), '☆ Favourites');
    assert.equal(await page.isDisabled('#radio-results .radio-result:first-child .fav-add'), false);
  } finally { await close(); }
});

test('Favourites: the section and buttons stay out of the way when the server has no bookmark file configured (browser E2E)', async () => {
  const { page, close } = await boot({ withBookmarks: false });
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result');
    await page.waitForTimeout(200);
    assert.equal(await page.isVisible('#radio-favourites .radio-mine-title'), false);
    assert.equal(await page.$$eval('.fav-add', (els) => els.length), 0);
  } finally { await close(); }
});

test('Favourites: Refresh re-reads the file (the receiver edits it too) (browser E2E)', async () => {
  const { page, bookmarksFile, close } = await boot({ favourites: TWO });
  try {
    await page.waitForSelector('#radio-favourites .fav-row');
    await bookmarks.add(bookmarksFile, { name: 'Added On Receiver', url: 'http://r/1' });
    assert.equal(await page.$$eval('#radio-favourites .fav-row', (els) => els.length), 2);
    await page.click('#radio-favourites .fav-refresh');
    await page.waitForFunction(() => document.querySelectorAll('#radio-favourites .fav-row').length === 3);
    assert.equal((await names(page))[2], 'Added On Receiver');
  } finally { await close(); }
});
