'use strict';

// Parsing of formMainZone_MainZoneXmlStatusLite.xml, and the rule for applying it.

function parseHttpStatus(xml) {
  // Simple regex parsing — no XML library needed for this tiny response
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}><value>(.*?)</value></${tag}>`));
    return m ? m[1] : null;
  };

  // Convert dB to Denon scale: -80dB = 0, so the CEOL's 0-60 range is -80..-20 dB
  let volume = null;
  const volumeDb = get('MasterVolume');
  if (volumeDb !== null) {
    const db = parseFloat(volumeDb);
    if (!isNaN(db)) volume = String(Math.round(db + 80)).padStart(2, '0');
  }
  const mute = get('Mute');
  return { power: get('Power'), input: get('InputFuncSelect'), volume, mute: mute === null ? null : mute.toUpperCase() };
}

// Fields of `parsed` that differ from `state`. While telnet is connected it is the source
// of truth: an HTTP poll still in flight when telnet came up must not override it (the
// HTTP API names the iRadio input "NET", which would hide the receiver display).
function httpStatusChanges(parsed, state, { telnetConnected }) {
  if (telnetConnected) return {};
  const changes = {};
  for (const key of ['power', 'input', 'volume', 'mute']) {
    if (parsed[key] !== null && parsed[key] !== state[key]) changes[key] = parsed[key];
  }
  return changes;
}

module.exports = { parseHttpStatus, httpStatusChanges };
