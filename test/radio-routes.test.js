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

function postPlay(base, body) {
  return fetch(`${base}/api/radio/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /play asks the receiver to play the station, defaulting to the configured category', async () => {
  const calls = [];
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', play: async (s) => { calls.push(s); } });
  try {
    const res = await postPlay(app.base, { name: 'FIP Jazz' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(calls, [{ name: 'FIP Jazz', category: 'Julien' }]);
    await postPlay(app.base, { name: 'Nova', category: 'Other' });
    assert.deepEqual(calls[1], { name: 'Nova', category: 'Other' });
  } finally {
    await app.close();
  }
});

test('POST /play without a name returns 400', async () => {
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', play: async () => {} });
  try {
    assert.equal((await postPlay(app.base, {})).status, 400);
  } finally {
    await app.close();
  }
});

test('POST /play passes through a status set by the player (e.g. 503 when telnet is down)', async () => {
  const play = async () => { throw Object.assign(new Error('Needs the telnet connection'), { status: 503 }); };
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', play });
  try {
    const res = await postPlay(app.base, { name: 'FIP Jazz' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /telnet/);
  } finally {
    await app.close();
  }
});

test('POST /play reports a navigation failure as 502 with its message', async () => {
  const play = async () => { throw new Error('"FIP Jazz" not found on the receiver'); };
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', play });
  try {
    const res = await postPlay(app.base, { name: 'FIP Jazz' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /not found/);
  } finally {
    await app.close();
  }
});

test('POST /play refuses a second request while one is still navigating (409)', async () => {
  let release;
  const play = () => new Promise((r) => { release = r; });
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien', play });
  try {
    const first = postPlay(app.base, { name: 'A' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await postPlay(app.base, { name: 'B' })).status, 409);
    release();
    assert.equal((await first).status, 200);
    // The lock is released afterwards: a new request is accepted.
    const third = postPlay(app.base, { name: 'C' });
    await new Promise((r) => setTimeout(r, 50));
    release();
    assert.equal((await third).status, 200);
  } finally {
    await app.close();
  }
});

test('POST /play returns 501 when no player is configured', async () => {
  const app = await startApp({ stationsFile: tmpFile(), category: 'Julien' });
  try {
    assert.equal((await postPlay(app.base, { name: 'FIP Jazz' })).status, 501);
  } finally {
    await app.close();
  }
});
