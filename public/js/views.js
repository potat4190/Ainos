import { api, rememberTracks } from './api.js';
import { h, icon, clear, img, mosaic, likedArt, fmtTime, fmtDuration, fmtNumber, fmtBytes, timeAgo, toast, showMenu, promptDialog } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { LOUDNESS_TARGETS } from './player.js';

const coarse = matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------- components

/** Spotify-style track table. ctx = { uri, title, tracks } is what gets played. */
export function trackList(app, tracks, ctx, opts = {}) {
  const { showAlbum = true, showCover = true, playlist = null, extra = null } = opts;
  rememberTracks(tracks);
  const root = h('div', { class: `tracklist${showAlbum ? '' : ' no-album'}`, role: 'grid', 'aria-label': ctx.title || 'Tracks' });
  root.append(h('div', { class: 'tl-head', role: 'row' },
    h('div', { class: 'tl-num' }, '#'), h('div', {}, 'Title'), showAlbum ? h('div', { class: 'tl-album' }, extra?.header || 'Album') : null,
    h('div', { class: 'tl-end' }, h('span', { class: 'dur', title: 'Duration' }, icon('clock')))));

  let dragFrom = null;
  tracks.forEach((t, i) => {
    const play = () => app.player.playContext(ctx, i);
    const likeBtn = h('button', { class: `icon-btn${app.isLiked(t.id) ? ' on' : ''}`, 'aria-label': app.isLiked(t.id) ? 'Remove from Liked Songs' : 'Save to Liked Songs', dataset: { likeId: t.id } }, icon(app.isLiked(t.id) ? 'heart-fill' : 'heart'));
    likeBtn.addEventListener('click', (e) => { e.stopPropagation(); app.toggleLike(t); });
    const moreBtn = h('button', { class: 'icon-btn', 'aria-label': `More options for ${t.title}` }, icon('more'));
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); app.trackMenu(t, e, { playlist, position: t.position }); });

    const row = h('div', { class: 'tl-row', role: 'row', tabindex: '0', dataset: { trackId: t.id, ctx: ctx.uri || '' } },
      h('div', { class: 'tl-num' }, h('span', { class: 'n' }, String(i + 1)), h('button', { class: 'play-small', 'aria-label': `Play ${t.title}`, onclick: (e) => { e.stopPropagation(); play(); } }, icon('play'))),
      h('div', { class: 'tl-main' },
        showCover ? img(t.album.cover, 'art') : null,
        h('div', { class: 'tl-title' },
          h('span', { class: 'tl-title-text' }, t.title),
          h('div', { class: 'tl-sub' }, h('a', { href: `#/artist/${t.artist.id}`, onclick: (e) => e.stopPropagation() }, t.artist.name)))),
      showAlbum ? h('div', { class: 'tl-album' }, extra?.cell ? extra.cell(t) : h('a', { href: `#/album/${t.album.id}`, onclick: (e) => e.stopPropagation() }, t.album.title)) : null,
      h('div', { class: 'tl-end' }, likeBtn, h('span', { class: 'dur' }, fmtTime(t.duration_ms)), moreBtn));

    row.addEventListener('dblclick', play);
    if (coarse) row.addEventListener('click', play);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); app.trackMenu(t, e, { playlist, position: t.position }); });

    if (playlist?.is_owner) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); row.classList.add('dragover'); } });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        if (dragFrom === null || dragFrom === i) return;
        const from = dragFrom; dragFrom = null;
        await api.post(`/api/playlists/${playlist.id}/move`, { from, to: i });
        app.refresh();
      });
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
    const fab = h('button', { class: 'fab', 'aria-label': `Play ${title}` }, icon('play'));
    fab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPlay(); });
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

function playFab(app, getCtx, label = 'Play') {
  const b = h('button', { class: 'fab', 'aria-label': label }, icon('play'));
  b.addEventListener('click', async () => {
    const ctx = await getCtx();
    const v = app.player.view();
    if (v.contextUri && v.contextUri === ctx.uri && v.track) return app.player.toggle();
    app.player.playContext(ctx, app.player.shuffle ? -1 : 0);
  });
  const c = getCtx();
  if (c && typeof c.then !== 'function' && c.uri) b.dataset.ctxUri = c.uri;
  return b;
}

function downloadBtn(app, tracks) {
  const all = () => tracks.length && tracks.every((t) => app.player.downloads[t.id]);
  const b = h('button', { class: `icon-btn${all() ? ' liked' : ''}`, 'aria-label': all() ? 'Remove download' : 'Download for offline' }, icon(all() ? 'check' : 'download'));
  b.addEventListener('click', async () => {
    try {
      if (all()) {
        for (const t of tracks) await app.player.removeDownload(t.id);
        toast('Removed from downloads');
      } else {
        toast(`Downloading ${tracks.length} track${tracks.length === 1 ? '' : 's'}…`);
        const n = await app.player.download(tracks);
        toast(`Downloaded ${n} track${n === 1 ? '' : 's'} for offline listening`);
      }
      clear(b).append(icon(all() ? 'check' : 'download'));
      b.classList.toggle('liked', all());
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return b;
}

function moreBtn(onClick) {
  const b = h('button', { class: 'icon-btn', 'aria-label': 'More options' }, icon('more'));
  b.addEventListener('click', onClick);
  return b;
}

const facts = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [' • ', p] : [p]));

function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', {}, title), h('p', {}, text), action || null);
}

// ------------------------------------------------------------------ views

export async function home(el, _p, app) {
  const data = await api.get('/api/home');
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  el.append(h('h1', { class: 'greeting', style: { 'font-size': '30px', 'margin-top': '8px' } }, greet));

  // Shortcuts (like the 2x4 grid at the top of Spotify's home)
  const shortcuts = [];
  const sc = (art, label, href, getCtx) => {
    const fab = h('button', { class: 'fab', 'aria-label': `Play ${label}` }, icon('play'));
    fab.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); const ctx = await getCtx(); app.player.playContext(ctx, 0); });
    return h('a', { class: 'shortcut', href }, art, h('span', {}, label), fab);
  };
  shortcuts.push(sc(likedArt('art'), 'Liked Songs', '#/liked', () => loadCtx('liked')));
  for (const m of data.made_for_you.slice(0, 3)) shortcuts.push(sc(mosaic(m.covers, 'art'), m.title, `#/mix/${m.kind}`, () => loadCtx('mix', m.kind)));
  for (const p of app.library?.playlists.slice(0, 2) || []) shortcuts.push(sc(mosaic(p.covers, 'art'), p.name, `#/playlist/${p.id}`, () => loadCtx('playlist', p.id)));
  for (const p of data.editorial.slice(0, 8 - shortcuts.length)) shortcuts.push(sc(mosaic(p.covers, 'art'), p.name, `#/playlist/${p.id}`, () => loadCtx('playlist', p.id)));
  el.append(h('div', { class: 'shortcuts' }, shortcuts));

  if (data.made_for_you.length) {
    el.append(section(`Made for ${app.me.display_name}`, grid(data.made_for_you.map((m) => card(app, {
      art: (() => { const a = mosaic(m.covers, 'art'); a.classList.add('art-mix'); a.dataset.label = m.title; return a; })(),
      title: m.title, sub: m.description, href: `#/mix/${m.kind}`, onPlay: async () => app.player.playContext(await loadCtx('mix', m.kind), 0),
    }))), { sub: 'Personalized from your listening' }));
  }

  if (data.recent.length) {
    const seen = new Set();
    const items = data.recent.filter((t) => !seen.has(t.album.id) && seen.add(t.album.id)).slice(0, 6);
    el.append(section('Recently played', grid(items.map((t) => card(app, {
      art: img(t.album.cover), title: t.album.title, sub: `${t.artist.name} · ${timeAgo(t.played_at)}`, href: `#/album/${t.album.id}`,
      onPlay: async () => { const ctx = await loadCtx('album', t.album.id); app.player.playContext(ctx, Math.max(0, ctx.tracks.findIndex((x) => x.id === t.id))); },
    }))), { href: '#/recent' }));
  }

  const popularCtx = { uri: 'ainos:chart:popular', title: 'Popular right now', tracks: data.popular };
  el.append(section('Popular right now', trackList(app, data.popular.slice(0, 5), { ...popularCtx, tracks: data.popular.slice(0, 5) }, {
    extra: { header: 'Plays (7 days)', cell: (t) => fmtNumber(t.plays) },
  }), { sub: 'Most streamed across all listeners this week' }));

  el.append(section('New releases', grid(data.new_releases.map((a) => card(app, {
    art: img(a.cover), title: a.title, sub: `${a.type === 'single' ? 'Single' : 'Album'} · ${a.artist.name}`, href: `#/album/${a.id}`,
    onPlay: async () => app.player.playContext(await loadCtx('album', a.id), 0),
  })))));

  el.append(section('Ainos picks', grid(data.editorial.map((p) => card(app, {
    art: mosaic(p.covers), title: p.name, sub: p.description, href: `#/playlist/${p.id}`,
    onPlay: async () => app.player.playContext(await loadCtx('playlist', p.id), 0),
  }))), { sub: 'Built automatically from audio features' }));

  if (data.suggested_artists.length) {
    el.append(section('Artists you might like', grid(data.suggested_artists.map((a) => card(app, {
      art: img(a.image), title: a.name, sub: 'Artist', href: `#/artist/${a.id}`, round: true,
    })))));
  }
}

/** Fetch something playable and turn it into a player context. */
export async function loadCtx(kind, id) {
  switch (kind) {
    case 'album': { const a = await api.get(`/api/albums/${id}`); return { uri: a.uri, title: a.title, tracks: a.tracks }; }
    case 'playlist': { const p = await api.get(`/api/playlists/${id}`); return { uri: p.uri, title: p.name, tracks: p.tracks }; }
    case 'mix': { const m = await api.get(`/api/made-for-you/${id}`); return { uri: m.uri, title: m.title, tracks: m.tracks }; }
    case 'liked': { const l = await api.get('/api/me/liked'); return { uri: 'ainos:collection:liked', title: 'Liked Songs', tracks: l.tracks }; }
    case 'artist': { const a = await api.get(`/api/artists/${id}`); return { uri: a.uri, title: a.name, tracks: a.top_tracks }; }
    case 'radio': { const r = await api.get(`/api/radio/${id}`); return { uri: r.uri, title: r.title, tracks: r.tracks }; }
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
    results.append(section('Browse all', h('div', { class: 'genre-grid' }, genres.map((g) =>
      h('a', { class: 'genre-tile', href: `#/genre/${encodeURIComponent(g.genre)}`, style: { background: g.color } }, g.genre, h('small', {}, `${g.tracks} tracks`))))));
    results.append(section('Ainos picks', grid(playlists.map((p) => card(app, { art: mosaic(p.covers), title: p.name, sub: p.description, href: `#/playlist/${p.id}` })))));
    return;
  }
  const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
  if (!r.tracks.length && !r.artists.length && !r.albums.length && !r.playlists.length) {
    results.append(empty(`No results found for “${q}”`, 'Check the spelling, or try fewer or different keywords.'));
    return;
  }
  const top = r.top?.item;
  const songs = r.tracks.slice(0, 4);
  const topEl = top ? (() => {
    const k = r.top.kind;
    const art = k === 'artist' ? img(top.image, 'art round') : k === 'playlist' ? mosaic(top.covers) : k === 'album' ? img(top.cover) : img(top.album.cover);
    const name = top.name || top.title;
    const sub = k === 'artist' ? 'Artist' : k === 'album' ? `Album · ${top.artist.name}` : k === 'playlist' ? 'Playlist' : `Song · ${top.artist.name}`;
    const href = k === 'track' ? `#/album/${top.album.id}` : `#/${k}/${top.id}`;
    const fab = h('button', { class: 'fab', 'aria-label': `Play ${name}` }, icon('play'));
    fab.addEventListener('click', async (e) => {
      e.preventDefault();
      if (k === 'track') return app.player.playContext({ uri: 'ainos:search:' + q, title: `Search “${q}”`, tracks: r.tracks }, 0);
      app.player.playContext(await loadCtx(k, top.id), 0);
    });
    return h('a', { class: 'top-result', href }, art, h('div', { class: 'name' }, name), h('div', { class: 'muted' }, sub), fab);
  })() : h('div');
  results.append(h('div', { class: 'search-top section' },
    h('div', {}, h('h2', { style: { 'margin-bottom': '12px' } }, 'Top result'), topEl),
    h('div', {}, h('h2', { style: { 'margin-bottom': '12px' } }, 'Songs'), songs.length ? trackList(app, songs, { uri: 'ainos:search:' + q, title: `Search “${q}”`, tracks: songs }, { showAlbum: false }) : h('p', { class: 'muted' }, 'No songs'))));
  if (r.artists.length) results.append(section('Artists', grid(r.artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: 'Artist', href: `#/artist/${a.id}`, round: true })))));
  if (r.albums.length) results.append(section('Albums', grid(r.albums.map((a) => card(app, { art: img(a.cover), title: a.title, sub: `${a.year} · ${a.artist.name}`, href: `#/album/${a.id}`, onPlay: async () => app.player.playContext(await loadCtx('album', a.id), 0) })))));
  if (r.playlists.length) results.append(section('Playlists', grid(r.playlists.map((p) => card(app, { art: mosaic(p.covers), title: p.name, sub: `By ${p.owner.name}`, href: `#/playlist/${p.id}` })))));
}

export async function library(el, params, app) {
  await app.refreshLibrary();
  const lib = app.library;
  const filter = params.filter || 'all';
  el.append(h('h1', { style: { margin: '8px 0 12px', 'font-size': '30px' } }, 'Your Library'));
  const chip = (id, label) => h('a', { class: `chip${filter === id ? ' active' : ''}`, href: id === 'all' ? '#/library' : `#/library?filter=${id}` }, label);
  el.append(h('div', { class: 'chips' }, chip('all', 'All'), chip('playlists', 'Playlists'), chip('artists', 'Artists'), h('a', { class: 'chip', href: '#/downloads' }, 'Downloaded')));
  const items = [];
  if (filter !== 'artists') {
    items.push(card(app, { art: likedArt(), title: 'Liked Songs', sub: `Playlist · ${lib.liked_count} songs`, href: '#/liked', onPlay: async () => app.player.playContext(await loadCtx('liked'), 0) }));
    for (const p of lib.playlists) items.push(card(app, { art: mosaic(p.covers), title: p.name, sub: `Playlist · ${p.track_count} songs`, href: `#/playlist/${p.id}`, onPlay: async () => app.player.playContext(await loadCtx('playlist', p.id), 0) }));
  }
  if (filter !== 'playlists') for (const a of lib.artists) items.push(card(app, { art: img(a.image), title: a.name, sub: 'Artist', href: `#/artist/${a.id}`, round: true }));
  const create = h('button', { class: 'btn btn-primary btn-sm' }, icon('plus'), 'Create playlist');
  create.addEventListener('click', () => app.createPlaylist());
  el.append(grid(items), h('div', { style: { 'margin-top': '20px' } }, create));
}

export async function album(el, { id }, app) {
  const a = await api.get(`/api/albums/${id}`);
  const ctx = { uri: a.uri, title: a.title, tracks: a.tracks };
  el.append(pageHead({
    art: img(a.cover), kind: a.type === 'single' ? 'Single' : 'Album', title: a.title, color: a.color,
    facts: facts(h('a', { href: `#/artist/${a.artist.id}` }, h('b', {}, a.artist.name)), String(a.year), `${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'}, ${fmtDuration(a.duration_ms)}`),
  }));
  el.append(actionBar(app, a.color, playFab(app, () => ctx), downloadBtn(app, a.tracks), moreBtn((e) => showMenu(e, [
    { label: 'Add to queue', icon: 'queue', onClick: () => { a.tracks.forEach((t) => app.player.addToQueue(t)); toast('Added to queue'); } },
    { label: 'Go to artist', onClick: () => (location.hash = `#/artist/${a.artist.id}`) },
    { label: 'Start radio', icon: 'radio', onClick: () => (location.hash = `#/radio/${a.tracks[0].id}`) },
  ]))));
  el.append(trackList(app, a.tracks, ctx, { showAlbum: false, showCover: false }));
  el.append(h('p', { class: 'dim small', style: { 'margin-top': '24px' } }, `Released ${new Date(a.released_at || Date.UTC(a.year, 0, 1)).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}`, h('br'), `℗ ${a.year} ${a.artist.name} · Synthesized for Ainos`));
}

export async function artist(el, { id }, app) {
  const a = await api.get(`/api/artists/${id}`);
  const ctx = { uri: a.uri, title: a.name, tracks: a.top_tracks };
  el.append(pageHead({ art: img(a.image, 'art round'), kind: 'Artist', title: a.name, color: a.color, facts: facts(`${fmtNumber(a.monthly_listeners)} monthly listeners`, a.genre) }));
  const follow = h('button', { class: 'btn btn-ghost btn-sm' }, a.following ? 'Following' : 'Follow');
  follow.addEventListener('click', async () => {
    a.following = !a.following;
    await (a.following ? api.put(`/api/me/following/${id}`) : api.del(`/api/me/following/${id}`));
    follow.textContent = a.following ? 'Following' : 'Follow';
    app.refreshLibrary();
  });
  const radio = h('a', { class: 'icon-btn', href: `#/radio/${a.top_tracks[0]?.id}`, 'aria-label': 'Artist radio', title: 'Artist radio' }, icon('radio'));
  el.append(actionBar(app, a.color, playFab(app, () => ctx), follow, radio));
  el.append(section('Popular', trackList(app, a.top_tracks, ctx, { extra: { header: 'Plays', cell: (t) => fmtNumber(t.plays) } })));
  el.append(section('Discography', grid(a.albums.map((al) => card(app, { art: img(al.cover), title: al.title, sub: `${al.year} · ${al.type === 'single' ? 'Single' : 'Album'}`, href: `#/album/${al.id}`, onPlay: async () => app.player.playContext(await loadCtx('album', al.id), 0) })))));
  el.append(section('About', h('div', { class: 'box', style: { 'max-width': '720px' } }, h('p', { style: { margin: 0 } }, a.bio))));
  if (a.related.length) el.append(section('Fans also like', grid(a.related.map((r) => card(app, { art: img(r.image), title: r.name, sub: 'Artist', href: `#/artist/${r.id}`, round: true }))), { sub: 'From co-listening patterns + audio similarity' }));
}

export async function playlist(el, { id }, app) {
  const p = await api.get(`/api/playlists/${id}`);
  const ctx = { uri: p.uri, title: p.name, tracks: p.tracks };
  const edit = async () => {
    const res = await promptDialog({ title: 'Edit details', fields: [{ name: 'name', label: 'Name', value: p.name, required: true }, { name: 'description', label: 'Description', value: p.description, type: 'textarea' }] });
    if (!res) return;
    await api.patch(`/api/playlists/${id}`, res);
    app.refreshLibrary();
    app.refresh();
  };
  const title = h('span', {}, p.name);
  if (p.is_owner) { title.style.cursor = 'pointer'; title.addEventListener('click', edit); }
  el.append(pageHead({
    art: mosaic(p.covers), kind: p.editorial ? 'Ainos playlist' : p.is_public ? 'Public playlist' : 'Private playlist', title, desc: p.description, color: p.color,
    facts: facts(h('b', {}, p.owner.name), `${p.tracks.length} song${p.tracks.length === 1 ? '' : 's'}${p.tracks.length ? ', ' + fmtDuration(p.duration_ms) : ''}`),
  }));
  const menu = [
    { label: 'Add to queue', icon: 'queue', onClick: () => { p.tracks.forEach((t) => app.player.addToQueue(t)); toast('Added to queue'); } },
  ];
  if (p.is_owner) {
    menu.push({ label: 'Edit details', onClick: edit });
    menu.push({ label: p.is_public ? 'Make private' : 'Make public', onClick: async () => { await api.patch(`/api/playlists/${id}`, { is_public: !p.is_public }); app.refresh(); } });
    menu.push('sep', { label: 'Delete', onClick: async () => { await api.del(`/api/playlists/${id}`); toast('Removed from Your Library'); app.refreshLibrary(); location.hash = '#/library'; } });
  }
  el.append(actionBar(app, p.color, p.tracks.length ? playFab(app, () => ctx) : null, p.tracks.length ? downloadBtn(app, p.tracks) : null, moreBtn((e) => showMenu(e, menu))));
  if (p.tracks.length) el.append(trackList(app, p.tracks, ctx, { playlist: p }));
  else el.append(empty('This playlist is empty', 'Add songs with the ••• menu on any track, or pick from the recommendations below.'));
  if (p.is_owner) {
    el.append(h('p', { class: 'dim small', style: { 'margin-top': '10px' } }, 'Tip: drag rows to reorder.'));
    const recSection = h('div');
    el.append(recSection);
    const seed = p.tracks[0]?.id || app.player.track?.id;
    if (seed) {
      const radio = await api.get(`/api/radio/${seed}`);
      const have = new Set(p.tracks.map((t) => t.id));
      const recs = radio.tracks.filter((t) => !have.has(t.id)).slice(0, 5);
      if (recs.length) {
        const list = h('div');
        for (const t of recs) {
          const add = h('button', { class: 'btn btn-ghost btn-sm' }, 'Add');
          add.addEventListener('click', async () => { await api.post(`/api/playlists/${id}/tracks`, { track_ids: [t.id] }); toast(`Added to ${p.name}`); app.refresh(); app.refreshLibrary(); });
          list.append(h('div', { class: 'queue-item' }, img(t.album.cover), h('div', { class: 'meta' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artist.name)), add));
        }
        recSection.append(section('Recommended', list, { sub: 'Based on what’s in this playlist' }));
      }
    }
  }
}

export async function mix(el, { id }, app) {
  const m = await api.get(`/api/made-for-you/${id}`);
  const ctx = { uri: m.uri, title: m.title, tracks: m.tracks };
  const art = mosaic(m.covers);
  art.classList.add('art-mix');
  art.dataset.label = m.title;
  el.append(pageHead({ art, kind: 'Made for you', title: m.title, desc: m.description, color: '#4a3a8c', facts: facts(h('b', {}, 'Ainos'), `${m.tracks.length} songs`, m.period ? `snapshot ${m.period}` : null) }));
  el.append(actionBar(app, '#4a3a8c', playFab(app, () => ctx), downloadBtn(app, m.tracks)));
  el.append(trackList(app, m.tracks, ctx));
  el.append(h('p', { class: 'dim small', style: { 'margin-top': '18px', 'max-width': '70ch' } },
    'How this was made: weighted matrix factorization (implicit ALS) over every listener’s streams and likes, blended with audio-feature similarity, filtered to songs you haven’t played (Discover Weekly) or anchored on your top genres (Daily Mix). See ', h('a', { href: '#/internals' }, 'Under the hood'), '.'));
}

export async function radio(el, { id }, app) {
  const r = await api.get(`/api/radio/${id}`);
  const ctx = { uri: r.uri, title: r.title, tracks: r.tracks };
  el.append(pageHead({ art: img(r.covers[0]), kind: 'Radio', title: r.title, desc: r.description, color: '#2e4a6b', facts: facts(h('b', {}, 'Ainos'), `${r.tracks.length} songs`) }));
  el.append(actionBar(app, '#2e4a6b', playFab(app, () => ctx)));
  el.append(trackList(app, r.tracks, ctx, { extra: { header: 'Similarity', cell: (t) => (t.similarity != null ? `${Math.round(t.similarity * 100)}%` : 'seed') } }));
}

export async function liked(el, _p, app) {
  const { tracks } = await api.get('/api/me/liked');
  const ctx = { uri: 'ainos:collection:liked', title: 'Liked Songs', tracks };
  el.append(pageHead({ art: likedArt(), kind: 'Playlist', title: 'Liked Songs', color: '#4b3bb8', facts: facts(h('b', {}, app.me.display_name), `${tracks.length} songs`) }));
  el.append(actionBar(app, '#4b3bb8', tracks.length ? playFab(app, () => ctx) : null, tracks.length ? downloadBtn(app, tracks) : null));
  if (tracks.length) el.append(trackList(app, tracks, ctx, { extra: { header: 'Date added', cell: (t) => timeAgo(t.added_at) } }));
  else el.append(empty('Songs you like will appear here', 'Save songs by tapping the heart icon.'));
}

export async function genre(el, { id }, app) {
  const g = await api.get(`/api/genres/${encodeURIComponent(id)}`);
  const ctx = { uri: `ainos:genre:${id}`, title: id, tracks: g.tracks };
  el.append(pageHead({ art: img(g.artists[0]?.image || '/img/icon.svg'), kind: 'Genre', title: id, color: g.artists[0]?.color, facts: facts(`${g.tracks.length} songs`, `${g.artists.length} artists`) }));
  el.append(actionBar(app, g.artists[0]?.color, playFab(app, () => ctx)));
  el.append(trackList(app, g.tracks, ctx));
  el.append(section('Artists', grid(g.artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: 'Artist', href: `#/artist/${a.id}`, round: true })))));
}

export async function recent(el, _p, app) {
  const { tracks } = await api.get('/api/me/recent');
  el.append(h('h1', { style: { margin: '8px 0 16px', 'font-size': '30px' } }, 'Recently played'));
  if (!tracks.length) return el.append(empty('Nothing yet', 'Play something and it will show up here.'));
  el.append(trackList(app, tracks, { uri: 'ainos:recent', title: 'Recently played', tracks }, { extra: { header: 'Played', cell: (t) => timeAgo(t.played_at) } }));
}

export async function downloads(el, _p, app) {
  const items = Object.values(app.player.downloads).sort((a, b) => b.savedAt - a.savedAt);
  el.append(h('h1', { style: { margin: '8px 0 6px', 'font-size': '30px' } }, 'Downloaded'));
  const stats = await app.player.cacheStats();
  el.append(h('p', { class: 'muted' }, `${items.length} tracks · ${fmtBytes(stats.offline.bytes)} stored for offline. Streaming cache: ${stats.lru.files} tracks, ${fmtBytes(stats.lru.bytes)} of ${fmtBytes(stats.lru.limit)} (least-recently-used tracks are evicted first).`));
  if (!items.length) return el.append(empty('No downloads yet', 'Use the download button on an album or playlist. Downloaded music plays even when the server is unreachable.'));
  const tracks = items.map((d) => d.track);
  el.append(trackList(app, tracks, { uri: 'ainos:downloads', title: 'Downloaded', tracks }, { extra: { header: 'Size', cell: (t) => fmtBytes(app.player.downloads[t.id]?.bytes) } }));
}

export async function stats(el, _p, app) {
  const s = await api.get('/api/me/stats');
  el.append(h('h1', { style: { margin: '8px 0 4px', 'font-size': '34px' } }, `${app.me.display_name}’s year in sound`));
  el.append(h('p', { class: 'muted' }, 'Computed from your stream history (plays of 30 seconds or more). Shorter plays count as skips.'));
  el.append(h('div', { class: 'stat-grid section' },
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.minutes)), h('div', { class: 'l' }, 'minutes listened')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.streams)), h('div', { class: 'l' }, 'streams')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtNumber(s.short_plays)), h('div', { class: 'l' }, 'plays under 30 s (not counted)')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, s.genres[0]?.genre || '—'), h('div', { class: 'l' }, 'top genre'))));
  if (s.top_tracks.length) {
    el.append(section('Top songs', trackList(app, s.top_tracks, { uri: 'ainos:stats:top', title: 'Your top songs', tracks: s.top_tracks }, { extra: { header: 'Streams', cell: (t) => fmtNumber(t.plays) } })));
    el.append(section('Top artists', grid(s.top_artists.map((a) => card(app, { art: img(a.image), title: a.name, sub: `${a.plays} streams`, href: `#/artist/${a.id}`, round: true })))));
  }
  const maxG = Math.max(1, ...s.genres.map((g) => g.n));
  el.append(section('Genres', h('div', { class: 'box' }, s.genres.map((g) => h('div', { class: 'genre-row' }, h('span', {}, g.genre), h('div', { class: 'bar' }, h('i', { style: { width: `${(g.n / maxG) * 100}%` } })), h('span', { class: 'dim' }, String(g.n)))))));
  const maxH = Math.max(1, ...s.hours);
  el.append(section('When you listen', h('div', { class: 'box' },
    h('div', { class: 'hours' }, s.hours.map((n, hr) => h('i', { title: `${hr}:00 — ${n} streams`, style: { height: `${(n / maxH) * 100}%` } }))),
    h('div', { class: 'hours-labels' }, h('span', {}, '00:00'), h('span', {}, '06:00'), h('span', {}, '12:00'), h('span', {}, '18:00')))));
}

const kv = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

export async function internals(el, _p, app) {
  el.append(h('h1', { style: { margin: '8px 0 4px', 'font-size': '30px' } }, 'Under the hood'));
  el.append(h('p', { class: 'muted', style: { 'max-width': '80ch' } }, 'Live view of the mechanisms Ainos borrows from Spotify. Each one is linked to the evidence for how Spotify does it. ', h('a', { href: '#/docs', class: 'link' }, 'Read the full evidence report →')));

  const live = h('div', { class: 'cards-2 section' });
  const server = h('div', { class: 'cards-2 section' });
  el.append(h('h2', { class: 'section', style: { 'font-size': '20px' } }, 'This device'), live, h('h2', { class: 'section', style: { 'font-size': '20px' } }, 'Server'), server);

  const mapping = [
    ['Catalog & metadata', 'SQLite catalog; Web-API-shaped JSON (ids, uris, nested artist/album)', 'Spotify Web API reference', 'web-api'],
    ['Chunked streaming', 'Signed media URLs + HTTP Range (16 KB chunks); browser fetches the start first, seeks anywhere', 'Kreitz & Niemelä 2010 §II; seektable + CDN base_urls in the desktop client', 'streaming'],
    ['Prefetch next track', 'Spare audio deck loads the next track at 30 s remaining; instant hand-off', 'Paper §II-C: prefetch at 30 s / 10 s left; 390→265 ms latency', 'prefetching'],
    ['Client cache', 'Service worker: LRU streaming cache (60 MB) + pinned offline downloads', 'Paper §II-A: encrypted LRU cache, partial tracks', 'caching'],
    ['Loudness normalization', 'BS.1770 loudness measured at ingest; per-track gain to −11/−14/−19 LUFS, capped at −1 dBFS peak', 'Spotify for Artists: −14 LUFS, ITU 1770', 'loudness'],
    ['Quality tiers', 'Low 176 kbps / High 353 kbps PCM; plan caps the tier', 'Spotify bitrates 24–320 kbps, lossless FLAC for Premium (2025)', 'quality'],
    ['Event delivery', 'Batched client events → hourly NDJSON buckets + SQLite; beacon on page close', 'Spotify event delivery (Kafka → Cloud Pub/Sub, hourly buckets)', 'events'],
    ['30-second stream rule', 'play_end ≥ 30 000 ms ⇒ a stream; drives stats & recommendations', 'Spotify: streams count after 30 s', 'streams'],
    ['Recommendations', 'Implicit-feedback ALS + audio-feature similarity; Discover Weekly / Daily Mix / Radio', 'Spotify CF talks (Johnson), Dieleman 2014 (audio CNNs), Annoy/Voyager', 'recommendations'],
    ['Connect', 'SSE push channel per device; state fan-out, remote commands, transfer', 'Desktop client: dealer websocket + connect-state service', 'connect'],
    ['Freemium', 'Free: low quality + 6 skips/hour; Premium: high quality, unlimited', 'Spotify Free vs Premium tiers', 'business'],
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
    retrain.addEventListener('click', async () => { retrain.disabled = true; const r = await api.post('/api/internals/retrain'); toast(`Retrained in ${r.ms} ms`); await loadServer(); renderServer(); });
    clear(server).append(
      h('div', { class: 'box' }, h('h3', {}, 'Streaming'), h('p', { class: 'lede' }, 'Media is only served with a valid HMAC signature and expiry.'),
        kv([['Range requests', fmtNumber(srv.streaming.range_requests)], ['Full-file requests', fmtNumber(srv.streaming.full_requests)], ['Bytes requested', fmtBytes(srv.streaming.bytes_requested)],
          ...srv.media.map((m) => [`${m.quality} tier`, `${m.files} files · ${m.kbps} kbps · ${fmtBytes(m.bytes)}`])])),
      h('div', { class: 'box' }, h('h3', {}, 'Event pipeline'), h('p', { class: 'lede' }, 'Raw events land in hourly files and in SQLite; streams are derived.'),
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
  el.append(h('h1', { style: { margin: '8px 0 16px', 'font-size': '30px' } }, 'Settings'));
  const row = (label, desc, control) => h('div', { class: 'box', style: { display: 'flex', 'align-items': 'center', gap: '16px', 'justify-content': 'space-between', 'margin-bottom': '10px' } },
    h('div', {}, h('div', { style: { 'font-weight': '700' } }, label), h('div', { class: 'muted small' }, desc)), control);
  const select = (value, options, onChange) => {
    const s2 = h('select', { class: 'chip', style: { border: '0' } }, options.map(([v, l, dis]) => h('option', { value: v, selected: v === value, disabled: dis }, l)));
    s2.addEventListener('change', () => onChange(s2.value));
    return s2;
  };
  const toggle = (value, onChange) => {
    const b = h('button', { class: `chip${value ? ' active' : ''}`, 'aria-pressed': String(value) }, value ? 'On' : 'Off');
    b.addEventListener('click', () => { value = !value; b.textContent = value ? 'On' : 'Off'; b.classList.toggle('active', value); b.setAttribute('aria-pressed', String(value)); onChange(value); });
    return b;
  };

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, 'Account'));
  const planBtn = h('button', { class: 'btn btn-primary btn-sm' }, me.plan === 'premium' ? 'Switch to Free' : 'Switch to Premium');
  planBtn.addEventListener('click', async () => {
    await api.post('/api/me/plan', { plan: me.plan === 'premium' ? 'free' : 'premium' });
    await app.loadMe();
    app.player.manifests.clear();
    toast(`You’re now on ${app.me.plan === 'premium' ? 'Premium' : 'Free'} (demo — no payment involved)`);
    app.refresh();
  });
  el.append(row(`${me.display_name} (@${me.username})`, me.plan === 'premium' ? 'Premium: high quality audio, unlimited skips.' : `Free: low quality only, ${me.limits.skips_remaining} of ${me.limits.skips_per_hour} skips left this hour.`, planBtn));

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, 'Audio'));
  el.append(row('Streaming quality', 'Automatic picks Low on slow or data-saver connections. Takes effect from the next track.', select(s.quality, [['auto', 'Automatic'], ['low', 'Low (176 kbps)'], ['high', `High (353 kbps)${me.plan === 'free' ? ' — Premium' : ''}`, me.plan === 'free']], (v) => app.player.updateSettings({ quality: v }))));
  el.append(row('Normalize volume', 'Set the same loudness level for all songs.', toggle(s.normalize, (v) => app.player.updateSettings({ normalize: v }))));
  el.append(row('Volume level', 'Loud −11 LUFS, Normal −14 LUFS, Quiet −19 LUFS — the same targets Spotify uses.', select(s.loudness, [['loud', 'Loud'], ['normal', 'Normal'], ['quiet', 'Quiet']], (v) => app.player.updateSettings({ loudness: v }))));
  el.append(row('Cache played songs', 'Keep fully played songs in a 60 MB cache so replays don’t hit the network.', toggle(s.autocache, (v) => app.player.updateSettings({ autocache: v }))));

  el.append(h('h2', { class: 'section', style: { 'font-size': '18px', 'margin-bottom': '10px' } }, 'Devices & storage'));
  const nameInput = h('input', { class: 'chip', style: { border: '0', width: '220px' }, maxlength: '40', value: app.connect.identity.name, 'aria-label': 'Device name' });
  nameInput.addEventListener('change', () => { try { localStorage.setItem('ainos.device_name', nameInput.value.trim()); } catch { /* ignore */ } toast('Device name saved — reload to apply'); });
  el.append(row('This device’s name', 'Shown in the Connect device list on your other devices.', nameInput));
  const stats = await app.player.cacheStats();
  const clearBtn = h('button', { class: 'btn btn-ghost btn-sm' }, 'Clear cache');
  clearBtn.addEventListener('click', async () => { await app.player.clearCache(); toast('Cache cleared'); app.refresh(); });
  el.append(row('Streaming cache', `${stats.lru.files} tracks, ${fmtBytes(stats.lru.bytes)} used. Downloads (${stats.offline.files}) are kept.`, clearBtn));
  const out = h('button', { class: 'btn btn-ghost btn-sm' }, 'Log out');
  out.addEventListener('click', () => app.logout());
  el.append(row('Log out', 'Ends this session on this browser.', out));
}
