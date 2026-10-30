// Churches (spec Phase 5): cross-church isolation, roles, the church demo, and
// the lyrics paste parser. Isolation is the main risk, so every org-scoped
// route is tried from another church.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signup, client } from './helpers.js';
import { parseLyrics } from '../public/js/lyrics-parse.js';
import { HYMN_IDS } from '../scripts/generate.js';
import { hymnSongId, DEMO_ORG_ID, nextSundayUtc } from '../server/demo.js';
import { ROLE_CAN } from '../server/orgs.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv?.close(); });

const db = () => srv.app.store;
/** Put a signed-up user into an org with a role, as an invite would (invites are not built yet). */
async function addMember(orgId, username, role) {
  const u = await db().get('SELECT id FROM users WHERE username = ?', [username]);
  await db().run('INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [orgId, u.id, role, Date.now()]);
}
async function churchDemo() {
  const c = client(srv.base);
  const r = await c.post('/api/auth/church-demo', { language: 'en' });
  assert.equal(r.status, 200, r.text);
  return c;
}

let A, B, orgA, orgB, setlistB, songB;
test('a user creates a church and becomes its admin', async () => {
  A = await signup(srv.base, 'alice-church');
  B = await signup(srv.base, 'bob-church');
  const ra = await A.post('/api/orgs', { name: 'Grace Fellowship' });
  assert.equal(ra.status, 201, ra.text);
  assert.equal(ra.json.role, 'admin');
  orgA = ra.json.id;
  orgB = (await B.post('/api/orgs', { name: 'Hope Chapel' })).json.id;
  assert.deepEqual((await A.get('/api/me/orgs')).json, [{ id: orgA, name: 'Grace Fellowship', role: 'admin' }]);
  const audit = await db().all('SELECT action FROM audit_log WHERE org_id = ?', [orgA]);
  assert.deepEqual(audit.map((x) => x.action), ['org.create']);

  const s = await B.post(`/api/orgs/${orgB}/setlists`, { name: 'Sunday', service_date: '2026-11-01' });
  assert.equal(s.status, 201, s.text);
  setlistB = s.json.id;
  const song = await B.post(`/api/orgs/${orgB}/songs`, { title: 'Blessed Assurance', text: 'Verse 1\nBlessed assurance, Jesus is mine\n\nChorus\nThis is my story, this is my song' });
  assert.equal(song.status, 201, song.text);
  songB = song.json.id;
  assert.deepEqual(song.json.arrangement, ['V1', 'C']);
});

test('a member of church A gets 404 for everything of church B', async () => {
  const urls = [
    ['get', `/api/orgs/${orgB}`], ['patch', `/api/orgs/${orgB}`, { name: 'Mine now' }], ['get', `/api/orgs/${orgB}/members`],
    ['get', `/api/orgs/${orgB}/setlists`], ['post', `/api/orgs/${orgB}/setlists`, { name: 'x' }],
    ['get', `/api/orgs/${orgB}/setlists/${setlistB}`], ['patch', `/api/orgs/${orgB}/setlists/${setlistB}`, { name: 'x' }],
    ['del', `/api/orgs/${orgB}/setlists/${setlistB}`], ['putJson', `/api/orgs/${orgB}/setlists/${setlistB}/items`, { items: [] }],
    ['get', `/api/orgs/${orgB}/setlists/${setlistB}/slides`], ['get', `/api/orgs/${orgB}/songs`],
    ['post', `/api/orgs/${orgB}/songs`, { title: 'x', text: 'a line' }],
    // B's setlist through A's own org: the setlist must belong to the org in the URL.
    ['get', `/api/orgs/${orgA}/setlists/${setlistB}`], ['patch', `/api/orgs/${orgA}/setlists/${setlistB}`, { name: 'x' }],
    ['del', `/api/orgs/${orgA}/setlists/${setlistB}`], ['putJson', `/api/orgs/${orgA}/setlists/${setlistB}/items`, { items: [] }],
    ['get', `/api/orgs/${orgA}/setlists/${setlistB}/slides`],
    ['get', '/api/orgs/no-such-org'], ['get', `/api/orgs/${'x'.repeat(200)}`],
  ];
  for (const [method, url, body] of urls) {
    const r = await A[method](url, body);
    assert.equal(r.status, 404, `${method} ${url} → ${r.status} ${r.text}`);
  }
  // Nothing changed in B.
  const s = await B.get(`/api/orgs/${orgB}/setlists/${setlistB}`);
  assert.equal(s.json.name, 'Sunday');
  assert.equal((await B.get(`/api/orgs/${orgB}`)).json.name, 'Hope Chapel');
});

test('church A cannot put church B’s song in its setlist, nor see it in its song list', async () => {
  const s = await A.post(`/api/orgs/${orgA}/setlists`, { name: 'Ours' });
  const r = await A.putJson(`/api/orgs/${orgA}/setlists/${s.json.id}/items`, { items: [{ kind: 'song', song_id: songB }] });
  assert.equal(r.status, 400, r.text);
  const songs = (await A.get(`/api/orgs/${orgA}/songs`)).json;
  assert.ok(!songs.some((x) => x.id === songB));
  assert.ok(songs.some((x) => x.id === HYMN_IDS.song('amazing-grace')), 'global hymns are listed');
  assert.ok((await B.get(`/api/orgs/${orgB}/songs`)).json.some((x) => x.id === songB && x.org_song));
});

test('setlist items: kinds validated, replaced as a whole list, at most 40', async () => {
  const s = (await A.post(`/api/orgs/${orgA}/setlists`, { name: 'Items' })).json;
  const url = `/api/orgs/${orgA}/setlists/${s.id}/items`;
  const items = [
    { kind: 'text', text: 'Welcome\nPlease sit' }, { kind: 'song', song_id: HYMN_IDS.song('it-is-well') },
    { kind: 'scripture', usfm_ref: 'psa.100.4-5' }, { kind: 'blank' },
  ];
  const r = await A.putJson(url, { items });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.items.map((x) => x.kind), ['text', 'song', 'scripture', 'blank']);
  assert.equal(r.json.items[2].usfm_ref, 'PSA.100.4-5');
  assert.equal(r.json.items[1].title, 'It Is Well with My Soul');
  for (const bad of [[{ kind: 'video' }], [{ kind: 'scripture', usfm_ref: 'NOPE.1' }], [{ kind: 'text', text: 'x'.repeat(501) }], [{ kind: 'song', song_id: 'missing' }], 'nope',
    Array.from({ length: 41 }, () => ({ kind: 'blank' }))]) {
    assert.equal((await A.putJson(url, { items: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  const again = await A.putJson(url, { items: r.json.items.slice().reverse() });
  assert.deepEqual(again.json.items.map((x) => x.kind), ['blank', 'scripture', 'song', 'text']);
  const slides = await A.get(`/api/orgs/${orgA}/setlists/${s.id}/slides`);
  assert.equal(slides.status, 200, slides.text);
  assert.equal(slides.json.setlist.name, 'Items');
  const [blank, psalm, song, text] = slides.json.items;
  assert.deepEqual(blank.slides.map((x) => x.lines), [[]]);
  assert.equal(psalm.slides.length, 1);
  assert.match(psalm.slides[0].lines[0], /Enter into his gates/);
  assert.equal(psalm.slides[0].label, 'Psalm 100:4-5');
  assert.equal(song.source.type, 'track');
  assert.equal(song.source.trackId, HYMN_IDS.track('it-is-well'));
  assert.ok(Array.isArray(song.slides));
  assert.deepEqual(text.slides[0].lines, ['Welcome', 'Please sit']);
});

test('roles: a member reads but cannot edit; an operator presents but cannot edit', async () => {
  const s = (await A.post(`/api/orgs/${orgA}/setlists`, { name: 'Roles' })).json;
  const M = await signup(srv.base, 'mia-member');
  const O = await signup(srv.base, 'oscar-operator');
  const L = await signup(srv.base, 'lena-leader');
  await addMember(orgA, 'mia-member', 'member');
  await addMember(orgA, 'oscar-operator', 'operator');
  await addMember(orgA, 'lena-leader', 'leader');
  const base = `/api/orgs/${orgA}/setlists`;
  for (const c of [M, O]) {
    assert.equal((await c.get(base)).status, 200);
    assert.equal((await c.get(`${base}/${s.id}`)).status, 200);
    assert.equal((await c.post(base, { name: 'x' })).status, 403);
    assert.equal((await c.patch(`${base}/${s.id}`, { name: 'x' })).status, 403);
    assert.equal((await c.putJson(`${base}/${s.id}/items`, { items: [] })).status, 403);
    assert.equal((await c.del(`${base}/${s.id}`)).status, 403);
    assert.equal((await c.post(`/api/orgs/${orgA}/songs`, { title: 'x', text: 'line' })).status, 403);
    assert.equal((await c.patch(`/api/orgs/${orgA}`, { name: 'x' })).status, 403);
  }
  assert.equal((await M.get(`${base}/${s.id}/slides`)).status, 403);
  assert.equal((await O.get(`${base}/${s.id}/slides`)).status, 200);
  // A leader edits setlists and songs but cannot rename the church.
  assert.equal((await L.patch(`${base}/${s.id}`, { name: 'Renamed', service_date: '2026-12-25' })).status, 200);
  assert.equal((await L.patch(`/api/orgs/${orgA}`, { name: 'x' })).status, 403);
  assert.equal((await A.patch(`/api/orgs/${orgA}`, { name: 'Grace Church' })).status, 200);
  const members = (await M.get(`/api/orgs/${orgA}/members`)).json;
  assert.deepEqual(Object.keys(members[0]).sort(), ['display_name', 'is_me', 'role']);
  assert.equal(members[0].role, 'admin');
  assert.deepEqual(ROLE_CAN['projection.run'], ['admin', 'leader', 'operator']);
  const actions = (await db().all('SELECT action FROM audit_log WHERE org_id = ?', [orgA])).map((x) => x.action);
  for (const a of ['setlist.create', 'setlist.update', 'setlist.items.replace', 'org.rename']) assert.ok(actions.includes(a), a);
});

test('pasted songs are parsed and limited on the server', async () => {
  const url = `/api/orgs/${orgA}/songs`;
  assert.equal((await A.post(url, { title: 'Long', text: Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n') })).status, 400);
  assert.equal((await A.post(url, { title: 'Wide', text: 'x'.repeat(121) })).status, 400);
  assert.equal((await A.post(url, { title: 'Many', text: Array.from({ length: 31 }, (_, i) => `Verse ${i % 9 + 1}\nline ${i}`).join('\n\n') })).status, 400);
  assert.equal((await A.post(url, { title: 'Empty', text: '   \n\n ' })).status, 400);
  const ok = await A.post(url, { title: 'Rock of Ages', text: 'Rock of Ages, cleft for me\r\nLet me hide myself in Thee' });
  assert.equal(ok.status, 201, ok.text);
  const rows = await db().all('SELECT org_id, language FROM song_sections WHERE song_id = ?', [ok.json.id]);
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ org_id: orgA, language: 'en' }]);
  assert.equal((await db().get('SELECT org_id FROM songs WHERE id = ?', [ok.json.id])).org_id, orgA);
});

test('the listener demo cannot create or see a church', async () => {
  const D = client(srv.base);
  assert.equal((await D.post('/api/auth/demo', { language: 'en' })).status, 200);
  const r = await D.post('/api/orgs', { name: 'Demo church' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'demo_not_allowed');
  assert.deepEqual((await D.get('/api/me/orgs')).json, []);
  assert.equal((await D.get(`/api/orgs/${DEMO_ORG_ID}`)).status, 404);
});

test('church demo: signs in to the seeded church, edits it, and is confined to it', async () => {
  assert.equal(hymnSongId('amazing-grace'), HYMN_IDS.song('amazing-grace'), 'the demo seed finds the hymns');
  const C = await churchDemo();
  const me = (await C.get('/api/me')).json;
  assert.equal(me.username, 'church-demo');
  assert.equal(me.is_demo, true);
  const orgs = (await C.get('/api/me/orgs')).json;
  assert.deepEqual(orgs, [{ id: DEMO_ORG_ID, name: 'Ainos Demo Church', role: 'admin' }]);
  const org = (await C.get(`/api/orgs/${DEMO_ORG_ID}`)).json;
  assert.ok(org.permissions.includes('setlist.edit') && !org.permissions.includes('org.edit'));
  const [list] = (await C.get(`/api/orgs/${DEMO_ORG_ID}/setlists`)).json;
  assert.equal(list.name, 'This Sunday');
  assert.equal(list.service_date, nextSundayUtc());
  assert.equal(new Date(`${list.service_date}T12:00:00Z`).getUTCDay(), 0);
  const seeded = (await C.get(`/api/orgs/${DEMO_ORG_ID}/setlists/${list.id}`)).json;
  assert.deepEqual(seeded.items.map((x) => x.kind), ['text', 'song', 'scripture', 'song', 'song', 'blank']);
  assert.deepEqual(seeded.items.filter((x) => x.kind === 'song').map((x) => x.song_id), ['holy-holy-holy', 'amazing-grace', 'it-is-well'].map(HYMN_IDS.song));
  assert.equal(seeded.items[2].usfm_ref, 'PSA.100.4-5');

  // Allowed: edit setlists and songs, present.
  const edit = await C.putJson(`/api/orgs/${DEMO_ORG_ID}/setlists/${list.id}/items`, { items: [{ kind: 'blank' }] });
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await C.post(`/api/orgs/${DEMO_ORG_ID}/songs`, { title: 'Doxology', text: 'Praise God, from whom all blessings flow' })).status, 201);
  assert.equal((await C.post(`/api/orgs/${DEMO_ORG_ID}/setlists`, { name: 'Evening' })).status, 201);
  assert.equal((await C.get(`/api/orgs/${DEMO_ORG_ID}/setlists/${list.id}/slides`)).status, 200);

  // Forbidden: new churches, renaming, other churches.
  const create = await C.post('/api/orgs', { name: 'Another' });
  assert.equal(create.status, 403);
  assert.equal(create.json.error.code, 'demo_not_allowed');
  const rename = await C.patch(`/api/orgs/${DEMO_ORG_ID}`, { name: 'Mine' });
  assert.equal(rename.status, 403);
  assert.equal(rename.json.error.code, 'demo_not_allowed');
  assert.equal((await C.get(`/api/orgs/${orgA}`)).status, 404);
  assert.equal((await C.get(`/api/orgs/${orgA}/setlists`)).status, 404);
  // Even if it were somehow added to another church, the demo stays confined.
  await addMember(orgA, 'church-demo', 'admin');
  assert.equal((await C.get(`/api/orgs/${orgA}/setlists`)).status, 404);
  assert.deepEqual((await C.get('/api/me/orgs')).json.map((x) => x.id), [DEMO_ORG_ID]);
  await db().run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [orgA, me.id]);

  // The next visitor gets the seed back, and nothing pasted survives.
  const C2 = await churchDemo();
  const lists = (await C2.get(`/api/orgs/${DEMO_ORG_ID}/setlists`)).json;
  assert.deepEqual(lists.map((x) => [x.id, x.name, x.item_count]), [[list.id, 'This Sunday', 6]]);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM songs WHERE org_id = ?', [DEMO_ORG_ID])).n, 0);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?', [DEMO_ORG_ID])).n, 0);
  assert.equal((await C2.get('/api/me')).json.username, 'church-demo');
  // The documented password works too, and the name can't be signed up for.
  const L = client(srv.base);
  assert.equal((await L.post('/api/auth/login', { username: 'church-demo', password: 'ainos-church-demo' })).status, 200);
  assert.equal((await client(srv.base).post('/api/auth/signup', { username: 'Church-Demo', password: 'correct horse battery' })).status, 409);
});

test('parseLyrics handles messy pastes', () => {
  // Windows line endings, bracketed and plain labels, a chorus given again by its label alone.
  assert.deepEqual(parseLyrics('Verse 1\r\nAmazing grace, how sweet the sound\r\nThat saved a wretch like me\r\n\r\n[Chorus]\r\nMy chains are gone\r\n\r\nverse 2:\r\nTwas grace that taught\r\n\r\nChorus'), {
    sections: [
      { label: 'V1', lines: ['Amazing grace, how sweet the sound', 'That saved a wretch like me'] },
      { label: 'C', lines: ['My chains are gone'] },
      { label: 'V2', lines: ['Twas grace that taught'] },
    ],
    arrangement: ['V1', 'C', 'V2', 'C'],
  });
  // No labels, extra spaces and blank lines full of spaces: the block that comes back is the chorus.
  const auto = parseLyrics('  Blessed   assurance  \n Jesus is mine \n   \n\nThis is my story\nThis is my song\n\n \t \nPerfect submission\n\nThis is my story\nThis   is my song\n');
  assert.deepEqual(auto.arrangement, ['V1', 'C', 'V2', 'C']);
  assert.deepEqual(auto.sections.map((s) => [s.label, !!s.needsReview]), [['V1', true], ['C', false], ['V2', true]]);
  assert.deepEqual(auto.sections[0].lines, ['Blessed assurance', 'Jesus is mine']);
  // Devanagari labels and digits (Nepali).
  assert.deepEqual(parseLyrics('कोरस:\nयेशू मेरो प्रभु\n\nपद १\nपहिलो पद\n\nपद २\nदोस्रो पद\n\nकोरस').arrangement, ['C', 'V1', 'V2', 'C']);
  // CJK text, an ideographic-space blank line.
  const zh = parseLyrics('主啊我爱你\n我要赞美你\n　\n哈利路亚\n\n主啊我爱你\n我要赞美你');
  assert.deepEqual(zh.sections.map((s) => s.label), ['C', 'V1']);
  assert.deepEqual(zh.arrangement, ['C', 'V1', 'C']);
  // Spanish labels, a repeat count, pre-chorus spellings, a label on its own line before its block.
  const es = parseLyrics('Pre-Chorus\nsube\n\nCoro (x2)\ncanta al Señor\n\nPuente\n\nnueva canción\n\n[Estribillo]');
  assert.deepEqual(es.sections, [{ label: 'PC', lines: ['sube'] }, { label: 'C', lines: ['canta al Señor'] }, { label: 'B', lines: ['nueva canción'] }]);
  assert.deepEqual(es.arrangement, ['PC', 'C', 'C', 'B', 'C']);
  // Short labels, refrain, bridge, tag and ending; nothing at all.
  assert.deepEqual(parseLyrics('v1\none\n\nRefrain\ntwo\n\nv2\nthree\n\nBRIDGE\nfour\n\nTag\nfive\n\nEnding\nsix').arrangement, ['V1', 'C', 'V2', 'B', 'T', 'E']);
  assert.deepEqual(parseLyrics(''), { sections: [], arrangement: [] });
  assert.deepEqual(parseLyrics(null), { sections: [], arrangement: [] });
});
