'use strict';

// Minimal UPnP AVTransport client for the receiver's MediaRenderer (port 8080,
// /AVTransport/ctrl per its /description.xml). SetAVTransportURI + Play makes it play
// any HTTP audio URL on its "Media Server" input. The RCD-N9 rejects the URI unless the
// DIDL-Lite metadata names the MIME type in <res protocolInfo> (tested 2026-10-04).

const SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function didl({ uri, title, mime }) {
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + '<item id="1" parentID="0" restricted="1">'
    + `<dc:title>${xmlEscape(title)}</dc:title>`
    + '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>'
    + `<res protocolInfo="http-get:*:${xmlEscape(mime)}:*">${xmlEscape(uri)}</res>`
    + '</item></DIDL-Lite>';
}

async function soap(controlUrl, action, argsXml, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${SERVICE}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetchImpl(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${SERVICE}#${action}"` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const desc = /<errorDescription>([^<]*)<\/errorDescription>/.exec(text);
    const code = /<errorCode>([^<]*)<\/errorCode>/.exec(text);
    const err = new Error(`Receiver refused ${action}: ${desc ? desc[1] : `HTTP ${res.status}`}${code ? ` (${code[1]})` : ''}`);
    err.status = 502;
    throw err;
  }
  return text;
}

async function playUri({ controlUrl, uri, title, mime, ...opts }) {
  await soap(controlUrl, 'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${xmlEscape(uri)}</CurrentURI>`
    + `<CurrentURIMetaData>${xmlEscape(didl({ uri, title, mime }))}</CurrentURIMetaData>`, opts);
  await soap(controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>', opts);
}

async function stop({ controlUrl, ...opts }) {
  await soap(controlUrl, 'Stop', '<InstanceID>0</InstanceID>', opts);
}

module.exports = { playUri, stop, didl, xmlEscape };
