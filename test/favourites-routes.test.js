'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createRadioRouter } = require('../lib/radioRoutes');
const bookmarks = require('../lib/bookmarks');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fav-routes-'));
}

async function startApp(opts) {
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter(opts));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/api/radio`, close: () => new Promise((r) => srv.close(r)) };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const FIP = { name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', uuid: '960e57c5-0601-11e8-ae97-52543be04c81', favicon: '' };

async function boot() {
  const dir = tmpDir();
  const bookmarksFile = path.join(dir, 'bookmark.xml');
  const app = await startApp({ stationsFile: path.join(dir, 'stations.ini'), bookmarksFile });
  return { ...app, bookmarksFile };
}

test('GET /favourites returns an empty list when there is no bookmark file', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/favourites`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { favourites: [] });
  } finally { await app.close(); }
});

test('POST /favourites adds, GET lists, DELETE removes (file deleted when empty)', async () => {
  const app = await boot();
  try {
    const res = await post(`${app.base}/favourites`, FIP);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.added, true);
    assert.equal(body.id, 'RBB960E57C50601');
    assert.deepEqual(body.favourites, [{ id: 'RBB960E57C50601', name: 'FIP Jazz', logo: '' }]);
    assert.equal(fs.existsSync(app.bookmarksFile), true);

    const list = await (await fetch(`${app.base}/favourites`)).json();
    assert.deepEqual(list.favourites.map((f) => f.name), ['FIP Jazz']);

    const del = await fetch(`${app.base}/favourites/RBB960E57C50601`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { favourites: [] });
    assert.equal(fs.existsSync(app.bookmarksFile), false);
  } finally { await app.close(); }
});

test('POST /favourites twice reports added:false the second time', async () => {
  const app = await boot();
  try {
    await post(`${app.base}/favourites`, FIP);
    const body = await (await post(`${app.base}/favourites`, FIP)).json();
    assert.equal(body.added, false);
    assert.equal(body.favourites.length, 1);
  } finally { await app.close(); }
});

test('POST /favourites validates input (400) and reports a full list (409)', async () => {
  const dir = tmpDir();
  const bookmarksFile = path.join(dir, 'bookmark.xml');
  const app = await startApp({ stationsFile: path.join(dir, 'stations.ini'), bookmarksFile, bookmarksLimit: 1 });
  try {
    assert.equal((await post(`${app.base}/favourites`, { name: 'x' })).status, 400);
    assert.equal((await post(`${app.base}/favourites`, { url: 'http://x' })).status, 400);
    assert.equal((await post(`${app.base}/favourites`, { name: 'x', url: 'ftp://x' })).status, 400);
    assert.equal((await post(`${app.base}/favourites`, { name: 'A', url: 'http://x/a' })).status, 200);
    const full = await post(`${app.base}/favourites`, { name: 'B', url: 'http://x/b' });
    assert.equal(full.status, 409);
    assert.match((await full.json()).error, /full|limit/i);
  } finally { await app.close(); }
});

test('DELETE /favourites/:id of an unknown id is 404', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/favourites/MSBNOPE`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  } finally { await app.close(); }
});

test('GET /favourites lists what yTuner itself wrote', async () => {
  const app = await boot();
  try {
    await bookmarks.add(app.bookmarksFile, { name: 'Elvis', url: 'http://elvis/ice' });
    const { favourites } = await (await fetch(`${app.base}/favourites`)).json();
    assert.deepEqual(favourites.map((f) => f.name), ['Elvis']);
  } finally { await app.close(); }
});

test('a corrupt bookmark file gives 500 with a message, and is not overwritten', async () => {
  const app = await boot();
  try {
    fs.writeFileSync(app.bookmarksFile, '<html>oops</html>');
    const get = await fetch(`${app.base}/favourites`);
    assert.equal(get.status, 500);
    assert.match((await get.json()).error, /bookmark/i);
    assert.equal((await post(`${app.base}/favourites`, FIP)).status, 500);
    assert.equal(fs.readFileSync(app.bookmarksFile, 'utf8'), '<html>oops</html>');
  } finally { await app.close(); }
});

test('without bookmarksFile the favourites endpoints answer 501, other routes unaffected', async () => {
  const dir = tmpDir();
  const app = await startApp({ stationsFile: path.join(dir, 'stations.ini') });
  try {
    assert.equal((await fetch(`${app.base}/favourites`)).status, 501);
    assert.equal((await post(`${app.base}/favourites`, FIP)).status, 501);
    assert.equal((await fetch(`${app.base}/favourites/x`, { method: 'DELETE' })).status, 501);
    assert.equal((await fetch(`${app.base}/mystations`)).status, 200);
  } finally { await app.close(); }
});
