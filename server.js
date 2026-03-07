const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const DenonClient = require('./lib/DenonClient');
const { discover } = require('./lib/discovery');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let denonHost = process.env.DENON_HOST || null;
const PORT = process.env.PORT || 3000;

// --- HTTP Command Transport ---
// Commands are sent via HTTP (fire-and-forget, no connection limit)
// Status is received via telnet (push, rich data)

function sendHttpCommand(cmd) {
  if (!denonHost) return false;
  const url = `http://${denonHost}/goform/formiPhoneAppDirect.xml?${encodeURIComponent(cmd)}`;
  http.get(url, (res) => {
    res.resume(); // drain response
  }).on('error', (err) => {
    console.error('HTTP command error:', err.message);
  });
  return true;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Denon Client Management ---

let denon = null;
let connected = false;
let state = {
  power: null,
  volume: null,
  mute: null,
  input: null,
  surround: null,
  sdb: null,
};

function parseResponse(data) {
  const lines = data.toString().trim().split('\r');
  const events = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('PW')) {
      state.power = line.substring(2);
      events.push({ type: 'power', value: state.power });
    } else if (line.startsWith('MV') && !line.startsWith('MVMAX')) {
      state.volume = line.substring(2);
      events.push({ type: 'volume', value: state.volume });
    } else if (line.startsWith('MVMAX')) {
      events.push({ type: 'volumeMax', value: line.substring(5) });
    } else if (line.startsWith('MU')) {
      state.mute = line.substring(2);
      events.push({ type: 'mute', value: state.mute });
    } else if (line.startsWith('SI')) {
      state.input = line.substring(2);
      events.push({ type: 'input', value: state.input });
    } else if (line.startsWith('MS') && !line.startsWith('MSQUICK')) {
      state.surround = line.substring(2);
      events.push({ type: 'surround', value: state.surround });
    } else if (line.startsWith('BDSTATUS ')) {
      // Parse CD playback status: BDSTATUS 442000S1TTTTTTTNMMMMSS
      const payload = line.substring(9); // after "BDSTATUS "
      const stateChar = payload.charAt(6); // C=playing, D=paused, B=stopped
      const track = parseInt(payload.substring(8, 15), 10);
      const mins = parseInt(payload.substring(16, 20), 10);
      const secs = parseInt(payload.substring(20, 22), 10);
      const cdTransport = stateChar === 'C' ? 'playing' : stateChar === 'D' ? 'paused' : stateChar === 'B' ? 'stopped' : 'unknown';
      state.cdTrack = track;
      state.cdTime = { mins, secs };
      state.cdTransport = cdTransport;
      events.push({ type: 'cdStatus', track, mins, secs, transport: cdTransport });
    } else if (line.startsWith('NSE') || line.startsWith('NSA')) {
      events.push({ type: 'display', value: line });
    } else if (line.startsWith('PSSDB ')) {
      state.sdb = line.substring(6);
      events.push({ type: 'sdb', value: state.sdb });
    } else if (line.startsWith('PS')) {
      events.push({ type: 'ps', value: line });
    } else if (line.startsWith('SLP')) {
      events.push({ type: 'sleep', value: line.substring(3) });
    }
    // Always forward the raw line
    events.push({ type: 'raw', value: line });
  }
  return events;
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

function connectDenon(host) {
  if (host) denonHost = host;

  if (!denonHost) {
    console.error('No Denon host configured');
    broadcast({ type: 'connection', value: 'no_host' });
    return;
  }

  if (denon) {
    const oldDenon = denon;
    denon = null;
    oldDenon.removeAllListeners();
    try { oldDenon.end(); } catch (e) { /* ignore */ }
  }

  denon = new DenonClient();

  denon.on('connect', () => {
    connected = true;
    console.log(`Connected to Denon at ${denonHost}`);
    broadcast({ type: 'connection', value: 'connected', host: denonHost });
    // Query initial state
    setTimeout(() => {
      sendCommand('PW?');
      setTimeout(() => sendCommand('MV?'), 100);
      setTimeout(() => sendCommand('MU?'), 200);
      setTimeout(() => sendCommand('SI?'), 300);
      setTimeout(() => sendCommand('MS?'), 400);
      setTimeout(() => sendCommand('SLP?'), 500);
      setTimeout(() => sendCommand('PSSDB ?'), 600);
      setTimeout(() => sendCommand('NSE'), 700);
    }, 500);
  });

  denon.on('error', err => {
    console.error('Denon connection error:', err.message);
    connected = false;
    broadcast({ type: 'connection', value: 'error', message: err.message });
  });

  denon.on('close', () => {
    console.log('Denon connection closed');
    connected = false;
    broadcast({ type: 'connection', value: 'disconnected' });
  });

  denon.on('data', buffer => {
    const events = parseResponse(buffer);
    for (const event of events) {
      broadcast(event);
    }
  });

  denon.connect(denonHost).catch(err => {
    console.error('Failed to connect to Denon:', err.message);
    connected = false;
  });
}

function sendCommand(cmd) {
  // Query commands (ending with ?) go via telnet if connected, so we get the response on the event stream
  // All other commands go via HTTP (fire-and-forget, no connection limit)
  if (cmd.endsWith('?') || cmd === 'NSE') {
    if (denon && connected) {
      denon.command(cmd);
      return true;
    }
    // Fallback: send via HTTP even for queries (won't get response but at least it executes)
    return sendHttpCommand(cmd);
  }
  return sendHttpCommand(cmd);
}

// --- REST API ---

app.get('/api/status', (req, res) => {
  res.json({ connected, state, host: denonHost, httpAvailable: !!denonHost });
});

// Discovery endpoint
app.post('/api/discover', async (req, res) => {
  try {
    broadcast({ type: 'discovery', value: 'scanning' });
    const devices = await discover();
    broadcast({ type: 'discovery', value: 'done', devices });
    res.json({ ok: true, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Connect to a specific host (or reconnect to current)
app.post('/api/connect', (req, res) => {
  const { host } = req.body || {};
  connectDenon(host || denonHost);
  res.json({ ok: true, host: denonHost });
});

app.post('/api/command', (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  if (!denonHost) return res.status(503).json({ error: 'No Denon host configured' });
  const ok = sendCommand(cmd);
  if (!ok) return res.status(503).json({ error: 'Failed to send command' });
  res.json({ ok: true, cmd });
});

// Power
app.post('/api/power/on', (req, res) => {
  sendCommand('PWON');
  res.json({ ok: true });
});

app.post('/api/power/off', (req, res) => {
  sendCommand('PWSTANDBY');
  res.json({ ok: true });
});

// Volume
app.post('/api/volume/up', (req, res) => {
  sendCommand('MVUP');
  res.json({ ok: true });
});

app.post('/api/volume/down', (req, res) => {
  sendCommand('MVDOWN');
  res.json({ ok: true });
});

app.post('/api/volume/set', (req, res) => {
  const { level } = req.body;
  const parsed = parseInt(level, 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    return res.status(400).json({ ok: false, error: 'Invalid volume level' });
  }
  const val = Math.max(0, Math.min(98, parsed));
  const padded = val.toString().padStart(2, '0');
  sendCommand(`MV${padded}`);
  res.json({ ok: true, level: val });
});

// Mute
app.post('/api/mute/toggle', (req, res) => {
  if (state.mute === 'ON') {
    sendCommand('MUOFF');
  } else {
    sendCommand('MUON');
  }
  res.json({ ok: true });
});

// Input source
app.post('/api/input/:source', (req, res) => {
  const source = req.params.source.toUpperCase();
  sendCommand(`SI${source}`);
  // Query display info after input switch so UI gets source status
  setTimeout(() => sendCommand('NSE'), 500);
  res.json({ ok: true, source });
});


// Playback — source-aware: CD uses BD prefix, others use NS prefix
app.post('/api/playback/:action', (req, res) => {
  const isCd = state.input && state.input.toUpperCase() === 'CD';
  const nsActions = {
    play: 'NS9A',
    pause: 'NS9B',
    stop: 'NS9C',
    next: 'NS9D',
    prev: 'NS9E',
    repeat: 'NSRPT',
    random: 'NSRND',
  };
  const bdActions = {
    play: 'BDPLAY',
    pause: 'BDPAUSE',
    stop: 'BDSTOP',
    next: 'BDSKIP +',
    prev: 'BDSKIP -',
    repeat: 'BDREPEAT',
    random: 'BDRANDOM',
  };
  const actions = isCd ? bdActions : nsActions;
  const cmd = actions[req.params.action];
  if (!cmd) return res.status(400).json({ error: 'Unknown action' });
  sendCommand(cmd);
  res.json({ ok: true });
});

// Surround mode
app.post('/api/surround/:mode', (req, res) => {
  const aliases = {
    movie: 'MOVIE', music: 'MUSIC', game: 'GAME',
    direct: 'DIRECT', stereo: 'STEREO', standard: 'STANDARD',
    mchstereo: 'MCH STEREO', dolby: 'DOLBY DIGITAL',
    dts: 'DTS SURROUND', rock: 'ROCK ARENA', jazz: 'JAZZ CLUB',
    virtual: 'VIRTUAL', matrix: 'MATRIX',
  };
  const mode = aliases[req.params.mode.toLowerCase()] || req.params.mode.toUpperCase();
  sendCommand(`MS${mode}`);
  res.json({ ok: true, mode });
});

// SDB tone toggle
app.post('/api/sdb/toggle', (req, res) => {
  if (state.sdb === 'ON') {
    sendCommand('PSSDB OFF');
  } else {
    sendCommand('PSSDB ON');
  }
  res.json({ ok: true });
});

// Tone controls
app.post('/api/tone/bass/:direction', (req, res) => {
  const dir = req.params.direction.toUpperCase();
  if (dir === 'UP' || dir === 'DOWN') {
    sendCommand(`PSBAS ${dir}`);
  }
  res.json({ ok: true });
});

app.post('/api/tone/treble/:direction', (req, res) => {
  const dir = req.params.direction.toUpperCase();
  if (dir === 'UP' || dir === 'DOWN') {
    sendCommand(`PSTRE ${dir}`);
  }
  res.json({ ok: true });
});

// Sleep timer
app.post('/api/sleep/:minutes', (req, res) => {
  const min = req.params.minutes;
  if (min === 'off' || min === 'OFF') {
    sendCommand('SLPOFF');
  } else {
    const parsed = parseInt(min, 10);
    if (Number.isNaN(parsed)) {
      return res.status(400).json({ error: 'Invalid minutes value' });
    }
    const val = Math.max(1, Math.min(120, parsed));
    const padded = val.toString().padStart(3, '0');
    sendCommand(`SLP${padded}`);
  }
  res.json({ ok: true });
});

// Source menu navigation (NS cursor for network sources)
app.post('/api/nav/:action', (req, res) => {
  const actions = {
    up: 'NS90', down: 'NS91', left: 'NS92', right: 'NS93',
    enter: 'NS94', back: 'NS92',
    play: 'NS9A', pause: 'NS9B', stop: 'NS9C',
    pageup: 'NS9X', pagedown: 'NS9Y',
    mode: 'NS97', favorite: 'NS98',
  };
  const cmd = actions[req.params.action];
  if (!cmd) return res.status(400).json({ error: 'Unknown nav action' });
  sendCommand(cmd);
  res.json({ ok: true });
});

// System menu navigation (MN commands for receiver setup)
app.post('/api/menu/:action', (req, res) => {
  const actions = {
    up: 'MNCUP', down: 'MNCDN', left: 'MNCLT', right: 'MNCRT',
    enter: 'MNENT', return: 'MNRTN', option: 'MNOPT', info: 'MNINF',
    menuon: 'MNMEN ON', menuoff: 'MNMEN OFF',
  };
  const cmd = actions[req.params.action];
  if (!cmd) return res.status(400).json({ error: 'Unknown menu action' });
  sendCommand(cmd);
  setTimeout(() => sendCommand('NSE'), 300);
  res.json({ ok: true });
});

// Query / refresh state
app.post('/api/refresh', (req, res) => {
  sendCommand('PW?');
  setTimeout(() => sendCommand('MV?'), 50);
  setTimeout(() => sendCommand('MU?'), 100);
  setTimeout(() => sendCommand('SI?'), 150);
  setTimeout(() => sendCommand('MS?'), 200);
  res.json({ ok: true });
});

// --- WebSocket ---

wss.on('connection', ws => {
  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'connection',
    value: connected ? 'connected' : (denonHost ? 'disconnected' : 'no_host'),
    host: denonHost,
    httpAvailable: !!denonHost,
  }));
  ws.send(JSON.stringify({ type: 'state', value: state }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.cmd) {
        sendCommand(data.cmd);
      }
    } catch (e) {
      // Raw command string
      sendCommand(msg.toString());
    }
  });
});

// --- Start ---

async function start() {
  // If no host configured, auto-discover
  if (!denonHost) {
    console.log('No DENON_HOST set, running auto-discovery...');
    try {
      const devices = await discover();
      if (devices.length > 0) {
        denonHost = devices[0].ip;
        console.log(`Auto-discovered Denon at ${denonHost} (${devices[0].name})`);
      } else {
        console.log('No Denon receivers found. Set DENON_HOST or use the web UI to connect manually.');
      }
    } catch (err) {
      console.error('Discovery failed:', err.message);
    }
  }

  server.listen(PORT, () => {
    console.log(`Denon CEOL N7 Remote running on http://0.0.0.0:${PORT}`);
    if (denonHost) {
      console.log(`Connecting to Denon at ${denonHost}...`);
      connectDenon();
    } else {
      console.log('Waiting for manual connection - open the web UI to discover or enter an IP.');
    }
  });
}

start();
