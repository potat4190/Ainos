// A church's own lyrics for a song already in the catalog (a YouTube song, or
// its own words for a hymn), so tap-to-sync has lines to time:
// PUT /api/orgs/:orgId/songs/:songId/lyrics. The lyrics stay private to the
// church, like every org row, so each check is also tried from outside it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signup, login } from './helpers.js';
import { parseLyrics, lyricsText } from '../public/js/lyrics-parse.js';
import { YOUTUBE_IDS, HYMN_IDS } from '../scripts/generate.js';

let srv;
after(() => srv?.close());

const db = () => srv.app.store;
const CARRY = 'eov9K7ALYKk';
const songId = YOUTUBE_IDS.song(CARRY);
const sourceId = YOUTUBE_IDS.source(CARRY);
// Made-up words (no real song's lyrics in the repository).
const WORDS = 'Verse 1\nFirst line of the verse\nSecond line of the verse\n\nChorus\nChorus line one\nChorus line two\n\nVerse 2\nAnother verse line\n\nChorus';

async function addMember(orgId, username, role) {
  const u = await db().get('SELECT id FROM users WHERE username = ?', [username]);
  await db().run('INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [orgId, u.id, role, Date.now()]);
}

let A, B, orgA, orgB;
before(async () => {
  srv = await startTestServer();
  A = await signup(srv.base, 'lyric-alice');
  B = await signup(srv.base, 'lyric-bob');
  orgA = (await A.post('/api/orgs', { name: 'Grace Fellowship' })).json.id;
  orgB = (await B.post('/api/orgs', { name: 'Hope Chapel' })).json.id;
});

const sectionsSeenBy = async (c) => (await c.get(`/api/songs/${songId}`)).json.sections;

test('a church leader adds lyrics to a YouTube song; only that church sees them', async () => {
  const url = `/api/orgs/${orgA}/songs/${songId}/lyrics`;
  const r = await A.putJson(url, { text: WORDS });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.language, 'en', 'the song’s own language when none is given');
  assert.deepEqual(r.json.arrangement, ['V1', 'C', 'V2', 'C']);
  assert.equal(r.json.timings_removed, 0);

  const mine = await sectionsSeenBy(A);
  assert.deepEqual(mine.map((s) => [s.label, s.org_id]), [['V1', orgA], ['V2', orgA], ['C', orgA]]);
  assert.deepEqual(mine.find((s) => s.label === 'C').lines, ['Chorus line one', 'Chorus line two']);
  const arrangement = (await A.get(`/api/songs/${songId}`)).json.arrangements.find((a) => a.org_id === orgA);
  assert.deepEqual(arrangement.section_order, ['V1', 'C', 'V2', 'C']);

  // Another church, and the listener demo, see none of it.
  assert.deepEqual(await sectionsSeenBy(B), []);
  assert.deepEqual(await sectionsSeenBy(await login(srv.base)), []);
  // The song is now in the church's song list (for setlists), not in the other church's.
  assert.ok((await A.get(`/api/orgs/${orgA}/songs`)).json.some((s) => s.id === songId));
  assert.ok(!(await B.get(`/api/orgs/${orgB}/songs`)).json.some((s) => s.id === songId));
  const audit = await db().get("SELECT details FROM audit_log WHERE org_id = ? AND action = 'song.lyrics.replace'", [orgA]);
  assert.ok(audit, 'audited');
  assert.deepEqual(JSON.parse(audit.details).arrangement, ['V1', 'C', 'V2', 'C']);
});

test('who may add lyrics: leaders and admins of that church only', async () => {
  const M = await signup(srv.base, 'lyric-member');
  const O = await signup(srv.base, 'lyric-operator');
  const L = await signup(srv.base, 'lyric-leader');
  await addMember(orgA, 'lyric-member', 'member');
  await addMember(orgA, 'lyric-operator', 'operator');
  await addMember(orgA, 'lyric-leader', 'leader');
  const url = `/api/orgs/${orgA}/songs/${songId}/lyrics`;
  assert.equal((await M.putJson(url, { text: WORDS })).status, 403);
  assert.equal((await O.putJson(url, { text: WORDS })).status, 403);
  assert.equal((await L.putJson(url, { text: WORDS })).status, 200);
  // Not a member: 404, so the church's existence isn't given away.
  assert.equal((await B.putJson(url, { text: WORDS })).status, 404);
  assert.equal((await (await login(srv.base)).putJson(url, { text: WORDS })).status, 404, 'listener demo');
  // Another church's own song can't be reached through this church.
  const bSong = (await B.post(`/api/orgs/${orgB}/songs`, { title: 'Hope Song', text: 'one line' })).json.id;
  assert.equal((await A.putJson(`/api/orgs/${orgA}/songs/${bSong}/lyrics`, { text: WORDS })).status, 404);
  assert.equal((await A.putJson(`/api/orgs/${orgA}/songs/no-such-song/lyrics`, { text: WORDS })).status, 404);
  assert.equal((await A.putJson(`/api/orgs/${orgA}/songs/${encodeURIComponent('bad id!')}/lyrics`, { text: WORDS })).status, 404);
  // B's own song is fine for B.
  assert.equal((await B.putJson(`/api/orgs/${orgB}/songs/${bSong}/lyrics`, { text: 'Verse 1\nnew words' })).status, 200);
});

test('lyrics are parsed and limited on the server', async () => {
  const url = `/api/orgs/${orgA}/songs/${songId}/lyrics`;
  assert.equal((await A.putJson(url, { text: '  \n\n ' })).status, 400);
  assert.equal((await A.putJson(url, {})).status, 400);
  assert.equal((await A.putJson(url, { text: Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n') })).status, 400);
  assert.equal((await A.putJson(url, { text: 'x'.repeat(121) })).status, 400);
  assert.equal((await A.putJson(url, { text: WORDS, language: 'xx' })).status, 400);
  // Another language is kept apart from the English lyrics.
  const ne = await A.putJson(url, { text: 'पद १\nपहिलो पद', language: 'ne' });
  assert.equal(ne.status, 200, ne.text);
  const rows = await db().all('SELECT language, COUNT(*) AS n FROM song_sections WHERE song_id = ? AND org_id = ? GROUP BY language ORDER BY language', [songId, orgA]);
  assert.deepEqual(rows.map((x) => [x.language, Number(x.n)]), [['en', 3], ['ne', 1]]);
});

test('tap-to-sync times the church’s lyrics; changed lines drop the timings that no longer fit', async () => {
  const lyricsUrl = `/api/orgs/${orgA}/songs/${songId}/lyrics`;
  assert.equal((await A.putJson(lyricsUrl, { text: WORDS })).status, 200);
  const timings = [
    { label: 'V1', line: 0, ms: 1000 }, { label: 'V1', line: 1, ms: 3000 },
    { label: 'C', line: 0, ms: 5000 }, { label: 'C', line: 1, ms: 7000 },
    { label: 'V2', line: 0, ms: 9000 },
  ];
  const put = await A.putJson(`/api/sources/${sourceId}/timings`, { org_id: orgA, language: 'en', timings });
  assert.equal(put.status, 200, put.text);
  const seen = (await A.get(`/api/songs/${songId}`)).json.sources[0].timings;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].org_id, orgA);
  assert.deepEqual((await B.get(`/api/songs/${songId}`)).json.sources[0].timings, [], 'other churches see no timings');

  // A typo fixed (same sections, same line counts): the timings stay.
  const fixed = await A.putJson(lyricsUrl, { text: WORDS.replace('Another verse line', 'Another verse, fixed') });
  assert.equal(fixed.json.timings_removed, 0);
  assert.equal((await A.get(`/api/songs/${songId}`)).json.sources[0].timings.length, 1);

  // Verse 1 loses its second line: the timing for it would show other words, so the timings go.
  const shorter = await A.putJson(lyricsUrl, { text: WORDS.replace('\nSecond line of the verse', '') });
  assert.equal(shorter.json.timings_removed, 1);
  assert.deepEqual((await A.get(`/api/songs/${songId}`)).json.sources[0].timings, []);
});

test('a church can give a hymn its own words without touching the global ones', async () => {
  const hymn = HYMN_IDS.song('amazing-grace');
  const before = await db().all('SELECT label, lines FROM song_sections WHERE song_id = ? AND org_id IS NULL ORDER BY label', [hymn]);
  const r = await A.putJson(`/api/orgs/${orgA}/songs/${hymn}/lyrics`, { text: 'Verse 1\nOur church’s own first line' });
  assert.equal(r.status, 200, r.text);
  const after = await db().all('SELECT label, lines FROM song_sections WHERE song_id = ? AND org_id IS NULL ORDER BY label', [hymn]);
  assert.deepEqual(after, before);
  const v1 = (await A.get(`/api/songs/${hymn}`)).json.sections.filter((s) => s.label === 'V1');
  assert.deepEqual(v1.map((s) => s.org_id).sort(), [orgA, null].sort());
});

test('lyricsText writes saved lyrics back as paste text that parses the same', () => {
  for (const text of [WORDS, 'v1\none\n\nRefrain\ntwo\n\nv2\nthree\n\nBRIDGE\nfour\n\nTag\nfive\n\nEnding\nsix\n\nPre-chorus\nseven\n\nChorus 2\neight', 'कोरस:\nयेशू मेरो प्रभु\n\nपद १\nपहिलो पद\n\nकोरस']) {
    const parsed = parseLyrics(text);
    const again = parseLyrics(lyricsText(parsed.sections, parsed.arrangement));
    assert.deepEqual(again.arrangement, parsed.arrangement, text);
    assert.deepEqual(again.sections.map((s) => [s.label, s.lines]), parsed.sections.map((s) => [s.label, s.lines]), text);
  }
  // Sections the arrangement leaves out still come along.
  assert.equal(lyricsText([{ label: 'V1', lines: ['a'] }, { label: 'B', lines: ['b'] }], ['V1']), 'Verse 1\na\n\nBridge\nb');
});
