'use strict';

// Plays a yTuner "My Stations" entry by driving the receiver's iRadio menu over telnet,
// exactly as a person would with the remote: Back to the top menu, then
// My Stations -> <category> -> <station> -> OK. The protocol has no "play this URL".
//
// Behaviour of the RCD-N9 this relies on (observed 2026-10-04, see CLAUDE.md):
//   - it pushes the whole screen after every key, so each key waits for the screen it
//     causes; it never presses a key while a list is loading ("---- empty ----"), which
//     on this unit leaves the menu stuck there;
//   - lists are a sliding 7-row window that wraps at both ends, with no reliable page
//     indicator, so items are found by their text and OK is only pressed once the
//     cursor row's text is exactly the target;
//   - after another input was used, the top menu can lack yTuner's entries until iRadio
//     is entered again from another input.
//
// io: { send(cmd), onLine(cb) -> unsubscribe, getInput() }  (cb receives raw NSE lines)

const { ScreenAssembler, fixDoubleEncoding } = require('./nseScreen');

const KEY = { up: 'NS90', down: 'NS91', back: 'NS92', enter: 'NS94' };
const TOP_TITLE = 'Internet Radio';
const MY_STATIONS = 'My Stations';
const MAX_BACKS = 8;
const MAX_STEPS = 500; // two laps of a 250-row list

const norm = (t) => fixDoubleEncoding(String(t)).normalize('NFC').replace(/\s+/g, ' ').trim();
const signature = (s) => [s.title, s.cursor, ...s.rows.map((r) => r.text)].join('\u0001');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playStation({ name, category }, io, {
  timeoutMs = 10000, scanTimeoutMs = Math.min(timeoutMs, 2500), deadlineMs = 60000,
  reenterMs = 2500, inputSwitchMs = Math.min(timeoutMs, 4000), signal,
} = {}) {
  const assembler = new ScreenAssembler();
  const waiters = new Set();
  let failure = null;
  const fail = (err) => {
    if (failure) return;
    failure = err;
    for (const w of [...waiters]) w.reject(err);
  };
  const off = io.onLine((line) => {
    const screen = assembler.feed(line);
    if (screen) for (const w of [...waiters]) w.check(screen);
  });
  const deadline = setTimeout(() => fail(new Error('Selecting the station took too long')), deadlineMs);
  const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);
  }

  // Send `cmd` (null: send nothing, just wait), resolve with the first screen it causes
  // that satisfies `accept`. Loading screens are skipped unless `allowLoading`.
  function press(cmd, accept, what, { ms = timeoutMs, allowLoading = false } = {}) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); waiters.delete(w); };
      const w = {
        check: (s) => {
          if ((s.loading && !allowLoading) || !accept(s)) return;
          done();
          resolve(s);
        },
        reject: (err) => { done(); reject(err); },
      };
      const timer = setTimeout(() => { done(); reject(new Error(`Receiver did not respond (${what})`)); }, ms);
      waiters.add(w);
      if (cmd !== null) io.send(cmd);
    });
  }

  // Ask the receiver for its current screen.
  function readDisplay(what) {
    return press('NSE', () => true, what, { allowLoading: true });
  }

  // A screen push can get lost: when `cmd` gets no answer, read the display once and use
  // it if it shows what we wanted. Returns null when the display shows nothing changed.
  async function pressOrReread(cmd, accept, what, opts) {
    try {
      return await press(cmd, accept, what, opts);
    } catch (err) {
      if (failure) throw failure;
      const now = await readDisplay(what);
      return accept(now) && !now.loading ? now : null;
    }
  }

  // Never press a key on a loading screen (it sticks the menu): wait for the load to
  // finish. If it never does, the menu is already stuck and Back is the way out.
  async function settle(screen) {
    if (!screen.loading) return screen;
    try {
      return await press(null, (n) => n.title === screen.title, `loading "${screen.title}"`);
    } catch (err) {
      if (failure) throw failure;
      return screen;
    }
  }

  // Bring the cursor onto the row reading exactly `text` and press OK. Returns the screen
  // accepted after OK, or null when the list has no such row.
  async function select(screen, text, acceptAfterOk) {
    const key = norm(text);
    const seen = new Set([signature(screen)]);
    let s = screen;
    for (let step = 0; step < MAX_STEPS; step++) {
      const cur = s.items.find((i) => i.cursor);
      if (cur && norm(cur.text) === key) return press(KEY.enter, acceptAfterOk, `opening "${text}"`);
      const from = s;
      const moved = (n) => n.title === from.title && signature(n) !== signature(from);
      const target = s.items.find((i) => norm(i.text) === key);
      if (target) {
        const down = !cur || target.idx > cur.idx;
        const next = await pressOrReread(down ? KEY.down : KEY.up, moved, `moving to "${text}"`);
        if (!next) throw new Error(`Receiver did not respond (moving to "${text}")`);
        s = next;
        continue;
      }
      // Not in view: step down one row at a time (the list wraps) until a screen repeats,
      // which means a full lap. Page Down jumps 7 rows and, on lists whose length shares
      // a factor with 7, wraps without ever showing some rows.
      const next = await pressOrReread(KEY.down, moved, `looking for "${text}"`, { ms: scanTimeoutMs });
      if (!next) return null; // nothing moved: a one-row list
      s = next;
      if (seen.has(signature(s))) return null;
      seen.add(signature(s));
    }
    throw new Error(`Gave up looking for "${text}"`);
  }

  async function backToTop(screen) {
    let s = await settle(screen);
    for (let backs = 0; s.title !== TOP_TITLE; backs++) {
      if (backs >= MAX_BACKS) throw new Error('Could not get back to the iRadio top menu');
      const from = s.title;
      s = await settle(await press(KEY.back, (n) => n.title !== from, 'going back to the top menu', { allowLoading: true }));
    }
    return s;
  }

  // Entering iRadio from another input shows either the top menu (seen from CD) or the
  // last station resuming on Now Playing (seen from Media Server); Back out of either.
  // SIIRADIO pushes nothing when iRadio is already on: then just read the display.
  async function enterIradio() {
    let s;
    try {
      s = await press('SIIRADIO', () => true, 'switching to iRadio', { ms: inputSwitchMs, allowLoading: true });
    } catch (err) {
      if (failure) throw failure;
      s = await readDisplay('switching to iRadio');
    }
    return backToTop(s);
  }

  let onCd = false; // switched to CD to make iRadio re-fetch yTuner, not yet back
  try {
    const screen = io.getInput() !== 'IRADIO'
      ? await enterIradio()
      : await backToTop(await readDisplay('reading the display'));

    const isMyStations = (s) => norm(s.title) === MY_STATIONS;
    let opened = await select(screen, MY_STATIONS, isMyStations);
    if (!opened) {
      // Top menu without yTuner's entries: enter iRadio again from another input.
      io.send('SICD');
      onCd = true;
      await sleep(reenterMs);
      if (failure) throw failure;
      const top = await enterIradio();
      onCd = false;
      opened = await select(top, MY_STATIONS, isMyStations);
      if (!opened) throw new Error(`"${MY_STATIONS}" not found on the receiver — is yTuner running?`);
    }
    const inCategory = await select(opened, category, (s) => norm(s.title) === norm(category));
    if (!inCategory) throw new Error(`"${category}" not found on the receiver`);
    const playing = await select(inCategory, name, (s) => s.title === 'Now Playing');
    if (!playing) throw new Error(`"${name}" not found on the receiver`);
  } catch (err) {
    if (onCd) io.send('SIIRADIO'); // never leave the receiver on CD
    throw err;
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onAbort);
    off();
  }
}

module.exports = { playStation };
