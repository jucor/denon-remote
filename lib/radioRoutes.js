'use strict';

// REST router for internet-radio keyword search + yTuner MyStations management.
// Injectable deps make it testable without booting the full server:
//   stationsFile — path to yTuner's stations.ini
//   category     — INI category new stations are filed under (e.g. "Julien")
//   search       — async (query) => station[]  (defaults to radio-browser.info)

const express = require('express');
const { searchStations } = require('./radiobrowser');
const {
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
} = require('./stations');

function createRadioRouter({ stationsFile, category, search } = {}) {
  if (!stationsFile) throw new Error('createRadioRouter requires stationsFile');
  const cat = category || 'Julien';
  const doSearch = search || ((q) => searchStations(q));

  const router = express.Router();

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

  return router;
}

module.exports = { createRadioRouter };
