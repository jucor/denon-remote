'use strict';

// REST router for internet-radio keyword search + yTuner MyStations management.
// Injectable deps make it testable without booting the full server:
//   stationsFile — path to yTuner's stations.ini
//   bookmarksFile — path to yTuner's bookmark.xml (the receiver's "Favourites"); without it
//                  the /favourites endpoints answer 501. bookmarksLimit overrides the 100 cap.
//   category     — INI category new stations are filed under (e.g. "Julien")
//   search       — async (query) => station[]  (defaults to radio-browser.info)
//   play         — async ({ name, category }) => void; plays a My Stations entry on the
//                  receiver. Throw an Error with .status to choose the HTTP status.

const express = require('express');
const { searchStations } = require('./radiobrowser');
const {
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
} = require('./stations');
const bookmarks = require('./bookmarks');

function createRadioRouter({ stationsFile, bookmarksFile, bookmarksLimit, category, search, play } = {}) {
  if (!stationsFile) throw new Error('createRadioRouter requires stationsFile');
  const cat = category || 'Julien';
  const doSearch = search || ((q) => searchStations(q));
  let playing = false; // one menu navigation at a time: two would interleave key presses

  const router = express.Router();

  router.post('/play', async (req, res) => {
    const { name, category: stationCat } = req.body || {};
    const validText = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 300;
    if (!validText(name)) return res.status(400).json({ error: 'name must be a non-empty string' });
    if (stationCat !== undefined && !validText(stationCat)) {
      return res.status(400).json({ error: 'category must be a non-empty string' });
    }
    if (!play) return res.status(501).json({ error: 'Playing stations is not available' });
    if (playing) return res.status(409).json({ error: 'Already selecting a station — try again in a moment' });
    playing = true;
    try {
      await play({ name, category: stationCat || cat });
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    } finally {
      playing = false;
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

  router.get('/mystations', (_req, res) => {
    try {
      res.json({ stations: listStationsFromFile(stationsFile) });
    } catch (err) {
      res.status(500).json({ error: `Could not read stations: ${err.message}` });
    }
  });

  router.post('/add', async (req, res) => {
    const { name, url, logo } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    try {
      const stations = await addStationToFile(stationsFile, cat, { name, url, logo });
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
      const { id, added, items } = await bookmarks.add(bookmarksFile, req.body || {}, { limit: bookmarksLimit });
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
