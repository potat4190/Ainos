// End-to-end smoke test against a running Ainos (local or deployed).
//
//   node scripts/smoke.js https://your-app.vercel.app
//   VERCEL_AUTOMATION_BYPASS_SECRET=... node scripts/smoke.js https://<protected preview>
//
// Signs in with "Try the demo" (which resets the shared demo account to its
// snapshot), walks every API route, plays with a temporary playlist (deleted
// at the end) and fetches a signed audio range.
import { headerProblems } from './check-headers.js';

const base = (process.argv[2] || 'http://127.0.0.1:4321').replace(/\/$/, '');
// Vercel previews sit behind Deployment Protection; its "Protection Bypass for
// Automation" secret gets the script through.
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
const get = (url, headers = {}) => fetch(base + url, { headers: { ...bypass, ...headers } });
let cookie = '';
let failures = 0;

async function call(method, url, body, { expect = 200, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...bypass, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: base, ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const ok = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${res.status} ${method} ${url}${ok ? '' : '  ' + text.slice(0, 200)}`);
  if (!ok) failures++;
  return { status: res.status, json, text, headers: res.headers };
}

const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

await call('GET', '/', undefined);
await call('GET', '/api/home', undefined, { expect: 401 });

// Security headers on a static page (vercel.json on Vercel) and on an API
// response (SECURITY_HEADERS in server/app.js). HSTS only over HTTPS.
for (const url of ['/', '/api/me']) {
  const problems = headerProblems((await get(url)).headers, { https: base.startsWith('https:') });
  check(!problems.length, `security headers on ${url}${problems.length ? ': ' + problems.join('; ') : ''}`);
}
await call('POST', '/api/auth/demo', {});
const me = (await call('GET', '/api/me')).json;
check(me?.username === 'demo' && me?.is_demo === true, 'signed in to the demo');
const lib = (await call('GET', '/api/me/library')).json;
check(lib?.playlists?.length >= 2 && lib?.liked_count > 0 && lib?.artists?.length > 0, 'the demo account has playlists, likes and follows');
const recentAtStart = (await call('GET', '/api/me/recent')).json;
check(recentAtStart?.tracks?.length > 0, 'the demo account has listening history');

const home = (await call('GET', '/api/home')).json;
check(home?.recommended?.length > 0 && home?.popular?.length > 0 && home?.made_for_you?.length > 0, 'home has recommendations, popular and mixes');
for (const lang of ['hi', 'ne', 'zh', 'ja', 'es']) {
  const h = (await call('GET', `/api/home?lang=${lang}`)).json;
  check(h?.recommended?.every((t) => t.language === lang), `home ?lang=${lang} recommends only ${lang} songs`);
}
const track = home.popular[0];
await call('GET', '/api/made-for-you/discover-weekly');
await call('GET', '/api/made-for-you/daily-mix-1', undefined, { expect: [200, 404] });
await call('GET', `/api/radio/${track.id}`);
const search = (await call('GET', '/api/search?q=' + encodeURIComponent(track.title.split(' ')[0]))).json;
check(search?.tracks?.length > 0, 'search finds tracks');
await call('GET', '/api/browse/genres');
await call('GET', `/api/genres/${encodeURIComponent(track.genre)}`);
await call('GET', `/api/tracks?ids=${track.id}`);
await call('GET', `/api/tracks/${track.id}`);
await call('GET', `/api/albums/${track.album.id}`);
await call('GET', `/api/artists/${track.artist.id}`);
await call('GET', '/api/me/library');
await call('GET', '/api/me/liked');
await call('GET', '/api/me/liked/ids');
await call('GET', '/api/me/recent');
await call('GET', '/api/me/stats');
await call('GET', '/api/internals');
await call('GET', '/api/connect/devices');

// Audio: a signed range request works, an unsigned one is refused.
const manifest = (await call('GET', `/api/tracks/${track.id}/manifest`)).json;
const media = await get(manifest.file.url, { Range: 'bytes=0-1023' });
check(media.status === 206 && (await media.arrayBuffer()).byteLength === 1024, `signed media range request -> ${media.status}`);
const unsigned = await get(manifest.file.url.split('?')[0]);
check(unsigned.status === 403, `unsigned media refused -> ${unsigned.status}`);
const art = await get(track.album.cover);
check(art.status === 200 && /svg/.test(art.headers.get('content-type') || ''), `album art -> ${art.status}`);
const doc = await get('/docs/HOW-SPOTIFY-WORKS.md');
check(doc.status === 200, `evidence report -> ${doc.status}`);

// Phase 1: the public-domain hymns are in the catalog and play.
check(home.editorial?.some((p) => p.name === 'Hymns'), 'home lists the Hymns playlist');
const hymn = (await call('GET', '/api/search?q=amazing%20grace')).json?.tracks?.find((t) => t.title === 'Amazing Grace');
check(hymn?.genre === 'Hymn', 'search finds the Amazing Grace hymn');
if (hymn) {
  const hm = (await call('GET', `/api/tracks/${hymn.id}/manifest`)).json;
  const audio = await get(hm.file.url, { Range: 'bytes=0-1023' });
  check(audio.status === 206 && (await audio.arrayBuffer()).byteLength === 1024, `hymn audio streams -> ${audio.status}`);
}

// Phase 2: Scripture next to songs. The public-domain fallback counts as a
// pass (no key, or YouVersion trouble); `source` says which text came back.
if (hymn) {
  const refs = (await call('GET', `/api/songs/${hymn.song_id}/scripture`)).json;
  const first = refs?.groups?.[0]?.references?.[0];
  check(!!first, 'the hymn lists its Scripture');
  if (first) {
    const p = (await call('GET', `/api/scripture/${first.usfm}`)).json;
    check(!!p?.reference && (p.text === null || !!p.version?.abbreviation), `its passage answers, with attribution when there is text (${p?.source})`);
  }
}
// Phases 3-4: songs in search (the curated official video, from the local
// index only) and a hymn's lyrics with their synced timings.
const carry = (await call('GET', '/api/search?q=carry%20my%20cross')).json?.songs?.items?.find((x) => x.name === 'Carry My Cross');
const video = carry?.sources?.find((x) => x.source === 'youtube');
check(video?.youtube?.videoId === 'eov9K7ALYKk' && video.youtube.title === 'Carry My Cross - Official Lyric Video' && video.youtube.channelTitle === 'Victory Worship'
  && /^https:\/\/i\.ytimg\.com\//.test(video.youtube.thumbnail || ''), 'search "carry my cross" finds the official Victory Worship video');
const csp = (await get('/')).headers.get('content-security-policy') || '';
check(/frame-src https:\/\/www\.youtube\.com/.test(csp) && /script-src 'self' https:\/\/www\.youtube\.com/.test(csp), 'the CSP allows the YouTube embed');
if (hymn?.song_id) {
  const lyrics = (await call('GET', `/api/songs/${hymn.song_id}`)).json;
  const rec = lyrics?.sources?.find((x) => x.source === 'ainos');
  check(lyrics?.sections?.length > 0 && rec?.timings?.[0]?.timings?.length > 0, 'the hymn has lyrics and synced timings');
  if (rec) check((await call('GET', `/api/sources/${rec.id}/timings?lang=en`)).json?.timings?.length > 0, 'its recording’s timings route answers');
}
const votd = (await call('GET', '/api/scripture/votd')).json;
check(!!votd?.reference, `Verse of the Day (${votd?.source})`);
await call('GET', '/api/scripture/NOPE.1', undefined, { expect: 400 });

// Writes: like/unlike, follow/unfollow, a temporary playlist, an event, the language.
// Only undo what this script changed, so the demo account keeps its own likes,
// follows and language. The one event sent is a pause with no track, which
// stays out of recently played, stats and recommendations.
const likedBefore = (await call('GET', '/api/me/liked/ids')).json.ids.includes(track.id);
const followedBefore = (await call('GET', `/api/artists/${track.artist.id}`)).json.following;
await call('PUT', `/api/me/liked/${track.id}`);
await call('PUT', `/api/me/following/${track.artist.id}`);
const p = (await call('POST', '/api/playlists', { name: 'Smoke Test', is_public: true, track_ids: home.popular.slice(0, 3).map((t) => t.id) }, { expect: 201 })).json;
await call('POST', `/api/playlists/${p.id}/tracks`, { track_ids: [home.popular[3].id] });
const moved = (await call('POST', `/api/playlists/${p.id}/move`, { from: 0, to: 3 })).json;
check(moved?.tracks?.map((t) => t.position).join() === '0,1,2,3', 'playlist positions stay contiguous after a move');
await call('DELETE', `/api/playlists/${p.id}/tracks/0`);
await call('PATCH', `/api/playlists/${p.id}`, { name: 'Smoke Test Renamed' });
// Everyone shares the demo account, so its playlists never become public or searchable.
check(p?.is_public === false, 'demo playlists are created private');
await call('PATCH', `/api/playlists/${p.id}`, { is_public: true }, { expect: 403 });
const found = (await call('GET', '/api/search?q=smoke%20test%20renamed')).json;
check(found && !found.playlists?.some((x) => x.id === p.id), 'demo playlists stay out of search');
await call('DELETE', `/api/playlists/${p.id}`);
const ev = (await call('POST', '/api/events', { events: [{ type: 'pause', device_id: 'smoke-test', ts: Date.now() }] })).json;
check(ev?.accepted === 1 && ev?.streams_counted === 0, 'event accepted');
if (!likedBefore) await call('DELETE', `/api/me/liked/${track.id}`);
if (!followedBefore) await call('DELETE', `/api/me/following/${track.artist.id}`);
await call('POST', '/api/me/language', { language: me.language }); // the endpoint works; the saved language stays as it was
await call('POST', '/api/playlists', { name: 'evil' }, { expect: 403, headers: { Origin: 'https://evil.example' } });
// Phase 5: the listener demo can't make a church.
await call('POST', '/api/orgs', { name: 'Smoke Church' }, { expect: 403 });
await call('POST', '/api/auth/logout', {});
await call('GET', '/api/me', undefined, { expect: 401 });

// Phases 5-6: the church demo signs in, sees only its demo church, and its
// setlist builds slides (song slides with timings, a Scripture reading).
await call('POST', '/api/auth/church-demo', {});
const orgs = (await call('GET', '/api/me/orgs')).json;
check(orgs?.length === 1, 'the church demo sees exactly one church');
if (orgs?.length) {
  const org = orgs[0];
  const setlists = (await call('GET', `/api/orgs/${org.id}/setlists`)).json;
  check(setlists?.length >= 1 && setlists[0].item_count >= 5, 'the demo church has its seeded setlist');
  if (setlists?.length) {
    const deck = (await call('GET', `/api/orgs/${org.id}/setlists/${setlists[0].id}/slides`)).json;
    const songs = deck?.items?.filter((i) => i.kind === 'song') || [];
    check(songs.length >= 3 && songs.every((i) => i.slides.length > 0), 'setlist songs have slides');
    check(songs.some((i) => i.hasTimings && i.slides.some((s) => Number.isFinite(s.startMs))), 'a hymn has timed slides for automatic mode');
    check(deck?.items?.some((i) => i.kind === 'scripture' && i.slides[0]?.lines?.length), 'the Scripture reading has a slide');
  }
  await call('POST', '/api/orgs', { name: 'Another Church' }, { expect: 403 });
  await call('GET', '/api/orgs/no-such-org', undefined, { expect: 404 });
}
await call('POST', '/api/auth/logout', {});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
