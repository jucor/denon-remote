const dgram = require('dgram');
const os = require('os');
const net = require('net');

// --- SSDP Discovery ---
// Denon/Marantz receivers respond to UPnP SSDP M-SEARCH.
// They advertise as MediaRenderer with "Denon" in the server string.

function ssdpDiscover(timeoutMs = 5000) {
  return new Promise(resolve => {
    const found = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const SSDP_ADDR = '239.255.255.250';
    const SSDP_PORT = 1900;
    const searchMsg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: ssdp:all\r\n' +
      '\r\n'
    );

    const seenIps = new Set();

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const lowerText = text.toLowerCase();
      // Look for Denon or Marantz identifiers in the SSDP response
      if (lowerText.includes('denon') || lowerText.includes('marantz')) {
        if (!seenIps.has(rinfo.address)) {
          seenIps.add(rinfo.address);
          // Try to extract a friendly name from the response
          let name = 'Denon receiver';
          const serverMatch = text.match(/SERVER:\s*(.+)/i);
          if (serverMatch) name = serverMatch[1].trim();
          const locationMatch = text.match(/LOCATION:\s*(.+)/i);
          found.push({
            ip: rinfo.address,
            name,
            location: locationMatch ? locationMatch[1].trim() : null,
            method: 'ssdp',
          });
        }
      }
    });

    socket.on('error', () => {
      // Ignore SSDP errors
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(searchMsg, 0, searchMsg.length, SSDP_PORT, SSDP_ADDR);
      // Send a second search after 1s for reliability
      setTimeout(() => {
        try {
          socket.send(searchMsg, 0, searchMsg.length, SSDP_PORT, SSDP_ADDR);
        } catch (e) { /* socket may be closed */ }
      }, 1000);
    });

    setTimeout(() => {
      try { socket.close(); } catch (e) {}
      resolve(found);
    }, timeoutMs);
  });
}

// --- TCP Port Scan ---
// Scan the local /24 subnet for hosts with telnet port 23 open,
// then verify they speak Denon protocol by sending a status query.

function getLocalSubnet() {
  // Allow overriding via environment variable (useful in Docker on macOS
  // where host networking doesn't expose the real LAN interfaces)
  if (process.env.SCAN_SUBNET) {
    return process.env.SCAN_SUBNET;
  }
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.netmask === '255.255.255.0') {
        const parts = iface.address.split('.');
        return parts.slice(0, 3).join('.');
      }
    }
  }
  return null;
}

function probeHost(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let responded = false;
    let data = '';

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      // Send a power status query - any Denon will respond with PW<status>
      socket.write('PW?\r');
    });

    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('PW')) {
        responded = true;
        try { socket.destroy(); } catch (e) {}
        resolve({ ip, denon: true, response: data.trim() });
      }
    });

    socket.on('timeout', () => {
      try { socket.destroy(); } catch (e) {}
      resolve(null);
    });

    socket.on('error', () => {
      try { socket.destroy(); } catch (e) {}
      resolve(null);
    });

    socket.on('close', () => {
      if (!responded) resolve(null);
    });

    socket.connect(23, ip);
  });
}

async function scanSubnet(timeoutMs = 8000) {
  const subnet = getLocalSubnet();
  if (!subnet) {
    console.log('Discovery: Could not determine local subnet');
    return [];
  }

  console.log(`Discovery: Scanning ${subnet}.0/24 for Denon receivers on port 23...`);

  // Scan in batches to avoid socket exhaustion
  const BATCH_SIZE = 30;
  const allIps = [];
  for (let i = 1; i <= 254; i++) {
    allIps.push(`${subnet}.${i}`);
  }

  const found = [];
  const deadline = Date.now() + timeoutMs;

  for (let batch = 0; batch < allIps.length; batch += BATCH_SIZE) {
    if (Date.now() > deadline) break;
    const slice = allIps.slice(batch, batch + BATCH_SIZE);
    const results = await Promise.all(
      slice.map(ip => probeHost(ip, 1200))
    );
    for (const r of results) {
      if (r && r.denon) {
        found.push({ ip: r.ip, name: 'Denon (port 23)', method: 'scan', response: r.response });
      }
    }
    // If we found at least one, we can stop early
    if (found.length > 0) break;
  }

  return found;
}

// --- Combined Discovery ---

async function discover(timeoutMs = 6000) {
  console.log('Discovery: Starting SSDP search...');

  // Run SSDP and subnet scan in parallel
  const [ssdpResults, scanResults] = await Promise.all([
    ssdpDiscover(timeoutMs),
    scanSubnet(timeoutMs + 2000),
  ]);

  // Merge and deduplicate by IP
  const seen = new Set();
  const all = [];

  // Prefer SSDP results (they have better names)
  for (const r of ssdpResults) {
    if (!seen.has(r.ip)) {
      seen.add(r.ip);
      all.push(r);
    }
  }
  for (const r of scanResults) {
    if (!seen.has(r.ip)) {
      seen.add(r.ip);
      all.push(r);
    }
  }

  console.log(`Discovery: Found ${all.length} device(s):`, all.map(d => `${d.ip} (${d.name})`).join(', ') || 'none');
  return all;
}

module.exports = { discover, ssdpDiscover, scanSubnet };
