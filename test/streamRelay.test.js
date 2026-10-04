'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.61', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', 'localhost']) {
    assert.equal(await isPublicHost(h), false, h);
  }
  for (const h of ['8.8.8.8', '2001:4860:4860::8888', 'icecast.radiofrance.fr']) {
    assert.equal(await isPublicHost(h), true, h);
  }
});
