'use strict';
// Simulated RCD-N9 iRadio menu, modelled on behaviour observed on the real receiver
// (2026-10-04, via yTuner):
//   - every cursor move / page / Back / OK pushes the full NSE0..NSE8 screen unprompted;
//   - lists show a sliding 7-row window; Up/Down wrap around the ends; Page Down/Up move
//     the cursor 7 items and wrap too. There is no reliable page indicator on line 8;
//   - entering a folder first shows a "---- empty ----" placeholder, then the loaded list;
//   - a key pressed while a list is loading leaves the menu stuck on "empty" (recorded
//     in `violations` — the navigator must never do this);
//   - Back (NS92) at the top menu does nothing and pushes nothing;
//   - after another input was used, the top menu can come back with only the receiver's
//     own entries (no yTuner items) until iRadio is entered again from another input;
//   - entering iRadio from another input either shows the top menu (seen from CD) or
//     resumes the last station on Now Playing (seen from Media Server): `resumeStation`;
//   - opening a folder can, rarely, never finish loading (seen once live: My Stations stuck
//     on "empty" with nothing else pressed); only entering iRadio afresh clears it:
//     `stickOnOpen` = title of a folder whose first opening sticks;
//   - on the Media Server input (after Play now via UPnP) the receiver still answers SI?
//     with IRADIO; NSE shows a "Media Server" screen, menu keys move in Media Server's own
//     menus, and only SIIRADIO brings iRadio back: `mediaServer`;
//   - an input switch takes a while (`switchMs`); another SI command during it is ignored
//     (seen live: SICD then SIIRADIO 2.5 s later left the receiver on CD);
//   - selecting a station shows "Now Playing" (station on line 2), which keeps pushing
//     refreshes while it plays.

const ROWS = 7;

function folder(title, children) { return { title, children }; }
function station(title) { return { title }; }

function topMenu(stations, withYtuner, favourites = []) {
  const ytuner = [
    folder('*** YTuner ***', []),
    folder('Favourites', favourites.map(station)),
    folder('My Stations', [folder('Julien', stations.map(station))]),
    folder('Radio Browser', []),
  ];
  return folder('Internet Radio', [
    ...(withYtuner ? ytuner : []),
    folder('Recently Played', []),
    folder('Search by Keyword', []),
  ]);
}

class FakeReceiver {
  constructor({
    stations = ['Big R Radio - 80s Metal FM', 'Exclusively Elvis Presley'],
    input = 'IRADIO', loadMs = 20, path = [], ytunerMenu = true, cursorAt = null,
    nowPlayingRefreshMs = 0, encode = (s) => s, resumeStation = null, dropPushes = [],
    stickOnOpen = null, favourites = [], mediaServer = false, switchMs = 0,
  } = {}) {
    this.switchMs = switchMs;
    this.switchingUntil = 0;
    if (mediaServer) input = 'MEDIA';
    this.favourites = favourites;
    this.stickOnOpen = stickOnOpen;
    this.dropPushes = new Set(dropPushes); // indexes of key presses whose screen push is lost
    this.resumeStation = resumeStation;
    this.stations = stations;
    this.input = input;
    this.loadMs = loadMs;
    this.encode = encode; // how the receiver mangles text on the wire
    this.nowPlayingRefreshMs = nowPlayingRefreshMs;
    this.sent = [];
    this.violations = [];
    this.nowPlaying = null;
    this.listeners = new Set();
    this.loading = false;
    this.stack = [{ node: topMenu(stations, ytunerMenu, favourites), cursor: 0, start: 0 }];
    for (const title of path) this._descend(title);
    if (cursorAt !== null) this._top().cursor = cursorAt;
  }

  // io surface used by the navigator
  send(cmd) {
    this.sent.push(cmd);
    // Menu keys while loading stick the menu; a display query (NSE) does not.
    if (this.loading && cmd !== 'NSE') { this.violations.push(`${cmd} sent while loading`); this.stuck = true; return; }
    if (this.loading) { // NSE while loading answers with the placeholder screen
      setTimeout(() => this._emit(this._lines(this.loadingTitle, [], true)), 2);
      return;
    }
    const n = this.sent.length - 1;
    setTimeout(() => {
      this.muted = this.dropPushes.has(n);
      this._handle(cmd);
      this.muted = false;
    }, 2);
  }

  // Put the receiver mid-load, as if a person had just opened a folder.
  startLoading(title, ms) {
    this.loading = true;
    this.loadingTitle = title;
    this._emit(this._lines(title, [], true));
    setTimeout(() => { this.loading = false; this._emitCurrent(); }, ms);
  }
  onLine(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  getInput() { return this.input === 'MEDIA' ? 'IRADIO' : this.input; } // telnet can't tell
  stop() { clearInterval(this.refreshTimer); }

  _top() { return this.stack[this.stack.length - 1]; }

  _descend(title) {
    const top = this._top();
    const i = top.node.children.findIndex((c) => c.title === title);
    if (i < 0) throw new Error(`fake: no ${title}`);
    top.cursor = i;
    const child = top.node.children[i];
    if (child.children) this.stack.push({ node: child, cursor: 0, start: 0 });
    else this._play(child.title);
  }

  _play(title) {
    this.nowPlaying = title;
    this.stack.push({ node: { title: 'Now Playing', nowPlaying: title }, cursor: 0, start: 0 });
    clearInterval(this.refreshTimer);
    if (this.nowPlayingRefreshMs) {
      this.refreshTimer = setInterval(() => { if (this._top().node.nowPlaying) this._emitCurrent(); }, this.nowPlayingRefreshMs);
    }
  }

  _move(top, to, upward) {
    const n = top.node.children.length;
    top.cursor = ((to % n) + n) % n;
    if (top.cursor < top.start || top.cursor >= top.start + ROWS || upward) {
      const start = upward ? top.cursor - 1 : top.cursor - 5;
      top.start = Math.max(0, Math.min(start, n - ROWS));
    }
  }

  _handle(cmd) {
    if (cmd.startsWith('SI')) return this._select(cmd.slice(2));
    if (this.stuck) return this._emit(this._lines(this.loadingTitle || 'My Stations', [], true));
    if (this.input === 'MEDIA') { // its own menus: Back never reaches iRadio
      return setTimeout(() => this._emit(['NSE0Media Server', 'NSE1\x0anas', 'NSE2', 'NSE3', 'NSE4', 'NSE5', 'NSE6', 'NSE7', 'NSE8']), 2);
    }
    if (this.input !== 'IRADIO') return; // CD or mid-switch: no menu, no display
    return this._keys(cmd);
  }

  // SI<input>: with `switchMs`, the change takes time and another SI meanwhile is ignored.
  _select(next) {
    if (Date.now() < this.switchingUntil) return;
    if (!this.switchMs || next === this.input) return this._switchTo(next);
    this.switchingUntil = Date.now() + this.switchMs;
    const was = this.input;
    this.input = 'SWITCHING';
    setTimeout(() => { this.input = was; this._switchTo(next); }, this.switchMs);
  }

  _switchTo(next) {
    if (next === 'IRADIO' && this.input !== 'IRADIO') {
      // Entering iRadio from another input fetches yTuner's menu again.
      this.stack = [{ node: topMenu(this.stations, true, this.favourites), cursor: 0, start: 0 }];
      this.input = next;
      this.stuck = false;
      if (this.resumeStation) this._play(this.resumeStation);
      return this._emitCurrent();
    }
    this.input = next;
  }

  _keys(cmd) {
    const top = this._top();
    const kids = top.node.children || [];
    switch (cmd) {
      case 'NSE': return this._emitCurrent();
      case 'NS90': if (!kids.length) return; this._move(top, top.cursor - 1, true); return this._emitCurrent();
      case 'NS91': if (!kids.length) return; this._move(top, top.cursor + 1, false); return this._emitCurrent();
      case 'NS9X': if (!kids.length) return; this._move(top, top.cursor - ROWS, true); return this._emitCurrent();
      case 'NS9Y': if (!kids.length) return; this._move(top, top.cursor + ROWS, false); return this._emitCurrent();
      case 'NS92':
        if (this.stack.length === 1) return; // top menu: nothing happens
        this.stack.pop();
        return this._emitCurrent();
      case 'NS94': {
        const child = kids[top.cursor];
        if (!child) return;
        if (!child.children) { this._play(child.title); return this._emitCurrent(); }
        this.stack.push({ node: child, cursor: 0, start: 0 });
        this.loadingTitle = child.title;
        if (this.stickOnOpen === child.title) {
          this.stickOnOpen = null;
          this.stuck = true; // no violation: the receiver did this on its own
          return this._emit(this._lines(child.title, [], true));
        }
        this.loading = true;
        this._emit(this._lines(child.title, [], true));
        setTimeout(() => { this.loading = false; this._emitCurrent(); }, this.loadMs);
        return;
      }
      default:
    }
  }

  _emitCurrent() {
    const top = this._top();
    if (top.node.nowPlaying) {
      return this._emit([
        'NSE0Now Playing', `NSE1\x01${this.encode('Warrant – Heaven')}`, `NSE2\x09${this.encode(top.node.nowPlaying)}`,
        'NSE3\x01', 'NSE4\x01', 'NSE5\x01  000:01     100%', 'NSE6', 'NSE7', 'NSE8',
      ]);
    }
    const kids = top.node.children;
    const rows = kids.slice(top.start, top.start + ROWS).map((c, i) => ({
      text: this.encode(c.title), folder: !!c.children, cursor: top.start + i === top.cursor,
    }));
    this._emit(this._lines(top.node.title, rows, kids.length === 0));
  }

  _lines(title, rows, empty) {
    const out = [`NSE0${title}`];
    if (empty) out.push('NSE1\x08---- empty ----');
    for (const r of rows) {
      const info = (r.folder ? 0x02 : 0x01) | (r.cursor ? 0x08 : 0);
      out.push(`NSE${out.length}${String.fromCharCode(info)}${r.text}`);
    }
    while (out.length < 9) out.push(`NSE${out.length}`);
    return out;
  }

  _emit(lines) {
    if (this.muted) return;
    for (const l of lines) for (const cb of [...this.listeners]) cb(l);
  }
}

module.exports = { FakeReceiver };
