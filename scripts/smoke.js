// End-to-end smoke test against a running Ainos (local or deployed).
//
//   node scripts/smoke.js https://your-app.vercel.app
//
// Logs in as the demo account, walks every API route, plays with a temporary
// playlist (deleted at the end) and fetches a signed audio range.
const base = (process.argv[2] || 'http://127.0.0.1:4321').replace(/\/$/, '');
let cookie = '';
let failures = 0;

async function call(method, url, body, { expect = 200, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: base, ...headers },
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
await call('POST', '/api/auth/login', { username: 'demo', password: 'ainos-demo' });
const me = (await call('GET', '/api/me')).json;
check(me?.username === 'demo', 'logged in as demo');

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
const media = await fetch(base + manifest.file.url, { headers: { Range: 'bytes=0-1023' } });
check(media.status === 206 && (await media.arrayBuffer()).byteLength === 1024, `signed media range request -> ${media.status}`);
const unsigned = await fetch(base + manifest.file.url.split('?')[0]);
check(unsigned.status === 403, `unsigned media refused -> ${unsigned.status}`);
const art = await fetch(base + track.album.cover);
check(art.status === 200 && /svg/.test(art.headers.get('content-type') || ''), `album art -> ${art.status}`);
const doc = await fetch(base + '/docs/HOW-SPOTIFY-WORKS.md');
check(doc.status === 200, `evidence report -> ${doc.status}`);

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
const found = (await call('GET', '/api/search?q=smoke%20test%20renamed')).json;
check(found?.playlists?.some((x) => x.id === p.id), 'renamed public playlist is searchable');
await call('DELETE', `/api/playlists/${p.id}`);
await call('POST', '/api/events', { events: [{ type: 'play_start', track_id: track.id, ts: Date.now() }, { type: 'play_end', track_id: track.id, ms_played: 1000, reason: 'fwdbtn', ts: Date.now() }] });
if (!likedBefore) await call('DELETE', `/api/me/liked/${track.id}`);
if (!followedBefore) await call('DELETE', `/api/me/following/${track.artist.id}`);
await call('POST', '/api/me/language', { language: 'en' });
await call('POST', '/api/playlists', { name: 'evil' }, { expect: 403, headers: { Origin: 'https://evil.example' } });
await call('POST', '/api/auth/logout', {});
await call('GET', '/api/me', undefined, { expect: 401 });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
