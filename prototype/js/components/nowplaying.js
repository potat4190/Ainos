// The right panel: now playing (cover, credits, Scripture card), synced lyrics,
// and the official YouTube embed for videos. Re-renders on 'player' and
// 'state'; 'time' only toggles classes on the lyric lines.
import { h, icon, cover, clear } from '../ui.js';
import { state, on, set } from '../state.js';
import { player } from '../player.js';
import { t } from '../i18n.js';
import { WEB_ATTRIBUTION } from '../data/hymns.js';
import * as home from '../views/home.js';
import { mountYouTube, watchUrl } from '../youtube.js';

const USER_SCROLL_GRACE_MS = 3000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

let unsubs = [];

function hueOf(item) {
  if (typeof home.hueFor === 'function') return home.hueFor(item?.id);
  let n = 0;
  for (const c of String(item?.id || '')) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

/** 'V1' → 'Verse 1', 'C' → 'Chorus', … (falls back to the raw label). */
function sectionLabel(label = '') {
  const m = /^V(\d+)$/i.exec(label);
  if (m) return t('verseN', { n: m[1] });
  if (/^C\d*$/i.test(label)) return t('chorus');
  if (/^B\d*$/i.test(label)) return t('bridge');
  if (/^(P|PC)\d*$/i.test(label)) return t('preChorus');
  return label;
}

const reduceMotion = () => matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function mountNowPlaying(el) {
  // A language change rebuilds the shell and mounts again: drop the old listeners.
  for (const u of unsubs) u();
  unsubs = [];

  const ctx = { key: null, tabs: null, lyrics: null, video: null };
  let lastUserScroll = 0;
  const markUser = () => { lastUserScroll = performance.now(); };
  el.addEventListener('wheel', markUser, { passive: true });
  el.addEventListener('touchstart', markUser, { passive: true });
  el.addEventListener('touchmove', markUser, { passive: true });
  el.addEventListener('keydown', (e) => { if (SCROLL_KEYS.has(e.key)) markUser(); });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) markUser(); }); // scrollbar drag

  function render() {
    const cur = player.current;
    if (!state.panel) {
      el.hidden = true;
      // Removing the player stops the video: it never plays hidden.
      if (ctx.key) { ctx.video?.yt?.destroy(); clear(el); Object.assign(ctx, { key: null, tabs: null, lyrics: null, video: null }); }
      return;
    }
    el.hidden = false;
    const isVideo = cur?.type === 'video';
    const key = isVideo ? `video|${cur.id}|${cur.youtubeId}|${state.lang}` : `${state.panel}|${cur?.id || ''}|${state.lang}`;
    if (key !== ctx.key) build(key, cur, isVideo);
    syncChrome();
    if (ctx.lyrics) highlight(player.time());
  }

  function build(key, cur, isVideo) {
    ctx.key = key;
    ctx.lyrics = null;
    ctx.video?.yt?.destroy();
    ctx.video = null;
    const tab = (panel, label) => h('button', { class: 'np-tab', type: 'button', onclick: () => set({ panel }) }, label);
    ctx.tabs = { nowplaying: tab('nowplaying', t('npNowPlaying')), lyrics: tab('lyrics', t('npLyrics')) };
    const head = h('div', { class: isVideo ? 'np-head np-head-static' : 'np-head' },
      h('div', { class: 'np-tabs', role: 'group', 'aria-label': t('npPanel') }, ctx.tabs.nowplaying, ctx.tabs.lyrics),
      h('button', { class: 'icon-btn np-close', type: 'button', 'aria-label': t('close'), title: t('close'), onclick: () => set({ panel: null }) }, icon('close')));
    let body;
    if (isVideo) body = buildVideo(cur);
    else if (!cur) body = buildEmpty();
    else if (state.panel === 'lyrics') body = buildLyrics(cur);
    else body = buildHymn(cur);
    clear(el).append(head, body);
    el.scrollTop = 0;
    if (ctx.lyrics) {
      highlight(player.time(), true);
      // At mount time the panel may not be in the document yet: place the line once it is.
      const lyrics = ctx.lyrics;
      requestAnimationFrame(() => { if (ctx.lyrics === lyrics) highlight(player.time(), true); });
    }
  }

  function syncChrome() {
    for (const [panel, btn] of Object.entries(ctx.tabs || {})) {
      const active = state.panel === panel;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    const v = ctx.video;
    if (!v) return;
    v.note.hidden = state.panel !== 'lyrics';
    // Forward the player bar's play/pause to the official player (IFrame Player API).
    const want = player.isPlaying();
    if (v.yt && want !== v.playing) {
      v.playing = want;
      if (want) v.yt.play(); else v.yt.pause();
    }
  }

  // ---- views ----

  function buildEmpty() {
    const lyrics = state.panel === 'lyrics';
    return h('div', { class: 'np-body np-empty' },
      h('div', { class: 'np-empty-art', 'aria-hidden': 'true' }, icon(lyrics ? 'lyrics' : 'nowplaying', 'icon np-empty-icon')),
      h('h2', { class: 'np-empty-title' }, t('npEmptyTitle')),
      h('p', { class: 'muted' }, lyrics ? t('npLyricsEmpty') : t('npEmptySub')));
  }

  function buildHymn(hy) {
    const credits = [];
    if (hy.words) credits.push(h('dt', {}, t('npWords')), h('dd', {}, hy.words));
    if (hy.tune) credits.push(h('dt', {}, t('npTune')), h('dd', {}, hy.tune));
    return h('div', { class: 'np-body' },
      cover(hueOf(hy), '', 'cover np-cover'),
      h('div', { class: 'np-titlerow' },
        h('div', { class: 'np-titles' },
          h('h2', { class: 'np-title' }, hy.title),
          h('div', { class: 'np-artist' }, hy.artist || 'Ainos Hymnal')),
        hy.lyrics?.length ? h('button', { class: 'btn btn-ghost btn-sm np-lyrics-btn', type: 'button', onclick: () => set({ panel: 'lyrics' }) }, icon('lyrics'), t('npLyrics')) : null),
      credits.length ? h('section', { class: 'np-card' }, h('h3', { class: 'np-card-title' }, t('npCredits')), h('dl', { class: 'np-credits' }, credits)) : null,
      hy.scripture?.length ? buildScripture(hy) : null);
  }

  function buildScripture(hy) {
    const items = [];
    const toggle = (i) => items.forEach((it, j) => {
      const open = j === i && it.btn.getAttribute('aria-expanded') !== 'true';
      it.item.classList.toggle('open', open);
      it.btn.setAttribute('aria-expanded', String(open));
      it.region.inert = !open;
    });
    const list = hy.scripture.slice(0, 2).map((s, i) => {
      const id = `np-scr-${i}`;
      const region = h('div', { class: 'np-scr-region', id, role: 'region', 'aria-labelledby': `${id}-btn` },
        h('div', { class: 'np-scr-inner' },
          h('blockquote', { class: 'np-quote' }, h('p', {}, s.text)),
          h('p', { class: 'np-attrib' }, `${s.label} · ${WEB_ATTRIBUTION}`)));
      region.inert = true;
      const btn = h('button', { class: 'np-scr-btn', type: 'button', id: `${id}-btn`, 'aria-expanded': 'false', 'aria-controls': id, onclick: () => toggle(i) },
        icon('book', 'icon np-scr-icon'), h('span', { class: 'np-scr-ref' }, s.label), icon('down', 'icon np-chev'));
      const item = h('div', { class: 'np-scr-item' }, btn, region);
      items.push({ item, btn, region });
      return item;
    });
    return h('section', { class: 'np-card np-scripture' },
      h('div', { class: 'np-card-head' },
        h('h3', { class: 'np-card-title' }, t('npScripture')),
        h('p', { class: 'np-card-sub' }, t('npScriptureSub'))),
      list);
  }

  function buildVideo(v) {
    // The official player (IFrame Player API, www.youtube.com). If YouTube can't
    // play it here, a fallback appears BELOW the player, which stays visible.
    const fallback = h('p', { class: 'np-yt-fallback', role: 'status' },
      t('npYtFallback'), ' ',
      h('a', { href: watchUrl(v.youtubeId || ''), target: '_blank', rel: 'noopener noreferrer' }, t('npWatchOnYouTube')));
    fallback.hidden = true;
    let frame;
    let yt = null;
    if (v.youtubeId) {
      frame = h('div', { class: 'np-frame np-frame-host' });
      yt = mountYouTube(frame, {
        videoId: v.youtubeId,
        title: t('npVideoFrameTitle', { title: v.title }),
        onProblem: (reason) => { console.info('[ainos] YouTube player:', reason); fallback.hidden = false; },
        onPlaying: () => { fallback.hidden = true; },
      });
    } else {
      frame = h('div', { class: 'np-frame np-frame-missing', role: 'note' }, icon('video', 'icon np-missing-icon'), h('p', {}, t('npVideoIdNotSet')));
    }
    const note = h('p', { class: 'np-video-nolyrics' }, icon('lyrics'), t('npNoLyricsVideo'));
    note.hidden = true;
    ctx.video = { yt, note, playing: true };
    return h('div', { class: 'np-body np-video' },
      h('div', { class: 'np-frame-wrap' }, frame),
      fallback,
      h('div', { class: 'np-titles' },
        h('span', { class: 'np-badge' }, icon('video'), t('npOfficialVideo')),
        h('h2', { class: 'np-title' }, v.title),
        h('div', { class: 'np-artist' }, t('npOfficialChannel', { artist: v.artist }))),
      note,
      h('p', { class: 'np-yt-note' }, t('npPlaysFromYouTube')));
  }

  function buildLyrics(hy) {
    const lines = [];
    const jump = (time) => {
      lastUserScroll = 0;
      player.seek(time);
      if (!player.isPlaying()) player.toggle();
    };
    const sections = (hy.lyrics || []).map((sec) => h('section', { class: 'np-sec' },
      h('div', { class: 'np-sec-label' }, sectionLabel(sec.label)),
      sec.lines.map((ln) => {
        const b = h('button', { class: 'np-line', type: 'button', onclick: () => jump(ln.t) }, ln.text);
        lines.push({ t: ln.t, el: b });
        return b;
      })));
    const more = hy.moreVerses?.length
      ? h('section', { class: 'np-more' },
        h('h3', { class: 'np-more-title' }, t('npMoreVerses')),
        hy.moreVerses.map((sec) => h('div', { class: 'np-sec' },
          h('div', { class: 'np-sec-label' }, sectionLabel(sec.label)),
          sec.lines.map((text) => h('p', { class: 'np-line-static' }, text)))))
      : null;
    ctx.lyrics = { lines, idx: -2 };
    return h('div', { class: 'np-body np-lyrics' },
      h('div', { class: 'np-lyrics-head' },
        h('h2', { class: 'np-title' }, hy.title),
        h('p', { class: 'np-hint' }, h('span', { class: 'np-dot', 'aria-hidden': 'true' }), t('npSyncedHint'))),
      h('div', { class: 'np-lines' }, sections),
      more);
  }

  // ---- synced highlight ----

  function highlight(time, instant = false) {
    const L = ctx.lyrics;
    if (!L) return;
    let idx = -1;
    for (let i = 0; i < L.lines.length; i++) if (L.lines[i].t <= time + 0.05) idx = i;
    if (idx === L.idx && !instant) return;
    L.idx = idx;
    L.lines.forEach((ln, i) => {
      ln.el.classList.toggle('past', i < idx);
      ln.el.classList.toggle('current', i === idx);
      if (i === idx) ln.el.setAttribute('aria-current', 'true');
      else ln.el.removeAttribute('aria-current');
    });
    if (idx >= 0) scrollToLine(L.lines[idx].el, instant);
  }

  function scrollToLine(lineEl, instant) {
    if (!el.isConnected || el.hidden) return;
    if (!instant && performance.now() - lastUserScroll < USER_SCROLL_GRACE_MS) return;
    const box = el.getBoundingClientRect();
    const r = lineEl.getBoundingClientRect();
    const top = el.scrollTop + (r.top - box.top) + r.height / 2 - el.clientHeight / 3;
    el.scrollTo({ top: Math.max(0, top), behavior: instant || reduceMotion() ? 'auto' : 'smooth' });
  }

  unsubs.push(
    on('player', render),
    on('state', render),
    on('time', (time) => { if (ctx.lyrics) highlight(time); }),
  );
  render();
}
