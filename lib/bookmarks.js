'use strict';

// Read/write helpers for yTuner's bookmark file ("Favourites" on the receiver).
// Format, ids and the rules yTuner applies are documented in docs/ytuner-bookmarks.md;
// yTuner itself reads the file afresh on every request, so a write is live at once.
//
//   <?xml version="1.0"?>
//   <ListOfItems>
//     <ItemCount>N</ItemCount>          <- must be the first child, must equal the Item count
//     <Item> <ItemType>Station</ItemType> <StationId>…</StationId> … <Bookmark>…</Bookmark> </Item>
//   </ListOfItems>
//
// parse/serialise/buildItem are pure string functions; the file wrappers at the bottom
// add atomic writes and an in-process mutex, mirroring lib/stations.js.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');

const LIMIT = 100; // yTuner's default BookmarkStationsLimit (bookmark.pas:19)
const YTUNER_HOST = 'ytunerhost'; // placeholder host yTuner stores and rewrites on read (common.pas:37)
const MIME_OK = ['MP3', 'AAC', 'WMA']; // vtuner.pas:60

// Children of an Item, in the order yTuner writes them (vtuner.pas:185-199).
const ITEM_TAGS = ['ItemType', 'StationId', 'StationName', 'StationUrl', 'StationDesc', 'Logo',
  'StationFormat', 'StationLocation', 'StationBandWidth', 'StationMime', 'Relia', 'Bookmark'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// --- XML (just enough for this fixed format) ---

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function encode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NOT_BOOKMARKS = 'Not a yTuner bookmark file';

// Split a run of sibling elements into [[tag, rawInnerXml], …]. Anything other than
// whitespace between elements means the input is not what yTuner writes.
function childElements(xml) {
  const out = [];
  const re = /\s*<([A-Za-z_][\w.-]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/y;
  let pos = 0;
  while (pos < xml.length) {
    if (!xml.slice(pos).trim()) break;
    re.lastIndex = pos;
    const m = re.exec(xml);
    if (!m) throw new Error(NOT_BOOKMARKS);
    out.push([m[1], m[2] === undefined ? '' : m[2]]);
    pos = re.lastIndex;
  }
  return out;
}

// text -> [{ fields: [[tag, value], …] }]. An empty/blank file is an empty list; anything
// that is not a ListOfItems document throws.
function parse(text) {
  let s = String(text).replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => encode(t))
    .trim();
  if (!s) return [];
  const root = childElements(s);
  if (root.length !== 1 || root[0][0] !== 'ListOfItems') throw new Error(NOT_BOOKMARKS);
  const items = [];
  for (const [tag, inner] of childElements(root[0][1])) {
    if (tag !== 'Item') continue; // ItemCount (recomputed on write) and anything unknown
    items.push({ fields: childElements(inner).map(([t, v]) => [t, decode(v.trim())]) });
  }
  return items;
}

function serialise(items) {
  const lines = ['<?xml version="1.0"?>', '<ListOfItems>', `  <ItemCount>${items.length}</ItemCount>`];
  for (const item of items) {
    lines.push('  <Item>');
    for (const [tag, value] of item.fields) {
      lines.push(value === '' ? `    <${tag}/>` : `    <${tag}>${encode(value)}</${tag}>`);
    }
    lines.push('  </Item>');
  }
  lines.push('</ListOfItems>', '');
  return lines.join('\n');
}

function field(item, tag) {
  const f = item.fields.find(([t]) => t === tag);
  return f ? f[1] : '';
}

function summarise(item) {
  const logo = field(item, 'Logo');
  return {
    id: field(item, 'StationId'),
    name: field(item, 'StationName'),
    url: field(item, 'StationUrl'), // Listen here plays it (the relay checks it is saved)
    // The placeholder host only means something to the receiver (yTuner swaps it on read).
    logo: new RegExp(`^https?://${YTUNER_HOST}[/:]`, 'i').test(logo) ? '' : logo,
  };
}

// --- Building an Item yTuner and the receiver accept ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Characters XML 1.0 forbids (or that yTuner's ReadXMLFile may choke on): C0/C1 controls,
// U+FFFE/U+FFFF and lone surrogates. One of them anywhere made yTuner 404 the whole menu.
const XML_UNSAFE = /[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(XML_UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(station) {
  return cleanText(station && station.name);
}

// URLs: drop unsafe characters, then let the URL parser percent-encode the rest, so what
// is stored is plain printable ASCII.
function cleanUrl(s) {
  const raw = String(s == null ? '' : s).replace(XML_UNSAFE, '').trim();
  if (!raw) return '';
  try { return new URL(raw).href; } catch (e) { return raw; }
}

const isHttpUrl = (u) => /^https?:\/\/[\x21-\x7E]+$/i.test(u);

// The bookmark id (3rd character 'B' routes the receiver's lookup to the bookmark file) and
// the id of the underlying MyStations/radio-browser entry (what the Bookmark URL names).
function ids(station) {
  const uuid = cleanUrl(station && station.uuid);
  if (UUID_RE.test(uuid)) {
    const tail = uuid.replace(/-/g, '').slice(0, 12).toUpperCase();
    return { id: `RBB${tail}`, source: `RB_${tail}` };
  }
  const tail = crypto.createHash('md5').update(cleanName(station) + cleanUrl(station && station.url))
    .digest('hex').slice(0, 12).toUpperCase();
  return { id: `MSB${tail}`, source: `MS_${tail}` };
}

function stationId(station) {
  return ids(station).id;
}

function buildItem(station) {
  const name = cleanName(station);
  const url = cleanUrl(station && station.url);
  if (!name) throw httpError(400, 'name is required');
  if (!isHttpUrl(url)) throw httpError(400, 'url must be an http(s) stream URL');
  const { id, source } = ids({ ...station, name, url });
  const iconUrl = `http://${YTUNER_HOST}/ytuner/icon?id=${source}`;
  const favicon = cleanUrl(station.favicon);
  // Logo and Bookmark must never be empty: GetBookmark dereferences them unguarded.
  const logo = source.startsWith('MS_') && isHttpUrl(favicon) ? favicon : iconUrl;
  const codec = String(station.codec || '').toUpperCase();
  const bitrate = Number(station.bitrate) > 0 ? String(Math.round(Number(station.bitrate))) : '';
  const values = {
    ItemType: 'Station',
    StationId: id,
    StationName: name,
    StationUrl: url,
    StationDesc: `My favorite "${name}"`,
    Logo: logo,
    StationFormat: cleanText(station.genre),
    StationLocation: cleanText(station.country),
    StationBandWidth: bitrate,
    StationMime: MIME_OK.includes(codec) ? codec : '',
    Relia: '3',
    Bookmark: `http://${YTUNER_HOST}/setupapp/favxml.asp?id=${source}&fav=del`,
  };
  return { fields: ITEM_TAGS.map((t) => [t, values[t]]) };
}

// --- File I/O (atomic write, serialised) ---

let writeChain = Promise.resolve();

function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

function readItems(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return parse(text);
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

function list(file) {
  return readItems(file).map(summarise);
}

// Add a station. Idempotent on the id, like yTuner's SetBookmark. Resolves
// { id, added, items }; rejects with .status 400 (bad input) or 409 (list full).
function add(file, station, { limit = LIMIT } = {}) {
  return withLock(async () => {
    const item = buildItem(station || {});
    const id = field(item, 'StationId');
    const items = readItems(file);
    if (items.some((i) => field(i, 'StationId') === id)) {
      return { id, added: false, items: items.map(summarise) };
    }
    if (items.length >= limit) {
      throw httpError(409, `Favourites are full (${limit} at most — yTuner's BookmarkStationsLimit)`);
    }
    items.push(item);
    await writeAtomic(file, serialise(items));
    return { id, added: true, items: items.map(summarise) };
  });
}

// Remove by id. Like SetBookmark, removing the last item deletes the file. Resolves the
// remaining list; rejects with .status 404 when the id is not there (nothing is written).
function remove(file, id) {
  return withLock(async () => {
    const items = readItems(file);
    const rest = items.filter((i) => field(i, 'StationId') !== id);
    if (rest.length === items.length) throw httpError(404, 'Not in Favourites');
    if (rest.length === 0) await fsp.rm(file, { force: true });
    else await writeAtomic(file, serialise(rest));
    return rest.map(summarise);
  });
}

module.exports = { LIMIT, parse, serialise, buildItem, stationId, list, add, remove };
