'use strict';

// Play a stream URL on the receiver's UPnP renderer through our relay. The renderer
// checks the MIME type named in the DIDL metadata against its own list and answers
// UPnP error 714 "Illegal MIME-type" otherwise (seen live: audio/aac is refused). Its
// list (ConnectionManager GetProtocolInfo) names AAC as audio/vnd.dlna.adts, audio/mp4,
// audio/x-mp4 and audio/3gpp, so AAC tries those in turn; the relay serves the stream
// with whichever type was accepted.

const AAC_TYPES = ['audio/vnd.dlna.adts', 'audio/mp4', 'audio/x-mp4', 'audio/3gpp'];

function mimeCandidates(codec) {
  return /aac/i.test(codec || '') ? AAC_TYPES : ['audio/mpeg'];
}

const isMimeRefusal = (err) => /\(714\)|Illegal MIME/i.test(err && err.message);

async function playStreamOnRenderer({ relay, relayBase, controlUrl, name, url, codec, playUri }) {
  let lastErr = null;
  for (const mime of mimeCandidates(codec)) {
    const id = relay.register({ url, name, contentType: mime });
    try {
      await playUri({ controlUrl, uri: `${relayBase}/api/radio/stream/${id}`, title: name, mime });
      return mime;
    } catch (err) {
      if (!isMimeRefusal(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { playStreamOnRenderer, mimeCandidates };
