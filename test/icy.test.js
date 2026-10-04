'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IcyStripper } = require('../lib/icy');

// Build an ICY stream: every `metaint` audio bytes, one length byte (n*16) + metadata.
function icyStream(metaint, audioBlocks, titles) {
  const parts = [];
  audioBlocks.forEach((block, i) => {
    parts.push(block);
    const meta = titles[i] === undefined ? '' : `StreamTitle='${titles[i]}';`;
    const len = Math.ceil(Buffer.byteLength(meta) / 16);
    const buf = Buffer.alloc(1 + len * 16);
    buf[0] = len;
    buf.write(meta, 1);
    parts.push(buf);
  });
  return Buffer.concat(parts);
}

async function run(stream, metaint, chunkSize) {
  const s = new IcyStripper(metaint);
  const out = [];
  const titles = [];
  s.on('data', (d) => out.push(d));
  s.on('title', (t) => titles.push(t));
  for (let i = 0; i < stream.length; i += chunkSize) s.write(stream.subarray(i, i + chunkSize));
  s.end();
  await new Promise((r) => s.on('end', r));
  return { audio: Buffer.concat(out), titles };
}

const A = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];

test('strips metadata blocks and keeps the audio bytes intact, for any chunking', async () => {
  const stream = icyStream(16, A, ['Warrant - Heaven', undefined, 'Stryper – Calling On You']);
  for (const chunk of [1, 3, 7, 16, 17, 1000]) {
    const { audio, titles } = await run(stream, 16, chunk);
    assert.deepEqual(audio, Buffer.concat(A), `chunk ${chunk}`);
    assert.deepEqual(titles, ['Warrant - Heaven', 'Stryper – Calling On You'], `chunk ${chunk}`);
  }
});

test('a repeated title is reported once', async () => {
  const { titles } = await run(icyStream(16, A, ['Same', 'Same', 'Other']), 16, 5);
  assert.deepEqual(titles, ['Same', 'Other']);
});

test('titles containing apostrophes are kept whole', async () => {
  const { titles } = await run(icyStream(16, [A[0]], ["Guns N' Roses - Don't Cry"]), 16, 4);
  assert.deepEqual(titles, ["Guns N' Roses - Don't Cry"]);
});
