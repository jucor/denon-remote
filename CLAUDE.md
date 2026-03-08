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

## Key Files

- `server.js` — Express server: WebSocket hub, telnet lifecycle, HTTP command proxy, HTTP polling
- `public/index.html` — Single-page frontend: all UI, WebSocket client, visibility tracking
- `lib/DenonClient.js` — Telnet wrapper (TCP port 23). `connect()` returns a Promise that only resolves on success, never rejects — connection errors go to the `error` event handler

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
# Copy updated files to NAS
scp -O server.js julien@nas.local:/volume2/docker/denon-remote/server.js
scp -O public/index.html julien@nas.local:/volume2/docker/denon-remote/public/index.html
# Rebuild and restart
ssh julien@nas.local "docker compose -f /volume2/docker/misc.yml build denon-remote && docker compose -f /volume2/docker/misc.yml up -d denon-remote"
```

### Container Config (in `misc.yml`)

```yaml
denon-remote:
  build: /volume2/docker/denon-remote
  container_name: denon-remote
  restart: unless-stopped
  ports:
    - "3002:3000"
  environment:
    - PORT=3000
    - DENON_HOST=192.168.1.11
```

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
- After sending an HTTP command, an immediate poll fires 300ms later so the UI reflects changes quickly.
- `Network Control` must be set to `Always On` on the receiver for telnet/HTTP to work.
