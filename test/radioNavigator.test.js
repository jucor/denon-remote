'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { playStation } = require('../lib/radioNavigator');
const { FakeReceiver } = require('./helpers/fakeReceiver');

const BIG_R = 'Big R Radio - 80s Metal FM';
const ELVIS = 'Exclusively Elvis Presley';

function io(fake) {
  return { send: (c) => fake.send(c), onLine: (cb) => fake.onScreen(cb), getInput: () => fake.getInput() };
}

test('plays a station starting from the top iRadio menu', async () => {
  const fake = new FakeReceiver();
  await playStation({ name: ELVIS, category: 'Julien' }, io(fake), { timeoutMs: 500 });
  assert.equal(fake.nowPlaying, ELVIS);
  assert.deepEqual(fake.violations, []);
});

test('backs out of Now Playing (another station) before navigating', async () => {
  const fake = new FakeReceiver({ path: ['My Stations', 'Julien', ELVIS] });
  await playStation({ name: BIG_R, category: 'Julien' }, io(fake), { timeoutMs: 500 });
  assert.equal(fake.nowPlaying, BIG_R);
  assert.deepEqual(fake.violations, []);
});

test('switches to iRadio first when another input is selected', async () => {
  const fake = new FakeReceiver({ input: 'CD' });
  await playStation({ name: BIG_R, category: 'Julien' }, io(fake), { timeoutMs: 500 });
  assert.equal(fake.sent[0], 'SIIRADIO');
  assert.equal(fake.nowPlaying, BIG_R);
});

test('never presses a key while a list is loading (slow yTuner)', async () => {
  const fake = new FakeReceiver({ loadMs: 120 });
  await playStation({ name: BIG_R, category: 'Julien' }, io(fake), { timeoutMs: 1000 });
  assert.deepEqual(fake.violations, []);
  assert.equal(fake.nowPlaying, BIG_R);
});

test('pages down to reach a station beyond the first page', async () => {
  const many = Array.from({ length: 17 }, (_, i) => `Station ${String(i + 1).padStart(2, '0')}`);
  const fake = new FakeReceiver({ stations: many });
  await playStation({ name: 'Station 16', category: 'Julien' }, io(fake), { timeoutMs: 500 });
  assert.equal(fake.nowPlaying, 'Station 16');
  assert.ok(fake.sent.includes('NS9Y'), 'expected a page-down');
  assert.deepEqual(fake.violations, []);
});

test('fails with a clear error, without playing anything, when the station is missing', async () => {
  const fake = new FakeReceiver();
  await assert.rejects(
    playStation({ name: 'No Such Radio', category: 'Julien' }, io(fake), { timeoutMs: 500 }),
    /No Such Radio.*not found/,
  );
  assert.equal(fake.nowPlaying, null);
});

test('fails clearly when the category folder is missing', async () => {
  const fake = new FakeReceiver();
  await assert.rejects(
    playStation({ name: BIG_R, category: 'Nobody' }, io(fake), { timeoutMs: 500 }),
    /Nobody.*not found/,
  );
  assert.equal(fake.nowPlaying, null);
});

test('times out when the receiver sends no screen', async () => {
  const silent = { send() {}, onLine: () => () => {}, getInput: () => 'IRADIO' };
  const t0 = Date.now();
  await assert.rejects(playStation({ name: BIG_R, category: 'Julien' }, silent, { timeoutMs: 150 }), /did not respond/);
  assert.ok(Date.now() - t0 < 1000);
});
