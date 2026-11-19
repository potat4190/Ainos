// Live YouTube search (spec 3.3 path B): the API client against a fake
// fetch, the title parsing, and the route with a fake client: one call per
// query, cached for 7 days, then found locally; never for the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, login, signup } from './helpers.js';
import { createYouTubeSearch, isoDurationMs, songMeta, videoKind, queryKey, cleanChannel, liveIds, purgeYouTubeCache, VIDEO_CACHE_MS } from '../server/youtube-search.js';

const video = (videoId, title, channelTitle, extra = {}) => ({ videoId, title, channelId: 'UC' + videoId, channelTitle, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, durationMs: 300_000, language: 'en', ...extra });
const GOODNESS = video('n0FBb6hnwTo', 'Goodness of God | Live | Bethel Music', 'Bethel Music');
const GRAVES = video('KwX1f2gYKZ4', 'Elevation Worship - Graves Into Gardens (Official Lyric Video)', 'Elevation Worship');

// A stand-in for createYouTubeSearch: answers from a table, counts calls.
function fakeYouTube(answers = {}) {
  const calls = [];
  return {
    enabled: true,
    calls,
    async search(q, opts) {
      calls.push({ q, ...opts });
      const a = answers[queryKey(q)];
      if (a instanceof Error) throw a;
      return a || [];
    },
  };
}

let srv;
let yt;
before(async () => {
  yt = fakeYouTube({ 'goodness of god': [GOODNESS, GRAVES], 'boom': new Error('YouTube search: quotaExceeded') });
  srv = await startTestServer({ youtubeSearch: yt, youtubeDailyCap: 50 });
});
after(() => srv?.close());

test('isoDurationMs reads YouTube durations', () => {
  assert.equal(isoDurationMs('PT4M13S'), 253_000);
  assert.equal(isoDurationMs('PT1H2M'), 3_720_000);
  assert.equal(isoDurationMs('PT45S'), 45_000);
  assert.equal(isoDurationMs('P1DT1S'), 86_401_000);
  for (const bad of ['', 'PT', 'P', '4:13', null, 'PT4X']) assert.equal(isoDurationMs(bad), null, String(bad));
});

test('songMeta finds the song title and artist in common YouTube titles', () => {
  assert.deepEqual(songMeta('Goodness of God | Live | Bethel Music', 'Bethel Music'), { title: 'Goodness of God', artist: 'Bethel Music' });
  assert.deepEqual(songMeta('Elevation Worship - Graves Into Gardens (Official Lyric Video)', 'Elevation Worship'), { title: 'Graves Into Gardens', artist: 'Elevation Worship' });
  assert.deepEqual(songMeta('Carry My Cross - Official Lyric Video', 'Victory Worship'), { title: 'Carry My Cross', artist: 'Victory Worship' });
  assert.deepEqual(songMeta('Way Maker', 'Sinach - Topic'), { title: 'Way Maker', artist: 'Sinach' });
  assert.deepEqual(songMeta('Phil Wickham - Battle Belongs [Official Music Video]', 'PhilWickhamVEVO'), { title: 'Battle Belongs', artist: 'Phil Wickham' });
  assert.equal(cleanChannel('HillsongWorshipVEVO'), 'HillsongWorship');
  assert.equal(songMeta('', 'Some Channel').artist, 'Some Channel');
});

test('videoKind reads what the title says it is, else nothing', () => {
  assert.equal(videoKind('Graves Into Gardens (Official Lyric Video)'), 'lyric');
  assert.equal(videoKind('Goodness of God | Live'), 'live');
  assert.equal(videoKind('Way Maker (Official Video)'), 'official');
  assert.equal(videoKind('Oceans instrumental'), 'backing');
  assert.equal(videoKind('Oceans'), null);
});

test('the API client asks search.list then videos.list and keeps only playable songs', async () => {
  const urls = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url) => {
    urls.push(new URL(url));
    if (url.includes('/search?')) return reply({ items: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee', 'not-an-id'].map((videoId) => ({ id: { videoId } })) });
    const v = (id, snippet, duration, status = {}) => ({ id, snippet: { title: `Song ${id}`, channelTitle: 'Chan', channelId: 'UCx', liveBroadcastContent: 'none', ...snippet }, contentDetails: { duration }, status: { embeddable: true, privacyStatus: 'public', ...status } });
    return reply({ items: [
      v('aaaaaaaaaaa', { defaultAudioLanguage: 'es-419' }, 'PT4M'),
      v('bbbbbbbbbbb', {}, 'PT30S'), // a Short
      v('ccccccccccc', {}, 'PT4M', { embeddable: false }),
      v('ddddddddddd', { liveBroadcastContent: 'live' }, 'P0D'),
      v('eeeeeeeeeee', {}, 'PT1H30M'), // a whole service
    ] });
  };
  const client = createYouTubeSearch({ apiKey: 'test-key', fetch });
  assert.equal(client.enabled, true);
  const found = await client.search('way maker', { lang: 'es' });
  assert.deepEqual(found.map((v) => v.videoId), ['aaaaaaaaaaa']);
  assert.equal(found[0].language, 'es');
  assert.equal(found[0].durationMs, 240_000);
  assert.equal(found[0].thumbnail, 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg');
  const [search, videos] = urls;
  assert.equal(search.pathname, '/youtube/v3/search');
  assert.equal(search.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(search.searchParams.get('relevanceLanguage'), 'es');
  assert.equal(search.searchParams.get('key'), 'test-key');
  assert.equal(videos.pathname, '/youtube/v3/videos');
  assert.equal(videos.searchParams.get('id'), 'aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc,ddddddddddd,eeeeeeeeeee');
  assert.equal(urls.length, 2, 'one search.list and one videos.list call');

  assert.equal(createYouTubeSearch({ apiKey: '' }).enabled, false);
  const failing = createYouTubeSearch({ apiKey: 'k', fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }) }) });
  await assert.rejects(failing.search('x'), /quotaExceeded/);
});

test('live search: one YouTube call, the songs join the catalog, then search finds them locally', async () => {
  const c = await signup(srv.base, 'livesearch1');
  const before = await c.get('/api/search?q=goodness%20of%20god');
  assert.equal(before.json.live_search, true);
  assert.equal(before.json.songs.items.length, 0);

  const r = await c.post('/api/search/youtube', { q: 'Goodness of God' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.cached, false);
  assert.equal(yt.calls.length, 1);
  assert.equal(yt.calls[0].lang, 'en');
  const [goodness, graves] = r.json.songs.items;
  assert.equal(goodness.id, liveIds.song(GOODNESS.videoId));
  assert.equal(goodness.name, 'Goodness of God');
  assert.deepEqual(goodness.artist, { name: 'Bethel Music' });
  assert.equal(goodness.sources.length, 1);
  const src = goodness.sources[0];
  assert.equal(src.source, 'youtube');
  assert.equal(src.kind, 'live');
  assert.equal(src.youtube.videoId, GOODNESS.videoId);
  assert.equal(src.youtube.title, GOODNESS.title, 'YouTube title unmodified');
  assert.equal(src.youtube.channelTitle, 'Bethel Music');
  assert.equal(graves.name, 'Graves Into Gardens');
  assert.equal(graves.sources[0].kind, 'lyric');

  // The same query again (any spelling of it) answers from the cache.
  const again = await c.post('/api/search/youtube', { q: '  goodness OF god ' });
  assert.equal(again.json.cached, true);
  assert.deepEqual(again.json.songs.items.map((s) => s.id), [goodness.id, graves.id]);
  assert.equal(yt.calls.length, 1, 'no second YouTube call');

  // ...and path A finds the songs now, for anyone.
  const other = await signup(srv.base, 'livesearch2');
  const local = await other.get('/api/search?q=graves%20into%20gardens');
  assert.ok(local.json.songs.items.some((s) => s.id === graves.id), JSON.stringify(local.json.songs));
  const song = await other.get(`/api/songs/${goodness.id}`);
  assert.equal(song.status, 200);
  assert.equal(song.json.sources[0].youtube.videoId, GOODNESS.videoId);
  assert.deepEqual(song.json.sections, [], 'no lyrics are taken from YouTube');
});

test('live search: a video already in the catalog keeps its song', async () => {
  const yt2 = fakeYouTube({ 'carry my cross': [video('eov9K7ALYKk', 'Carry My Cross (Live at Church)', 'Victory Worship')] });
  const s2 = await startTestServer({ youtubeSearch: yt2 });
  try {
    const c = await signup(s2.base, 'livesearch3');
    const r = await c.post('/api/search/youtube', { q: 'carry my cross' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.songs.items.length, 1);
    assert.equal(r.json.songs.items[0].name, 'Carry My Cross', 'the curated song record stays');
  } finally { await s2.close(); }
});

test('live search: nothing found is cached too', async () => {
  const c = await signup(srv.base, 'livesearch4');
  const calls = yt.calls.length;
  const r = await c.post('/api/search/youtube', { q: 'zzzz nothing here' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.songs.items, []);
  const again = await c.post('/api/search/youtube', { q: 'zzzz nothing here' });
  assert.equal(again.json.cached, true);
  assert.equal(yt.calls.length, calls + 1);
});

test('live search: the demo never searches YouTube', async () => {
  const c = await login(srv.base);
  const calls = yt.calls.length;
  const s = await c.get('/api/search?q=anything');
  assert.equal(s.json.live_search, false);
  const r = await c.post('/api/search/youtube', { q: 'brand new query' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'demo_not_allowed');
  assert.equal(yt.calls.length, calls);
});

test('live search: bad queries, YouTube failures and a server without a key', async () => {
  const c = await signup(srv.base, 'livesearch5');
  assert.equal((await c.post('/api/search/youtube', { q: 'a' })).status, 400);
  assert.equal((await c.post('/api/search/youtube', { q: '!!' })).status, 400);
  assert.equal((await c.post('/api/search/youtube', { q: 42 })).status, 400);
  assert.equal((await c.post('/api/search/youtube', { q: 'x'.repeat(101) })).status, 400);
  const failed = await c.post('/api/search/youtube', { q: 'boom' });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.code, 'youtube_unavailable');

  const s2 = await startTestServer({ youtubeSearch: createYouTubeSearch({ apiKey: '' }) });
  try {
    const u = await signup(s2.base, 'livesearch6');
    assert.equal((await u.get('/api/search?q=x')).json.live_search, false);
    const r = await u.post('/api/search/youtube', { q: 'goodness of god' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'not_configured');
  } finally { await s2.close(); }
});

test('live search: 10 new searches an hour per listener', async () => {
  const c = await signup(srv.base, 'livesearch7');
  for (let i = 0; i < 10; i++) assert.equal((await c.post('/api/search/youtube', { q: `limit test ${i}` })).status, 200);
  const r = await c.post('/api/search/youtube', { q: 'limit test 10' });
  assert.equal(r.status, 429);
  // A cached query still answers.
  assert.equal((await c.post('/api/search/youtube', { q: 'limit test 3' })).status, 200);
});

test('live search: an app-wide daily cap', async () => {
  const yt3 = fakeYouTube();
  const s3 = await startTestServer({ youtubeSearch: yt3, youtubeDailyCap: 2 });
  try {
    const a = await signup(s3.base, 'livecap1');
    const b = await signup(s3.base, 'livecap2');
    assert.equal((await a.post('/api/search/youtube', { q: 'cap one' })).status, 200);
    assert.equal((await b.post('/api/search/youtube', { q: 'cap two' })).status, 200);
    const r = await b.post('/api/search/youtube', { q: 'cap three' });
    assert.equal(r.status, 429);
    assert.equal(yt3.calls.length, 2);
  } finally { await s3.close(); }
});

test('housekeeping drops live-found YouTube data after 30 days, never the curated videos', async () => {
  const yt4 = fakeYouTube({ 'way maker': [video('iJCV_2H9xD0', 'Way Maker (Official Video)', 'Sinach')] });
  const s4 = await startTestServer({ youtubeSearch: yt4 });
  try {
    const c = await signup(s4.base, 'livepurge');
    assert.equal((await c.post('/api/search/youtube', { q: 'way maker' })).json.songs.items.length, 1);
    const store = s4.app.store;
    assert.ok(store, 'app exposes its store');
    const later = Date.now() + VIDEO_CACHE_MS + 60_000;
    await purgeYouTubeCache(store, later);
    assert.equal((await store.all('SELECT video_id FROM youtube_video_cache WHERE video_id = ?', ['iJCV_2H9xD0'])).length, 0);
    assert.equal((await store.all('SELECT video_id FROM youtube_video_cache WHERE video_id = ?', ['eov9K7ALYKk'])).length, 1, 'curated video kept');
    assert.equal((await store.all('SELECT query FROM youtube_search_cache')).length, 0);
    // The song no longer shows until a search refreshes it.
    assert.equal((await c.get('/api/search?q=way%20maker')).json.songs.items.length, 0);
  } finally { await s4.close(); }
});
