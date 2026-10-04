'use strict';

// Assembles the receiver's NSE0..NSE8 display lines into one screen.
//
// Line 0 is the title. Lines 1-8 start with an info byte, as observed on the RCD-N9:
//   0x01 = station (playable)   0x02 = folder   0x08 = cursor on this line
//   0x20 = information only (Now Playing text, the "[ n/m ]" page indicator)
// The protocol PDF calls 0x02 "playable", but stations carry 0x01 and folders 0x02.

const CURSOR = 0x08;
const INFO_ONLY = 0x20;
const PAGE_RE = /^\[\s*(\d+)\s*\/\s*(\d+)\s*\]$/;
const PLACEHOLDER = '---- empty ----';

function parseNseLine(line) {
  const m = /^NS[EA](\d)([\s\S]*)$/.exec(line);
  if (!m) return null;
  const idx = Number(m[1]);
  const raw = m[2].split('\x00')[0];
  if (idx === 0) return { idx, info: 0, text: raw.trim() };
  if (!raw.length) return { idx, info: 0, text: '' };
  return { idx, info: raw.charCodeAt(0), text: raw.substring(1).trim() };
}

function buildScreen(lines) {
  const title = lines[0] ? lines[0].text : '';
  const rows = [];
  const items = [];
  let page = null;
  let cursor = -1;
  let loading = false;
  for (let i = 1; i <= 8; i++) {
    const l = lines[i];
    if (!l) continue;
    const isCursor = (l.info & CURSOR) !== 0;
    const pm = PAGE_RE.exec(l.text);
    if (pm) { page = { current: Number(pm[1]), total: Number(pm[2]) }; continue; }
    if (l.text === PLACEHOLDER) { loading = true; continue; }
    if (isCursor) cursor = i;
    const isItem = l.text !== '' && (l.info & INFO_ONLY) === 0;
    const row = { idx: i, text: l.text, cursor: isCursor, item: isItem, folder: (l.info & 0x02) !== 0 };
    rows.push(row);
    if (isItem) items.push(row);
  }
  return { title, rows, items, cursor, page, loading };
}

class ScreenAssembler {
  constructor() { this.lines = {}; }

  // Feed one NSE/NSA line; returns the complete screen when line 8 arrives, else null.
  feed(line) {
    const parsed = parseNseLine(line);
    if (!parsed) return null;
    if (parsed.idx === 0) this.lines = {};
    this.lines[parsed.idx] = parsed;
    return parsed.idx === 8 ? buildScreen(this.lines) : null;
  }
}

module.exports = { parseNseLine, ScreenAssembler, buildScreen };
