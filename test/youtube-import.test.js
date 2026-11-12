// Adding YouTube videos to the catalog (PLAN.md "Live YouTube search", L2):
// the importer (song found or made, one source per video, cache row, search
// entry, audit) and the admin routes that import a pasted link and hide a
// wrong video. YouTube is a stub here: no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, client, login, signup } from './helpers.js';
import { importVideo, hideVideo, parseVideoUrl, songLanguage, isImportable, splitTitles } from '../server/youtube-import.js';
import { MUSIC_CATEGORY, thumbnailUrl } from '../server/youtube.js';
import { YOUTUBE_IDS } from '../scripts/generate.js';
import { YOUTUBE_VIDEOS } from '../scripts/youtube-videos.js';
import { fold } from '../server/util.js';

const CARRY = YOUTUBE_VIDEOS.find((v) => v.videoId === 'eov9K7ALYKk');
const vid = (n) => `imp${String(n).padStart(8, '0')}`; // 11 characters

/** A video as server/youtube.js hands it over. */
const video = (videoId, title, channelTitle, over = {}) => ({
  videoId, title, channelId: 'UCx', channelTitle, thumbnail: thumbnailUrl(videoId), durationMs: 240_000,
  embeddable: true, public: true, live: false, categoryId: MUSIC_CATEGORY, defaultLanguage: null, ...over,
});

let srv, store, admin, adminId;
// The stub YouTube the routes see: `known` videos by id, or a failure reason.
const yt = { known: new Map(), fail: null, calls: [] };
const youtube = {
  hasKey: true,
  async searchVideos() { throw new Error('the importer never searches'); },
  async videoDetails(ids) {
    yt.calls.push(ids);
    if (yt.fail) return { ok: false, reason: yt.fail, videos: [] };
    return { ok: true, videos: ids.map((id) => yt.known.get(id)).filter(Boolean) };
  },
};

before(async () => {
  srv = await startTestServer({
    youtube,
    prepare: (dataDir) => {
      const db = new DatabaseSync(path.join(dataDir, 'ainos.db'), { readOnly: true });
      try { adminId = db.prepare('SELECT MAX(id) AS n FROM users').get().n + 1; } finally { db.close(); }
      return { adminUserIds: String(adminId) };
    },
  });
  store = srv.app.store;
  admin = await signup(srv.base, 'yt-admin');
  assert.equal((await admin.get('/api/me')).json.id, adminId);
});
after(() => srv.close());

const count = async (sql, params = []) => Number((await store.get(sql, params)).n);
const songsFor = async (c, q) => (await c.get(`/api/search?q=${encodeURIComponent(q)}`)).json.songs.items;

test('parseVideoUrl: ids and YouTube links only', () => {
  const id = 'eov9K7ALYKk';
  for (const ok of [id, ` ${id} `, `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s&list=PLx`, `http://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}?si=abc`, `youtu.be/${id}`, `www.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}?rel=0`,
    `https://www.youtube.com/live/${id}`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube-nocookie.com/embed/${id}`, `HTTPS://WWW.YOUTUBE.COM/watch?v=${id}`]) {
    assert.equal(parseVideoUrl(ok), id, ok);
  }
  for (const bad of ['', 'short', `${id}x`, `https://evil.example/watch?v=${id}`, `https://youtube.com.evil.example/watch?v=${id}`, `https://notyoutube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=tooshort`, 'https://www.youtube.com/channel/UCabc', `https://www.youtube.com/playlist?list=${id}`, `javascript:alert('${id}')`,
    `ftp://youtu.be/${id}`, `https://youtu.be/`, `https://www.youtube.com/watch?v=${id}`.padEnd(600, 'x'), null, 42, {}]) {
    assert.equal(parseVideoUrl(bad), null, String(bad));
  }
});

test('songLanguage and isImportable', () => {
  assert.equal(songLanguage({ defaultLanguage: 'es-419' }, 'en'), 'es');
  assert.equal(songLanguage({ defaultLanguage: 'JA' }), 'ja');
  assert.equal(songLanguage({ defaultLanguage: 'tl' }, 'hi'), 'hi', 'a language the app doesn’t have: the searcher’s');
  assert.equal(songLanguage({}, 'xx'), 'en');
  assert.equal(isImportable(video(vid(0), 'T', 'C')), true);
  assert.equal(isImportable(video(vid(0), 'T', 'C', { categoryId: '22' })), true, 'an admin may add a video outside Music');
  for (const over of [{ embeddable: false }, { public: false }, { live: true }, { title: '  ' }, { videoId: 'nope' }]) assert.equal(isImportable(video(vid(0), 'T', 'C', over)), false);
  assert.equal(isImportable(null), false);
});

test('a new video becomes a song, a source, a cache row and a search entry; search then finds it', async () => {
  const listener = await signup(srv.base, 'imp-listener');
  assert.deepEqual(await songsFor(listener, 'way maker'), [], 'not in the catalog yet');

  const v = video(vid(1), 'Way Maker (Official Lyric Video)', 'Sinach', { defaultLanguage: 'en-GB' });
  const r = await importVideo(store, v, { language: 'es', userId: adminId, via: 'search', now: 5000 });
  assert.equal(r.status, 'added');
  assert.equal(r.createdSong, true);

  assert.deepEqual({ ...(await store.get('SELECT title, artist, language, org_id, public_domain, created_at FROM songs WHERE id = ?', [r.songId])) },
    { title: 'Way Maker', artist: 'Sinach', language: 'en', org_id: null, public_domain: 0, created_at: 5000 });
  assert.deepEqual({ ...(await store.get('SELECT song_id, source, track_id, youtube_video_id, kind, available FROM song_sources WHERE id = ?', [r.sourceId])) },
    { song_id: r.songId, source: 'youtube', track_id: null, youtube_video_id: vid(1), kind: 'lyric', available: 1 });
  assert.deepEqual({ ...(await store.get('SELECT title, channel_title, thumbnail_url, duration_ms, embeddable, fetched_at FROM youtube_video_cache WHERE video_id = ?', [vid(1)])) },
    { title: 'Way Maker (Official Lyric Video)', channel_title: 'Sinach', thumbnail_url: thumbnailUrl(vid(1)), duration_ms: 240_000, embeddable: 1, fetched_at: 5000 });

  const [hit] = await songsFor(listener, 'way maker');
  assert.equal(hit.id, r.songId);
  assert.equal(hit.name, 'Way Maker');
  assert.equal(hit.sources.length, 1);
  assert.equal(hit.sources[0].id, r.sourceId);
  assert.equal(hit.sources[0].youtube.title, 'Way Maker (Official Lyric Video)', 'YouTube’s title, unmodified');
  assert.equal((await songsFor(listener, 'sinach')).length, 1, 'found by the artist too');
  assert.equal((await listener.get(`/api/sources/${r.sourceId}`)).status, 200, 'playable from a queue or another device');

  const log = await store.get("SELECT user_id, details FROM audit_log WHERE action = 'youtube.import' AND target_id = ?", [r.sourceId]);
  assert.equal(Number(log.user_id), adminId);
  assert.deepEqual(JSON.parse(log.details), { video_id: vid(1), song_id: r.songId, created_song: true, kind: 'lyric', via: 'search' });
});

test('the same video again changes nothing but its cached data; another recording joins the same song', async () => {
  const v = video(vid(1), 'Way Maker (Official Lyric Video) [HD]', 'Sinach');
  const before = { songs: await count('SELECT COUNT(*) AS n FROM songs'), sources: await count('SELECT COUNT(*) AS n FROM song_sources'), docs: await count('SELECT COUNT(*) AS n FROM search_index') };
  const again = await importVideo(store, v, { now: 9000 });
  assert.equal(again.status, 'exists');
  assert.equal(again.createdSong, false);
  assert.deepEqual({ songs: await count('SELECT COUNT(*) AS n FROM songs'), sources: await count('SELECT COUNT(*) AS n FROM song_sources'), docs: await count('SELECT COUNT(*) AS n FROM search_index') }, before);
  const cache = await store.get('SELECT title, fetched_at FROM youtube_video_cache WHERE video_id = ?', [vid(1)]);
  assert.deepEqual({ ...cache }, { title: 'Way Maker (Official Lyric Video) [HD]', fetched_at: 9000 }, 'refreshed, as YouTube’s terms want');

  const live = await importVideo(store, video(vid(2), 'WAY MAKER [Live] | Sinach', 'Sinach'));
  assert.equal(live.status, 'added');
  assert.equal(live.createdSong, false);
  assert.equal(live.songId, again.songId, 'matched ignoring case and the video’s description');
  assert.equal((await store.get('SELECT kind FROM song_sources WHERE id = ?', [live.sourceId])).kind, 'live');
  assert.equal(await count('SELECT COUNT(*) AS n FROM songs'), before.songs);

  // The same title by another artist is another song.
  const other = await importVideo(store, video(vid(3), 'Way Maker', 'Leeland'));
  assert.equal(other.createdSong, true);
  assert.notEqual(other.songId, again.songId);
});

test('titles match by alias too, and LIKE wildcards in a title match nothing by accident', async () => {
  const first = await importVideo(store, video(vid(10), 'Cuán Grande Es Él', 'Coro Uno', { defaultLanguage: 'es' }));
  await store.run('INSERT INTO song_aliases (song_id, alias, folded) VALUES (?, ?, ?)', [first.songId, 'How Great Thou Art', fold('How Great Thou Art')]);
  const byAlias = await importVideo(store, video(vid(11), 'How Great Thou Art (Live)', 'Coro Uno'));
  assert.equal(byAlias.songId, first.songId);
  assert.equal(byAlias.createdSong, false);
  const accents = await importVideo(store, video(vid(12), 'CUAN GRANDE ES EL - Coro Uno', 'Coro Uno'));
  assert.equal(accents.songId, first.songId, 'folded: accents and case don’t make a new song');

  const percent = await importVideo(store, video(vid(13), '%', 'Coro Uno'));
  assert.equal(percent.createdSong, true, '"%" is a title, not "any song"');
  const underscore = await importVideo(store, video(vid(14), 'Cu_n Grande Es _l', 'Coro Uno'));
  assert.equal(underscore.createdSong, true);
});

test('a title that names the artist joins that artist’s song, whichever way round; it never names a new song', async () => {
  assert.deepEqual(splitTitles('Way Maker - Leeland'), [{ title: 'Way Maker', artist: 'Leeland' }, { title: 'Leeland', artist: 'Way Maker' }]);
  assert.deepEqual(splitTitles('Way Maker'), []);
  assert.deepEqual(splitTitles('A - B - C'), [], 'three parts could be anything');

  const own = await importVideo(store, video(vid(70), 'Lee Band - Split Song (Official Live Video)', 'Lee Band'));
  assert.equal(own.createdSong, true);
  assert.deepEqual({ ...(await store.get('SELECT title, artist FROM songs WHERE id = ?', [own.songId])) }, { title: 'Split Song', artist: 'Lee Band' });
  // A label's upload ("title - artist") and a lyrics channel's ("artist - title"): the same song.
  const label = await importVideo(store, video(vid(71), 'Split Song (Lyric Video) - Lee Band [ Official ]', 'Some Label'));
  const lyrics = await importVideo(store, video(vid(72), 'LEE BAND - split song (Lyrics)', 'Lyrics Channel'));
  for (const r of [label, lyrics]) assert.deepEqual([r.status, r.createdSong, r.songId], ['added', false, own.songId]);
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_sources WHERE song_id = ?', [own.songId]), 3);

  // No such song yet: the title is kept whole (it can't say which half is the artist).
  const unknown = await importVideo(store, video(vid(73), 'Nobody Yet - Unheard Song', 'Lyrics Channel'));
  assert.deepEqual({ ...(await store.get('SELECT title, artist FROM songs WHERE id = ?', [unknown.songId])) }, { title: 'Nobody Yet - Unheard Song', artist: 'Lyrics Channel' });
});

test('two imports of one new video at once leave one song and one source', async () => {
  const v = video(vid(20), 'Goodness of God', 'Bethel Music');
  const both = await Promise.all([importVideo(store, v), importVideo(store, v)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['added', 'exists']);
  assert.equal(both[0].sourceId, both[1].sourceId);
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_sources WHERE youtube_video_id = ?', [vid(20)]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM songs WHERE title = 'Goodness of God'"), 1);
});

test('existing ids never change: a curated video is "exists" under its own ids', async () => {
  const r = await importVideo(store, video(CARRY.videoId, CARRY.title, CARRY.channelTitle));
  assert.deepEqual(r, { status: 'exists', songId: YOUTUBE_IDS.song(CARRY.videoId), sourceId: YOUTUBE_IDS.source(CARRY.videoId), createdSong: false });
});

test('a hidden video stays out of search and of later live searches; a church’s video is never touched', async () => {
  const listener = await signup(srv.base, 'imp-hider');
  const v = video(vid(30), 'Not A Worship Song (Official Video)', 'Some Band');
  const added = await importVideo(store, v);
  assert.equal((await songsFor(listener, 'not a worship song')).length, 1);

  assert.equal(await hideVideo(store, vid(30), { userId: adminId }), true);
  assert.deepEqual(await songsFor(listener, 'not a worship song'), []);
  assert.equal(await count('SELECT COUNT(*) AS n FROM youtube_video_cache WHERE video_id = ?', [vid(30)]), 0, 'YouTube’s data for it is deleted');
  assert.equal((await listener.get(`/api/sources/${added.sourceId}`)).status, 404);

  const retry = await importVideo(store, v, { via: 'search' });
  assert.equal(retry.status, 'hidden');
  assert.deepEqual(await songsFor(listener, 'not a worship song'), [], 'a search never brings it back');
  assert.equal(await count('SELECT COUNT(*) AS n FROM youtube_video_cache WHERE video_id = ?', [vid(30)]), 0);
  assert.equal(await hideVideo(store, vid(30)), true, 'hiding twice is fine');
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'youtube.hide' AND target_id = ?", [added.sourceId]), 1);
  assert.equal(await hideVideo(store, vid(99)), false);

  const restored = await importVideo(store, v, { via: 'admin', userId: adminId });
  assert.equal(restored.status, 'restored');
  assert.equal((await songsFor(listener, 'not a worship song')).length, 1);

  // A video that is a source of a church's own song: not imported, not hidden, not revealed.
  await store.run("INSERT INTO songs (id, title, artist, language, org_id, created_at, updated_at) VALUES ('church-song', 'Ours', 'Us', 'en', 'org-x', 0, 0)");
  await store.run("INSERT INTO song_sources (id, song_id, source, youtube_video_id, kind, available) VALUES ('church-src', 'church-song', 'youtube', ?, 'official', 1)", [vid(31)]);
  const priv = await importVideo(store, video(vid(31), 'Ours', 'Us'));
  assert.equal(priv.status, 'private');
  assert.equal(await count('SELECT COUNT(*) AS n FROM youtube_video_cache WHERE video_id = ?', [vid(31)]), 0);
  assert.equal(await hideVideo(store, vid(31)), false);
  assert.equal((await store.get("SELECT available FROM song_sources WHERE id = 'church-src'")).available, 1);
});

test('importVideo refuses a video that can’t be a source', async () => {
  await assert.rejects(importVideo(store, video(vid(40), 'T', 'C', { embeddable: false })), /not an importable video/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_sources WHERE youtube_video_id = ?', [vid(40)]), 0);
});

test('POST /api/admin/youtube/import: admins only', async () => {
  const url = `https://youtu.be/${vid(50)}`;
  yt.known.set(vid(50), video(vid(50), 'Admin Song', 'Admin Band'));
  assert.equal((await client(srv.base).post('/api/admin/youtube/import', { url })).status, 401);
  const user = await signup(srv.base, 'imp-user');
  const refused = await user.post('/api/admin/youtube/import', { url });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, 'not_admin');
  assert.equal((await (await login(srv.base)).post('/api/admin/youtube/import', { url })).status, 403, 'the demo is never an admin');
  assert.equal((await user.del(`/api/admin/youtube/${vid(1)}`)).status, 403);
  assert.equal(yt.calls.length, 0, 'nobody else spends YouTube quota');
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_sources WHERE youtube_video_id = ?', [vid(50)]), 0);
});

test('POST /api/admin/youtube/import: a pasted link becomes a playable song; song_id attaches or moves it', async () => {
  yt.calls.length = 0;
  const made = await admin.post('/api/admin/youtube/import', { url: `https://www.youtube.com/watch?v=${vid(50)}&t=10s`, language: 'es' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.status, 'added');
  assert.equal(made.json.created_song, true);
  assert.deepEqual(made.json.song, { id: made.json.song.id, name: 'Admin Song', artist: { name: 'Admin Band' }, language: 'es' });
  assert.equal(made.json.source.youtube.videoId, vid(50));
  assert.equal(made.json.source.youtube.title, 'Admin Song');
  assert.deepEqual(yt.calls, [[vid(50)]], 'one videos.list call, for the id in the link');

  const again = await admin.post('/api/admin/youtube/import', { url: vid(50) });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'exists');
  assert.equal(again.json.source.id, made.json.source.id);

  // Attach a new video to a chosen song, whatever its title says.
  yt.known.set(vid(51), video(vid(51), 'Completely Different Title', 'Other Channel', { categoryId: '22' }));
  const attached = await admin.post('/api/admin/youtube/import', { url: vid(51), song_id: made.json.song.id });
  assert.equal(attached.status, 201, attached.text);
  assert.equal(attached.json.song.id, made.json.song.id);
  assert.equal(attached.json.created_song, false);

  // Move a video the automatic match put under the wrong song.
  const carry = YOUTUBE_IDS.song(CARRY.videoId);
  const moved = await admin.post('/api/admin/youtube/import', { url: vid(51), song_id: carry });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.status, 'moved');
  assert.equal(moved.json.song.id, carry);
  assert.equal(moved.json.source.id, attached.json.source.id, 'the source keeps its id (and so its timings)');
  const log = await store.get("SELECT details FROM audit_log WHERE action = 'youtube.move' AND target_id = ?", [attached.json.source.id]);
  assert.deepEqual(JSON.parse(log.details), { video_id: vid(51), song_id: carry, from_song_id: made.json.song.id });
});

test('POST /api/admin/youtube/import: what it refuses', async () => {
  const post = (body) => admin.post('/api/admin/youtube/import', body);
  for (const url of ['', 'not a link', 'https://evil.example/watch?v=eov9K7ALYKk', null, 42]) assert.equal((await post({ url })).status, 400, String(url));
  assert.equal((await post({ url: vid(50), language: 'xx' })).status, 400);
  assert.equal((await post({ url: vid(50), song_id: 'no-such-song' })).status, 404);
  assert.equal((await post({ url: vid(50), song_id: 'church-song' })).status, 404, 'a church’s song is not a target');

  const gone = await post({ url: vid(60) });
  assert.equal(gone.status, 404, 'YouTube has no such public video');
  yt.known.set(vid(61), video(vid(61), 'Blocked', 'B', { embeddable: false }));
  yt.known.set(vid(62), video(vid(62), 'Stream', 'B', { live: true }));
  yt.known.set(vid(63), video(vid(63), 'Private', 'B', { public: false }));
  for (const n of [61, 62, 63]) assert.equal((await post({ url: vid(n) })).status, 400, vid(n));
  yt.known.set(vid(31), video(vid(31), 'Ours', 'Us'));
  const taken = await post({ url: vid(31) });
  assert.equal(taken.status, 409, 'already a source of a church’s song');
  assert.equal(taken.json.error.code, 'conflict');

  for (const reason of ['no_key', 'quota', 'error']) {
    yt.fail = reason;
    const r = await post({ url: vid(50) });
    assert.equal(r.status, 503, reason);
    assert.equal(r.json.error.code, 'youtube_unavailable');
  }
  yt.fail = null;
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_sources WHERE youtube_video_id IN (?, ?, ?, ?)', [vid(60), vid(61), vid(62), vid(63)]), 0);
});

test('DELETE /api/admin/youtube/:videoId hides a video; importing it again as admin brings it back', async () => {
  const listener = await signup(srv.base, 'imp-del');
  assert.equal((await songsFor(listener, 'admin song')).length, 1);
  assert.equal((await admin.del(`/api/admin/youtube/${vid(50)}`)).status, 200);
  assert.deepEqual(await songsFor(listener, 'admin song'), []);
  assert.equal((await admin.del(`/api/admin/youtube/${vid(99)}`)).status, 404);
  assert.equal((await admin.del('/api/admin/youtube/not-a-video-id')).status, 404);

  const back = await admin.post('/api/admin/youtube/import', { url: vid(50) });
  assert.equal(back.status, 200);
  assert.equal(back.json.status, 'restored');
  assert.equal((await songsFor(listener, 'admin song')).length, 1);
});
