'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const DenonClient = require('../lib/DenonClient');

// A port with nothing listening: connecting fails with ECONNREFUSED after we let go.
async function closedPort() {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// HANDOFF.md: the server stripped every listener from a socket still connecting, so its
// late connect error had no handler and killed the process (container down, 502).
test('discard() on a client still connecting survives its late connect error', async () => {
  const port = await closedPort();
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.prependListener('uncaughtException', onCrash);
  try {
    const client = new DenonClient({ port });
    client.on('error', () => {});
    client.connect('127.0.0.1');
    client.discard();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(crashes.map((e) => e.code), []);
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
});
