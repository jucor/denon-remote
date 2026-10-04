'use strict';
// "On the receiver · Favourites": yTuner's bookmark.xml, listed above My Stations, plus a
// "☆ Favourite" button on every internet-radio search result.
//
// Loaded after index.html's own script and hooked in from outside, so index.html only
// carries <div id="radio-favourites"> and the <script> tag:
//   - isTelnetConnected / radioUpdatePlayAvailability() are the page's globals; the latter is
//     wrapped so Play enables/disables together with the My Stations buttons.
//   - renderRadioResults() is wrapped only to remember the stations behind the result rows
//     (the DOM does not carry their URLs); a MutationObserver adds the buttons, so they come
//     back whenever the results are re-rendered.
(function () {
  const root = document.getElementById('radio-favourites');
  if (!root) return;

  const NEEDS_TELNET = 'Play needs the telnet connection — press Connect at the top';
  const FAV_MENU = ['Favourites']; // the receiver's menu entry, sent as the play "path"

  const style = document.createElement('style');
  style.textContent = `
    .fav-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
    .fav-head .radio-mine-title { margin-bottom: 8px; }
    .fav-refresh { flex-shrink: 0; font-size: 12px; padding: 5px 10px; margin-bottom: 8px; background: var(--surface); border: 1px solid var(--text-dim); }
    .fav-add { flex-shrink: 0; font-size: 12px; padding: 6px 12px; background: var(--surface); border: 1px solid var(--accent); }
    .fav-add:disabled { opacity: 0.7; }
    .fav-empty { margin: 4px 2px 14px; }
  `;
  document.head.appendChild(style);

  let favourites = [];
  let lastResults = []; // stations behind the rows currently in #radio-results
  let unavailable = false; // server answered 501: no bookmark file configured

  const telnetOk = () => typeof isTelnetConnected !== 'undefined' && !!isTelnetConnected;

  // --- DOM skeleton: header + refresh, status line, list ---
  root.hidden = true; // shown once the first load answers
  root.innerHTML =
    '<div class="fav-head">' +
      '<div class="radio-mine-title">On the receiver · Favourites — tap one to play it</div>' +
      '<button type="button" class="fav-refresh" title="Re-read the Favourites list (the receiver can change it too)">↻ Refresh</button>' +
    '</div>' +
    '<div id="radio-fav-status" class="radio-status" role="status" aria-live="polite"></div>' +
    '<div id="radio-favlist" class="radio-list"></div>';
  const statusEl = root.querySelector('#radio-fav-status');
  const listEl = root.querySelector('#radio-favlist');
  root.querySelector('.fav-refresh').onclick = () => load(true);

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = 'radio-status' + (isError ? ' error' : '');
  }

  async function json(res) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* no JSON body */ }
    if (!res.ok) throw Object.assign(new Error(body.error || 'HTTP ' + res.status), { status: res.status });
    return body;
  }

  const sendJson = (url, method, body) => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // --- Rendering ---
  function logoEl(f) {
    if (/^https?:\/\//i.test(f.logo || '')) {
      const img = document.createElement('img');
      img.className = 'radio-fav';
      img.src = encodeURI(f.logo);
      img.alt = '';
      img.onerror = () => img.replaceWith(logoPlaceholder());
      return img;
    }
    return logoPlaceholder();
  }

  function logoPlaceholder() {
    const span = document.createElement('span');
    span.className = 'radio-fav';
    span.textContent = '📻';
    return span;
  }

  function button(cls, text, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.setAttribute('aria-label', label);
    return b;
  }

  function renderList(list) {
    favourites = list || [];
    listEl.innerHTML = '';
    if (!favourites.length) {
      const empty = document.createElement('div');
      empty.className = 'radio-sub fav-empty';
      empty.textContent = 'No favourites yet — search above and press “☆ Favourite” on a station.';
      listEl.appendChild(empty);
    }
    for (const f of favourites) {
      const row = document.createElement('div');
      row.className = 'radio-mine fav-row';
      const meta = document.createElement('div');
      meta.className = 'radio-meta';
      const name = document.createElement('span');
      name.className = 'radio-name';
      name.textContent = f.name;
      const sub = document.createElement('span');
      sub.className = 'radio-sub';
      sub.textContent = 'Favourites';
      meta.append(name, sub);
      const play = button('radio-play fav-play', '▶ Play', 'Play ' + f.name);
      const del = button('radio-remove fav-remove', '×', 'Remove ' + f.name + ' from Favourites');
      del.title = 'Remove from Favourites';
      row.append(logoEl(f), meta, play, del);
      row.onclick = () => play_(f, play);
      del.onclick = (ev) => { ev.stopPropagation(); remove(f, del); };
      listEl.appendChild(row);
    }
    updateAvailability();
    syncAddButtons();
  }

  // --- Play (needs telnet: the receiver's menu is walked server-side) ---
  function updateAvailability() {
    const buttons = listEl.querySelectorAll('.fav-play');
    for (const b of buttons) {
      if (b.dataset.busy) continue; // a play in progress re-enables itself
      b.disabled = !telnetOk();
      b.title = telnetOk() ? 'Play on the receiver' : NEEDS_TELNET;
    }
    if (!telnetOk() && buttons.length) {
      if (!statusEl.classList.contains('error')) setStatus(NEEDS_TELNET);
    } else if (statusEl.textContent === NEEDS_TELNET) {
      setStatus('');
    }
  }

  async function play_(f, btn) {
    if (btn.disabled) {
      if (!telnetOk()) setStatus(NEEDS_TELNET, true);
      return;
    }
    btn.disabled = true;
    btn.dataset.busy = '1';
    btn.textContent = '…';
    setStatus('Selecting “' + f.name + '” on the receiver — takes a few seconds…');
    try {
      await json(await sendJson('/api/radio/play', 'POST', { name: f.name, path: FAV_MENU }));
      setStatus('Playing “' + f.name + '”');
    } catch (e) {
      setStatus('Could not play “' + f.name + '”: ' + e.message, true);
    } finally {
      btn.textContent = '▶ Play';
      delete btn.dataset.busy;
      btn.disabled = !telnetOk();
    }
  }

  // --- Load / remove ---
  async function load(announce) {
    try {
      const { favourites: list } = await json(await fetch('/api/radio/favourites'));
      root.hidden = false;
      renderList(list);
      if (announce) setStatus('Favourites refreshed — ' + list.length + (list.length === 1 ? ' station' : ' stations'));
    } catch (e) {
      if (e.status === 501) { unavailable = true; root.hidden = true; return; }
      root.hidden = false;
      setStatus('Could not load Favourites: ' + e.message, true);
    }
  }

  async function remove(f, btn) {
    btn.disabled = true;
    try {
      const { favourites: list } = await json(await sendJson('/api/radio/favourites/' + encodeURIComponent(f.id), 'DELETE'));
      renderList(list);
      setStatus('Removed “' + f.name + '” from Favourites');
    } catch (e) {
      if (e.status === 404) { await load(); setStatus('“' + f.name + '” was already gone from Favourites'); return; }
      setStatus('Could not remove: ' + e.message, true);
      btn.disabled = false;
    }
  }

  // --- "☆ Favourite" on search results ---
  const ADD_LABEL = '☆ Favourites';
  const IN_LABEL = '★ In Favourites';

  function decorateResults() {
    if (unavailable) return;
    const rows = document.querySelectorAll('#radio-results .radio-result');
    rows.forEach((row, i) => {
      if (row.querySelector('.fav-add')) return;
      const station = lastResults[i];
      const nameEl = row.querySelector('.radio-name');
      if (!station || !nameEl || nameEl.textContent !== station.name) return; // not the rows we captured
      const btn = button('fav-add', ADD_LABEL, 'Add ' + station.name + ' to Favourites');
      btn.title = 'Add to the receiver’s Favourites menu';
      btn.onclick = (ev) => { ev.stopPropagation(); add(station, btn); };
      row.appendChild(btn);
    });
  }

  // A button marked "In Favourites" whose entry has since been removed is offered again.
  function syncAddButtons() {
    const ids = new Set(favourites.map((f) => f.id));
    for (const b of document.querySelectorAll('#radio-results .fav-add[data-fav-id]')) {
      if (!ids.has(b.dataset.favId)) {
        delete b.dataset.favId;
        b.textContent = ADD_LABEL;
        b.disabled = false;
      }
    }
  }

  // Outcomes of buttons on search results go to the status line just above the results
  // (where Play now and + My Stations report), not to this list far below them.
  function resultStatus(msg, isError) {
    if (typeof window.radioSetStatus === 'function') window.radioSetStatus(msg, isError);
    else setStatus(msg, isError);
  }

  async function add(station, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const body = await json(await sendJson('/api/radio/favourites', 'POST', {
        name: station.name, url: station.url, uuid: station.uuid, favicon: station.favicon,
        codec: station.codec, bitrate: station.bitrate, country: station.country,
      }));
      root.hidden = false;
      renderList(body.favourites);
      btn.dataset.favId = body.id;
      btn.textContent = IN_LABEL;
      btn.disabled = true;
      resultStatus(body.added
        ? 'Added “' + station.name + '” to Favourites — it is on the receiver’s Favourites menu right away'
        : '“' + station.name + '” is already in Favourites');
    } catch (e) {
      resultStatus('Could not add to Favourites: ' + e.message, true);
      btn.textContent = ADD_LABEL;
      btn.disabled = false;
    }
  }

  // --- Hooks into index.html's globals (no edits there) ---
  if (typeof window.radioUpdatePlayAvailability === 'function') {
    const orig = window.radioUpdatePlayAvailability;
    window.radioUpdatePlayAvailability = function () {
      const r = orig.apply(this, arguments);
      updateAvailability();
      return r;
    };
  }
  if (typeof window.renderRadioResults === 'function') {
    const orig = window.renderRadioResults;
    window.renderRadioResults = function (stations) {
      lastResults = stations || [];
      return orig.apply(this, arguments);
    };
  }
  const results = document.getElementById('radio-results');
  if (results) {
    new MutationObserver(decorateResults).observe(results, { childList: true });
    decorateResults();
  }

  load();
})();
