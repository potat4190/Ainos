import { api, rememberTracks } from './api.js';
import { h, icon, clear, img, mosaic, likedArt, fmtTime, fmtDuration, fmtNumber, fmtBytes, timeAgo, toast, showMenu, promptDialog, safely } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { LOUDNESS_TARGETS } from './player.js';
import { CROSSFADE_CHOICES } from './crossfade.js';
import { LANGUAGES, getLang, t, langDisplayName, translateEditorial, translateMix, translateGenre, errorText } from './i18n.js';

const coarse = matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------- components

/** Spotify-style track table. ctx = { uri, title, tracks } is what gets played. */
export function trackList(app, tracks, ctx, opts = {}) {
  const { showAlbum = true, showCover = true, playlist = null, extra = null } = opts;
  rememberTracks(tracks);
  const root = h('div', { class: `tracklist${showAlbum ? '' : ' no-album'}`, role: 'list', 'aria-label': ctx.title || t('songs') });
  root.append(h('div', { class: 'tl-head', 'aria-hidden': 'true' },
    h('div', { class: 'tl-num' }, '#'), h('div', {}, t('titleCol')), showAlbum ? h('div', { class: 'tl-album' }, extra?.header || t('albumCol')) : null,
    h('div', { class: 'tl-end' }, h('span', { class: 'dur', title: t('durationCol') }, icon('clock')))));

  let dragFrom = null;
  tracks.forEach((tr, i) => {
    const play = () => app.player.playContext(ctx, i);
    const likeBtn = h('button', { class: `icon-btn${app.isLiked(tr.id) ? ' on' : ''}`, 'aria-label': app.isLiked(tr.id) ? t('removeFromLiked') : t('saveToLiked'), dataset: { likeId: tr.id } }, icon(app.isLiked(tr.id) ? 'heart-fill' : 'heart'));
    likeBtn.addEventListener('click', (e) => { e.stopPropagation(); app.toggleLike(tr); });
    const moreBtn = h('button', { class: 'icon-btn', 'aria-label': t('moreOptionsFor', { title: tr.title }) }, icon('more'));
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); app.trackMenu(tr, e, { playlist, position: tr.position, count: tracks.length }); });

    const row = h('div', { class: 'tl-row', role: 'listitem', tabindex: '0', dataset: { trackId: tr.id, ctx: ctx.uri || '' } },
      h('div', { class: 'tl-num' }, h('span', { class: 'n' }, String(i + 1)), h('button', { class: 'play-small', 'aria-label': t('playTitle', { title: tr.title }), onclick: (e) => { e.stopPropagation(); play(); } }, icon('play'))),
      h('div', { class: 'tl-main' },
        showCover ? img(tr.album.cover, 'art') : null,
        h('div', { class: 'tl-title' },
          h('span', { class: 'tl-title-text' }, tr.title),
          h('div', { class: 'tl-sub' }, h('a', { href: `#/artist/${tr.artist.id}`, onclick: (e) => e.stopPropagation() }, tr.artist.name)))),
      showAlbum ? h('div', { class: 'tl-album' }, extra?.cell ? extra.cell(tr) : h('a', { href: `#/album/${tr.album.id}`, onclick: (e) => e.stopPropagation() }, tr.album.title)) : null,
      h('div', { class: 'tl-end' }, likeBtn, h('span', { class: 'dur' }, fmtTime(tr.duration_ms)), moreBtn));

    row.addEventListener('dblclick', play);
    if (coarse) row.addEventListener('click', play);
    // Only the row itself: Enter on its Like / More buttons must not also start the song.
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) play(); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); app.trackMenu(tr, e, { playlist, position: tr.position, count: tracks.length }); });

    if (playlist?.is_owner) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); row.classList.add('dragover'); } });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', safely(async (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        if (dragFrom === null || dragFrom === i) return;
        const from = dragFrom; dragFrom = null;
        await api.post(`/api/playlists/${playlist.id}/move`, { from, to: i });
        app.refresh();
      }));
      row.addEventListener('dragend', () => { dragFrom = null; });
    }
    root.append(row);
  });
  queueMicrotask(() => app.highlightPlaying());
  return root;
}

function card(app, { art, title, sub, href, onPlay, round = false }) {
  const c = h('a', { class: 'card', href }, art, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub || ''));
  if (round) c.querySelector('.art')?.classList.add('round');
  if (onPlay) {
    const fab = h('button', { class: 'fab', 'aria-label': t('playTitle', { title }) }, icon('play'));
    fab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); safely(onPlay)(e); });
    c.append(fab);
  }
  return c;
}

function section(title, content, { sub, href } = {}) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, href ? h('a', { href }, title) : title), sub ? h('span', { class: 'muted' }, sub) : null),
    content);
}

function grid(items) {
  return h('div', { class: 'grid' }, items);
}

function pageHead({ art, kind, title, desc, facts, color }) {
  const head = h('header', { class: 'page-head', style: { '--hero': color || '#3a3550' } },
    art,
    h('div', { class: 'page-meta' },
      h('div', { class: 'kind' }, kind),
      h('h1', {}, title),
      desc ? h('div', { class: 'desc' }, desc) : null,
      h('div', { class: 'facts' }, facts)));
  return head;
}

function actionBar(app, color, ...items) {
  return h('div', { class: 'actionbar', style: { '--hero': color || '#3a3550' } }, items);
}

function playFab(app, getCtx, label = t('play')) {
  const b = h('button', { class: 'fab', 'aria-label': label }, icon('play'));
  b.addEventListener('click', safely(async () => {
    const ctx = await getCtx();
    const v = app.player.view();
    if (v.contextUri && v.contextUri === ctx.uri && v.track) return app.player.toggle();
    app.player.playContext(ctx, app.player.shuffle ? -1 : 0);
  }));
  const c = getCtx();
  if (c && typeof c.then !== 'function' && c.uri) b.dataset.ctxUri = c.uri;
  return b;
}

function downloadBtn(app, tracks) {
  const all = () => tracks.length && tracks.every((t) => app.player.downloads[t.id]);
  const b = h('button', { class: `icon-btn${all() ? ' liked' : ''}`, 'aria-label': all() ? t('removeDownload') : t('download') }, icon(all() ? 'check' : 'download'));
  b.addEventListener('click', async () => {
    try {
      if (all()) {
        for (const t of tracks) await app.player.removeDownload(t.id);
        toast(t('downloadRemovedToast'));
      } else {
        toast(t('downloadingToast', { n: tracks.length }));
        const n = await app.player.download(tracks);
        toast(t('downloadedNToast', { n }));
      }
      clear(b).append(icon(all() ? 'check' : 'download'));
      b.classList.toggle('liked', all());
      b.setAttribute('aria-label', all() ? t('removeDownload') : t('download'));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
  return b;
}

function moreBtn(onClick) {
  const b = h('button', { class: 'icon-btn', 'aria-label': t('moreOptions') }, icon('more'));
  b.addEventListener('click', onClick);
  return b;
}

const facts = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [' • ', p] : [p]));

function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', {}, title), h('p', {}, text), action ? h('div', { class: 'empty-actions' }, action) : null);
}

// ------------------------------------------------------------------ views

export async function home(el, _p, app) {
  const lang = getLang();
  const data = await api.get(`/api/home?lang=${encodeURIComponent(lang)}`);
  const hr = new Date().getHours();
  const greet = hr < 5 ? t('goodNight') : hr < 12 ? t('goodMorning') : hr < 18 ? t('goodAfternoon') : t('goodEvening');
  el.append(
    h('div', { class: 'faith-banner' }, icon('sparkle'), t('faithBanner')),
    h('h1', { class: 'greeting', style: { 'font-size': '30px', 'margin-top': '10px' } }, greet),
  );

  const mixes = data.made_for_you.map((m) => translateMix(m, lang));
  const editorials = data.editorial.map(translateEditorial);

  // Shortcuts (2x4 grid at the top of home)
  const shortcuts = [];
  const sc = (art, label, href, getCtx) => {
    const fab = h('button', { class: 'fab', 'aria-label': t('playTitle', { title: label }) }, icon('play'));
    fab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); safely(async () => app.player.playContext(await getCtx(), 0))(e); });
    return h('a', { class: 'shortcut', href }, art, h('span', {}, label), fab);
  };
  shortcuts.push(sc(likedArt('art'), t('likedSongs'), '#/liked', () => loadCtx('liked')));
  for (const m of mixes.slice(0, 3)) shortcuts.push(sc(mosaic(m.covers, 'art'), m.title, `#/mix/${m.kind}`, () => loadCtx('mix', m.kind)));
  for (const p of app.library?.playlists.slice(0, 2) || []) shortcuts.push(sc(mosaic(p.covers, 'art'), p.name, `#/playlist/${p.id}`, () => loadCtx('playlist', p.id)));
  for (const p of editorials.slice(0, 8 - shortcuts.length)) shortcuts.push(sc(mosaic(p.covers, 'art'), p.name, `#/playlist/${p.id}`, () => loadCtx('playlist', p.id)));
  el.append(h('div', { class: 'shortcuts' }, shortcuts));

  const langName = langDisplayName(lang);
  if (data.recommended?.length) {
    // No second ":" so uriToRoute() returns null — there is no #/recommended page to link "Playing from" to.
    const recTitle = t('recommendedInLang', { lang: langName });
    const recCtx = { uri: `ainos:recommended-${lang}`, title: recTitle, tracks: data.recommended };
    el.append(section(recTitle, trackList(app, data.recommended.slice(0, 6), recCtx), {
      sub: t('recommendedInLangSub', { lang: langName }),
    }));
  }

  if (mixes.length) {
    el.append(section(t('madeForYou', { name: app.me.display_name }), grid(mixes.map((m) => card(app, {
      art: (() => { const a = mosaic(m.covers, 'art'); a.classList.add('art-mix'); a.dataset.label = m.title; return a; })(),
      title: m.title, sub: m.description, href: `#/mix/${m.kind}`, onPlay: async () => app.player.playContext(await loadCtx('mix', m.kind), 0),
    }))), { sub: t('madeForYouSub') }));
  }

  if (data.recent.length) {
    const seen = new Set();
    const items = data.recent.filter((tr) => !seen.has(tr.album.id) && seen.add(tr.album.id)).slice(0, 6);
    el.append(section(t('recentlyPlayed'), grid(items.map((tr) => card(app, {
      art: img(tr.album.cover), title: tr.album.title, sub: `${tr.artist.name} · ${timeAgo(tr.played_at)}`, href: `#/album/${tr.album.id}`,
      onPlay: async () => { const ctx = await loadCtx('album', tr.album.id); app.player.playContext(ctx, Math.max(0, ctx.tracks.findIndex((x) => x.id === tr.id))); },
    }))), { href: '#/recent' }));
  }

  const popularCtx = { uri: 'ainos:chart:popular', title: t('popularNow', { lang: langName }), tracks: data.popular };
  el.append(section(t('popularNow', { lang: langName }), trackList(app, data.popular.slice(0, 5), { ...popularCtx, tracks: data.popular.slice(0, 5) }, {
    extra: { header: t('plays7Days'), cell: (tr) => fmtNumber(tr.plays) },
  }), { sub: t('popularNowSub', { lang: langName }) }));

  el.append(section(t('newReleases'), grid(data.new_releases.map((a) => card(app, {
    art: img(a.cover), title: a.title, sub: `${a.type === 'single' ? t('single') : t('album')} · ${a.artist.name}`, href: `#/album/${a.id}`,
    onPlay: async () => app.player.playContext(await loadCtx('album', a.id), 0),
  })))));

  el.append(section(t('ainosPicks'), grid(editorials.map((p) => card(app, {
    art: mosaic(p.covers), title: p.name, sub: p.description, href: `#/playlist/${p.id}`,
    onPlay: async () => app.player.playContext(await loadCtx('playlist', p.id), 0),
  }))), { sub: t('ainosPicksSub') }));

  if (data.suggested_artists.length) {
    el.append(section(t('suggestedArtists'), grid(data.suggested_artists.map((a) => card(app, {
      art: img(a.image), title: a.name, sub: t('artist'), href: `#/artist/${a.id}`, round: true,
    })))));
  }
}

/** Fetch something playable and turn it into a player context. */
export async function loadCtx(kind, id) {
  const lang = getLang();
  switch (kind) {
    case 'album': { const a = await api.get(`/api/albums/${id}`); return { uri: a.uri, title: a.title, tracks: a.tracks }; }
    case 'playlist': { const p = translateEditorial(await api.get(`/api/playlists/${id}`)); return { uri: p.uri, title: p.name, tracks: p.tracks }; }
    case 'mix': { const m = translateMix(await api.get(`/api/made-for-you/${id}?lang=${encodeURIComponent(lang)}`), lang); return { uri: m.uri, title: m.title, tracks: m.tracks }; }
    case 'liked': { const l = await api.get('/api/me/liked'); return { uri: 'ainos:collection:liked', title: t('likedSongs'), tracks: l.tracks }; }
    case 'artist': { const a = await api.get(`/api/artists/${id}`); return { uri: a.uri, title: a.name, tracks: a.top_tracks }; }
    case 'radio': { const r = await api.get(`/api/radio/${id}?lang=${encodeURIComponent(lang)}`); return { uri: r.uri, title: r.title, tracks: r.tracks }; }
  }
  throw new Error('unknown context');
}

export async function search(el, params, app) {
  const q = params.q || '';
  app.showSearch(q);
  const results = h('div');
  el.append(results);
  if (!q.trim()) {
    const { genres, playlists } = await api.get('/api/browse/genres');
    results.append(section(t('browseAll'), h('div', { class: 'genre-grid' }, genres.map((g) =>
      h('a', { class: 'genre-tile', href: `#/genre/${encodeURIComponent(g.genre)}`, style: { background: g.color } }, translateGenre(g.genre), h('small', {}, t('tracksCount', { n: g.tracks })))))));
    results.append(section(t('ainosPicks'), grid(playlists.map(translateEditorial).map((p) => card(app, { art: mosaic(p.covers), title: p.name, sub: p.description, href: `#/playlist/${p.id}` })))));
    return;
  }
  const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
  if (!r.tracks.length && !r.artists.length && !r.albums.length && !r.playlists.length) {
    results.append(empty(t('noResultsTitle', { q }), t('noResultsSub')));
    return;
  }
  const top = r.top?.item;
  const songs = r.tracks.slice(0, 4);
  const topEl = top ? (() => {
    const k = r.top.kind;
    const art = k === 'artist' ? img(top.image, 'art round') : k === 'playlist' ? mosaic(top.covers) : k === 'album' ? img(top.cover) : img(top.album.cover);
    const name = k === 'playlist' ? translateEditorial(top).name : top.name || top.title;
    const sub = k === 'artist' ? t('artist') : k === 'album' ? `${t('album')} · ${top.artist.name}` : k === 'playlist' ? t('playlist') : `${t('song')} · ${top.artist.name}`;
    const href = k === 'track' ? `#/album/${top.album.id}` : `#/${k}/${top.id}`;
    const fab = h('button', { class: 'fab', 'aria-label': t('playTitle', { title: name }) }, icon('play'));
    fab.addEventListener('click', (e) => {
      e.preventDefault();
      if (k === 'track') return app.player.playContext({ uri: 'ainos:search:' + q, title: t('searchContext', { q }), tracks: r.tracks }, 0);
      safely(async () => app.player.playContext(await loadCtx(k, top.id), 0))(e);
    });
    return h('a', { class: 'top-result', href }, art, h('div', { class: 'name' }, name), h('div', { class: 'muted' }, sub), fab);
  })() : h('div');
  results.append(h('div', { class: 'search-top section' },
    h('div', {}, h('h2', { style: { 'margin-bottom': '12px' } }, t('topResult')), topEl),
    h('div', {}, h('h2', { style: { 'margin-bottom': '12px' } }, t('songs')), songs.length ? trackList(app, songs, { uri: 'ainos:search:' + q, title: t('searchContext', { q }), tracks: songs }, { showAlbum: false }) : h('p', { class: 'muted' }, t('noSongs')))));
  if (r.artists.length) results.append(section(t('artists'), grid(r.artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: t('artist'), href: `#/artist/${a.id}`, round: true })))));
  if (r.albums.length) results.append(section(t('albums'), grid(r.albums.map((a) => card(app, { art: img(a.cover), title: a.title, sub: `${a.year} · ${a.artist.name}`, href: `#/album/${a.id}`, onPlay: async () => app.player.playContext(await loadCtx('album', a.id), 0) })))));
  if (r.playlists.length) results.append(section(t('filterPlaylists'), grid(r.playlists.map(translateEditorial).map((p) => card(app, { art: mosaic(p.covers), title: p.name, sub: t('byOwner', { name: p.owner.name }), href: `#/playlist/${p.id}` })))));
}

export async function library(el, params, app) {
  await app.refreshLibrary();
  const lib = app.library;
  const filter = params.filter || 'all';
  el.append(h('h1', { class: 'page-title' }, t('navLibrary')));
  const chip = (id, label) => h('a', { class: `chip${filter === id ? ' active' : ''}`, href: id === 'all' ? '#/library' : `#/library?filter=${id}` }, label);
  el.append(h('div', { class: 'chips' }, chip('all', t('filterAll')), chip('playlists', t('filterPlaylists')), chip('artists', t('filterArtists')), h('a', { class: 'chip', href: '#/downloads' }, t('downloaded'))));
  const items = [];
  if (filter !== 'artists') {
    items.push(card(app, { art: likedArt(), title: t('likedSongs'), sub: `${t('playlist')} · ${t('songsCount', { n: lib.liked_count })}`, href: '#/liked', onPlay: async () => app.player.playContext(await loadCtx('liked'), 0) }));
    for (const p of lib.playlists) items.push(card(app, { art: mosaic(p.covers), title: p.name, sub: `${t('playlist')} · ${t('songsCount', { n: p.track_count })}`, href: `#/playlist/${p.id}`, onPlay: async () => app.player.playContext(await loadCtx('playlist', p.id), 0) }));
  }
  if (filter !== 'playlists') for (const a of lib.artists) items.push(card(app, { art: img(a.image), title: a.name, sub: t('artist'), href: `#/artist/${a.id}`, round: true }));
  const create = h('button', { class: 'btn btn-primary btn-sm' }, icon('plus'), t('createPlaylist'));
  create.addEventListener('click', safely(() => app.createPlaylist()));
  el.append(grid(items));
  if (!lib.playlists.length && !lib.artists.length) el.append(h('p', { class: 'muted hint' }, t('emptyLibraryHint')));
  el.append(h('div', { class: 'page-actions' }, create));
}

export async function album(el, { id }, app) {
  const a = await api.get(`/api/albums/${id}`);
  const ctx = { uri: a.uri, title: a.title, tracks: a.tracks };
  el.append(pageHead({
    art: img(a.cover), kind: a.type === 'single' ? t('single') : t('album'), title: a.title, color: a.color,
    facts: facts(h('a', { href: `#/artist/${a.artist.id}` }, h('b', {}, a.artist.name)), String(a.year), `${t('songsCount', { n: a.tracks.length })}, ${fmtDuration(a.duration_ms)}`),
  }));
  el.append(actionBar(app, a.color, playFab(app, () => ctx), downloadBtn(app, a.tracks), moreBtn((e) => showMenu(e, [
    { label: t('addToQueue'), icon: 'queue', onClick: () => { a.tracks.forEach((tr) => app.player.addToQueue(tr)); toast(t('addedToQueueToast')); } },
    { label: t('goToArtist'), onClick: () => (location.hash = `#/artist/${a.artist.id}`) },
    { label: t('startRadio'), icon: 'radio', onClick: () => (location.hash = `#/radio/${a.tracks[0].id}`) },
  ]))));
  el.append(trackList(app, a.tracks, ctx, { showAlbum: false, showCover: false }));
  const dateStr = new Date(a.released_at || Date.UTC(a.year, 0, 1)).toLocaleDateString(getLang(), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  el.append(h('p', { class: 'dim small', style: { 'margin-top': '24px' } }, t('releasedDate', { date: dateStr }), h('br'), t('synthesizedNote', { year: a.year, artist: a.artist.name })));
}

export async function artist(el, { id }, app) {
  const a = await api.get(`/api/artists/${id}`);
  const ctx = { uri: a.uri, title: a.name, tracks: a.top_tracks };
  el.append(pageHead({ art: img(a.image, 'art round'), kind: t('artist'), title: a.name, color: a.color, facts: facts(t('monthlyListeners', { n: fmtNumber(a.monthly_listeners) }), translateGenre(a.genre)) }));
  const follow = h('button', { class: 'btn btn-ghost btn-sm' }, a.following ? t('following') : t('follow'));
  const showFollow = () => { follow.textContent = a.following ? t('following') : t('follow'); follow.setAttribute('aria-pressed', String(!!a.following)); };
  showFollow();
  // Optimistic: flip at once, flip back if the request fails.
  follow.addEventListener('click', safely(async () => {
    a.following = !a.following;
    showFollow();
    await (a.following ? api.put(`/api/me/following/${id}`) : api.del(`/api/me/following/${id}`));
    app.refreshLibrary();
  }, { onError: () => { a.following = !a.following; showFollow(); } }));
  const radio = a.top_tracks[0] ? h('a', { class: 'icon-btn', href: `#/radio/${a.top_tracks[0].id}`, 'aria-label': t('startRadio'), title: t('startRadio') }, icon('radio')) : null;
  el.append(actionBar(app, a.color, a.top_tracks.length ? playFab(app, () => ctx) : null, follow, radio));
  el.append(section(t('popular'), trackList(app, a.top_tracks, ctx, { extra: { header: t('plays'), cell: (tr) => fmtNumber(tr.plays) } })));
  el.append(section(t('discography'), grid(a.albums.map((al) => card(app, { art: img(al.cover), title: al.title, sub: `${al.year} · ${al.type === 'single' ? t('single') : t('album')}`, href: `#/album/${al.id}`, onPlay: async () => app.player.playContext(await loadCtx('album', al.id), 0) })))));
  el.append(section(t('about'), h('div', { class: 'box', style: { 'max-width': '720px' } }, h('p', { style: { margin: 0 } }, a.bio))));
  if (a.related.length) el.append(section(t('fansAlsoLike'), grid(a.related.map((r) => card(app, { art: img(r.image), title: r.name, sub: t('artist'), href: `#/artist/${r.id}`, round: true }))), { sub: t('fansAlsoLikeSub') }));
}

export async function playlist(el, { id }, app) {
  const raw = await api.get(`/api/playlists/${id}`);
  const p = raw.editorial ? translateEditorial(raw) : raw;
  const ctx = { uri: p.uri, title: p.name, tracks: p.tracks };
  const edit = safely(async () => {
    const res = await promptDialog({ title: t('editDetails'), submitLabel: t('save'), fields: [{ name: 'name', label: t('nameField'), value: p.name, required: true }, { name: 'description', label: t('descField'), value: p.description, type: 'textarea' }] });
    if (!res) return;
    await api.patch(`/api/playlists/${id}`, res);
    app.refreshLibrary();
    app.refresh();
  });
  const title = h('span', {}, p.name);
  if (p.is_owner) { title.style.cursor = 'pointer'; title.addEventListener('click', edit); }
  el.append(pageHead({
    art: mosaic(p.covers), kind: p.editorial ? t('ainosPlaylist') : p.is_public ? t('publicPlaylist') : t('privatePlaylist'), title, desc: p.description, color: p.color,
    facts: facts(h('b', {}, p.owner.name), `${t('songsCount', { n: p.tracks.length })}${p.tracks.length ? ', ' + fmtDuration(p.duration_ms) : ''}`),
  }));
  const menu = [
    { label: t('addToQueue'), icon: 'queue', onClick: () => { p.tracks.forEach((tr) => app.player.addToQueue(tr)); toast(t('addedToQueueToast')); } },
  ];
  if (p.is_owner) {
    menu.push({ label: t('editDetails'), onClick: edit });
    // The shared demo account cannot publish playlists (server/demo.js).
    if (!app.me.is_demo || p.is_public) menu.push({ label: p.is_public ? t('makePrivate') : t('makePublic'), onClick: safely(async () => { await api.patch(`/api/playlists/${id}`, { is_public: !p.is_public }); app.refresh(); }) });
    menu.push('sep', { label: t('deletePlaylist'), onClick: safely(async () => { await api.del(`/api/playlists/${id}`); toast(t('removedFromLibraryToast')); app.refreshLibrary(); location.hash = '#/library'; }) });
  }
  el.append(actionBar(app, p.color, p.tracks.length ? playFab(app, () => ctx) : null, p.tracks.length ? downloadBtn(app, p.tracks) : null, moreBtn((e) => showMenu(e, menu))));
  if (p.tracks.length) el.append(trackList(app, p.tracks, ctx, { playlist: p }));
  else el.append(empty(t('emptyPlaylistTitle'), t('emptyPlaylistSub')));
  if (p.is_owner) {
    el.append(h('p', { class: 'dim small', style: { 'margin-top': '10px' } }, t('dragTip')));
    const recSection = h('div');
    el.append(recSection);
    const seed = p.tracks[0]?.id || app.player.track?.id;
    // Suggestions are extra: if they fail to load, the playlist still shows.
    const radio = seed ? await api.get(`/api/radio/${seed}?lang=${encodeURIComponent(getLang())}`).catch(() => null) : null;
    if (radio) {
      const have = new Set(p.tracks.map((tr) => tr.id));
      const recs = radio.tracks.filter((tr) => !have.has(tr.id)).slice(0, 5);
      if (recs.length) {
        const list = h('div');
        for (const tr of recs) {
          const add = h('button', { class: 'btn btn-ghost btn-sm' }, t('addBtn'));
          add.addEventListener('click', safely(async () => { await api.post(`/api/playlists/${id}/tracks`, { track_ids: [tr.id] }); toast(t('addedToPlaylistToast', { name: p.name })); app.refresh(); app.refreshLibrary(); }));
          list.append(h('div', { class: 'queue-item' }, img(tr.album.cover), h('div', { class: 'meta' }, h('div', { class: 't' }, tr.title), h('div', { class: 's' }, tr.artist.name)), add));
        }
        recSection.append(section(t('recommended'), list, { sub: t('recommendedSub') }));
      }
    }
  }
}

export async function mix(el, { id }, app) {
  const lang = getLang();
  const raw = await api.get(`/api/made-for-you/${id}?lang=${encodeURIComponent(lang)}`);
  const m = translateMix(raw, lang);
  const ctx = { uri: m.uri, title: m.title, tracks: m.tracks };
  const art = mosaic(m.covers);
  art.classList.add('art-mix');
  art.dataset.label = m.title;
  el.append(pageHead({ art, kind: t('madeForYouKind'), title: m.title, desc: m.description, color: '#4a3a8c', facts: facts(h('b', {}, 'Ainos'), t('songsCount', { n: m.tracks.length }), m.period ? `snapshot ${m.period}` : null) }));
  el.append(actionBar(app, '#4a3a8c', playFab(app, () => ctx), downloadBtn(app, m.tracks)));
  el.append(trackList(app, m.tracks, ctx));
  el.append(h('p', { class: 'dim small', style: { 'margin-top': '18px', 'max-width': '70ch' } },
    t('howMadeNote'), ' ', h('a', { href: '#/internals' }, t('navInternals')), '.'));
}

export async function radio(el, { id }, app) {
  const r = await api.get(`/api/radio/${id}?lang=${encodeURIComponent(getLang())}`);
  const seedTrack = r.tracks[0];
  const title = seedTrack ? t('radioTitle', { title: seedTrack.title }) : r.title;
  const desc = seedTrack ? t('radioDesc', { title: seedTrack.title, artist: seedTrack.artist.name }) : r.description;
  const ctx = { uri: r.uri, title, tracks: r.tracks };
  el.append(pageHead({ art: img(r.covers[0]), kind: t('radioKind'), title, desc, color: '#2e4a6b', facts: facts(h('b', {}, 'Ainos'), t('songsCount', { n: r.tracks.length })) }));
  el.append(actionBar(app, '#2e4a6b', playFab(app, () => ctx)));
  el.append(trackList(app, r.tracks, ctx, { extra: { header: t('similarityCol'), cell: (tr) => (tr.similarity != null ? `${Math.round(tr.similarity * 100)}%` : t('seed')) } }));
}

export async function liked(el, _p, app) {
  const { tracks } = await api.get('/api/me/liked');
  const ctx = { uri: 'ainos:collection:liked', title: t('likedSongs'), tracks };
  el.append(pageHead({ art: likedArt(), kind: t('playlist'), title: t('likedSongs'), color: '#4b3bb8', facts: facts(h('b', {}, app.me.display_name), t('songsCount', { n: tracks.length })) }));
  el.append(actionBar(app, '#4b3bb8', tracks.length ? playFab(app, () => ctx) : null, tracks.length ? downloadBtn(app, tracks) : null));
  if (tracks.length) el.append(trackList(app, tracks, ctx, { extra: { header: t('dateAdded'), cell: (tr) => timeAgo(tr.added_at) } }));
  else el.append(empty(t('emptyLikedTitle'), t('emptyLikedSub')));
}

export async function genre(el, { id }, app) {
  const g = await api.get(`/api/genres/${encodeURIComponent(id)}`);
  const displayTitle = translateGenre(id);
  const ctx = { uri: `ainos:genre:${id}`, title: displayTitle, tracks: g.tracks };
  el.append(pageHead({ art: img(g.artists[0]?.image || '/img/icon.svg'), kind: t('genreKind'), title: displayTitle, color: g.artists[0]?.color, facts: facts(t('songsCount', { n: g.tracks.length }), t('artistsCount', { n: g.artists.length })) }));
  el.append(actionBar(app, g.artists[0]?.color, playFab(app, () => ctx)));
  el.append(trackList(app, g.tracks, ctx));
  el.append(section(t('artists'), grid(g.artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: t('artist'), href: `#/artist/${a.id}`, round: true })))));
}

export async function recent(el, _p, app) {
  const { tracks } = await api.get('/api/me/recent');
  el.append(h('h1', { class: 'page-title' }, t('recentlyPlayed')));
  if (!tracks.length) return el.append(empty(t('emptyRecentTitle'), t('emptyRecentSub'), h('a', { class: 'btn btn-primary btn-sm', href: '#/search' }, t('browseMusic'))));
  el.append(trackList(app, tracks, { uri: 'ainos:recent', title: t('recentlyPlayed'), tracks }, { extra: { header: t('playedCol'), cell: (tr) => timeAgo(tr.played_at) } }));
}

export async function downloads(el, _p, app) {
  const items = Object.values(app.player.downloads).sort((a, b) => b.savedAt - a.savedAt);
  el.append(h('h1', { class: 'page-title has-sub' }, t('downloaded')));
  const stats = await app.player.cacheStats();
  el.append(h('p', { class: 'muted' }, t('downloadsInfo', { count: items.length, bytes: fmtBytes(stats.offline.bytes), lruFiles: stats.lru.files, lruBytes: fmtBytes(stats.lru.bytes), lruLimit: fmtBytes(stats.lru.limit) })));
  if (!items.length) return el.append(empty(t('emptyDownloadsTitle'), t('emptyDownloadsSub')));
  const tracks = items.map((d) => d.track);
  el.append(trackList(app, tracks, { uri: 'ainos:downloads', title: t('downloaded'), tracks }, { extra: { header: t('sizeCol'), cell: (tr) => fmtBytes(app.player.downloads[tr.id]?.bytes) } }));
}

export async function stats(el, _p, app) {
  const s = await api.get(`/api/me/stats?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
  el.append(h('h1', { class: 'page-title has-sub' }, t('statsTitle', { name: app.me.display_name })));
  el.append(h('p', { class: 'muted' }, t('statsSub')));
  if (!s.streams && !s.short_plays) {
    el.append(empty(t('emptyStatsTitle'), t('emptyStatsSub'), h('a', { class: 'btn btn-primary btn-sm', href: '#/search' }, t('browseMusic'))));
    return;
  }
  el.append(h('div', { class: 'stat-grid section' },
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.minutes)), h('div', { class: 'l' }, t('minutesListened'))),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.streams)), h('div', { class: 'l' }, t('streamsLabel'))),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.short_plays)), h('div', { class: 'l' }, t('shortPlays'))),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, s.genres[0]?.genre ? translateGenre(s.genres[0].genre) : '—'), h('div', { class: 'l' }, t('topGenre')))));
  if (s.top_tracks.length) {
    el.append(section(t('topSongs'), trackList(app, s.top_tracks, { uri: 'ainos:stats:top', title: t('topSongs'), tracks: s.top_tracks }, { extra: { header: t('streams'), cell: (tr) => fmtNumber(tr.plays) } })));
    el.append(section(t('topArtists'), grid(s.top_artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: `${a.plays} ${t('streamsLabel')}`, href: `#/artist/${a.id}`, round: true })))));
  }
  const maxG = Math.max(1, ...s.genres.map((g) => g.n));
  el.append(section(t('genresTitle'), h('div', { class: 'box' }, s.genres.map((g) => h('div', { class: 'genre-row' }, h('span', {}, translateGenre(g.genre)), h('div', { class: 'bar' }, h('i', { style: { width: `${(g.n / maxG) * 100}%` } })), h('span', { class: 'dim' }, String(g.n)))))));
  const maxH = Math.max(1, ...s.hours);
  el.append(section(t('whenYouListen'), h('div', { class: 'box' },
    h('div', { class: 'hours' }, s.hours.map((n, hr) => h('i', { title: `${hr}:00 — ${n} streams`, style: { height: `${(n / maxH) * 100}%` } }))),
    h('div', { class: 'hours-labels' }, h('span', {}, '00:00'), h('span', {}, '06:00'), h('span', {}, '12:00'), h('span', {}, '18:00')))));
}

const kv = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

export async function internals(el, _p, app) {
  el.append(h('h1', { class: 'page-title has-sub' }, t('navInternals')));
  el.append(h('p', { class: 'muted', style: { 'max-width': '80ch' } }, 'Live view of the mechanisms Ainos borrows from Spotify. Each one is linked to the evidence for how Spotify does it. ', h('a', { href: '#/docs', class: 'link' }, 'Read the full evidence report →')));

  const live = h('div', { class: 'cards-2 section' });
  const server = h('div', { class: 'cards-2 section' });
  el.append(h('h2', { class: 'section', style: { 'font-size': '20px' } }, 'This device'), live, h('h2', { class: 'section', style: { 'font-size': '20px' } }, 'Server'), server);

  const mapping = [
    ['Catalog & metadata', 'SQLite (local) or Postgres (hosted) catalog; Web-API-shaped JSON (ids, uris, nested artist/album)', 'Spotify Web API reference', 'web-api'],
    ['Chunked streaming', 'Signed media URLs + HTTP Range (16 KB chunks); browser fetches the start first, seeks anywhere', 'Kreitz & Niemelä 2010 §II; seektable + CDN base_urls in the desktop client', 'streaming'],
    ['Prefetch next track', 'Spare audio deck loads the next track at 30 s remaining; instant hand-off', 'Paper §II-C: prefetch at 30 s / 10 s left; 390→265 ms latency', 'prefetching'],
    ['Client cache', 'Service worker: LRU streaming cache (60 MB) + pinned offline downloads', 'Paper §II-A: encrypted LRU cache, partial tracks', 'caching'],
    ['Loudness normalization', 'BS.1770 loudness measured at ingest; per-track gain to −11/−14/−19 LUFS, capped at −1 dBFS peak', 'Spotify for Artists: −14 LUFS, ITU 1770', 'loudness'],
    ['Quality tiers', 'Low 176 kbps / High 353 kbps PCM; High unlocked for all listeners', 'Lossless-grade PCM streaming', 'quality'],
    ['Event delivery', 'Batched client events → hourly NDJSON buckets (local) + database; beacon on page close', 'Event delivery (hourly buckets)', 'events'],
    ['30-second stream rule', 'play_end ≥ 30 000 ms ⇒ a stream; drives stats & recommendations', 'Streams count after 30 s', 'streams'],
    ['Recommendations', 'Implicit-feedback ALS + audio-feature similarity + language preference; Discover Weekly / Daily Mix / Radio', 'CF (ALS) + audio features + multi-language worship ranking', 'recommendations'],
    ['Connect', 'SSE push channel per device; state fan-out, remote commands, transfer', 'Dealer push channel + connect-state service', 'connect'],
    [t('planMechanism'), t('planHow'), t('planEvidence'), 'business'],
  ];
  el.append(section('Spotify → Ainos', h('div', { class: 'table-wrap box' }, h('table', { class: 'map-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Mechanism'), h('th', {}, 'How Ainos does it'), h('th', {}, 'Evidence'))),
    h('tbody', {}, mapping.map(([a, b, c, anchor]) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', {}, h('a', { href: `#/docs/${anchor}`, class: 'link' }, c)))))))));

  let srv = null;
  const loadServer = async () => { try { srv = await api.get('/api/internals'); } catch { /* ignore */ } };
  await loadServer();

  const renderLive = async () => {
    const d = app.player.debug();
    const v = app.player.view();
    const lat = d.metrics.latencies;
    const bufferedPct = d.active.duration ? Math.round(((d.active.buffered.at(-1)?.[1] || 0) / d.active.duration) * 100) : 0;
    const cache = await app.player.cacheStats();
    const status = d.active.trackId ? await app.player.isCached(app.player.deck.manifest) : null;
    clear(live).append(
      h('div', { class: 'box' }, h('h3', {}, 'Playback', v.remote ? h('span', { class: 'pill' }, 'remote') : h('span', { class: `pill ${v.isPlaying ? 'ok' : ''}` }, v.isPlaying ? 'playing' : 'idle')),
        h('p', { class: 'lede' }, 'Active deck = what you hear. Spare deck = prefetched next track.'),
        kv([
          ['Device id', h('span', { class: 'mono' }, d.deviceId)],
          ['Now playing', d.active.title], ['File', h('span', { class: 'mono' }, d.active.url || '—')],
          ['Quality', d.active.quality ? `${d.active.quality} · ${d.active.kbps} kbps · ${fmtBytes(d.active.bytes)}` : '—'],
          ['Buffered', d.active.trackId ? `${bufferedPct}%` : '—'], ['Served from', status || (d.active.trackId ? 'network (range requests)' : '—')],
          ['Next track (spare deck)', d.prefetch.trackId ? `${d.spare.title || d.prefetch.trackId} — ${d.prefetch.state}` : d.prefetch.state],
          ['Crossfade', d.settings.crossfade ? (d.crossfade ? `fading in over ${(d.crossfade.ms / 1000).toFixed(1)} s from ${d.crossfade.from}` : `${d.settings.crossfade} s, at the end of each song`) : 'off'],
          ['Audio graph', d.audioGraph],
        ])),
      h('div', { class: 'box' }, h('h3', {}, 'Latency & stutter'), h('p', { class: 'lede' }, 'Time from pressing play to first audio. Spotify reported 265 ms median with prefetch, 390 ms without.'),
        kv([
          ['Last play', ms(lat.at(-1)?.ms)], ['Median (prefetched)', ms(median(lat.filter((l) => l.prefetched).map((l) => l.ms)))],
          ['Median (cold start)', ms(median(lat.filter((l) => !l.prefetched).map((l) => l.ms)))],
          ['Prefetch hits / cold starts', `${d.metrics.prefetchHits} / ${d.metrics.coldStarts}`], ['Stutters (buffer underruns)', String(d.metrics.stutters)],
          ['Events waiting to send', String(d.pendingEvents)],
        ])),
      h('div', { class: 'box' }, h('h3', {}, 'Loudness normalization'), h('p', { class: 'lede' }, 'Measured once per track (ITU-R BS.1770); gain applied in a Web Audio node.'),
        kv([
          ['Enabled', d.settings.normalize ? `yes · ${d.settings.loudness} (${LOUDNESS_TARGETS[d.settings.loudness]} LUFS)` : 'no'],
          ['Track loudness', d.normalization ? `${d.normalization.loudness_lufs.toFixed(1)} LUFS` : '—'],
          ['Track peak', d.normalization ? `${d.normalization.peak_db.toFixed(1)} dBFS` : '—'],
          ['Gain applied', d.active.trackId ? `${d.active.gainDb >= 0 ? '+' : ''}${d.active.gainDb.toFixed(1)} dB` : '—'],
          ['Catalog range', srv ? `${srv.loudness.min.toFixed(1)} … ${srv.loudness.max.toFixed(1)} LUFS` : '—'],
        ])),
      h('div', { class: 'box' }, h('h3', {}, 'Client cache'), h('p', { class: 'lede' }, 'Fully played tracks are cached; least recently used are evicted first.'),
        kv([
          ['Streaming cache (LRU)', `${cache.lru.files} tracks · ${fmtBytes(cache.lru.bytes)} / ${fmtBytes(cache.lru.limit)}`],
          ['Offline downloads', `${cache.offline.files} tracks · ${fmtBytes(cache.offline.bytes)}`],
          ['Service worker', navigator.serviceWorker?.controller ? 'active' : 'not controlling this page (reload once)'],
        ])),
    );
  };

  const renderServer = () => {
    if (!srv) return;
    const rec = srv.recommender;
    const retrain = h('button', { class: 'btn btn-ghost btn-sm', style: { 'margin-top': '12px' } }, 'Retrain now');
    retrain.addEventListener('click', safely(async () => { const r = await api.post('/api/internals/retrain'); toast(`Retrained in ${r.ms} ms`); await loadServer(); renderServer(); }));
    clear(server).append(
      h('div', { class: 'box' }, h('h3', {}, 'Streaming'), h('p', { class: 'lede' }, 'Media is only served with a valid HMAC signature and expiry.'),
        kv([['Range requests', fmtNumber(srv.streaming.range_requests)], ['Full-file requests', fmtNumber(srv.streaming.full_requests)], ['Bytes requested', fmtBytes(srv.streaming.bytes_requested)],
          ...srv.media.map((m) => [`${m.quality} tier`, `${m.files} files · ${m.kbps} kbps · ${fmtBytes(m.bytes)}`])])),
      h('div', { class: 'box' }, h('h3', {}, 'Event pipeline'), h('p', { class: 'lede' }, 'Raw events land in the database (and hourly files when running locally); streams are derived.'),
        kv([['Events stored', fmtNumber(srv.events.total)], ...srv.events.by_type.slice(0, 6).map((t) => [t.type, fmtNumber(t.n)]),
          ['Hourly buckets', h('span', { class: 'mono' }, srv.events.hourly_files.join(', ') || '—')],
          ['Median latency (all clients)', ms(srv.events.latency_ms.median_all)]])),
      h('div', { class: 'box' }, h('h3', {}, 'Recommender'), h('p', { class: 'lede' }, 'Weighted ALS on implicit feedback (Hu, Koren & Volinsky 2008).'),
        kv([['Users × items', `${rec.users} × ${rec.items}`], ['Interactions', fmtNumber(rec.interactions)], ['Latent factors', String(rec.factors)],
          ['Iterations / λ / α', `${rec.iterations} / ${rec.lambda} / ${rec.alpha}`], ['Loss', `${Math.round(rec.loss_first)} → ${Math.round(rec.loss_last)}`],
          ['Trained', `${timeAgo(rec.trained_at)} in ${rec.ms} ms`]]), retrain),
      h('div', { class: 'box' }, h('h3', {}, 'Catalog & Connect'), h('p', { class: 'lede' }, 'Counts include 300 simulated listeners that give collaborative filtering data.'),
        kv([['Tracks / albums / artists', `${srv.catalog.tracks} / ${srv.catalog.albums} / ${srv.catalog.artists}`], ['Real / simulated users', `${srv.catalog.users} / ${srv.catalog.simulated_users}`],
          ['Streams', fmtNumber(srv.catalog.streams)], ['Connected devices', String(srv.connect.devices)], ['Requests served', fmtNumber(srv.server.requests)], ['Uptime', `${Math.round(srv.server.uptime_s / 60)} min`]])),
    );
  };

  await renderLive();
  renderServer();
  const t1 = setInterval(renderLive, 1000);
  const t2 = setInterval(async () => { await loadServer(); renderServer(); }, 5000);
  return () => { clearInterval(t1); clearInterval(t2); };
}

export async function docs(el, params) {
  const res = await fetch('/docs/HOW-SPOTIFY-WORKS.md');
  if (!res.ok) return el.append(empty('Evidence report missing', 'docs/HOW-SPOTIFY-WORKS.md was not found.'));
  const doc = renderMarkdown(await res.text());
  // in-document anchors (#section) become routes (#/docs/section)
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const href = a.getAttribute('href');
    if (!href.startsWith('#/')) a.setAttribute('href', `#/docs/${href.slice(1)}`);
  }
  el.append(doc);
  if (params.id) {
    const target = doc.querySelector(`[id="${CSS.escape(params.id)}"]`) || doc.querySelector(`[id^="${CSS.escape(params.id)}"]`);
    requestAnimationFrame(() => target?.scrollIntoView({ block: 'start' }));
  }
}

export async function settings(el, _p, app) {
  const s = app.player.settings;
  const me = app.me;
  el.append(h('h1', { class: 'page-title' }, t('settingsTitle')));
  const row = (label, desc, control) => {
    // Selects and On/Off toggles have no name of their own; buttons with text keep theirs.
    if ((control.tagName === 'SELECT' || control.hasAttribute('aria-pressed')) && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
    return h('div', { class: 'box setting-row' }, h('div', {}, h('div', { class: 'setting-title' }, label), h('div', { class: 'muted small' }, desc)), control);
  };
  const select = (value, options, onChange) => {
    const s2 = h('select', { class: 'chip', style: { border: '0' } }, options.map(([v, l, dis]) => h('option', { value: v, selected: v === value, disabled: dis }, l)));
    s2.addEventListener('change', () => onChange(s2.value));
    return s2;
  };
  const toggle = (value, onChange) => {
    const b = h('button', { class: `chip${value ? ' active' : ''}`, 'aria-pressed': String(value) }, value ? t('on') : t('off'));
    b.addEventListener('click', () => { value = !value; b.textContent = value ? t('on') : t('off'); b.classList.toggle('active', value); b.setAttribute('aria-pressed', String(value)); onChange(value); });
    return b;
  };

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, t('accountSection')));
  el.append(row(`${me.display_name} (@${me.username})`, t('planDescription'), h('span', { class: 'chip active' }, t('planBadge'))));

  const langOptions = LANGUAGES.map((l) => [l.code, `${l.native} (${l.label})`]);
  el.append(row(t('languageSettingTitle'), t('languageSettingDesc'), select(getLang(), langOptions, (v) => app.changeLanguage(v))));

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, t('audioSection')));
  el.append(row(t('streamingQuality'), t('streamingQualityDesc'), select(s.quality, [['auto', t('qualityAuto')], ['low', t('qualityLow')], ['high', t('qualityHigh')]], (v) => app.player.updateSettings({ quality: v }))));
  el.append(row(t('normalizeVolume'), t('normalizeVolumeDesc'), toggle(s.normalize, (v) => app.player.updateSettings({ normalize: v }))));
  el.append(row(t('volumeLevel'), t('volumeLevelDesc'), select(s.loudness, [['loud', t('loudnessLoud')], ['normal', t('loudnessNormal')], ['quiet', t('loudnessQuiet')]], (v) => app.player.updateSettings({ loudness: v }))));
  el.append(row(t('crossfadeTitle'), t('crossfadeDesc'), select(String(s.crossfade || 0), CROSSFADE_CHOICES.map((n) => [String(n), n ? t('secondsN', { n }) : t('crossfadeOff')]), (v) => app.player.updateSettings({ crossfade: Number(v) }))));
  el.append(row(t('cachePlayed'), t('cachePlayedDesc'), toggle(s.autocache, (v) => app.player.updateSettings({ autocache: v }))));

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, t('devicesStorageSection')));
  const nameInput = h('input', { class: 'chip', style: { border: '0', width: '220px' }, maxlength: '40', value: app.connect.identity.name, 'aria-label': t('deviceNameTitle') });
  nameInput.addEventListener('change', () => { try { localStorage.setItem('ainos.device_name', nameInput.value.trim()); } catch { /* ignore */ } toast(t('deviceNameSaved')); });
  el.append(row(t('deviceNameTitle'), t('deviceNameDesc'), nameInput));
  const stats = await app.player.cacheStats();
  const clearBtn = h('button', { class: 'btn btn-ghost btn-sm' }, t('clearCache'));
  clearBtn.addEventListener('click', safely(async () => { await app.player.clearCache(); toast(t('cacheCleared')); app.refresh(); }));
  el.append(row(t('streamingCacheTitle'), t('streamingCacheDesc', { files: stats.lru.files, bytes: fmtBytes(stats.lru.bytes), offline: stats.offline.files }), clearBtn));
  const out = h('button', { class: 'btn btn-ghost btn-sm' }, t('logoutTitle'));
  out.addEventListener('click', () => app.logout());
  el.append(row(t('logoutTitle'), t('logoutDesc'), out));
}
