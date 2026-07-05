'use strict';

// Thin client for the radio-browser.info directory (the same source yTuner uses).
// https://api.radio-browser.info/ — search returns candidate internet-radio streams.

const DEFAULT_BASE = 'https://all.api.radio-browser.info';
const DEFAULT_UA = 'denon-remote/2.0 (+https://github.com/jucor/tools)';
const DEFAULT_LIMIT = 30;

// Map a raw radio-browser record to the fields our UI/stations file need.
function mapStation(raw) {
  return {
    uuid: raw.stationuuid || '',
    name: String(raw.name || '').trim(),
    url: String(raw.url_resolved || raw.url || '').trim(),
    codec: raw.codec || '',
    bitrate: raw.bitrate || 0,
    country: raw.country || raw.countrycode || '',
    favicon: raw.favicon || '',
    votes: raw.votes || 0,
  };
}

function mapStations(rawList) {
  return (Array.isArray(rawList) ? rawList : [])
    .map(mapStation)
    .filter((s) => s.name && s.url);
}

async function searchStations(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty search query');

  const {
    base = DEFAULT_BASE,
    limit = DEFAULT_LIMIT,
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_UA,
  } = opts;

  const params = new URLSearchParams({
    name: q,
    limit: String(limit),
    hidebroken: 'true',
    order: 'votes',
    reverse: 'true',
  });
  const url = `${base}/json/stations/search?${params.toString()}`;

  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`radio-browser HTTP ${res.status}`);
  return mapStations(await res.json());
}

module.exports = { mapStation, mapStations, searchStations };
