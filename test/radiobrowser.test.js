'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapStation, mapStations, searchStations, parseSearchQuery } = require('../lib/radiobrowser');

const RAW = {
  stationuuid: 'uuid-1',
  name: '  FIP Jazz  ',
  url: 'http://old/stream',
  url_resolved: 'http://cdn/stream.mp3',
  codec: 'MP3',
  bitrate: 128,
  countrycode: 'FR',
  country: 'France',
  favicon: 'http://cdn/fav.png',
  votes: 42,
};

test('mapStation prefers url_resolved and trims the name', () => {
  assert.deepEqual(mapStation(RAW), {
    uuid: 'uuid-1',
    name: 'FIP Jazz',
    url: 'http://cdn/stream.mp3',
    codec: 'MP3',
    bitrate: 128,
    country: 'France',
    favicon: 'http://cdn/fav.png',
    votes: 42,
  });
});

test('mapStation falls back to url when url_resolved is empty', () => {
  const s = mapStation({ ...RAW, url_resolved: '' });
  assert.equal(s.url, 'http://old/stream');
});

test('mapStations drops entries with no name or no url', () => {
  const out = mapStations([
    RAW,
    { ...RAW, name: '   ', stationuuid: 'blank-name' },
    { ...RAW, url: '', url_resolved: '', stationuuid: 'no-url' },
  ]);
  assert.deepEqual(out.map((s) => s.uuid), ['uuid-1']);
});

test('searchStations calls the radio-browser search endpoint with encoded params + UA', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => [RAW] };
  };
  const out = await searchStations('fip jazz', {
    base: 'https://rb.example',
    limit: 15,
    fetchImpl,
    userAgent: 'denon-remote/test',
  });

  const u = new URL(captured.url);
  assert.equal(u.origin + u.pathname, 'https://rb.example/json/stations/search');
  assert.equal(u.searchParams.get('name'), 'fip jazz');
  assert.equal(u.searchParams.get('limit'), '15');
  assert.equal(u.searchParams.get('hidebroken'), 'true');
  assert.equal(captured.opts.headers['User-Agent'], 'denon-remote/test');
  assert.deepEqual(out.map((s) => s.name), ['FIP Jazz']);
});

test('parseSearchQuery: plain text becomes a name search', () => {
  assert.deepEqual(parseSearchQuery('fip jazz'), { name: 'fip jazz' });
});

test('parseSearchQuery: field prefixes map to radio-browser params', () => {
  assert.deepEqual(parseSearchQuery('tag:jazz'), { tag: 'jazz' });
  assert.deepEqual(parseSearchQuery('country:France'), { country: 'France' });
  assert.deepEqual(parseSearchQuery('cc:fr'), { countrycode: 'fr' });
  assert.deepEqual(parseSearchQuery('lang:french'), { language: 'french' });
  assert.deepEqual(parseSearchQuery('codec:mp3'), { codec: 'mp3' });
});

test('parseSearchQuery: unprefixed words accumulate into name alongside fields', () => {
  assert.deepEqual(parseSearchQuery('radio nova cc:fr'), { name: 'radio nova', countrycode: 'fr' });
  assert.deepEqual(parseSearchQuery('name:fip tag:jazz'), { name: 'fip', tag: 'jazz' });
});

test('parseSearchQuery: an empty/whitespace query yields no fields', () => {
  assert.deepEqual(parseSearchQuery('   '), {});
});

test('searchStations sends the parsed field param (tag) instead of name', async () => {
  let captured;
  const fetchImpl = async (url) => { captured = url; return { ok: true, json: async () => [] }; };
  await searchStations('tag:jazz', { base: 'https://rb.example', fetchImpl });
  const u = new URL(captured);
  assert.equal(u.searchParams.get('tag'), 'jazz');
  assert.equal(u.searchParams.get('name'), null);
});

test('searchStations rejects a blank query', async () => {
  await assert.rejects(() => searchStations('   ', { fetchImpl: async () => ({}) }), /query/i);
});

test('searchStations throws on a non-ok HTTP response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => searchStations('jazz', { fetchImpl }), /503/);
});
