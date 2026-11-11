// Turns a YouTube video (server/youtube.js videoDto) into catalog rows, so the
// ordinary search finds it from then on (PLAN.md "Live YouTube search", L2):
// a global song (found by title and artist, or created), a song_sources row,
// a youtube_video_cache row and a search_index entry. Used by the live search
// fallback and by the admin import route.
//
// Only the video id and YouTube's own title, channel and thumbnail are kept:
// never audio, never lyrics. One video is one source: importing it again
// changes nothing. New rows get random ids; no existing id ever changes.
import { fold, randomId, searchText } from './util.js';
import { audit } from './audit.js';
import { songFromVideo } from './youtube.js';

const LANGS = ['en', 'hi', 'ne', 'zh', 'ja', 'es']; // LANGUAGES in app.js (not imported: app.js imports the routes that use this file)
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);

/**
 * The video id in what an admin pasted: a bare id, or a youtube.com /
 * youtu.be link (watch?v=, /shorts/, /embed/, /live/). null when it is
 * neither; nothing is ever fetched from the pasted address itself.
 */
export function parseVideoUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (VIDEO_ID.test(s)) return s;
  if (s.length > 500) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (u.hostname.toLowerCase() === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = u.searchParams.get('v');
  else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
  return typeof id === 'string' && VIDEO_ID.test(id) ? id : null;
}

/** A video's language as one of the app's six, else `fallback` ("es-419" → es). */
export function songLanguage(video, fallback = 'en') {
  const primary = String(video?.defaultLanguage || '').toLowerCase().split('-')[0];
  if (LANGS.includes(primary)) return primary;
  return LANGS.includes(fallback) ? fallback : 'en';
}

/** Whether a video can be a source at all: public, embeddable, not a live stream (the live search also wants the Music category). */
export const isImportable = (v) => !!v && VIDEO_ID.test(String(v.videoId)) && typeof v.title === 'string' && !!v.title.trim() && v.embeddable === true && v.public === true && !v.live;

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A global song with this title (or alias) and artist, compared folded; null when there is none. */
async function findSong(t, title, artist) {
  const want = fold(title);
  const wantArtist = fold(artist);
  const rows = await t.all(
    `SELECT s.id, s.title, s.artist FROM songs s WHERE s.org_id IS NULL AND (
       s.id IN (SELECT ref_id FROM search_index WHERE kind = 'song' AND folded LIKE ? ESCAPE '\\')
       OR s.id IN (SELECT song_id FROM song_aliases WHERE folded = ?)) ORDER BY s.created_at, s.id`,
    [`${likeEscape(want)} %`, want]);
  if (!rows.length) return null;
  const aliased = new Set((await t.all('SELECT song_id FROM song_aliases WHERE folded = ?', [want])).map((r) => r.song_id));
  return rows.find((r) => fold(r.artist) === wantArtist && (fold(r.title) === want || aliased.has(r.id))) || null;
}

/**
 * A video's title often names the artist too, when a label or a lyrics
 * channel uploaded it: "Way Maker - Leeland", "Leeland - Way Maker". Such a
 * title can't say which half is which, so it is only used to find a song
 * that already exists, either way round; it never names a new one.
 */
export function splitTitles(title) {
  const parts = String(title ?? '').split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return [];
  return [{ title: parts[0], artist: parts[1] }, { title: parts[1], artist: parts[0] }];
}

/** The existing song a video is a recording of: by its cleaned title and channel, else by a "title - artist" title. */
async function matchSong(t, made) {
  const direct = await findSong(t, made.title, made.artist);
  if (direct) return direct;
  for (const guess of splitTitles(made.title)) {
    const song = await findSong(t, guess.title, guess.artist);
    if (song) return song;
  }
  return null;
}

async function saveCache(t, v, now) {
  await t.run(`INSERT INTO youtube_video_cache (video_id, channel_id, title, channel_title, thumbnail_url, duration_ms, embeddable, default_language, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (video_id) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title, channel_title = excluded.channel_title,
      thumbnail_url = excluded.thumbnail_url, duration_ms = excluded.duration_ms, embeddable = 1, default_language = excluded.default_language, fetched_at = excluded.fetched_at`,
  [v.videoId, v.channelId ?? null, v.title, v.channelTitle ?? '', v.thumbnail, v.durationMs ?? null, v.defaultLanguage ?? null, now]);
}

class Raced extends Error {}

/**
 * Add one video to the global catalog.
 *
 * @param {object} store
 * @param {object} video    a videoDto from server/youtube.js (isImportable)
 * @param {object} options  language: for a new song when the video names none;
 *   userId: who caused it (audit); via: 'search' | 'admin';
 *   songId: (admin) attach to this global song instead of matching by title
 * @returns {{ status: 'added'|'exists'|'moved'|'restored'|'hidden'|'private', songId, sourceId, createdSong }}
 *   exists: already a source (its cached data is refreshed); hidden: an admin
 *   took it out, so a search leaves it out; private: the video belongs to a
 *   church's song; moved / restored: only for via 'admin'.
 */
export async function importVideo(store, video, { language = 'en', userId = null, via = 'search', songId = null, now = Date.now() } = {}) {
  if (!isImportable(video)) throw new Error('importVideo: not an importable video');
  const admin = via === 'admin';
  const run = () => store.tx(async (t) => {
    const existing = await t.get(`SELECT ss.id, ss.song_id, ss.available, s.org_id FROM song_sources ss JOIN songs s ON s.id = ss.song_id
      WHERE ss.youtube_video_id = ?`, [video.videoId]);
    let target = null;
    if (songId !== null) {
      target = await t.get('SELECT id, title, artist FROM songs WHERE id = ? AND org_id IS NULL', [songId]);
      if (!target) throw new ImportError('Song not found', 'not_found');
    }

    if (existing) {
      const out = { status: 'exists', songId: existing.song_id, sourceId: existing.id, createdSong: false };
      if (existing.org_id !== null) return { ...out, status: 'private' };
      if (Number(existing.available) !== 1 && !admin) return { ...out, status: 'hidden' };
      await saveCache(t, video, now);
      const moved = target && target.id !== existing.song_id;
      const restored = Number(existing.available) !== 1;
      if (!moved && !restored) return out;
      await t.run('UPDATE song_sources SET song_id = ?, available = 1, last_checked_at = ? WHERE id = ?', [moved ? target.id : existing.song_id, now, existing.id]);
      await audit(t, { userId, action: moved ? 'youtube.move' : 'youtube.restore', targetType: 'source', targetId: existing.id,
        details: { video_id: video.videoId, song_id: moved ? target.id : existing.song_id, ...(moved ? { from_song_id: existing.song_id } : {}) }, now });
      return { ...out, status: moved ? 'moved' : 'restored', songId: moved ? target.id : existing.song_id };
    }

    const made = songFromVideo(video);
    let song = target || await matchSong(t, made);
    const createdSong = !song;
    if (!song) {
      song = { id: randomId(), title: made.title, artist: made.artist || video.channelTitle || 'YouTube' };
      await t.run('INSERT INTO songs (id, title, artist, language, ccli_number, public_domain, org_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?)',
        [song.id, song.title, song.artist, songLanguage(video, language), userId, now, now]);
      const subtitle = `${song.artist} ${video.channelTitle ?? ''}`.trim();
      await t.run('INSERT INTO search_index (kind, ref_id, title, subtitle, folded) VALUES (?, ?, ?, ?, ?)', ['song', song.id, song.title, subtitle, searchText(song.title, subtitle)]);
    }
    const sourceId = randomId();
    const { changes } = await t.run(`INSERT INTO song_sources (id, song_id, source, track_id, youtube_video_id, kind, available, last_checked_at)
      VALUES (?, ?, 'youtube', NULL, ?, ?, 1, ?) ON CONFLICT (youtube_video_id) DO NOTHING`, [sourceId, song.id, video.videoId, made.kind, now]);
    // Someone else imported this video a moment ago: undo this attempt (and any song it made) and answer from theirs.
    if (!changes) throw new Raced();
    await saveCache(t, video, now);
    await audit(t, { userId, action: 'youtube.import', targetType: 'source', targetId: sourceId,
      details: { video_id: video.videoId, song_id: song.id, created_song: createdSong, kind: made.kind, via }, now });
    return { status: 'added', songId: song.id, sourceId, createdSong };
  });
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof Raced)) throw err;
    return run(); // the other import has committed: this time it is "exists"
  }
}

/** A refusal the admin route turns into a 4xx (`code` as in HttpError). */
export class ImportError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Take a video out of the catalog (a wrong automatic match, or not a worship
 * song): its source stays, unavailable, so no later search adds it back; its
 * cached YouTube data is deleted. Returns false when the video is not a
 * global source.
 */
export async function hideVideo(store, videoId, { userId = null, now = Date.now() } = {}) {
  return store.tx(async (t) => {
    const row = await t.get(`SELECT ss.id, ss.song_id, ss.available FROM song_sources ss JOIN songs s ON s.id = ss.song_id
      WHERE ss.youtube_video_id = ? AND s.org_id IS NULL`, [videoId]);
    if (!row) return false;
    await t.run('UPDATE song_sources SET available = 0, last_checked_at = ? WHERE id = ?', [now, row.id]);
    await t.run('DELETE FROM youtube_video_cache WHERE video_id = ?', [videoId]);
    if (Number(row.available) === 1) await audit(t, { userId, action: 'youtube.hide', targetType: 'source', targetId: row.id, details: { video_id: videoId, song_id: row.song_id }, now });
    return true;
  });
}
