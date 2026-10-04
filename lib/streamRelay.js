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
async function publicAddress(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return isPublicAddress(bare) ? { address: bare, family: net.isIP(bare) } : null;
  let all;
  try { all = await dns.lookup(bare, { all: true }); } catch (e) { return null; }
  return all.length && all.every((a) => isPublicAddress(a.address)) ? all[0] : null;
}

async function isPublicHost(host) {
  return (await publicAddress(host)) !== null;
}
const { IcyStripper } = require('./icy');

const MAX_STATIONS = 20;
const PLAYLIST_TYPES = /mpegurl|scpls|x-pls|vnd\.apple/i;

function firstUrlInPlaylist(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^File\d+=(.+)$/i.exec(line) || (/^https?:\/\//i.test(line) ? [line, line] : null);
    if (m && /^https?:\/\//i.test(m[1].trim())) return m[1].trim();
  }
  return null;
}

function createStreamRelay({
  onTitle = () => {}, connectTimeoutMs = 8000, maxRedirects = 5, userAgent = 'denon-remote/2.0',
  allowPrivateHosts = false, // tests only
  allowHosts = [],           // hostnames exempt from the public-address check (tests only)
} = {}) {
  const stations = new Map(); // id -> { url, name }

  // contentType: the MIME type to serve (the one the renderer accepted); else upstream's.
  function register({ url, name, contentType }) {
    const id = crypto.randomBytes(6).toString('hex');
    stations.set(id, { url, name, contentType });
    while (stations.size > MAX_STATIONS) stations.delete(stations.keys().next().value);
    return id;
  }

  // Resolve to a live audio response: follows redirects and playlists.
  async function open(url, depth = 0) {
    if (depth > maxRedirects) throw new Error('Too many redirects');
    let target;
    try { target = new URL(url); } catch (e) { throw new Error(`Bad stream URL: ${url}`); }
    const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!lib) throw new Error(`Unsupported stream URL: ${url}`);
    let pinned = null; // the checked address, used for the connection itself
    if (!allowPrivateHosts && !allowHosts.includes(target.hostname)) {
      pinned = await publicAddress(target.hostname);
      if (!pinned) throw new Error(`Refusing a non-public stream address: ${target.hostname}`);
    }
    const lookup = pinned && ((_host, opts, cb) => (opts && opts.all
      ? cb(null, [{ address: pinned.address, family: pinned.family }])
      : cb(null, pinned.address, pinned.family)));
    return new Promise((resolve, reject) => {
      const options = { headers: { 'Icy-MetaData': '1', 'User-Agent': userAgent, Accept: '*/*' }, ...(lookup ? { lookup } : {}) };
      const req = lib.get(target, options, (res) => {
        clearTimeout(timer);
        const type = String(res.headers['content-type'] || '');
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(open(new URL(res.headers.location, target).href, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Stream answered HTTP ${res.statusCode}`));
        }
        if (PLAYLIST_TYPES.test(type) || /\.(m3u8?|pls)(\?|$)/i.test(target.pathname)) {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { text += c; if (text.length > 65536) res.destroy(); });
          res.on('end', () => {
            if (/#EXT-X-/.test(text)) return reject(new Error('HLS streams are not supported'));
            const next = firstUrlInPlaylist(text);
            if (!next) return reject(new Error('Playlist has no stream URL'));
            resolve(open(next, depth + 1));
          });
          return;
        }
        resolve({ res, req, type });
      });
      const timer = setTimeout(() => req.destroy(new Error('Stream did not answer')), connectTimeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  async function handler(req, res) {
    const id = req.params.id;
    const station = stations.get(id);
    if (!station) return res.status(404).end();
    let upstream;
    try {
      upstream = await open(station.url);
    } catch (err) {
      console.error(`Relay ${station.name}: ${err.message}`);
      return res.status(502).end();
    }
    if (req.destroyed || res.destroyed) return upstream.req.destroy();
    const contentType = station.contentType || upstream.type.split(';')[0].trim() || 'audio/mpeg';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'transferMode.dlna.org': 'Streaming',
    });
    if (req.method === 'HEAD') { upstream.req.destroy(); return res.end(); }
    let body = upstream.res;
    const metaint = Number(upstream.res.headers['icy-metaint']);
    if (metaint > 0) {
      const strip = new IcyStripper(metaint);
      strip.on('title', (title) => onTitle({ id, name: station.name, title }));
      body = upstream.res.pipe(strip);
    }
    body.pipe(res);
    const closeUpstream = () => upstream.req.destroy();
    res.on('close', closeUpstream);
    upstream.res.on('error', () => res.destroy());
  }

  return { register, handler, get: (id) => stations.get(id) };
}

module.exports = { createStreamRelay, firstUrlInPlaylist, isPublicHost };
