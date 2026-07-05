'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createRadioRouter } = require('../lib/radioRoutes');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-routes-'));
  return path.join(dir, 'stations.ini');
}

// Boot a throwaway express app mounting only the radio router.
async function startApp(opts) {
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter(opts));
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

const SAMPLE = { uuid: 'u1', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', codec: 'MP3', bitrate: 128, country: 'France', favicon: '', votes: 9 };

test('GET /search proxies the injected search and returns stations', async () => {
  let seen;
  const app = await startApp({
    stationsFile: tmpFile(),
    category: 'Julien',
    search: async (q) => { seen = q; return [SAMPLE]; },
  });
  try {
    const res = await fetch(`${app.base}/api/radio/search?q=${encodeURIComponent('fip jazz')}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen, 'fip jazz');
    assert.deepEqual(body.stations, [SAMPLE]);
  } finally {
    await app.close();
  }
});

test('GET /search with a blank query returns 400', async () => {
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', search: async () => [] });
  try {
    const res = await fetch(`${app.base}/api/radio/search?q=`);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /search returns 502 when the search backend fails', async () => {
  const app = await startApp({
    stationsFile: tmpFile(),
    category: 'Julien',
    search: async () => { throw new Error('backend down'); },
  });
  try {
    const res = await fetch(`${app.base}/api/radio/search?q=jazz`);
    assert.equal(res.status, 502);
  } finally {
    await app.close();
  }
});

test('POST /add writes the station under the configured category and lists it', async () => {
  const file = tmpFile();
  const app = await startApp({ stationsFile: file, category: 'Julien', search: async () => [] });
  try {
    const res = await fetch(`${app.base}/api/radio/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', logo: 'http://cdn/f.png' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.stations, [
      { category: 'Julien', name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', logo: 'http://cdn/f.png' },
    ]);
    assert.match(fs.readFileSync(file, 'utf8'), /\[Julien\]/);
  } finally {
    await app.close();
  }
});

test('POST /add rejects a missing url with 400', async () => {
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', search: async () => [] });
  try {
    const res = await fetch(`${app.base}/api/radio/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No URL' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /mystations reflects what was added, DELETE /remove takes it away', async () => {
  const file = tmpFile();
  const app = await startApp({ stationsFile: file, category: 'Julien', search: async () => [] });
  try {
    await fetch(`${app.base}/api/radio/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FIP Jazz', url: 'http://cdn/jazz.mp3' }),
    });
    let res = await fetch(`${app.base}/api/radio/mystations`);
    assert.deepEqual((await res.json()).stations.map((s) => s.name), ['FIP Jazz']);

    res = await fetch(`${app.base}/api/radio/remove`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FIP Jazz', url: 'http://cdn/jazz.mp3' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).stations, []);
  } finally {
    await app.close();
  }
});
