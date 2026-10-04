'use strict';
// Simulated RCD-N9 iRadio menu, modelled on behaviour observed on the real receiver
// (2026-10-04, via yTuner):
//   - every cursor move / enter / back pushes the full NSE0..NSE8 screen unprompted;
//   - entering a folder first shows a "---- empty ----" placeholder, then the loaded list;
//   - a key pressed while a list is loading leaves the menu stuck on "empty" (recorded
//     in `violations` — the navigator must never do this);
//   - Back (NS92) at the top menu does nothing and pushes nothing;
//   - selecting a station shows "Now Playing" with the station on the cursor line;
//   - 7 items per page; line 8 holds the "[ n/m ]" page indicator.

const PAGE = 7;

function folder(title, children) { return { title, children }; }
function station(title) { return { title }; }

function defaultTree(stations) {
  return folder('Internet Radio', [
    folder('*** YTuner ***', []),
    folder('Favourites', []),
    folder('My Stations', [folder('Julien', stations.map(station))]),
    folder('Radio Browser', []),
    folder('Recently Played', []),
    folder('Search by Keyword', []),
  ]);
}

class FakeReceiver {
  constructor({ stations = ['Big R Radio - 80s Metal FM', 'Exclusively Elvis Presley'], input = 'IRADIO', loadMs = 20, path = [] } = {}) {
    this.input = input;
    this.loadMs = loadMs;
    this.sent = [];
    this.violations = [];
    this.nowPlaying = null;
    this.listeners = new Set();
    this.loading = false;
    // Stack of { node, cursor } — cursor is an absolute index into node.children.
    this.stack = [{ node: defaultTree(stations), cursor: 0 }];
    for (const title of path) this._descend(title);
  }

  // io surface used by the navigator
  send(cmd) {
    this.sent.push(cmd);
    if (this.loading) { this.violations.push(`${cmd} sent while loading`); this.stuck = true; return; }
    setTimeout(() => this._handle(cmd), 2);
  }
  onScreen(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  getInput() { return this.input; }

  _descend(title) {
    const top = this.stack[this.stack.length - 1];
    const i = top.node.children.findIndex((c) => c.title === title);
    if (i < 0) throw new Error(`fake: no ${title}`);
    top.cursor = i;
    const child = top.node.children[i];
    if (child.children) this.stack.push({ node: child, cursor: 0 });
    else this._play(child.title);
  }

  _play(title) {
    this.nowPlaying = title;
    this.stack.push({ node: { title: 'Now Playing', nowPlaying: title }, cursor: 0 });
  }

  _handle(cmd) {
    if (this.stuck) return this._emit(this._lines('My Stations', [], true));
    const top = this.stack[this.stack.length - 1];
    const kids = top.node.children || [];
    switch (cmd) {
      case 'SIIRADIO': this.input = 'IRADIO'; return this._emitCurrent();
      case 'NSE': return this.input === 'IRADIO' ? this._emitCurrent() : undefined;
      case 'NS90': top.cursor = Math.max(0, top.cursor - 1); return this._emitCurrent();
      case 'NS91': top.cursor = Math.min(kids.length - 1, top.cursor + 1); return this._emitCurrent();
      case 'NS9Y': top.cursor = Math.min(kids.length - 1, (Math.floor(top.cursor / PAGE) + 1) * PAGE); return this._emitCurrent();
      case 'NS9X': top.cursor = Math.max(0, (Math.floor(top.cursor / PAGE) - 1) * PAGE); return this._emitCurrent();
      case 'NS92':
        if (this.stack.length === 1) return; // top menu: nothing happens
        this.stack.pop();
        return this._emitCurrent();
      case 'NS94': {
        const child = kids[top.cursor];
        if (!child) return;
        if (!child.children) { this._play(child.title); return this._emitCurrent(); }
        this.stack.push({ node: child, cursor: 0 });
        this.loading = true;
        this._emit(this._lines(child.title, [], true));
        setTimeout(() => { this.loading = false; this._emitCurrent(); }, this.loadMs);
        return;
      }
      default:
    }
  }

  _emitCurrent() {
    const top = this.stack[this.stack.length - 1];
    if (top.node.nowPlaying) {
      return this._emit([
        'NSE0Now Playing', 'NSE1\x20Some song title', `NSE2\x09${top.node.nowPlaying}`,
        'NSE3', 'NSE4\x01', 'NSE5\x20  000:01     100%', 'NSE6', 'NSE7', 'NSE8',
      ]);
    }
    const kids = top.node.children;
    const page = Math.floor(top.cursor / PAGE);
    const rows = kids.slice(page * PAGE, page * PAGE + PAGE).map((c, i) => ({
      text: c.title, folder: !!c.children, cursor: page * PAGE + i === top.cursor,
    }));
    const total = Math.max(1, Math.ceil(kids.length / PAGE));
    this._emit(this._lines(top.node.title, rows, false, kids.length ? `${page + 1}/${total}` : '0/0'));
  }

  _lines(title, rows, empty, pageText = '0/0') {
    const out = [`NSE0${title}`];
    if (empty) out.push('NSE1\x08---- empty ----');
    for (const r of rows) {
      const info = (r.folder ? 0x02 : 0x01) | (r.cursor ? 0x08 : 0);
      out.push(`NSE${out.length}${String.fromCharCode(info)}${r.text}`);
    }
    while (out.length < 8) out.push(`NSE${out.length}`);
    out.push(`NSE8\x20  [    ${pageText}    ]`);
    return out;
  }

  _emit(lines) {
    for (const l of lines) for (const cb of [...this.listeners]) cb(l);
  }
}

module.exports = { FakeReceiver };
