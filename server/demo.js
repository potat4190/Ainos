// The shared demo account. "Try the demo" signs a visitor in as this one user
// and first puts it back to a fixed snapshot: the same likes, follows,
// playlists and listening history every time, picked from the catalog with a
// seeded RNG. Timestamps are relative to the reset, so Home always shows
// recent listening and Made For You has something to work from.
import { randomId, mulberry32, hashSeed } from './util.js';
import { inList } from './store.js';

export const DEMO_USERNAME = 'demo';
export const DEMO_SESSION_TTL_MS = 24 * 3600 * 1000;
const DISPLAY_NAME = 'Demo Listener';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export const isDemo = (user) => user?.username?.toLowerCase() === DEMO_USERNAME;

/**
 * Which tracks the snapshot uses. Favourites are the first two English artists'
 * tracks (any two artists if there are none), most of the history; "breadth"
 * is one track by each other artist, so recommendations work in each language.
 */
function pickTracks(tracks) {
  const firstTwo = (list) => [...new Set(list.map((t) => t.artist_id))].slice(0, 2);
  const favArtists = firstTwo(tracks.filter((t) => t.language === 'en'));
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
    for (const table of ['liked_tracks', 'followed_artists', 'streams', 'events', 'generated_playlists']) {
      await t.run(`DELETE FROM ${table} WHERE user_id = ?`, [uid]);
    }

    const tracks = await t.all(`SELECT t.id, t.artist_id, t.language, t.duration_ms, a.name AS artist
      FROM tracks t JOIN artists a ON a.id = t.artist_id ORDER BY a.name, t.album_id, t.track_no`);
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
