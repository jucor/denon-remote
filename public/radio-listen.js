// "Listen here": play a saved station (My Stations or Favourites) on this device — the phone
// or computer showing the page — instead of the receiver. The audio comes from the server's
// relay (GET /api/radio/listen?url=<saved URL field>&lid=<this tab>), same origin, so HTTP-only
// and geo-blocked stations play too. Song titles arrive over the WebSocket as
// { type: 'listenTitle', lid, title }; only this tab's own are shown.
//
// The page's renderers call radioListen.button(station) for each row; handleEvent() forwards
// listenTitle events to radioListen.onTitle().
(function () {
  const lid = (crypto.getRandomValues(new Uint32Array(2))).reduce((s, n) => s + n.toString(36), '');
  let current = null; // { name, url, logo } of the station playing (or paused) here
  let playing = false; // false while paused from the lock screen
  let song = '';
  let bar, nowEl, stopBtn, audio;

  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'listen-bar';
    bar.className = 'listen-bar';
    bar.style.display = 'none';
    nowEl = document.createElement('div');
    nowEl.id = 'listen-now';
    nowEl.className = 'listen-now';
    nowEl.setAttribute('role', 'status');
    nowEl.setAttribute('aria-live', 'polite');
    stopBtn = document.createElement('button');
    stopBtn.id = 'listen-stop';
    stopBtn.type = 'button';
    stopBtn.className = 'listen-stop';
    stopBtn.textContent = '■ Stop';
    stopBtn.setAttribute('aria-label', 'Stop listening on this device');
    stopBtn.onclick = stop;
    audio = document.createElement('audio');
    audio.id = 'listen-audio';
    audio.preload = 'none';
    audio.addEventListener('error', () => {
      if (!current || !audio.getAttribute('src')) return;
      const name = current.name;
      halt();
      showBar('Could not play “' + name + '” on this device');
    });
    bar.append(nowEl, stopBtn, audio);
    document.body.appendChild(bar);
  }

  function showBar(text) {
    nowEl.textContent = text;
    bar.style.display = '';
    document.body.classList.add('listening');
  }

  function render() {
    if (current) showBar((playing ? 'On this device · ' : 'Paused on this device · ') + current.name + (song ? ' — ' + song : ''));
    for (const b of document.querySelectorAll('.radio-listen')) {
      const on = isPlaying(b._station);
      b.textContent = on ? '■ Stop' : '🎧 Listen here';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', (on ? 'Stop listening to ' : 'Listen to ') + b._station.name + ' on this device');
    }
    updateMediaSession();
  }

  function listen(station) {
    ensureBar();
    current = { name: station.name, url: station.url, logo: station.logo || station.favicon || '' };
    song = '';
    playing = true;
    audio.src = '/api/radio/listen?url=' + encodeURIComponent(station.url) + '&lid=' + lid;
    render();
    const p = audio.play();
    if (p && p.catch) p.catch(() => {}); // failures surface through the 'error' event
  }

  const isPlaying = (station) => playing && !!current && station.url === current.url && station.name === current.name;

  // Drop the stream's connection (live radio: nothing to buffer, the relay must let go).
  function unload() {
    playing = false;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  function halt() {
    unload();
    current = null;
    song = '';
    render();
  }

  // Lock-screen pause: the station stays, so the lock screen's play resumes it.
  function pause() {
    if (!current) return;
    unload();
    render();
  }

  function stop() {
    halt();
    bar.style.display = 'none';
    document.body.classList.remove('listening');
  }

  function button(station) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'radio-listen';
    b.title = 'Play on this phone or computer, not on the receiver';
    b._station = station;
    b.onclick = (ev) => {
      ev.stopPropagation(); // the row itself plays on the receiver
      if (isPlaying(station)) stop(); else listen(station);
    };
    b.textContent = '🎧 Listen here';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Listen to ' + station.name + ' on this device');
    // A row re-rendered while it plays keeps showing Stop.
    queueMicrotask(render);
    return b;
  }

  function onTitle(msg) {
    if (!msg || msg.lid !== lid || !current) return;
    song = msg.title || '';
    render();
  }

  // Lock screen / headphone controls on phones.
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) { ms.metadata = null; ms.playbackState = 'none'; return; }
    try {
      ms.metadata = new MediaMetadata({
        title: song || current.name,
        artist: song ? current.name : 'Radio',
        artwork: /^https?:\/\//i.test(current.logo) ? [{ src: current.logo }] : [],
      });
      ms.playbackState = playing ? 'playing' : 'paused';
      ms.setActionHandler('play', () => { if (current) listen(current); });
      ms.setActionHandler('pause', pause);
      ms.setActionHandler('stop', stop);
    } catch (e) { /* older browsers: no lock-screen controls */ }
  }

  window.radioListen = { lid, button, onTitle, stop, pause };
})();
