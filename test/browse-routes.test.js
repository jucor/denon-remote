'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createRadioRouter } = require('../lib/radioRoutes');

async function startApp(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-routes-'));
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioRouter({ stationsFile: path.join(dir, 's.ini'), ...opts }));
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

const TAGS = [{ name: 'jazz', stationcount: 2345 }];
const COUNTRIES = [{ name: 'France', code: 'FR', stationcount: 1500 }];

test('GET /tags returns the injected listTags result', async () => {
  const app = await startApp({ listTags: async () => TAGS });
  try {
    const res = await fetch(`${app.base}/api/radio/tags`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { tags: TAGS });
  } finally {
    await app.close();
  }
});

test('GET /countries returns the injected listCountries result', async () => {
  const app = await startApp({ listCountries: async () => COUNTRIES });
  try {
    const res = await fetch(`${app.base}/api/radio/countries`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { countries: COUNTRIES });
  } finally {
    await app.close();
  }
});

test('GET /tags and /countries return 502 with an error message on upstream failure', async () => {
  const app = await startApp({
    listTags: async () => { throw new Error('tags down'); },
    listCountries: async () => { throw new Error('countries down'); },
  });
  try {
    const t = await fetch(`${app.base}/api/radio/tags`);
    assert.equal(t.status, 502);
    assert.match((await t.json()).error, /tags down/);
    const c = await fetch(`${app.base}/api/radio/countries`);
    assert.equal(c.status, 502);
    assert.match((await c.json()).error, /countries down/);
  } finally {
    await app.close();
  }
});
