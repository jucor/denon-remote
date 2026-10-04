const Socket = require('net').Socket;

module.exports = class DenonClient {
  constructor ({ port = 23 } = {}) {
    const socket = new Socket({ allowHalfOpen: true });
    socket.setTimeout(250);
    socket.setEncoding('utf8');

    this.port = port;
    this.socket = socket;
    this.on = socket.on.bind(socket);
    this.end = socket.end.bind(socket);
    this.removeAllListeners = socket.removeAllListeners.bind(socket);
  }

  connect (host) {
    return new Promise(resolve =>
      this.socket.connect(this.port, host, resolve)
    );
  }

  command (cmd) {
    return Promise.resolve(
      this.socket.write(`${cmd}\r`)
    );
  }

  // Let go of this connection for good, even mid-connect. A socket still connecting can
  // emit 'error' (EHOSTUNREACH, ECONNREFUSED) later; with no listener left, Node would
  // throw it and kill the process.
  discard () {
    this.socket.removeAllListeners();
    this.socket.on('error', () => {});
    try { this.socket.end(); } catch (e) { /* ignore */ }
  }
};
