import { api, onUnauthorized } from './api.js';
import { h, icon, clear, img, mosaic, likedArt, fmtTime, fmtNumber, toast, showMenu, promptDialog, bindSlider, setSlider, safely } from './ui.js';
import { Player, uriToRoute } from './player.js';
import { Connect, deviceIdentity } from './connect.js';
import { getLang, setLang, t, langDisplayName, translateGenre, errorText } from './i18n.js';
import * as views from './views.js';
import * as church from './church.js';
import { watchUrl } from './youtube.js';

const $ = (id) => document.getElementById(id);
const ROUTES = ['home', 'search', 'library', 'album', 'artist', 'song', 'playlist', 'mix', 'radio', 'liked', 'genre', 'recent', 'stats', 'internals', 'docs', 'settings', 'downloads', 'church', 'setlist'];
const VIEWS = { ...views, church: church.church, setlist: church.setlist };
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
    this.scriptureCards = new Map(); // song id → its Scripture card, kept across re-renders so an open passage stays open
    this.songDetails = new Map(); // song id → { at, promise } of GET /api/songs/:id (lyrics, sources, timings)
    this.lyrics = null; // { key, view } of the lyrics view in the right panel, kept so its scroll position survives re-renders
    let mode = null;
    try { mode = localStorage.getItem('ainos.right'); } catch { /* ignore */ }
    this.rightMode = mode === 'none' ? null : mode || (innerWidth > 960 ? 'now' : null);
  }

  // ----------------------------------------------------------------- boot
  async boot() {
    // The router owns the hash, so the skip link moves focus instead of navigating to "#main".
    $('skip-link').addEventListener('click', (e) => { e.preventDefault(); $('main').focus(); });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[ainos] SW registration failed', e));
    onUnauthorized(() => { if (!this.loggingIn) this.showLogin(); });
    try {
      await this.loadMe();
    } catch (err) {
      if (err.status === 401) return this.showLogin();
      $('boot').hidden = true;
      const retry = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, t('tryAgain'));
      retry.addEventListener('click', () => location.reload());
      document.body.append(h('div', { class: 'empty boot-error', role: 'alert' }, h('h2', {}, t('cantReachAinos')), h('p', {}, errorText(err)), retry));
      return;
    }
    this.start();
  }

  async loadMe() {
    const prevLang = getLang();
    this.me = await api.get('/api/me');
    if (this.pendingLang) {
      // A local language change hasn't reached the server yet: keep it (and retry) instead of reverting to the stale server value.
      if (this.me.language === this.pendingLang) this.pendingLang = null;
      else this.saveLanguage(this.pendingLang).catch(() => {});
      this.me.language = getLang();
    } else if (this.me.language && this.me.language !== prevLang) {
      setLang(this.me.language);
    }
    if (this.player) {
      this.player.me = this.me;
    }
    const sel = $('lang-select');
    if (sel) sel.value = getLang();
    $('user-menu-btn').textContent = (this.me.display_name || '?')[0].toUpperCase();
    $('user-menu-btn').title = this.me.display_name;
    this.applyI18n();
    if (this.started) this.renderDemoBanner();
    // The 2-minute refresh can pick up a language changed on another device: re-render, don't leave a mixed-language UI.
    if (this.started && this.player && getLang() !== prevLang) {
      this.renderLibrary();
      this.renderPlayerBar();
      this.renderRight();
      this.refresh();
    }
  }

  async changeLanguage(lang) {
    setLang(lang);
    const sel = $('lang-select');
    if (sel) sel.value = lang;
    if (this.me) {
      this.me.language = lang;
      this.pendingLang = lang;
      try {
        await this.saveLanguage(lang);
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    }
    this.scriptureCards.clear();
    this.applyI18n();
    this.renderLibrary();
    this.renderPlayerBar();
    this.renderRight();
    await this.refresh();
    toast(t('languageChangedToast', { lang: langDisplayName(lang) }));
  }

  async saveLanguage(lang) {
    await api.post('/api/me/language', { language: lang });
    if (this.pendingLang === lang) this.pendingLang = null;
  }

  applyI18n() {
    const setTxt = (id, key) => { const el = $(id); if (el) el.textContent = t(key); };
    setTxt('login-brand-sub', 'brandSubtitle');
    setTxt('sidebar-brand-sub', 'brandSubtitle');
    setTxt('lbl-username', 'username');
    setTxt('lbl-displayname', 'displayName');
    setTxt('lbl-password', 'password');
    setTxt('demo-login', 'demoBtn');
    setTxt('church-demo-login', 'churchDemoBtn');
    setTxt('nav-church-text', 'navChurch');
    setTxt('skip-link', 'skipToContent');
    setTxt('boot-text', 'loadingApp');
    setTxt('demo-hint', 'demoHint');
    setTxt('login-or', 'orDivider');
    setTxt('nav-home-text', 'navHome');
    setTxt('nav-search-text', 'navSearch');
    setTxt('nav-library-text', 'navLibrary');
    setTxt('nav-internals-text', 'navInternals');
    setTxt('mnav-home-text', 'navHome');
    setTxt('mnav-search-text', 'navSearch');
    setTxt('mnav-library-text', 'navLibraryShort');
    setTxt('mnav-internals-text', 'navInternalsShort');
    setTxt('lang-label', 'languageLabel');
    const np = $('new-playlist');
    if (np) { np.title = t('createPlaylist'); np.setAttribute('aria-label', t('createPlaylist')); }
    $('nav-back')?.setAttribute('aria-label', t('goBack'));
    $('nav-fwd')?.setAttribute('aria-label', t('goForward'));
    const si = $('search-input');
    if (si) { si.placeholder = t('searchPlaceholder'); si.setAttribute('aria-label', t('navSearch')); }
    $('lang-select')?.setAttribute('aria-label', t('languageLabel'));
    $('user-menu-btn')?.setAttribute('aria-label', t('accountLabel'));
    $('btn-shuffle')?.setAttribute('aria-label', t('shuffle'));
    $('btn-prev')?.setAttribute('aria-label', t('previous'));
    $('btn-next')?.setAttribute('aria-label', t('next'));
    $('btn-nowplaying')?.setAttribute('aria-label', t('nowPlayingView'));
    $('btn-queue')?.setAttribute('aria-label', t('queue'));
    $('btn-devices')?.setAttribute('aria-label', t('connectDevice'));
    $('btn-mute')?.setAttribute('aria-label', t('mute'));
    $('volume')?.setAttribute('aria-label', t('volume'));
  }

  showLogin() {
    $('boot').hidden = true;
    this.applyI18n();
    $('app').hidden = true;
    $('login').hidden = false;
    const form = $('login-form');
    if (form.dataset.bound) return;
    form.dataset.bound = '1';
    let mode = 'login';
    const setMode = (m) => {
      mode = m;
      $('login-title').textContent = m === 'login' ? t('loginTitle') : t('signupTitle');
      $('login-submit').textContent = m === 'login' ? t('loginBtn') : t('signupBtn');
      $('login-switch-text').textContent = m === 'login' ? t('noAccount') : t('hasAccount');
      $('login-switch').textContent = m === 'login' ? t('signupLink') : t('loginLink');
      form.querySelector('.signup-only').hidden = m === 'login';
      form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      $('login-error').textContent = '';
    };
    $('login-switch').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    const busy = (on) => { for (const b of form.querySelectorAll('button')) b.disabled = on; form.setAttribute('aria-busy', String(on)); };
    const submit = async (body, m) => {
      $('login-error').textContent = '';
      this.loggingIn = true;
      busy(true);
      try {
        const url = { login: '/api/auth/login', signup: '/api/auth/signup', demo: '/api/auth/demo', churchDemo: '/api/auth/church-demo' }[m];
        if (m === 'churchDemo') location.hash = '#/church';
        await api.post(url, { ...body, language: getLang() });
        if (this.started) return location.reload();
        await this.loadMe();
        this.start();
      } catch (err) {
        $('login-error').textContent = errorText(err);
      } finally {
        this.loggingIn = false;
        busy(false);
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit({ username: form.username.value.trim(), password: form.password.value, display_name: form.display_name.value.trim() }, mode);
    });
    $('demo-login').addEventListener('click', () => submit({}, 'demo'));
    $('church-demo-login').addEventListener('click', () => submit({}, 'churchDemo'));
    setMode(new URLSearchParams(location.hash.split('?')[1] || '').get('signup') ? 'signup' : 'login');
    form.username.focus();
  }

  async start() {
    this.started = true;
    $('boot').hidden = true;
    $('login').hidden = true;
    $('app').hidden = false;
    const identity = deviceIdentity();
    this.player = new Player({ deviceId: identity.id });
    this.player.me = this.me;
    this.connect = new Connect(this.player, identity);
    this.player.connect = this.connect;
    this.connect.start();
    church.onStart(this);

    this.player.addEventListener('change', () => this.onPlayerChange());
    this.player.addEventListener('debug', () => this.scheduleRight(400));
    this.player.addEventListener('error', (e) => toast(e.detail.message, { error: true }));
    this.player.addEventListener('downloads', () => this.renderLibrary());
    this.connect.addEventListener('change', () => { this.renderPlayerBar(); this.scheduleRight(); });
    this.connect.addEventListener('error', (e) => toast(e.detail.message || t('remoteCommandFailed'), { error: true }));

    this.buildRightPanel();
    this.bindChrome();
    this.renderDemoBanner();
    await Promise.all([this.refreshLibrary(), this.loadLiked()]);
    addEventListener('hashchange', () => this.route({ focus: true }));
    addEventListener('offline', () => toast(t('offlineToast')));
    addEventListener('online', () => toast(t('onlineToast')));
    setInterval(() => this.loadMe().catch(() => {}), 120_000);
    this.route();
    this.renderPlayerBar();
    this.renderRight();
    this.tick();
  }

  /** Shared demo account: say that changes are temporary, and how to keep them. */
  renderDemoBanner() {
    const bar = $('demo-banner');
    if (!bar) return;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('ainos.demoBanner') === 'hidden'; } catch { /* storage blocked */ }
    bar.hidden = !this.me?.is_demo || dismissed;
    if (bar.hidden) return;
    const signup = h('button', { type: 'button', class: 'link' }, t('demoBannerAction'));
    signup.addEventListener('click', () => this.logout({ signup: true }));
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('closePanel') }, icon('close'));
    close.addEventListener('click', () => {
      try { sessionStorage.setItem('ainos.demoBanner', 'hidden'); } catch { /* storage blocked */ }
      bar.hidden = true;
      $('main').focus({ preventScroll: true });
    });
    clear(bar).append(icon('sparkle'), h('div', { class: 'demo-banner-text' }, h('span', {}, t('demoBanner')), ' ', signup), close);
  }

  // --------------------------------------------------------------- router
  parseHash() {
    const raw = location.hash.slice(1) || '/';
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'home', id: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : undefined, params: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  async route({ keepScroll = false, focus = false } = {}) {
    const seq = ++this.renderSeq;
    this.cleanup?.();
    this.cleanup = null;
    const { name, id, params } = this.parseHash();
    const view = ROUTES.includes(name) ? VIEWS[name] : null;
    if (name !== 'search') $('topbar-search').hidden = true;
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
    this.renderLibrary();
    const main = $('main');
    const scroll = main.scrollTop;
    const container = $('view');
    const fresh = h('div');
    const slow = setTimeout(() => { if (seq === this.renderSeq) clear(container).append(h('div', { class: 'skeleton', style: { height: '220px', 'margin-top': '16px' } })); }, 180);
    try {
      if (!view) throw Object.assign(new Error(t('pageNotFound')), { status: 404 });
      const cleanup = await view(fresh, { ...params, id }, this);
      clearTimeout(slow);
      if (seq !== this.renderSeq) return cleanup?.();
      this.cleanup = cleanup || null;
      clear(container).append(...fresh.childNodes);
      main.scrollTop = keepScroll ? scroll : 0;
      document.title = this.titleFor(name, container);
      this.highlightPlaying();
      // Not while typing in search: that also changes the hash.
      if (focus && document.activeElement?.id !== 'search-input') main.focus({ preventScroll: true });
    } catch (err) {
      clearTimeout(slow);
      if (seq !== this.renderSeq) return;
      const retry = err.status === 404 ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, t('tryAgain'));
      retry?.addEventListener('click', () => this.route({ focus: true }));
      clear(container).append(h('div', { class: 'empty', role: 'alert' }, h('h2', {}, err.status === 404 ? t('pageNotFound') : t('somethingWentWrong')), h('p', {}, err.status === 404 ? err.message : errorText(err)),
        h('div', { class: 'empty-actions' }, retry, h('a', { class: 'btn btn-ghost btn-sm', href: '#/' }, t('goHome')))));
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
      toast(on ? t('addedToLiked') : t('removedFromLiked'));
      this.library.liked_count += on ? 1 : -1;
      this.renderLibrary();
    } catch (err) {
      on ? this.liked.delete(track.id) : this.liked.add(track.id);
      this.syncLikeButtons(track.id);
      toast(errorText(err), { error: true });
    }
  }

  syncLikeButtons(id) {
    const on = this.liked.has(id);
    for (const b of document.querySelectorAll(`[data-like-id="${CSS.escape(id)}"]`)) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-label', on ? t('removeFromLiked') : t('saveToLiked'));
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
      item('#/liked', likedArt('art'), t('likedSongs'), `${t('playlist')} · ${t('songsCount', { n: this.library.liked_count })}`, 'ainos:collection:liked'),
      downloads ? item('#/downloads', h('div', { class: 'art art-liked', style: { background: 'linear-gradient(135deg,#0f766e,#5eead4)' } }, icon('download')), t('downloaded'), t('songsCount', { n: downloads }), 'ainos:downloads') : null,
      ...this.library.playlists.map((p) => item(`#/playlist/${p.id}`, mosaic(p.covers, 'art'), p.name, `${t('playlist')} · ${p.owner.name}`, p.uri)),
      ...this.library.artists.map((a) => item(`#/artist/${a.id}`, img(a.image, 'art round'), a.name, t('artist'), a.uri)),
    ].filter(Boolean));
  }

  async createPlaylist(trackIds = []) {
    const p = await api.post('/api/playlists', { track_ids: trackIds });
    await this.refreshLibrary();
    location.hash = `#/playlist/${p.id}`;
    toast(t('createdPlaylistToast', { name: p.name }));
    return p;
  }

  trackMenu(track, e, { playlist, position, count = 0 } = {}) {
    const p = this.player;
    const items = [
      { label: t('addToQueue'), icon: 'queue', onClick: () => { p.addToQueue(track); toast(t('addedToQueueToast')); } },
      { label: t('goToRadio'), icon: 'radio', onClick: () => (location.hash = `#/radio/${track.id}`) },
      { label: t('goToArtist'), onClick: () => (location.hash = `#/artist/${track.artist.id}`) },
      { label: t('goToAlbum'), onClick: () => (location.hash = `#/album/${track.album.id}`) },
      'sep',
      {
        label: t('addToPlaylist'), icon: 'plus', submenu: [
          { label: t('newPlaylist'), icon: 'plus', onClick: safely(() => this.createPlaylist([track.id])) },
          ...(this.library.playlists.length ? ['sep'] : []),
          ...this.library.playlists.map((pl) => ({
            label: pl.name,
            onClick: safely(async () => { await api.post(`/api/playlists/${pl.id}/tracks`, { track_ids: [track.id] }); toast(t('addedToPlaylistToast', { name: pl.name })); this.refreshLibrary(); if (location.hash === `#/playlist/${pl.id}`) this.refresh(); }),
          })),
        ],
      },
      { label: this.isLiked(track.id) ? t('removeFromLiked') : t('saveToLiked'), icon: this.isLiked(track.id) ? 'heart-fill' : 'heart', onClick: () => this.toggleLike(track) },
    ];
    if (playlist?.is_owner && Number.isInteger(position)) {
      const move = (to) => safely(async () => { await api.post(`/api/playlists/${playlist.id}/move`, { from: position, to }); this.refresh(); });
      if (position > 0) items.push({ label: t('moveUp'), onClick: move(position - 1) });
      if (position < count - 1) items.push({ label: t('moveDown'), onClick: move(position + 1) });
      items.push({ label: t('removeFromPlaylist'), icon: 'close', onClick: safely(async () => { await api.del(`/api/playlists/${playlist.id}/tracks/${position}`); this.refresh(); this.refreshLibrary(); }) });
    }
    items.push(p.downloads[track.id]
      ? { label: t('removeDownload'), icon: 'download', onClick: () => p.removeDownload(track.id).then(() => toast(t('downloadRemovedToast'))) }
      : { label: t('download'), icon: 'download', onClick: () => p.download([track]).then(() => toast(t('downloadedToast'))).catch((err) => toast(errorText(err), { error: true })) });
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
    $('btn-lyrics').addEventListener('click', () => {
      if ($('btn-lyrics').getAttribute('aria-disabled') === 'true' && this.rightMode !== 'lyrics') return;
      // Closing the lyrics while a video plays goes back to now playing: the video's panel stays.
      this.setRight(this.rightMode === 'lyrics' ? (this.player.yt ? 'now' : null) : 'lyrics');
    });
    $('btn-queue').addEventListener('click', () => this.setRight(this.rightMode === 'queue' ? null : 'queue'));
    $('btn-devices').addEventListener('click', () => this.setRight(this.rightMode === 'devices' ? null : 'devices'));
    $('nav-back').addEventListener('click', () => history.back());
    $('nav-fwd').addEventListener('click', () => history.forward());
    $('new-playlist').addEventListener('click', safely(() => this.createPlaylist()));
    $('lang-select')?.addEventListener('change', (e) => this.changeLanguage(e.target.value));
    $('user-menu-btn').addEventListener('click', (e) => showMenu(e, [
      { label: t('yourStats'), icon: 'sparkle', onClick: () => (location.hash = '#/stats') },
      { label: t('recentlyPlayed'), icon: 'clock', onClick: () => (location.hash = '#/recent') },
      { label: t('downloaded'), icon: 'download', onClick: () => (location.hash = '#/downloads') },
      { label: t('navInternals'), icon: 'cpu', onClick: () => (location.hash = '#/internals') },
      { label: t('howItWorks'), onClick: () => (location.hash = '#/docs') },
      { label: t('settingsTitle'), onClick: () => (location.hash = '#/settings') },
      'sep',
      { label: t('logoutTitle'), onClick: () => this.logout() },
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
    this.syncYouTubeBox();
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
    if (!v.track) left.append(h('div', { class: 'np-hint dim small' }, t('pickSongHint')));
    if (v.track?.youtube) {
      // The song record ("Carry My Cross · Victory Worship"); the video's own title shows with the player.
      const tr = v.track;
      left.append(
        h('img', { class: 'yt-thumb yt-thumb-sm', src: tr.youtube.thumbnail, alt: '', decoding: 'async' }),
        h('div', { class: 'meta' }, h('div', { class: 'title' }, h('a', { href: `#/song/${tr.song_id}` }, tr.title)), h('div', { class: 'sub' }, `${tr.artist.name} · ${t('sourceYouTube')}`)));
    } else if (v.track) {
      const tr = v.track;
      const like = h('button', { class: `icon-btn${this.isLiked(tr.id) ? ' on' : ''}`, 'aria-label': this.isLiked(tr.id) ? t('removeFromLiked') : t('saveToLiked'), dataset: { likeId: tr.id } }, icon(this.isLiked(tr.id) ? 'heart-fill' : 'heart'));
      like.addEventListener('click', () => this.toggleLike(tr));
      like.style.setProperty('color', this.isLiked(tr.id) ? 'var(--accent)' : '');
      left.append(
        h('a', { href: `#/album/${tr.album.id}` }, img(tr.album.cover)),
        h('div', { class: 'meta' }, h('div', { class: 'title' }, h('a', { href: `#/album/${tr.album.id}` }, tr.title)), h('div', { class: 'sub' }, h('a', { href: `#/artist/${tr.artist.id}` }, tr.artist.name))),
        like);
    }
    const play = $('btn-play');
    clear(play).append(icon(v.isPlaying ? 'pause' : 'play'));
    play.setAttribute('aria-label', v.isPlaying ? t('pause') : t('play'));
    $('btn-shuffle').setAttribute('aria-pressed', String(!!v.shuffle));
    const rep = $('btn-repeat');
    rep.setAttribute('aria-pressed', String(v.repeat !== 'off'));
    rep.setAttribute('aria-label', `${t('repeat')}: ${v.repeat}`);
    clear(rep).append(icon(v.repeat === 'track' ? 'repeat-one' : 'repeat'));
    clear($('btn-mute')).append(icon(v.muted || v.volume === 0 ? 'mute' : 'volume'));
    $('btn-next').disabled = !v.track;
    $('btn-prev').disabled = !v.track;
    $('btn-nowplaying').setAttribute('aria-pressed', String(this.rightMode === 'now'));
    this.renderLyricsButton(v);
    $('btn-queue').setAttribute('aria-pressed', String(this.rightMode === 'queue'));
    $('btn-devices').setAttribute('aria-pressed', String(this.rightMode === 'devices' || v.remote));
    const app = $('app');
    app.classList.toggle('remote', v.remote);
    const bar = clear($('connect-bar'));
    if (v.remote) bar.append(icon('devices'), t('playingOn', { device: this.connect.deviceName(v.deviceId) }));
  }

  tick() {
    const step = () => {
      const v = this.player.view();
      if (!this.seekSlider.isDragging()) {
        const f = v.durationMs ? v.positionMs / v.durationMs : 0;
        const cur = fmtTime(v.positionMs), dur = fmtTime(v.durationMs);
        if (cur + dur !== this.seekText?.key) this.seekText = { key: cur + dur, text: t('timeOf', { cur, dur }) };
        setSlider($('seek'), $('seek-fill'), $('seek-thumb'), f, this.seekText.text);
        $('time-cur').textContent = cur;
        $('seek-buffer').style.width = `${v.durationMs && v.bufferedMs ? Math.min(100, (v.bufferedMs / v.durationMs) * 100) : 0}%`;
      }
      $('time-dur').textContent = fmtTime(v.durationMs);
      if (this.rightMode === 'lyrics') this.lyrics?.view.tick(v);
      if (!this.volSlider.isDragging()) { const vol = v.muted ? 0 : v.volume ?? 1; setSlider($('volume'), $('volume-fill'), $('volume-thumb'), vol, `${Math.round(vol * 100)}%`); }
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
      if (on && v.isPlaying) { if (!n.querySelector('.eq')) clear(n).append(h('span', { class: 'eq', 'aria-label': t('playing') }, h('i'), h('i'), h('i'))); }
      else if (n.textContent !== n.dataset.n) n.textContent = n.dataset.n;
    }
    for (const fab of document.querySelectorAll('[data-ctx-uri]')) {
      const on = v.isPlaying && v.contextUri === fab.dataset.ctxUri;
      clear(fab).append(icon(on ? 'pause' : 'play'));
    }
  }

  // ---------------------------------------------------------- right panel
  setRight(mode) {
    // The video is never hidden while it plays: closing its panel stops it.
    if (!mode && this.player?.yt) this.player.stopYouTube();
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
    const open = !!this.rightMode || !!this.player?.yt;
    panel.hidden = !open;
    app.classList.toggle('no-right', !open);
    if (!this.rightMode) return;
    if (this.rightMode === 'lyrics' && this.lyrics?.key === this.lyricsKey() && this.rp.body.contains(this.lyrics.view.el)) return; // rebuilding would lose the scroll position
    const seq = (this.rightSeq = (this.rightSeq || 0) + 1);
    const content = h('div');
    const head = (title) => {
      const close = h('button', { class: 'icon-btn', 'aria-label': t('closePanel') }, icon('close'));
      close.addEventListener('click', () => this.setRight(null));
      return h('div', { class: 'rp-head' }, h('h2', {}, title), close);
    };
    const v = this.player.view();
    if (this.rightMode === 'devices') {
      content.append(head(t('connectDevice')));
      const me = this.connect.identity.id;
      const devices = this.connect.devices.slice().sort((a, b) => (b.id === me) - (a.id === me));
      for (const d of devices) {
        const active = d.is_active || (!v.remote && d.id === me && v.track);
        const b = h('button', { class: `device${active ? ' active' : ''}` }, icon(d.type === 'smartphone' || d.type === 'tablet' ? 'phone' : 'computer'),
          h('div', {}, d.id === me ? t('thisBrowser') : d.name, h('small', {}, active ? (v.isPlaying ? t('playing') : t('active')) : d.id === me ? d.name : t('tapToPlay'))));
        b.addEventListener('click', async () => {
          if (active) return;
          try { await this.connect.transfer(d.id); } catch (err) { toast(errorText(err), { error: true }); }
        });
        content.append(b);
      }
      if (!this.connect.connected) content.append(h('p', { class: 'dim small' }, t('connecting')));
      content.append(h('div', { class: 'rp-card' }, h('h3', {}, t('tryIt')), h('p', { class: 'muted small', style: { margin: 0 } },
        t('connectHelp'),
        h('br'), h('br'), h('code', { class: 'mono' }, 'HOST=0.0.0.0'))));
    } else if (this.rightMode === 'lyrics') {
      content.append(head(t('lyricsTitle')));
      const tr = v.track;
      if (!tr) content.append(h('p', { class: 'muted' }, t('lyricsNothing')));
      else if (!tr.song_id) content.append(h('p', { class: 'muted' }, t('lyricsNone')));
      else {
        const key = this.lyricsKey();
        const holder = h('div', {}, h('p', { class: 'muted small' }, t('lyricsLoading')));
        content.append(holder);
        this.songDetail(tr.song_id).then((detail) => {
          if (key !== this.lyricsKey()) return;
          clear(holder);
          if (!views.hasLyrics(detail)) { holder.append(h('p', { class: 'muted' }, t('lyricsNone'))); return; }
          const view = views.lyricsView(this, { track: tr, detail, scroller: panel });
          this.lyrics = { key, view };
          holder.append(view.el);
          view.tick(this.player.view());
        }).catch(() => { clear(holder).append(h('p', { class: 'muted small' }, t('lyricsUnavailable'))); });
      }
    } else if (this.rightMode === 'queue') {
      content.append(head(t('queue')));
      if (!v.track) content.append(h('p', { class: 'muted' }, t('nothingPlaying')));
      else {
        content.append(h('div', { class: 'queue-label' }, t('nowPlaying')), this.queueItem(v.track, { current: true }));
        if (v.remote) {
          content.append(h('p', { class: 'muted small' }, t('queueLivesOn', { device: this.connect.deviceName(v.deviceId) })));
        } else {
          const p = this.player;
          if (p.userQueue.length) {
            content.append(h('div', { class: 'queue-label' }, t('nextInQueue')));
            p.userQueue.forEach((tr, i) => content.append(this.queueItem(tr, { onPlay: () => p.playFromQueue(i), onRemove: () => p.removeFromQueue(i) })));
          }
          const up = p.upNext(40);
          if (up.length) {
            content.append(h('div', { class: 'queue-label' }, t('nextFrom', { title: p.context?.title || '' })));
            up.forEach(({ track, orderIndex }) => content.append(this.queueItem(track, { onPlay: () => p.jumpTo(orderIndex) })));
          }
          if (!p.userQueue.length && !up.length) content.append(h('p', { class: 'muted small' }, p.repeat === 'off' ? t('nothingAfter') : t('repeatIsOn')));
        }
      }
    } else {
      content.append(head(v.contextTitle || t('nowPlaying')));
      if (!v.track) {
        content.append(h('p', { class: 'muted' }, t('pickSomething')));
      } else if (v.track.youtube) {
        // The video itself is in the YouTube box above; this is the song record.
        const tr = v.track;
        content.append(h('div', { class: 'rp-title' }, h('a', { href: `#/song/${tr.song_id}` }, tr.title)), h('div', { class: 'muted' }, tr.artist.name),
          h('p', { class: 'dim small' }, t('ytPlaysFrom')));
        if (!this.scriptureCards.has(tr.song_id)) this.scriptureCards.set(tr.song_id, views.scriptureCard(tr.song_id, { link: true }));
        const card = this.scriptureCards.get(tr.song_id);
        if (!card.hidden) content.append(card);
      } else {
        const tr = v.track;
        content.append(img(tr.album.cover, 'rp-cover'), h('div', { class: 'rp-title' }, h('a', { href: `#/album/${tr.album.id}` }, tr.title)), h('div', { class: 'muted' }, h('a', { href: `#/artist/${tr.artist.id}` }, tr.artist.name)));
        if (v.contextUri && uriToRoute(v.contextUri)) content.append(h('div', { class: 'dim small', style: { 'margin-top': '4px' } }, t('playingFrom'), h('a', { href: uriToRoute(v.contextUri) }, v.contextTitle || 'context')));
        if (!v.remote) {
          const d = this.player.debug();
          const lat = d.metrics.latencies.at(-1);
          const nextUp = this.player.peekNext();
          const cacheState = h('dd', {}, '…');
          this.player.isCached(this.player.deck.manifest).then((s) => { cacheState.textContent = s || 'network'; });
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, t('streamCard')),
            h('dl', { class: 'kv' },
              h('dt', {}, t('qualityLabel')), h('dd', {}, d.active.quality ? `${d.active.quality} · ${d.active.kbps} kbps` : '—'),
              h('dt', {}, t('loudnessLabel')), h('dd', {}, d.normalization ? `${d.normalization.loudness_lufs.toFixed(1)} LUFS → ${d.active.gainDb >= 0 ? '+' : ''}${d.active.gainDb.toFixed(1)} dB` : '—'),
              h('dt', {}, t('startLatencyLabel')), h('dd', {}, lat && lat.title === tr.title ? `${lat.ms} ms${lat.prefetched ? ' (prefetched)' : ''}` : '—'),
              h('dt', {}, t('sourceLabel')), cacheState,
              h('dt', {}, t('nextTrackLabel')), h('dd', {}, nextUp ? `${nextUp.title} · ${d.prefetch.trackId === nextUp.id ? d.prefetch.state : 'loads at −30 s'}` : '—'),
              h('dt', {}, t('countsAsStreamLabel')), h('dd', {}, d.session ? (d.session.msPlayed >= 30000 ? 'yes ✓' : `after ${Math.ceil((30000 - d.session.msPlayed) / 1000)} s more`) : '—'))));
        }
        const f = tr.features;
        if (f) {
          const bar = (label, val) => h('div', { class: 'feature-bar' }, h('span', {}, label), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(val * 100)}%` } })), h('span', { class: 'dim' }, `${Math.round(val * 100)}`));
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, t('audioFeaturesCard')),
            h('div', { class: 'dim small', style: { 'margin-bottom': '8px' } }, `${Math.round(f.tempo)} BPM · ${KEY_NAMES[f.key]} ${f.mode ? 'major' : 'minor'} · ${translateGenre(tr.genre)}`),
            h('div', { class: 'feature-bars' }, bar(t('energy'), f.energy), bar(t('danceability'), f.danceability), bar(t('valence'), f.valence), bar(t('acousticness'), f.acousticness))));
        }
        if (tr.song_id) {
          const cached = this.scriptureCards.get(tr.song_id);
          if (!cached || Date.now() - Number(cached.dataset.failedAt || Infinity) > 60_000) this.scriptureCards.set(tr.song_id, views.scriptureCard(tr.song_id, { link: true }));
          const card = this.scriptureCards.get(tr.song_id);
          if (!card.hidden) content.append(card);
        }
        let artist = this.artistCache.get(tr.artist.id);
        if (!artist) {
          api.get(`/api/artists/${tr.artist.id}`).then((a) => { this.artistCache.set(a.id, a); this.scheduleRight(); }).catch(() => {});
        } else {
          content.append(h('div', { class: 'rp-card' }, h('h3', {}, t('aboutArtistCard')),
            h('a', { href: `#/artist/${artist.id}`, style: { display: 'flex', gap: '12px', 'align-items': 'center', 'margin-bottom': '8px' } }, img(artist.image, 'art'), h('div', {}, h('b', {}, artist.name), h('div', { class: 'dim small' }, t('monthlyListeners', { n: fmtNumber(artist.monthly_listeners) })))),
            h('p', { class: 'muted small', style: { margin: 0 } }, artist.bio)));
          content.querySelector('.rp-card:last-child .art')?.style.setProperty('width', '48px');
          content.querySelector('.rp-card:last-child .art')?.style.setProperty('border-radius', '50%');
        }
      }
    }
    if (seq !== this.rightSeq) return;
    const nodes = [...content.childNodes];
    const headNode = nodes[0]?.classList?.contains('rp-head') ? nodes.shift() : null;
    clear(this.rp.head);
    if (headNode) this.rp.head.append(headNode);
    clear(this.rp.body).append(...nodes);
  }

  // ------------------------------------------------- YouTube and lyrics (Phases 3-4)
  /** The right panel: a head and body that re-render, and between them the YouTube box, which never moves. */
  buildRightPanel() {
    const fallbackLink = h('a', { target: '_blank', rel: 'noopener' });
    const fallbackText = h('span');
    const yt = {
      frame: h('div', { class: 'yt-frame-wrap' }),
      fallback: h('p', { class: 'yt-fallback', role: 'status', hidden: true }, fallbackText, ' ', fallbackLink),
      fallbackText, fallbackLink,
      badge: h('span', { class: 'yt-badge' }),
      title: h('div', { class: 'yt-title' }),
      channel: h('div', { class: 'dim small' }),
    };
    yt.el = h('div', { class: 'yt-box', hidden: true }, yt.frame, yt.fallback, h('div', { class: 'yt-meta' }, yt.badge, yt.title, yt.channel));
    this.rp = { head: h('div'), yt, body: h('div') };
    clear($('rightpanel')).append(this.rp.head, yt.el, this.rp.body);
  }

  /** Play an official YouTube video (a song source from search) in the visible embed; native audio pauses. */
  playYouTube(song, source) {
    const y = source.youtube;
    const track = {
      id: `yt:${source.id}`, title: song.name, artist: { id: null, name: song.artist.name }, album: { id: null, title: '', cover: y.thumbnail },
      duration_ms: y.duration_ms || 0, song_id: song.id, language: song.language, youtube: { ...y, sourceId: source.id },
    };
    if (!this.rightMode || this.rightMode === 'lyrics') this.rightMode = 'now'; // the panel holds the player; not saved as the user's choice
    const host = h('div');
    clear(this.rp.yt.frame).append(host);
    this.player.playYouTube(track, host, { title: t('ytFrameTitle', { title: y.title }) });
    this.renderRight();
  }

  /** Show the YouTube box (player, fallback below it, YouTube's own title and channel) while a video is the current item. */
  syncYouTubeBox() {
    const yt = this.rp?.yt;
    if (!yt) return;
    const v = this.player.view();
    const y = v.youtube ? v.track.youtube : null;
    if (!y) {
      if (!yt.el.hidden) { yt.el.hidden = true; clear(yt.frame); this.scheduleRight(); }
      return;
    }
    if (yt.el.hidden) { yt.el.hidden = false; this.scheduleRight(); }
    yt.fallback.hidden = !v.problem;
    yt.fallbackText.textContent = t('ytFallback');
    yt.fallbackLink.textContent = t('ytWatch');
    yt.fallbackLink.href = watchUrl(y.videoId);
    yt.badge.textContent = t('ytVideoLabel');
    yt.title.textContent = y.title; // YouTube's title, unmodified
    yt.channel.textContent = y.channelTitle;
  }

  lyricsKey() {
    const v = this.player.view();
    return `${v.track?.id || ''}|${getLang()}`;
  }

  /** GET /api/songs/:id, cached for a few minutes (lyrics, arrangements, sources and timings). */
  songDetail(songId) {
    const hit = this.songDetails.get(songId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.promise;
    const entry = { at: Date.now(), value: hit?.value, promise: api.get(`/api/songs/${encodeURIComponent(songId)}`) };
    this.songDetails.set(songId, entry);
    entry.promise.then((d) => { entry.value = d; }, () => { if (this.songDetails.get(songId) === entry) this.songDetails.delete(songId); });
    return entry.promise;
  }

  /** The player bar's Lyrics button: disabled, with a tooltip, when the song has no lyrics. */
  renderLyricsButton(v) {
    const btn = $('btn-lyrics');
    const songId = v.track?.song_id;
    let has = false;
    if (songId) {
      const hit = this.songDetails.get(songId);
      if (hit?.value) has = views.hasLyrics(hit.value);
      else if (!hit) this.songDetail(songId).then(() => this.renderPlayerBar(), () => {}); // once: the entry exists from now on
    }
    btn.setAttribute('aria-disabled', String(!has));
    btn.setAttribute('aria-pressed', String(this.rightMode === 'lyrics'));
    btn.setAttribute('aria-label', t('lyricsBtn'));
    btn.title = has ? t('lyricsBtn') : t('lyricsNone');
  }

  queueItem(tr, { current = false, onPlay, onRemove } = {}) {
    const row = h('div', { class: `queue-item${current ? ' current' : ''}` }, img(tr.album.cover), h('div', { class: 'meta' }, h('div', { class: 't' }, tr.title), h('div', { class: 's' }, tr.artist.name)));
    if (onPlay) { row.style.cursor = 'pointer'; row.addEventListener('dblclick', onPlay); row.addEventListener('click', (e) => { if (matchMedia('(pointer: coarse)').matches || e.detail === 0) onPlay(); }); }
    if (onRemove) {
      const x = h('button', { class: 'icon-btn', 'aria-label': t('removeFromQueueLabel', { title: tr.title }) }, icon('close'));
      x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
      row.append(x);
    }
    return row;
  }

  async logout({ signup = false } = {}) {
    await this.player?.flush();
    await api.post('/api/auth/logout').catch(() => {});
    location.hash = signup ? '#/?signup=1' : '#/';
    location.reload();
  }
}

const app = new App();
window.ainos = app; // handy for poking at internals from DevTools
app.boot();

// expose for views that want to open dialogs
export { app, promptDialog };
