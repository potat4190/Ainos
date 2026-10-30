// Listener home: greeting, hymns, sample playlists and recently played.
// Also exports the small cover helpers the sidebar, search and player bar share.
import { h, icon, cover } from '../ui.js';
import { t } from '../i18n.js';
import { state, on } from '../state.js';
import { player } from '../player.js';
import { HYMNS } from '../data/hymns.js';

const HUES = { 'amazing-grace': 38, 'it-is-well': 200, 'holy-holy-holy': 268, 'abide-with-me': 14, 'video:carry-my-cross': 352 };

/** A stable cover hue for an item id. */
export function hueFor(id = '') {
  if (HUES[id] != null) return HUES[id];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

/** Cover art for an item (hymn or video). Videos get a play glyph, never a YouTube thumbnail. */
export function artFor(item, cls = 'cover') {
  const el = cover(hueFor(item?.id), '', cls);
  if (item?.type === 'video') { el.classList.add('cover-video'); el.append(h('span', { class: 'cover-glyph' }, icon('play'))); }
  return el;
}

export const PLAYLISTS = [
  { id: 'sunday', name: 'playlistSunday', sub: 'playlistSundaySub', hue: 150, ids: ['holy-holy-holy', 'amazing-grace', 'it-is-well'] },
  { id: 'evening', name: 'playlistEvening', sub: 'playlistEveningSub', hue: 225, ids: ['abide-with-me', 'it-is-well'] },
  { id: 'grace', name: 'playlistGrace', sub: 'playlistGraceSub', hue: 30, ids: ['amazing-grace', 'abide-with-me', 'holy-holy-holy'] },
].map((p) => ({ ...p, ids: p.ids.filter((id) => HYMNS.some((x) => x.id === id)) }));

function greeting() {
  const hr = new Date().getHours();
  return t(hr < 12 ? 'goodMorning' : hr < 18 ? 'goodAfternoon' : 'goodEvening');
}

/** A card: cover, title, sub line, hover play button. */
export function card({ id, art, title, sub, onPlay }) {
  const play = (e) => { e?.stopPropagation(); onPlay(); };
  return h('div', {
    class: 'card', role: 'button', tabindex: '0', 'aria-label': t('playX', { title }), dataset: { id },
    onclick: play, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } },
  },
  h('div', { class: 'card-art' }, art,
    h('button', { class: 'round-play card-play', tabindex: '-1', 'aria-hidden': 'true', onclick: play }, icon('play'))),
  h('div', { class: 'card-title' }, title),
  h('div', { class: 'card-sub' }, sub));
}

const hymnIds = () => HYMNS.map((x) => x.id);

const playlistArt = (p) => cover(p.hue, t(p.name), 'cover cover-playlist');

function recentRow() {
  const items = state.recent.map((id) => player.item(id)).filter(Boolean);
  if (!items.length) return h('p', { class: 'muted empty-row' }, t('recentEmpty'));
  return h('div', { class: 'card-grid' }, items.map((it) => card({
    id: it.id, art: artFor(it), title: it.title,
    sub: it.type === 'video' ? t('officialVideo', { artist: it.artist }) : it.artist,
    onPlay: () => (it.type === 'video' ? player.play(it.id) : player.play(it.id, hymnIds())),
  })));
}

let offs = [];
function markPlaying() {
  const cur = player.current?.id;
  document.querySelectorAll('.card[data-id]').forEach((c) => c.classList.toggle('playing', c.dataset.id === cur));
}

export function render(el) {
  offs.forEach((f) => f()); offs = [];
  const recentWrap = h('div', {}, recentRow());
  el.append(h('div', { class: 'home' },
    h('header', { class: 'home-hero' },
      h('h1', { class: 'home-greeting' }, greeting()),
      h('p', { class: 'muted' }, t('homeSub'))),
    h('h2', { class: 'section-title' }, t('rowHymns')),
    h('div', { class: 'card-grid' }, HYMNS.map((x) => card({
      id: x.id, art: artFor(x), title: x.title, sub: x.words, onPlay: () => player.play(x.id, hymnIds()),
    }))),
    h('h2', { class: 'section-title' }, t('rowPlaylists')),
    h('div', { class: 'card-grid' }, PLAYLISTS.filter((p) => p.ids.length).map((p) => card({
      id: `playlist:${p.id}`, art: playlistArt(p), title: t(p.name),
      sub: `${t(p.sub)} · ${t('nHymns', { n: p.ids.length })}`, onPlay: () => player.play(p.ids[0], p.ids),
    }))),
    h('h2', { class: 'section-title' }, t('rowRecent')),
    recentWrap));
  markPlaying();
  offs.push(on('state', (patch) => {
    if (!recentWrap.isConnected) return;
    if (patch && 'recent' in patch) { recentWrap.replaceChildren(recentRow()); markPlaying(); }
  }));
  offs.push(on('player', () => { if (recentWrap.isConnected) markPlaying(); }));
}
