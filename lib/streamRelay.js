'use strict';

// Relays an internet-radio stream to the receiver's UPnP renderer, which cannot play most
// Icecast URLs directly: it asks for ICY metadata (as "WinampMPEG/2.8") and then cannot
// parse it, and it cannot play HTTPS. The relay fetches the stream itself, follows
// redirects and .pls/.m3u playlists, strips the metadata (reporting song titles via
// onTitle) and serves plain audio over HTTP.
//
// Only stations registered through register() are relayed: this is not an open proxy.
// And every hop (the URL, each redirect, each playlist entry) must resolve to a public
// address: the remote has no login, so it must not become a way to make the server
// fetch LAN pages (SSRF). The connection goes to the very address that was checked.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const PRIVATE = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(addr, bits, 'ipv4');
// IPv6, including forms that embed an IPv4 address (IPv4-compatible ::/96, NAT64,
// 6to4, Teredo), which could otherwise smuggle a LAN address past the check.
for (const [addr, bits] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32], ['100::', 64]]) {
  PRIVATE.addSubnet(addr, bits, 'ipv6');
}

function isPublicAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = net.isIP(address);
  if (!family) return false;
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Resolve `host` and return its first address if all of them are public, else null.
// Resolve `host`; return all its addresses (IPv4 first) if every one is public, else null.
// IPv4 first: the NAS container often has no IPv6 route, and a plain http.get would have
// fallen back to IPv4 too.
async function publicAddresses(host) {
  // Normalise like a URL would (octal/hex/integer IPv4 such as 0177.0.0.1 -> 127.0.0.1).
  let normal = host;
  try { normal = new URL(`http://${host}/`).hostname; } catch (e) { /* bare IPv6: as is */ }
  const bare = normal.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return isPublicAddress(bare) ? [{ address: bare, family: net.isIP(bare) }] : null;
  let all;
  try { all = await dns.lookup(bare, { all: true }); } catch (e) { return null; }
  if (!all.length || !all.every((a) => isPublicAddress(a.address))) return null;
  return [...all].sort((a, b) => a.family - b.family);
}

async function isPublicHost(host) {
  return (await publicAddresses(host)) !== null;
}

const { IcyStripper } = require('./icy');

const MAX_STATIONS = 20;
const MAX_PLAYLIST_BYTES = 65536;
const PLAYLIST_TYPES = /mpegurl|scpls|x-pls|vnd\.apple/i;

function firstUrlInPlaylist(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^File\d+=(.+)$/i.exec(line) || (/^https?:\/\//i.test(line) ? [line, line] : null);
    if (m && /^https?:\/\//i.test(m[1].trim())) return m[1].trim();
  }
  return null;
}

// Read a (small) body completely, or fail: too big, too slow, or cut short.
function readBody(stream, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const fail = (err) => { clearTimeout(timer); stream.destroy(); reject(err); };
    const timer = setTimeout(() => fail(new Error('Playlist did not arrive in time')), timeoutMs);
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) return fail(new Error('Playlist too large'));
      chunks.push(c);
    });
    stream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    stream.on('error', (e) => fail(e));
    stream.on('close', () => { if (stream.readableEnded) return; fail(new Error('Playlist cut short')); });
  });
}

function createStreamRelay({
  onTitle = () => {}, onEnd = () => {}, connectTimeoutMs = 8000, bodyTimeoutMs = 5000,
  maxRedirects = 5, userAgent = 'denon-remote/2.0',
  allowPrivateHosts = false, // tests only
  allowHosts = [],           // hostnames exempt from the public-address check (tests only)
  proxyUrl = '',             // HTTP proxy for streams that refuse us (geo-blocks), e.g. gluetun
  tlsCa,                     // extra CA for HTTPS upstreams (tests only)
  isSavedUrl = async () => false, // allow-list for the saved-station route (savedHandler)
} = {}) {
  const stations = new Map(); // id -> { url, name, contentType }
  const proxied = new Set();  // hosts that refused us directly and play through the proxy
  const proxy = proxyUrl ? new URL(proxyUrl) : null;

  // contentType: the MIME type to serve (the one the renderer accepted); else upstream's.
  function register({ url, name, contentType }) {
    const id = crypto.randomBytes(6).toString('hex');
    stations.set(id, { url, name, contentType });
    while (stations.size > MAX_STATIONS) stations.delete(stations.keys().next().value);
    return id;
  }

  const requestHeaders = { 'Icy-MetaData': '1', 'User-Agent': userAgent, Accept: '*/*' };

  // GET with Node's HTTP client -> { statusCode, headers, stream, close }.
  function httpGet(target, addresses) {
    const lib = target.protocol === 'https:' ? https : http;
    const lookup = addresses && ((_host, opts, cb) => (opts && opts.all
      ? cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
      : cb(null, addresses[0].address, addresses[0].family)));
    return new Promise((resolve, reject) => {
      const req = lib.get(target, { headers: requestHeaders, ...(lookup ? { lookup } : {}), ...(tlsCa ? { ca: tlsCa } : {}) }, (res) => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, stream: res, close: () => req.destroy() });
      });
      const timer = setTimeout(() => req.destroy(new Error('Stream did not answer')), connectTimeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  // The same GET through the HTTP proxy, still to the address that was checked: plain HTTP as
  // an absolute-URI request; HTTPS through a CONNECT tunnel, the certificate verified for the
  // real hostname. (Seen live: NRJ streams refuse UK addresses, play through the NAS's VPN.)
  function proxyGet(target, addresses) {
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const a = addresses && addresses[0];
    const hostForConn = a ? (a.family === 6 ? `[${a.address}]` : a.address) : target.hostname;
    return new Promise((resolve, reject) => {
      let req;
      const fail = (e) => { clearTimeout(timer); if (req) req.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error('Stream did not answer (via proxy)')), connectTimeoutMs);
      const done = (res, r) => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, stream: res, close: () => r.destroy() });
      };
      if (target.protocol === 'http:') {
        req = http.get({
          host: proxy.hostname, port: proxy.port || 80,
          path: `http://${hostForConn}:${port}${target.pathname}${target.search}`,
          headers: { ...requestHeaders, Host: target.host },
        }, (res) => done(res, req));
        req.on('error', fail);
        return;
      }
      req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${hostForConn}:${port}` });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return fail(new Error(`Proxy refused the tunnel (HTTP ${res.statusCode})`)); }
        const inner = https.get(target, {
          headers: requestHeaders, agent: false, ...(tlsCa ? { ca: tlsCa } : {}), // https checks these too
          createConnection: () => tls.connect({ socket, servername: target.hostname, ...(tlsCa ? { ca: tlsCa } : {}) }),
        }, (r) => done(r, inner));
        inner.on('error', fail);
      });
      req.on('error', fail);
      req.end();
    });
  }

  // Old Shoutcast servers answer "ICY 200 OK", which Node's HTTP parser rejects: speak the
  // request by hand over a socket to the checked address and parse the head ourselves.
  function rawGet(target, addresses) {
    return new Promise((resolve, reject) => {
      const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
      const host = addresses ? addresses[0].address : target.hostname.replace(/^\[|\]$/g, '');
      const sock = target.protocol === 'https:'
        ? tls.connect({ host, port, servername: target.hostname })
        : net.connect({ host, port });
      const timer = setTimeout(() => sock.destroy(new Error('Stream did not answer')), connectTimeoutMs);
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      sock.write(`GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\n`
        + Object.entries(requestHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { if (head.length > 16384) sock.destroy(new Error('Bad stream response')); return; }
        sock.removeListener('data', onData);
        clearTimeout(timer);
        const lines = head.subarray(0, end).toString('latin1').split('\r\n');
        const m = /^(?:ICY|HTTP\/\d\.\d)\s+(\d{3})/.exec(lines[0]);
        if (!m) { sock.destroy(); return reject(new Error('Bad stream response')); }
        const headers = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        }
        sock.pause();
        const rest = head.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        resolve({ statusCode: Number(m[1]), headers, stream: sock, close: () => sock.destroy() });
      };
      sock.on('data', onData);
    });
  }

  // Resolve to a live audio response: follows redirects and playlists, every hop checked.
  // mode: 'auto' (direct, then the proxy if refused), 'direct' or 'proxy' (probe()).
  async function open(url, depth = 0, mode = 'auto') {
    if (depth > maxRedirects) throw new Error('Too many redirects');
    let target;
    try { target = new URL(url); } catch (e) { throw new Error(`Bad stream URL: ${url}`); }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`Unsupported stream URL: ${url}`);
    let addresses = null; // the checked addresses, used for the connection itself
    if (!allowPrivateHosts && !allowHosts.includes(target.hostname)) {
      addresses = await publicAddresses(target.hostname);
      if (!addresses) throw new Error(`Refusing a non-public stream address: ${target.hostname}`);
    }
    const viaProxy = proxy && (mode === 'proxy' || (mode === 'auto' && proxied.has(target.host)));
    let up;
    if (viaProxy) {
      up = await proxyGet(target, addresses);
    } else {
      try {
        up = await httpGet(target, addresses);
      } catch (err) {
        if (!/^HPE_/.test(err.code || '')) throw err;
        up = await rawGet(target, addresses);
      }
      if (proxy && mode === 'auto' && (up.statusCode === 403 || up.statusCode === 451)) {
        up.close();
        proxied.add(target.host);
        up = await proxyGet(target, addresses);
      }
    }
    const type = String(up.headers['content-type'] || '');
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      up.close();
      return open(new URL(up.headers.location, target).href, depth + 1, mode);
    }
    if (up.statusCode !== 200) {
      up.close();
      throw new Error(`Stream answered HTTP ${up.statusCode}`);
    }
    if (PLAYLIST_TYPES.test(type) || /\.(m3u8?|pls)(\?|$)/i.test(target.pathname)) {
      const text = await readBody(up.stream, MAX_PLAYLIST_BYTES, bodyTimeoutMs);
      if (/#EXT-X-/.test(text)) throw new Error('HLS streams are not supported');
      const next = firstUrlInPlaylist(text);
      if (!next) throw new Error('Playlist has no stream URL');
      return open(next, depth + 1, mode);
    }
    return { ...up, type };
  }

  async function handler(req, res) {
    const id = req.params.id;
    const station = stations.get(id);
    if (!station) return res.status(404).end();
    return serve(req, res, id, station);
  }

  // GET …/stream/u?url=<stream URL>: the stable address saved in stations.ini / bookmark.xml
  // for geo-blocked stations, so the receiver's own menus play them through the relay too.
  // Only URLs isSavedUrl() finds in those files are relayed.
  async function savedHandler(req, res) {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url || !(await isSavedUrl(url))) return res.status(404).end();
    let name = url;
    try { name = new URL(url).hostname; } catch (e) { return res.status(404).end(); }
    return serve(req, res, 'saved', { url, name });
  }

  // Is the stream playable directly, or only through the proxy? (Adding a station.)
  async function probe(url) {
    try {
      (await open(url, 0, 'direct')).close();
      return { direct: true, viaProxy: false };
    } catch (err) {
      if (!proxy) return { direct: false, viaProxy: false };
    }
    try {
      (await open(url, 0, 'proxy')).close();
      return { direct: false, viaProxy: true };
    } catch (err) {
      return { direct: false, viaProxy: false };
    }
  }

  async function serve(req, res, id, station) {
    let upstream;
    try {
      upstream = await open(station.url);
    } catch (err) {
      console.error(`Relay ${station.name}: ${err.message}`);
      return res.status(502).end();
    }
    if (req.destroyed || res.destroyed) return upstream.close();
    const contentType = station.contentType || upstream.type.split(';')[0].trim() || 'audio/mpeg';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'transferMode.dlna.org': 'Streaming',
    });
    if (req.method === 'HEAD') { upstream.close(); return res.end(); }
    let body = upstream.stream;
    const metaint = Number(upstream.headers['icy-metaint']);
    if (metaint > 0) {
      const strip = new IcyStripper(metaint);
      strip.on('title', (title) => onTitle({ id, name: station.name, title }));
      body = upstream.stream.pipe(strip);
    }
    body.pipe(res);
    upstream.stream.resume();
    res.on('close', () => { upstream.close(); onEnd(id); });
    upstream.stream.on('error', () => res.destroy());
  }

  return { register, handler, savedHandler, probe, get: (id) => stations.get(id) };
}

module.exports = { createStreamRelay, firstUrlInPlaylist, isPublicHost };
