'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  listStations,
  addStation,
  removeStation,
  sanitizeName,
} = require('../lib/stations');

test('listStations parses name=url|logo entries under categories', () => {
  const text = [
    '; a comment',
    '[Rock]',
    'Radio Beat=http://example.com/beat.mp3|http://example.com/beat.png',
    '[Jazz]',
    'FIP Jazz=http://example.com/jazz.mp3',
  ].join('\n');

  assert.deepEqual(listStations(text), [
    { category: 'Rock', name: 'Radio Beat', url: 'http://example.com/beat.mp3', logo: 'http://example.com/beat.png' },
    { category: 'Jazz', name: 'FIP Jazz', url: 'http://example.com/jazz.mp3', logo: '' },
  ]);
});

test('listStations ignores comments, blanks, and headers', () => {
  const text = '; header comment\n\n[Empty]\n\n; only comments here\n';
  assert.deepEqual(listStations(text), []);
});

test('addStation creates the category when missing and appends the entry', () => {
  const out = addStation('; preamble kept\n', 'Julien', {
    name: 'FIP Jazz',
    url: 'http://example.com/jazz.mp3',
    logo: 'http://example.com/jazz.png',
  });
  assert.match(out, /; preamble kept/);
  assert.deepEqual(listStations(out), [
    { category: 'Julien', name: 'FIP Jazz', url: 'http://example.com/jazz.mp3', logo: 'http://example.com/jazz.png' },
  ]);
});

test('addStation appends into an existing category without touching others', () => {
  const text = '[Rock]\nRadio Beat=http://example.com/beat.mp3\n[Julien]\nExisting=http://example.com/old.mp3\n';
  const out = addStation(text, 'Julien', { name: 'New One', url: 'http://example.com/new.mp3' });
  const list = listStations(out);
  assert.deepEqual(list, [
    { category: 'Rock', name: 'Radio Beat', url: 'http://example.com/beat.mp3', logo: '' },
    { category: 'Julien', name: 'Existing', url: 'http://example.com/old.mp3', logo: '' },
    { category: 'Julien', name: 'New One', url: 'http://example.com/new.mp3', logo: '' },
  ]);
});

test('addStation is idempotent per stream URL within a category (updates in place)', () => {
  const text = '[Julien]\nOld Name=http://example.com/s.mp3|http://old.png\n';
  const out = addStation(text, 'Julien', { name: 'New Name', url: 'http://example.com/s.mp3', logo: 'http://new.png' });
  assert.deepEqual(listStations(out), [
    { category: 'Julien', name: 'New Name', url: 'http://example.com/s.mp3', logo: 'http://new.png' },
  ]);
});

test('addStation sanitizes the name and encodes a pipe in the URL', () => {
  const out = addStation('', 'Julien', {
    name: 'Bad=Name|X\tY',
    url: 'http://example.com/s.mp3?a=1|b=2',
  });
  const [s] = listStations(out);
  assert.equal(s.name, 'Bad-Name/X Y');
  // the raw line must not contain a literal pipe in the URL portion
  assert.ok(out.includes('http://example.com/s.mp3?a=1%7Cb=2'));
  assert.equal(s.url, 'http://example.com/s.mp3?a=1%7Cb=2');
});

test('removeStation deletes the matching entry by name+url and preserves the rest', () => {
  const text = '[Rock]\nRadio Beat=http://example.com/beat.mp3\n[Julien]\nFIP=http://example.com/jazz.mp3\n';
  const out = removeStation(text, { name: 'FIP', url: 'http://example.com/jazz.mp3' });
  assert.deepEqual(listStations(out), [
    { category: 'Rock', name: 'Radio Beat', url: 'http://example.com/beat.mp3', logo: '' },
  ]);
});

test('removeStation leaves the file unchanged when nothing matches', () => {
  const text = '[Julien]\nFIP=http://example.com/jazz.mp3\n';
  assert.equal(removeStation(text, { name: 'Nope', url: 'http://x' }), text);
});

test('sanitizeName strips control chars, brackets and separators, collapses whitespace', () => {
  assert.equal(sanitizeName('  A[b]c=d|e\n\tf  '), 'A(b)c-d/e f');
});
