# Denon CEOL N7 Web Remote

Web-based remote control for the **Denon CEOL N7 (RCD-N7)** network CD receiver. Runs on a home server via Docker, accessible from any phone or browser on your local network.

Based on the [denon-remote](https://github.com/jtangelder/denon-remote) CLI tool, adapted into a full web application with Bluetooth support.

## Features

- **Power** on/off (standby)
- **Volume** control with slider, up/down, mute
- **Input source** selection: Bluetooth, CD, Tuner, USB, Network, AUX, Spotify, iRadio, Server, Favorites, Optical, Analog
- **Bluetooth** input selection and **pairing mode**
- **Playback** controls: play, pause, stop, skip, repeat, shuffle
- **Tone** controls: bass and treble up/down
- **Sound modes**: Stereo, Direct, Standard, Music, Movie, Game, Rock Arena, Jazz Club, Virtual
- **Sleep timer**: 15, 30, 60, 90, 120 minutes
- **Raw command** input for advanced users
- **Real-time status** updates via WebSocket
- **Mobile-first** responsive design

## Quick Start with Docker

```bash
# Set your Denon's IP address and run
DENON_HOST=192.168.1.100 docker compose up -d

# Then open http://your-server-ip:3000 in your browser
```

## Docker Compose

```yaml
services:
  denon-remote:
    build: .
    container_name: denon-ceol-remote
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - DENON_HOST=192.168.1.100  # <-- Your Denon's IP
```

## Running Without Docker

```bash
npm install
DENON_HOST=192.168.1.100 npm start
# Open http://localhost:3000
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `DENON_HOST` | `null` (auto-discover) | IP address of your Denon CEOL N7. Docker Compose defaults to `192.168.1.100`. |
| `PORT` | `3000` | Web server port |

## Prerequisites

Your Denon CEOL N7 must be:
1. Connected to your local network (Ethernet or WiFi)
2. Have **Network Control** set to **Always On** (Settings > Network > IP Control)
3. Have a static IP address (recommended)

## Bluetooth

- **Select Bluetooth**: Switches the receiver to Bluetooth input
- **Pairing Mode**: Selects Bluetooth input which activates pairing mode when no device is currently connected. Look for "Pairing" on the receiver's display, then select the receiver from your phone's Bluetooth settings.

## CLI (Original)

The original command-line interface is still available:

```bash
npm run cli
denon$ help
```

## How It Works

The receiver is controlled via telnet (TCP port 23) using the Denon AVR control protocol. The web app runs an Express server that maintains a persistent telnet connection to the receiver and exposes a REST API + WebSocket for the browser.

See `protocol.pdf` for the full command reference.
