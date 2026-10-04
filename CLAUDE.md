# Denon CEOL Remote

Web remote control for the **Denon CEOL RCD-N9** (not N7 as in README) network CD receiver.

## Architecture

### Hybrid Transport

- **Commands**: sent via HTTP API (`http://192.168.1.11/goform/formiPhoneAppDirect.xml?CMD`) — fire-and-forget, no connection limit, same protocol commands as telnet (`PWON`, `MVUP`, `SICD`, etc.)
- **Status (telnet connected)**: real-time push via telnet (TCP port 23) — power, volume, mute, input, CD track, display text
- **Status (telnet unavailable)**: HTTP polling every 2s via `formMainZone_MainZoneXmlStatusLite.xml` — provides power, input, volume (dB scale, converted to Denon 0–60), mute

### Telnet Lifecycle

- **Single connection limit**: the RCD-N9 only accepts one telnet client at a time on port 23
- **Tab-driven**: telnet connects only when a browser tab is visible (Page Visibility API); disconnects when all tabs are hidden/closed
- **Auto-retry**: if telnet fails (e.g. another client holds it), retries every 10s while tabs are active
- **Manual disconnect**: "Disconnect" button drops telnet and stops retrying (HTTP-only mode); "Connect" button re-enables telnet with auto-retry
- **HTTP polling fallback**: starts automatically when telnet is unavailable + active tabs exist; stops when telnet connects or all tabs close

### HTTP-only Mode UI

When telnet is unavailable, the UI adapts:
- Power toggle becomes two explicit buttons (Power ON / Standby)
- Mute toggle becomes two explicit buttons (Mute On / Mute Off)
- SDB toggle becomes two explicit buttons (SDB On / SDB Off)
- Volume slider hidden (up/down buttons still work)
- No active highlighting on buttons until first HTTP poll provides state
- Once HTTP poll returns state, normal toggle UI is restored

### Internet Radio Search (via yTuner)

The receiver's on-device iRadio "Search by keyword" needs modified-T9 entry on the remote,
and the AVR protocol has **no text-input command** (and this RCD-N9 is pre-HEOS, so no HEOS
`browse/search` either — port 1255 is closed). Instead, the web remote searches
[radio-browser.info](https://api.radio-browser.info) and injects the chosen station into
**yTuner**'s MyStations file. yTuner (the vTuner replacement on the NAS, container `ytuner`
at LAN IP 192.168.1.200, intercepts `*.vtuner.com` DNS) serves it to the receiver under
**Internet Radio → My Stations → Julien**. No on-device keyboard involved.

- Flow: type keyword → `GET /api/radio/search` → radio-browser.info → tap Add →
  `POST /api/radio/add` → append to `stations.ini` → yTuner auto-reloads
  (`MyStationsAutoRefreshPeriod=1`) → appears on receiver within ~1 min.
- Config (env): `YTUNER_STATIONS_FILE` (default local `stations.local.ini`),
  `YTUNER_STATIONS_CATEGORY` (default `Julien`), `RADIO_BROWSER_BASE`.
- Play: each My Stations row has **▶ Play** (the whole row is tappable) → `POST /api/radio/play`
  → `lib/radioNavigator.js` drives the menu over telnet: `SIIRADIO` if needed, Back (`NS92`)
  until the top iRadio menu, then My Stations → category → station → OK (`NS94`), until the
  screen title is "Now Playing". Items are found by stepping Down one row at a time until
  the cursor row's text is exactly the target (a repeated screen = full lap = not found);
  OK is only ever pressed on an exact match. If the top menu lacks yTuner's entries it
  re-enters iRadio via `SICD` → `SIIRADIO`. Needs telnet (503 otherwise; the Play buttons
  are disabled with a visible reason); one navigation at a time (409, and manual `NS9x`
  keys get 409 meanwhile); aborted at once if telnet drops; 60 s overall deadline.
  The iRadio protocol itself has no "play this URL" — but see UPnP below.
- Tests: `npm test` (node:test unit + integration), `npm run test:e2e` (Playwright browser
  E2E; `playwright` is a devDependency, excluded from the image by `npm ci --production`).
  `test/helpers/fakeReceiver.js` simulates the iRadio menu as observed on the real unit.

### Receiver display (NSE lines) — observed on the RCD-N9, 2026-10-04

- Info byte on lines 1-8: `0x01` station, `0x02` folder, `0x08` cursor, `0x20` information
  only (the `[ n/m ]` indicator on line 8, sometimes Now Playing text). The protocol PDF calls
  `0x02` "playable", but stations carry `0x01`. On **Now Playing** the song and time lines
  can also carry `0x01`, so nothing there is treated as selectable. `lib/nseScreen.js` and
  `handleDisplay()` in the page share these rules.
- **Lists are a sliding 7-row window that wraps**: Down on the last item goes to the first;
  Page Down/Up (`NS9Y`/`NS9X`) move the cursor 7 items and wrap too. `[ n/m ]` (cursor item
  / total) appears only on some screens — don't rely on it.
- Text arrives **double-encoded** (UTF-8 read as Latin-1: "We’ll" → "Weâ\x80\x99ll");
  `fixDoubleEncoding()` repairs it on both sides.
- The same screen is sometimes **pushed twice** in a row; each key must wait for a screen
  that actually differs from the one before it.
- Left idle in a menu while something plays, the receiver **returns to Now Playing on its
  own** after a few seconds (so "Back at the top pushes nothing" is only true at first).
- Entering iRadio from another input either shows the top menu (from CD) or **resumes the
  last station** on Now Playing (from Media Server).
- Seen once: a folder (My Stations) opened, yTuner served it, but the receiver stayed on
  `---- empty ----` with nothing else pressed; Back/OK then behaved erratically. The
  navigator recovers by re-entering iRadio (`SICD` → `SIIRADIO`) and starting over, once.
- After another input was used (e.g. Media Server via UPnP), iRadio's top menu can come back
  with **only "Recently Played" and "Search by Keyword"** — no yTuner entries — until iRadio
  is entered again from another input (`SICD` then `SIIRADIO` makes it re-fetch from yTuner).
- The receiver **pushes the whole screen** after every cursor move, Back and OK. Back at the
  top menu does nothing and pushes nothing.
- Opening a folder first shows `---- empty ----` while yTuner loads it. **A key pressed during
  loading leaves the menu stuck on "empty"** (Back + OK again recovers): always wait for the
  loaded screen before the next key.
- The HTTP API names the iRadio input `NET`; telnet says `IRADIO`. While telnet is connected
  HTTP poll results are ignored (`lib/httpStatus.js`), otherwise a late poll overwrote
  `IRADIO` with `NET` and the page hid the display.

## Key Files

- `server.js` — Express server: WebSocket hub, telnet lifecycle, HTTP command proxy, HTTP polling; mounts `/api/radio`
- `public/index.html` — Single-page frontend: all UI, WebSocket client, visibility tracking, Internet Radio Search section
- `lib/DenonClient.js` — Telnet wrapper (TCP port 23). `connect()` returns a Promise that only resolves on success, never rejects — connection errors go to the `error` event handler
- `lib/stations.js` — pure yTuner `stations.ini` parse/serialize/add/remove + atomic, mutex-guarded file I/O
- `lib/radiobrowser.js` — radio-browser.info search + result mapping
- `lib/radioRoutes.js` — injectable REST router: `GET /search`, `POST /add`, `GET /mystations`, `DELETE /remove`, `POST /play`
- `lib/radioNavigator.js` — plays a My Stations entry by walking the iRadio menu over telnet
- `lib/nseScreen.js` — assembles NSE0..NSE8 lines into a screen (title, items, cursor, page, loading)
- `lib/lineSplitter.js` — splits the telnet stream into CR-terminated lines across TCP chunks
- `lib/httpStatus.js` — parses the HTTP status XML; ignores it while telnet is connected

## Denon HTTP API

| Endpoint | Returns |
|----------|---------|
| `/goform/formiPhoneAppDirect.xml?CMD` | 200 OK, no body (fire-and-forget command) |
| `/goform/formMainZone_MainZoneXmlStatusLite.xml` | Power, input, volume (dB), mute |
| `/goform/formMainZone_MainZoneXml.xml` | Power, input, model info |
| `/goform/formMainZone_MainZoneXmlStatus.xml` | Same as Lite + zone info |
| `/goform/formNetAudio_StatusXml.xml` | Network source display lines |
| `/goform/formTuner_TunerXml.xml` | Tuner band, presets |
| `/goform/Deviceinfo.xml` | Model (RCD-N9), MAC, capabilities, max volume (60) |

### Receiver Ports

- 80: GoAhead-Webs admin/HTTP API
- 443: HTTPS version
- 23: Telnet control (single connection)
- 8080: UPnP/DLNA presentation
- 5000: UPnP control/eventing

### Volume Conversion

Denon uses 0–60 range internally. HTTP API returns dB scale. Conversion: `denonValue = dB + 80` (e.g., -77.0 dB = volume 3).

## Deployment

Deployed on Synology NAS via `misc.yml` Docker stack, accessible at `denon.ju.fr`.

```bash
# Copy updated files to NAS (include lib/*.js when they change)
scp -O server.js package.json package-lock.json julien@nas.local:/volume2/docker/denon-remote/
scp -O public/*.html public/*.js julien@nas.local:/volume2/docker/denon-remote/public/
scp -O lib/*.js julien@nas.local:/volume2/docker/denon-remote/lib/
# Rebuild and restart
ssh julien@nas.local "docker compose -f /volume2/docker/misc.yml build denon-remote && docker compose -f /volume2/docker/misc.yml up -d denon-remote"
```

### Container Config (in `misc.yml`)

```yaml
denon-remote:
  build: /volume2/docker/denon-remote
  container_name: denon-remote
  user: "1026:100"            # julien:users — see gotcha below
  restart: unless-stopped
  ports:
    - "3002:3000"
  volumes:
    - /volume2/docker/ytuner/config:/ytuner-config   # write yTuner MyStations
  environment:
    - PORT=3000
    - DENON_HOST=192.168.1.11
    - YTUNER_STATIONS_FILE=/ytuner-config/stations.ini
    - YTUNER_STATIONS_CATEGORY=Julien
```

yTuner side: `/volume2/docker/ytuner/ytuner.ini` must have, under `[MyStations]`,
**`Enable=1`** (without it the receiver's menu has no "My Stations" at all — it was `0` until
2026-10-04) and `MyStationsAutoRefreshPeriod=1` so it reloads `stations.ini`. Restart the
`ytuner` container after changing the ini. `ytuner.ini`, `config/avr.ini` (menu items) and
`config/stations.ini` are versioned in the NAS's `/volume2/docker` git repo.

### DNS & Reverse Proxy

- **DNS**: `denon.ju.fr` CNAME -> `hangar.ju.fr` (Synology DNS Server GUI)
- **Reverse proxy**: `denon.ju.fr:80` -> `localhost:3002` with WebSocket headers (Synology Control Panel GUI)

## Local Development

```bash
npm install
DENON_HOST=192.168.1.11 PORT=3003 node server.js
# Use port 3003 to avoid conflict with NAS mapping on 3002
```

## Gotchas

- The receiver is an **RCD-N9**, not N7 (README is outdated). Confirmed via `/goform/Deviceinfo.xml`.
- **DenonClient.connect()** never rejects on failure — errors go to the `error` event. The `.catch()` after connect is dead code for connection failures.
- **Tear a client down with `discard()`**, never `removeAllListeners()` + `end()`: a socket
  still connecting emits its connect error later, and with no listener Node kills the
  process (this took `denon.ju.fr` down with a 502). `server.js` also has an
  `uncaughtException` backstop.
- After sending an HTTP command, an immediate poll fires 300ms later so the UI reflects changes quickly.
- `Network Control` must be set to `Always On` on the receiver for telnet/HTTP to work.
- **Writing yTuner's `stations.ini` needs `user: "1026:100"`** in `misc.yml`. The image runs as non-root `appuser` (uid 100), but a **Synology ACL** on `/volume2/docker/ytuner/config` overrides the 777 POSIX bits and only grants the file owner (uid 1026 = `julien`) write. Symptom without it: `EACCES ... stations.ini.tmp` on add/remove. Probe with `docker exec -u <uid>:<gid> denon-remote touch /ytuner-config/.probe`.
- The design spec lives at `docs/superpowers/specs/2026-07-05-ytuner-radio-search-design.md` (includes why direct text entry / HEOS are impossible on this unit).

## Play now — UPnP renderer (port 8080) + stream relay

Each search result has **▶ Play now**: `POST /api/radio/playnow {name, url, codec}` →
`lib/playNow.js` registers the stream with `lib/streamRelay.js` and tells the receiver's
UPnP renderer (`lib/upnpRenderer.js`) to play `RELAY_BASE/api/radio/stream/<id>`. Plays in
~3 s on the receiver's "Media Server" input; no telnet, no yTuner, no menu. The relay
follows redirects and `.pls`/`.m3u` playlists, fetches HTTPS (the receiver can't), strips ICY
metadata (`lib/icy.js`) and broadcasts song titles (`streamTitle` WebSocket event → the
"Now playing" strip). Only registered stations are relayed (not an open proxy). HLS is not
supported. MIME types: MP3 → `audio/mpeg`; AAC → tried in order `audio/vnd.dlna.adts`
(accepted live), `audio/mp4`, `audio/x-mp4`, `audio/3gpp` — `audio/aac` is refused (714).
**Needs env `RELAY_BASE`** = this server's URL as seen from the receiver
(`http://192.168.1.61:3002` on the NAS); without it `/playnow` answers 501.
Verified live 2026-10-04: MP3 (Elvis), AAC (FIP Jazz), HTTPS (Radio Paradise), titles.

### Renderer details (tested 2026-10-04)

The RCD-N9 is a UPnP **MediaRenderer** (`/description.xml`: AVTransport, RenderingControl,
ConnectionManager under `/<Service>/ctrl`). `SetAVTransportURI` (with DIDL-Lite metadata
whose `res protocolInfo="http-get:*:audio/mpeg:*"`) + `Play` plays any HTTP MP3/AAC URL on
the **Media Server** input — no menu walking. Direct Icecast URLs fail (STOPPED at 0:00): the
renderer asks for `icy-metadata: 1` as `WinampMPEG/2.8` and can't parse the interleaved
metadata. Relayed with the metadata stripped (served chunked, no fake Content-Length)
it plays. Side effect: switching back to iRadio afterwards can lose yTuner's menu entries
(see above).
