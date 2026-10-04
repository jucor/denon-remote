'use strict';
// Unit tests for lib/bookmarks.js — yTuner's bookmark.xml ("Favourites").
// Fixtures are shaped after what yTuner itself writes (docs/ytuner-bookmarks.md):
// vtuner.pas:178-201 for the Item layout, bookmark.pas:217-222 for the stored values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bookmarks = require('../lib/bookmarks');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-'));
  return path.join(dir, 'bookmark.xml');
}

// One Item exactly as yTuner serialises a favourited My Stations entry.
const ITEM_MS = `  <Item>
    <ItemType>Station</ItemType>
    <StationId>MSB1A2B3C4D5E6F</StationId>
    <StationName>Big R Radio - 80s Metal FM</StationName>
    <StationUrl>http://bigr/5186_128</StationUrl>
    <StationDesc>My favorite "Big R Radio - 80s Metal FM"</StationDesc>
    <Logo>http://ytunerhost/ytuner/icon?id=MS_1A2B3C4D5E6F</Logo>
    <StationFormat>Julien</StationFormat>
    <StationLocation/>
    <StationBandWidth/>
    <StationMime/>
    <Relia>3</Relia>
    <Bookmark>http://ytunerhost/setupapp/favxml.asp?id=MS_1A2B3C4D5E6F&amp;fav=del</Bookmark>
  </Item>
`;
// And one favourited from radio-browser (RB_ id, location/bitrate/mime filled in).
const ITEM_RB = `  <Item>
    <ItemType>Station</ItemType>
    <StationId>RBB960E57C50601</StationId>
    <StationName>FIP Jazz &amp; Blues</StationName>
    <StationUrl>http://icecast.radiofrance.fr/fipjazz-midfi.mp3</StationUrl>
    <StationDesc>FIP Jazz &amp; Blues : https://www.radiofrance.fr/fip</StationDesc>
    <Logo>http://ytunerhost/ytuner/icon?id=RB_960E57C50601</Logo>
    <StationFormat>jazz,fip</StationFormat>
    <StationLocation>France</StationLocation>
    <StationBandWidth>128</StationBandWidth>
    <StationMime>MP3</StationMime>
    <Relia>3</Relia>
    <Bookmark>http://ytunerhost/setupapp/favxml.asp?id=RB_960E57C50601&amp;fav=del</Bookmark>
  </Item>
`;
const xmlOf = (count, ...items) =>
  `<?xml version="1.0"?>\n<ListOfItems>\n  <ItemCount>${count}</ItemCount>\n${items.join('')}</ListOfItems>\n`;

// What yTuner's readers need (bookmark.pas:53, 85-94, 139): ItemCount first and equal to
// the number of Items; every Item's children in the vtuner.pas order, with the unguarded
// StationId / StationName / Logo / Bookmark non-empty (an empty Logo makes GetBookmark
// raise -> 404 for the whole Favourites menu).
const ITEM_TAGS = ['ItemType', 'StationId', 'StationName', 'StationUrl', 'StationDesc', 'Logo',
  'StationFormat', 'StationLocation', 'StationBandWidth', 'StationMime', 'Relia', 'Bookmark'];
function assertYTunerAccepts(xml) {
  const root = xml.match(/<ListOfItems>([\s\S]*)<\/ListOfItems>/);
  assert.ok(root, 'has a ListOfItems root');
  assert.match(root[1].trim(), /^<ItemCount>\d+<\/ItemCount>/, 'ItemCount is the first child');
  const count = Number(root[1].match(/<ItemCount>(\d+)<\/ItemCount>/)[1]);
  const items = [...root[1].matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => m[1]);
  assert.equal(items.length, count, 'ItemCount equals the number of Items');
  for (const body of items) {
    assert.deepEqual([...body.matchAll(/<(\w+)[\s/>]/g)].map((m) => m[1]), ITEM_TAGS);
    for (const tag of ['StationId', 'StationName', 'StationUrl', 'Logo', 'Bookmark']) {
      assert.match(body, new RegExp(`<${tag}>[^<]+</${tag}>`), `${tag} is non-empty`);
    }
    assert.match(body.match(/<StationId>([^<]+)</)[1], /^[A-Z]{2}B[0-9A-F]{12}$/, 'id has the B marker at index 2');
  }
}

test('list returns [] when the file does not exist', () => {
  assert.deepEqual(bookmarks.list(tmpFile()), []);
});

test('list returns [] for an empty file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '');
  assert.deepEqual(bookmarks.list(file), []);
});

test('list parses yTuner-written items: id, decoded name, logo', () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(2, ITEM_MS, ITEM_RB));
  assert.deepEqual(bookmarks.list(file), [
    { id: 'MSB1A2B3C4D5E6F', name: 'Big R Radio - 80s Metal FM', logo: '' },
    { id: 'RBB960E57C50601', name: 'FIP Jazz & Blues', logo: '' },
  ]);
});

test('list keeps a real logo URL but blanks the ytunerhost placeholder', () => {
  const file = tmpFile();
  const withLogo = ITEM_MS.replace('http://ytunerhost/ytuner/icon?id=MS_1A2B3C4D5E6F', 'http://cdn.example/logo.png');
  fs.writeFileSync(file, xmlOf(1, withLogo));
  assert.equal(bookmarks.list(file)[0].logo, 'http://cdn.example/logo.png');
});

test('parse tolerates compact XML, CRLF, a BOM, empty-element spellings and CDATA', () => {
  const compact = '﻿<?xml version="1.0"?><ListOfItems><ItemCount>1</ItemCount><Item>' +
    '<ItemType>Station</ItemType><StationId>MSBAAAAAAAAAAAA</StationId>' +
    '<StationName><![CDATA[Tom & Jerry <FM>]]></StationName><StationUrl>http://x/y</StationUrl>' +
    '<StationDesc></StationDesc><Logo>http://l/1.png</Logo><StationFormat/><StationLocation/>' +
    '<StationBandWidth/><StationMime/><Relia>3</Relia><Bookmark>http://b</Bookmark></Item></ListOfItems>';
  const items = bookmarks.parse(compact.replace(/></g, '>\r\n<'));
  assert.equal(items.length, 1);
  assert.equal(items[0].fields.find(([t]) => t === 'StationName')[1], 'Tom & Jerry <FM>');
  assert.equal(bookmarks.parse(compact).length, 1);
});

test('parse decodes numeric and named entities', () => {
  const xml = xmlOf(1, ITEM_MS.replace('Big R Radio - 80s Metal FM</StationName>', 'A&#38;B &#x41; &lt;&gt; &quot;q&quot; &apos;</StationName>'));
  assert.equal(bookmarks.parse(xml)[0].fields.find(([t]) => t === 'StationName')[1], 'A&B A <> "q" \'');
});

test('parse throws on a file that is not a bookmark list', () => {
  assert.throws(() => bookmarks.parse('<html><body>nope</body></html>'), /bookmark/i);
  assert.throws(() => bookmarks.parse('not xml at all'), /bookmark/i);
  assert.throws(() => bookmarks.parse('<ListOfItems><ItemCount>1</ItemCount><Item><StationId>x'), /bookmark/i);
});

test('list uses the Items actually present, not ItemCount', () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(7, ITEM_MS));
  assert.equal(bookmarks.list(file).length, 1);
});

test('serialise round-trips yTuner output byte-for-byte in structure', () => {
  const xml = xmlOf(2, ITEM_MS, ITEM_RB);
  assert.equal(bookmarks.serialise(bookmarks.parse(xml)), xml);
});

test('stationId: radio-browser uuid -> RBB + first 12 hex of the dashless uuid, uppercased', () => {
  assert.equal(bookmarks.stationId({ name: 'x', url: 'http://x', uuid: '960e57c5-0601-11e8-ae97-52543be04c81' }), 'RBB960E57C50601');
});

test('stationId: no (valid) uuid -> MSB + md5(name+url) first 12, like yTuner MyStations ids', () => {
  const md5 = crypto.createHash('md5').update('Big R Radiohttp://bigr/5186_128').digest('hex').slice(0, 12).toUpperCase();
  assert.equal(bookmarks.stationId({ name: 'Big R Radio', url: 'http://bigr/5186_128' }), `MSB${md5}`);
  assert.equal(bookmarks.stationId({ name: 'Big R Radio', url: 'http://bigr/5186_128', uuid: 'u1' }), `MSB${md5}`);
});

test('add creates the file with an Item yTuner will accept', async () => {
  const file = tmpFile();
  const res = await bookmarks.add(file, { name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', uuid: '960e57c5-0601-11e8-ae97-52543be04c81', favicon: '' });
  assert.equal(res.added, true);
  assert.equal(res.id, 'RBB960E57C50601');
  assert.deepEqual(res.items, [{ id: 'RBB960E57C50601', name: 'FIP Jazz', logo: '' }]);
  const xml = fs.readFileSync(file, 'utf8');
  assertYTunerAccepts(xml);
  assert.match(xml, /<StationUrl>http:\/\/cdn\/jazz\.mp3<\/StationUrl>/);
  // Stored with the placeholder host and the *_ id, ready for yTuner to rewrite on read.
  assert.match(xml, /<Logo>http:\/\/ytunerhost\/ytuner\/icon\?id=RB_960E57C50601<\/Logo>/);
  assert.match(xml, /<Bookmark>http:\/\/ytunerhost\/setupapp\/favxml\.asp\?id=RB_960E57C50601&amp;fav=del<\/Bookmark>/);
  assert.deepEqual(bookmarks.list(file), res.items);
});

test('add: a station without a uuid gets an MS id and falls back to its own favicon as Logo', async () => {
  const file = tmpFile();
  const { id } = await bookmarks.add(file, { name: 'Mine', url: 'http://m/1.mp3', favicon: 'http://m/logo.png' });
  assert.match(id, /^MSB[0-9A-F]{12}$/);
  const xml = fs.readFileSync(file, 'utf8');
  assertYTunerAccepts(xml);
  assert.match(xml, /<Logo>http:\/\/m\/logo\.png<\/Logo>/);
  assert.match(xml, new RegExp(`id=MS_${id.slice(3)}&amp;fav=del`));
});

test('add appends to an existing yTuner file and keeps ItemCount right', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(1, ITEM_MS));
  const { items } = await bookmarks.add(file, { name: 'FIP Jazz', url: 'http://cdn/jazz.mp3' });
  assert.deepEqual(items.map((i) => i.name), ['Big R Radio - 80s Metal FM', 'FIP Jazz']);
  const xml = fs.readFileSync(file, 'utf8');
  assertYTunerAccepts(xml);
  assert.ok(xml.includes(ITEM_MS), 'the existing item is untouched');
});

test('add is idempotent on the station id, like SetBookmark', async () => {
  const file = tmpFile();
  const s = { name: 'FIP Jazz', url: 'http://cdn/jazz.mp3', uuid: '960e57c5-0601-11e8-ae97-52543be04c81' };
  await bookmarks.add(file, s);
  const again = await bookmarks.add(file, s);
  assert.equal(again.added, false);
  assert.equal(again.items.length, 1);
  assertYTunerAccepts(fs.readFileSync(file, 'utf8'));
});

test('add escapes XML-special characters and they round-trip', async () => {
  const file = tmpFile();
  await bookmarks.add(file, { name: 'Rock & Roll <live> "x"', url: 'http://h/s?a=1&b=2' });
  const xml = fs.readFileSync(file, 'utf8');
  assert.match(xml, /Rock &amp; Roll &lt;live&gt;/);
  assert.match(xml, /http:\/\/h\/s\?a=1&amp;b=2/);
  assert.equal(bookmarks.list(file)[0].name, 'Rock & Roll <live> "x"');
  assert.equal(bookmarks.parse(xml)[0].fields.find(([t]) => t === 'StationUrl')[1], 'http://h/s?a=1&b=2');
});

test('add strips control characters from names', async () => {
  const file = tmpFile();
  await bookmarks.add(file, { name: 'Bad\u0000 \u0007Name\n', url: 'http://h/s' });
  assert.equal(bookmarks.list(file)[0].name, 'Bad Name');
});

test('add rejects missing name, missing url, and non-http(s) urls with status 400', async () => {
  const file = tmpFile();
  for (const bad of [{ url: 'http://x' }, { name: 'x' }, { name: 'x', url: 'rtsp://x' }, { name: '  ', url: 'http://x' }]) {
    await assert.rejects(() => bookmarks.add(file, bad), (e) => e.status === 400);
  }
  assert.equal(fs.existsSync(file), false);
});

test('add refuses past the limit (yTuner BookmarkStationsLimit) with status 409', async () => {
  const file = tmpFile();
  await bookmarks.add(file, { name: 'A', url: 'http://x/a' }, { limit: 2 });
  await bookmarks.add(file, { name: 'B', url: 'http://x/b' }, { limit: 2 });
  await assert.rejects(() => bookmarks.add(file, { name: 'C', url: 'http://x/c' }, { limit: 2 }), (e) => e.status === 409);
  assert.equal(bookmarks.list(file).length, 2);
  assert.equal(bookmarks.LIMIT, 100);
});

test('add refuses to overwrite a file that is not a bookmark list', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '<html>oops</html>');
  await assert.rejects(() => bookmarks.add(file, { name: 'A', url: 'http://x/a' }), /bookmark/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '<html>oops</html>');
});

test('remove drops the item and updates ItemCount', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(2, ITEM_MS, ITEM_RB));
  const items = await bookmarks.remove(file, 'MSB1A2B3C4D5E6F');
  assert.deepEqual(items.map((i) => i.id), ['RBB960E57C50601']);
  assert.equal(fs.readFileSync(file, 'utf8'), xmlOf(1, ITEM_RB));
});

test('remove of the last item deletes the file, like SetBookmark', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(1, ITEM_MS));
  assert.deepEqual(await bookmarks.remove(file, 'MSB1A2B3C4D5E6F'), []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(bookmarks.list(file), []);
});

test('remove of an unknown id (or from a missing file) rejects with 404 and writes nothing', async () => {
  const file = tmpFile();
  await assert.rejects(() => bookmarks.remove(file, 'MSBNOPE'), (e) => e.status === 404);
  fs.writeFileSync(file, xmlOf(1, ITEM_MS));
  await assert.rejects(() => bookmarks.remove(file, 'MSBNOPE'), (e) => e.status === 404);
  assert.equal(fs.readFileSync(file, 'utf8'), xmlOf(1, ITEM_MS));
});

test('writes are atomic: no .tmp left behind, and concurrent adds are all kept', async () => {
  const file = tmpFile();
  await Promise.all(Array.from({ length: 25 }, (_, i) => bookmarks.add(file, { name: `Station ${i}`, url: `http://x/${i}` })));
  assert.equal(bookmarks.list(file).length, 25);
  assertYTunerAccepts(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['bookmark.xml']);
});

test('concurrent add + remove stay consistent', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, xmlOf(1, ITEM_MS));
  await Promise.all([
    bookmarks.add(file, { name: 'New', url: 'http://x/new' }),
    bookmarks.remove(file, 'MSB1A2B3C4D5E6F'),
  ]);
  assert.deepEqual(bookmarks.list(file).map((i) => i.name), ['New']);
});
