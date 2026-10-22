import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteStore, postgresStore, inList } from './store.js';
import { Router, HttpError, sendJson, readJson, serveFile, serveRange, safeJoin } from './http.js';
import {
  hashPassword, verifyPassword, validateCredentials, createSession, destroySession, purgeExpiredSessions, sessionCookie, clearCookie,
  userFromRequest, rateLimiter, signMediaPath, verifyMediaSignature,
} from './auth.js';
import { Catalog } from './catalog.js';
import { Recommender } from './recommend.js';
import { EventPipeline, STREAM_THRESHOLD_MS } from './events.js';
import { ConnectHub } from './connect.js';
import { normalizationGainDb } from './loudness.js';
import { randomId, toUri } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUALITIES = ['low', 'high'];
export const LANGUAGES = ['en', 'hi', 'ne', 'zh', 'ja', 'es'];
const TARGET_LUFS = -14;

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * Build the app. Data lives in SQLite under dataDir by default, or in Postgres
 * when databaseUrl (or the DATABASE_URL env var) is set.
 */
export async function createApp({
  dataDir = path.join(ROOT, 'data'),
  databaseUrl = process.env.DATABASE_URL,
  secret = process.env.AINOS_SECRET,
  publicDir = path.join(ROOT, 'public'),
  docsDir = path.join(ROOT, 'docs'),
  eventLogDir = databaseUrl ? null : path.join(dataDir, 'events'),
  trustProxy = !!process.env.VERCEL,
  log = console.log,
  authAttemptsPerMinute = 10,
} = {}) {
  let store;
  if (databaseUrl) {
    store = await postgresStore(databaseUrl);
  } else {
    const dbFile = path.join(dataDir, 'ainos.db');
    if (!fs.existsSync(dbFile)) throw new Error(`No catalog at ${dbFile}. Run "npm run setup" first.`);
    store = sqliteStore(dbFile);
  }
  if (!secret) secret = fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim();

  const catalog = new Catalog(store);
  const recommender = new Recommender(store);
  const events = new EventPipeline(store, eventLogDir, { onStreams: (n) => recommender.noteNewStreams(n) });
  const hub = new ConnectHub();
  const loginLimiter = rateLimiter({ limit: authAttemptsPerMinute, windowMs: 60_000 });
  const retrainLimiter = rateLimiter({ limit: 2, windowMs: 60_000 });
  const metrics = { started_at: Date.now(), requests: 0, media_range_requests: 0, media_full_requests: 0, media_bytes_requested: 0 };

  // Housekeeping: expired sessions and old mix snapshots are never read again.
  const housekeeping = () => Promise.all([purgeExpiredSessions(store), recommender.pruneSnapshots()]).catch((err) => log('[housekeeping]', err.message));
  housekeeping();
  const housekeepingTimer = setInterval(housekeeping, 6 * 3600 * 1000);
  housekeepingTimer.unref?.();

  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';

  const r = new Router();
  const auth = (handler) => async (ctx) => {
    const user = await userFromRequest(store, ctx.req);
    if (!user) throw new HttpError(401, 'Not logged in', 'unauthorized');
    ctx.user = user;
    return handler(ctx);
  };

  // ---------------- auth ----------------
  r.post('/api/auth/signup', async ({ req, res }) => {
    if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Too many attempts, wait a minute');
    const { username, password, display_name, language } = await readJson(req);
    validateCredentials(username, password);
    const taken = () => new HttpError(409, 'That username is taken', 'username_taken');
    if (await store.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?)', [username])) throw taken();
    const name = (typeof display_name === 'string' && display_name.trim().slice(0, 40)) || username;
    const lang = LANGUAGES.includes(language) ? language : 'en';
    let row;
    try {
      row = await store.get('INSERT INTO users (username, display_name, password_hash, language, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [username, name, await hashPassword(password), lang, Date.now()]);
    } catch (err) {
      if (/unique/i.test(err.message)) throw taken(); // two signups for one name at the same moment
      throw err;
    }
    const token = await createSession(store, Number(row.id));
    sendJson(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isSecure(req) }) });
  });

  r.post('/api/auth/login', async ({ req, res }) => {
    if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Too many attempts, wait a minute');
    const { username, password } = await readJson(req);
    const row = typeof username === 'string' ? await store.get('SELECT id, password_hash FROM users WHERE lower(username) = lower(?) AND is_simulated = 0', [username]) : null;
    if (!row || typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
    const token = await createSession(store, row.id);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isSecure(req) }) });
  });

  r.post('/api/auth/logout', async ({ req, res }) => {
    const user = await userFromRequest(store, req);
    if (user) await destroySession(store, user.token);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  });

  r.get('/api/me', auth(({ res, user }) => {
    sendJson(res, 200, {
      id: user.id, username: user.username, display_name: user.display_name, language: user.language,
      stream_threshold_ms: STREAM_THRESHOLD_MS,
    });
  }));

  r.post('/api/me/language', auth(async ({ req, res, user }) => {
    const { language } = await readJson(req);
    if (!LANGUAGES.includes(language)) throw new HttpError(400, `language must be one of: ${LANGUAGES.join(', ')}`);
    await store.run('UPDATE users SET language = ? WHERE id = ?', [language, user.id]);
    sendJson(res, 200, { ok: true, language });
  }));

  // ---------------- catalog ----------------
  r.get('/api/home', auth(async ({ res, user, query }) => {
    const lang = requestLang(query, user);
    const taste = await recommender.scoresForUser(user.id);
    const [dw, daily, onRepeat, followRows, allArtists] = await Promise.all([
      recommender.discoverWeekly(user.id, 12, { language: lang, taste }),
      recommender.dailyMixes(user.id, 3, { language: lang, taste }),
      onRepeatIds(user.id),
      store.all('SELECT artist_id FROM followed_artists WHERE user_id = ? ORDER BY added_at DESC', [user.id]),
      catalog.artists({ language: lang }),
    ]);
    const mixes = [];
    if (dw.ids.length) mixes.push(dw);
    for (const m of daily) if (m.ids.length) mixes.push(m);
    if (onRepeat.length >= 3) mixes.push(onRepeatMix(onRepeat));

    const following = followRows.map((x) => x.artist_id);
    const langArtists = allArtists.filter((a) => a.language === lang && !following.includes(a.id)).map((a) => a.id);
    const related = new Map();
    for (const a of following) {
      for (const rel of await recommender.relatedArtists(a, 4)) if (!following.includes(rel.id)) related.set(rel.id, (related.get(rel.id) || 0) + rel.score);
    }
    const suggested = [...new Set([...langArtists, ...[...related.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id), ...allArtists.map((a) => a.id).filter((id) => !following.includes(id))])];

    const [madeForYou, recommended, recent, popular, newReleases, editorial, suggestedArtists] = await Promise.all([
      Promise.all(mixes.map((m) => mixCard(m))),
      recommender.recommendForLanguage(user.id, lang, 12, { taste }).then((ids) => catalog.tracksByIds(ids)),
      recentTracks(user.id, 8),
      catalog.popular(7, 10, lang),
      catalog.albums({ newest: true, limit: 6, language: lang }),
      catalog.editorialPlaylists(),
      catalog.artistsByIds(suggested.slice(0, 6)),
    ]);
    sendJson(res, 200, {
      language: lang, recommended, recent, made_for_you: madeForYou, popular,
      new_releases: newReleases, editorial, suggested_artists: suggestedArtists,
    });
  }));

  /** The ?lang= the client asked for, else the user's saved language. */
  function requestLang(query, user) {
    return LANGUAGES.includes(query.get('lang')) ? query.get('lang') : user.language;
  }

  const onRepeatMix = (ids) => ({ kind: 'on-repeat', title: 'On Repeat', description: 'The songs you can’t stop playing right now.', ids });

  async function mixCard(m, tracks = null) {
    tracks = tracks || (await catalog.tracksByIds(m.ids.slice(0, 16)));
    return { kind: m.kind, title: m.title, description: m.description, covers: [...new Set(tracks.map((t) => t.album.cover))].slice(0, 4), track_count: m.ids.length };
  }

  async function onRepeatIds(userId) {
    const rows = await store.all('SELECT track_id, COUNT(*) AS n FROM streams WHERE user_id = ? AND ended_at > ? GROUP BY track_id HAVING COUNT(*) >= 2 ORDER BY n DESC, track_id LIMIT 20',
      [userId, Date.now() - 30 * 86400000]);
    return rows.map((x) => x.track_id);
  }

  async function recentTracks(userId, limit) {
    const rows = await store.all(`SELECT track_id, MAX(ts) AS ts FROM (
        SELECT track_id, server_ts AS ts FROM events WHERE user_id = ? AND type = 'play_start' AND track_id IS NOT NULL
        UNION ALL SELECT track_id, ended_at AS ts FROM streams WHERE user_id = ?) recent
      GROUP BY track_id ORDER BY ts DESC LIMIT ?`, [userId, userId, limit]);
    const playedAt = new Map(rows.map((x) => [x.track_id, x.ts]));
    return (await catalog.tracksByIds(rows.map((x) => x.track_id))).map((t) => ({ ...t, played_at: playedAt.get(t.id) }));
  }

  r.get('/api/made-for-you/:kind', auth(async ({ res, user, params, query }) => {
    const lang = requestLang(query, user);
    let mix;
    if (params.kind === 'discover-weekly') mix = await recommender.discoverWeekly(user.id, 12, { language: lang });
    else if (params.kind === 'on-repeat') mix = onRepeatMix(await onRepeatIds(user.id));
    else if (/^daily-mix-\d$/.test(params.kind)) mix = (await recommender.dailyMixes(user.id, 3, { language: lang })).find((m) => m.kind === params.kind);
    if (!mix) throw new HttpError(404, 'Mix not found');
    const tracks = await catalog.tracksByIds(mix.ids);
    sendJson(res, 200, { ...(await mixCard(mix, tracks.slice(0, 16))), uri: toUri('mix', mix.kind), period: mix.period || null, tracks });
  }));

  r.get('/api/radio/:id', auth(async ({ res, params, query, user }) => {
    const lang = requestLang(query, user);
    const seed = await catalog.track(params.id);
    if (!seed) throw new HttpError(404, 'Track not found');
    const scored = await recommender.similarTracks(params.id, 19, { language: lang });
    const tracks = await catalog.tracksByIds([params.id, ...scored.map((s) => s.id)]);
    // Pair scores by id: tracksByIds drops unknown ids, so indexes may not line up.
    const simById = new Map(scored.map((s) => [s.id, s.similarity]));
    sendJson(res, 200, {
      kind: 'radio', uri: toUri('radio', params.id), title: `${seed.title} Radio`,
      description: `Tracks similar to ${seed.title} by ${seed.artist.name}, from listening patterns and audio features.`,
      covers: [seed.album.cover], tracks: tracks.map((t) => (t.id === params.id ? t : { ...t, similarity: Math.round(simById.get(t.id) * 100) / 100 })),
    });
  }));

  r.get('/api/search', auth(async ({ res, query }) => {
    const q = (query.get('q') || '').slice(0, 100);
    sendJson(res, 200, await catalog.search(q));
  }));

  r.get('/api/browse/genres', auth(async ({ res }) => {
    const [genres, playlists] = await Promise.all([catalog.genres(), catalog.editorialPlaylists()]);
    sendJson(res, 200, { genres, playlists });
  }));
  r.get('/api/genres/:name', auth(async ({ res, params }) => sendJson(res, 200, await catalog.genre(params.name))));

  r.get('/api/tracks', auth(async ({ res, query }) => {
    const ids = (query.get('ids') || '').split(',').filter(Boolean).slice(0, 100);
    sendJson(res, 200, { tracks: await catalog.tracksByIds(ids) });
  }));
  r.get('/api/tracks/:id', auth(async ({ res, params }) => {
    const t = await catalog.track(params.id);
    if (!t) throw new HttpError(404, 'Track not found');
    sendJson(res, 200, t);
  }));

  // Manifest: which file to fetch, signed CDN-style URLs, seek info and the
  // loudness normalization gain. The client never builds media URLs itself.
  r.get('/api/tracks/:id/manifest', auth(async ({ res, params, query }) => {
    const [t, files] = await Promise.all([
      store.get('SELECT id, duration_ms, loudness_lufs, peak_db FROM tracks WHERE id = ?', [params.id]),
      store.all('SELECT * FROM track_files WHERE track_id = ? ORDER BY quality', [params.id]),
    ]);
    if (!t) throw new HttpError(404, 'Track not found');
    const quality = QUALITIES.includes(query.get('quality')) ? query.get('quality') : 'high';
    const f = files.find((x) => x.quality === quality) || files.find((x) => x.quality === 'high') || files[0];
    if (!f) throw new HttpError(404, 'No audio for this track');
    const url = signMediaPath(secret, '/' + f.file);
    const bytesPerSecond = f.sample_rate * 2;
    sendJson(res, 200, {
      track_id: t.id,
      duration_ms: t.duration_ms,
      file: { quality: f.quality, mime: f.mime, bitrate_kbps: f.bitrate_kbps, sample_rate: f.sample_rate, bytes: f.bytes, url, cdn_urls: [url] },
      available_qualities: files.map((x) => ({ quality: x.quality, bitrate_kbps: x.bitrate_kbps, allowed: true })),
      normalization: { loudness_lufs: round(t.loudness_lufs, 2), peak_db: round(t.peak_db, 2), target_lufs: TARGET_LUFS, gain_db: round(normalizationGainDb(t.loudness_lufs, t.peak_db, TARGET_LUFS), 2) },
      seektable: { header_bytes: f.header_bytes, bytes_per_second: bytesPerSecond, chunk_bytes: 16384, chunks: Math.ceil(f.bytes / 16384) },
      expires_in: 3600,
    });
  }));

  r.get('/api/albums/:id', auth(async ({ res, params }) => {
    const a = await catalog.album(params.id);
    if (!a) throw new HttpError(404, 'Album not found');
    sendJson(res, 200, a);
  }));

  r.get('/api/artists/:id', auth(async ({ res, params, user }) => {
    const a = await catalog.artist(params.id);
    if (!a) throw new HttpError(404, 'Artist not found');
    const [related, following] = await Promise.all([
      recommender.relatedArtists(params.id, 5).then((rel) => catalog.artistsByIds(rel.map((x) => x.id))),
      store.get('SELECT 1 AS x FROM followed_artists WHERE user_id = ? AND artist_id = ?', [user.id, params.id]),
    ]);
    sendJson(res, 200, { ...a, related, following: !!following });
  }));

  r.get('/api/playlists/:id', auth(async ({ res, params, user }) => {
    const p = await catalog.playlist(params.id);
    if (!p || (!p.is_public && p.owner.id !== user.id)) throw new HttpError(404, 'Playlist not found');
    sendJson(res, 200, { ...p, is_owner: p.owner.id === user.id });
  }));

  // ---------------- library ----------------
  r.get('/api/me/library', auth(async ({ res, user }) => {
    const [liked, followRows, playlists] = await Promise.all([
      store.get('SELECT COUNT(*) AS n FROM liked_tracks WHERE user_id = ?', [user.id]),
      store.all('SELECT artist_id FROM followed_artists WHERE user_id = ? ORDER BY added_at DESC', [user.id]),
      catalog.userPlaylists(user.id),
    ]);
    sendJson(res, 200, { liked_count: liked.n, playlists, artists: await catalog.artistsByIds(followRows.map((x) => x.artist_id)) });
  }));

  r.get('/api/me/liked', auth(async ({ res, user }) => {
    const rows = await store.all('SELECT track_id, added_at FROM liked_tracks WHERE user_id = ? ORDER BY added_at DESC, track_id', [user.id]);
    const addedAt = new Map(rows.map((x) => [x.track_id, x.added_at]));
    sendJson(res, 200, { tracks: (await catalog.tracksByIds(rows.map((x) => x.track_id))).map((t) => ({ ...t, added_at: addedAt.get(t.id) })) });
  }));
  r.get('/api/me/liked/ids', auth(async ({ res, user }) => {
    sendJson(res, 200, { ids: (await store.all('SELECT track_id FROM liked_tracks WHERE user_id = ?', [user.id])).map((x) => x.track_id) });
  }));
  r.put('/api/me/liked/:id', auth(async ({ res, user, params }) => {
    if (!(await store.get('SELECT 1 AS x FROM tracks WHERE id = ?', [params.id]))) throw new HttpError(404, 'Track not found');
    await store.run('INSERT INTO liked_tracks (user_id, track_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [user.id, params.id, Date.now()]);
    sendJson(res, 200, { ok: true });
  }));
  r.delete('/api/me/liked/:id', auth(async ({ res, user, params }) => {
    await store.run('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?', [user.id, params.id]);
    sendJson(res, 200, { ok: true });
  }));

  r.put('/api/me/following/:id', auth(async ({ res, user, params }) => {
    if (!(await store.get('SELECT 1 AS x FROM artists WHERE id = ?', [params.id]))) throw new HttpError(404, 'Artist not found');
    await store.run('INSERT INTO followed_artists (user_id, artist_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [user.id, params.id, Date.now()]);
    sendJson(res, 200, { ok: true });
  }));
  r.delete('/api/me/following/:id', auth(async ({ res, user, params }) => {
    await store.run('DELETE FROM followed_artists WHERE user_id = ? AND artist_id = ?', [user.id, params.id]);
    sendJson(res, 200, { ok: true });
  }));

  r.get('/api/me/recent', auth(async ({ res, user }) => sendJson(res, 200, { tracks: await recentTracks(user.id, 30) })));

  r.get('/api/me/stats', auth(async ({ res, user }) => {
    const since = Date.now() - 365 * 86400000;
    const args = [user.id, since];
    const [totals, topTracks, topArtists, genres, times, skips] = await Promise.all([
      store.get('SELECT COUNT(*) AS streams, COALESCE(SUM(ms_played), 0) AS ms FROM streams WHERE user_id = ? AND ended_at > ?', args),
      store.all('SELECT track_id, COUNT(*) AS n FROM streams WHERE user_id = ? AND ended_at > ? GROUP BY track_id ORDER BY n DESC, track_id LIMIT 5', args),
      store.all('SELECT t.artist_id, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.user_id = ? AND s.ended_at > ? GROUP BY t.artist_id ORDER BY n DESC, t.artist_id LIMIT 5', args),
      store.all('SELECT t.genre, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.user_id = ? AND s.ended_at > ? GROUP BY t.genre ORDER BY n DESC, t.genre', args),
      store.all('SELECT ended_at FROM streams WHERE user_id = ? AND ended_at > ?', args),
      store.get("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'play_end' AND ms_played < ?", [user.id, STREAM_THRESHOLD_MS]),
    ]);
    const hours = new Array(24).fill(0);
    for (const row of times) hours[new Date(row.ended_at).getHours()]++;
    const trackPlays = new Map(topTracks.map((x) => [x.track_id, x.n]));
    const artistPlays = new Map(topArtists.map((x) => [x.artist_id, x.n]));
    const [tt, ta] = await Promise.all([catalog.tracksByIds([...trackPlays.keys()]), catalog.artistsByIds([...artistPlays.keys()])]);
    sendJson(res, 200, {
      streams: totals.streams, minutes: Math.round(totals.ms / 60000), short_plays: skips.n,
      top_tracks: tt.map((t) => ({ ...t, plays: trackPlays.get(t.id) })),
      top_artists: ta.map((a) => ({ ...a, plays: artistPlays.get(a.id) })),
      genres, hours,
    });
  }));

  // ---------------- playlists ----------------
  const ownPlaylist = async (user, id) => {
    const p = await store.get('SELECT * FROM playlists WHERE id = ?', [id]);
    if (!p) throw new HttpError(404, 'Playlist not found');
    if (p.owner_id !== user.id) throw new HttpError(403, 'Not your playlist');
    return p;
  };
  const touch = (s, id) => s.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), id]);
  const cleanName = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

  r.post('/api/playlists', auth(async ({ req, res, user }) => {
    const body = await readJson(req);
    const count = (await store.get('SELECT COUNT(*) AS n FROM playlists WHERE owner_id = ?', [user.id])).n;
    const name = cleanName(body.name, 100) || `My Playlist #${count + 1}`;
    const id = randomId();
    const colors = ['#3d5a80', '#7b2d8b', '#2a7f62', '#b5543c', '#5b4bdb', '#8a6d1f'];
    const now = Date.now();
    await store.tx(async (t) => {
      await t.run('INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, user.id, name, cleanName(body.description, 300), colors[count % colors.length], body.is_public ? 1 : 0, now, now]);
      if (Array.isArray(body.track_ids)) await addTracks(t, id, body.track_ids);
      await syncPlaylistSearch(t, id); // a playlist created public must be searchable right away
    });
    sendJson(res, 201, await catalog.playlist(id));
  }));

  r.patch('/api/playlists/:id', auth(async ({ req, res, user, params }) => {
    await ownPlaylist(user, params.id);
    const body = await readJson(req);
    const sets = [], vals = [];
    if (body.name !== undefined) {
      const name = cleanName(body.name, 100);
      if (!name) throw new HttpError(400, 'Name cannot be empty');
      sets.push('name = ?'); vals.push(name);
    }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(cleanName(body.description, 300)); }
    if (body.is_public !== undefined) { sets.push('is_public = ?'); vals.push(body.is_public ? 1 : 0); }
    sets.push('updated_at = ?'); vals.push(Date.now());
    await store.tx(async (t) => {
      await t.run(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`, [...vals, params.id]);
      await syncPlaylistSearch(t, params.id);
    });
    sendJson(res, 200, await catalog.playlist(params.id));
  }));

  r.delete('/api/playlists/:id', auth(async ({ res, user, params }) => {
    await ownPlaylist(user, params.id);
    await store.tx(async (t) => {
      await t.run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', ['playlist', params.id]);
      await t.run('DELETE FROM playlists WHERE id = ?', [params.id]);
    });
    sendJson(res, 200, { ok: true });
  }));

  async function addTracks(t, playlistId, ids) {
    const wanted = ids.filter((x) => typeof x === 'string').slice(0, 200);
    if (!wanted.length) return 0;
    const exists = new Set((await t.all(`SELECT id FROM tracks WHERE id IN (${inList([...new Set(wanted)])})`, [...new Set(wanted)])).map((x) => x.id));
    const valid = wanted.filter((id) => exists.has(id));
    if (!valid.length) return 0;
    const start = (await t.get('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM playlist_tracks WHERE playlist_id = ?', [playlistId])).p;
    const now = Date.now();
    await t.run(`INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES ${valid.map(() => '(?, ?, ?, ?)').join(', ')}`,
      valid.flatMap((id, i) => [playlistId, id, start + i, now]));
    return valid.length;
  }

  /** Give rows (playlist_tracks ids, in order) positions 0..n-1 in one statement. */
  async function setPositions(t, playlistId, rowIds) {
    if (!rowIds.length) return;
    await t.run(`UPDATE playlist_tracks SET position = CASE id ${rowIds.map(() => 'WHEN ? THEN ?').join(' ')} ELSE position END WHERE playlist_id = ?`,
      [...rowIds.flatMap((id, i) => [id, i]), playlistId]);
  }

  async function syncPlaylistSearch(t, id) {
    const p = await t.get('SELECT * FROM playlists WHERE id = ?', [id]);
    await t.run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', ['playlist', id]);
    if (p && p.is_public) await t.run('INSERT INTO search_index (kind, ref_id, title, subtitle) VALUES (?, ?, ?, ?)', ['playlist', id, p.name, p.description]);
  }

  r.post('/api/playlists/:id/tracks', auth(async ({ req, res, user, params }) => {
    await ownPlaylist(user, params.id);
    const { track_ids } = await readJson(req);
    if (!Array.isArray(track_ids) || !track_ids.length) throw new HttpError(400, 'track_ids required');
    const added = await store.tx(async (t) => {
      const n = await addTracks(t, params.id, track_ids);
      await touch(t, params.id);
      return n;
    });
    sendJson(res, 200, { added });
  }));

  r.delete('/api/playlists/:id/tracks/:position', auth(async ({ res, user, params }) => {
    await ownPlaylist(user, params.id);
    const pos = Number(params.position);
    await store.tx(async (t) => {
      await t.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?', [params.id, pos]);
      const rows = await t.all('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id', [params.id]);
      await setPositions(t, params.id, rows.map((x) => x.id));
      await touch(t, params.id);
    });
    sendJson(res, 200, { ok: true });
  }));

  r.post('/api/playlists/:id/move', auth(async ({ req, res, user, params }) => {
    await ownPlaylist(user, params.id);
    const { from, to } = await readJson(req);
    await store.tx(async (t) => {
      const rows = (await t.all('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id', [params.id])).map((x) => x.id);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= rows.length || to >= rows.length) throw new HttpError(400, 'Bad positions');
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      await setPositions(t, params.id, rows);
      await touch(t, params.id);
    });
    sendJson(res, 200, await catalog.playlist(params.id));
  }));

  // ---------------- events ----------------
  r.post('/api/events', auth(async ({ req, res, user }) => {
    sendJson(res, 200, await events.ingest(user, await readJson(req, 512 * 1024)));
  }));

  // ---------------- connect ----------------
  // Connect keeps devices in this process's memory. On a serverless host each
  // instance has its own hub, so devices only see each other when their
  // requests land on the same instance.
  r.get('/api/connect/dealer', auth(({ req, res, user, query }) => {
    hub.open(user.id, req, res, { id: query.get('device_id'), name: query.get('name'), type: query.get('type') });
    return 'stream';
  }));
  r.get('/api/connect/devices', auth(({ res, user }) => sendJson(res, 200, { devices: hub.devices(user.id) })));
  r.post('/api/connect/state', auth(async ({ req, res, user }) => {
    const body = await readJson(req);
    sendJson(res, 200, hub.reportState(user.id, String(body.device_id || ''), body.state || {}));
  }));
  r.post('/api/connect/command', auth(async ({ req, res, user }) => {
    const body = await readJson(req);
    sendJson(res, 200, hub.command(user.id, String(body.device_id || ''), body.command));
  }));
  r.post('/api/connect/transfer', auth(async ({ req, res, user }) => {
    const body = await readJson(req);
    sendJson(res, 200, hub.transfer(user.id, String(body.device_id || ''), { play: body.play !== false }));
  }));

  // ---------------- internals ("under the hood") ----------------
  r.get('/api/internals', auth(async ({ res }) => {
    const [counts, media, loud, eventStats] = await Promise.all([
      store.get(`SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM albums) AS albums, (SELECT COUNT(*) FROM artists) AS artists,
        (SELECT COUNT(*) FROM users WHERE is_simulated = 0) AS users, (SELECT COUNT(*) FROM users WHERE is_simulated = 1) AS simulated_users,
        (SELECT COUNT(*) FROM streams) AS streams, (SELECT COUNT(*) FROM playlists) AS playlists`),
      store.all('SELECT quality, COUNT(*) AS files, SUM(bytes) AS bytes, MAX(bitrate_kbps) AS kbps FROM track_files GROUP BY quality ORDER BY quality'),
      store.get('SELECT MIN(loudness_lufs) AS min, MAX(loudness_lufs) AS max, AVG(loudness_lufs) AS avg FROM tracks'),
      events.stats(),
    ]);
    await recommender.ready();
    sendJson(res, 200, {
      server: { uptime_s: Math.round((Date.now() - metrics.started_at) / 1000), node: process.version, requests: metrics.requests, database: store.kind },
      catalog: counts, media, loudness: { ...loud, target: TARGET_LUFS },
      streaming: { range_requests: metrics.media_range_requests, full_requests: metrics.media_full_requests, bytes_requested: metrics.media_bytes_requested },
      recommender: { ...recommender.stats, trained_at: recommender.trainedAt },
      events: eventStats, connect: hub.stats(),
    });
  }));

  // A full retrain is CPU-heavy, so it is rate-limited across all users.
  r.post('/api/internals/retrain', auth(async ({ res }) => {
    if (!retrainLimiter('global')) throw new HttpError(429, 'The recommender was just retrained, try again in a minute');
    sendJson(res, 200, await recommender.train());
  }));

  // ---------------- request handling ----------------
  async function route(req, res) {
    metrics.requests++;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');
      const m = r.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const ctx = { req, res, params: m.params, query: url.searchParams };
      await m.handler(ctx);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    // Audio files: signed URL required; served with byte-range support.
    const media = /^\/media\/(low|high)\/([A-Za-z0-9]{22})\.wav$/.exec(pathname);
    if (media) {
      if (!verifyMediaSignature(secret, pathname, url.searchParams.get('exp'), url.searchParams.get('sig'))) throw new HttpError(403, 'Invalid or expired media signature');
      const file = path.join(dataDir, 'media', media[1], media[2] + '.wav');
      if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
      if (req.headers.range) {
        metrics.media_range_requests++;
        const m2 = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
        if (m2) metrics.media_bytes_requested += (m2[2] ? Number(m2[2]) + 1 : fs.statSync(file).size) - Number(m2[1]);
      } else {
        metrics.media_full_requests++;
        metrics.media_bytes_requested += fs.statSync(file).size;
      }
      return serveRange(req, res, file, 'audio/wav', { 'Cache-Control': 'private, max-age=3600' });
    }

    if (pathname.startsWith('/art/')) {
      const file = safeJoin(path.join(dataDir, 'art'), pathname.slice(5));
      if (file && serveFile(req, res, file, { cacheControl: 'public, max-age=86400' })) return;
      throw new HttpError(404, 'Not found');
    }

    if (pathname.startsWith('/docs/')) {
      const file = safeJoin(docsDir, pathname.slice(6));
      if (file && file.endsWith('.md') && serveFile(req, res, file)) return;
      throw new HttpError(404, 'Not found');
    }

    const file = safeJoin(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (file && serveFile(req, res, file, { cacheControl: 'no-cache', headers: pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {} })) return;
    // SPA fallback (hash routing makes this rare, but deep links still work)
    if (!path.extname(pathname)) return serveFile(req, res, path.join(publicDir, 'index.html'));
    throw new HttpError(404, 'Not found');
  }

  /** Node-style (req, res) handler: used by the HTTP server here and by serverless hosts. */
  function handler(req, res) {
    return route(req, res).catch((err) => {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log('[error]', req.method, req.url, err);
      sendJson(res, status, { error: { status, message: status >= 500 ? 'Internal server error' : err.message, code: err.code } });
    });
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;

  function close() {
    hub.close();
    recommender.stop();
    clearInterval(housekeepingTimer);
    server.closeAllConnections?.();
    return new Promise((resolve) => {
      const done = () => store.close().then(resolve, resolve);
      if (server.listening) server.close(done);
      else done();
    });
  }

  return { server, handler, store, recommender, hub, events, close };
}

function isSecure(req) {
  return !!req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches from older browsers / curl / sendBeacon may omit it
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
  } catch {
    return false;
  }
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
