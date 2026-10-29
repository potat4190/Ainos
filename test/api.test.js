import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, client, login, signup } from './helpers.js';

let srv, demo;
before(async () => {
  srv = await startTestServer();
  demo = await login(srv.base);
});
after(() => srv.close());

const firstTrack = async (c) => (await c.get('/api/home')).json.popular[0];

// ---------------------------------------------------------------- auth
test('API requires a session', async () => {
  const r = await client(srv.base).get('/api/home');
  assert.equal(r.status, 401);
});

test('login rejects a wrong password and sets an HttpOnly cookie on success', async () => {
  const bad = await client(srv.base).post('/api/auth/login', { username: 'demo', password: 'nope-nope' });
  assert.equal(bad.status, 401);
  const c = client(srv.base);
  const ok = await c.post('/api/auth/login', { username: 'demo', password: 'ainos-demo' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);
});

test('signup validates input and refuses duplicates; simulated users cannot log in', async () => {
  assert.equal((await client(srv.base).post('/api/auth/signup', { username: 'x', password: 'longenough' })).status, 400);
  assert.equal((await client(srv.base).post('/api/auth/signup', { username: 'shortpw', password: '123' })).status, 400);
  assert.equal((await client(srv.base).post('/api/auth/signup', { username: 'demo', password: 'longenough' })).status, 409);
  assert.equal((await client(srv.base).post('/api/auth/login', { username: 'listener1', password: 'anything-at-all' })).status, 401);
  const c = await signup(srv.base, 'newbie');
  const me = (await c.get('/api/me')).json;
  assert.equal(me.language, 'en');
});

test('logout ends the session', async () => {
  const c = await signup(srv.base, 'leaver');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

// ------------------------------------------------------------ streaming
test('manifest returns a signed URL, seek table and normalization gain', async () => {
  const t = await firstTrack(demo);
  const m = (await demo.get(`/api/tracks/${t.id}/manifest`)).json;
  assert.equal(m.file.quality, 'high');
  assert.match(m.file.url, /^\/media\/high\/\w{22}\.wav\?exp=\d+&sig=[\w-]+$/);
  assert.equal(m.seektable.bytes_per_second, 44100);
  assert.equal(m.normalization.target_lufs, -14);
  assert.ok(m.normalization.gain_db <= -1 - m.normalization.peak_db + 1e-9, 'gain never pushes peaks past -1 dBFS');
});

test('media supports byte ranges and rejects bad or missing signatures', async () => {
  const t = await firstTrack(demo);
  const { url } = (await demo.get(`/api/tracks/${t.id}/manifest`)).json.file;
  const part = await fetch(srv.base + url, { headers: { Range: 'bytes=0-16383' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 16384);
  assert.match(part.headers.get('content-range'), /^bytes 0-16383\/\d+$/);
  const head = Buffer.from(await (await fetch(srv.base + url, { headers: { Range: 'bytes=0-11' } })).arrayBuffer());
  assert.equal(head.toString('ascii', 0, 4), 'RIFF');
  const suffix = await fetch(srv.base + url, { headers: { Range: 'bytes=-100' } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 100);
  const bad = await fetch(srv.base + url, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(bad.status, 416);

  const path = url.split('?')[0];
  assert.equal((await fetch(srv.base + path)).status, 403);
  assert.equal((await fetch(srv.base + url.replace(/sig=./, 'sig=A'))).status, 403);
  const expired = url.replace(/exp=\d+/, 'exp=1000');
  assert.equal((await fetch(srv.base + expired)).status, 403);
});

test('all users can stream high quality and switch languages for recommendations', async () => {
  const c = await signup(srv.base, 'worshipper');
  const t = await firstTrack(c);
  const hi = (await c.get(`/api/tracks/${t.id}/manifest?quality=high`)).json;
  assert.equal(hi.file.quality, 'high');
  assert.equal(hi.available_qualities.find((q) => q.quality === 'high').allowed, true);

  for (const lang of ['en', 'hi', 'ne', 'zh', 'ja', 'es']) {
    const res = await c.post('/api/me/language', { language: lang });
    assert.equal(res.status, 200);
    assert.equal(res.json.language, lang);
    const home = (await c.get(`/api/home?lang=${lang}`)).json;
    assert.equal(home.language, lang);
    assert.ok(home.recommended.length > 0, `has recommended songs for ${lang}`);
    assert.ok(home.recommended.every((tr) => tr.language === lang), `all recommended songs match ${lang}`);
    assert.ok(home.popular.every((tr) => tr.language === lang), `popular songs match ${lang}`);
  }
  assert.equal((await c.post('/api/me/language', { language: 'xx' })).status, 400);
});

test('single plan: no tiers or skip limits, every account gets high quality', async () => {
  const c = await signup(srv.base, 'skipper');
  const me = (await c.get('/api/me')).json;
  assert.equal(me.plan, undefined, 'no plan field any more');
  assert.equal(me.limits, undefined, 'no skip or quality limits');
  const t = await firstTrack(c);
  const skips = Array.from({ length: 12 }, () => ({ type: 'play_end', track_id: t.id, device_id: 'd', ms_played: 2_000, reason: 'fwdbtn' }));
  assert.equal((await c.post('/api/events', { events: skips })).json.accepted, 12, 'a dozen skips in an hour are all accepted');
  const m = (await c.get(`/api/tracks/${t.id}/manifest`)).json;
  assert.equal(m.file.quality, 'high', 'still high quality after many skips');
  assert.ok(m.available_qualities.length >= 2 && m.available_qualities.every((q) => q.allowed));
  assert.equal((await c.get(`/api/tracks/${t.id}/manifest?quality=low`)).json.file.quality, 'low', 'low stays available as a data saver');
  assert.equal((await c.post('/api/me/plan', { plan: 'premium' })).status, 404, 'the old plan endpoint is gone');
});

test('the saved language drives recommendations without a ?lang override', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/signup', { username: 'polyglot', password: 'correct horse battery', language: 'ja' })).status, 201);
  assert.equal((await c.get('/api/me')).json.language, 'ja', 'signup stores the chosen language');
  let home = (await c.get('/api/home')).json;
  assert.equal(home.language, 'ja');
  const ja = home.recommended.map((t) => t.id);
  assert.ok(ja.length > 0 && home.recommended.every((t) => t.language === 'ja'));

  await c.post('/api/me/language', { language: 'es' });
  assert.equal((await c.get('/api/me')).json.language, 'es', 'language change persists across requests');
  home = (await c.get('/api/home')).json;
  assert.equal(home.language, 'es');
  assert.ok(home.recommended.length > 0 && home.recommended.every((t) => t.language === 'es'));
  assert.ok(!home.recommended.some((t) => ja.includes(t.id)), 'switching language replaces the recommendations');
  assert.ok(home.popular.length > 0 && home.popular.every((t) => t.language === 'es'));
});

test('Discover Weekly puts songs in the requested language first', async () => {
  for (const lang of ['zh', 'ja', 'es']) {
    const dw = (await demo.get(`/api/made-for-you/discover-weekly?lang=${lang}`)).json;
    assert.ok(dw.tracks.length >= 2);
    assert.equal(dw.tracks[0].language, lang, `first Discover Weekly pick is in ${lang}`);
  }
  const en = (await demo.get('/api/made-for-you/discover-weekly?lang=en')).json;
  const zh = (await demo.get('/api/made-for-you/discover-weekly?lang=zh')).json;
  assert.notDeepEqual(en.tracks.map((t) => t.id), zh.tracks.map((t) => t.id), 'each language has its own weekly snapshot');
});

// --------------------------------------------------------------- events
test('a play counts as a stream only at 30 seconds or more', async () => {
  const c = await signup(srv.base, 'counter');
  const t = await firstTrack(c);
  const r = await c.post('/api/events', { events: [
    { type: 'play_start', track_id: t.id, device_id: 'test-device', reason: 'clickrow' },
    { type: 'play_end', track_id: t.id, device_id: 'test-device', ms_played: 29_999, reason: 'fwdbtn' },
    { type: 'play_end', track_id: t.id, device_id: 'test-device', ms_played: 30_000, reason: 'trackdone' },
    { type: 'not_a_type', track_id: t.id },
    { type: 'play_end', track_id: 'doesnotexist', ms_played: 99_999 },
  ] });
  assert.deepEqual(r.json, { accepted: 3, rejected: 2, streams_counted: 1 });
  const stats = (await c.get('/api/me/stats')).json;
  assert.equal(stats.streams, 1);
  assert.equal(stats.short_plays, 1);
});

test('listening hours follow the listener’s time zone', async () => {
  const c = await signup(srv.base, 'nightowl');
  const t = await firstTrack(c);
  const before = Date.now();
  await c.post('/api/events', { events: [{ type: 'play_end', track_id: t.id, device_id: 'd', ms_played: 40_000, reason: 'trackdone' }] });
  const after = Date.now();
  const hourIn = (tz, ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms)) % 24;
  for (const tz of ['UTC', 'Asia/Kathmandu', 'America/New_York']) {
    const { hours } = (await c.get(`/api/me/stats?tz=${encodeURIComponent(tz)}`)).json;
    assert.ok(hours[hourIn(tz, before)] === 1 || hours[hourIn(tz, after)] === 1, tz);
  }
  const unknown = (await c.get('/api/me/stats?tz=Not%2FA_Zone')).json;
  assert.equal(unknown.hours.reduce((s, n) => s + n, 0), 1, 'an unknown zone falls back to the server clock');
});

test('events are also written to hourly NDJSON buckets', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(srv.dataDir, 'events');
  const isBucket = (f) => /^\d{4}-\d{2}-\d{2}T\d{2}\.ndjson$/.test(f);
  for (let i = 0; i < 20 && !fs.readdirSync(dir).some(isBucket); i++) await new Promise((r) => setTimeout(r, 50)); // append is async
  const file = fs.readdirSync(dir).find(isBucket);
  assert.ok(file, 'an hourly bucket exists');
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.type === 'play_end' && e.ms_played === 30000));
});

test('event batches are size-limited', async () => {
  const r = await demo.post('/api/events', { events: Array.from({ length: 201 }, () => ({ type: 'pause' })) });
  assert.equal(r.status, 413);
});

// ------------------------------------------------------------ playlists
test('playlist lifecycle: create, add, reorder, remove, rename, delete', async () => {
  const c = await signup(srv.base, 'curator');
  const tracks = (await c.get('/api/home')).json.popular.slice(0, 3);
  const p = (await c.post('/api/playlists', { name: 'Road Trip' })).json;
  assert.equal(p.name, 'Road Trip');
  await c.post(`/api/playlists/${p.id}/tracks`, { track_ids: tracks.map((t) => t.id) });
  let got = (await c.get(`/api/playlists/${p.id}`)).json;
  assert.deepEqual(got.tracks.map((t) => t.id), tracks.map((t) => t.id));
  got = (await c.post(`/api/playlists/${p.id}/move`, { from: 0, to: 2 })).json;
  assert.deepEqual(got.tracks.map((t) => t.id), [tracks[1].id, tracks[2].id, tracks[0].id]);
  await c.del(`/api/playlists/${p.id}/tracks/0`);
  got = (await c.get(`/api/playlists/${p.id}`)).json;
  assert.deepEqual(got.tracks.map((t) => t.position), [0, 1]);
  await c.patch(`/api/playlists/${p.id}`, { name: 'Night Drive Too', is_public: true });
  const found = (await c.get('/api/search?q=night drive too')).json;
  assert.ok(found.playlists.some((x) => x.id === p.id), 'public playlists become searchable');

  // another user can read a public playlist but cannot edit it
  const other = await signup(srv.base, 'intruder');
  assert.equal((await other.get(`/api/playlists/${p.id}`)).status, 200);
  assert.equal((await other.post(`/api/playlists/${p.id}/tracks`, { track_ids: [tracks[0].id] })).status, 403);
  assert.equal((await other.del(`/api/playlists/${p.id}`)).status, 403);

  await c.patch(`/api/playlists/${p.id}`, { is_public: false });
  assert.equal((await other.get(`/api/playlists/${p.id}`)).status, 404, 'private playlists are hidden');
  assert.equal((await c.del(`/api/playlists/${p.id}`)).status, 200);
  assert.equal((await c.get(`/api/playlists/${p.id}`)).status, 404);
});

test('removing a playlist track checks the position', async () => {
  const c = await signup(srv.base, 'tidy');
  const tracks = (await c.get('/api/home')).json.popular.slice(0, 2);
  const p = (await c.post('/api/playlists', { name: 'Tidy', track_ids: tracks.map((t) => t.id) })).json;
  for (const bad of ['abc', '1.5', '-1', '99999999999']) assert.equal((await c.del(`/api/playlists/${p.id}/tracks/${bad}`)).status, 400, bad);
  assert.equal((await c.del(`/api/playlists/${p.id}/tracks/7`)).status, 200, 'a position that is already gone is a no-op');
  assert.equal((await c.del(`/api/playlists/${p.id}/tracks/0`)).status, 200);
  const got = (await c.get(`/api/playlists/${p.id}`)).json;
  assert.deepEqual(got.tracks.map((t) => [t.id, t.position]), [[tracks[1].id, 0]]);
});

test('likes and follows', async () => {
  const c = await signup(srv.base, 'fan');
  const t = await firstTrack(c);
  await c.put(`/api/me/liked/${t.id}`);
  await c.put(`/api/me/liked/${t.id}`); // idempotent
  assert.deepEqual((await c.get('/api/me/liked/ids')).json.ids, [t.id]);
  await c.put(`/api/me/following/${t.artist.id}`);
  const artist = (await c.get(`/api/artists/${t.artist.id}`)).json;
  assert.equal(artist.following, true);
  assert.equal((await c.put('/api/me/liked/nope')).status, 404);
});

// -------------------------------------------------------------- search
test('search uses prefix matching and ranks titles', async () => {
  const r = (await demo.get('/api/search?q=neon')).json;
  assert.equal(r.top.kind, 'artist');
  assert.equal(r.top.item.name, 'Neon Harbor');
  assert.ok(r.tracks.length >= 4);
  const empty = (await demo.get('/api/search?q=%22%27%29(')).json;
  assert.deepEqual(empty.tracks, []);
});

// ---------------------------------------------------- recommendations
test('Discover Weekly only contains unheard tracks and at most 2 per artist', async () => {
  const dw = (await demo.get('/api/made-for-you/discover-weekly')).json;
  assert.ok(dw.tracks.length >= 5);
  const recent = (await demo.get('/api/me/stats')).json;
  const heard = new Set(recent.top_tracks.map((t) => t.id));
  for (const t of dw.tracks) assert.ok(!heard.has(t.id), `${t.title} was already heard`);
  const perArtist = {};
  for (const t of dw.tracks) perArtist[t.artist.id] = (perArtist[t.artist.id] || 0) + 1;
  assert.ok(Object.values(perArtist).every((n) => n <= 2));
  const again = (await demo.get('/api/made-for-you/discover-weekly')).json;
  assert.deepEqual(again.tracks.map((t) => t.id), dw.tracks.map((t) => t.id), 'stable within the week');
});

test('radio starts with the seed and prefers the same genre', async () => {
  const t = await firstTrack(demo);
  const r = (await demo.get(`/api/radio/${t.id}`)).json;
  assert.equal(r.tracks[0].id, t.id);
  assert.equal(new Set(r.tracks.map((x) => x.id)).size, r.tracks.length, 'no duplicates');
  assert.ok(r.tracks.slice(1, 4).some((x) => x.genre === t.genre), 'a same-genre track is among the nearest neighbours');
});

test('item similarity follows co-listening: most neighbours share the seed genre', async () => {
  const rec = srv.app.recommender;
  const tracks = (await rec.ready()).tracks;
  let same = 0;
  for (const t of tracks) same += (await rec.similarTracks(t.id, 3)).filter((s) => tracks.find((x) => x.id === s.id).genre === t.genre).length;
  assert.ok(same / tracks.length >= 1.5, `avg same-genre neighbours ${(same / tracks.length).toFixed(2)}`);
});

test('retraining is rate-limited across all users', async () => {
  const other = await signup(srv.base, 'tinkerer');
  assert.equal((await demo.post('/api/internals/retrain')).status, 200);
  assert.equal((await other.post('/api/internals/retrain')).status, 200);
  assert.equal((await demo.post('/api/internals/retrain')).status, 429);
});

test('home is personalized and includes made-for-you mixes', async () => {
  const h = (await demo.get('/api/home')).json;
  assert.ok(h.made_for_you.some((m) => m.kind === 'discover-weekly'));
  assert.ok(h.made_for_you.some((m) => m.kind.startsWith('daily-mix')));
  assert.equal(h.editorial.length, 6);
});

// ------------------------------------------------------------- security
test('cross-origin writes are refused', async () => {
  const r = await demo.post('/api/playlists', { name: 'evil' }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

// A logged-in browser visiting another site must not be able to change
// anything here: every state-changing method checks where the request came from.
test('CSRF: writes from another origin are refused for every method; same-origin writes work', async () => {
  const send = (method, url, headers = {}) => fetch(srv.base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: demo.cookie, ...headers }, body: method === 'DELETE' ? undefined : '{}',
  });
  const own = new URL(srv.base);
  const refused = [
    { Origin: 'http://evil.example' },
    { Origin: 'null' }, // sandboxed iframes and some redirects
    { Origin: `https://${own.host}` }, // right host, wrong scheme
    { Origin: `http://${own.hostname}:1` }, // right host name, wrong port
    // Forwarded headers mean nothing without a proxy in front.
    { Origin: 'http://evil.example', 'X-Forwarded-Host': 'evil.example' },
    // No Origin, but the browser says the request came from another site.
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ];
  for (const [method, url] of [['POST', '/api/me/language'], ['PUT', '/api/me/liked/x'], ['PATCH', '/api/playlists/x'], ['DELETE', '/api/me/liked/x']]) {
    for (const headers of refused) {
      const r = await send(method, url, headers);
      assert.equal(r.status, 403, `${method} ${url} ${JSON.stringify(headers)}`);
    }
  }
  const lang = (headers) => fetch(srv.base + '/api/me/language', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: demo.cookie, ...headers }, body: JSON.stringify({ language: 'en' }),
  });
  assert.equal((await lang({ Origin: srv.base })).status, 200, 'same origin');
  assert.equal((await lang({ 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'no Origin, same-origin fetch');
  assert.equal((await lang({})).status, 200, 'no Origin at all (curl, older browsers)');
});

test('CSRF: behind the proxy, the forwarded host and scheme are the app origin', async () => {
  const { sameOrigin } = await import('../server/app.js');
  const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });
  const vercel = { host: 'internal:3000', 'x-forwarded-host': 'ainos.example', 'x-forwarded-proto': 'https' };
  assert.equal(sameOrigin(req({ ...vercel, origin: 'https://ainos.example' }), { trustProxy: true }), true);
  assert.equal(sameOrigin(req({ ...vercel, origin: 'http://ainos.example' }), { trustProxy: true }), false, 'scheme must match');
  assert.equal(sameOrigin(req({ ...vercel, origin: 'https://evil.example' }), { trustProxy: true }), false);
  assert.equal(sameOrigin(req({ ...vercel, origin: 'https://ainos.example' })), false, 'forwarded headers ignored without trustProxy');
  assert.equal(sameOrigin(req({ host: 'ainos.example', origin: 'https://ainos.example:443' }, true)), true, 'default port');
  assert.equal(sameOrigin(req({ origin: 'https://ainos.example' })), false, 'no Host header');
});

test('session cookies are HttpOnly and SameSite=Lax, and Secure over HTTPS', async () => {
  const signin = (headers = {}) => fetch(srv.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'demo', password: 'ainos-demo' }),
  });
  const plain = (await signin()).headers.get('set-cookie');
  assert.match(plain, /; HttpOnly/);
  assert.match(plain, /; SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/, 'plain HTTP (local dev) cannot use Secure cookies');
  const tls = await signin({ 'X-Forwarded-Proto': 'https' });
  assert.match(tls.headers.get('set-cookie'), /; Secure/);
  const out = await fetch(srv.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: tls.headers.get('set-cookie').split(';')[0], 'X-Forwarded-Proto': 'https' } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0.*; Secure|; Secure.*Max-Age=0/, 'the clearing cookie matches the one it replaces');
});

test('static files cannot escape their folders', async () => {
  for (const p of ['/art/..%2Fsecret.key', '/art/../secret.key', '/docs/..%2F..%2Fpackage.json', '/..%2Fdata%2Fsecret.key']) {
    const r = await fetch(srv.base + p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(await r.text(), /^[0-9a-f]{64}$/);
  }
});

test('security headers are set', async () => {
  const r = await fetch(srv.base + '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // YouTube embeds identify the app by its origin in the Referer header; a
  // stricter policy (same-origin, no-referrer) breaks them.
  for (const url of ['/', '/api/me']) assert.equal((await fetch(srv.base + url)).headers.get('referrer-policy'), 'strict-origin-when-cross-origin', url);
});

test('vercel.json gives static files the same security headers as the app', async () => {
  const fs = await import('node:fs');
  const { SECURITY_HEADERS } = await import('../server/app.js');
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const all = config.headers.find((x) => x.source === '/(.*)');
  assert.deepEqual(Object.fromEntries(all.headers.map((x) => [x.key, x.value])), SECURITY_HEADERS);
});

test('unknown routes 404, wrong methods 405, bad JSON 400', async () => {
  assert.equal((await demo.get('/api/nope')).status, 404);
  assert.equal((await demo.put('/api/home')).status, 405);
  const bad = await fetch(srv.base + '/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: demo.cookie }, body: '{nope' });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- try the demo
// Its own server: these tests reset the demo account, which the tests above rely on.
const DEMO_LIMIT = 10;
let demoSrv;
after(() => demoSrv?.close());
const tryDemo = async (body = {}) => {
  const c = client(demoSrv.base);
  const r = await c.post('/api/auth/demo', body);
  return { c, r };
};
const demoState = async (c) => {
  const [lib, liked, recent, stats] = await Promise.all(['/api/me/library', '/api/me/liked/ids', '/api/me/recent', '/api/me/stats'].map((u) => c.get(u)));
  return {
    playlists: lib.json.playlists.map((p) => [p.name, p.track_count]).sort(),
    artists: lib.json.artists.map((a) => a.id).sort(),
    liked: liked.json.ids.slice().sort(),
    recent: recent.json.tracks.length,
    streams: stats.json.streams,
    short_plays: stats.json.short_plays,
  };
};

test('try the demo: one request signs in, with no password on the client', async () => {
  demoSrv = await startTestServer({ demoSignInsPerMinute: DEMO_LIMIT });
  const { c, r } = await tryDemo({ language: 'es' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /Max-Age=86400(;|$)/, 'demo sessions last a day, not 30');
  const me = (await c.get('/api/me')).json;
  assert.equal(me.username, 'demo');
  assert.equal(me.is_demo, true);
  assert.equal(me.language, 'es', 'the language picked on the sign-in screen');
  const html = await (await fetch(demoSrv.base + '/js/app.js')).text();
  assert.doesNotMatch(html, /ainos-demo/, 'the demo password is not in the client code');
});

test('the demo account looks lived-in: library, likes, history and mixes', async () => {
  const { c } = await tryDemo();
  const s = await demoState(c);
  assert.deepEqual(s.playlists.map(([n]) => n), ['Quiet Time Devotion', 'Sunday Morning Worship']);
  assert.ok(s.playlists.every(([, n]) => n >= 4), 'playlists have songs');
  assert.ok(s.liked.length >= 5 && s.artists.length >= 2);
  assert.ok(s.recent >= 8 && s.streams >= 40 && s.short_plays >= 3);
  const home = (await c.get('/api/home')).json;
  assert.ok(home.recent.length > 0, 'recently played');
  assert.ok(home.made_for_you.some((m) => m.kind === 'discover-weekly') && home.made_for_you.some((m) => m.kind.startsWith('daily-mix')));
  assert.ok(home.recommended.length > 0);
  const dw = (await c.get('/api/made-for-you/discover-weekly')).json;
  assert.ok(dw.tracks.length >= 5);
});

test('each demo sign-in puts back the same snapshot, whatever the last visitor did', async () => {
  const { c: first } = await tryDemo();
  const before = await demoState(first);
  // A visitor tidies everything away and adds their own things.
  const lib = (await first.get('/api/me/library')).json;
  for (const p of lib.playlists) await first.del(`/api/playlists/${p.id}`);
  for (const id of before.liked) await first.del(`/api/me/liked/${id}`);
  for (const id of before.artists) await first.del(`/api/me/following/${id}`);
  const track = (await first.get('/api/home')).json.popular.at(-1);
  await first.post('/api/playlists', { name: 'Mine now', track_ids: [track.id] });
  await first.post('/api/me/language', { language: 'ja' });
  await first.post('/api/events', { events: [{ type: 'play_end', track_id: track.id, device_id: 'x', ms_played: 40_000, reason: 'trackdone' }] });
  const { c: next } = await tryDemo();
  assert.deepEqual(await demoState(next), before);
  assert.equal((await next.get('/api/me')).json.language, 'en');
  // The trade-off of one shared account: the first visitor is still signed in and sees the reset too.
  assert.equal((await first.get('/api/me')).status, 200);
  assert.deepEqual(await demoState(first), before);
});

test('demo playlists stay private, so visitors cannot put text in everyone’s search', async () => {
  const { c } = await tryDemo();
  const p = (await c.post('/api/playlists', { name: 'Zzyzx demo graffiti', is_public: true })).json;
  assert.equal(p.is_public, false);
  const r = await c.patch(`/api/playlists/${p.id}`, { is_public: true });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'demo_private');
  const other = await signup(demoSrv.base, 'searcher');
  assert.equal((await other.get('/api/search?q=zzyzx')).json.playlists.length, 0);
  // Other accounts can still share playlists.
  const mine = (await other.post('/api/playlists', { name: 'Zzyzx shared', is_public: true })).json;
  assert.equal(mine.is_public, true);
});

test('the demo password still works, and does not reset the account', async () => {
  const { c } = await tryDemo();
  const extra = (await c.get('/api/home')).json.popular.at(-1);
  await c.post('/api/playlists', { name: 'Kept', track_ids: [extra.id] });
  const pw = await login(demoSrv.base);
  assert.ok((await pw.get('/api/me/library')).json.playlists.some((p) => p.name === 'Kept'));
});

test('the demo account is created on first use, even by two sign-ins at once', async () => {
  const { store } = demoSrv.app;
  await store.run("DELETE FROM users WHERE lower(username) = 'demo'");
  const [a, b] = await Promise.all([tryDemo(), tryDemo()]);
  assert.deepEqual([a.r.status, b.r.status], [200, 200]);
  assert.equal((await store.get("SELECT COUNT(*) AS n FROM users WHERE lower(username) = 'demo'")).n, 1);
  assert.ok((await demoState(b.c)).streams >= 40);
});

test('demo sign-ins are rate-limited', async () => {
  // Earlier tests used some of this minute's allowance.
  let status = 200;
  for (let i = 0; i < DEMO_LIMIT + 1 && status === 200; i++) status = (await tryDemo()).r.status;
  assert.equal(status, 429);
  assert.ok((await signup(demoSrv.base, 'afterdemo')).cookie, 'sign-up has its own limit');
});
