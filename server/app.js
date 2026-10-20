import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { Router, HttpError, sendJson, readJson, serveFile, serveRange, safeJoin } from './http.js';
import {
  hashPassword, verifyPassword, validateCredentials, createSession, destroySession, sessionCookie, clearCookie,
  userFromRequest, rateLimiter, signMediaPath, verifyMediaSignature,
} from './auth.js';
import { Catalog } from './catalog.js';
import { Recommender } from './recommend.js';
import { EventPipeline, FREE_SKIPS_PER_HOUR, STREAM_THRESHOLD_MS } from './events.js';
import { ConnectHub } from './connect.js';
import { normalizationGainDb } from './loudness.js';
import { randomId, toUri } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUALITIES = ['low', 'high'];
const PLAN_MAX_QUALITY = { free: 'low', premium: 'high' };
const TARGET_LUFS = -14;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function createApp({ dataDir = path.join(ROOT, 'data'), publicDir = path.join(ROOT, 'public'), docsDir = path.join(ROOT, 'docs'), log = console.log, authAttemptsPerMinute = 10 } = {}) {
  const dbFile = path.join(dataDir, 'ainos.db');
  if (!fs.existsSync(dbFile)) throw new Error(`No catalog at ${dbFile}. Run "npm run setup" first.`);
  const db = openDb(dbFile);
  const secret = process.env.AINOS_SECRET || fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim();
  const catalog = new Catalog(db);
  const recommender = new Recommender(db);
  const events = new EventPipeline(db, dataDir, { onStreams: (n) => recommender.noteNewStreams(n) });
  const hub = new ConnectHub();
  const loginLimiter = rateLimiter({ limit: authAttemptsPerMinute, windowMs: 60_000 });
  const metrics = { started_at: Date.now(), requests: 0, media_range_requests: 0, media_full_requests: 0, media_bytes_requested: 0 };
  recommender.train();

  const r = new Router();
  const auth = (handler) => async (ctx) => {
    const user = userFromRequest(db, ctx.req);
    if (!user) throw new HttpError(401, 'Not logged in', 'unauthorized');
    ctx.user = user;
    return handler(ctx);
  };

  // ---------------- auth ----------------
  r.post('/api/auth/signup', async ({ req, res }) => {
    const ip = req.socket.remoteAddress;
    if (!loginLimiter(ip)) throw new HttpError(429, 'Too many attempts, wait a minute');
    const { username, password, display_name } = await readJson(req);
    validateCredentials(username, password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken', 'username_taken');
    const name = (typeof display_name === 'string' && display_name.trim().slice(0, 40)) || username;
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, password_hash, plan, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, name, hashPassword(password), 'free', Date.now());
    const token = createSession(db, Number(lastInsertRowid));
    sendJson(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isSecure(req) }) });
  });

  r.post('/api/auth/login', async ({ req, res }) => {
    if (!loginLimiter(req.socket.remoteAddress)) throw new HttpError(429, 'Too many attempts, wait a minute');
    const { username, password } = await readJson(req);
    const row = typeof username === 'string' ? db.prepare('SELECT id, password_hash FROM users WHERE username = ? AND is_simulated = 0').get(username) : null;
    if (!row || typeof password !== 'string' || !verifyPassword(password, row.password_hash)) throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
    const token = createSession(db, row.id);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isSecure(req) }) });
  });

  r.post('/api/auth/logout', async ({ req, res }) => {
    const user = userFromRequest(db, req);
    if (user) destroySession(db, user.token);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  });

  r.get('/api/me', auth(({ res, user }) => {
    const skips = events.skipsLastHour(user.id);
    sendJson(res, 200, {
      id: user.id, username: user.username, display_name: user.display_name, plan: user.plan,
      limits: {
        max_quality: PLAN_MAX_QUALITY[user.plan],
        skips_per_hour: user.plan === 'free' ? FREE_SKIPS_PER_HOUR : null,
        skips_remaining: user.plan === 'free' ? Math.max(0, FREE_SKIPS_PER_HOUR - skips) : null,
      },
      stream_threshold_ms: STREAM_THRESHOLD_MS,
    });
  }));

  r.post('/api/me/plan', auth(async ({ req, res, user }) => {
    const { plan } = await readJson(req);
    if (!['free', 'premium'].includes(plan)) throw new HttpError(400, 'plan must be free or premium');
    db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, user.id);
    sendJson(res, 200, { ok: true, plan });
  }));

  // ---------------- catalog ----------------
  r.get('/api/home', auth(({ res, user }) => {
    const madeForYou = [];
    const dw = recommender.discoverWeekly(user.id);
    if (dw.ids.length) madeForYou.push(mixCard(dw));
    for (const m of recommender.dailyMixes(user.id)) if (m.ids.length) madeForYou.push(mixCard(m));
    const onRepeat = onRepeatIds(user.id);
    if (onRepeat.length >= 3) madeForYou.push(mixCard({ kind: 'on-repeat', title: 'On Repeat', description: 'The songs you can’t stop playing right now.', ids: onRepeat }));

    const following = db.prepare('SELECT artist_id FROM followed_artists WHERE user_id = ? ORDER BY added_at DESC').all(user.id).map((x) => x.artist_id);
    const related = new Map();
    for (const a of following) for (const rel of recommender.relatedArtists(a, 4)) if (!following.includes(rel.id)) related.set(rel.id, (related.get(rel.id) || 0) + rel.score);
    const suggested = [...related.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const fallbackArtists = catalog.artists().map((a) => a.id).filter((id) => !following.includes(id));

    sendJson(res, 200, {
      recent: recentTracks(user.id, 8),
      made_for_you: madeForYou,
      popular: catalog.popular(7, 10),
      new_releases: catalog.albums({ newest: true, limit: 6 }),
      editorial: catalog.editorialPlaylists(),
      suggested_artists: catalog.artistsByIds((suggested.length ? suggested : fallbackArtists).slice(0, 6)),
    });
  }));

  function mixCard(m) {
    const tracks = catalog.tracksByIds(m.ids.slice(0, 16));
    return { kind: m.kind, title: m.title, description: m.description, covers: [...new Set(tracks.map((t) => t.album.cover))].slice(0, 4), track_count: m.ids.length };
  }

  function onRepeatIds(userId) {
    return db.prepare('SELECT track_id, COUNT(*) AS n FROM streams WHERE user_id = ? AND ended_at > ? GROUP BY track_id HAVING n >= 2 ORDER BY n DESC LIMIT 20')
      .all(userId, Date.now() - 30 * 86400000).map((x) => x.track_id);
  }

  function recentTracks(userId, limit) {
    const rows = db.prepare(`SELECT track_id, MAX(ts) AS ts FROM (
        SELECT track_id, server_ts AS ts FROM events WHERE user_id = ? AND type = 'play_start' AND track_id IS NOT NULL
        UNION ALL SELECT track_id, ended_at AS ts FROM streams WHERE user_id = ?)
      GROUP BY track_id ORDER BY ts DESC LIMIT ?`).all(userId, userId, limit);
    const tracks = catalog.tracksByIds(rows.map((x) => x.track_id));
    return tracks.map((t, i) => ({ ...t, played_at: rows[i].ts }));
  }

  r.get('/api/made-for-you/:kind', auth(({ res, user, params }) => {
    let mix;
    if (params.kind === 'discover-weekly') mix = recommender.discoverWeekly(user.id);
    else if (params.kind === 'on-repeat') mix = { kind: 'on-repeat', title: 'On Repeat', description: 'The songs you can’t stop playing right now.', ids: onRepeatIds(user.id) };
    else if (/^daily-mix-\d$/.test(params.kind)) mix = recommender.dailyMixes(user.id).find((m) => m.kind === params.kind);
    if (!mix) throw new HttpError(404, 'Mix not found');
    const tracks = catalog.tracksByIds(mix.ids);
    sendJson(res, 200, { ...mixCard(mix), uri: toUri('mix', mix.kind), period: mix.period || null, tracks });
  }));

  r.get('/api/radio/:id', auth(({ res, params }) => {
    const seed = catalog.track(params.id);
    if (!seed) throw new HttpError(404, 'Track not found');
    const scored = recommender.similarTracks(params.id, 19);
    const tracks = catalog.tracksByIds([params.id, ...scored.map((s) => s.id)]);
    sendJson(res, 200, {
      kind: 'radio', uri: toUri('radio', params.id), title: `${seed.title} Radio`,
      description: `Tracks similar to ${seed.title} by ${seed.artist.name}, from listening patterns and audio features.`,
      covers: [seed.album.cover], tracks: tracks.map((t, i) => (i === 0 ? t : { ...t, similarity: Math.round(scored[i - 1].score * 100) / 100 })),
    });
  }));

  r.get('/api/search', auth(({ res, query }) => {
    const q = (query.get('q') || '').slice(0, 100);
    sendJson(res, 200, catalog.search(q));
  }));

  r.get('/api/browse/genres', auth(({ res }) => sendJson(res, 200, { genres: catalog.genres(), playlists: catalog.editorialPlaylists() })));
  r.get('/api/genres/:name', auth(({ res, params }) => sendJson(res, 200, catalog.genre(params.name))));

  r.get('/api/tracks', auth(({ res, query }) => {
    const ids = (query.get('ids') || '').split(',').filter(Boolean).slice(0, 100);
    sendJson(res, 200, { tracks: catalog.tracksByIds(ids) });
  }));
  r.get('/api/tracks/:id', auth(({ res, params }) => {
    const t = catalog.track(params.id);
    if (!t) throw new HttpError(404, 'Track not found');
    sendJson(res, 200, t);
  }));

  // Manifest: which file to fetch, signed CDN-style URLs, seek info and the
  // loudness normalization gain. The client never builds media URLs itself.
  r.get('/api/tracks/:id/manifest', auth(({ res, params, query, user }) => {
    const t = db.prepare('SELECT id, duration_ms, loudness_lufs, peak_db FROM tracks WHERE id = ?').get(params.id);
    if (!t) throw new HttpError(404, 'Track not found');
    const files = db.prepare('SELECT * FROM track_files WHERE track_id = ?').all(t.id);
    const maxQ = PLAN_MAX_QUALITY[user.plan];
    const wanted = QUALITIES.includes(query.get('quality')) ? query.get('quality') : maxQ;
    const quality = QUALITIES.indexOf(wanted) > QUALITIES.indexOf(maxQ) ? maxQ : wanted;
    const f = files.find((x) => x.quality === quality);
    const url = signMediaPath(secret, '/' + f.file);
    const bytesPerSecond = f.sample_rate * 2;
    sendJson(res, 200, {
      track_id: t.id,
      duration_ms: t.duration_ms,
      file: { quality, mime: f.mime, bitrate_kbps: f.bitrate_kbps, sample_rate: f.sample_rate, bytes: f.bytes, url, cdn_urls: [url] },
      available_qualities: files.map((x) => ({ quality: x.quality, bitrate_kbps: x.bitrate_kbps, allowed: QUALITIES.indexOf(x.quality) <= QUALITIES.indexOf(maxQ) })),
      normalization: { loudness_lufs: round(t.loudness_lufs, 2), peak_db: round(t.peak_db, 2), target_lufs: TARGET_LUFS, gain_db: round(normalizationGainDb(t.loudness_lufs, t.peak_db, TARGET_LUFS), 2) },
      seektable: { header_bytes: f.header_bytes, bytes_per_second: bytesPerSecond, chunk_bytes: 16384, chunks: Math.ceil(f.bytes / 16384) },
      expires_in: 3600,
    });
  }));

  r.get('/api/albums/:id', auth(({ res, params }) => {
    const a = catalog.album(params.id);
    if (!a) throw new HttpError(404, 'Album not found');
    sendJson(res, 200, a);
  }));

  r.get('/api/artists/:id', auth(({ res, params, user }) => {
    const a = catalog.artist(params.id);
    if (!a) throw new HttpError(404, 'Artist not found');
    const related = catalog.artistsByIds(recommender.relatedArtists(params.id, 5).map((x) => x.id));
    const following = !!db.prepare('SELECT 1 FROM followed_artists WHERE user_id = ? AND artist_id = ?').get(user.id, params.id);
    sendJson(res, 200, { ...a, related, following });
  }));

  r.get('/api/playlists/:id', auth(({ res, params, user }) => {
    const p = catalog.playlist(params.id);
    if (!p || (!p.is_public && p.owner.id !== user.id)) throw new HttpError(404, 'Playlist not found');
    sendJson(res, 200, { ...p, is_owner: p.owner.id === user.id });
  }));

  // ---------------- library ----------------
  r.get('/api/me/library', auth(({ res, user }) => {
    const liked = db.prepare('SELECT COUNT(*) AS n FROM liked_tracks WHERE user_id = ?').get(user.id).n;
    const artists = catalog.artistsByIds(db.prepare('SELECT artist_id FROM followed_artists WHERE user_id = ? ORDER BY added_at DESC').all(user.id).map((x) => x.artist_id));
    sendJson(res, 200, { liked_count: liked, playlists: catalog.userPlaylists(user.id), artists });
  }));

  r.get('/api/me/liked', auth(({ res, user }) => {
    const rows = db.prepare('SELECT track_id, added_at FROM liked_tracks WHERE user_id = ? ORDER BY added_at DESC').all(user.id);
    const tracks = catalog.tracksByIds(rows.map((x) => x.track_id));
    sendJson(res, 200, { tracks: tracks.map((t, i) => ({ ...t, added_at: rows[i].added_at })) });
  }));
  r.get('/api/me/liked/ids', auth(({ res, user }) => {
    sendJson(res, 200, { ids: db.prepare('SELECT track_id FROM liked_tracks WHERE user_id = ?').all(user.id).map((x) => x.track_id) });
  }));
  r.put('/api/me/liked/:id', auth(({ res, user, params }) => {
    if (!catalog.track(params.id)) throw new HttpError(404, 'Track not found');
    db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id, added_at) VALUES (?, ?, ?)').run(user.id, params.id, Date.now());
    sendJson(res, 200, { ok: true });
  }));
  r.delete('/api/me/liked/:id', auth(({ res, user, params }) => {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(user.id, params.id);
    sendJson(res, 200, { ok: true });
  }));

  r.put('/api/me/following/:id', auth(({ res, user, params }) => {
    if (!db.prepare('SELECT 1 FROM artists WHERE id = ?').get(params.id)) throw new HttpError(404, 'Artist not found');
    db.prepare('INSERT OR IGNORE INTO followed_artists (user_id, artist_id, added_at) VALUES (?, ?, ?)').run(user.id, params.id, Date.now());
    sendJson(res, 200, { ok: true });
  }));
  r.delete('/api/me/following/:id', auth(({ res, user, params }) => {
    db.prepare('DELETE FROM followed_artists WHERE user_id = ? AND artist_id = ?').run(user.id, params.id);
    sendJson(res, 200, { ok: true });
  }));

  r.get('/api/me/recent', auth(({ res, user }) => sendJson(res, 200, { tracks: recentTracks(user.id, 30) })));

  r.get('/api/me/stats', auth(({ res, user }) => {
    const since = Date.now() - 365 * 86400000;
    const totals = db.prepare('SELECT COUNT(*) AS streams, COALESCE(SUM(ms_played), 0) AS ms FROM streams WHERE user_id = ? AND ended_at > ?').get(user.id, since);
    const topTracks = db.prepare('SELECT track_id, COUNT(*) AS n FROM streams WHERE user_id = ? AND ended_at > ? GROUP BY track_id ORDER BY n DESC LIMIT 5').all(user.id, since);
    const topArtists = db.prepare('SELECT t.artist_id, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.user_id = ? AND s.ended_at > ? GROUP BY t.artist_id ORDER BY n DESC LIMIT 5').all(user.id, since);
    const genres = db.prepare('SELECT t.genre, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.user_id = ? AND s.ended_at > ? GROUP BY t.genre ORDER BY n DESC').all(user.id, since);
    const hours = new Array(24).fill(0);
    for (const row of db.prepare('SELECT ended_at FROM streams WHERE user_id = ? AND ended_at > ?').all(user.id, since)) hours[new Date(row.ended_at).getHours()]++;
    const skips = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'play_end' AND ms_played < ?").get(user.id, STREAM_THRESHOLD_MS).n;
    const tt = catalog.tracksByIds(topTracks.map((x) => x.track_id));
    const ta = catalog.artistsByIds(topArtists.map((x) => x.artist_id));
    sendJson(res, 200, {
      streams: totals.streams, minutes: Math.round(totals.ms / 60000), short_plays: skips,
      top_tracks: tt.map((t, i) => ({ ...t, plays: topTracks[i].n })),
      top_artists: ta.map((a, i) => ({ ...a, plays: topArtists[i].n })),
      genres, hours,
    });
  }));

  // ---------------- playlists ----------------
  const ownPlaylist = (user, id) => {
    const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Playlist not found');
    if (p.owner_id !== user.id) throw new HttpError(403, 'Not your playlist');
    return p;
  };
  const touch = (id) => db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  const cleanName = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

  r.post('/api/playlists', auth(async ({ req, res, user }) => {
    const body = await readJson(req);
    const count = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE owner_id = ?').get(user.id).n;
    const name = cleanName(body.name, 100) || `My Playlist #${count + 1}`;
    const id = randomId();
    const colors = ['#3d5a80', '#7b2d8b', '#2a7f62', '#b5543c', '#5b4bdb', '#8a6d1f'];
    const now = Date.now();
    tx(db, () => {
      db.prepare('INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, user.id, name, cleanName(body.description, 300), colors[count % colors.length], body.is_public ? 1 : 0, now, now);
      if (Array.isArray(body.track_ids)) addTracks(id, body.track_ids);
    });
    sendJson(res, 201, catalog.playlist(id));
  }));

  r.patch('/api/playlists/:id', auth(async ({ req, res, user, params }) => {
    ownPlaylist(user, params.id);
    const body = await readJson(req);
    if (body.name !== undefined) {
      const name = cleanName(body.name, 100);
      if (!name) throw new HttpError(400, 'Name cannot be empty');
      db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, params.id);
    }
    if (body.description !== undefined) db.prepare('UPDATE playlists SET description = ? WHERE id = ?').run(cleanName(body.description, 300), params.id);
    if (body.is_public !== undefined) db.prepare('UPDATE playlists SET is_public = ? WHERE id = ?').run(body.is_public ? 1 : 0, params.id);
    touch(params.id);
    syncPlaylistSearch(params.id);
    sendJson(res, 200, catalog.playlist(params.id));
  }));

  r.delete('/api/playlists/:id', auth(({ res, user, params }) => {
    ownPlaylist(user, params.id);
    tx(db, () => {
      db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run('playlist', params.id);
      db.prepare('DELETE FROM playlists WHERE id = ?').run(params.id);
    });
    sendJson(res, 200, { ok: true });
  }));

  function addTracks(playlistId, ids) {
    const valid = ids.filter((x) => typeof x === 'string').slice(0, 200).filter((id) => db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id));
    let pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM playlist_tracks WHERE playlist_id = ?').get(playlistId).p;
    const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
    for (const id of valid) ins.run(playlistId, id, pos++, Date.now());
    return valid.length;
  }

  function renumber(playlistId) {
    const rows = db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id').all(playlistId);
    const upd = db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
    rows.forEach((row, i) => upd.run(i, row.id));
  }

  function syncPlaylistSearch(id) {
    const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run('playlist', id);
    if (p && p.is_public) db.prepare('INSERT INTO search_fts (kind, ref_id, title, subtitle) VALUES (?, ?, ?, ?)').run('playlist', id, p.name, p.description);
  }

  r.post('/api/playlists/:id/tracks', auth(async ({ req, res, user, params }) => {
    ownPlaylist(user, params.id);
    const { track_ids } = await readJson(req);
    if (!Array.isArray(track_ids) || !track_ids.length) throw new HttpError(400, 'track_ids required');
    const added = tx(db, () => addTracks(params.id, track_ids));
    touch(params.id);
    sendJson(res, 200, { added });
  }));

  r.delete('/api/playlists/:id/tracks/:position', auth(({ res, user, params }) => {
    ownPlaylist(user, params.id);
    const pos = Number(params.position);
    tx(db, () => {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?').run(params.id, pos);
      renumber(params.id);
    });
    touch(params.id);
    sendJson(res, 200, { ok: true });
  }));

  r.post('/api/playlists/:id/move', auth(async ({ req, res, user, params }) => {
    ownPlaylist(user, params.id);
    const { from, to } = await readJson(req);
    const rows = db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(params.id);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= rows.length || to >= rows.length) throw new HttpError(400, 'Bad positions');
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    tx(db, () => {
      const upd = db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
      rows.forEach((row, i) => upd.run(i, row.id));
    });
    touch(params.id);
    sendJson(res, 200, catalog.playlist(params.id));
  }));

  // ---------------- events ----------------
  r.post('/api/events', auth(async ({ req, res, user }) => {
    sendJson(res, 200, events.ingest(user, await readJson(req, 512 * 1024)));
  }));

  // ---------------- connect ----------------
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
  r.get('/api/internals', auth(({ res }) => {
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM albums) AS albums, (SELECT COUNT(*) FROM artists) AS artists,
      (SELECT COUNT(*) FROM users WHERE is_simulated = 0) AS users, (SELECT COUNT(*) FROM users WHERE is_simulated = 1) AS simulated_users,
      (SELECT COUNT(*) FROM streams) AS streams, (SELECT COUNT(*) FROM playlists) AS playlists`).get();
    const media = db.prepare('SELECT quality, COUNT(*) AS files, SUM(bytes) AS bytes, MAX(bitrate_kbps) AS kbps FROM track_files GROUP BY quality').all();
    const loud = db.prepare('SELECT MIN(loudness_lufs) AS min, MAX(loudness_lufs) AS max, AVG(loudness_lufs) AS avg FROM tracks').get();
    sendJson(res, 200, {
      server: { uptime_s: Math.round((Date.now() - metrics.started_at) / 1000), node: process.version, requests: metrics.requests },
      catalog: counts, media, loudness: { ...loud, target: TARGET_LUFS },
      streaming: { range_requests: metrics.media_range_requests, full_requests: metrics.media_full_requests, bytes_requested: metrics.media_bytes_requested },
      recommender: { ...recommender.stats, trained_at: recommender.trainedAt },
      events: events.stats(), connect: hub.stats(),
    });
  }));

  r.post('/api/internals/retrain', auth(({ res }) => sendJson(res, 200, recommender.train())));

  // ---------------- request handling ----------------
  async function handle(req, res) {
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

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log('[error]', req.method, req.url, err);
      sendJson(res, status, { error: { status, message: status >= 500 ? 'Internal server error' : err.message, code: err.code } });
    });
  });
  server.keepAliveTimeout = 65_000;

  function close() {
    hub.close();
    recommender.stop();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
  }

  return { server, db, recommender, hub, events, close };
}

function isSecure(req) {
  return !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches from older browsers / curl / sendBeacon may omit it
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
