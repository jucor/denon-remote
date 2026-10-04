'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { playStreamOnRenderer, mimeCandidates } = require('../lib/playNow');

function fakes({ accept }) {
  const registered = [];
  const tried = [];
  const relay = { register: (s) => { registered.push(s); return `id${registered.length}`; } };
  const playUri = async ({ uri, mime }) => {
    tried.push({ uri, mime });
    if (!accept(mime)) throw Object.assign(new Error('Receiver refused SetAVTransportURI: Illegal MIME-type (714)'), { status: 502 });
  };
  return { relay, playUri, registered, tried };
}

const base = { relayBase: 'http://nas:3002', controlUrl: 'http://denon:8080/AVTransport/ctrl', name: 'FIP Jazz', url: 'http://x/fipjazz.aac' };

test('MP3 is sent as audio/mpeg, served by the relay with the same type', async () => {
  const f = fakes({ accept: () => true });
  const mime = await playStreamOnRenderer({ ...base, codec: 'MP3', relay: f.relay, playUri: f.playUri });
  assert.equal(mime, 'audio/mpeg');
  assert.deepEqual(f.registered, [{ url: base.url, name: 'FIP Jazz', contentType: 'audio/mpeg' }]);
  assert.deepEqual(f.tried, [{ uri: 'http://nas:3002/api/radio/stream/id1', mime: 'audio/mpeg' }]);
});

test('AAC tries the receiver\'s AAC types in turn until one is accepted (714 = wrong MIME)', async () => {
  // Seen live: audio/aac -> 714 Illegal MIME-type.
  const f = fakes({ accept: (m) => m === 'audio/mp4' });
  const mime = await playStreamOnRenderer({ ...base, codec: 'AAC+', relay: f.relay, playUri: f.playUri });
  assert.equal(mime, 'audio/mp4');
  assert.deepEqual(f.tried.map((t) => t.mime), mimeCandidates('AAC+').slice(0, mimeCandidates('AAC+').indexOf('audio/mp4') + 1));
  assert.equal(f.registered.at(-1).contentType, 'audio/mp4');
});

test('an error other than a MIME refusal is not retried', async () => {
  const f = fakes({ accept: () => true });
  const playUri = async () => { throw Object.assign(new Error('connect EHOSTUNREACH'), { status: 503 }); };
  await assert.rejects(playStreamOnRenderer({ ...base, codec: 'AAC', relay: f.relay, playUri }), /EHOSTUNREACH/);
  assert.equal(f.registered.length, 1);
});

test('when every type is refused, the last refusal is reported', async () => {
  const f = fakes({ accept: () => false });
  await assert.rejects(playStreamOnRenderer({ ...base, codec: 'AAC', relay: f.relay, playUri: f.playUri }), /714/);
  assert.equal(f.tried.length, mimeCandidates('AAC').length);
});

test('unknown codec is treated as MP3 (most streams)', () => {
  assert.deepEqual(mimeCandidates(''), ['audio/mpeg']);
  assert.ok(mimeCandidates('aac').includes('audio/vnd.dlna.adts'));
});
