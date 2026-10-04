'use strict';

// REST router for internet-radio keyword search + yTuner MyStations management.
// Injectable deps make it testable without booting the full server:
//   stationsFile — path to yTuner's stations.ini
//   bookmarksFile — path to yTuner's bookmark.xml (the receiver's "Favourites"); without it
//                  the /favourites endpoints answer 501. bookmarksLimit overrides the 100 cap.
//   category     — INI category new stations are filed under (e.g. "Julien")
//   search       — async (query) => station[]  (defaults to radio-browser.info)
//   listTags / listCountries — async () => [{name, code?, stationcount}] for the browse
//                  chips (default to radio-browser.info, cached 24 h)
//   play         — async ({ name, category, path? }) => void; plays an entry of the
//                  receiver's iRadio menu (My Stations by default, or `path`, e.g.
//                  ["Favourites"]). Throw an Error with .status to choose the HTTP status.
//   playNow      — async ({ name, url, codec }) => void; plays a stream URL directly
//                  (UPnP + relay), no menu involved.

const express = require('express');
const { isRelayUrl } = require('./savedUrls');
const { searchStations, listTags, listCountries } = require('./radiobrowser');
const {
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
} = require('./stations');
const bookmarks = require('./bookmarks');

function createRadioRouter({
  stationsFile, bookmarksFile, bookmarksLimit, category, search, play, playNow,
  listTags: tags, listCountries: countries,
  prepareUrl = async (u) => u, // address to save for a station (the relay's when geo-blocked)
} = {}) {
  if (!stationsFile) throw new Error('createRadioRouter requires stationsFile');
  const cat = category || 'Julien';
  const doSearch = search || ((q) => searchStations(q));
  const doListTags = tags || (() => listTags());
  const doListCountries = countries || (() => listCountries());
  let playing = false; // one menu navigation at a time: two would interleave key presses

  const router = express.Router();

  const validText = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 300;

  router.post('/play', async (req, res) => {
    const { name, category: stationCat, path } = req.body || {};
    if (!validText(name)) return res.status(400).json({ error: 'name must be a non-empty string' });
    if (stationCat !== undefined && !validText(stationCat)) {
      return res.status(400).json({ error: 'category must be a non-empty string' });
    }
    if (path !== undefined && !(Array.isArray(path) && path.length >= 1 && path.length <= 5 && path.every(validText))) {
      return res.status(400).json({ error: 'path must be a list of menu entries' });
    }
    if (!play) return res.status(501).json({ error: 'Playing stations is not available' });
    if (playing) return res.status(409).json({ error: 'Already selecting a station — try again in a moment' });
    playing = true;
    try {
      await play({ name, category: stationCat || cat, ...(path ? { path } : {}) });
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    } finally {
      playing = false;
    }
  });

  router.post('/playnow', async (req, res) => {
    const { name, url, codec } = req.body || {};
    if (!validText(name)) return res.status(400).json({ error: 'name must be a non-empty string' });
    if (!(typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) && url.length <= 2000)) {
      return res.status(400).json({ error: 'url must be an http(s) URL' });
    }
    if (!playNow) return res.status(501).json({ error: 'Play now is not configured on this server' });
    try {
      await playNow({ name, url, codec: typeof codec === 'string' ? codec : '' });
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing search query' });
    try {
      const stations = await doSearch(q);
      res.json({ stations });
    } catch (err) {
      res.status(502).json({ error: `Search failed: ${err.message}` });
    }
  });

  // Browse lists for the genre / country chips (cached 24 h inside radiobrowser.js).
  router.get('/tags', async (_req, res) => {
    try {
      res.json({ tags: await doListTags() });
    } catch (err) {
      res.status(502).json({ error: `Could not load genres: ${err.message}` });
    }
  });

  router.get('/countries', async (_req, res) => {
    try {
      res.json({ countries: await doListCountries() });
    } catch (err) {
      res.status(502).json({ error: `Could not load countries: ${err.message}` });
    }
  });

  router.get('/mystations', (_req, res) => {
    try {
      res.json({ stations: listStationsFromFile(stationsFile) });
    } catch (err) {
      res.status(500).json({ error: `Could not read stations: ${err.message}` });
    }
  });

  // A station URL may not point at our own relay: that would launder arbitrary URLs into the
  // saved-station allow-list (security review). Geo-blocked ones get it via prepareUrl only.

  router.post('/add', async (req, res) => {
    const { name, url, logo } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    if (isRelayUrl(url)) return res.status(400).json({ error: 'url must be the station’s own stream URL' });
    try {
      const stations = await addStationToFile(stationsFile, cat, { name, url: await prepareUrl(url), logo });
      res.json({ stations });
    } catch (err) {
      res.status(500).json({ error: `Could not add station: ${err.message}` });
    }
  });

  router.delete('/remove', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    try {
      const stations = await removeStationFromFile(stationsFile, { name, url });
      res.json({ stations });
    } catch (err) {
      res.status(500).json({ error: `Could not remove station: ${err.message}` });
    }
  });

  // --- Favourites: yTuner's bookmark.xml, which the receiver shows as "Favourites" ---
  const needFavourites = (_req, res, next) =>
    bookmarksFile ? next() : res.status(501).json({ error: 'Favourites are not available' });
  const favError = (res, err, what) =>
    res.status(err.status || 500).json({ error: err.status ? err.message : `Could not ${what} favourites: ${err.message}` });

  router.get('/favourites', needFavourites, (_req, res) => {
    try {
      res.json({ favourites: bookmarks.list(bookmarksFile) });
    } catch (err) {
      favError(res, err, 'read');
    }
  });

  router.post('/favourites', needFavourites, async (req, res) => {
    try {
      const station = { ...(req.body || {}) };
      if (isRelayUrl(station.url)) return res.status(400).json({ error: 'url must be the station’s own stream URL' });
      if (typeof station.url === 'string') station.url = await prepareUrl(station.url);
      const { id, added, items } = await bookmarks.add(bookmarksFile, station, { limit: bookmarksLimit });
      res.json({ id, added, favourites: items });
    } catch (err) {
      favError(res, err, 'update');
    }
  });

  router.delete('/favourites/:id', needFavourites, async (req, res) => {
    try {
      res.json({ favourites: await bookmarks.remove(bookmarksFile, req.params.id) });
    } catch (err) {
      favError(res, err, 'update');
    }
  });

  return router;
}

module.exports = { createRadioRouter };
