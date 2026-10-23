'use strict';

// Which hosts POST /api/connect may point the server at. The route has no login, and the
// host is pasted into http://${host}/goform/..., http://${host}:8080/AVTransport/ctrl and a
// telnet socket, so it must be a bare home-LAN IPv4: no hostname (container names resolve to
// the Docker networks, where gluetun and the *arr apps live), no port, path or credentials,
// and none of Docker's 172.16.0.0/12.

const net = require('net');

const LAN = new net.BlockList();
LAN.addSubnet('192.168.0.0', 16, 'ipv4');
LAN.addSubnet('10.0.0.0', 8, 'ipv4');

function isReceiverAddress(host) {
  if (typeof host !== 'string') return false;
  // Dotted decimal only, no leading zeros: refuses octal/hex/integer forms outright.
  if (!/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return false;
  return LAN.check(host, 'ipv4') && host !== '192.168.255.255' && host !== '10.255.255.255';
}

module.exports = { isReceiverAddress };
