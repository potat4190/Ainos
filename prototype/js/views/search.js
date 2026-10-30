// Search: official videos (by keyword) and hymns (title, author, tune, lyric lines).
import { h, icon } from '../ui.js';
import { t } from '../i18n.js';
import { player } from '../player.js';
import { HYMNS } from '../data/hymns.js';
import { VIDEOS } from '../data/videos.js';
import { artFor } from './home.js';

const SUGGESTIONS = ['Amazing Grace', 'Carry My Cross', 'Holy', 'It is well', 'Abide with me', 'Newton', 'NICAEA', 'grace'];

/** Lowercase, drop accents and punctuation, collapse spaces. */
export const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const words = (s) => norm(s).split(' ').filter(Boolean);
/** Every query word appears as a word prefix in text. */
const allWords = (qw, text) => { const tw = words(text); return qw.every((w) => tw.some((x) => x.startsWith(w))); };

function lyricLines(hymn) {
  const out = [];
  for (const sec of hymn.lyrics || []) for (const l of sec.lines || []) out.push(l.text);
  for (const sec of hymn.moreVerses || []) for (const l of sec.lines || []) out.push(typeof l === 'string' ? l : l.text);
  return out.filter(Boolean);
}

/** Search the sample catalogue. Returns [{ item, score, kind: 'video'|'hymn', match?: { type, text } }] best first. */
export function searchAll(query) {
  const q = norm(query);
  if (!q) return [];
  const qw = q.split(' ');
  const results = [];

  for (const v of VIDEOS) {
    const keys = (v.keywords || []).map(norm);
    const title = norm(v.title);
    let score = 0;
    if (title === q || keys.includes(q)) score = 120;
    else if (title.startsWith(q)) score = 110;
    else if (keys.some((k) => k.startsWith(q))) score = 95;
    else if (allWords(qw, [v.title, v.artist, ...(v.keywords || [])].join(' '))) score = 70;
    if (score) results.push({ item: v, score, kind: 'video' });
  }

  for (const x of HYMNS) {
    const title = norm(x.title);
    let score = 0;
    let match = null;
    if (title === q) score = 115;
    else if (title.startsWith(q)) score = 105;
    else if (title.includes(q)) score = 90;
    else if (allWords(qw, x.title)) score = 80;
    else if (allWords(qw, x.words)) { score = 60; match = { type: 'matchWords', text: x.words }; }
    else if (allWords(qw, x.tune)) { score = 55; match = { type: 'matchTune', text: x.tune }; }
    if (score < 60) {
      const lines = lyricLines(x);
      const phrase = lines.find((l) => norm(l).includes(q));
      const loose = phrase || lines.find((l) => allWords(qw, l));
      if (loose) {
        const s = phrase ? 65 : 45;
        if (s > score) { score = s; match = { type: 'matchLyric', text: loose }; }
      }
    }
    if (score) results.push({ item: x, score, kind: 'hymn', match });
  }

  return results.sort((a, b) => b.score - a.score);
}

const playResult = (r) => (r.kind === 'video' ? player.play(r.item.id) : player.play(r.item.id, HYMNS.map((x) => x.id)));
const subLine = (r) => (r.kind === 'video' ? t('officialVideo', { artist: r.item.artist }) : t('hymnBy', { words: r.item.words }));

function topCard(r) {
  return h('div', { class: 'top-result', role: 'button', tabindex: '0', 'aria-label': t('playX', { title: r.item.title }),
    onclick: () => playResult(r), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playResult(r); } } },
  artFor(r.item, 'cover top-cover'),
  h('div', { class: 'top-title' }, r.item.title),
  h('div', { class: 'top-sub' }, r.kind === 'video' ? h('span', { class: 'tag tag-video' }, icon('video'), t('video')) : null, h('span', {}, subLine(r))),
  r.match ? h('div', { class: 'snippet' }, h('span', { class: 'snippet-label' }, t(r.match.type)), ` “${r.match.text}”`) : null,
  h('button', { class: 'round-play top-play', tabindex: '-1', 'aria-hidden': 'true', onclick: (e) => { e.stopPropagation(); playResult(r); } }, icon('play')));
}

function row(r) {
  return h('li', {},
    h('button', { class: 'result-row', onclick: () => playResult(r), 'aria-label': t('playX', { title: r.item.title }) },
      h('span', { class: 'result-art' }, artFor(r.item, 'cover result-cover'), h('span', { class: 'result-play' }, icon('play'))),
      h('span', { class: 'result-text' },
        h('span', { class: 'result-title' }, r.item.title),
        h('span', { class: 'result-sub' }, r.kind === 'video' ? icon('video', 'icon icon-xs') : null, subLine(r)),
        r.match ? h('span', { class: 'snippet' }, h('span', { class: 'snippet-label' }, t(r.match.type)), ` “${r.match.text}”`) : null)));
}

export function render(el, query = '') {
  const results = h('div', { class: 'search-results', 'aria-live': 'polite' });
  const input = h('input', {
    class: 'search-input', type: 'search', value: query, placeholder: t('searchPlaceholder'),
    'aria-label': t('searchLabel'), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
  });
  const update = () => {
    const q = input.value;
    const hash = q.trim() ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
    if (location.hash !== hash) history.replaceState(null, '', hash);
    results.replaceChildren(...view(q, (s) => { input.value = s; update(); input.focus(); }));
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = searchAll(input.value)[0]; if (first) playResult(first); }
  });
  el.append(h('div', { class: 'search' },
    h('label', { class: 'search-box' }, icon('search'), input),
    results));
  results.replaceChildren(...view(query, (s) => { input.value = s; update(); input.focus(); }));
  requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
}

function view(q, pick) {
  if (!norm(q)) {
    return [h('div', { class: 'browse' },
      h('h2', { class: 'section-title' }, t('browseTitle')),
      h('p', { class: 'muted' }, t('browseSub')),
      h('div', { class: 'chips' }, SUGGESTIONS.map((s) => h('button', { class: 'chip', onclick: () => pick(s) }, icon('search', 'icon icon-xs'), s))))];
  }
  const res = searchAll(q);
  if (!res.length) {
    return [h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon('search')),
      h('h2', {}, t('noResultsTitle', { q: q.trim() })),
      h('p', { class: 'muted' }, t('noResultsSub')),
      h('div', { class: 'chips' }, SUGGESTIONS.slice(0, 4).map((s) => h('button', { class: 'chip', onclick: () => pick(s) }, s))))];
  }
  const [top, ...rest] = res;
  return [h('div', { class: 'results-grid' },
    h('section', { class: 'results-top' }, h('h2', { class: 'section-title' }, t('topResult')), topCard(top)),
    rest.length ? h('section', { class: 'results-list' }, h('h2', { class: 'section-title' }, t('searchHymns')), h('ul', { class: 'result-rows' }, rest.map(row))) : null)];
}
