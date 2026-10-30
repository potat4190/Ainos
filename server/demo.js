// The shared demo account. "Try the demo" signs a visitor in as this one user
// and first puts it back to a fixed snapshot: the same likes, follows,
// playlists and listening history every time, picked from the catalog with a
// seeded RNG. Timestamps are relative to the reset, so Home always shows
// recent listening and Made For You has something to work from.
import { randomId, seededId, mulberry32, hashSeed } from './util.js';
import { inList } from './store.js';
import { HttpError } from './http.js';

export const DEMO_USERNAME = 'demo';
// The church demo (spec Phase 5.7) is a second shared account, confined to one
// seeded demo church. Recognized here from the start so the guard covers it.
export const CHURCH_DEMO_USERNAME = 'church-demo';
export const DEMO_USERNAMES = [DEMO_USERNAME, CHURCH_DEMO_USERNAME];
export const DEMO_SESSION_TTL_MS = 24 * 3600 * 1000;
const DISPLAY_NAME = 'Demo Listener';
// The genre of the public-domain hymn album (scripts/hymns.js).
export const HYMN_GENRE = 'Hymn';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Either shared demo account: everyone who clicks "Try the demo" is this user. */
export const isDemo = (user) => DEMO_USERNAMES.includes(user?.username?.toLowerCase());
export const isChurchDemo = (user) => user?.username?.toLowerCase() === CHURCH_DEMO_USERNAME;

/** Throws 403 for a shared demo account; for actions that would reach other people or outlive the demo. */
export function assertNotDemo(user) {
  // Fail closed: without a user (e.g. noDemo placed outside auth()) the guard
  // could not tell, so it must not let the action through.
  if (!user?.username) throw new Error('assertNotDemo: no signed-in user (wrap routes as auth(noDemo(handler)))');
  if (isDemo(user)) throw new HttpError(403, 'The shared demo can’t do this. Sign up to use it.', 'demo_not_allowed');
}

/**
 * Route wrapper for actions the shared demo accounts must not take (create a
 * church, upload, invite, live YouTube search, account changes). Goes inside
 * auth(): r.post('/api/orgs', auth(noDemo(async (ctx) => ...))).
 */
export const noDemo = (handler) => async (ctx) => {
  assertNotDemo(ctx.user);
  return handler(ctx);
};

/**
 * Which tracks the snapshot uses. Favourites are the first two English artists'
 * tracks (any two artists if there are none), most of the history; "breadth"
 * is one track by each other artist, so recommendations work in each language.
 * Tracks arrive ordered by artist id, never by name, so renaming an artist
 * doesn't change the snapshot. Hymns are never favourites (they reach the
 * snapshot through breadth), so adding the hymnal doesn't change them either.
 */
function pickTracks(tracks) {
  const firstTwo = (list) => [...new Set(list.map((t) => t.artist_id))].slice(0, 2);
  const favArtists = firstTwo(tracks.filter((t) => t.language === 'en' && t.genre !== HYMN_GENRE));
  if (!favArtists.length) favArtists.push(...firstTwo(tracks));
  const favourites = tracks.filter((t) => favArtists.includes(t.artist_id));
  const seen = new Set(favArtists);
  const breadth = tracks.filter((t) => !seen.has(t.artist_id) && seen.add(t.artist_id));
  return { favourites, breadth };
}

/** Multi-row INSERT; does nothing for no rows. */
const insertRows = (t, sql, rows) => (rows.length
  ? t.run(`${sql} VALUES ${rows.map((r) => `(${r.map(() => '?').join(', ')})`).join(', ')}`, rows.flat())
  : null);

/**
 * Put the demo account back to its snapshot (creating the account if needed)
 * and return its user id. Runs in one transaction; on Postgres the first
 * UPDATE locks the user row, so two sign-ins at once reset one after another.
 */
export async function resetDemo(store, { language = 'en', now = Date.now() } = {}) {
  return store.tx(async (t) => {
    const find = () => t.get('SELECT id FROM users WHERE lower(username) = ? AND is_simulated = 0', [DEMO_USERNAME]);
    let user = await find();
    if (!user) {
      // No password: the account is only reachable through the demo sign-in.
      // DO NOTHING: a sign-in running at the same moment may have created it.
      await t.run('INSERT INTO users (username, display_name, password_hash, language, created_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT DO NOTHING',
        [DEMO_USERNAME, DISPLAY_NAME, language, now]);
      user = await find();
    }
    const uid = Number(user.id);
    await t.run('UPDATE users SET display_name = ?, language = ? WHERE id = ?', [DISPLAY_NAME, language, uid]);

    // Wipe what visitors can change. Sessions stay: see README ("Try the demo").
    const playlists = (await t.all('SELECT id FROM playlists WHERE owner_id = ?', [uid])).map((p) => p.id);
    if (playlists.length) {
      await t.run(`DELETE FROM search_index WHERE kind = 'playlist' AND ref_id IN (${inList(playlists)})`, playlists);
      await t.run(`DELETE FROM playlists WHERE id IN (${inList(playlists)})`, playlists); // playlist_tracks cascade
    }
    for (const table of ['liked_tracks', 'followed_artists', 'streams', 'events', 'generated_playlists', 'user_settings']) {
      await t.run(`DELETE FROM ${table} WHERE user_id = ?`, [uid]);
    }

    // Sorted in JS: Postgres orders text by locale, SQLite by bytes.
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const tracks = (await t.all('SELECT id, artist_id, album_id, track_no, language, genre, duration_ms FROM tracks'))
      .sort((a, b) => cmp(a.artist_id, b.artist_id) || cmp(a.album_id, b.album_id) || a.track_no - b.track_no);
    if (!tracks.length) return uid;
    const { favourites, breadth } = pickTracks(tracks);
    const rnd = mulberry32(hashSeed('ainos-demo-snapshot-v1'));
    const pick = (list) => list[Math.floor(rnd() * list.length)];

    // About three weeks of listening, newest first, at varied times of day.
    const streams = [];
    let at = now - 2 * HOUR;
    for (let i = 0; i < 48; i++) {
      const tr = rnd() < 0.75 || !breadth.length ? pick(favourites) : pick(breadth);
      streams.push([uid, tr.id, Math.min(tr.duration_ms, 35_000 + Math.floor(rnd() * 60_000)), null, at]);
      at -= 4 * HOUR + Math.floor(rnd() * 8 * HOUR);
    }
    await insertRows(t, 'INSERT INTO streams (user_id, track_id, ms_played, context_uri, ended_at)', streams);
    // A few skips, so the stats page has short plays to show.
    const skips = [0, 1, 2].map((i) => [uid, 'demo-seed', 'play_end', pick(favourites).id, 8000 + i * 4000, 'fwdbtn', now - (i + 1) * DAY, now - (i + 1) * DAY]);
    await insertRows(t, 'INSERT INTO events (user_id, device_id, type, track_id, ms_played, reason, client_ts, server_ts)', skips);

    const liked = [...favourites.slice(0, 4), ...breadth.slice(0, 2)];
    await insertRows(t, 'INSERT INTO liked_tracks (user_id, track_id, added_at)', liked.map((tr, i) => [uid, tr.id, now - (i + 1) * DAY]));
    const followed = [...new Set([...favourites, ...breadth.slice(0, 1)].map((tr) => tr.artist_id))];
    await insertRows(t, 'INSERT INTO followed_artists (user_id, artist_id, added_at)', followed.map((a, i) => [uid, a, now - (i + 2) * DAY]));

    // Demo playlists are private, so nothing a visitor names them reaches search.
    const lists = [
      { name: 'Sunday Morning Worship', description: 'Songs for the drive to church', color: '#3d5a80', tracks: [...favourites.slice(0, 5), ...breadth.slice(0, 2)] },
      { name: 'Quiet Time Devotion', description: 'Calm songs for prayer and reading', color: '#2a7f62', tracks: [...favourites.slice(-4), ...breadth.slice(-1)] },
    ];
    for (const [n, p] of lists.entries()) {
      const id = randomId();
      const created = now - (10 - n * 3) * DAY;
      await t.run('INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        [id, uid, p.name, p.description, p.color, created, created]);
      await insertRows(t, 'INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)', p.tracks.map((tr, i) => [id, tr.id, i, created]));
    }
    return uid;
  });
}

// ---------------- the church demo (spec 5.7) ----------------
// A second shared account, confined to one seeded church. "Try the church demo"
// resets that church (in the same way the listener demo resets above) and signs in.

// The spec's documented demo password (like demo / ainos-demo), not a secret:
// the account can only ever reach the demo church.
export const CHURCH_DEMO_PASSWORD = 'ainos-church-demo';
const CHURCH_DEMO_DISPLAY_NAME = 'Church Demo';
const demoChurchId = (key) => seededId(mulberry32(hashSeed(`demo-church:${key}`)));
export const DEMO_ORG_ID = demoChurchId('org');
export const DEMO_ORG_NAME = 'Ainos Demo Church';
// The hymns' song ids, made the way scripts/generate.js makes them (HYMN_IDS.song).
export const hymnSongId = (slug) => seededId(mulberry32(hashSeed(`song:${slug}`)));

/** The next Sunday on or after `now`, in UTC, as YYYY-MM-DD. */
export function nextSundayUtc(now = Date.now()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Put the demo church back to its seed (creating the church-demo account and
 * the church if needed) and return the account's user id. One transaction: the
 * org upsert comes first, so on Postgres it locks the org row and two sign-ins
 * at once reset one after another. passwordHash is only used to create the account.
 */
export async function resetChurchDemo(store, { language = 'en', now = Date.now(), passwordHash = null } = {}) {
  return store.tx(async (t) => {
    const find = () => t.get('SELECT id FROM users WHERE lower(username) = ? AND is_simulated = 0', [CHURCH_DEMO_USERNAME]);
    let user = await find();
    if (!user) {
      if (!passwordHash) throw new Error('resetChurchDemo: passwordHash needed to create the account');
      await t.run('INSERT INTO users (username, display_name, password_hash, language, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [CHURCH_DEMO_USERNAME, CHURCH_DEMO_DISPLAY_NAME, passwordHash, language, now]);
      user = await find();
    }
    const uid = Number(user.id);
    await t.run('UPDATE users SET display_name = ?, language = ? WHERE id = ?', [CHURCH_DEMO_DISPLAY_NAME, language, uid]);

    const org = DEMO_ORG_ID;
    await t.run(`INSERT INTO orgs (id, name, default_language, bible_version_id, created_by, created_at) VALUES (?, ?, 'en', NULL, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, default_language = excluded.default_language, bible_version_id = NULL`, [org, DEMO_ORG_NAME, uid, now]);

    // Wipe every row of the demo church: setlists and items, its songs and their
    // children, its lyrics, arrangements and timings, members and audit trail.
    await t.run('DELETE FROM setlist_items WHERE setlist_id IN (SELECT id FROM setlists WHERE org_id = ?)', [org]);
    await t.run('DELETE FROM setlists WHERE org_id = ?', [org]);
    await t.run('DELETE FROM lyric_timings WHERE org_id = ? OR source_id IN (SELECT ss.id FROM song_sources ss JOIN songs s ON s.id = ss.song_id WHERE s.org_id = ?)', [org, org]);
    for (const table of ['song_sections', 'song_arrangements']) {
      await t.run(`DELETE FROM ${table} WHERE org_id = ? OR song_id IN (SELECT id FROM songs WHERE org_id = ?)`, [org, org]);
    }
    for (const table of ['song_sources', 'song_aliases', 'song_themes', 'song_scripture']) {
      await t.run(`DELETE FROM ${table} WHERE song_id IN (SELECT id FROM songs WHERE org_id = ?)`, [org]);
    }
    await t.run("DELETE FROM search_index WHERE kind = 'song' AND ref_id IN (SELECT id FROM songs WHERE org_id = ?)", [org]);
    await t.run('DELETE FROM songs WHERE org_id = ?', [org]);
    await t.run('DELETE FROM audit_log WHERE org_id = ?', [org]);
    await t.run('DELETE FROM org_members WHERE org_id = ?', [org]);
    await t.run("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)", [org, uid, now]);

    // This Sunday: a welcome, three hymns around a psalm, and a blank to end on.
    const setlistId = demoChurchId('setlist:this-sunday');
    await t.run('INSERT INTO setlists (id, org_id, name, service_date, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [setlistId, org, 'This Sunday', nextSundayUtc(now), uid, now]);
    const hymns = ['holy-holy-holy', 'amazing-grace', 'it-is-well'].map(hymnSongId);
    const present = new Set((await t.all(`SELECT id FROM songs WHERE org_id IS NULL AND id IN (${inList(hymns)})`, hymns)).map((r) => r.id));
    const items = [
      { kind: 'text', text: `Welcome to ${DEMO_ORG_NAME}\nPlease silence your phones` },
      { kind: 'song', song_id: hymns[0] },
      { kind: 'scripture', usfm_ref: 'PSA.100.4-5' },
      { kind: 'song', song_id: hymns[1] },
      { kind: 'song', song_id: hymns[2] },
      { kind: 'blank' },
    ].filter((it) => it.kind !== 'song' || present.has(it.song_id));
    await insertRows(t, 'INSERT INTO setlist_items (id, setlist_id, position, kind, song_id, arrangement_id, source_id, usfm_ref, text)',
      items.map((it, i) => [demoChurchId(`setlist:this-sunday:item:${i}`), setlistId, i, it.kind, it.song_id ?? null, null, null, it.usfm_ref ?? null, it.text ?? null]));
    return uid;
  });
}
