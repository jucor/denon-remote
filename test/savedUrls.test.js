'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSavedStreamUrl, isRelayUrl, savedAddress } = require('../lib/savedUrls');
const bookmarks = require('../lib/bookmarks');

const BASE = 'http://192.168.1.61:3002';
const NRJ = 'https://streaming.nrjaudio.fm/ou8o8xgk7oiu?origine=fluxradios';
const EVIL = 'http://example.com/anything';

function files({ stations = '', favourites = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-'));
  const stationsFile = path.join(dir, 'stations.ini');
  const bookmarksFile = path.join(dir, 'bookmark.xml');
  fs.writeFileSync(stationsFile, stations);
  if (favourites.length) fs.writeFileSync(bookmarksFile, bookmarks.serialise(favourites.map((f) => bookmarks.buildItem(f))));
  return { stationsFile, bookmarksFile, relayBase: BASE };
}

test('a stream URL is saved when a station entry\'s URL is exactly its relay address', async () => {
  const f = files({ stations: `[Julien]\nRire et Chansons=${savedAddress(BASE, NRJ)}\n` });
  assert.equal(await isSavedStreamUrl({ ...f, url: NRJ }), true);
  assert.equal(await isSavedStreamUrl({ ...f, url: EVIL }), false);
});

test('a Favourite whose StationUrl is the relay address counts too', async () => {
  const f = files({ favourites: [{ name: 'Rire et Chansons', url: savedAddress(BASE, NRJ) }] });
  assert.equal(await isSavedStreamUrl({ ...f, url: NRJ }), true);
});

// Security review: the old check looked for the text ANYWHERE in the files, so a logo or name
// containing it whitelisted any URL.
test('the relay address appearing in a logo or a name does not count', async () => {
  const sneaky = savedAddress(BASE, EVIL);
  const f = files({
    stations: `[Julien]\nFIP=http://icecast.radiofrance.fr/fip.aac|${sneaky}\n${sneaky}=http://icecast.radiofrance.fr/x.mp3\n`,
    favourites: [{ name: `x ${sneaky}`, url: 'http://icecast.radiofrance.fr/fip.aac', favicon: sneaky }],
  });
  assert.equal(await isSavedStreamUrl({ ...f, url: EVIL }), false);
});

test('missing files mean nothing is saved', async () => {
  assert.equal(await isSavedStreamUrl({ stationsFile: '/nonexistent/s.ini', bookmarksFile: '/nonexistent/b.xml', relayBase: BASE, url: NRJ }), false);
});

test('isRelayUrl catches the relay path in any case or encoding', () => {
  for (const u of [
    'http://nas:3002/api/radio/stream/u?url=x', 'http://nas:3002/API/Radio/Stream/u?url=x',
    'http://nas:3002/api/radio/%73tream/u?url=x', 'http://nas:3002/api%2Fradio%2Fstream/u',
    'http://nas:3002/api/radio/stream/abc123',
  ]) assert.equal(isRelayUrl(u), true, u);
  assert.equal(isRelayUrl(NRJ), false);
});
