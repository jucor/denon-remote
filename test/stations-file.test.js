'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listStationsFromFile,
  addStationToFile,
  removeStationFromFile,
} = require('../lib/stations');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stations-'));
  return path.join(dir, 'stations.ini');
}

test('addStationToFile creates the file when it does not exist', async () => {
  const file = tmpFile();
  await addStationToFile(file, 'Julien', { name: 'FIP', url: 'http://x/1.mp3' });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(listStationsFromFile(file), [
    { category: 'Julien', name: 'FIP', url: 'http://x/1.mp3', logo: '' },
  ]);
});

test('addStationToFile round-trips through disk and appends', async () => {
  const file = tmpFile();
  await addStationToFile(file, 'Julien', { name: 'A', url: 'http://x/a.mp3' });
  await addStationToFile(file, 'Julien', { name: 'B', url: 'http://x/b.mp3' });
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.match(onDisk, /\[Julien\]/);
  assert.deepEqual(listStationsFromFile(file).map((s) => s.name), ['A', 'B']);
});

test('removeStationFromFile persists the removal to disk', async () => {
  const file = tmpFile();
  await addStationToFile(file, 'Julien', { name: 'A', url: 'http://x/a.mp3' });
  await addStationToFile(file, 'Julien', { name: 'B', url: 'http://x/b.mp3' });
  await removeStationFromFile(file, { name: 'A', url: 'http://x/a.mp3' });
  assert.deepEqual(listStationsFromFile(file).map((s) => s.name), ['B']);
});

test('concurrent addStationToFile calls do not lose updates (mutex)', async () => {
  const file = tmpFile();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      addStationToFile(file, 'Julien', { name: `S${i}`, url: `http://x/${i}.mp3` }),
    ),
  );
  assert.equal(listStationsFromFile(file).length, 20);
});

test('addStationToFile leaves no temp file behind', async () => {
  const file = tmpFile();
  await addStationToFile(file, 'Julien', { name: 'A', url: 'http://x/a.mp3' });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
