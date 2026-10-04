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
// back to a name search. Prefix values are single words; a value that needs a space
// (a multi-word tag such as "smooth jazz") escapes it with a backslash:
// "tag:smooth\ jazz".
const FIELD_PREFIXES = {
  name: 'name',
  tag: 'tag',
  country: 'country',
  cc: 'countrycode',
  lang: 'language',
  codec: 'codec',
};

function unescapeSpaces(v) {
  return v.replace(/\\(\s)/g, '$1');
}

function parseSearchQuery(query) {
  const fields = {};
  const nameWords = [];
  // Split on whitespace NOT preceded by a backslash, then unescape "\ " in values.
  for (const token of String(query || '').trim().split(/(?<!\\)\s+/)) {
    if (!token) continue;
    const m = token.match(/^([a-z]+):(.+)$/i);
    const param = m && FIELD_PREFIXES[m[1].toLowerCase()];
    if (param && param !== 'name') {
      fields[param] = unescapeSpaces(m[2]);
    } else if (param === 'name') {
      nameWords.push(unescapeSpaces(m[2]));
    } else {
      nameWords.push(unescapeSpaces(token));
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

// --- Browse lists (genres / countries) ---------------------------------------------

const BROWSE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TAG_LIMIT = 100;
const MAX_TAG_LENGTH = 40;

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// radio-browser tags are free text typed by station owners: drop empties, URLs, lists
// crammed into one tag, over-long strings and anything with no letter or digit at all.
function isJunkTag(name) {
  return (
    !name ||
    name.length > MAX_TAG_LENGTH ||
    !/[\p{L}\p{N}]/u.test(name) ||
    /https?:|www\./i.test(name) ||
    /[,;|\\]/.test(name)
  );
}

function mapTags(rawList) {
  const byName = new Map(); // lower-cased name -> entry (merges "Rock" / "rock")
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const name = String((raw && raw.name) || '').trim();
    const stationcount = toCount(raw && raw.stationcount);
    if (isJunkTag(name) || !stationcount) continue;
    const key = name.toLowerCase();
    const prev = byName.get(key);
    if (!prev) byName.set(key, { name, stationcount });
    else {
      if (stationcount > prev.stationcount) prev.name = name;
      prev.stationcount += stationcount;
    }
  }
  return [...byName.values()].sort((a, b) => b.stationcount - a.stationcount);
}

function mapCountries(rawList) {
  const out = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const name = String((raw && raw.name) || '').trim();
    const stationcount = toCount(raw && raw.stationcount);
    if (!name || !stationcount) continue;
    const code = String((raw && raw.iso_3166_1) || '').trim().toUpperCase();
    const entry = { name };
    if (/^[A-Z]{2}$/.test(code)) entry.code = code;
    entry.stationcount = stationcount;
    out.push(entry);
  }
  return out.sort((a, b) => b.stationcount - a.stationcount);
}

// In-memory cache, 24 h. Concurrent callers share one in-flight request; failures are
// never cached (the next call retries).
const browseCache = new Map(); // key -> { at, value } | { promise }

function clearBrowseCache() {
  browseCache.clear();
}

async function cachedBrowse(key, now, load) {
  const hit = browseCache.get(key);
  if (hit && hit.promise) return hit.promise;
  if (hit && now() - hit.at < BROWSE_TTL_MS) return hit.value;
  const promise = load().then(
    (value) => {
      browseCache.set(key, { at: now(), value });
      return value;
    },
    (err) => {
      browseCache.delete(key);
      throw err;
    }
  );
  browseCache.set(key, { promise });
  return promise;
}

async function fetchBrowseJson(path, params, { base, fetchImpl, userAgent }) {
  const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`radio-browser HTTP ${res.status}`);
  return res.json();
}

async function listTags(opts = {}) {
  const {
    base = DEFAULT_BASE,
    limit = DEFAULT_TAG_LIMIT,
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_UA,
    now = Date.now,
  } = opts;
  return cachedBrowse(`${base}|tags|${limit}`, now, async () =>
    mapTags(
      await fetchBrowseJson(
        '/json/tags',
        { order: 'stationcount', reverse: 'true', hidebroken: 'true', limit: String(limit) },
        { base, fetchImpl, userAgent }
      )
    )
  );
}

async function listCountries(opts = {}) {
  const {
    base = DEFAULT_BASE,
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_UA,
    now = Date.now,
  } = opts;
  return cachedBrowse(`${base}|countries`, now, async () =>
    mapCountries(
      await fetchBrowseJson(
        '/json/countries',
        { order: 'stationcount', reverse: 'true', hidebroken: 'true' },
        { base, fetchImpl, userAgent }
      )
    )
  );
}

module.exports = {
  mapStation,
  mapStations,
  searchStations,
  parseSearchQuery,
  mapTags,
  mapCountries,
  listTags,
  listCountries,
  clearBrowseCache,
};
