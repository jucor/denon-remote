// "Browse by genre / country" for the Internet Radio Search section.
// Renders into #radio-browse: a visible toggle, two real tabs (Genres, Countries) and
// chips with station counts. Clicking a chip fills #radio-q and runs the page's own
// radioSearch(). Lists load lazily (first open / first visit of a tab) from
// /api/radio/tags and /api/radio/countries.
(function () {
  'use strict';

  var root = document.getElementById('radio-browse');
  if (!root) return;

  var TOP_GENRES = 40;

  var TABS = [
    { id: 'genres', label: 'Genres', url: '/api/radio/tags', key: 'tags', noun: 'genres' },
    { id: 'countries', label: 'Countries', url: '/api/radio/countries', key: 'countries', noun: 'countries' },
  ];
  var state = {}; // tab id -> { phase: 'idle'|'loading'|'done'|'error', error: string }
  TABS.forEach(function (t) { state[t.id] = { phase: 'idle', error: '' }; });
  var activeId = 'genres';
  var selectedChip = null;

  // --- Styles (page CSS variables; nothing hidden behind hover) ---
  var style = document.createElement('style');
  style.textContent = [
    '#radio-browse { margin-top: 10px; }',
    '#radio-browse [hidden] { display: none !important; }',
    '#radio-browse .browse-toggle { width: 100%; justify-content: space-between; border: 1px solid var(--text-dim); font-weight: 600; padding: 10px 12px; }',
    '#radio-browse .browse-toggle[aria-expanded="true"] { border-color: var(--accent); }',
    '#radio-browse .browse-body { margin-top: 10px; }',
    '#radio-browse .browse-tablist { display: flex; gap: 4px; border-bottom: 2px solid var(--accent); }',
    '#radio-browse .browse-tab { flex: 1; border: 1px solid var(--text-dim); border-bottom: none; border-radius: 8px 8px 0 0; background: var(--bg); color: var(--text-dim); font-weight: 600; padding: 9px 12px; margin-bottom: -2px; }',
    '#radio-browse .browse-tab[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }',
    '#radio-browse .browse-tab:focus-visible, #radio-browse .browse-toggle:focus-visible, #radio-browse .browse-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
    '#radio-browse .browse-panel { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 0 2px; }',
    '#radio-browse .browse-chip { border: 1px solid var(--text-dim); background: var(--surface2); color: var(--text); border-radius: 999px; padding: 6px 12px; font-size: 13px; min-height: 32px; text-align: left; }',
    '#radio-browse .browse-chip-count { color: var(--text-dim); font-variant-numeric: tabular-nums; }',
    '#radio-browse .browse-chip[aria-pressed="true"] { background: var(--accent2); border-color: var(--accent); }',
    '#radio-browse .browse-chip[aria-pressed="true"] .browse-chip-count { color: var(--text); }',
    '#radio-browse .browse-status { font-size: 12px; color: var(--text-dim); margin: 10px 2px 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
    '#radio-browse .browse-status:empty { display: none; }',
    '#radio-browse .browse-status.error { color: var(--accent); }',
    '#radio-browse .browse-retry { border: 1px solid var(--accent); padding: 4px 12px; font-size: 12px; }',
  ].join('\n');
  document.head.appendChild(style);

  // --- DOM ---
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  var toggle = el('button', {
    id: 'radio-browse-toggle', type: 'button', 'class': 'browse-toggle',
    'aria-expanded': 'false', 'aria-controls': 'radio-browse-body',
  });
  var body = el('div', { id: 'radio-browse-body', 'class': 'browse-body' });
  body.hidden = true;
  var tablist = el('div', { role: 'tablist', 'aria-label': 'Browse stations by', 'class': 'browse-tablist' });
  var status = el('div', { id: 'browse-status', 'class': 'browse-status' });
  var tabEls = {};
  var panelEls = {};

  TABS.forEach(function (t) {
    var tab = el('button', {
      id: 'browse-tab-' + t.id, type: 'button', role: 'tab', 'class': 'browse-tab',
      'aria-selected': 'false', 'aria-controls': 'browse-panel-' + t.id, tabindex: '-1',
    }, t.label);
    tab.addEventListener('click', function () { activate(t.id, false); });
    tab.addEventListener('keydown', onTabKey);
    tablist.appendChild(tab);
    tabEls[t.id] = tab;
    var panel = el('div', {
      id: 'browse-panel-' + t.id, role: 'tabpanel', 'class': 'browse-panel',
      'aria-labelledby': 'browse-tab-' + t.id,
    });
    panel.hidden = true;
    panelEls[t.id] = panel;
  });

  body.appendChild(tablist);
  body.appendChild(status);
  TABS.forEach(function (t) { body.appendChild(panelEls[t.id]); });
  root.appendChild(toggle);
  root.appendChild(body);

  function setToggleText(open) {
    toggle.textContent = 'Browse by genre / country ' + (open ? '▴' : '▾');
  }
  setToggleText(false);

  toggle.addEventListener('click', function () {
    var open = body.hidden; // hidden now -> opening
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    setToggleText(open);
    if (open) activate(activeId, false);
  });

  // --- Tabs ---
  function onTabKey(ev) {
    var i = TABS.findIndex(function (t) { return t.id === activeId; });
    var next;
    if (ev.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    else return;
    ev.preventDefault();
    activate(TABS[next].id, true);
  }

  function activate(id, focus) {
    activeId = id;
    TABS.forEach(function (t) {
      var on = t.id === id;
      tabEls[t.id].setAttribute('aria-selected', on ? 'true' : 'false');
      tabEls[t.id].setAttribute('tabindex', on ? '0' : '-1');
      panelEls[t.id].hidden = !on;
    });
    if (focus) tabEls[id].focus();
    var s = state[id];
    if (s.phase === 'idle' || s.phase === 'error') load(id);
    else renderStatus();
  }

  // --- Loading ---
  function tabById(id) { return TABS.filter(function (t) { return t.id === id; })[0]; }

  function renderStatus() {
    var s = state[activeId];
    var t = tabById(activeId);
    status.textContent = '';
    status.className = 'browse-status';
    status.removeAttribute('role');
    if (s.phase === 'loading') {
      status.setAttribute('role', 'status');
      status.textContent = 'Loading ' + t.noun + '…';
    } else if (s.phase === 'error') {
      status.setAttribute('role', 'alert');
      status.className = 'browse-status error';
      status.appendChild(document.createTextNode('Could not load ' + t.noun + ': ' + s.error));
      var retry = el('button', { id: 'browse-retry', type: 'button', 'class': 'browse-retry' }, 'Retry');
      retry.addEventListener('click', function () { load(activeId); });
      status.appendChild(retry);
    }
  }

  function load(id) {
    var t = tabById(id);
    state[id] = { phase: 'loading', error: '' };
    renderStatus();
    fetch(t.url)
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          return data;
        });
      })
      .then(function (data) {
        var items = Array.isArray(data[t.key]) ? data[t.key] : [];
        renderChips(id, id === 'genres' ? items.slice(0, TOP_GENRES) : items);
        state[id] = { phase: 'done', error: '' };
        if (id === activeId) renderStatus();
        if (!items.length) {
          state[id] = { phase: 'error', error: 'the list is empty' };
          if (id === activeId) renderStatus();
        }
      })
      .catch(function (err) {
        state[id] = { phase: 'error', error: err.message || String(err) };
        if (id === activeId) renderStatus();
      });
  }

  // --- Chips ---
  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function flag(code) {
    if (!/^[A-Za-z]{2}$/.test(code || '')) return '🌐'; // globe
    return String.fromCodePoint.apply(null, code.toUpperCase().split('').map(function (c) {
      return 0x1F1E6 + c.charCodeAt(0) - 65;
    }));
  }

  // parseSearchQuery splits tokens on whitespace, so a space inside a prefix value is
  // escaped with a backslash ("tag:smooth\ jazz") to keep it one value.
  function escapeValue(v) { return String(v).trim().replace(/\s+/g, '\\ '); }

  function queryFor(id, item) {
    if (id === 'genres') return 'tag:' + escapeValue(item.name);
    if (item.code) return 'cc:' + item.code.toLowerCase();
    return 'country:' + escapeValue(item.name);
  }

  function renderChips(id, items) {
    var panel = panelEls[id];
    panel.textContent = '';
    items.forEach(function (item) {
      var chip = el('button', {
        type: 'button', 'class': 'browse-chip', 'aria-pressed': 'false',
        'aria-label': item.name + ', ' + fmt(item.stationcount) + ' stations',
      });
      chip.appendChild(el('span', { 'class': 'browse-chip-name' },
        (id === 'countries' ? flag(item.code) + ' ' : '') + item.name));
      chip.appendChild(el('span', { 'class': 'browse-chip-count' }, ' · ' + fmt(item.stationcount)));
      chip.addEventListener('click', function () { pick(chip, queryFor(id, item)); });
      panel.appendChild(chip);
    });
  }

  function pick(chip, query) {
    if (selectedChip) selectedChip.setAttribute('aria-pressed', 'false');
    selectedChip = chip;
    chip.setAttribute('aria-pressed', 'true');
    document.getElementById('radio-q').value = query;
    var done = typeof radioSearch === 'function' ? radioSearch() : null;
    var reveal = function () {
      var st = document.getElementById('radio-status');
      if (st && st.scrollIntoView) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    if (done && done.then) done.then(reveal); else reveal();
  }

  // Open by default so the genres are in plain sight (discoverability); the toggle
  // still collapses it. Countries load when their tab is first shown.
  body.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  setToggleText(true);
  activate(activeId, false);
})();
