// Phases 3-4 (speedrun): curated YouTube songs in search, song lyrics with
// their visibility rules, and the hymn line timings the generator writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, login, signup, client } from './helpers.js';
import { HYMN_IDS, YOUTUBE_IDS, hymnTimings, hymnOrder } from '../scripts/generate.js';
import { HYMNS } from '../scripts/hymns.js';
import { YOUTUBE_VIDEOS } from '../scripts/youtube-videos.js';

const CARRY = YOUTUBE_VIDEOS.find((v) => v.videoId === 'eov9K7ALYKk');
let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv?.close());

test('hymn timings: every recorded line once, in order, verse then refrain, with times rising', () => {
  for (const h of HYMNS) {
    const timings = hymnTimings(h);
    assert.equal(timings.length, h.audioVerses * h.lineStarts.length, h.slug);
    const order = hymnOrder(h, h.audioVerses);
    // Labels appear in the recording's arrangement order, each section's lines 0..n-1.
    const labels = timings.map((x) => x.label).filter((l, i, a) => i === 0 || a[i - 1] !== l || timings[i].line === 0);
    assert.deepEqual(labels, order, `${h.slug}: sections in recording order`);
    for (const { label, line } of timings) assert.ok(h.sections.find((s) => s.label === label).lines[line], `${h.slug} ${label}:${line} exists`);
    for (let i = 1; i < timings.length; i++) assert.ok(timings[i].ms > timings[i - 1].ms, `${h.slug}: times rise`);
  }
});

test('searching "carry my cross" finds the Victory Worship song with its official video, YouTube data unmodified', async () => {
  const c = await login(srv.base);
  const r = await c.get('/api/search?q=carry%20my%20cross');
  assert.equal(r.status, 200);
  for (const key of ['tracks', 'artists', 'albums', 'playlists']) assert.ok(Array.isArray(r.json[key]), `${key} keeps its shape`);
  const song = r.json.songs.items.find((s) => s.id === YOUTUBE_IDS.song(CARRY.videoId));
  assert.ok(song, JSON.stringify(r.json.songs));
  assert.equal(song.uri, `ainos:song:${song.id}`);
  assert.equal(song.name, 'Carry My Cross');
  assert.deepEqual(song.artist, { name: 'Victory Worship' });
  assert.equal(song.sources.length, 1);
  const [src] = song.sources;
  assert.equal(src.id, YOUTUBE_IDS.source(CARRY.videoId));
  assert.equal(src.source, 'youtube');
  assert.equal(src.playback, 'embed');
  assert.equal(src.kind, 'lyric');
  assert.deepEqual({ ...src.youtube, duration_ms: undefined }, {
    videoId: 'eov9K7ALYKk', title: 'Carry My Cross - Official Lyric Video', channelTitle: 'Victory Worship',
    thumbnail: 'https://i.ytimg.com/vi/eov9K7ALYKk/hqdefault.jpg', duration_ms: undefined,
  });
  // No lyrics of a copyrighted song anywhere: only the official embed.
  const detail = await c.get(`/api/songs/${song.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.sections, []);
  assert.deepEqual(detail.json.sources.map((s) => [s.source, s.timings]), [['youtube', []]]);
});

test('hymn songs appear in search with their native source; the top result keeps its kinds', async () => {
  const c = await login(srv.base);
  const r = (await c.get('/api/search?q=amazing%20grace')).json;
  const song = r.songs.items.find((s) => s.id === HYMN_IDS.song('amazing-grace'));
  assert.ok(song);
  assert.deepEqual(song.sources.map((s) => [s.source, s.playback, s.track?.id]), [['ainos', 'native', HYMN_IDS.track('amazing-grace')]]);
  assert.ok(['track', 'artist', 'album', 'playlist'].includes(r.top.kind));
  const empty = (await c.get('/api/search?q=')).json;
  assert.deepEqual(empty.songs, { items: [] });
});

test('GET /api/songs/:id: a hymn has its sections, arrangements and its recording with timings', async () => {
  const c = await login(srv.base);
  const h = HYMNS.find((x) => x.slug === 'it-is-well');
  const r = await c.get(`/api/songs/${HYMN_IDS.song(h.slug)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.title, h.title);
  assert.deepEqual(r.json.tracks.map((t) => t.id), [HYMN_IDS.track(h.slug)], 'existing keys unchanged');
  assert.deepEqual(r.json.sections.map((s) => s.label).sort(), h.sections.map((s) => s.label).sort());
  assert.deepEqual(r.json.sections.find((s) => s.label === 'V1').lines, h.sections.find((s) => s.label === 'V1').lines);
  assert.ok(r.json.sections.every((s) => s.org_id === null && s.language === 'en'));
  assert.deepEqual(r.json.arrangements.find((a) => a.name === 'Recording').section_order, hymnOrder(h, h.audioVerses));
  const [src] = r.json.sources;
  assert.equal(src.id, HYMN_IDS.source(h.slug));
  assert.equal(src.timings.length, 1);
  assert.deepEqual(src.timings[0].timings, hymnTimings(h));
  assert.equal(src.timings[0].offset_ms, 0);
  const only = await c.get(`/api/sources/${src.id}/timings?lang=en`);
  assert.equal(only.status, 200);
  assert.deepEqual(only.json.timings[0].timings, hymnTimings(h));
  assert.deepEqual((await c.get(`/api/sources/${src.id}/timings?lang=ne`)).json.timings, [], 'no Nepali timings');
  assert.equal((await c.get('/api/sources/nope/timings')).status, 404);
  assert.equal((await c.get(`/api/songs/${HYMN_IDS.song(h.slug)}?lang=ne`)).json.sections.length, 0, '?lang= filters sections');
});

test('org lyrics and timings are invisible to non-members, visible to members', async () => {
  const member = await signup(srv.base, 'grace-member');
  const outsider = await signup(srv.base, 'paul-outsider');
  const memberId = (await member.get('/api/me')).json.id;
  const songId = HYMN_IDS.song('amazing-grace');
  const sourceId = HYMN_IDS.source('amazing-grace');
  const db = srv.app.store;
  await db.run("INSERT INTO orgs (id, name, default_language, created_by, created_at) VALUES ('org-test-1', 'Grace Chapel', 'en', ?, 0)", [memberId]);
  await db.run("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES ('org-test-1', ?, 'member', 0)", [memberId]);
  await db.run("INSERT INTO song_sections (id, song_id, language, label, lines, folded, org_id) VALUES ('orgsec1', ?, 'en', 'V1', 'Our church''s own words', '', 'org-test-1')", [songId]);
  await db.run(`INSERT INTO song_arrangements (id, song_id, org_id, name, section_order) VALUES ('orgarr1', ?, 'org-test-1', 'Sunday', '["V1"]')`, [songId]);
  await db.run(`INSERT INTO lyric_timings (id, source_id, language, offset_ms, timings, org_id, updated_at) VALUES ('orgtim1', ?, 'en', 0, '[{"label":"V1","line":0,"ms":10}]', 'org-test-1', 0)`, [sourceId]);

  const seen = async (c) => {
    const r = (await c.get(`/api/songs/${songId}`)).json;
    const t = (await c.get(`/api/sources/${sourceId}/timings`)).json;
    return { sections: r.sections.some((s) => s.id === 'orgsec1'), arrangements: r.arrangements.some((a) => a.id === 'orgarr1'),
      timings: r.sources[0].timings.some((x) => x.id === 'orgtim1'), route: t.timings.some((x) => x.id === 'orgtim1'), global: r.sections.filter((s) => s.org_id === null).length };
  };
  const out = await seen(outsider);
  assert.deepEqual({ ...out, global: out.global > 0 }, { sections: false, arrangements: false, timings: false, route: false, global: true }, 'outsider sees global lyrics only');
  const demo = await seen(await login(srv.base));
  assert.equal(demo.sections || demo.arrangements || demo.timings || demo.route, false, 'nor does the demo');
  const mem = await seen(member);
  assert.deepEqual({ ...mem, global: mem.global > 0 }, { sections: true, arrangements: true, timings: true, route: true, global: true }, 'members see their org’s too');
});

test('the CSP allows exactly the YouTube embed, its API script and thumbnails', async () => {
  const r = await fetch(srv.base + '/api/me');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/www\.youtube\.com;/);
  assert.match(csp, /frame-src https:\/\/www\.youtube\.com;/);
  assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com;/);
  assert.doesNotMatch(csp, /\*|unsafe-inline/);
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('the frontend never builds DOM from HTML strings or inline styles (strict CSP)', () => {
  for (const f of ['youtube.js', 'views.js', 'app.js', 'player.js']) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|setAttribute\('style'|\.onerror\s*=/, f);
  }
});

test('tap-to-sync: a church leader saves its church’s timings, a catalog admin the global ones; lines and times are checked', async () => {
  let adminId;
  const own = await startTestServer({
    prepare: (dataDir) => {
      const db = new DatabaseSync(path.join(dataDir, 'ainos.db'), { readOnly: true });
      try { adminId = db.prepare('SELECT MAX(id) AS n FROM users').get().n + 1; } finally { db.close(); }
      return { adminUserIds: String(adminId) };
    },
  });
  try {
    const admin = await signup(own.base, 'catalog-admin');
    assert.equal((await admin.get('/api/me')).json.id, adminId);
    const leader = await signup(own.base, 'lea-leader');
    const member = await signup(own.base, 'max-member');
    const outsider = await signup(own.base, 'oz-outsider');
    const orgId = (await leader.post('/api/orgs', { name: 'Hillside' })).json.id;
    const memberId = (await member.get('/api/me')).json.id;
    await own.app.store.run("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 0)", [orgId, memberId]);
    // The church's own words for the YouTube song (as a paste would give them).
    const ytSong = YOUTUBE_IDS.song(CARRY.videoId);
    const ytSource = YOUTUBE_IDS.source(CARRY.videoId);
    await own.app.store.run("INSERT INTO song_sections (id, song_id, language, label, lines, folded, org_id) VALUES ('hs1', ?, 'en', 'V1', 'first line\nsecond line', '', ?)", [ytSong, orgId]);
    await own.app.store.run("INSERT INTO song_sections (id, song_id, language, label, lines, folded, org_id) VALUES ('hs2', ?, 'en', 'C', 'chorus line', '', ?)", [ytSong, orgId]);

    const url = `/api/sources/${ytSource}/timings`;
    const body = { org_id: orgId, language: 'en', offset_ms: -200, timings: [{ label: 'V1', line: 0, ms: 1000 }, { label: 'V1', line: 1, ms: 4000 }, { label: 'C', line: 0, ms: 9000 }] };
    const saved = await leader.putJson(url, body);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json.timings.map((x) => [x.org_id, x.offset_ms, x.timings.length]), [[orgId, -200, 3]]);
    const again = await leader.putJson(url, { ...body, timings: body.timings.slice(0, 2) });
    assert.equal(again.json.timings.length, 1, 'a new sync replaces the church’s earlier one');
    assert.equal(again.json.timings[0].timings.length, 2);
    assert.deepEqual((await member.get(url)).json.timings.map((x) => x.org_id), [orgId], 'members see their church’s timings');
    assert.deepEqual((await outsider.get(url)).json.timings, [], 'other people do not');

    assert.equal((await member.putJson(url, body)).status, 403, 'members do not sync');
    assert.equal((await outsider.putJson(url, body)).status, 404, 'not their church');
    assert.equal((await outsider.putJson(url, { ...body, org_id: null })).status, 403, 'global timings are for catalog admins');
    assert.equal((await (await login(own.base)).putJson(url, { ...body, org_id: null })).status, 403, 'the demo is never an admin');
    for (const [timings, why] of [
      [[{ label: 'V1', line: 0, ms: 4000 }, { label: 'V1', line: 1, ms: 1000 }], 'times must rise'],
      [[{ label: 'V2', line: 0, ms: 1000 }], 'no such section'],
      [[{ label: 'V1', line: 2, ms: 1000 }], 'no such line'],
      [[{ label: 'V1', line: 0, ms: -5 }], 'negative time'],
      [[], 'empty'],
      [Array.from({ length: 401 }, (_, i) => ({ label: 'V1', line: 0, ms: i + 1 })), 'too many'],
    ]) assert.equal((await leader.putJson(url, { ...body, timings })).status, 400, why);
    assert.equal((await leader.putJson(url, { ...body, language: 'xx' })).status, 400);
    assert.equal((await leader.putJson(url, { ...body, offset_ms: 120_000 })).status, 400);
    assert.equal((await leader.putJson('/api/sources/nope/timings', body)).status, 404);

    // The global hymn timings: admins only, and within the recording's length.
    const hymnUrl = `/api/sources/${HYMN_IDS.source('amazing-grace')}/timings`;
    const hymnTiming = [{ label: 'V1', line: 0, ms: 500 }, { label: 'V1', line: 1, ms: 3000 }];
    assert.equal((await admin.putJson(hymnUrl, { language: 'en', timings: [{ label: 'V1', line: 0, ms: 10 * 3600 * 1000 }] })).status, 400, 'past the end of the recording');
    const global = await admin.putJson(hymnUrl, { language: 'en', timings: hymnTiming });
    assert.equal(global.status, 200, global.text);
    const seen = (await outsider.get(hymnUrl)).json.timings;
    assert.ok(seen.some((x) => x.org_id === null && x.arrangement_id === null && JSON.stringify(x.timings) === JSON.stringify(hymnTiming)), 'global: seen by all');
    assert.ok(seen.some((x) => x.arrangement_id !== null), 'the generator’s timings for its Recording arrangement stay');

    // Two saves at once (a double-click on Save) leave one row for the church, not two.
    const both = await Promise.all([leader.putJson(url, body), leader.putJson(url, body)]);
    assert.deepEqual(both.map((x) => x.status), [200, 200]);
    const rows = await own.app.store.all('SELECT id FROM lyric_timings WHERE source_id = ? AND org_id = ?', [ytSource, orgId]);
    assert.equal(rows.length, 1, 'saves at the same time replace each other, they do not pile up');

    const actions = await own.app.store.all("SELECT org_id, action FROM audit_log WHERE action = 'timings.replace'");
    assert.deepEqual(actions.map((x) => x.org_id), [orgId, orgId, null, orgId, orgId]);
  } finally {
    await own.close();
  }
});

test('YouTube plays are kept as events, never streams; unknown or mixed-up sources are dropped', async () => {
  const c = await signup(srv.base, 'yt-listener');
  const yt = YOUTUBE_IDS.source(CARRY.videoId);
  const r = await c.post('/api/events', { events: [
    { type: 'play_start', source_id: yt, device_id: 'd1', reason: 'clickrow' },
    { type: 'play_end', source_id: yt, device_id: 'd1', reason: 'trackdone', ms_played: 95_000, data: { position_ms: 95_000 } },
    { type: 'play_end', source_id: 'nope', ms_played: 95_000 },
    { type: 'play_end', source_id: HYMN_IDS.source('amazing-grace'), ms_played: 95_000 },
    { type: 'play_end', source_id: yt, track_id: HYMN_IDS.track('amazing-grace'), ms_played: 95_000 },
  ] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { accepted: 2, rejected: 3, streams_counted: 0 });
  const me = (await c.get('/api/me')).json.id;
  const rows = await srv.app.store.all('SELECT type, track_id, ms_played, payload FROM events WHERE user_id = ? ORDER BY id', [me]);
  assert.deepEqual(rows.map((x) => [x.type, x.track_id, JSON.parse(x.payload).source, JSON.parse(x.payload).source_id]), [['play_start', null, 'youtube', yt], ['play_end', null, 'youtube', yt]]);
  assert.equal(JSON.parse(rows[1].payload).position_ms, 95_000);
  assert.equal((await srv.app.store.get('SELECT COUNT(*) AS n FROM streams WHERE user_id = ?', [me])).n, 0);
});

test('GET /api/sources/:id: a source with its song, so a queued or transferred video can be shown anywhere', async () => {
  const c = await login(srv.base);
  const yt = YOUTUBE_IDS.source(CARRY.videoId);
  const r = await c.get(`/api/sources/${yt}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.song.id, r.json.song.name, r.json.song.artist], [YOUTUBE_IDS.song(CARRY.videoId), 'Carry My Cross', { name: 'Victory Worship' }]);
  assert.deepEqual([r.json.source.id, r.json.source.source, r.json.source.youtube.videoId], [yt, 'youtube', CARRY.videoId]);
  assert.equal((await c.get(`/api/sources/${HYMN_IDS.source('amazing-grace')}`)).json.source.track.id, HYMN_IDS.track('amazing-grace'));
  assert.equal((await c.get('/api/sources/nope')).status, 404);
  // A church's own song is its members' only.
  const db = srv.app.store;
  await db.run("INSERT INTO orgs (id, name, default_language, created_by, created_at) VALUES ('org-src-1', 'Hidden', 'en', 1, 0)");
  await db.run("INSERT INTO songs (id, title, artist, language, public_domain, org_id, created_at, updated_at) VALUES ('orgsong-src', 'Ours', '', 'en', 0, 'org-src-1', 0, 0)");
  await db.run("INSERT INTO song_sources (id, song_id, source, track_id, youtube_video_id, kind, available) VALUES ('orgsrc-1', 'orgsong-src', 'ainos', ?, NULL, NULL, 1)", [HYMN_IDS.track('amazing-grace')]);
  assert.equal((await c.get('/api/sources/orgsrc-1')).status, 404);
  assert.equal((await client(srv.base).get(`/api/sources/${yt}`)).status, 401);
});
