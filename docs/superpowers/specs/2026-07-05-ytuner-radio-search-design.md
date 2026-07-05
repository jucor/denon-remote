# Internet Radio Keyword Search via yTuner — Design

**Date:** 2026-07-05
**Status:** Approved design (pending spec review)
**Component:** `denon-remote` (web remote for Denon CEOL RCD-N9)

## Problem

On the physical remote, entering an internet-radio "Search by keyword" is done with a
modified-T9 keypad on the receiver's on-screen keyboard — slow and awkward. We want to
type a keyword in a normal text field in the web remote and have the matching station end
up playable on the receiver.

## Constraint findings (why this design)

Investigated during brainstorming; these rule out the "obvious" approaches:

1. **No direct text command exists on this hardware.** The Denon AVR telnet/HTTP protocol
   (the one this app uses) has **no character-input command**. `NS90–94` are cursor
   arrows, `NS9x` are transport/page, and there is **no numeric/T9 passthrough**. Verified
   against the official DRA-N5/RCD-N8 protocol PDF and the existing project notes
   (`CEOL-N7-PROTOCOL.md`).
2. **HEOS is not available.** HEOS exposes a clean `browse/search?search=<text>` API on
   TCP 1255, but the receiver is a pre-HEOS (vTuner-based) **RCD-N9** and **port 1255 is
   closed** (probed: 23/80 open, 1255 closed).
3. **Simulating the on-screen keyboard** (driving `NS90–94` letter-by-letter) is the only
   *on-device* option, but its feasibility is unknown without reverse-engineering the live
   device, and it is fragile.

**Decision:** don't type on the device at all. The receiver's Internet Radio is already
served by **yTuner** (open-source vTuner replacement, `coffeegreg/YTuner`) running on the
NAS, which intercepts `*.vtuner.com` DNS and serves the receiver's radio menus. yTuner
reads a user-controlled **MyStations** file (`config/stations.ini`). We do the search in
our web UI (against the same directory yTuner uses, **radio-browser.info**) and inject the
chosen station into that file. It then appears on the receiver under **Internet Radio →
My Stations** — no on-device keyboard involved.

## Deployment facts (ground truth, verified on NAS)

- `denon-remote` and `ytuner` both run as Docker containers on the same NAS under
  `/volume2/docker/`.
- yTuner config: `/volume2/docker/ytuner/ytuner.ini`, stations at
  `/volume2/docker/ytuner/config/stations.ini` (currently empty except comments).
- yTuner currently has `MyStationsAutoRefreshPeriod=0` (reload disabled).
- `stations.ini` is world-writable (`rwxrwxrwx`), so the denon-remote container (non-root
  `appuser`) can write it through a bind mount.
- yTuner has **no HTTP API** for stations (its maintenance server only shuts the service
  down); bookmarks (`bookmark.xml`) are managed only from the AVR remote. Therefore the
  **MyStations file is the integration point.**

## Architecture

```
[Web remote]  type "fip jazz"  ──GET /api/radio/search?q=fip jazz──►
[denon-remote server] ──► radio-browser.info /json/stations/search (name=…)
     ◄── cleaned results {name,url,codec,bitrate,country,favicon,uuid}
User taps "Add" ──POST /api/radio/add──►
[denon-remote server] read-modify-write /ytuner-config/stations.ini (atomic)
     ▼
[yTuner] auto-refresh (period=1 min) re-reads MyStations
     ▼
[Receiver] Internet Radio ▸ My Stations ▸ "<category>" ▸ "FIP Jazz"  ✓  (≤60s)
```

Reload mechanism: **auto-refresh timer** (`MyStationsAutoRefreshPeriod=1`). The server only
writes the file; the station appears within ~60s. No Docker socket, no playback
interruption. (Alternative — restarting yTuner per add — was rejected: needs the Docker
socket and drops yTuner's DNS/web briefly.)

## Components

### 1. Server endpoints (`server.js`)

All are plain REST (JSON), independent of the existing WebSocket receiver channel.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/radio/search?q=<kw>` | Proxy radio-browser search | `name=<kw>&limit=30&hidebroken=true&order=votes&reverse=true`; sets a descriptive `User-Agent`; maps to cleaned records |
| `POST /api/radio/add` | Add station to MyStations | body `{name, url, logo?}`; append under configured category; dedup by stream URL; atomic write |
| `GET /api/radio/mystations` | List current custom stations | parse `stations.ini`, return `[{category, name, url, logo}]` |
| `DELETE /api/radio/remove` | Remove a station | body `{name, url}`; remove matching line; atomic write; leaves other categories/comments intact |

**radio-browser mapping** (per result): `name`, `url` ← `url_resolved` (fallback `url`),
`codec`, `bitrate`, `country` ← `country`/`countrycode`, `favicon`, `uuid` ←
`stationuuid`, `votes`. Drop entries with empty name or url.

**stations.ini I/O module** (new, e.g. `lib/stations.js`) — the unit under test:
- Parse INI: `[Category]` headers, `Name=url|logo` lines, preserve comment/blank lines.
- Serialize back preserving unrelated categories and comments.
- `addStation(file, category, {name,url,logo})`: dedup by normalized stream URL within the
  category; if present, update in place; else append.
- `removeStation(file, {name,url})`.
- **Sanitize station name** (it is the INI key): strip control chars, collapse whitespace,
  replace `=`→`-`, `|`→`/`, drop `[` `]`, trim. If a stream URL contains `|`, URL-encode
  that character (yTuner splits name/logo on `|`).
- **Atomic write:** write temp file in same dir, `fs.rename` over the target. Serialize
  concurrent writes with an in-process mutex (single-user volume).

### 2. Frontend (`public/index.html`)

New **"Internet Radio Search"** section (own `.section` card, matching existing styling),
always visible:
- Text input + **Search** button; Enter submits.
- **Results list** (≤20 shown): favicon (with fallback icon), station name, and a meta line
  `country · codec · bitrate`. Each row has a `＋ Add` button.
- **My Stations list** (fetched on load and after add/remove): each row shows name + meta
  and a `×` remove button.
- States: loading spinner during search; empty ("no results"); error (radio-browser
  unreachable → retriable message). On add: optimistic insert into My Stations + toast
  "Added — appears on the receiver's *My Stations* within ~1 min."

Uses `fetch` to the new endpoints (not the WebSocket).

### 3. Deployment wiring (`misc.yml` on NAS)

Add to the `denon-remote` service:
```yaml
    volumes:
      - /volume2/docker/ytuner/config:/ytuner-config
    environment:
      - YTUNER_STATIONS_FILE=/ytuner-config/stations.ini
      - YTUNER_STATIONS_CATEGORY=Added via Remote
      - RADIO_BROWSER_BASE=https://all.api.radio-browser.info
```
One-time yTuner change: set `MyStationsAutoRefreshPeriod=1` in
`/volume2/docker/ytuner/ytuner.ini` and restart the `ytuner` container.

**Config (env vars, with defaults so local dev works):**
- `YTUNER_STATIONS_FILE` — path to stations.ini (local dev: a temp file).
- `YTUNER_STATIONS_CATEGORY` — default `Added via Remote` (ASCII, OLED-safe).
- `RADIO_BROWSER_BASE` — default `https://all.api.radio-browser.info`.

## Error handling

- radio-browser timeout/5xx/DNS failure → `502` with a clear message; UI shows retriable error.
- `stations.ini` write failure (perms/missing mount) → `500`; UI toast; log the path.
- Malformed/oversized keyword → trim, cap length; empty query → `400`.
- Name collisions / duplicate URL → idempotent (update in place, no duplicate line).

## Testing (TDD — RED/GREEN, per repo CLAUDE.md)

Runner: Node 20 built-in `node:test` + `node:assert` (zero new runtime deps; test-only).

- **Unit — `lib/stations.js`:** round-trip parse/serialize; add dedups by URL; add
  preserves other categories and comments; remove deletes only the target; name
  sanitization (`=`, `|`, brackets, control chars); URL-with-`|` encoding.
- **Unit — radio-browser mapping:** field mapping, `url_resolved` fallback, dropping empty
  entries.
- **Integration — endpoints:** boot the Express app with a temp stations file and a stubbed
  radio-browser; assert `search` returns mapped JSON, `add` writes the expected file
  bytes, `mystations` reads them back, `remove` deletes.
- **E2E — Playwright:** load the page, type a keyword (search endpoint stubbed for
  determinism), click **Add**, assert the My Stations list updates and the temp
  `stations.ini` contains the entry; click **×**, assert removal.

## Out of scope (future enhancements)

- Auto-selecting/playing the added station on the receiver (would need `NS` cursor
  navigation of the device menu).
- yTuner `bookmark.xml` integration.
- Category management / reordering; multi-mirror failover for radio-browser.

## Success criteria

Type a keyword in the web remote, add a result, and within ~1 minute select and play that
station on the receiver via Internet Radio → My Stations — without ever using the device's
on-screen keyboard. Added stations are listable and removable from the remote.
