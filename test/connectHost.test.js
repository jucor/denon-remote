'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isReceiverAddress } = require('../lib/connectHost');

// POST /api/connect {host} has no login, and the host goes straight into
// http://${host}/goform/..., http://${host}:8080/AVTransport/ctrl and a telnet socket.
// Anything but a bare home-LAN IPv4 would let a caller aim those at the server's
// container neighbours (gluetun, the *arr apps) or anywhere else (security review).

test('a bare home-LAN IPv4 is a receiver address', () => {
  for (const ip of ['192.168.1.11', '192.168.0.1', '10.0.0.5']) assert.equal(isReceiverAddress(ip), true, ip);
});

test('hostnames are refused: container names resolve to the Docker networks', () => {
  for (const h of ['gluetun', 'sonarr', 'denon.local', 'localhost']) assert.equal(isReceiverAddress(h), false, h);
});

test('a port, path, query, fragment or credentials smuggled into the host is refused', () => {
  for (const h of ['192.168.1.11:8000', '192.168.1.11/v1/openvpn/status#', '192.168.1.11?x=1',
    '192.168.1.11#', 'user@192.168.1.11', 'gluetun:8000/v1/vpn/status#', ' 192.168.1.11', '192.168.1.11 ']) {
    assert.equal(isReceiverAddress(h), false, JSON.stringify(h));
  }
});

test('Docker, loopback, link-local, tailnet and public addresses are refused', () => {
  for (const ip of ['172.31.0.5', '172.17.0.1', '172.30.0.1', '127.0.0.1', '169.254.1.1',
    '100.94.48.7', '8.8.8.8', '0.0.0.0', '255.255.255.255']) {
    assert.equal(isReceiverAddress(ip), false, ip);
  }
});

test('non-canonical IPv4 forms and IPv6 are refused', () => {
  for (const h of ['0300.0250.1.11', '0xc0.168.1.11', '3232235787', '192.168.1', '192.168.1.011',
    '::ffff:192.168.1.11', '[::1]', 'fe80::1']) {
    assert.equal(isReceiverAddress(h), false, h);
  }
});

test('anything that is not a string is refused', () => {
  for (const v of [undefined, null, 42, ['192.168.1.11'], { host: '192.168.1.11' }]) {
    assert.equal(isReceiverAddress(v), false, JSON.stringify(v));
  }
});
