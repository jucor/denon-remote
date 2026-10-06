'use strict';
// End-to-end: "Listen here" plays a saved station (My Stations or Favourites) in the browser
// itself, through the real relay and the real saved-URL allow-list. Only the radio station is
// faked: a local server looping a 1 s MP3 tone (test/fixtures/tone.mp3), with ICY titles.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { chromium } = require('playwright');
const { createRadioRouter } = require('../../lib/radioRoutes');
const { createStreamRelay } = require('../../lib/streamRelay');
const { listenStreamUrl, savedAddress } = require('../../lib/savedUrls');
const bookmarks = require('../../lib/bookmarks');

const TONE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tone.mp3'));
const RELAY_BASE = 'http://192.168.1.61:3002';

// A radio station: /tone.mp3 loops the tone forever; anything else is a 404.
async function station() {
  const srv = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/tone.mp3') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const timer = setInterval(() => res.write(TONE), 250);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}

// Boot the frontend + radio router + relay's listen route, with the given saved entries.
// "STATION" in them stands for the fake station's base URL; stationsText may also be a
// function of that base (for entries that must encode it).
async function boot({ stationsText = '', favourites = [], width } = {}) {
  const radio = await station();
  const sub = (s) => (typeof s === 'function' ? s(radio.base) : s.replaceAll('STATION', radio.base));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');
  const bookmarksFile = path.join(dir, 'bookmark.xml');
  fs.writeFileSync(stationsFile, sub(stationsText));
  for (const f of favourites) await bookmarks.add(bookmarksFile, { ...f, url: sub(f.url) });
  const relay = createStreamRelay({
    allowPrivateHosts: true,
    resolveListenUrl: (url) => listenStreamUrl({ stationsFile, bookmarksFile, relayBase: RELAY_BASE, url }),
  });
  const app = express();
  app.use(express.json());
  app.get('/api/radio/listen', relay.listenHandler);
  app.use('/api/radio', createRadioRouter({
    stationsFile, bookmarksFile, category: 'Julien', search: async () => [], play: async () => {},
  }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage(width ? { viewport: { width, height: 900 } } : {});
  const listens = [];
  const plays = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/radio/listen')) listens.push(new URL(req.url()));
    if (req.method() === 'POST' && req.url().endsWith('/api/radio/play')) plays.push(req.postData());
  });
  await page.goto(`http://127.0.0.1:${srv.address().port}`);
  const close = async () => {
    await browser.close();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    await radio.close();
  };
  return { page, listens, plays, radioBase: radio.base, close };
}

const audioPlaying = (page) => page.waitForFunction(() => {
  const a = document.getElementById('listen-audio');
  return a && !a.paused && a.currentTime > 0.2;
}, null, { timeout: 15000 });

test('Listen here: every My Stations and Favourites row has a visible, named button (browser E2E)', async () => {
  const { page, close } = await boot({
    stationsText: '[Julien]\nFIP Jazz=STATION/tone.mp3\n',
    favourites: [{ name: 'Radio Nova', url: 'STATION/tone.mp3' }],
  });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine .radio-listen');
    await page.waitForSelector('#radio-favourites .fav-row .radio-listen');
    const buttons = await page.$$eval('.radio-listen', (els) => els.map((b) => ({
      text: b.textContent.trim(), label: b.getAttribute('aria-label'), visible: b.offsetWidth > 0,
    })));
    assert.deepEqual(buttons.map((b) => b.label).sort(),
      ['Listen to FIP Jazz on this device', 'Listen to Radio Nova on this device']);
    for (const b of buttons) {
      assert.equal(b.text, '🎧 Listen here');
      assert.equal(b.visible, true);
    }
    assert.equal(await page.isVisible('#listen-bar'), false, 'no player bar until something plays');
  } finally {
    await close();
  }
});

test('Listen here: plays the station in the browser, not on the receiver; Stop ends it (browser E2E)', async () => {
  const { page, listens, plays, radioBase, close } = await boot({ stationsText: '[Julien]\nFIP Jazz=STATION/tone.mp3\n' });
  try {
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await audioPlaying(page);
    assert.deepEqual(plays, [], 'the receiver is left alone');
    assert.equal(listens.length >= 1, true);
    assert.equal(listens[0].searchParams.get('url'), `${radioBase}/tone.mp3`);
    assert.match(listens[0].searchParams.get('lid'), /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(await page.isVisible('#listen-bar'), true);
    assert.equal((await page.textContent('#listen-now')).trim(), 'On this device · FIP Jazz');
    // The row's own button turns into Stop while it plays.
    assert.equal((await page.textContent('#radio-mystations .radio-listen')).trim(), '■ Stop');
    assert.equal(await page.getAttribute('#radio-mystations .radio-listen', 'aria-pressed'), 'true');

    await page.click('#listen-stop');
    assert.equal(await page.isVisible('#listen-bar'), false);
    assert.equal(await page.$eval('#listen-audio', (a) => a.paused), true);
    assert.equal((await page.textContent('#radio-mystations .radio-listen')).trim(), '🎧 Listen here');
    assert.equal(await page.getAttribute('#radio-mystations .radio-listen', 'aria-pressed'), 'false');
  } finally {
    await close();
  }
});

test('Listen here: a geo-blocked entry (saved as the relay address) plays through the relay too (browser E2E)', async () => {
  const geo = (base) => `[Julien]\nRire et Chansons=${savedAddress(RELAY_BASE, `${base}/tone.mp3`)}\n`;
  const { page, listens, radioBase, close } = await boot({ stationsText: geo });
  try {
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await audioPlaying(page);
    assert.equal(listens[0].searchParams.get('url'), savedAddress(RELAY_BASE, `${radioBase}/tone.mp3`));
    assert.equal((await page.textContent('#listen-now')).trim(), 'On this device · Rire et Chansons');
  } finally {
    await close();
  }
});

test('Listen here: Favourites rows play too, and switching station replaces the stream (browser E2E)', async () => {
  const { page, listens, close } = await boot({
    stationsText: '[Julien]\nFIP Jazz=STATION/tone.mp3\n',
    favourites: [{ name: 'Radio Nova', url: 'STATION/tone.mp3?nova' }],
  });
  try {
    await page.waitForSelector('#radio-favourites .fav-row .radio-listen');
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await audioPlaying(page);
    await page.click('#radio-favourites .fav-row .radio-listen');
    // The new stream itself plays (not just the label): the audio's source is Nova's.
    await page.waitForFunction(() => {
      const a = document.getElementById('listen-audio');
      return /%3Fnova&/.test(a.currentSrc) && !a.paused && a.currentTime > 0.2;
    }, null, { timeout: 15000 });
    assert.equal((await page.textContent('#listen-now')).trim(), 'On this device · Radio Nova');
    assert.equal((await page.textContent('#radio-mystations .radio-listen')).trim(), '🎧 Listen here');
    assert.equal((await page.textContent('#radio-favourites .radio-listen')).trim(), '■ Stop');
    assert.match(listens.at(-1).searchParams.get('url'), /\?nova$/);
  } finally {
    await close();
  }
});

test('Listen here: song titles for this tab show in the bar; other tabs\' titles are ignored (browser E2E)', async () => {
  const { page, close } = await boot({ stationsText: '[Julien]\nFIP Jazz=STATION/tone.mp3\n' });
  try {
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await page.waitForSelector('#listen-bar', { state: 'visible' });
    const lid = await page.evaluate(() => radioListen.lid);
    await page.evaluate((id) => handleEvent({ type: 'listenTitle', lid: id, title: 'Miles Davis – So What' }), lid);
    assert.equal((await page.textContent('#listen-now')).trim(), 'On this device · FIP Jazz — Miles Davis – So What');
    await page.evaluate(() => handleEvent({ type: 'listenTitle', lid: 'someoneelse', title: 'Other song' }));
    assert.equal((await page.textContent('#listen-now')).trim(), 'On this device · FIP Jazz — Miles Davis – So What');
    // The receiver's own "Now playing" strip is untouched.
    assert.equal(await page.isVisible('#radio-now'), false);
  } finally {
    await close();
  }
});

test('Listen here: a stream that cannot play says so in the bar (browser E2E)', async () => {
  const { page, close } = await boot({ stationsText: '[Julien]\nDead FM=STATION/gone.mp3\n' });
  try {
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await page.waitForFunction(() => /Could not play “Dead FM” on this device/.test(document.getElementById('listen-now').textContent));
    assert.equal(await page.isVisible('#listen-stop'), true, 'the bar can still be closed');
    assert.equal((await page.textContent('#radio-mystations .radio-listen')).trim(), '🎧 Listen here');
  } finally {
    await close();
  }
});

test('phone width: My Stations rows keep the name readable with Play, Listen here and ×; the bar fits (browser E2E)', async () => {
  const { page, close } = await boot({ stationsText: '[Julien]\nBig R Radio - 80s Metal FM=STATION/tone.mp3\n', width: 360 });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine .radio-listen');
    const row = await page.$eval('#radio-mystations .radio-mine', (el) => {
      const r = el.getBoundingClientRect();
      const meta = el.querySelector('.radio-meta').getBoundingClientRect();
      const overlaps = [...el.querySelectorAll('button')].some((b) => {
        const q = b.getBoundingClientRect();
        return q.left < meta.right && q.right > meta.left && q.top < meta.bottom && q.bottom > meta.top;
      });
      return { metaShare: meta.width / r.width, overlaps };
    });
    assert.ok(row.metaShare > 0.6, `name area too narrow: ${Math.round(row.metaShare * 100)}% of the row`);
    assert.equal(row.overlaps, false);
    await page.click('#radio-mystations .radio-mine .radio-listen');
    await page.waitForSelector('#listen-bar', { state: 'visible' });
    const bar = await page.$eval('#listen-bar', (el) => el.getBoundingClientRect().width);
    assert.ok(bar <= 360, 'the player bar fits the screen');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 360), true, 'no sideways scroll');
  } finally {
    await close();
  }
});
