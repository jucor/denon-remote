'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { playUri, didl } = require('../lib/upnpRenderer');

async function fakeRenderer(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ path: req.url, action: req.headers.soapaction, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}/AVTransport/ctrl`, close: () => new Promise((r) => srv.close(r)) };
}

const ok = (res) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end('<s:Envelope><s:Body/></s:Envelope>'); };

test('playUri sets the transport URI with escaped DIDL metadata, then plays', async () => {
  const r = await fakeRenderer((req, res) => ok(res));
  try {
    await playUri({ controlUrl: r.url, uri: 'http://nas:3002/api/radio/stream/ab12', title: 'Rock & <Roll>', mime: 'audio/mpeg' });
    assert.deepEqual(r.calls.map((c) => c.action), [
      '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"',
      '"urn:schemas-upnp-org:service:AVTransport:1#Play"',
    ]);
    const set = r.calls[0].body;
    assert.match(set, /<CurrentURI>http:\/\/nas:3002\/api\/radio\/stream\/ab12<\/CurrentURI>/);
    // DIDL is XML inside XML: escaped once inside the DIDL, once more inside the SOAP body.
    assert.match(set, /&lt;dc:title&gt;Rock &amp;amp; &amp;lt;Roll&amp;gt;&lt;\/dc:title&gt;/);
    assert.match(set, /protocolInfo=&quot;http-get:\*:audio\/mpeg:\*&quot;/);
  } finally {
    await r.close();
  }
});

test('a SOAP fault is reported with its description', async () => {
  const r = await fakeRenderer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/xml' });
    res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>714</errorCode><errorDescription>Illegal MIME-type</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
  });
  try {
    await assert.rejects(playUri({ controlUrl: r.url, uri: 'http://x/y', title: 't', mime: 'audio/mpeg' }), /Illegal MIME-type \(714\)/);
  } finally {
    await r.close();
  }
});

test('didl() marks the item as an audio broadcast', () => {
  assert.match(didl({ uri: 'http://a/b', title: 'X', mime: 'audio/aac' }), /object\.item\.audioItem\.audioBroadcast/);
});
