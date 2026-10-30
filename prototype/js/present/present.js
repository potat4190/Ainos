// The presentation: a dialog (where + mode), then either a full-screen slideshow on
// this screen, or a presenter view here with the slides in a second window
// (present.html, kept in sync over BroadcastChannel('ainos-present')).
// Automatic mode plays each recorded hymn and follows its lyric timings.
import { h, icon, modal, toast, clear, fmtTime } from '../ui.js';
import { t } from '../i18n.js';
import { on } from '../state.js';
import { player } from '../player.js';
import { buildSlides } from '../slides.js';
import { renderSlide } from './stage.js';

const CHANNEL = 'ainos-present';
const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);
const POPUP_FEATURES = 'popup,width=1024,height=576,left=80,top=80';

let active = null;

/** Open the Present dialog for a setlist (array of setlist items, see slides.js). */
export function openPresentDialog(items) {
  if (active) active.end();
  const slides = buildSlides(items || [], t);
  if (!slides.length) { toast(t('prEmpty')); return; }

  const choice = { where: 'screen', mode: 'manual' };
  const cards = [];
  const card = (group, value, ic, title, sub) => {
    const el = h('button', { type: 'button', class: 'pr-card', onclick: () => { choice[group] = value; sync(); } },
      h('span', { class: 'pr-card-icon' }, icon(ic)),
      h('span', { class: 'pr-card-text' }, h('strong', {}, title), h('span', { class: 'pr-card-sub' }, sub)),
      h('span', { class: 'pr-card-check' }, icon('check')));
    cards.push({ el, group, value });
    return el;
  };
  const sync = () => {
    for (const c of cards) {
      const sel = choice[c.group] === c.value;
      c.el.classList.toggle('selected', sel);
      c.el.setAttribute('aria-pressed', String(sel));
    }
  };
  const error = h('p', { class: 'pr-error', role: 'alert', hidden: true });

  const content = h('div', { class: 'pr-dialog' },
    h('h3', { class: 'pr-group-title' }, t('prWhere')),
    h('div', { class: 'pr-cards' },
      card('where', 'screen', 'fullscreen', t('prThisScreen'), t('prThisScreenSub')),
      card('where', 'presenter', 'devices', t('prPresenterView'), t('prPresenterViewSub'))),
    h('h3', { class: 'pr-group-title' }, t('prMode')),
    h('div', { class: 'pr-cards' },
      card('mode', 'manual', 'computer', t('prManual'), t('prManualSub')),
      card('mode', 'auto', 'lyrics', t('prAuto'), t('prAutoSub'))),
    h('p', { class: 'pr-summary dim small' }, t('prSlideCount', { n: slides.length })),
    error);
  sync();

  const start = () => {
    if (choice.where === 'screen') {
      // Must be called directly in the click (user gesture).
      const fs = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      dlg.close();
      const session = new Session(slides, { where: 'screen', mode: choice.mode });
      active = session;
      fs?.catch?.(() => {});
    } else {
      // Open synchronously in the click, then move it to the other screen.
      const win = window.open('present.html', 'ainos-audience', POPUP_FEATURES);
      if (!win) {
        error.textContent = t('prPopupBlocked');
        error.hidden = false;
        toast(t('prPopupBlocked'));
        return;
      }
      dlg.close();
      const session = new Session(slides, { where: 'presenter', mode: choice.mode, win });
      active = session;
      placeWindow(win).then((placed) => session.setPlaced(placed));
    }
  };

  const dlg = modal({
    title: t('prTitle'),
    content,
    wide: true,
    actions: [
      h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, t('cancel')),
      h('button', { class: 'btn btn-accent', onclick: start }, icon('play'), t('prStart')),
    ],
  });
}

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
  constructor(slides, { where, mode, win = null }) {
    this.slides = [...slides, { kind: 'end', title: t('prEndOfPresentation'), lines: [] }];
    this.where = where;
    this.mode = mode;
    this.win = win;
    this.placed = false;
    this.index = 0;
    this.alive = true;
    this.cleanups = [];
    this.advancing = false;
    this.seekPending = false;
    this.fsEntered = false;
    this.startedAt = Date.now();
    this.prevFocus = document.activeElement;
    // [first, last] slide index of the item each slide belongs to.
    this.group = this.slides.map((s, i) => {
      let a = i; let b = i;
      if (s.itemId) {
        while (a > 0 && this.slides[a - 1].itemId === s.itemId) a--;
        while (b < this.slides.length - 1 && this.slides[b + 1].itemId === s.itemId) b++;
      }
      return [a, b];
    });
    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
    if (where === 'screen') this.buildScreen(); else this.buildPresenter();
    document.body.append(this.root);
    this.listen();
    this.go(0, { user: true });
  }

  // ---- building ----
  buildScreen() {
    this.stage = h('div', { class: 'stage pr-screen-stage' });
    this.hint = h('div', { class: 'pr-hint' });
    this.root = h('div', {
      class: 'pr-overlay pr-screen',
      tabindex: '-1',
      onclick: () => this.next(),
      oncontextmenu: (e) => { e.preventDefault(); this.prev(); },
      onmousemove: () => this.showHint(),
    }, this.stage, this.hint);
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
    this.playBtn = btn('play', t('prPlayPause'), () => this.togglePlay(), 'pr-play-btn');
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
    this.root = h('div', { class: 'pr-overlay pr-presenter', tabindex: '-1' },
      h('header', { class: 'pr-top' },
        h('strong', { class: 'pr-top-title' }, icon('present'), t('prPresenterView')),
        h('span', { class: `pr-badge${this.mode === 'auto' ? ' pr-badge-auto' : ''}` }, this.mode === 'auto' ? t('prAutoBadge') : t('prManualBadge')),
        this.audStatus, this.reopenBtn,
        h('span', { class: 'pr-spacer' }),
        h('span', { class: 'pr-time' }, icon('clock'), this.clock),
        h('span', { class: 'pr-time' }, h('span', { class: 'dim' }, `${t('prElapsed')} `), this.elapsed),
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
    this.thumbs.forEach(({ st }, i) => renderSlide(st, this.slides[i]));
  }

  // ---- events ----
  listen() {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.handleKey(e.key)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey, true));

    const onUnload = () => this.post({ type: 'end' });
    window.addEventListener('pagehide', onUnload);
    this.cleanups.push(() => window.removeEventListener('pagehide', onUnload));

    if (this.channel) {
      this.channel.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'hello') this.sendDeck();
        else if (m.type === 'key') this.handleKey(m.key);
      };
    }

    if (this.where === 'screen') {
      const onFs = () => {
        if (document.fullscreenElement) this.fsEntered = true;
        else if (this.fsEntered) this.end();
      };
      document.addEventListener('fullscreenchange', onFs);
      this.cleanups.push(() => document.removeEventListener('fullscreenchange', onFs));
      this.root.focus({ preventScroll: true });
    } else {
      const tick = () => {
        this.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.elapsed.textContent = fmtTime((Date.now() - this.startedAt) / 1000);
        const open = this.win && !this.win.closed;
        this.audStatus.textContent = open ? t('prAudienceOpen') : t('prAudienceClosed');
        this.audStatus.classList.toggle('off', !open);
        this.reopenBtn.hidden = open;
      };
      tick();
      const timer = setInterval(tick, 1000);
      this.cleanups.push(() => clearInterval(timer));
      this.root.focus({ preventScroll: true });
    }

    if (this.mode === 'auto') {
      this.cleanups.push(on('time', (time) => this.onTime(time)));
      this.cleanups.push(on('ended', (item) => this.onEnded(item)));
      this.cleanups.push(on('player', () => this.updateAuto()));
    }
  }

  handleKey(key) {
    if (!this.alive) return false;
    if (NEXT_KEYS.has(key)) this.next();
    else if (PREV_KEYS.has(key)) this.prev();
    else if (key === 'Home') this.go(0, { user: true });
    else if (key === 'End') this.go(this.slides.length - 1, { user: true });
    else if (key === 'Escape') this.end();
    else return false;
    return true;
  }

  post(msg) { try { this.channel?.postMessage(msg); } catch { /* closed */ } }
  sendDeck() { this.post({ type: 'deck', slides: this.slides, index: this.index, placed: this.placed }); }
  setPlaced(placed) { this.placed = placed; if (this.alive) this.sendDeck(); }

  reopen() {
    const win = window.open('present.html', 'ainos-audience', POPUP_FEATURES);
    if (!win) { toast(t('prPopupBlocked')); return; }
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
    if (this.mode === 'auto' && !fromAudio) this.syncAudio(user);
    this.updateAuto();
  }

  render() {
    const cur = this.slides[this.index];
    renderSlide(this.stage, cur);
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
    const auto = this.mode === 'auto' ? ` · ${t('prAutoBadge')}` : '';
    this.hint.textContent = `${this.index + 1} / ${this.slides.length}${auto} · ${t('prEscToExit')}`;
    this.hint.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hint.classList.remove('show'), 2200);
  }

  // ---- automatic mode ----
  syncAudio(user) {
    const s = this.slides[this.index];
    if (!s.hymnId) {
      if (player.current?.type !== 'video') player.pause();
      return;
    }
    if (player.current?.id !== s.hymnId) {
      // One-item queue, so the player doesn't run on into an unrelated hymn.
      player.play(s.hymnId, [s.hymnId]);
      if (s.start > 0.3) this.seekWhenReady(s.start + 0.02);
    } else {
      if (user) player.seek(s.start > 0 ? s.start + 0.02 : 0);
      if (player.audio.paused) player.audio.play().catch(() => {});
    }
  }

  seekWhenReady(at) {
    const a = player.audio;
    this.seekPending = true;
    const done = () => { this.seekPending = false; if (this.alive) player.seek(at); };
    if (a.readyState >= 1) done();
    else {
      a.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(() => { this.seekPending = false; }, 3000);
    }
  }

  onTime(time) {
    if (!this.alive || this.advancing || this.seekPending) return;
    this.updateAuto(time);
    const s = this.slides[this.index];
    if (!s?.hymnId || player.current?.id !== s.hymnId || player.audio.paused) return;
    const [first, last] = this.group[this.index];
    for (let j = first; j <= last; j++) {
      const x = this.slides[j];
      if (x.start <= time && time < x.end) {
        if (j !== this.index) this.go(j, { fromAudio: true });
        return;
      }
    }
    if (time >= this.slides[last].end - 0.05) this.afterHymn();
  }

  onEnded(item) {
    if (!this.alive || this.advancing) return;
    if (item?.id && item.id === this.slides[this.index].hymnId) this.afterHymn();
  }

  /** The hymn finished: go to the next item's first slide (the player runs its own 'ended' logic first). */
  afterHymn() {
    const [, last] = this.group[this.index];
    this.advancing = true;
    setTimeout(() => {
      this.advancing = false;
      if (this.alive) this.go(last + 1);
    }, 80);
  }

  togglePlay() {
    const s = this.slides[this.index];
    if (s.hymnId && player.current?.id !== s.hymnId) this.syncAudio(true);
    else player.toggle();
  }

  updateAuto(time) {
    if (this.mode !== 'auto' || !this.autoText) return;
    const s = this.slides[this.index];
    const playing = player.isPlaying() && player.current?.id === s.hymnId;
    clear(this.playBtn).append(icon(playing ? 'pause' : 'play'));
    this.playBtn.hidden = !s.hymnId;
    if (s.hymnId) {
      const tm = time ?? player.time();
      this.autoText.textContent = `${s.title} · ${fmtTime(player.current?.id === s.hymnId ? tm : 0)} / ${fmtTime(player.item(s.hymnId)?.duration || 0)}`;
    } else if (s.kind === 'end') {
      this.autoText.textContent = t('prEndOfPresentation');
    } else if (s.kind === 'song' || s.kind === 'title') {
      this.autoText.textContent = t('prAutoNoAudio');
    } else {
      this.autoText.textContent = t('prAutoWaiting');
    }
  }

  // ---- end ----
  end() {
    if (!this.alive) return;
    this.alive = false;
    for (const fn of this.cleanups) { try { fn(); } catch { /* ignore */ } }
    clearTimeout(this.hintTimer);
    if (this.mode === 'auto' && player.current?.type !== 'video') player.pause();
    this.post({ type: 'end' });
    const ch = this.channel;
    setTimeout(() => ch?.close(), 300);
    if (this.win && !this.win.closed) { try { this.win.close(); } catch { /* ignore */ } }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    if (active === this) active = null;
    try { this.prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
}
