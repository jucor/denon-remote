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

// Security review (parser differential): a forged line break + "name=relay address" in a
// station's NAME must not become a second entry whose URL is a relay address.
test('a newline-forged entry in a station name does not reach the allow-list', async () => {
  const st = require('../lib/stations');
  const forged = `Foo\nEvil=${savedAddress(BASE, EVIL)}`;
  const f = files({ stations: st.addStation('[Julien]\n', 'Julien', { name: forged, url: 'http://ok.example/a.mp3' }) });
  assert.equal(await isSavedStreamUrl({ ...f, url: EVIL }), false);
  const g = files({ favourites: [{ name: forged, url: 'http://ok.example/a.mp3' }] });
  assert.equal(await isSavedStreamUrl({ ...g, url: EVIL }), false);
});

// --- Listen here: the browser plays a saved station through the relay ---
const { listenStreamUrl } = require('../lib/savedUrls');
const FIP = 'http://icecast.radiofrance.fr/fip-hifi.aac';

test('listen: a saved station\'s own URL field is listenable as is', async () => {
  const f = files({ stations: `[Julien]\nFIP=${FIP}\n` });
  assert.equal(await listenStreamUrl({ ...f, url: FIP }), FIP);
});

test('listen: a geo-blocked entry (saved as the relay address) plays its inner stream', async () => {
  const f = files({ stations: `[Julien]\nRire et Chansons=${savedAddress(BASE, NRJ)}\n` });
  assert.equal(await listenStreamUrl({ ...f, url: savedAddress(BASE, NRJ) }), NRJ);
});

test('listen: Favourites count too, direct or via the relay', async () => {
  const f = files({ favourites: [{ name: 'FIP', url: FIP }, { name: 'RC', url: savedAddress(BASE, NRJ) }] });
  assert.equal(await listenStreamUrl({ ...f, url: FIP }), FIP);
  assert.equal(await listenStreamUrl({ ...f, url: savedAddress(BASE, NRJ) }), NRJ);
});

test('listen: anything that is not exactly a saved URL field is refused (no open proxy)', async () => {
  const f = files({
    stations: `[Julien]\nFIP=${FIP}|${EVIL}\n${EVIL}=http://ok.example/a.mp3\n`,
    favourites: [{ name: `x ${EVIL}`, url: 'http://ok.example/b.mp3', favicon: EVIL }],
  });
  for (const url of [EVIL, '', undefined, FIP + '?x', savedAddress(BASE, FIP)]) {
    assert.equal(await listenStreamUrl({ ...f, url }), null, String(url));
  }
});

test('listen: a saved relay address of another base, or wrapping a relay URL, is refused', async () => {
  const other = savedAddress('http://10.0.0.9:3002', NRJ);
  const nested = savedAddress(BASE, savedAddress(BASE, NRJ));
  const f = files({ stations: `[Julien]\nA=${other}\nB=${nested}\n` });
  assert.equal(await listenStreamUrl({ ...f, url: other }), null);
  assert.equal(await listenStreamUrl({ ...f, url: nested }), null);
});
