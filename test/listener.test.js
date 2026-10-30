// Phases 3-4 (speedrun): curated YouTube songs in search, song lyrics with
// their visibility rules, and the hymn line timings the generator writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, login, signup } from './helpers.js';
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
