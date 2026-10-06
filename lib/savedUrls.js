'use strict';

// Geo-blocked stations are saved in stations.ini / bookmark.xml as the relay's stable
// address, RELAY_BASE/api/radio/stream/u?url=<stream URL>, so the receiver's own menus play
// them through the NAS's VPN. The relay serves that route only for stream URLs whose relay
// address is the URL FIELD of a saved entry — compared exactly after parsing, never by
// searching the files' text (a logo or a name containing it must not count: security review).

const { listStationsFromFile } = require('./stations');
const bookmarks = require('./bookmarks');
const fs = require('fs');

const RELAY_PATH = '/api/radio/stream/';

function savedAddress(relayBase, url) {
  return `${relayBase}${RELAY_PATH}u?url=${encodeURIComponent(url)}`;
}

// Does this URL point at our relay, in any case or percent-encoding? Such URLs may not be
// added as stations (that would launder any URL into the allow-list).
function isRelayUrl(u) {
  if (typeof u !== 'string') return false;
  let text = u;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    } catch (e) { break; }
  }
  return text.toLowerCase().includes(RELAY_PATH);
}

function savedUrlFields({ stationsFile, bookmarksFile }) {
  const urls = [];
  try { for (const s of listStationsFromFile(stationsFile)) urls.push(s.url); } catch (e) { /* missing */ }
  try {
    for (const item of bookmarks.parse(fs.readFileSync(bookmarksFile, 'utf8'))) {
      const f = item.fields.find(([t]) => t === 'StationUrl');
      if (f) urls.push(f[1].replace(/&amp;/g, '&'));
    }
  } catch (e) { /* missing */ }
  return urls;
}

async function isSavedStreamUrl({ stationsFile, bookmarksFile, relayBase, url }) {
  if (!relayBase || typeof url !== 'string' || !url) return false;
  const wanted = savedAddress(relayBase, url);
  return savedUrlFields({ stationsFile, bookmarksFile }).includes(wanted);
}

// Listen here (the browser plays a saved station): `url` must be exactly the URL field of a
// saved entry. Resolves the stream to fetch — the field itself, or for a geo-blocked entry
// the stream inside our relay address — or null. Any other relay URL is refused.
async function listenStreamUrl({ stationsFile, bookmarksFile, relayBase, url }) {
  if (typeof url !== 'string' || !url) return null;
  if (!savedUrlFields({ stationsFile, bookmarksFile }).includes(url)) return null;
  if (!isRelayUrl(url)) return url;
  if (!relayBase) return null;
  let inner;
  try { inner = new URL(url).searchParams.get('url'); } catch (e) { return null; }
  if (!inner || isRelayUrl(inner) || savedAddress(relayBase, inner) !== url) return null;
  return inner;
}

module.exports = { savedAddress, isRelayUrl, isSavedStreamUrl, listenStreamUrl };
