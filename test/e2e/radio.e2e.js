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
async function boot({ play, playNow, stationsText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-e2e-'));
  const stationsFile = path.join(dir, 'stations.ini');
  if (stationsText) fs.writeFileSync(stationsFile, stationsText);
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({ stationsFile, category: 'Julien', search: async (q) => (q ? CANNED : []), play, playNow }));
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
    await page.evaluate(() => updateConnection('connected'));
    const buttons = await page.$$eval('#radio-mystations .radio-mine .radio-play', (els) =>
      els.map((e) => e.textContent.trim()));
    assert.deepEqual(buttons, ['▶ Play', '▶ Play']);

    await page.click('#radio-mystations .radio-mine:nth-child(2) .radio-play');
    await page.waitForFunction(() => /Playing/.test(document.getElementById('radio-mine-status').textContent));
    assert.deepEqual(calls, [{ name: 'Exclusively Elvis Presley', category: 'Julien' }]);

    // Clicking the row itself (not just the button) plays it too.
    await page.click('#radio-mystations .radio-mine:nth-child(1) .radio-name');
    await page.waitForFunction(() => /^Playing “Big R Radio/.test(document.getElementById('radio-mine-status').textContent));
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
    await page.evaluate(() => updateConnection('connected'));
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

test('My Stations: Play is disabled with a visible reason until telnet is connected (browser E2E)', async () => {
  const { page, close } = await boot({ stationsText: TWO_STATIONS, play: async () => {} });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine');
    await page.evaluate(() => updateConnection('disconnected', '', true, true));
    assert.deepEqual(await page.$$eval('.radio-play', (els) => els.map((e) => e.disabled)), [true, true]);
    assert.match(await page.textContent('#radio-mine-status'), /Connect/);
    await page.evaluate(() => updateConnection('connected'));
    assert.deepEqual(await page.$$eval('.radio-play', (els) => els.map((e) => e.disabled)), [false, false]);
    assert.equal(await page.textContent('#radio-mine-status'), '');
  } finally {
    await close();
  }
});

test('Receiver display: repairs double-encoded text; placeholder and Now Playing rows are not tappable (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    const rows = () => page.$$eval('#receiver-display .display-line', (els) => els.map((e) => ({
      text: e.textContent.trim(), cursor: e.classList.contains('cursor'), tappable: e.classList.contains('selectable'),
    })));
    await page.evaluate(() => {
      updateInput('IRADIO');
      ['NSE0Now Playing', 'NSE1\x01Weâ\x80\x99ll Be Right Back', 'NSE2\x09BOB Hair Metal', 'NSE3', 'NSE4\x01',
        'NSE5\x01  000:03     100%', 'NSE6', 'NSE7', 'NSE8'].forEach(handleDisplay);
    });
    assert.deepEqual(await rows(), [
      { text: 'Now Playing', cursor: false, tappable: false },
      { text: 'We’ll Be Right Back', cursor: false, tappable: false },
      { text: '▶ BOB Hair Metal', cursor: true, tappable: false },
      { text: '000:03     100%', cursor: false, tappable: false },
    ]);
    await page.evaluate(() => {
      ['NSE0My Stations', 'NSE1\x08---- empty ----', 'NSE2', 'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8'].forEach(handleDisplay);
    });
    assert.deepEqual(await rows(), [
      { text: 'My Stations', cursor: false, tappable: false },
      { text: '---- empty ----', cursor: false, tappable: false },
    ]);
  } finally {
    await close();
  }
});

test('Receiver display: tappable rows are keyboard buttons (Tab + Enter) (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    await page.evaluate(() => {
      window.navToLine = (i) => { window.__navTo = i; };
      updateInput('IRADIO');
      ['NSE0Julien', 'NSE1\x09Big R Radio - 80s Metal FM', 'NSE2\x01Exclusively Elvis Presley',
        'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8'].forEach(handleDisplay);
    });
    const roles = await page.$$eval('#receiver-display .display-line.selectable', (els) =>
      els.map((e) => [e.getAttribute('role'), e.getAttribute('tabindex')]));
    assert.deepEqual(roles, [['button', '0'], ['button', '0']]);
    await page.focus('#receiver-display .display-line.selectable:nth-of-type(3)');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__navTo), 2);
  } finally {
    await close();
  }
});

test('a11y: Play buttons are named per station; status lines are announced (browser E2E)', async () => {
  const { page, close } = await boot({ stationsText: TWO_STATIONS, play: async () => {} });
  try {
    await page.waitForSelector('#radio-mystations .radio-mine');
    assert.deepEqual(await page.$$eval('.radio-play', (els) => els.map((e) => e.getAttribute('aria-label'))),
      ['Play Big R Radio - 80s Metal FM', 'Play Exclusively Elvis Presley']);
    assert.equal(await page.getAttribute('#radio-mine-status', 'role'), 'status');
  } finally {
    await close();
  }
});

test('a11y: keyboard focus stays on the same display row when the screen refreshes (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    const screen = (cursor) => ['NSE0Julien', `NSE1${cursor === 1 ? '\x09' : '\x01'}Big R`, `NSE2${cursor === 2 ? '\x09' : '\x01'}Elvis`,
      'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8'];
    await page.evaluate((lines) => { window.navToLine = () => {}; updateInput('IRADIO'); lines.forEach(handleDisplay); }, screen(1));
    await page.focus('#receiver-display .display-line.selectable:nth-of-type(3)');
    await page.evaluate((lines) => lines.forEach(handleDisplay), screen(2));
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '▶ Elvis');
  } finally {
    await close();
  }
});

test('Play now: every search result has a visible Play now button that plays it directly (browser E2E)', async () => {
  const calls = [];
  const { page, close } = await boot({ playNow: async (s) => { calls.push(s); } });
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result');
    assert.deepEqual(await page.$$eval('#radio-results .radio-playnow', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-label')])),
      [['▶ Play now', 'Play FIP Jazz now'], ['▶ Play now', 'Play Radio Nova now']]);
    await page.click('#radio-results .radio-result:nth-child(2) .radio-playnow');
    await page.waitForFunction(() => /^Playing “Radio Nova”/.test(document.getElementById('radio-status').textContent));
    assert.deepEqual(calls, [{ name: 'Radio Nova', url: 'http://cdn/nova.mp3', codec: 'AAC' }]);
  } finally {
    await close();
  }
});

test('Play now: a failure is shown in the status line (browser E2E)', async () => {
  const playNow = async () => { throw Object.assign(new Error('Receiver refused SetAVTransportURI: Illegal MIME-type (714)'), { status: 502 }); };
  const { page, close } = await boot({ playNow });
  try {
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-playnow');
    await page.click('#radio-results .radio-result:first-child .radio-playnow');
    await page.waitForFunction(() => /714/.test(document.getElementById('radio-status').textContent));
    assert.match(await page.getAttribute('#radio-status', 'class'), /error/);
  } finally {
    await close();
  }
});

test('Play now: the now-playing strip shows the station and the current song (browser E2E)', async () => {
  const { page, close } = await boot();
  try {
    assert.equal(await page.isVisible('#radio-now'), false);
    await page.evaluate(() => handleStreamTitle({ name: 'Radio Paradise', title: '' }));
    assert.equal((await page.textContent('#radio-now')).trim(), 'Now playing · Radio Paradise');
    await page.evaluate(() => handleStreamTitle({ name: 'Radio Paradise', title: 'Uche Yara – Bodyscanner' }));
    assert.equal((await page.textContent('#radio-now')).trim(), 'Now playing · Radio Paradise — Uche Yara – Bodyscanner');
  } finally {
    await close();
  }
});

test('phone width: search rows keep the station name readable; buttons never overlap it (browser E2E)', async () => {
  const { page, close } = await boot({ playNow: async () => {} });
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.fill('#radio-q', 'jazz');
    await page.click('#radio-search-btn');
    await page.waitForSelector('#radio-results .radio-result .radio-playnow');
    await page.waitForTimeout(300); // let late-added row buttons (Favourite) settle
    const rows = await page.$$eval('#radio-results .radio-result', (els) => els.map((row) => {
      const r = row.getBoundingClientRect();
      const meta = row.querySelector('.radio-meta').getBoundingClientRect();
      const overlaps = [...row.querySelectorAll('button')].some((b) => {
        const q = b.getBoundingClientRect();
        return q.left < meta.right && q.right > meta.left && q.top < meta.bottom && q.bottom > meta.top;
      });
      return { metaShare: meta.width / r.width, overlaps };
    }));
    for (const row of rows) {
      assert.ok(row.metaShare > 0.6, `name area too narrow: ${Math.round(row.metaShare * 100)}% of the row`);
      assert.equal(row.overlaps, false, 'a button overlaps the station name');
    }
  } finally {
    await close();
  }
});
