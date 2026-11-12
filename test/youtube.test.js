// The YouTube client for the live search fallback (PLAN.md L1), against a
// fake YouTube (no network): what is asked, what is kept, that only public,
// embeddable, finished music videos come back, that API trouble becomes a
// reason instead of an error, and that the key never leaves its header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYouTube, isoDurationMs, videoKind, cleanSongTitle, artistFromChannel, songFromVideo, thumbnailUrl, isPlayableMusic,
  YOUTUBE_API, MUSIC_CATEGORY, SEARCH_RESULTS } from '../server/youtube.js';
import { thumbnailUrl as curatedThumbnail } from '../scripts/youtube-videos.js';

const KEY = 'test-yt-key-4b1e9a7c2d';
const id = (n) => `vid${String(n).padStart(8, '0')}`; // 11 characters

/** A videos.list item; `over` changes or removes parts of it. */
function item(videoId, over = {}) {
  return {
    id: videoId,
    snippet: {
      title: `Song ${videoId} (Official Video)`, channelId: 'UCchannel', channelTitle: 'Some Worship', categoryId: MUSIC_CATEGORY,
      liveBroadcastContent: 'none', defaultAudioLanguage: 'en',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } }, ...over.snippet,
    },
    contentDetails: { duration: 'PT4M13S', ...over.contentDetails },
    status: { embeddable: true, privacyStatus: 'public', ...over.status },
  };
}

/** A fake YouTube: `search` lists the ids search.list returns, `videos` the items videos.list knows. */
function fakeYouTube({ search = [], videos = [] } = {}) {
  const fake = { mode: 'ok', calls: [], search, videos };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  fake.fetch = async (url, init = {}) => {
    const u = new URL(url);
    fake.calls.push({ url: u.href, path: u.pathname, params: Object.fromEntries(u.searchParams), key: init.headers?.['X-Goog-Api-Key'], redirect: init.redirect });
    if (fake.mode === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    if (fake.mode === 'network') throw new TypeError('fetch failed');
    if (fake.mode === 'error') return json({ error: { code: 500, errors: [{ reason: 'backendError' }] } }, 500);
    if (fake.mode === 'quota') return json({ error: { code: 403, message: `quota for key ${KEY}`, errors: [{ reason: 'quotaExceeded' }] } }, 403);
    if (fake.mode === 'forbidden') return json({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403);
    if (fake.mode === 'html') return new Response('<html>', { status: 200 });
    if (fake.mode === 'null') return json(null);
    if (init.headers?.['X-Goog-Api-Key'] !== KEY) return json({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } }, 400);
    if (u.pathname === '/youtube/v3/search') return json({ items: fake.search.map((videoId) => ({ id: { kind: 'youtube#video', videoId } })) });
    if (u.pathname === '/youtube/v3/videos') {
      const wanted = u.searchParams.get('id').split(',');
      return json({ items: fake.videos.filter((v) => wanted.includes(v.id)) });
    }
    return json({ error: { code: 404 } }, 404);
  };
  return fake;
}

const clientFor = (fake, more = {}) => {
  const logs = [];
  const yt = createYouTube({ apiKey: KEY, fetch: fake.fetch, log: (...a) => logs.push(a.join(' ')), ...more });
  return { yt, logs };
};

test('isoDurationMs reads YouTube durations and refuses anything else', () => {
  assert.equal(isoDurationMs('PT4M13S'), 253_000);
  assert.equal(isoDurationMs('PT1H2M3S'), 3_723_000);
  assert.equal(isoDurationMs('PT45S'), 45_000);
  assert.equal(isoDurationMs('PT2H'), 7_200_000);
  assert.equal(isoDurationMs('P1DT1S'), 86_401_000);
  assert.equal(isoDurationMs('P0D'), 0, 'a live stream has no length');
  for (const bad of ['', 'P', 'PT', 'P1DT', '4:13', 'PT4M13', 'PT-4M', null, undefined, 253, {}]) assert.equal(isoDurationMs(bad), null, String(bad));
});

test('videoKind: lyric before live, official otherwise', () => {
  assert.equal(videoKind('Carry My Cross - Official Lyric Video'), 'lyric');
  assert.equal(videoKind('Goodness of God (LIVE)'), 'live');
  assert.equal(videoKind('Way Maker (Live Lyrics)'), 'lyric');
  assert.equal(videoKind('What A Beautiful Name (Official Music Video)'), 'official');
  assert.equal(videoKind('Alive'), 'official', 'whole words only');
  assert.equal(videoKind(null), 'official');
});

test('cleanSongTitle keeps what is sung and drops the video’s description and the artist', () => {
  for (const [title, channel, want] of [
    ['Carry My Cross - Official Lyric Video', 'Victory Worship', 'Carry My Cross'],
    ['Carry My Cross (Live) | Victory Worship', 'Victory Worship', 'Carry My Cross'],
    ['Bethel Music - Goodness of God (Live)', 'Bethel Music', 'Goodness of God'],
    ['What A Beautiful Name [Official Music Video] - Hillsong Worship', 'Hillsong Worship', 'What A Beautiful Name'],
    ['WAY MAKER (Official Lyric Video) [4K]', 'Sinach', 'WAY MAKER'],
    ['10,000 Reasons (Bless the Lord)', 'Matt Redman', '10,000 Reasons (Bless the Lord)'],
    ['Jesús Es El Señor (Video Oficial)', 'Alabanza', 'Jesús Es El Señor (Video Oficial)'],
    ['  Great   Are You Lord  ', 'All Sons & Daughters - Topic', 'Great Are You Lord'],
    ['Live', 'Some Band', 'Live'],
    ['Official Video', 'Some Band', 'Official Video'],
    ['"Oceans" (Lyrics)', 'HillsongUNITEDVEVO', 'Oceans'],
  ]) assert.equal(cleanSongTitle(title, channel), want, title);
  assert.equal(cleanSongTitle('x'.repeat(500)).length, 200);
  assert.equal(cleanSongTitle(null), '');
});

test('artistFromChannel and songFromVideo', () => {
  assert.equal(artistFromChannel('Elevation Worship - Topic'), 'Elevation Worship');
  assert.equal(artistFromChannel('HillsongUNITEDVEVO'), 'HillsongUNITED');
  assert.equal(artistFromChannel(undefined), '');
  assert.deepEqual(songFromVideo({ title: 'Carry My Cross - Official Lyric Video', channelTitle: 'Victory Worship' }),
    { title: 'Carry My Cross', artist: 'Victory Worship', kind: 'lyric' });
  assert.equal(curatedThumbnail, thumbnailUrl, 'one thumbnail rule for curated and live-added videos');
});

test('without a key nothing is called', async () => {
  const fake = fakeYouTube({ search: [id(1)], videos: [item(id(1))] });
  for (const apiKey of ['', null]) {
    const yt = createYouTube({ apiKey, fetch: fake.fetch });
    assert.equal(yt.hasKey, false);
    assert.deepEqual(await yt.searchVideos('way maker'), { ok: false, reason: 'no_key', videos: [] });
    assert.deepEqual(await yt.videoDetails([id(1)]), { ok: false, reason: 'no_key', videos: [] });
  }
  assert.equal(fake.calls.length, 0);
});

test('a search is one search.list call and one videos.list call, with the key in a header only', async () => {
  const fake = fakeYouTube({ search: [id(2), id(1)], videos: [item(id(1)), item(id(2), { snippet: { title: 'Way Maker (Live)', channelTitle: 'Leeland' } })] });
  const { yt } = clientFor(fake);
  assert.equal(yt.hasKey, true);
  const r = await yt.searchVideos('  way   maker ', { language: 'es' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.videos.map((v) => v.videoId), [id(2), id(1)], 'YouTube’s order is kept');
  assert.deepEqual(r.videos[0], {
    videoId: id(2), title: 'Way Maker (Live)', channelId: 'UCchannel', channelTitle: 'Leeland', thumbnail: `https://i.ytimg.com/vi/${id(2)}/hqdefault.jpg`,
    durationMs: 253_000, embeddable: true, public: true, live: false, categoryId: MUSIC_CATEGORY, defaultLanguage: 'en',
  });

  assert.deepEqual(fake.calls.map((c) => c.path), ['/youtube/v3/search', '/youtube/v3/videos']);
  const [search, videos] = fake.calls;
  assert.deepEqual(search.params, { part: 'id', type: 'video', videoEmbeddable: 'true', videoCategoryId: MUSIC_CATEGORY, safeSearch: 'moderate',
    maxResults: String(SEARCH_RESULTS), q: 'way maker', relevanceLanguage: 'es' });
  assert.equal(videos.params.part, 'snippet,contentDetails,status');
  assert.equal(videos.params.id, `${id(2)},${id(1)}`);
  for (const c of fake.calls) {
    assert.ok(c.url.startsWith(`${YOUTUBE_API}/`));
    assert.equal(c.key, KEY);
    assert.equal(c.redirect, 'error', 'a redirect must not carry the key elsewhere');
    assert.ok(!c.url.includes(KEY), 'the key is never in a URL');
  }
});

test('the query is cut to 100 characters, an odd language is left out, and an empty query calls nothing', async () => {
  const fake = fakeYouTube();
  const { yt } = clientFor(fake);
  assert.deepEqual(await yt.searchVideos('   '), { ok: true, videos: [] });
  assert.deepEqual(await yt.searchVideos(42), { ok: true, videos: [] });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await yt.searchVideos('q'.repeat(300), { language: 'en-US&key=x' }), { ok: true, videos: [] });
  assert.equal(fake.calls.length, 1, 'no results: no videos.list call');
  assert.equal(fake.calls[0].params.q.length, 100);
  assert.equal('relevanceLanguage' in fake.calls[0].params, false);
});

test('only public, embeddable, finished music videos come back', async () => {
  const videos = [
    item(id(1)),
    item(id(2), { status: { embeddable: false } }),
    item(id(3), { status: { privacyStatus: 'unlisted' } }),
    item(id(4), { snippet: { categoryId: '22' } }),
    item(id(5), { snippet: { liveBroadcastContent: 'live' }, contentDetails: { duration: 'P0D' } }),
    item(id(6), { snippet: { liveBroadcastContent: 'upcoming' } }),
    item(id(7), { contentDetails: { duration: 'nonsense' } }),
    item(id(8), { snippet: { title: '   ' } }),
    item(id(9), { snippet: { thumbnails: { high: { url: 'https://evil.example/x.jpg' }, default: { url: 'http://i.ytimg.com/vi/x/default.jpg' } } } }),
    // id(10) is in the search but YouTube returns no details for it (deleted meanwhile).
    { id: 'not-an-id', snippet: { title: 'x' } },
  ];
  const fake = fakeYouTube({ search: [...Array.from({ length: 10 }, (_, i) => id(i + 1)), 'bad id!', null], videos });
  const { yt } = clientFor(fake);
  const r = await yt.searchVideos('anything');
  assert.deepEqual(r.videos.map((v) => v.videoId), [id(1), id(9)]);
  assert.equal(r.videos[1].thumbnail, thumbnailUrl(id(9)), 'a thumbnail from another host or over http is replaced by YouTube’s standard one');
  assert.equal(fake.calls[1].params.id.split(',').length, 10, 'malformed ids never reach videos.list');
  assert.equal(isPlayableMusic(null), false);
});

test('videoDetails: 50 ids per call, the order asked, duplicates and bad ids dropped, missing videos simply absent', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => id(i + 1));
  const fake = fakeYouTube({ videos: ids.filter((_, i) => i !== 60).map((v) => item(v, { status: { embeddable: false } })) });
  const { yt } = clientFor(fake);
  const r = await yt.videoDetails([...ids, ids[0], 'short', 7]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.videos.map((v) => v.videoId), ids.filter((_, i) => i !== 60), 'the refresh job sees unembeddable videos too');
  assert.deepEqual(fake.calls.map((c) => c.params.id.split(',').length), [50, 50, 20]);
  assert.deepEqual(await yt.videoDetails('nope'), { ok: true, videos: [] });
  assert.equal(fake.calls.length, 3);
});

test('API trouble becomes a reason, is logged without the key, and pauses further calls', async () => {
  let clock = 1_000_000;
  for (const [mode, reason, logged, pauseMs] of [
    ['error', 'error', 'HTTP 500', 60_000],
    ['network', 'error', 'network error', 60_000],
    ['timeout', 'error', 'timeout', 60_000],
    ['quota', 'quota', 'HTTP 403 quotaExceeded', 3_600_000],
  ]) {
    const fake = fakeYouTube({ search: [id(1)], videos: [item(id(1))] });
    const { yt, logs } = clientFor(fake, { now: () => clock, timeoutMs: 20 });
    fake.mode = mode;
    assert.deepEqual(await yt.searchVideos('way maker'), { ok: false, reason, videos: [] }, mode);
    assert.equal(fake.calls.length, 1);
    assert.ok(logs[0].includes(logged), `${mode}: ${logs[0]}`);
    assert.ok(logs.every((l) => !l.includes(KEY)), 'the key is never logged, even when YouTube’s error text holds it');

    // While paused nothing is called, whatever YouTube would now say.
    fake.mode = 'ok';
    const paused = await yt.searchVideos('way maker');
    assert.deepEqual(paused, { ok: false, reason: mode === 'quota' ? 'quota' : 'paused', videos: [] }, mode);
    assert.equal(fake.calls.length, 1);
    clock += pauseMs + 1;
    assert.equal((await yt.searchVideos('way maker')).ok, true, `${mode}: calls again after the pause`);
  }
});

test('a refused key or a strange body is an error without a pause; details failing fails the search', async () => {
  const fake = fakeYouTube({ search: [id(1)], videos: [item(id(1))] });
  const { yt } = clientFor(fake);
  for (const mode of ['forbidden', 'html', 'null']) {
    fake.mode = mode;
    assert.deepEqual(await yt.searchVideos('way maker'), { ok: false, reason: 'error', videos: [] }, mode);
  }
  fake.mode = 'ok';
  assert.equal((await yt.searchVideos('way maker')).ok, true, 'no pause after those');

  // search.list answers, videos.list fails: not "nothing found".
  const real = fake.fetch;
  const half = { ...fake, fetch: (url, init) => (new URL(url).pathname.endsWith('/videos') ? Promise.resolve(new Response('{}', { status: 500 })) : real(url, init)) };
  const r = await createYouTube({ apiKey: KEY, fetch: half.fetch }).searchVideos('way maker');
  assert.deepEqual(r, { ok: false, reason: 'error', videos: [] });

  const wrongKey = await createYouTube({ apiKey: 'wrong', fetch: real }).searchVideos('way maker');
  assert.deepEqual(wrongKey, { ok: false, reason: 'error', videos: [] });
});
