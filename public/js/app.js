import { api, onUnauthorized } from './api.js';
import { h, icon, clear, img, mosaic, likedArt, fmtTime, fmtNumber, toast, showMenu, promptDialog, bindSlider, setSlider } from './ui.js';
import { Player, uriToRoute } from './player.js';
import { Connect, deviceIdentity } from './connect.js';
import * as views from './views.js';

const $ = (id) => document.getElementById(id);
const ROUTES = ['home', 'search', 'library', 'album', 'artist', 'playlist', 'mix', 'radio', 'liked', 'genre', 'recent', 'stats', 'internals', 'docs', 'settings', 'downloads'];
const KEY_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

class App {
  constructor() {
    this.me = null;
    this.library = { playlists: [], artists: [], liked_count: 0 };
    this.liked = new Set();
    this.started = false;
    this.renderSeq = 0;
    this.cleanup = null;
    this.artistCache = new Map();
    let mode = null;
    try { mode = localStorage.getItem('ainos.right'); } catch { /* ignore */ }
    this.rightMode = mode === 'none' ? null : mode || (innerWidth > 960 ? 'now' : null);
  }

  // ----------------------------------------------------------------- boot
  async boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[ainos] SW registration failed', e));
    onUnauthorized(() => { if (!this.loggingIn) this.showLogin(); });
    try {
      await this.loadMe();
    } catch (err) {
      if (err.status === 401) return this.showLogin();
      document.body.append(h('div', { class: 'empty' }, h('h2', {}, 'Can’t reach Ainos'), h('p', {}, err.message)));
      return;
    }
    this.start();
  }

  async loadMe() {
    this.me = await api.get('/api/me');
    if (this.player) {
      this.player.me = this.me;
      this.player.skipsRemaining = this.me.limits.skips_remaining;
    }
    const badge = $('plan-badge');
    badge.textContent = this.me.plan;
    badge.classList.toggle('premium', this.me.plan === 'premium');
    $('user-menu-btn').textContent = (this.me.display_name || '?')[0].toUpperCase();
    $('user-menu-btn').title = this.me.display_name;
  }

  showLogin() {
    $('app').hidden = true;
    $('login').hidden = false;
    const form = $('login-form');
    if (form.dataset.bound) return;
    form.dataset.bound = '1';
    let mode = 'login';
    const setMode = (m) => {
      mode = m;
      $('login-title').textContent = m === 'login' ? 'Log in to Ainos' : 'Sign up for Ainos';
      $('login-submit').textContent = m === 'login' ? 'Log in' : 'Create account';
      $('login-switch-text').textContent = m === 'login' ? 'Don’t have an account?' : 'Already have an account?';
      $('login-switch').textContent = m === 'login' ? 'Sign up' : 'Log in';
      form.querySelector('.signup-only').hidden = m === 'login';
      form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      $('login-error').textContent = '';
    };
    $('login-switch').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    const submit = async (body, m) => {
      $('login-error').textContent = '';
      this.loggingIn = true;
      try {
        await api.post(m === 'login' ? '/api/auth/login' : '/api/auth/signup', body);
        if (this.started) return location.reload();
        await this.loadMe();
        this.start();
      } catch (err) {
        $('login-error').textContent = err.message;
      } finally {
        this.loggingIn = false;
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit({ username: form.username.value.trim(), password: form.password.value, display_name: form.display_name.value.trim() }, mode);
    });
    $('demo-login').addEventListener('click', () => submit({ username: 'demo', password: 'ainos-demo' }, 'login'));
    setMode('login');
    form.username.focus();
  }

  async start() {
    this.started = true;
    $('login').hidden = true;
    $('app').hidden = false;
    const identity = deviceIdentity();
    this.player = new Player({ deviceId: identity.id });
    this.player.me = this.me;
    this.player.skipsRemaining = this.me.limits.skips_remaining;
    this.connect = new Connect(this.player, identity);
    this.player.connect = this.connect;
    this.connect.start();

    this.player.addEventListener('change', () => this.onPlayerChange());
    this.player.addEventListener('debug', () => this.scheduleRight(400));
    this.player.addEventListener('error', (e) => toast(e.detail.message, { error: true }));
    this.player.addEventListener('downloads', () => this.renderLibrary());
    this.connect.addEventListener('change', () => { this.renderPlayerBar(); this.scheduleRight(); });
    this.connect.addEventListener('error', (e) => toast(e.detail.message || 'Remote command failed', { error: true }));

    this.bindChrome();
    await Promise.all([this.refreshLibrary(), this.loadLiked()]);
    addEventListener('hashchange', () => this.route());
    addEventListener('offline', () => toast('You’re offline. Downloaded music still plays.'));
    addEventListener('online', () => toast('Back online'));
    setInterval(() => this.loadMe().catch(() => {}), 120_000);
    this.route();
    this.renderPlayerBar();
    this.renderRight();
    this.tick();
  }

  // --------------------------------------------------------------- router
  parseHash() {
    const raw = location.hash.slice(1) || '/';
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'home', id: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : undefined, params: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  async route({ keepScroll = false } = {}) {
    const seq = ++this.renderSeq;
    this.cleanup?.();
    this.cleanup = null;
    const { name, id, params } = this.parseHash();
    const view = ROUTES.includes(name) ? views[name] : null;
    if (name !== 'search') $('topbar-search').hidden = true;
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
    this.renderLibrary();
    const main = $('main');
    const scroll = main.scrollTop;
    const container = $('view');
    const fresh = h('div');
    const slow = setTimeout(() => { if (seq === this.renderSeq) clear(container).append(h('div', { class: 'skeleton', style: { height: '220px', 'margin-top': '16px' } })); }, 180);
    try {
      if (!view) throw Object.assign(new Error('Page not found'), { status: 404 });
      const cleanup = await view(fresh, { ...params, id }, this);
      clearTimeout(slow);
      if (seq !== this.renderSeq) return cleanup?.();
      this.cleanup = cleanup || null;
      clear(container).append(...fresh.childNodes);
      main.scrollTop = keepScroll ? scroll : 0;
      document.title = this.titleFor(name, container);
      this.highlightPlaying();
    } catch (err) {
      clearTimeout(slow);
      if (seq !== this.renderSeq) return;
      clear(container).append(h('div', { class: 'empty' }, h('h2', {}, err.status === 404 ? 'Page not found' : 'Something went wrong'), h('p', {}, err.message), h('a', { class: 'btn btn-ghost btn-sm', href: '#/' }, 'Go home')));
    }
  }

  titleFor(name, container) {
    const h1 = container.querySelector('h1');
    const t = name === 'home' ? '' : h1?.textContent || name;
    return t ? `${t} · Ainos` : 'Ainos';
  }

  refresh() {
    return this.route({ keepScroll: true });
  }

  showSearch(q) {
    const box = $('topbar-search');
    box.hidden = false;
    const input = $('search-input');
    if (document.activeElement !== input) input.value = q;
    if (!q) setTimeout(() => input.focus(), 0);
  }

  // -------------------------------------------------------------- library
  async refreshLibrary() {
    try {
      this.library = await api.get('/api/me/library');
    } catch { /* offline */ }
    this.renderLibrary();
  }

  async loadLiked() {
    try {
      const { ids } = await api.get('/api/me/liked/ids');
      this.liked = new Set(ids);
    } catch { /* offline */ }
  }

  isLiked(id) {
    return this.liked.has(id);
  }

  async toggleLike(track) {
    const on = !this.liked.has(track.id);
    on ? this.liked.add(track.id) : this.liked.delete(track.id);
    this.syncLikeButtons(track.id);
    try {
      await (on ? api.put(`/api/me/liked/${track.id}`) : api.del(`/api/me/liked/${track.id}`));
      toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs');
      this.library.liked_count += on ? 1 : -1;
      this.renderLibrary();
    } catch (err) {
      on ? this.liked.delete(track.id) : this.liked.add(track.id);
      this.syncLikeButtons(track.id);
      toast(err.message, { error: true });
    }
  }

  syncLikeButtons(id) {
    const on = this.liked.has(id);
    for (const b of document.querySelectorAll(`[data-like-id="${CSS.escape(id)}"]`)) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-label', on ? 'Remove from Liked Songs' : 'Save to Liked Songs');
      clear(b).append(icon(on ? 'heart-fill' : 'heart'));
    }
  }

  renderLibrary() {
    const list = $('library-list');
    if (!list) return;
    const v = this.player?.view();
    const hash = location.hash || '#/';
    const item = (href, art, title, sub, uri) => {
      const playing = v?.contextUri && uri && v.contextUri === uri;
      return h('a', { class: `lib-item${hash === href ? ' active' : ''}`, href, title }, art, h('div', { class: 'meta' }, h('div', { class: `title${playing ? ' playing' : ''}` }, title), h('div', { class: 'sub' }, sub)));
    };
    const downloads = Object.keys(this.player?.downloads || {}).length;
    clear(list).append(...[
      item('#/liked', likedArt('art'), 'Liked Songs', `Playlist · ${this.library.liked_count} songs`, 'ainos:collection:liked'),
      downloads ? item('#/downloads', h('div', { class: 'art art-liked', style: { background: 'linear-gradient(135deg,#0f766e,#5eead4)' } }, icon('download')), 'Downloaded', `${downloads} songs`, 'ainos:downloads') : null,
      ...this.library.playlists.map((p) => item(`#/playlist/${p.id}`, mosaic(p.covers, 'art'), p.name, `Playlist · ${p.owner.name}`, p.uri)),
      ...this.library.artists.map((a) => item(`#/artist/${a.id}`, img(a.image, 'art round'), a.name, 'Artist', a.uri)),
    ].filter(Boolean));
  }

  async createPlaylist(trackIds = []) {
    const p = await api.post('/api/playlists', { track_ids: trackIds });
    await this.refreshLibrary();
    location.hash = `#/playlist/${p.id}`;
    toast(`Created “${p.name}”`);
    return p;
  }

  trackMenu(track, e, { playlist, position } = {}) {
    const p = this.player;
    const items = [
      { label: 'Add to queue', icon: 'queue', onClick: () => { p.addToQueue(track); toast('Added to queue'); } },
      { label: 'Go to song radio', icon: 'radio', onClick: () => (location.hash = `#/radio/${track.id}`) },
      { label: 'Go to artist', onClick: () => (location.hash = `#/artist/${track.artist.id}`) },
      { label: 'Go to album', onClick: () => (location.hash = `#/album/${track.album.id}`) },
      'sep',
      {
        label: 'Add to playlist', icon: 'plus', submenu: [
          { label: 'New playlist', icon: 'plus', onClick: () => this.createPlaylist([track.id]) },
          ...(this.library.playlists.length ? ['sep'] : []),
          ...this.library.playlists.map((pl) => ({
            label: pl.name,
            onClick: async () => { await api.post(`/api/playlists/${pl.id}/tracks`, { track_ids: [track.id] }); toast(`Added to ${pl.name}`); this.refreshLibrary(); if (location.hash === `#/playlist/${pl.id}`) this.refresh(); },
          })),
        ],
      },
      { label: this.isLiked(track.id) ? 'Remove from your Liked Songs' : 'Save to your Liked Songs', icon: this.isLiked(track.id) ? 'heart-fill' : 'heart', onClick: () => this.toggleLike(track) },
    ];
    if (playlist?.is_owner && Number.isInteger(position)) {
      items.push({ label: 'Remove from this playlist', icon: 'close', onClick: async () => { await api.del(`/api/playlists/${playlist.id}/tracks/${position}`); this.refresh(); this.refreshLibrary(); } });
    }
    items.push(p.downloads[track.id]
      ? { label: 'Remove download', icon: 'download', onClick: () => p.removeDownload(track.id).then(() => toast('Download removed')) }
      : { label: 'Download', icon: 'download', onClick: () => p.download([track]).then(() => toast('Downloaded')).catch((err) => toast(err.message, { error: true })) });
    showMenu(e, items);
  }

  // ----------------------------------------------------------- player UI
  bindChrome() {
    const p = this.player;
    $('btn-play').addEventListener('click', () => p.toggle());
    $('btn-next').addEventListener('click', () => p.next('fwdbtn'));
    $('btn-prev').addEventListener('click', () => p.previous());
    $('btn-shuffle').addEventListener('click', () => p.toggleShuffle());
    $('btn-repeat').addEventListener('click', () => p.cycleRepeat());
    $('btn-mute').addEventListener('click', () => p.toggleMute());
    $('btn-nowplaying').addEventListener('click', () => this.setRight(this.rightMode === 'now' ? null : 'now'));
    $('btn-queue').addEventListener('click', () => this.setRight(this.rightMode === 'queue' ? null : 'queue'));
    $('btn-devices').addEventListener('click', () => this.setRight(this.rightMode === 'devices' ? null : 'devices'));
    $('nav-back').addEventListener('click', () => history.back());
    $('nav-fwd').addEventListener('click', () => history.forward());
    $('new-playlist').addEventListener('click', () => this.createPlaylist());
    $('user-menu-btn').addEventListener('click', (e) => showMenu(e, [
      { label: 'Your stats', icon: 'sparkle', onClick: () => (location.hash = '#/stats') },
      { label: 'Recently played', icon: 'clock', onClick: () => (location.hash = '#/recent') },
      { label: 'Downloaded', icon: 'download', onClick: () => (location.hash = '#/downloads') },
      { label: 'Under the hood', icon: 'cpu', onClick: () => (location.hash = '#/internals') },
      { label: 'How Spotify works (evidence)', onClick: () => (location.hash = '#/docs') },
      { label: 'Settings', onClick: () => (location.hash = '#/settings') },
      'sep',
      { label: 'Log out', onClick: () => this.logout() },
    ]));

    let searchTimer;
    $('search-input').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = e.target.value;
        history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/search');
        this.route();
      }, 180);
    });

    this.seekSlider = bindSlider($('seek'), {
      onInput: (f) => { const v = p.view(); setSlider($('seek'), $('seek-fill'), $('seek-thumb'), f); $('time-cur').textContent = fmtTime(f * v.durationMs); },
      onCommit: (f) => p.seek(f * p.view().durationMs),
    });
    this.volSlider = bindSlider($('volume'), {
      onInput: (f) => { setSlider($('volume'), $('volume-fill'), $('volume-thumb'), f); p.setVolume(f); },
      onCommit: (f) => p.setVolume(f),
    });

    addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.closest?.('input, textarea, select, [contenteditable], dialog')) return;
      if (e.code === 'Space' && !t.closest?.('button, a, [role="slider"]')) { e.preventDefault(); p.toggle(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight') { e.preventDefault(); p.next('fwdbtn'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft') { e.preventDefault(); p.previous(); }
    });
  }

  onPlayerChange() {
    this.renderPlayerBar();
    this.highlightPlaying();
    this.renderLibrary();
    this.scheduleRight();
    const v = this.player.view();
    document.title = v.track && v.isPlaying ? `${v.track.title} • ${v.track.artist.name}` : this.titleFor(this.parseHash().name, $('view'));
  }

  renderPlayerBar() {
    const v = this.player.view();
    const left = clear($('np-left'));
    if (v.track) {
      const t = v.track;
      const like = h('button', { class: `icon-btn${this.isLiked(t.id) ? ' on' : ''}`, 'aria-label': 'Save to Liked Songs', dataset: { likeId: t.id } }, icon(this.isLiked(t.id) ? 'heart-fill' : 'heart'));
      like.addEventListener('click', () => this.toggleLike(t));
      like.style.setProperty('color', this.isLiked(t.id) ? 'var(--accent)' : '');
      left.append(
        h('a', { href: `#/album/${t.album.id}` }, img(t.album.cover)),
        h('div', { class: 'meta' }, h('div', { class: 'title' }, h('a', { href: `#/album/${t.album.id}` }, t.title)), h('div', { class: 'sub' }, h('a', { href: `#/artist/${t.artist.id}` }, t.artist.name))),
        like);
    }
    const play = $('btn-play');
    clear(play).append(icon(v.isPlaying ? 'pause' : 'play'));
    play.setAttribute('aria-label', v.isPlaying ? 'Pause' : 'Play');
    $('btn-shuffle').setAttribute('aria-pressed', String(!!v.shuffle));
    const rep = $('btn-repeat');
    rep.setAttribute('aria-pressed', String(v.repeat !== 'off'));
    rep.setAttribute('aria-label', `Repeat: ${v.repeat}`);
    clear(rep).append(icon(v.repeat === 'track' ? 'repeat-one' : 'repeat'));
    clear($('btn-mute')).append(icon(v.muted || v.volume === 0 ? 'mute' : 'volume'));
    $('btn-next').disabled = !v.track;
    $('btn-prev').disabled = !v.track;
    $('btn-nowplaying').setAttribute('aria-pressed', String(this.rightMode === 'now'));
    $('btn-queue').setAttribute('aria-pressed', String(this.rightMode === 'queue'));
    $('btn-devices').setAttribute('aria-pressed', String(this.rightMode === 'devices' || v.remote));
    const app = $('app');
    app.classList.toggle('remote', v.remote);
    const bar = clear($('connect-bar'));
    if (v.remote) bar.append(icon('devices'), `Playing on ${this.connect.deviceName(v.deviceId)}`);
  }

  tick() {
    const step = () => {
      const v = this.player.view();
      if (!this.seekSlider.isDragging()) {
        const f = v.durationMs ? v.positionMs / v.durationMs : 0;
        setSlider($('seek'), $('seek-fill'), $('seek-thumb'), f);
        $('time-cur').textContent = fmtTime(v.positionMs);
        $('seek-buffer').style.width = `${v.durationMs && v.bufferedMs ? Math.min(100, (v.bufferedMs / v.durationMs) * 100) : 0}%`;
      }
      $('time-dur').textContent = fmtTime(v.durationMs);
      if (!this.volSlider.isDragging()) setSlider($('volume'), $('volume-fill'), $('volume-thumb'), v.muted ? 0 : v.volume ?? 1);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  highlightPlaying() {
    if (!this.player) return;
    const v = this.player.view();
    for (const row of document.querySelectorAll('.tl-row')) {
      const on = !!v.track && row.dataset.trackId === v.track.id && (!v.contextUri || !row.dataset.ctx || row.dataset.ctx === v.contextUri);
      row.classList.toggle('playing', on);
      const n = row.querySelector('.n');
      if (!n) continue;
      if (!n.dataset.n) n.dataset.n = n.textContent;
      if (on && v.isPlaying) { if (!n.querySelector('.eq')) clear(n).append(h('span', { class: 'eq', 'aria-label': 'Playing' }, h('i'), h('i'), h('i'))); }
      else if (n.textContent !== n.dataset.n) n.textContent = n.dataset.n;
    }
    for (const fab of document.querySelectorAll('[data-ctx-uri]')) {
      const on = v.isPlaying && v.contextUri === fab.dataset.ctxUri;
      clear(fab).append(icon(on ? 'pause' : 'play'));
    }
  }

  // ---------------------------------------------------------- right panel
  setRight(mode) {
    this.rightMode = mode;
    try { localStorage.setItem('ainos.right', mode || 'none'); } catch { /* ignore */ }
    this.renderRight();
    this.renderPlayerBar();
  }

  scheduleRight(delay = 0) {
    if (this.rightTimer) return;
    this.rightTimer = setTimeout(() => { this.rightTimer = null; this.renderRight(); }, delay);
  }

  async renderRight() {
    const panel = $('rightpanel');
    const app = $('app');
    panel.hidden = !this.rightMode;
    app.classList.toggle('no-right', !this.rightMode);
    if (!this.rightMode) return;
    const seq = (this.rightSeq = (this.rightSeq || 0) + 1);
    const content = h('div');
    const head = (title) => {
      const close = h('button', { class: 'icon-btn', 'aria-label': 'Close panel' }, icon('close'));
      close.addEventListener('click', () => this.setRight(null));
      return h('div', { class: 'rp-head' }, h('h2', {}, title), close);
    };
    const v = this.player.view();
    if (this.rightMode === 'devices') {
      content.append(head('Connect to a device'));
      const me = this.connect.identity.id;
      const devices = this.connect.devices.slice().sort((a, b) => (b.id === me) - (a.id === me));
      for (const d of devices) {
        const active = d.is_active || (!v.remote && d.id === me && v.track);
        const b = h('button', { class: `device${active ? ' active' : ''}` }, icon(d.type === 'smartphone' || d.type === 'tablet' ? 'phone' : 'computer'),
          h('div', {}, d.id === me ? 'This browser' : d.name, h('small', {}, active ? (v.isPlaying ? 'Playing' : 'Active') : d.id === me ? d.name : 'Tap to play here')));
        b.addEventListener('click', async () => {
          if (active) return;
          try { await this.connect.transfer(d.id); } catch (err) { toast(err.message, { error: true }); }
        });
        content.append(b);
      }
      if (!this.connect.connected) content.append(h('p', { class: 'dim small' }, 'Connecting…'));
      content.append(h('div', { class: 'rp-card' }, h('h3', {}, 'Try it'), h('p', { class: 'muted small', style: { margin: 0 } },
        'Open Ainos in another tab, browser or phone and log in with the same account. Each one shows up here. Pick a device to move playback there (it continues at the same position), or control the active device from any other.',
        h('br'), h('br'), 'For phones on your Wi-Fi, start the server with ', h('code', { class: 'mono' }, 'HOST=0.0.0.0'), '.')));
    } else if (this.rightMode === 'queue') {
      content.append(head('Queue'));
      if (!v.track) content.append(h('p', { class: 'muted' }, 'Nothing playing.'));
      else {
        content.append(h('div', { class: 'queue-label' }, 'Now playing'), this.queueItem(v.track, { current: true }));
        if (v.remote) {
          content.append(h('p', { class: 'muted small' }, `The queue lives on ${this.connect.deviceName(v.deviceId)}. Use “Add to queue” here and it is sent there.`));
        } else {
          const p = this.player;
          if (p.userQueue.length) {
            content.append(h('div', { class: 'queue-label' }, 'Next in queue'));
            p.userQueue.forEach((t, i) => content.append(this.queueItem(t, { onPlay: () => p.playFromQueue(i), onRemove: () => p.removeFromQueue(i) })));
          }
          const up = p.upNext(40);
          if (up.length) {
            content.append(h('div', { class: 'queue-label' }, `Next from: ${p.context?.title || ''}`));
            up.forEach(({ track, orderIndex }) => content.append(this.queueItem(track, { onPlay: () => p.jumpTo(orderIndex) })));
          }
          if (!p.userQueue.length && !up.length) content.append(h('p', { class: 'muted small' }, p.repeat === 'off' ? 'Nothing after this one. Turn on repeat or add songs to the queue.' : 'Repeat is on.'));
        }
      }
    } else {
      content.append(head(v.contextTitle || 'Now playing'));
      if (!v.track) {
        content.append(h('p', { class: 'muted' }, 'Pick something to play. Details about the stream, its loudness and audio features show up here.'));
      } else {
        const t = v.track;
        content.append(img(t.album.cover, 'rp-cover'), h('div', { class: 'rp-title' }, h('a', { href: `#/album/${t.album.id}` }, t.title)), h('div', { class: 'muted' }, h('a', { href: `#/artist/${t.artist.id}` }, t.artist.name)));
        if (v.contextUri && uriToRoute(v.contextUri)) content.append(h('div', { class: 'dim small', style: { 'margin-top': '4px' } }, 'Playing from ', h('a', { href: uriToRoute(v.contextUri) }, v.contextTitle || 'context')));
        if (!v.remote) {
          const d = this.player.debug();
          const lat = d.metrics.latencies.at(-1);
          const nextUp = this.player.peekNext();
          const cacheState = h('dd', {}, '…');
          this.player.isCached(this.player.deck.manifest).then((s) => { cacheState.textContent = s || 'network'; });
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, 'Stream'),
            h('dl', { class: 'kv' },
              h('dt', {}, 'Quality'), h('dd', {}, d.active.quality ? `${d.active.quality} · ${d.active.kbps} kbps` : '—'),
              h('dt', {}, 'Loudness'), h('dd', {}, d.normalization ? `${d.normalization.loudness_lufs.toFixed(1)} LUFS → ${d.active.gainDb >= 0 ? '+' : ''}${d.active.gainDb.toFixed(1)} dB` : '—'),
              h('dt', {}, 'Start latency'), h('dd', {}, lat && lat.title === t.title ? `${lat.ms} ms${lat.prefetched ? ' (prefetched)' : ''}` : '—'),
              h('dt', {}, 'Source'), cacheState,
              h('dt', {}, 'Next track'), h('dd', {}, nextUp ? `${nextUp.title} · ${d.prefetch.trackId === nextUp.id ? d.prefetch.state : 'loads at −30 s'}` : '—'),
              h('dt', {}, 'Counts as a stream'), h('dd', {}, d.session ? (d.session.msPlayed >= 30000 ? 'yes ✓' : `after ${Math.ceil((30000 - d.session.msPlayed) / 1000)} s more`) : '—'))));
        }
        const f = t.features;
        if (f) {
          const bar = (label, val) => h('div', { class: 'feature-bar' }, h('span', {}, label), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(val * 100)}%` } })), h('span', { class: 'dim' }, `${Math.round(val * 100)}`));
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, 'Audio features'),
            h('div', { class: 'dim small', style: { 'margin-bottom': '8px' } }, `${Math.round(f.tempo)} BPM · ${KEY_NAMES[f.key]} ${f.mode ? 'major' : 'minor'} · ${t.genre}`),
            h('div', { class: 'feature-bars' }, bar('Energy', f.energy), bar('Danceability', f.danceability), bar('Valence', f.valence), bar('Acousticness', f.acousticness))));
        }
        let artist = this.artistCache.get(t.artist.id);
        if (!artist) {
          api.get(`/api/artists/${t.artist.id}`).then((a) => { this.artistCache.set(a.id, a); this.scheduleRight(); }).catch(() => {});
        } else {
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, 'About the artist'),
            h('a', { href: `#/artist/${artist.id}`, style: { display: 'flex', gap: '12px', 'align-items': 'center', 'margin-bottom': '8px' } }, img(artist.image, 'art'), h('div', {}, h('b', {}, artist.name), h('div', { class: 'dim small' }, `${fmtNumber(artist.monthly_listeners)} monthly listeners`))),
            h('p', { class: 'muted small', style: { margin: 0 } }, artist.bio)));
          content.querySelector('.rp-card:last-child .art')?.style.setProperty('width', '48px');
          content.querySelector('.rp-card:last-child .art')?.style.setProperty('border-radius', '50%');
        }
      }
    }
    if (seq !== this.rightSeq) return;
    clear(panel).append(...content.childNodes);
  }

  queueItem(t, { current = false, onPlay, onRemove } = {}) {
    const row = h('div', { class: `queue-item${current ? ' current' : ''}` }, img(t.album.cover), h('div', { class: 'meta' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artist.name)));
    if (onPlay) { row.style.cursor = 'pointer'; row.addEventListener('dblclick', onPlay); row.addEventListener('click', (e) => { if (matchMedia('(pointer: coarse)').matches || e.detail === 0) onPlay(); }); }
    if (onRemove) {
      const x = h('button', { class: 'icon-btn', 'aria-label': `Remove ${t.title} from queue` }, icon('close'));
      x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
      row.append(x);
    }
    return row;
  }

  async logout() {
    await this.player?.flush();
    await api.post('/api/auth/logout').catch(() => {});
    location.hash = '#/';
    location.reload();
  }
}

const app = new App();
window.ainos = app; // handy for poking at internals from DevTools
app.boot();

// expose for views that want to open dialogs
export { app, promptDialog };
