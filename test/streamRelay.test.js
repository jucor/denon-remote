'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createStreamRelay } = require('../lib/streamRelay');

// Upstream radio server: /icy (ICY metadata when asked), /redirect -> /icy, /list.pls -> /icy.
async function upstream() {
  const seen = { closed: 0, icyAsked: [] };
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${base}/icy` }); return res.end(); }
    if (req.url === '/list.pls') {
      res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
      return res.end(`[playlist]\nNumberOfEntries=1\nFile1=${base}/icy\nTitle1=Test\n`);
    }
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U\n#EXTINF:-1,Test\n${base}/icy\n`);
    }
    if (req.url !== '/icy') { res.writeHead(404); return res.end(); }
    const icy = req.headers['icy-metadata'] === '1';
    seen.icyAsked.push(icy);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...(icy ? { 'icy-metaint': '8' } : {}) });
    const meta = Buffer.alloc(1 + 32); meta[0] = 2; meta.write("StreamTitle='Song A';", 1);
    let n = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(8, 65 + (n++ % 26)));
      if (icy) res.write(meta);
    }, 5);
    req.on('close', () => { clearInterval(timer); seen.closed++; });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}

async function relayApp(opts) {
  const relay = createStreamRelay({ allowPrivateHosts: true, ...opts });
  const app = express();
  app.get('/stream/:id', relay.handler);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { relay, base: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}

// Read `n` bytes of a GET, then abort.
function readBytes(url, n) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      let got = 0;
      res.on('data', (c) => {
        chunks.push(c); got += c.length;
        if (got >= n) { req.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).subarray(0, n) }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

test('relays only audio (ICY metadata stripped) and reports the song title', async () => {
  const up = await upstream();
  const titles = [];
  const app = await relayApp({ onTitle: (t) => titles.push(t) });
  try {
    const id = app.relay.register({ url: `${up.base}/icy`, name: 'Test FM' });
    const { status, type, body } = await readBytes(`${app.base}/stream/${id}`, 64);
    assert.equal(status, 200);
    assert.equal(type, 'audio/mpeg');
    assert.ok([...body].every((b) => b >= 65 && b <= 90), 'only audio bytes (A-Z), no metadata');
    assert.deepEqual(up.seen.icyAsked, [true]);
    assert.deepEqual(titles, [{ id, name: 'Test FM', title: 'Song A' }]);
  } finally { await app.close(); await up.close(); }
});

test('follows redirects and .pls / .m3u playlists to the stream', async () => {
  const up = await upstream();
  const app = await relayApp({});
  try {
    for (const path of ['/redirect', '/list.pls', '/list.m3u']) {
      const id = app.relay.register({ url: `${up.base}${path}`, name: path });
      const { status, body } = await readBytes(`${app.base}/stream/${id}`, 16);
      assert.equal(status, 200, path);
      assert.equal(body.length, 16, path);
    }
  } finally { await app.close(); await up.close(); }
});

test('only registered stations are relayed (no open proxy)', async () => {
  const app = await relayApp({});
  try {
    const { status } = await readBytes(`${app.base}/stream/deadbeef`, 1);
    assert.equal(status, 404);
  } finally { await app.close(); }
});

test('closes the upstream connection when the receiver hangs up', async () => {
  const up = await upstream();
  const app = await relayApp({});
  try {
    const id = app.relay.register({ url: `${up.base}/icy`, name: 'x' });
    await readBytes(`${app.base}/stream/${id}`, 16);
    for (let i = 0; i < 50 && up.seen.closed === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(up.seen.closed, 1);
  } finally { await app.close(); await up.close(); }
});

test('an unreachable stream answers 502 rather than hanging', async () => {
  const app = await relayApp({ connectTimeoutMs: 300 });
  try {
    const id = app.relay.register({ url: 'http://127.0.0.1:1/nothing', name: 'x' });
    const { status } = await readBytes(`${app.base}/stream/${id}`, 1);
    assert.equal(status, 502);
  } finally { await app.close(); }
});

test('serves the stream with the registered content type when given (the one the renderer accepted)', async () => {
  const up = await upstream();
  const app = await relayApp({});
  try {
    const id = app.relay.register({ url: `${up.base}/icy`, name: 'x', contentType: 'audio/vnd.dlna.adts' });
    const { type } = await readBytes(`${app.base}/stream/${id}`, 8);
    assert.equal(type, 'audio/vnd.dlna.adts');
  } finally { await app.close(); await up.close(); }
});

test('refuses a LAN/loopback stream by default, even one that answers with audio (no SSRF)', async () => {
  const up = await upstream();
  const relay = createStreamRelay({ connectTimeoutMs: 300 }); // defaults: private hosts refused
  const app = express();
  app.get('/stream/:id', relay.handler);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const id = relay.register({ url: `${up.base}/icy`, name: 'x' });
    const { status } = await readBytes(`http://127.0.0.1:${srv.address().port}/stream/${id}`, 1);
    assert.equal(status, 502);
    assert.deepEqual(up.seen.icyAsked, [], 'the LAN host must not even be contacted');
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); await up.close(); }
});

test('every hop is checked: an allowed host redirecting into the LAN is refused at the redirect', async () => {
  const up = await upstream(); // /redirect -> http://127.0.0.1:<port>/icy
  const relay = createStreamRelay({ allowHosts: ['localhost'] });
  const app = express();
  app.get('/stream/:id', relay.handler);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const port = new URL(up.base).port;
    const id = relay.register({ url: `http://localhost:${port}/redirect`, name: 'x' });
    const { status } = await readBytes(`http://127.0.0.1:${srv.address().port}/stream/${id}`, 1);
    assert.equal(status, 502);
    assert.deepEqual(up.seen.icyAsked, []);
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); await up.close(); }
});

test('isPublicHost classifies addresses and resolved names', async () => {
  const { isPublicHost } = require('../lib/streamRelay');
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.61', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', 'localhost',
    '2002:c0a8:0101::1', '64:ff9b::c0a8:0101', '::c0a8:0101', '0177.0.0.1', '2130706433']) {
    assert.equal(await isPublicHost(h), false, h);
  }
  for (const h of ['8.8.8.8', '2001:4860:4860::8888', 'icecast.radiofrance.fr']) {
    assert.equal(await isPublicHost(h), true, h);
  }
});

// Review finding: a playlist that drips bytes, or overflows the cap, never settled.
test('a playlist that never finishes, or is too big, answers 502 instead of hanging', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    if (req.url === '/drip.m3u') { const t = setInterval(() => res.write('#'), 50); req.on('close', () => clearInterval(t)); return; }
    res.end('#'.repeat(70000)); // over the 64 KiB cap, no URL
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const app = await relayApp({ bodyTimeoutMs: 300 });
  try {
    for (const p of ['/drip.m3u', '/big.m3u']) {
      const id = app.relay.register({ url: `http://127.0.0.1:${srv.address().port}${p}`, name: p });
      const t0 = Date.now();
      const { status } = await readBytes(`${app.base}/stream/${id}`, 1);
      assert.equal(status, 502, p);
      assert.ok(Date.now() - t0 < 2000, `${p} took ${Date.now() - t0} ms`);
    }
  } finally { await app.close(); srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test('an old Shoutcast server answering "ICY 200 OK" is relayed', async () => {
  const net = require('node:net');
  const srv = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write('ICY 200 OK\r\ncontent-type: audio/mpeg\r\n\r\n');
      const t = setInterval(() => sock.write(Buffer.alloc(16, 66)), 10);
      sock.on('close', () => clearInterval(t)); sock.on('error', () => clearInterval(t));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const app = await relayApp({});
  try {
    const id = app.relay.register({ url: `http://127.0.0.1:${srv.address().port}/`, name: 'old' });
    const { status, body } = await readBytes(`${app.base}/stream/${id}`, 32);
    assert.equal(status, 200);
    assert.equal(body.length, 32);
  } finally { await app.close(); await new Promise((r) => srv.close(r)); }
});

test('when the receiver hangs up, onEnd reports the stream id', async () => {
  const up = await upstream();
  const ended = [];
  const app = await relayApp({ onEnd: (id) => ended.push(id) });
  try {
    const id = app.relay.register({ url: `${up.base}/icy`, name: 'x' });
    await readBytes(`${app.base}/stream/${id}`, 16);
    for (let i = 0; i < 50 && !ended.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(ended, [id]);
  } finally { await app.close(); await up.close(); }
});

// --- Geo-blocked stations through an HTTP proxy (gluetun on the NAS) ---
// Seen live: NRJ-group streams answer 403 to UK addresses and 200 through the VPN.

const https = require('node:https');
const tlsFixture = {
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'cert.pem')),
};

// Minimal forward proxy: absolute-URI GET (adds x-via-proxy) and CONNECT tunnels.
async function fakeProxy() {
  const seen = { gets: 0, connects: 0 };
  const tunnels = new Set(); // CONNECT sockets are detached: closeAllConnections() misses them
  const srv = http.createServer((req, res) => {
    seen.gets++;
    const u = new URL(req.url);
    const up = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...req.headers, 'x-via-proxy': '1' } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.on('close', () => up.destroy());
  });
  srv.on('connect', (req, sock, head) => {
    seen.connects++;
    tunnels.add(sock);
    const [host, port] = req.url.split(':');
    // (the test servers listen on 127.0.0.1 only; 'localhost' may resolve to ::1)
    const up = require('node:net').connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    tunnels.add(up);
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    seen, url: `http://127.0.0.1:${srv.address().port}`,
    close: () => { for (const t of tunnels) t.destroy(); srv.closeAllConnections(); return new Promise((r) => srv.close(r)); },
  };
}

function audioHandler(isAllowed) {
  return (req, res) => {
    if (!isAllowed(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const t = setInterval(() => res.write(Buffer.alloc(8, 67)), 5);
    req.on('close', () => clearInterval(t));
  };
}

test('a stream that refuses us (403) plays through the proxy; the host is then proxied directly', async () => {
  let direct = 0;
  const up = http.createServer(audioHandler((req) => { if (req.headers['x-via-proxy']) return true; direct++; return false; }));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await fakeProxy();
  const app = await relayApp({ proxyUrl: proxy.url });
  try {
    for (let i = 0; i < 2; i++) {
      const id = app.relay.register({ url: `http://127.0.0.1:${up.address().port}/live`, name: 'NRJ' });
      const { status, body } = await readBytes(`${app.base}/stream/${id}`, 16);
      assert.equal(status, 200);
      assert.equal(body.length, 16);
    }
    assert.equal(direct, 1, 'second time it must go straight through the proxy');
    assert.equal(proxy.seen.gets, 2);
  } finally { await app.close(); await proxy.close(); up.closeAllConnections(); await new Promise((r) => up.close(r)); }
});

test('an HTTPS stream that refuses us goes through a CONNECT tunnel, certificate still verified', async () => {
  let n = 0;
  const up = https.createServer(tlsFixture, audioHandler(() => n++ > 0)); // first (direct) request refused
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await fakeProxy();
  const app = await relayApp({ proxyUrl: proxy.url, tlsCa: tlsFixture.cert });
  try {
    const id = app.relay.register({ url: `https://localhost:${up.address().port}/live`, name: 'NRJ' });
    const { status, body } = await readBytes(`${app.base}/stream/${id}`, 16);
    assert.equal(status, 200);
    assert.equal(body.length, 16);
    assert.equal(proxy.seen.connects, 1);
  } finally { await app.close(); await proxy.close(); up.closeAllConnections(); await new Promise((r) => up.close(r)); }
});

test('without a proxy configured, a refused stream is still a 502', async () => {
  const up = http.createServer(audioHandler(() => false));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const app = await relayApp({});
  try {
    const id = app.relay.register({ url: `http://127.0.0.1:${up.address().port}/live`, name: 'x' });
    assert.equal((await readBytes(`${app.base}/stream/${id}`, 1)).status, 502);
  } finally { await app.close(); up.closeAllConnections(); await new Promise((r) => up.close(r)); }
});

// --- Saved stations: a stable relay address for entries in stations.ini / bookmark.xml ---

test('the saved-station route relays only URLs the allow-list accepts', async () => {
  const up = await upstream();
  const allowed = new Set([`${up.base}/icy`]);
  const relay = createStreamRelay({ allowPrivateHosts: true, isSavedUrl: async (u) => allowed.has(u) });
  const app = express();
  app.get('/stream/u', relay.savedHandler);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await readBytes(`${base}/stream/u?url=${encodeURIComponent(`${up.base}/icy`)}`, 16);
    assert.equal(ok.status, 200);
    const no = await readBytes(`${base}/stream/u?url=${encodeURIComponent('http://example.com/other')}`, 1);
    assert.equal(no.status, 404);
    assert.equal((await readBytes(`${base}/stream/u`, 1)).status, 404);
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); await up.close(); }
});

test('probe() tells a geo-blocked stream (refused direct, fine via proxy) from a dead one', async () => {
  const blocked = http.createServer(audioHandler((req) => !!req.headers['x-via-proxy']));
  const dead = http.createServer(audioHandler(() => false));
  await Promise.all([blocked, dead].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const proxy = await fakeProxy();
  const relay = createStreamRelay({ allowPrivateHosts: true, proxyUrl: proxy.url });
  try {
    assert.deepEqual(await relay.probe(`http://127.0.0.1:${blocked.address().port}/`), { direct: false, viaProxy: true });
    assert.deepEqual(await relay.probe(`http://127.0.0.1:${dead.address().port}/`), { direct: false, viaProxy: false });
  } finally {
    await proxy.close();
    for (const s of [blocked, dead]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  }
});
