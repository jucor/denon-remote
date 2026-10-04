'use strict';

// Shoutcast/Icecast "ICY" metadata: when a client sends `Icy-MetaData: 1`, the server
// inserts a metadata block after every `icy-metaint` audio bytes: one length byte (n),
// then n*16 bytes such as "StreamTitle='Artist - Song';" padded with NULs.
// The RCD-N9's UPnP renderer asks for metadata but cannot parse it, so the relay strips
// it here and reports the song titles separately.

const { Transform } = require('stream');

function parseStreamTitle(meta) {
  const m = /StreamTitle='([\s\S]*?)';/.exec(meta);
  return m ? m[1].trim() : '';
}

class IcyStripper extends Transform {
  constructor(metaint) {
    super();
    this.metaint = metaint;
    this.audioLeft = metaint; // audio bytes before the next length byte
    this.metaLeft = -1;       // -1: not in a metadata block
    this.meta = [];
    this.lastTitle = null;
  }

  _transform(chunk, _enc, done) {
    let i = 0;
    while (i < chunk.length) {
      if (this.metaLeft < 0 && this.audioLeft > 0) {
        const n = Math.min(this.audioLeft, chunk.length - i);
        this.push(chunk.subarray(i, i + n));
        this.audioLeft -= n;
        i += n;
      } else if (this.metaLeft < 0) {
        this.metaLeft = chunk[i] * 16; // length byte
        i += 1;
        if (this.metaLeft === 0) this._endMeta();
      } else {
        const n = Math.min(this.metaLeft, chunk.length - i);
        this.meta.push(chunk.subarray(i, i + n));
        this.metaLeft -= n;
        i += n;
        if (this.metaLeft === 0) this._endMeta();
      }
    }
    done();
  }

  _endMeta() {
    // Many stations send Latin-1 titles: UTF-8 when it is valid, else Latin-1.
    const bytes = Buffer.concat(this.meta);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = bytes.toString('latin1'); }
    text = text.replace(/\0+$/, '');
    const title = parseStreamTitle(text);
    if (title && title !== this.lastTitle) {
      this.lastTitle = title;
      this.emit('title', title);
    }
    this.meta = [];
    this.metaLeft = -1;
    this.audioLeft = this.metaint;
  }
}

module.exports = { IcyStripper, parseStreamTitle };
