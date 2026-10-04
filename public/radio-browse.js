// "Browse by genre / country" for the Internet Radio Search section: two labelled
// dropdowns on one line (Genre ▾, Country ▾) with station counts. Picking one rewrites
// its filter in #radio-q (tag:… / cc:… — any words typed there are kept) and runs the
// page's own radioSearch(), so the two combine and the box always shows what is searched.
// Lists come from /api/radio/tags and /api/radio/countries (cached 24 h server-side).
// (A wall of 40+ chips here was unreadable and pushed the results far down.)
(function () {
  'use strict';

  var root = document.getElementById('radio-browse');
  if (!root) return;

  var LISTS = [
    { id: 'genre', label: 'Genre', any: 'Any genre', url: '/api/radio/tags', key: 'tags', noun: 'genres' },
    { id: 'country', label: 'Country', any: 'Any country', url: '/api/radio/countries', key: 'countries', noun: 'countries' },
  ];

  var style = document.createElement('style');
  style.textContent = [
    '#radio-browse { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }',
    '#radio-browse .browse-field { display: flex; align-items: center; gap: 6px; flex: 1 1 150px; min-width: 0; }',
    '#radio-browse label { font-size: 12px; color: var(--text-dim); font-weight: 600; }',
    '#radio-browse select { flex: 1; min-width: 0; font-size: 14px; padding: 7px 8px; border-radius: 8px;'
      + ' background: var(--surface2); color: var(--text); border: 1px solid var(--text-dim); }',
    '#radio-browse select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }',
    '#radio-browse select.active { border-color: var(--accent); }',
    '#browse-status { flex-basis: 100%; font-size: 12px; color: var(--accent); }',
    '#browse-status:empty { display: none; }',
    '#browse-status .browse-retry { margin-left: 8px; font-size: 12px; padding: 3px 10px; }',
  ].join('\n');
  document.head.appendChild(style);

  var selects = {};
  LISTS.forEach(function (l) {
    var field = document.createElement('div');
    field.className = 'browse-field';
    var label = document.createElement('label');
    label.htmlFor = 'browse-' + l.id;
    label.textContent = l.label;
    var select = document.createElement('select');
    select.id = 'browse-' + l.id;
    select.disabled = true;
    select.appendChild(new Option('Loading ' + l.noun + '…', ''));
    select.addEventListener('change', function () { apply(); });
    field.appendChild(label);
    field.appendChild(select);
    root.appendChild(field);
    selects[l.id] = select;
  });
  var status = document.createElement('div');
  status.id = 'browse-status';
  status.setAttribute('role', 'status');
  root.appendChild(status);

  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function flag(code) {
    if (!/^[A-Za-z]{2}$/.test(code || '')) return '🌐';
    return String.fromCodePoint.apply(null, code.toUpperCase().split('').map(function (c) {
      return 0x1F1E6 + c.charCodeAt(0) - 65;
    }));
  }

  // parseSearchQuery splits tokens on whitespace, so a space inside a prefix value is
  // escaped with a backslash ("tag:smooth\ jazz") to keep it one value.
  function escapeValue(v) { return String(v).trim().replace(/\s+/g, '\\ '); }

  function fill(l, items) {
    var select = selects[l.id];
    select.textContent = '';
    select.appendChild(new Option(l.any, ''));
    // Genres: most stations first (discovery). Countries: A–Z (typing a letter jumps there).
    items = items.slice().sort(l.id === 'country'
      ? function (a, b) { return a.name.localeCompare(b.name); }
      : function (a, b) { return b.stationcount - a.stationcount; });
    items.forEach(function (item) {
      var text = (l.id === 'country' ? flag(item.code) + ' ' : '') + item.name + ' · ' + fmt(item.stationcount);
      var value = l.id === 'genre' ? 'tag:' + escapeValue(item.name)
        : item.code ? 'cc:' + item.code.toLowerCase() : 'country:' + escapeValue(item.name);
      select.appendChild(new Option(text, value));
    });
    select.disabled = false;
  }

  var errors = {};
  function renderStatus() {
    status.textContent = '';
    var failed = LISTS.filter(function (l) { return errors[l.id]; });
    if (!failed.length) return;
    status.appendChild(document.createTextNode(failed.map(function (l) {
      return 'Couldn’t load ' + l.noun + ': ' + errors[l.id];
    }).join(' · ')));
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'browse-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', function () { failed.forEach(load); });
    status.appendChild(retry);
  }

  function load(l) {
    errors[l.id] = '';
    renderStatus();
    fetch(l.url)
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          var items = Array.isArray(data[l.key]) ? data[l.key] : [];
          if (!items.length) throw new Error('the list is empty');
          return items;
        });
      })
      .then(function (items) { fill(l, items); })
      .catch(function (err) {
        errors[l.id] = err.message || String(err);
        selects[l.id].textContent = '';
        selects[l.id].appendChild(new Option(l.label + ' list unavailable', ''));
        renderStatus();
      });
  }

  // Rewrite the box: keep typed words, replace genre/country filters with the dropdowns'.
  function apply() {
    var box = document.getElementById('radio-q');
    var kept = String(box.value || '').trim().split(/(?<!\\)\s+/).filter(function (t) {
      return t && !/^(tag|cc|country):/i.test(t);
    });
    LISTS.forEach(function (l) {
      var v = selects[l.id].value;
      selects[l.id].classList.toggle('active', !!v);
      if (v) kept.push(v);
    });
    box.value = kept.join(' ');
    if (box.value && typeof radioSearch === 'function') radioSearch();
  }

  LISTS.forEach(load);
})();
