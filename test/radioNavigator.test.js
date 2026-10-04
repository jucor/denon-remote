'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { playStation } = require('../lib/radioNavigator');
const { FakeReceiver } = require('./helpers/fakeReceiver');

const BIG_R = 'Big R Radio - 80s Metal FM';
const ELVIS = 'Exclusively Elvis Presley';
const OPTS = { timeoutMs: 400, scanTimeoutMs: 100, reenterMs: 10 };
const many = (n) => Array.from({ length: n }, (_, i) => `Station ${String(i + 1).padStart(2, '0')}`);

async function play(fake, station, opts = OPTS) {
  try {
    return await playStation({ category: 'Julien', ...station }, fake, opts);
  } finally {
    fake.stop();
  }
}

test('plays a station starting from the top iRadio menu', async () => {
  const fake = new FakeReceiver();
  await play(fake, { name: ELVIS });
  assert.equal(fake.nowPlaying, ELVIS);
  assert.deepEqual(fake.violations, []);
});

test('backs out of Now Playing (another station) before navigating, despite its refreshes', async () => {
  const fake = new FakeReceiver({ path: ['My Stations', 'Julien', ELVIS], nowPlayingRefreshMs: 5 });
  await play(fake, { name: BIG_R });
  assert.equal(fake.nowPlaying, BIG_R);
  assert.deepEqual(fake.violations, []);
});

test('switches to iRadio first when another input is selected', async () => {
  const fake = new FakeReceiver({ input: 'CD' });
  await play(fake, { name: BIG_R });
  assert.equal(fake.sent[0], 'SIIRADIO');
  assert.equal(fake.nowPlaying, BIG_R);
});

test('never presses a key while a list is loading (slow yTuner)', async () => {
  const fake = new FakeReceiver({ loadMs: 120 });
  await play(fake, { name: BIG_R }, { timeoutMs: 1000 });
  assert.deepEqual(fake.violations, []);
  assert.equal(fake.nowPlaying, BIG_R);
});

test('finds a station beyond the visible window (sliding list, no page indicator)', async () => {
  const fake = new FakeReceiver({ stations: many(17) });
  await play(fake, { name: 'Station 16' });
  assert.equal(fake.nowPlaying, 'Station 16');
  assert.deepEqual(fake.violations, []);
});

test('finds a station above the cursor when the cursor starts low in a long list', async () => {
  const fake = new FakeReceiver({ stations: many(17), path: ['My Stations', 'Julien'], cursorAt: 14 });
  await play(fake, { name: 'Station 03' });
  assert.equal(fake.nowPlaying, 'Station 03');
});

test('a name that is the start of another name never plays the wrong one', async () => {
  const names = ['Radio Paradise', ...many(8), 'Radio Paradise Mellow Mix'];
  const fake = new FakeReceiver({ stations: names });
  await play(fake, { name: 'Radio Paradise Mellow Mix' });
  assert.equal(fake.nowPlaying, 'Radio Paradise Mellow Mix');
  const fake2 = new FakeReceiver({ stations: names });
  await play(fake2, { name: 'Radio Paradise' });
  assert.equal(fake2.nowPlaying, 'Radio Paradise');
});

test('matches names the receiver sends double-encoded (UTF-8 read as Latin-1)', async () => {
  const mangle = (s) => Buffer.from(s, 'utf8').toString('latin1');
  const fake = new FakeReceiver({ stations: ['Radio Nova – Jazz', 'Café Müller'], encode: mangle });
  await play(fake, { name: 'Café Müller' });
  assert.equal(fake.nowPlaying, 'Café Müller');
});

test('switching to iRadio that resumes the last station on Now Playing still gets to the station', async () => {
  // Seen live: SIIRADIO from Media Server resumed the previous station instead of the top menu.
  const fake = new FakeReceiver({ input: 'NET', resumeStation: ELVIS, nowPlayingRefreshMs: 5 });
  await play(fake, { name: BIG_R });
  assert.equal(fake.nowPlaying, BIG_R);
  assert.deepEqual(fake.violations, []);
});

test('re-enters iRadio when the top menu came back without yTuner entries', async () => {
  const fake = new FakeReceiver({ ytunerMenu: false });
  await play(fake, { name: BIG_R });
  assert.equal(fake.nowPlaying, BIG_R);
  assert.ok(fake.sent.includes('SIIRADIO'), 'expected iRadio to be re-entered');
});

test('fails with a clear error, without playing anything, when the station is missing', async () => {
  const fake = new FakeReceiver({ stations: many(17) });
  await assert.rejects(play(fake, { name: 'No Such Radio' }), /No Such Radio.*not found/);
  assert.equal(fake.nowPlaying, null);
});

test('fails clearly when the category folder is missing', async () => {
  const fake = new FakeReceiver();
  await assert.rejects(play(fake, { name: BIG_R, category: 'Nobody' }), /Nobody.*not found/);
  assert.equal(fake.nowPlaying, null);
});

test('times out when the receiver sends no screen', async () => {
  const silent = { send() {}, onLine: () => () => {}, getInput: () => 'IRADIO' };
  const t0 = Date.now();
  await assert.rejects(playStation({ name: BIG_R, category: 'Julien' }, silent, { timeoutMs: 150 }), /did not respond/);
  assert.ok(Date.now() - t0 < 1000);
});

test('stops at once, without further key presses, when the connection drops (abort signal)', async () => {
  const fake = new FakeReceiver({ loadMs: 300 });
  const ac = new AbortController();
  const p = play(fake, { name: BIG_R }, { timeoutMs: 2000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error('Telnet connection lost')), 60);
  const t0 = Date.now();
  await assert.rejects(p, /connection lost/);
  assert.ok(Date.now() - t0 < 200);
  const sentAtAbort = fake.sent.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fake.sent.length, sentAtAbort);
});

test('gives up after an overall deadline even if every step answers', async () => {
  const fake = new FakeReceiver({ stations: many(17), loadMs: 60 });
  await assert.rejects(play(fake, { name: 'Station 16' }, { timeoutMs: 400, deadlineMs: 100 }), /took too long/);
});

test('waits out a list that is loading when the play starts, instead of pressing Back on it', async () => {
  const fake = new FakeReceiver({ path: ['My Stations'] });
  fake.startLoading('Julien', 150);
  await play(fake, { name: BIG_R }, { timeoutMs: 1000, scanTimeoutMs: 100, reenterMs: 10 });
  assert.equal(fake.nowPlaying, BIG_R);
  assert.deepEqual(fake.violations, []);
});

test('a lost screen push during the search is re-read, not taken as "not found"', async () => {
  // Presses 5 and 7 are Downs scanning Julien (0 NSE, 1-2 Down, 3-4 OK, 5.. Down).
  const fake = new FakeReceiver({ stations: many(12), dropPushes: [5, 7] });
  await play(fake, { name: 'Station 11' });
  assert.equal(fake.nowPlaying, 'Station 11');
  assert.ok(!fake.sent.includes('SICD'), 'must not switch inputs because of a lost push');
});

test('SIIRADIO that pushes nothing (already in iRadio, input misreported) falls back to reading the display', async () => {
  const fake = new FakeReceiver();
  const io = { send: (c) => fake.send(c), onLine: (cb) => fake.onLine(cb), getInput: () => 'NET' };
  try {
    await playStation({ name: ELVIS, category: 'Julien' }, io, OPTS);
  } finally { fake.stop(); }
  assert.equal(fake.nowPlaying, ELVIS);
});

test('if re-entering iRadio fails after switching to CD, it switches back to iRadio', async () => {
  const fake = new FakeReceiver({ ytunerMenu: false });
  const io = {
    send: (c) => { if (c === 'SIIRADIO' && fake.sent.includes('SICD') && !io.once) { io.once = true; fake.sent.push(c); return; } fake.send(c); },
    onLine: (cb) => fake.onLine(cb), getInput: () => fake.getInput(),
  };
  await assert.rejects(playStation({ name: BIG_R, category: 'Julien' }, io, OPTS));
  fake.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.input, 'IRADIO', 'receiver must not be left on CD');
});

test('recovers once when a folder never finishes loading: re-enters iRadio and starts over', async () => {
  const fake = new FakeReceiver({ stickOnOpen: 'My Stations' });
  await play(fake, { name: ELVIS });
  assert.equal(fake.nowPlaying, ELVIS);
  const i = fake.sent.indexOf('SICD');
  assert.ok(i >= 0 && fake.sent[i + 1] === 'SIIRADIO', 'expected SICD then SIIRADIO');
  assert.equal(fake.input, 'IRADIO');
});
