'use strict';

// Plays a yTuner "My Stations" entry by driving the receiver's iRadio menu over telnet,
// exactly as a person would with the remote: Back to the top menu, then
// My Stations -> <category> -> <station> -> OK. The protocol has no "play this URL".
//
// Every step presses one key and waits for the screen the receiver pushes back. It never
// presses a key while a list is still loading: on the RCD-N9 that leaves the menu stuck on
// "---- empty ----".
//
// io: { send(cmd), onLine(cb) -> unsubscribe, getInput() }  (cb receives raw NSE lines)

const { ScreenAssembler } = require('./nseScreen');

const KEY = { up: 'NS90', down: 'NS91', back: 'NS92', enter: 'NS94', pageDown: 'NS9Y' };
const TOP_MENU_ITEM = 'My Stations';
const MAX_BACKS = 8;

function findItem(screen, text) {
  const exact = screen.items.find((i) => i.text === text);
  if (exact) return exact;
  // The display may truncate long names; accept a unique prefix match.
  const prefix = screen.items.filter((i) => {
    const shown = i.text.replace(/(\.\.\.|…)$/, '');
    return shown.length >= 8 && text.startsWith(shown);
  });
  return prefix.length === 1 ? prefix[0] : null;
}

async function playStation({ name, category }, io, { timeoutMs = 10000, settleMs = 3000 } = {}) {
  const assembler = new ScreenAssembler();
  const waiters = new Set();
  const off = io.onLine((line) => {
    const screen = assembler.feed(line);
    if (screen) for (const w of [...waiters]) w(screen);
  });

  // Send `cmd`, resolve with the first fully loaded screen satisfying `accept`.
  function press(cmd, accept, what, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = (s) => {
        if (s.loading || !accept(s)) return;
        clearTimeout(timer);
        waiters.delete(w);
        resolve(s);
      };
      const timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error(`Receiver did not respond (${what})`));
      }, ms);
      waiters.add(w);
      io.send(cmd);
    });
  }

  async function open(screen, text, accept) {
    let s = screen;
    let target = findItem(s, text);
    while (!target) {
      if (!s.page || s.page.current >= s.page.total) throw new Error(`"${text}" not found on the receiver`);
      const from = s.page.current;
      s = await press(KEY.pageDown, (n) => !!n.page && n.page.current > from, `paging to find "${text}"`);
      target = findItem(s, text);
    }
    while (s.cursor !== target.idx) {
      const from = s.cursor;
      const down = from < 0 || target.idx > from;
      s = await press(down ? KEY.down : KEY.up,
        (n) => n.cursor !== from && n.page?.current === s.page?.current,
        `moving to "${text}"`);
    }
    return press(KEY.enter, accept, `opening "${text}"`);
  }

  try {
    let screen = null;
    if (io.getInput() !== 'IRADIO') {
      screen = await press('SIIRADIO', () => true, 'switching to iRadio', settleMs).catch(() => null);
    }
    if (!screen) screen = await press('NSE', () => true, 'reading the display');

    for (let backs = 0; !findItem(screen, TOP_MENU_ITEM); backs++) {
      if (backs >= MAX_BACKS) throw new Error('Could not get back to the iRadio top menu');
      screen = await press(KEY.back, () => true, 'going back to the top menu');
    }
    screen = await open(screen, TOP_MENU_ITEM, (s) => s.title === TOP_MENU_ITEM);
    screen = await open(screen, category, (s) => s.title === category);
    await open(screen, name, (s) => s.title === 'Now Playing');
  } finally {
    off();
  }
}

module.exports = { playStation };
