// Projection (Phase 6): the Present dialog, the this-screen slideshow and the presenter
// view. In presenter view the slides show in a second window (/present.html) kept in sync
// over BroadcastChannel('ainos-present-' + sessionId); nothing goes through the server.
// Automatic mode plays each native track item in its own <audio> element and advances the
// slides when playback crosses each slide's startMs (Phase 4 timings).
//
// DECISION: YouTube items are always manual in automatic mode (their slides still show, and
// the YouTube player is never used or hidden here); the dialog lists them.
import { h, icon, toast, clear, fmtTime } from '../ui.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { renderSlide } from './stage.js';

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp']);
const PAUSE_KEYS = new Set(['p', 'P', 'k', 'K', 'MediaPlayPause']);
const POPUP_FEATURES = 'popup,width=1024,height=576,left=80,top=80';
const MAX_SLIDES = 2000;

let active = null;

const str = (v) => (v == null ? '' : String(v));
const strLines = (lines) => (Array.isArray(lines) ? lines : typeof lines === 'string' ? lines.split('\n') : []).map(str);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A section label ('V2', 'C', 'B', …) as shown on the slide, in the UI language. */
export function sectionName(label) {
  const l = str(label);
  const v = /^V(\d+)$/.exec(l);
  if (v) return t('prSecV', { n: v[1] });
  const key = { C: 'prSecC', C2: 'prSecC2', PC: 'prSecPC', B: 'prSecB', T: 'prSecT', E: 'prSecE', I: 'prSecI' }[l];
  return key ? t(key) : l;
}

/** Whether automatic mode can play this item: a native track with timings. */
export function isAutoItem(item) {
  return item?.kind === 'song' && item.source?.type === 'track' && !!item.source.trackId && !!item.hasTimings
    && Array.isArray(item.slides) && item.slides.some((s) => num(s?.startMs) !== undefined);
}

/**
 * The deck (see GET /api/orgs/:orgId/setlists/:id/slides) as one flat list of slides.
 * Each song gets a title slide first. Slides: { id, itemIndex, kind, title, label, lines, startMs?, attribution? }
 */
export function flattenDeck(deck) {
  const items = Array.isArray(deck?.items) ? deck.items : [];
  const out = [];
  items.forEach((item, itemIndex) => {
    const itemId = str(item?.id ?? itemIndex);
    const title = str(item?.title);
    const list = (Array.isArray(item?.slides) ? item.slides : []).filter((s) => s && typeof s === 'object');
    const base = (s, n) => ({ id: `${itemId}:${str(s?.id) || n}`, itemIndex, title });
    if (item?.kind === 'song') {
      out.push({ id: `${itemId}:title`, itemIndex, kind: 'title', title, label: title, lines: [title], startMs: 0 });
      list.forEach((s, n) => out.push({ ...base(s, n), kind: 'song', label: sectionName(s.label), lines: strLines(s.lines), startMs: num(s.startMs) }));
    } else if (item?.kind === 'scripture') {
      list.forEach((s, n) => out.push({ ...base(s, n), kind: 'scripture', label: str(s.label) || title, lines: strLines(s.lines), attribution: str(s.attribution) }));
    } else if (item?.kind === 'text') {
      if (list.length) list.forEach((s, n) => out.push({ ...base(s, n), kind: 'text', label: title, lines: strLines(s.lines) }));
      else if (title) out.push({ id: `${itemId}:0`, itemIndex, title, kind: 'text', label: title, lines: [title] });
    } else if (item?.kind === 'blank') {
      out.push({ id: `${itemId}:blank`, itemIndex, title, kind: 'blank', label: '', lines: [] });
    }
  });
  return out.slice(0, MAX_SLIDES);
}

/** Open the Present dialog for a deck: { title, items: [{ id, kind, title, slides, source, hasTimings }] }. */
export function openPresentDialog(deck) {
  if (active) active.end();
  const slides = flattenDeck(deck);
  if (!slides.length) { toast(t('prEmpty')); return; }
  const items = deck.items;
  const songs = items.filter((i) => i?.kind === 'song');
  const youtube = songs.filter((i) => i.source?.type === 'youtube');
  const untimed = songs.filter((i) => i.source?.type !== 'youtube' && !isAutoItem(i));
  const canAuto = songs.some(isAutoItem);

  const choice = { where: 'screen', mode: 'manual' };
  const cards = [];
  const card = (group, value, ic, title, sub, disabled = false) => {
    const el = h('button', { type: 'button', class: 'pr-card', disabled, onclick: () => { choice[group] = value; sync(); } },
      h('span', { class: 'pr-card-icon' }, icon(ic)),
      h('span', { class: 'pr-card-text' }, h('strong', {}, title), h('span', { class: 'pr-card-sub' }, sub)),
      h('span', { class: 'pr-card-check' }, icon('check')));
    cards.push({ el, group, value });
    return el;
  };
  const autoNote = h('div', { class: 'pr-auto-note' });
  const sync = () => {
    for (const c of cards) {
      const sel = choice[c.group] === c.value;
      c.el.classList.toggle('selected', sel);
      c.el.setAttribute('aria-pressed', String(sel));
    }
    autoNote.hidden = choice.mode !== 'auto' || (!untimed.length && !youtube.length);
  };
  const songList = (heading, list) => (list.length
    ? h('div', { class: 'pr-note-group' }, h('p', {}, heading), h('ul', { class: 'pr-note-list' }, list.map((i) => h('li', {}, str(i.title)))))
    : null);
  autoNote.append(songList(t('prAutoFallback'), untimed), songList(t('prAutoYouTube'), youtube));
  const error = h('p', { class: 'pr-error', role: 'alert', hidden: true });

  const titleId = `pr-dlg-title-${Math.random().toString(36).slice(2, 8)}`;
  const startBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('play'), t('prStart'));
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, t('cancel'));
  const dlg = h('dialog', { class: 'pr-dlg', 'aria-labelledby': titleId },
    h('h2', { id: titleId }, t('prTitle'), deck.title ? h('span', { class: 'pr-dlg-sub' }, ` · ${str(deck.title)}`) : null),
    h('div', { class: 'pr-dialog' },
      h('h3', { class: 'pr-group-title' }, t('prWhere')),
      h('div', { class: 'pr-cards' },
        card('where', 'screen', 'computer', t('prThisScreen'), t('prThisScreenSub')),
        card('where', 'presenter', 'devices', t('prPresenterView'), t('prPresenterViewSub'))),
      h('h3', { class: 'pr-group-title' }, t('prMode')),
      h('div', { class: 'pr-cards' },
        card('mode', 'manual', 'next', t('prManual'), t('prManualSub')),
        card('mode', 'auto', 'play', t('prAuto'), canAuto ? t('prAutoSub') : t('prAutoUnavailable'), !canAuto)),
      autoNote,
      h('p', { class: 'pr-summary' }, t('prSlideCount', { n: slides.length })),
      error),
    h('div', { class: 'dialog-actions' }, cancelBtn, startBtn));
  sync();

  cancelBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  startBtn.addEventListener('click', () => {
    const sessionId = newSessionId();
    if (choice.where === 'screen') {
      // Must run inside the click (user gesture).
      const fs = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      dlg.close();
      active = new Session(deck, slides, { where: 'screen', mode: choice.mode, sessionId });
      active.unlockAudio();
      fs?.catch?.(() => {});
    } else {
      // Open synchronously in the click, then move it to the other screen.
      const win = window.open(audienceUrl(sessionId), `ainos-audience-${sessionId}`, POPUP_FEATURES);
      if (!win) {
        error.textContent = t('prPopupBlocked');
        error.hidden = false;
        return;
      }
      dlg.close();
      const session = new Session(deck, slides, { where: 'presenter', mode: choice.mode, win, sessionId });
      active = session;
      session.unlockAudio();
      placeWindow(win).then((placed) => session.setPlaced(placed));
    }
  });
  document.body.append(dlg);
  dlg.showModal();
  startBtn.focus();
}

function newSessionId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

const audienceUrl = (sessionId) => `/present.html#${encodeURIComponent(sessionId)}`;

/** Move the audience window to another screen with the Window Management API, if allowed. */
async function placeWindow(win) {
  if (!('getScreenDetails' in window)) return false;
  try {
    const details = await window.getScreenDetails();
    const other = details.screens.find((s) => s !== details.currentScreen);
    if (!other || win.closed) return false;
    win.moveTo(other.availLeft, other.availTop);
    win.resizeTo(other.availWidth, other.availHeight);
    return true;
  } catch {
    return false;
  }
}

class Session {
  constructor(deck, slides, { where, mode, win = null, sessionId }) {
    this.deckTitle = str(deck.title);
    this.items = deck.items;
    this.slides = [...slides, { id: 'end', itemIndex: -1, kind: 'end', title: t('prEndOfPresentation'), lines: [] }];
    this.where = where;
    this.mode = mode;
    this.win = win;
    this.sessionId = sessionId;
    this.placed = false;
    this.index = 0;
    this.alive = true;
    this.cleanups = [];
    this.fsEntered = false;
    this.startedAt = Date.now();
    this.prevFocus = document.activeElement;
    // [first, last] slide index of the item each slide belongs to.
    this.group = [];
    for (let i = 0; i < this.slides.length;) {
      let j = i;
      const ii = this.slides[i].itemIndex;
      while (ii >= 0 && j + 1 < this.slides.length && this.slides[j + 1].itemIndex === ii) j++;
      for (let k = i; k <= j; k++) this.group[k] = [i, j];
      i = j + 1;
    }
    // Automatic mode state.
    this.autoSet = new Set(mode === 'auto' ? this.items.map((it, i) => (isAutoItem(it) ? i : -1)).filter((i) => i >= 0) : []);
    this.failed = new Set();
    this.audio = mode === 'auto' ? new Audio() : null;
    this.loadedItem = -1;
    this.loadToken = 0;
    this.loading = false;
    this.userPaused = false;
    this.lastNow = 0;
    this.raf = 0;
    this.lastUiUpdate = 0;

    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel(`ainos-present-${sessionId}`) : null;
    if (where === 'screen') this.buildScreen(); else this.buildPresenter();
    document.body.append(this.root);
    this.listen();
    this.go(0, { user: true });
  }

  /** Called inside the Start click so later play() calls are allowed without another gesture. */
  unlockAudio() {
    if (!this.audio) return;
    try {
      const p = this.audio.play();
      p?.catch?.(() => {});
      this.audio.pause();
    } catch { /* no source yet: fine */ }
  }

  // ---- building ----
  buildScreen() {
    this.stage = h('div', { class: 'stage pr-screen-stage' });
    this.hint = h('div', { class: 'pr-hint' });
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    this.playBtn = this.mode === 'auto'
      ? h('button', { type: 'button', class: 'pr-ctrl-btn', 'aria-label': t('prPlayPause'), title: t('prPlayPause'), onclick: stop(() => this.togglePlay()) }, icon('pause'))
      : null;
    this.ctrls = h('div', { class: 'pr-screen-ctrls' },
      this.playBtn,
      h('button', { type: 'button', class: 'pr-ctrl-btn', 'aria-label': t('prEnd'), title: t('prEnd'), onclick: stop(() => this.end()) }, icon('close')));
    this.root = h('div', {
      class: 'pr-overlay pr-screen',
      tabindex: '-1',
      onclick: () => this.next(),
      oncontextmenu: (e) => { e.preventDefault(); this.prev(); },
      onmousemove: () => this.showHint(),
    }, this.stage, this.hint, this.ctrls);
  }

  buildPresenter() {
    const btn = (ic, label, fn, cls = 'pr-nav-btn') => h('button', { class: cls, type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic));
    this.stage = h('div', { class: 'stage pr-current', onclick: () => this.next() });
    this.nextStage = h('div', { class: 'stage pr-next', onclick: () => this.next() });
    this.counter = h('span', { class: 'pr-counter' });
    this.clock = h('span', { class: 'pr-clock' });
    this.elapsed = h('span', { class: 'pr-elapsed' });
    this.audStatus = h('span', { class: 'pr-aud-status' });
    this.reopenBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true, onclick: () => this.reopen() }, t('prReopen'));
    this.autoText = h('span', { class: 'pr-auto-text' });
    this.playBtn = this.mode === 'auto' ? btn('play', t('prPlayPause'), () => this.togglePlay(), 'pr-play-btn') : null;
    this.strip = h('div', { class: 'pr-strip', role: 'list' });
    this.thumbs = this.slides.map((s, i) => {
      const st = h('div', { class: 'stage pr-thumb-stage' });
      const b = h('button', {
        class: `pr-thumb${this.group[i][0] === i && i > 0 ? ' pr-thumb-item' : ''}`,
        type: 'button', role: 'listitem', 'aria-label': t('prSlideOf', { n: i + 1, m: this.slides.length }),
        onclick: () => this.go(i, { user: true }),
      }, st, h('span', { class: 'pr-thumb-no' }, String(i + 1)));
      this.strip.append(b);
      return { b, st };
    });
    this.root = h('div', { class: 'pr-overlay pr-presenter', tabindex: '-1', role: 'region', 'aria-label': t('prPresenterView') },
      h('header', { class: 'pr-top' },
        h('strong', { class: 'pr-top-title' }, t('prPresenterView')),
        this.deckTitle ? h('span', { class: 'pr-deck-title' }, this.deckTitle) : null,
        h('span', { class: `pr-badge${this.mode === 'auto' ? ' pr-badge-auto' : ''}` }, this.mode === 'auto' ? t('prAutoBadge') : t('prManualBadge')),
        this.audStatus, this.reopenBtn,
        h('span', { class: 'pr-spacer' }),
        h('span', { class: 'pr-time' }, icon('clock'), this.clock),
        h('span', { class: 'pr-time' }, h('span', { class: 'pr-dim' }, `${t('prElapsed')} `), this.elapsed),
        h('button', { class: 'btn btn-sm pr-end-btn', type: 'button', onclick: () => this.end() }, icon('close'), t('prEnd'))),
      h('div', { class: 'pr-main' },
        h('section', { class: 'pr-cur-wrap' }, h('div', { class: 'pr-label' }, t('prCurrent')), h('div', { class: 'pr-cur-box' }, this.stage)),
        h('aside', { class: 'pr-side' },
          h('div', { class: 'pr-label' }, t('prNext')), this.nextStage,
          h('div', { class: 'pr-nav' },
            btn('chevron-left', t('prPrev'), () => this.prev()),
            this.counter,
            btn('chevron-right', t('prNext'), () => this.next())),
          this.mode === 'auto' ? h('div', { class: 'pr-auto' }, this.playBtn, this.autoText) : null)),
      this.strip);
    // Thumbnails need layout to fit: render them once the overlay is in the document.
    requestAnimationFrame(() => { if (this.alive) this.thumbs.forEach(({ st }, i) => renderSlide(st, this.slides[i])); });
  }

  // ---- events ----
  listen() {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.handleKey(e.key)) { e.preventDefault(); e.stopPropagation(); }
    };
    // Space on a focused button would also click it on keyup: swallow that.
    const onKeyUp = (e) => { if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    this.cleanups.push(() => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); });

    const onUnload = () => { this.post({ type: 'end' }); this.stopAudio(); };
    window.addEventListener('pagehide', onUnload);
    this.cleanups.push(() => window.removeEventListener('pagehide', onUnload));

    if (this.channel) {
      this.channel.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'hello') this.sendDeck();
        else if (m.type === 'key' && typeof m.key === 'string') this.handleKey(m.key);
      };
    }

    if (this.where === 'screen') {
      const onFs = () => {
        if (document.fullscreenElement) this.fsEntered = true;
        else if (this.fsEntered) this.end();
      };
      document.addEventListener('fullscreenchange', onFs);
      this.cleanups.push(() => document.removeEventListener('fullscreenchange', onFs));
    } else {
      const tick = () => {
        this.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.elapsed.textContent = fmtTime(Date.now() - this.startedAt);
        const open = !!this.win && !this.win.closed;
        this.audStatus.textContent = open ? t('prAudienceOpen') : t('prAudienceClosed');
        this.audStatus.classList.toggle('off', !open);
        this.reopenBtn.hidden = open;
      };
      tick();
      const timer = setInterval(tick, 1000);
      this.cleanups.push(() => clearInterval(timer));
    }
    this.root.focus({ preventScroll: true });

    if (this.audio) {
      const a = this.audio;
      const onState = () => this.updateAuto();
      const onEnded = () => this.onEnded();
      const onError = () => {
        if (!this.alive || this.loadedItem < 0 || !a.getAttribute('src')) return;
        this.audioFailed(this.loadedItem);
      };
      a.addEventListener('play', onState);
      a.addEventListener('pause', onState);
      a.addEventListener('ended', onEnded);
      a.addEventListener('error', onError);
      this.cleanups.push(() => {
        a.removeEventListener('play', onState);
        a.removeEventListener('pause', onState);
        a.removeEventListener('ended', onEnded);
        a.removeEventListener('error', onError);
      });
      const frame = () => {
        if (!this.alive) return;
        this.raf = requestAnimationFrame(frame);
        this.onFrame();
      };
      this.raf = requestAnimationFrame(frame);
      this.cleanups.push(() => cancelAnimationFrame(this.raf));
    }
  }

  handleKey(key) {
    if (!this.alive) return false;
    if (NEXT_KEYS.has(key)) this.next();
    else if (PREV_KEYS.has(key)) this.prev();
    else if (key === 'Home') this.go(0, { user: true });
    else if (key === 'End') this.go(this.slides.length - 1, { user: true });
    else if (key === 'Escape') this.end();
    else if (PAUSE_KEYS.has(key) && this.audio) this.togglePlay();
    else return false;
    return true;
  }

  post(msg) { try { this.channel?.postMessage(msg); } catch { /* closed */ } }
  sendDeck() {
    const slides = this.slides.map(({ kind, title, label, lines, attribution }) => ({ kind, title, label, lines, attribution }));
    this.post({ type: 'deck', slides, index: this.index, placed: this.placed });
  }
  setPlaced(placed) { this.placed = placed; if (this.alive) this.sendDeck(); }

  reopen() {
    const win = window.open(audienceUrl(this.sessionId), `ainos-audience-${this.sessionId}`, POPUP_FEATURES);
    if (!win) { toast(t('prPopupBlocked'), { error: true }); return; }
    this.win = win;
    this.placed = false;
    placeWindow(win).then((placed) => this.setPlaced(placed));
  }

  // ---- navigation ----
  next() { this.go(this.index + 1, { user: true }); }
  prev() { this.go(this.index - 1, { user: true }); }

  go(i, { user = false, fromAudio = false } = {}) {
    if (!this.alive) return;
    this.index = Math.max(0, Math.min(this.slides.length - 1, i));
    this.render();
    this.post({ type: 'go', index: this.index });
    if (this.audio && !fromAudio) this.syncAudio(user);
    this.updateAuto();
  }

  render() {
    renderSlide(this.stage, this.slides[this.index]);
    if (this.where === 'screen') { this.showHint(); return; }
    renderSlide(this.nextStage, this.slides[this.index + 1] || null);
    this.counter.textContent = `${this.index + 1} / ${this.slides.length}`;
    this.thumbs.forEach(({ b }, i) => {
      b.classList.toggle('current', i === this.index);
      if (i === this.index) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    this.thumbs[this.index].b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  showHint() {
    if (!this.hint) return;
    const parts = [`${this.index + 1} / ${this.slides.length}`];
    if (this.mode === 'auto') parts.push(t('prAutoBadge'), t('prPauseHint'));
    parts.push(t('prEscToExit'));
    this.hint.textContent = parts.join(' · ');
    this.root.classList.add('show-ui');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.root.classList.remove('show-ui'), 2200);
  }

  // ---- automatic mode ----
  isAuto(itemIndex) { return this.autoSet.has(itemIndex) && !this.failed.has(itemIndex); }

  syncAudio(user) {
    const s = this.slides[this.index];
    if (!this.isAuto(s.itemIndex)) { this.pauseAudio(); return; }
    const at = num(s.startMs);
    if (this.loadedItem !== s.itemIndex) { this.loadItem(s.itemIndex, at ?? 0); return; }
    if (this.loading) return;
    if (user && at !== undefined) this.seekTo(at);
    if (this.audio.paused && !this.userPaused) this.playAudio();
  }

  async loadItem(itemIndex, atMs) {
    const a = this.audio;
    const token = ++this.loadToken;
    this.pauseAudio();
    this.loadedItem = itemIndex;
    this.loading = true;
    this.userPaused = false;
    this.updateAuto();
    const item = this.items[itemIndex];
    try {
      const m = await api.get(`/api/tracks/${encodeURIComponent(item.source.trackId)}/manifest`);
      if (token !== this.loadToken || !this.alive) return;
      const url = m?.file?.url;
      // Same-origin signed media URL only (CSP media-src 'self').
      if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) throw new Error('no media url');
      const gain = Number(m?.normalization?.gain_db);
      a.volume = Number.isFinite(gain) ? Math.min(1, Math.max(0.05, 10 ** (gain / 20))) : 1;
      a.src = url;
      if (atMs > 300) {
        await new Promise((resolve) => {
          const done = () => { a.removeEventListener('loadedmetadata', done); resolve(); };
          a.addEventListener('loadedmetadata', done);
          setTimeout(done, 5000);
        });
        if (token !== this.loadToken || !this.alive) return;
        a.currentTime = atMs / 1000;
      }
      this.lastNow = atMs;
      this.loading = false;
      this.playAudio();
    } catch {
      if (token !== this.loadToken || !this.alive) return;
      this.audioFailed(itemIndex);
    } finally {
      if (token === this.loadToken) { this.loading = false; this.updateAuto(); }
    }
  }

  audioFailed(itemIndex) {
    if (this.failed.has(itemIndex)) return;
    this.failed.add(itemIndex);
    if (this.loadedItem === itemIndex) { this.loadedItem = -1; this.stopAudio(); }
    toast(t('prAudioFailed', { title: str(this.items[itemIndex]?.title) }), { error: true });
    this.updateAuto();
  }

  playAudio() {
    const a = this.audio;
    if (!a || !this.alive || !a.getAttribute('src')) return;
    try { window.ainos?.player?.pause?.(); } catch { /* the app's own player */ }
    this.lastNow = a.currentTime * 1000;
    const p = a.play();
    p?.catch?.((err) => {
      if (!this.alive) return;
      if (err?.name === 'NotAllowedError') { this.userPaused = true; this.updateAuto(); }
    });
  }

  pauseAudio() { if (this.audio && !this.audio.paused) this.audio.pause(); }

  stopAudio() {
    const a = this.audio;
    if (!a) return;
    try {
      a.pause();
      a.removeAttribute('src');
      a.load();
    } catch { /* ignore */ }
  }

  seekTo(ms) {
    const a = this.audio;
    if (!a.getAttribute('src')) return;
    try { a.currentTime = ms / 1000; } catch { /* not seekable yet */ }
    this.lastNow = ms;
  }

  togglePlay() {
    const a = this.audio;
    if (!a) return;
    const s = this.slides[this.index];
    if (!this.isAuto(s.itemIndex)) return;
    if (this.loadedItem !== s.itemIndex) { this.loadItem(s.itemIndex, num(s.startMs) ?? 0); return; }
    if (this.loading) return;
    if (a.paused) { this.userPaused = false; this.playAudio(); } else { this.userPaused = true; a.pause(); }
  }

  /** Advance when playback crosses a slide's startMs (a cue, so manual jumps never bounce back). */
  onFrame() {
    const a = this.audio;
    if (this.loadedItem < 0 || a.paused || a.seeking || this.loading) return;
    const now = a.currentTime * 1000;
    const prev = this.lastNow;
    this.lastNow = now;
    const s = this.slides[this.index];
    if (s.itemIndex === this.loadedItem && now > prev) {
      const [first, last] = this.group[this.index];
      let target = -1;
      for (let k = first; k <= last; k++) {
        const ms = this.slides[k].startMs;
        if (ms !== undefined && ms > prev && ms <= now) target = k;
      }
      if (target >= 0 && target !== this.index) this.go(target, { fromAudio: true });
    }
    if (performance.now() - this.lastUiUpdate > 250) this.updateAuto();
  }

  onEnded() {
    if (!this.alive || this.loadedItem < 0) return;
    const s = this.slides[this.index];
    if (s.itemIndex !== this.loadedItem) return;
    const [, last] = this.group[this.index];
    this.go(last + 1);
  }

  updateAuto() {
    if (!this.audio) return;
    this.lastUiUpdate = performance.now();
    const s = this.slides[this.index];
    const auto = this.isAuto(s.itemIndex);
    const playing = auto && this.loadedItem === s.itemIndex && !this.audio.paused;
    if (this.playBtn) {
      clear(this.playBtn).append(icon(playing ? 'pause' : 'play'));
      this.playBtn.hidden = !auto;
    }
    if (!this.autoText) return;
    let text;
    if (s.kind === 'end') text = t('prEndOfPresentation');
    else if (auto && this.loading) text = `${s.title} · ${t('prLoading')}`;
    else if (auto) {
      const cur = this.loadedItem === s.itemIndex ? this.audio.currentTime * 1000 : 0;
      const dur = this.loadedItem === s.itemIndex && Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
      text = `${s.title} · ${fmtTime(cur)} / ${fmtTime(dur)}${!playing && this.loadedItem === s.itemIndex ? ` · ${t('prPaused')}` : ''}`;
    } else if (s.kind === 'song' || s.kind === 'title') text = t('prAutoNoAudio');
    else text = t('prAutoWaiting');
    if (this.autoText.textContent !== text) this.autoText.textContent = text;
  }

  // ---- end ----
  end() {
    if (!this.alive) return;
    this.alive = false;
    for (const fn of this.cleanups) { try { fn(); } catch { /* ignore */ } }
    clearTimeout(this.hintTimer);
    this.stopAudio();
    this.post({ type: 'end' });
    const ch = this.channel;
    setTimeout(() => { try { ch?.close(); } catch { /* ignore */ } }, 300);
    if (this.win && !this.win.closed) { try { this.win.close(); } catch { /* ignore */ } }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    if (active === this) active = null;
    try { this.prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
}
