'use strict';

// REST router for internet-radio keyword search + yTuner MyStations management.
// Injectable deps make it testable without booting the full server:
//   stationsFile — path to yTuner's stations.ini
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
const { searchStations, listTags, listCountries } = require('./radiobrowser');
const {
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
} = require('./stations');

function createRadioRouter({
  stationsFile, category, search, play, playNow, listTags: tags, listCountries: countries,
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

  return router;
}

module.exports = { createRadioRouter };
