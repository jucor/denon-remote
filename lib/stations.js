'use strict';

// Read/write helpers for yTuner's MyStations file (INI format):
//
//   [Category]
//   Station Name=http://stream-url|http://logo-url        (logo optional)
//
// All parse/serialize functions operate on plain strings so they are trivially
// testable. File I/O wrappers (atomic write + in-process mutex) live at the bottom.

function isHeader(line) {
  return /^\s*\[.*\]\s*$/.test(line);
}

function headerName(line) {
  const m = line.match(/^\s*\[(.*)\]\s*$/);
  return m ? m[1].trim() : null;
}

function isComment(line) {
  return /^\s*[;#]/.test(line);
}

// Parse a "Name=url|logo" entry line. Returns null for comments/headers/blanks.
function parseEntry(line) {
  if (!line || isComment(line) || isHeader(line) || !line.trim()) return null;
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const name = line.slice(0, eq).trim();
  const rest = line.slice(eq + 1).trim();
  if (!name || !rest) return null;
  const pipe = rest.indexOf('|');
  const url = (pipe >= 0 ? rest.slice(0, pipe) : rest).trim();
  const logo = pipe >= 0 ? rest.slice(pipe + 1).trim() : '';
  if (!url) return null;
  return { name, url, logo };
}

const NAME_SUBSTITUTIONS = { '=': '-', '|': '/', '[': '(', ']': ')' };

function sanitizeName(name) {
  // Replace control chars (< 0x20) with spaces without an inline control-char
  // regex literal, then swap INI-significant characters and collapse whitespace.
  const noControl = Array.from(String(name))
    .map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('');
  return noControl
    .replace(/[=|[\]]/g, (m) => NAME_SUBSTITUTIONS[m])
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeUrl(url) {
  // yTuner splits name/url and url/logo on '|', so a literal pipe in the URL
  // must be percent-encoded.
  return String(url).trim().replace(/\|/g, '%7C');
}

function serializeEntry({ name, url, logo }) {
  const line = `${name}=${url}`;
  return logo ? `${line}|${logo}` : line;
}

function listStations(text) {
  const out = [];
  let category = null;
  for (const line of String(text).split('\n')) {
    if (isHeader(line)) {
      category = headerName(line);
      continue;
    }
    const entry = parseEntry(line);
    if (entry) out.push({ category: category || '', ...entry });
  }
  return out;
}

function addStation(text, category, station) {
  const name = sanitizeName(station.name);
  const url = encodeUrl(station.url);
  const logo = station.logo ? encodeUrl(station.logo) : '';
  const newLine = serializeEntry({ name, url, logo });

  const lines = String(text).split('\n');
  // Locate the [category] header.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHeader(lines[i]) && headerName(lines[i]) === category) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    // Append a fresh category at the end.
    let prefix = String(text);
    if (prefix.length && !prefix.endsWith('\n')) prefix += '\n';
    return `${prefix}[${category}]\n${newLine}\n`;
  }

  // Section runs until the next header (or EOF).
  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isHeader(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Dedup by stream URL within the section: replace an existing entry in place.
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    const entry = parseEntry(lines[i]);
    if (entry && entry.url === url) {
      lines[i] = newLine;
      return lines.join('\n');
    }
  }

  // Insert after the last non-blank line of the section.
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    if (lines[i].trim()) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, newLine);
  return lines.join('\n');
}

function removeStation(text, { name, url }) {
  const lines = String(text).split('\n');
  const kept = [];
  let removed = false;
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!removed && entry && entry.name === name && entry.url === url) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return removed ? kept.join('\n') : String(text);
}

// --- File I/O (atomic write, serialized) ---

const fs = require('fs');
const fsp = require('fs/promises');

let writeChain = Promise.resolve();

// Serialize read-modify-write operations so concurrent adds can't lose updates.
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined); // keep chain alive on reject
  return run;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

function listStationsFromFile(file) {
  return listStations(readText(file));
}

function addStationToFile(file, category, station) {
  return withLock(async () => {
    const next = addStation(readText(file), category, station);
    await writeAtomic(file, next);
    return listStations(next);
  });
}

function removeStationFromFile(file, station) {
  return withLock(async () => {
    const next = removeStation(readText(file), station);
    await writeAtomic(file, next);
    return listStations(next);
  });
}

module.exports = {
  listStations,
  addStation,
  removeStation,
  sanitizeName,
  encodeUrl,
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
};
