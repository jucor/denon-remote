'use strict';

// Splits the telnet byte stream into CR-terminated lines. A TCP chunk can end mid-line,
// so the trailing partial line is kept until the rest arrives.
class LineSplitter {
  constructor() { this.rest = ''; }

  push(chunk) {
    const parts = (this.rest + chunk).split('\r');
    this.rest = parts.pop();
    return parts.map((l) => l.replace(/^\n+/, '')).filter((l) => l.trim() !== '');
  }
}

module.exports = { LineSplitter };
