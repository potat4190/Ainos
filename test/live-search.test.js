// The live YouTube fallback in GET /api/search (PLAN.md "Live YouTube
// search", L3; spec 3.3 path B, S12, S15): a missing song costs exactly one
// YouTube search and is found in the catalog from then on; the demo, the
// limits, the daily cap and remembered queries each stop it; the key never
// shows. YouTube is a stub or a fake fetch: no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, client, login, signup } from './helpers.js';
import { foldQuery, MAX_ADDED, CACHE_MS } from '../server/live-search.js';
import { createYouTube, MUSIC_CATEGORY, thumbnailUrl } from '../server/youtube.js';
import { hideVideo } from '../server/youtube-import.js';

const vid = (n) => `liv${String(n).padStart(8, '0')}`; // 11 characters
const video = (videoId, title, channelTitle, over = {}) => ({
  videoId, title, channelId: 'UCx', channelTitle, thumbnail: thumbnailUrl(videoId), durationMs: 240_000,
  embeddable: true, public: true, live: false, categoryId: MUSIC_CATEGORY, defaultLanguage: null, ...over,
});

// The stub YouTube: `answer(q)` gives the videos (or a failure) for a query.
const yt = { calls: [], answer: () => [] };
const youtube = {
  hasKey: true,
  async searchVideos(q, opts) {
    yt.calls.push({ q, ...opts });
    const a = await yt.answer(q);
    return Array.isArray(a) ? { ok: true, videos: a } : { ok: false, reason: a, videos: [] };
  },
  async videoDetails() { throw new Error('a search never asks for details itself'); },
};

let srv, store;
before(async () => {
  srv = await startTestServer({ youtube, verifiedChannels: ['Victory Worship'] });
  store = srv.app.store;
});
after(() => srv.close());

const search = async (c, q, live = true) => {
  const r = await c.get(`/api/search?q=${encodeURIComponent(q)}${live ? '&live=1' : ''}`);
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const cacheRow = (q, language = 'en') => store.get('SELECT results, fetched_at FROM search_cache WHERE query_folded = ? AND language = ?', [q, language]);

test('foldQuery: folded words, and nothing for a query too short to be a song', () => {
  assert.equal(foldQuery('  Way   MAKER!! '), 'way maker');
  assert.equal(foldQuery('Jesús, Es El Señor'), 'jesus es el senor');
  assert.equal(foldQuery('ＡＢＣ'), 'abc');
  assert.equal(foldQuery('主の祈り'), '主の祈り');
  for (const short of ['', '  ', 'ab', 'a b', '!!!', null, undefined]) assert.equal(foldQuery(short), '', String(short));
  assert.equal(foldQuery('one two three four five six seven eight nine ten').split(' ').length, 8);
  assert.ok(foldQuery('x'.repeat(300)).length <= 100);
});

test('a song not in the catalog costs exactly one live search, then is found locally', async () => {
  const a = await signup(srv.base, 'live-a');
  yt.answer = () => [video(vid(1), 'Way Maker (Official Lyric Video)', 'Sinach')];

  const plain = await search(a, 'Way Maker', false);
  assert.deepEqual([plain.songs.items.length, plain.live, yt.calls.length], [0, 'off', 0], 'typing alone never asks YouTube');

  const first = await search(a, 'Way Maker');
  assert.equal(first.live, 'searched');
  assert.deepEqual(yt.calls, [{ q: 'Way Maker', language: 'en' }]);
  assert.equal(first.songs.items.length, 1, 'the answer already holds the new song');
  assert.equal(first.songs.items[0].name, 'Way Maker');
  assert.equal(first.songs.items[0].sources[0].youtube.videoId, vid(1));
  assert.deepEqual(JSON.parse((await cacheRow('way maker')).results), [vid(1)]);

  // From now on: the catalog answers, for everyone, and YouTube is not asked again.
  const again = await search(a, 'way  maker');
  assert.deepEqual([again.songs.items.length, again.live], [1, 'cached']);
  const b = await signup(srv.base, 'live-b');
  assert.equal((await search(b, 'WAY MAKER', false)).songs.items.length, 1);
  assert.equal((await search(b, 'Way Maker')).live, 'cached');
  assert.equal(yt.calls.length, 1);

  const log = await store.get("SELECT user_id, details FROM audit_log WHERE action = 'youtube.import'");
  assert.equal(Number(log.user_id), (await a.get('/api/me')).json.id);
  assert.equal(JSON.parse(log.details).via, 'search');
});

test('at most three videos are added, verified channels first, then YouTube’s order', async () => {
  const a = await signup(srv.base, 'live-top');
  yt.calls.length = 0;
  yt.answer = () => [
    video(vid(11), 'Tala (Cover)', 'Fan Channel'),
    video(vid(12), 'Tala - Lyrics', 'Lyrics Hub'),
    video(vid(13), 'Tala (Karaoke)', 'Karaoke Co'),
    video(vid(14), 'Tala (Official Lyric Video)', 'victory worship'),
    video(vid(15), 'Tala (Live)', 'Someone Else'),
  ];
  const r = await search(a, 'tala');
  assert.equal(r.live, 'searched');
  assert.equal(MAX_ADDED, 3);
  assert.deepEqual(JSON.parse((await cacheRow('tala')).results), [vid(14), vid(11), vid(12)]);
  const added = (await store.all("SELECT youtube_video_id AS v FROM song_sources WHERE youtube_video_id LIKE 'liv0000001%' ORDER BY v")).map((x) => x.v);
  assert.deepEqual(added, [vid(11), vid(12), vid(14)]);
  assert.equal(r.songs.items.length, 3, 'three channels, three songs (the artist is the channel)');
});

test('/api/me tells the app whether a live search can happen for this user', async () => {
  const a = await signup(srv.base, 'live-me');
  assert.equal((await a.get('/api/me')).json.live_search, true);
  assert.equal((await (await login(srv.base)).get('/api/me')).json.live_search, false, 'never for the demo');
  youtube.hasKey = false;
  try {
    assert.equal((await a.get('/api/me')).json.live_search, false, 'no key: the app does not even ask');
  } finally {
    youtube.hasKey = true;
  }
});

test('one song from three channels becomes one song with three versions, whatever order YouTube gives them in', async () => {
  const a = await signup(srv.base, 'live-merge');
  yt.calls.length = 0;
  yt.answer = () => [
    video(vid(71), 'Leeland - Merge Song (Lyrics)', 'The Higher Power'),
    video(vid(72), 'Merge Song (Lyric Video) - Leeland [ Official ]', 'Integrity Music'),
    video(vid(73), 'Leeland - Merge Song (Official Live Video)', 'Leeland'),
  ];
  const r = await search(a, 'merge song');
  assert.equal(r.live, 'searched');
  assert.equal(r.songs.items.length, 1);
  assert.deepEqual([r.songs.items[0].name, r.songs.items[0].artist.name], ['Merge Song', 'Leeland']);
  assert.deepEqual(r.songs.items[0].sources.map((x) => x.youtube.videoId).sort(), [vid(71), vid(72), vid(73)]);
  assert.deepEqual(JSON.parse((await cacheRow('merge song')).results), [vid(71), vid(72), vid(73)], 'remembered in YouTube’s order');
});

test('enough songs in the catalog, a demo account, a short query or no key: YouTube is not asked', async () => {
  const a = await signup(srv.base, 'live-off');
  yt.calls.length = 0;
  yt.answer = () => [video(vid(20), 'Anything', 'Anyone')];
  assert.equal((await search(a, 'tala')).live, 'enough', 'three songs match already');
  assert.equal((await search(a, 'ab')).live, 'off');
  assert.equal((await search(a, '')).live, 'off');

  const demo = await login(srv.base);
  assert.equal((await search(demo, 'never heard of this song')).live, 'off', 'the shared demo never spends quota');
  const churchDemo = client(srv.base);
  assert.equal((await churchDemo.post('/api/auth/church-demo', { language: 'en' })).status, 200);
  assert.equal((await search(churchDemo, 'never heard of this song')).live, 'off');

  youtube.hasKey = false;
  try {
    assert.equal((await search(a, 'never heard of this song')).live, 'off');
  } finally {
    youtube.hasKey = true;
  }
  assert.equal(yt.calls.length, 0);
  assert.equal(await cacheRow('never heard of this song'), undefined);
});

test('a miss is remembered for a week, per language', async () => {
  const a = await signup(srv.base, 'live-miss');
  yt.calls.length = 0;
  yt.answer = () => [];
  assert.equal((await search(a, 'zzz no such hymn')).live, 'searched');
  assert.deepEqual({ ...(await cacheRow('zzz no such hymn')) }.results, '[]');
  assert.equal((await search(a, 'zzz no such hymn')).live, 'cached');
  assert.equal(yt.calls.length, 1);

  // Another language is another question to YouTube (relevanceLanguage differs).
  await store.run("UPDATE users SET language = 'es' WHERE username = 'live-miss'");
  assert.equal((await search(a, 'zzz no such hymn')).live, 'searched');
  assert.deepEqual(yt.calls.at(-1), { q: 'zzz no such hymn', language: 'es' });
  await store.run("UPDATE users SET language = 'en' WHERE username = 'live-miss'");

  // A week later the query may be asked again, and now there is a video.
  await store.run("UPDATE search_cache SET fetched_at = ? WHERE query_folded = 'zzz no such hymn' AND language = 'en'", [Date.now() - CACHE_MS - 1000]);
  yt.answer = () => [video(vid(30), 'ZZZ No Such Hymn', 'New Band')];
  const later = await search(a, 'zzz no such hymn');
  assert.deepEqual([later.live, later.songs.items.length], ['searched', 1]);
  assert.equal(yt.calls.length, 3);
});

test('when YouTube can’t be asked nothing is remembered, and the search still answers', async () => {
  const a = await signup(srv.base, 'live-fail');
  yt.calls.length = 0;
  for (const [reason, live] of [['error', 'unavailable'], ['paused', 'unavailable'], ['quota', 'capped']]) {
    yt.answer = () => reason;
    const r = await search(a, 'broken upstream song');
    assert.deepEqual([r.live, r.songs.items.length], [live, 0], reason);
    assert.equal(await cacheRow('broken upstream song'), undefined, 'not a miss: it can be tried again');
  }
  yt.answer = () => { throw new Error('boom'); };
  assert.equal((await search(a, 'broken upstream song')).live, 'unavailable', 'even a client that throws');
  assert.equal(yt.calls.length, 4);
});

test('the same new query twice at once asks YouTube once', async () => {
  const a = await signup(srv.base, 'live-twice');
  yt.calls.length = 0;
  yt.answer = async () => { await new Promise((r) => setTimeout(r, 30)); return [video(vid(40), 'Twice At Once', 'A Band')]; };
  const both = await Promise.all([search(a, 'twice at once'), search(a, 'twice at once')]);
  assert.deepEqual(both.map((r) => r.live).sort(), ['cached', 'searched']);
  assert.equal(yt.calls.length, 1);
});

test('a video an admin hid is not brought back by a later search', async () => {
  const a = await signup(srv.base, 'live-hidden');
  yt.calls.length = 0;
  yt.answer = () => [video(vid(50), 'Not Worship At All', 'Some Band')];
  assert.equal((await search(a, 'not worship at all')).songs.items.length, 1);
  await hideVideo(store, vid(50));
  await store.run("DELETE FROM search_cache WHERE query_folded = 'not worship at all'");
  const r = await search(a, 'not worship at all');
  assert.deepEqual([r.live, r.songs.items.length], ['searched', 0]);
  assert.deepEqual(JSON.parse((await cacheRow('not worship at all')).results), [], 'remembered as nothing usable');
});

test('a user gets 10 live searches an hour; after that the catalog still answers', async () => {
  const a = await signup(srv.base, 'live-limit');
  yt.calls.length = 0;
  yt.answer = () => [];
  for (let i = 0; i < 10; i++) assert.equal((await search(a, `limit query number ${i}`)).live, 'searched', String(i));
  const over = await search(a, 'limit query number ten');
  assert.equal(over.live, 'limited');
  assert.equal(yt.calls.length, 10);
  assert.equal((await search(a, 'limit query number 3')).live, 'cached', 'remembered queries cost nothing');
  assert.equal((await search(a, 'way maker', false)).songs.items.length, 1);
  // Someone else is not held back by this user's limit.
  const b = await signup(srv.base, 'live-limit-b');
  assert.equal((await search(b, 'another user query')).live, 'searched');
});

test('the daily cap stops live searches for everyone, and the key never shows (real client, fake fetch)', async () => {
  const KEY = 'test-live-key-9c2b7e41aa';
  const calls = [];
  const logs = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const item = (videoId, title) => ({ id: videoId, snippet: { title, channelId: 'UCx', channelTitle: 'Cap Band', categoryId: MUSIC_CATEGORY, liveBroadcastContent: 'none' },
    contentDetails: { duration: 'PT3M' }, status: { embeddable: true, privacyStatus: 'public' } });
  let mode = 'ok';
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (mode === 'quota') return json({ error: { message: `key ${KEY} is over quota`, errors: [{ reason: 'quotaExceeded' }] } }, 403);
    if (init.headers['X-Goog-Api-Key'] !== KEY) return json({}, 400);
    if (u.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: vid(60) } }] });
    return json({ items: [item(vid(60), 'Cap Song One (Official Video)')] });
  };
  let clock = Date.now();
  const own = await startTestServer({ youtube: createYouTube({ apiKey: KEY, fetch, now: () => clock, log: (...a) => logs.push(a.join(' ')) }), youtubeDailySearchCap: 3, log: (...a) => logs.push(a.join(' ')) });
  try {
    const a = await signup(own.base, 'cap-a');
    const b = await signup(own.base, 'cap-b');
    const texts = [];
    const go = async (c, q) => {
      const r = await c.get(`/api/search?q=${encodeURIComponent(q)}&live=1`);
      texts.push(r.text, JSON.stringify([...r.headers]));
      return r.json;
    };
    const one = await go(a, 'cap song one');
    assert.deepEqual([one.live, one.songs.items[0]?.name], ['searched', 'Cap Song One']);
    assert.deepEqual(calls, ['/youtube/v3/search', '/youtube/v3/videos'], 'one search.list and one videos.list per live search');

    // YouTube's own quota answer (its error text holds the key): reported as capped, nothing remembered.
    mode = 'quota';
    assert.equal((await go(b, 'quota song')).live, 'capped');
    assert.equal(calls.length, 3);
    assert.equal((await own.app.store.get("SELECT 1 AS x FROM search_cache WHERE query_folded = 'quota song'")), undefined);
    mode = 'ok';
    clock += 2 * 3600 * 1000; // past the client's pause after a quota answer

    assert.equal((await go(b, 'cap song two')).live, 'searched');
    assert.equal(calls.length, 5);
    assert.equal((await go(b, 'cap song three')).live, 'capped', 'the app’s daily allowance (3 here) is used up');
    assert.equal((await go(a, 'cap song four')).live, 'capped');
    assert.equal(calls.length, 5, 'no call past the cap');
    assert.equal((await go(b, 'cap song one')).live, 'cached');

    for (const t of [...texts, ...logs]) assert.ok(!t.includes(KEY), 'the key is in no response and no log line');
    assert.ok(logs.some((l) => l.includes('quotaExceeded')), 'the reason is logged');
    const rows = await own.app.store.all('SELECT * FROM search_cache');
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(KEY)));
  } finally {
    await own.close();
  }
});
