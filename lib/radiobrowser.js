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

// Map "prefix:" tokens to radio-browser search params. Unprefixed words fall
// back to a name search. Prefix values are single words (no spaces).
const FIELD_PREFIXES = {
  name: 'name',
  tag: 'tag',
  country: 'country',
  cc: 'countrycode',
  lang: 'language',
  codec: 'codec',
};

function parseSearchQuery(query) {
  const fields = {};
  const nameWords = [];
  for (const token of String(query || '').trim().split(/\s+/)) {
    if (!token) continue;
    const m = token.match(/^([a-z]+):(.+)$/i);
    const param = m && FIELD_PREFIXES[m[1].toLowerCase()];
    if (param && param !== 'name') {
      fields[param] = m[2];
    } else if (param === 'name') {
      nameWords.push(m[2]);
    } else {
      nameWords.push(token);
    }
  }
  if (nameWords.length) fields.name = nameWords.join(' ');
  return fields;
}

async function searchStations(query, opts = {}) {
  if (!String(query || '').trim()) throw new Error('Empty search query');

  const {
    base = DEFAULT_BASE,
    limit = DEFAULT_LIMIT,
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_UA,
  } = opts;

  const params = new URLSearchParams({
    limit: String(limit),
    hidebroken: 'true',
    order: 'votes',
    reverse: 'true',
  });
  for (const [k, v] of Object.entries(parseSearchQuery(query))) {
    if (v) params.set(k, v);
  }
  const url = `${base}/json/stations/search?${params.toString()}`;

  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`radio-browser HTTP ${res.status}`);
  return mapStations(await res.json());
}

module.exports = { mapStation, mapStations, searchStations, parseSearchQuery };
