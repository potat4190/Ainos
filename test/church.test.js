// Churches (spec Phase 5): cross-church isolation, roles, the church demo, and
// the lyrics paste parser. Isolation is the main risk, so every org-scoped
// route is tried from another church.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signup, login, client } from './helpers.js';
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

test('admins change roles and remove members, anyone can leave, and a church always keeps an admin', async () => {
  const L = await login(srv.base, 'lena-leader', 'correct horse battery');
  const M = await login(srv.base, 'mia-member', 'correct horse battery');
  const O = await login(srv.base, 'oscar-operator', 'correct horse battery');
  const idOf = async (username) => Number((await db().get('SELECT id FROM users WHERE username = ?', [username])).id);
  const [aliceId, lenaId, oscarId, bobId] = await Promise.all(['alice-church', 'lena-leader', 'oscar-operator', 'bob-church'].map(idOf));
  const url = (id) => `/api/orgs/${orgA}/members/${id}`;

  // Only admins see user ids, which the management routes take.
  assert.ok((await M.get(`/api/orgs/${orgA}/members`)).json.every((x) => !('id' in x)));
  assert.ok((await A.get(`/api/orgs/${orgA}/members`)).json.every((x) => Number.isInteger(x.id)));

  for (const c of [L, M, O]) assert.equal((await c.patch(url(oscarId), { role: 'member' })).status, 403, 'only admins manage members');
  assert.equal((await A.patch(url(lenaId), { role: 'owner' })).status, 400);
  assert.equal((await A.patch(url(lenaId), { role: 'admin' })).json.role, 'admin');
  // Lena demotes Alice; now Lena is the only admin and cannot step down or leave.
  assert.equal((await L.patch(url(aliceId), { role: 'leader' })).status, 200);
  const last = await L.patch(url(lenaId), { role: 'member' });
  assert.deepEqual([last.status, last.json.error.code], [409, 'last_admin']);
  assert.equal((await L.del(`/api/orgs/${orgA}/members/me`)).status, 409);
  assert.equal((await L.patch(url(aliceId), { role: 'admin' })).status, 200);
  // Two admins: one may leave or be removed, never both.
  assert.equal((await A.del(url(lenaId))).status, 200);
  assert.equal((await L.get(`/api/orgs/${orgA}`)).status, 404, 'a removed member is out');
  assert.equal((await A.del(`/api/orgs/${orgA}/members/me`)).status, 409, 'the last admin cannot leave');

  assert.equal((await O.del(`/api/orgs/${orgA}/members/me`)).status, 200, 'anyone can leave');
  assert.equal((await O.get(`/api/orgs/${orgA}`)).status, 404);
  assert.equal((await A.patch(url(oscarId), { role: 'leader' })).status, 404, 'no longer a member');
  for (const bad of ['0', '-1', 'abc', '9'.repeat(30), String(bobId)]) {
    assert.equal((await A.patch(url(bad), { role: 'member' })).status, 404, `user ${bad}`);
    assert.equal((await A.del(url(bad))).status, 404, `user ${bad}`);
  }
  // Church B's members can't be reached from A, through either org.
  assert.equal((await A.patch(`/api/orgs/${orgB}/members/${bobId}`, { role: 'member' })).status, 404);
  assert.equal((await A.del(`/api/orgs/${orgB}/members/${bobId}`)).status, 404);
  assert.equal((await B.get(`/api/orgs/${orgB}`)).json.role, 'admin');

  const actions = (await db().all('SELECT action FROM audit_log WHERE org_id = ?', [orgA])).map((x) => x.action);
  for (const a of ['member.role', 'member.remove', 'member.leave']) assert.ok(actions.includes(a), a);
});

test('invites: the link is shown once and only its hash stored; they expire, are revoked and get used up', async () => {
  const base = `/api/orgs/${orgA}/invites`;
  const made = await A.post(base, { role: 'leader' });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.json.path, `/#/join/${made.json.token}`);
  assert.deepEqual([made.json.role, made.json.max_uses, made.json.uses], ['leader', 1, 0]);
  assert.ok(Math.abs(made.json.expires_at - Date.now() - 7 * 86_400_000) < 60_000, 'a week to use it');
  const stored = await db().get('SELECT * FROM org_invites WHERE id = ?', [made.json.id]);
  assert.equal(stored.token_hash.length, 64);
  assert.ok(!Object.values(stored).some((v) => String(v).includes(made.json.token)), 'the token itself is not stored');
  const listed = (await A.get(base)).json;
  assert.ok(listed.some((x) => x.id === made.json.id) && listed.every((x) => !('token' in x) && !('token_hash' in x)));

  const N = await signup(srv.base, 'nina-newcomer');
  const P = await signup(srv.base, 'paul-pew');
  const joined = await N.post('/api/invites/redeem', { token: made.json.token });
  assert.equal(joined.status, 200, joined.text);
  assert.deepEqual([joined.json.org_id, joined.json.role, joined.json.name, joined.json.already_member], [orgA, 'leader', 'Grace Church', false]);
  assert.equal((await N.get(`/api/orgs/${orgA}`)).json.role, 'leader');
  const usedUp = await P.post('/api/invites/redeem', { token: made.json.token });
  assert.deepEqual([usedUp.status, usedUp.json.error.code], [404, 'invite_invalid'], 'a leader invite admits one person');

  const team = (await A.post(base, { role: 'member' })).json;
  assert.equal(team.max_uses, 25);
  assert.equal((await P.post('/api/invites/redeem', { token: team.token })).json.role, 'member');

  const revoked = (await A.post(base, { role: 'member' })).json;
  assert.equal((await A.del(`${base}/${revoked.id}`)).status, 200);
  assert.equal((await A.del(`${base}/${revoked.id}`)).status, 404, 'already revoked');
  const expired = (await A.post(base, { role: 'member' })).json;
  await db().run('UPDATE org_invites SET expires_at = ? WHERE id = ?', [Date.now() - 1, expired.id]);
  const late = await signup(srv.base, 'larry-late');
  for (const token of [revoked.token, expired.token]) assert.equal((await late.post('/api/invites/redeem', { token })).status, 404);
  assert.ok(!(await A.get(base)).json.some((x) => [revoked.id, expired.id, made.json.id].includes(x.id)), 'only open invites are listed');

  // Only admins of this church; other churches get 404.
  assert.equal((await P.post(base, { role: 'member' })).status, 403);
  assert.equal((await N.get(base)).status, 403, 'leaders do not manage members');
  assert.equal((await B.get(base)).status, 404);
  assert.equal((await B.del(`${base}/${team.id}`)).status, 404);
  assert.equal((await B.post(base, { role: 'admin' })).status, 404);
  const bInvite = (await B.post(`/api/orgs/${orgB}/invites`, { role: 'member' })).json;
  assert.equal((await A.del(`${base}/${bInvite.id}`)).status, 404, 'B’s invite through A’s church');
  assert.equal((await A.post(base, { role: 'pastor' })).status, 400);

  const actions = (await db().all('SELECT action FROM audit_log WHERE org_id = ?', [orgA])).map((x) => x.action);
  for (const a of ['invite.create', 'invite.redeem', 'invite.revoke']) assert.ok(actions.includes(a), a);

  // Redeeming is limited to 10 tries an hour; every failure looks the same until then.
  const guesser = await signup(srv.base, 'gus-guesser');
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await guesser.post('/api/invites/redeem', { token: i % 2 ? 'x'.repeat(43) : 'short' });
    if (r.status === 429) limited = r;
    else assert.deepEqual([r.status, r.json.error.code], [404, 'invite_invalid']);
  }
  assert.ok(limited, 'rate-limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('church demo: role preview is enforced on the server, only for the demo and only in the demo church', async () => {
  const C = await churchDemo();
  const org = (await C.get(`/api/orgs/${DEMO_ORG_ID}`)).json;
  assert.deepEqual([org.role, org.can_preview_roles], ['admin', true]);
  const members = (await C.get(`/api/orgs/${DEMO_ORG_ID}/members`)).json;
  assert.deepEqual(members.map((x) => [x.display_name, x.role]),
    [['Church Demo', 'admin'], ['Demo Leader', 'leader'], ['Demo Operator', 'operator'], ['Demo Member', 'member']]);
  assert.ok(members.every((x) => !('id' in x)), 'the demo cannot manage members, so it gets no ids');
  const [list] = (await C.get(`/api/orgs/${DEMO_ORG_ID}/setlists`)).json;
  const items = `/api/orgs/${DEMO_ORG_ID}/setlists/${list.id}/items`;
  const slides = `/api/orgs/${DEMO_ORG_ID}/setlists/${list.id}/slides`;

  const asRole = async (role) => {
    const r = await C.putJson(`/api/orgs/${DEMO_ORG_ID}/demo-role`, { role });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.role, role);
    return r.json;
  };
  assert.deepEqual((await asRole('member')).permissions, ['org.view']);
  assert.equal((await C.get('/api/me/orgs')).json[0].role, 'member');
  const denied = await C.putJson(items, { items: [{ kind: 'blank' }] });
  assert.deepEqual([denied.status, denied.json.error.code], [403, 'forbidden_role']);
  assert.equal((await C.get(slides)).status, 403);
  await asRole('operator');
  assert.equal((await C.get(slides)).status, 200);
  assert.equal((await C.putJson(items, { items: [{ kind: 'blank' }] })).status, 403);
  await asRole('leader');
  assert.equal((await C.putJson(items, { items: [{ kind: 'blank' }] })).status, 200);
  assert.equal((await C.putJson(`/api/orgs/${DEMO_ORG_ID}/demo-role`, { role: 'pastor' })).status, 400);

  // Per session: the next visitor starts as admin, and this one keeps its preview.
  const C2 = await churchDemo();
  assert.equal((await C2.get(`/api/orgs/${DEMO_ORG_ID}`)).json.role, 'admin');
  assert.equal((await C.get(`/api/orgs/${DEMO_ORG_ID}`)).json.role, 'leader');

  // Previewing as admin never unlocks what the demo may not do.
  await asRole('admin');
  for (const [method, url, body] of [
    ['post', `/api/orgs/${DEMO_ORG_ID}/invites`, { role: 'member' }], ['get', `/api/orgs/${DEMO_ORG_ID}/invites`],
    ['patch', `/api/orgs/${DEMO_ORG_ID}/members/1`, { role: 'member' }], ['del', `/api/orgs/${DEMO_ORG_ID}/members/me`],
    ['post', '/api/invites/redeem', { token: 'x'.repeat(43) }], ['patch', `/api/orgs/${DEMO_ORG_ID}`, { name: 'Mine' }],
  ]) {
    const r = await C[method](url, body);
    assert.deepEqual([r.status, r.json.error.code], [403, 'demo_not_allowed'], `${method} ${url}`);
  }

  // Anyone else: no preview route, and a stored demo_role is ignored.
  assert.equal((await A.putJson(`/api/orgs/${orgA}/demo-role`, { role: 'admin' })).status, 403);
  assert.equal((await A.putJson(`/api/orgs/${DEMO_ORG_ID}/demo-role`, { role: 'admin' })).status, 403);
  const P = await login(srv.base, 'paul-pew', 'correct horse battery');
  const pId = (await db().get("SELECT id FROM users WHERE username = 'paul-pew'")).id;
  await db().run("UPDATE sessions SET demo_role = 'admin' WHERE user_id = ?", [pId]);
  assert.equal((await P.get(`/api/orgs/${orgA}`)).json.role, 'member');
  assert.equal((await P.post(`/api/orgs/${orgA}/setlists`, { name: 'x' })).status, 403);

  // The placeholder members are not accounts: nobody can sign in as them or take their names.
  for (const name of ['church-demo-leader', 'Church-Demo-Member']) {
    assert.equal((await client(srv.base).post('/api/auth/login', { username: name, password: 'correct horse battery' })).status, 401);
    assert.equal((await client(srv.base).post('/api/auth/signup', { username: name, password: 'correct horse battery' })).status, 409);
  }
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
