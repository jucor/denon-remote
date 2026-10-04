'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  listTags,
  listCountries,
  mapTags,
  mapCountries,
  clearBrowseCache,
  parseSearchQuery,
} = require('../lib/radiobrowser');

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => clearBrowseCache());

function fakeFetch(payload, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => payload };
  };
}

test('mapTags maps to {name, stationcount}, trims, and drops empty or junk names', () => {
  const out = mapTags([
    { name: 'jazz', stationcount: 2345 },
    { name: '  smooth jazz ', stationcount: 10 },
    { name: '', stationcount: 99 },
    { name: '   ', stationcount: 99 },
    { name: '!!!', stationcount: 99 },
    { name: 'http://spam.example/x', stationcount: 99 },
    { name: 'a,b,c', stationcount: 99 },
    { name: 'x'.repeat(80), stationcount: 99 },
    { stationcount: 5 },
    { name: 'dead', stationcount: 0 },
  ]);
  assert.deepEqual(out, [
    { name: 'jazz', stationcount: 2345 },
    { name: 'smooth jazz', stationcount: 10 },
  ]);
});

test('mapTags merges case-insensitive duplicates, keeping the larger entry first', () => {
  const out = mapTags([
    { name: 'Rock', stationcount: 5 },
    { name: 'rock', stationcount: 50 },
  ]);
  assert.deepEqual(out, [{ name: 'rock', stationcount: 55 }]);
});

test('mapTags tolerates a non-array payload', () => {
  assert.deepEqual(mapTags(null), []);
  assert.deepEqual(mapTags({}), []);
});

test('mapCountries maps name, upper-cased 2-letter code, count; drops junk; sorts by count', () => {
  const out = mapCountries([
    { name: 'France', iso_3166_1: 'fr', stationcount: 1500 },
    { name: 'The United States Of America', iso_3166_1: 'US', stationcount: 4000 },
    { name: 'Nowhere', iso_3166_1: '', stationcount: 3 },
    { name: '', iso_3166_1: 'XX', stationcount: 3 },
    { name: ' ', iso_3166_1: 'YY', stationcount: 3 },
    { name: 'Weird', iso_3166_1: 'ZZZ', stationcount: 7 },
    { name: 'Empty', iso_3166_1: 'EE', stationcount: 0 },
  ]);
  assert.deepEqual(out, [
    { name: 'The United States Of America', code: 'US', stationcount: 4000 },
    { name: 'France', code: 'FR', stationcount: 1500 },
    { name: 'Weird', stationcount: 7 },
    { name: 'Nowhere', stationcount: 3 },
  ]);
});

test('listTags calls /json/tags with the documented params and the User-Agent', async () => {
  const calls = [];
  const out = await listTags({
    base: 'https://rb.example',
    limit: 50,
    userAgent: 'denon-remote/test',
    fetchImpl: fakeFetch([{ name: 'jazz', stationcount: 3 }], calls),
  });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://rb.example/json/tags');
  assert.equal(u.searchParams.get('order'), 'stationcount');
  assert.equal(u.searchParams.get('reverse'), 'true');
  assert.equal(u.searchParams.get('hidebroken'), 'true');
  assert.equal(u.searchParams.get('limit'), '50');
  assert.equal(calls[0].opts.headers['User-Agent'], 'denon-remote/test');
  assert.deepEqual(out, [{ name: 'jazz', stationcount: 3 }]);
});

test('listCountries calls /json/countries with the documented params', async () => {
  const calls = [];
  const out = await listCountries({
    base: 'https://rb.example',
    fetchImpl: fakeFetch([{ name: 'France', iso_3166_1: 'FR', stationcount: 9 }], calls),
  });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://rb.example/json/countries');
  assert.equal(u.searchParams.get('order'), 'stationcount');
  assert.equal(u.searchParams.get('reverse'), 'true');
  assert.equal(u.searchParams.get('hidebroken'), 'true');
  assert.deepEqual(out, [{ name: 'France', code: 'FR', stationcount: 9 }]);
});

test('listTags and listCountries throw on an upstream HTTP error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(listTags({ fetchImpl }), /HTTP 503/);
  await assert.rejects(listCountries({ fetchImpl }), /HTTP 503/);
});

test('results are cached in memory for 24 hours, then refetched', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ name: 'jazz', stationcount: 3 }], calls);
  let t = 1_000_000;
  const now = () => t;
  await listTags({ fetchImpl, now });
  await listTags({ fetchImpl, now });
  assert.equal(calls.length, 1);
  t += DAY - 1;
  await listTags({ fetchImpl, now });
  assert.equal(calls.length, 1, 'still fresh just under 24 h');
  t += 2;
  await listTags({ fetchImpl, now });
  assert.equal(calls.length, 2, 'refetched after 24 h');
});

test('tags and countries are cached independently', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([], calls);
  await listTags({ fetchImpl });
  await listCountries({ fetchImpl });
  await listCountries({ fetchImpl });
  assert.equal(calls.length, 2);
});

test('a failed fetch is not cached', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => [{ name: 'jazz', stationcount: 3 }] };
  };
  await assert.rejects(listTags({ fetchImpl }));
  const out = await listTags({ fetchImpl });
  assert.equal(out.length, 1);
});

test('concurrent calls share a single upstream request', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ name: 'jazz', stationcount: 3 }], calls);
  await Promise.all([listTags({ fetchImpl }), listTags({ fetchImpl })]);
  assert.equal(calls.length, 1);
});

// Multi-word tags: parseSearchQuery splits on whitespace, so a space inside a value
// must be escaped with a backslash ("tag:smooth\ jazz") to stay one value.
test('parseSearchQuery: a backslash-escaped space keeps a multi-word value together', () => {
  assert.deepEqual(parseSearchQuery('tag:smooth\\ jazz'), { tag: 'smooth jazz' });
  assert.deepEqual(parseSearchQuery('tag:classic\\ rock cc:gb'), { tag: 'classic rock', countrycode: 'gb' });
  assert.deepEqual(parseSearchQuery('country:United\\ Kingdom'), { country: 'United Kingdom' });
});

test('parseSearchQuery: unescaped queries keep behaving as before', () => {
  assert.deepEqual(parseSearchQuery('tag:smooth jazz'), { tag: 'smooth', name: 'jazz' });
});
