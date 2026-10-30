// Scripture next to songs (AINOS-SPEC.md Phase 2): the YouVersion client and
// its routes, against a fake YouVersion (no network): fallback without a key,
// on errors and on timeouts, attribution, validation, rate limits, admin-only
// edits, and that neither the key nor any verse text leaks or is stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, client, login, signup } from './helpers.js';
import { createScripture, fallbackText, referenceName, dayOfYear, YOUVERSION_API } from '../server/scripture.js';
import { FALLBACK_SOURCE, FALLBACK_VERSES, VOTD_FALLBACK } from '../server/scripture-fallback.js';
import { HYMNS } from '../scripts/hymns.js';
import { HYMN_IDS } from '../scripts/generate.js';
import { parseAdminIds, isAdmin } from '../server/admin.js';

const KEY = 'test-app-key-7f3c9e1d5b';
const UPSTREAM_TEXT = 'UPSTREAM VERSE TEXT 8d2f';

/**
 * A fake YouVersion. English has version 111 and Spanish 222; `mode` makes
 * every call fail ('error'), hang until aborted ('timeout') or answer.
 */
function fakeYouVersion() {
  const fake = { mode: 'ok', calls: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const versions = { 111: { id: 111, abbreviation: 'TST', title: 'Test Version', copyright: '© Test Publisher', language_tag: 'en' },
    222: { id: 222, abbreviation: 'PRB', title: 'Prueba', copyright: '© Editorial', language_tag: 'es' } };
  fake.fetch = async (url, init = {}) => {
    const u = new URL(url);
    fake.calls.push({ url: u.href, key: init.headers?.['X-YVP-App-Key'] });
    if (fake.mode === 'timeout') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    if (fake.mode === 'error') return json({ error: 'boom' }, 500);
    if (init.headers?.['X-YVP-App-Key'] !== KEY) return json({ detail: 'unauthorized' }, 401);
    let m;
    if (u.pathname === '/v1/bibles') {
      const lang = u.searchParams.get('language_ranges[]');
      return json({ data: Object.values(versions).filter((v) => v.language_tag === lang), next_page_token: null });
    }
    if ((m = /^\/v1\/bibles\/(\d+)$/.exec(u.pathname))) return versions[m[1]] ? json(versions[m[1]]) : json({}, 404);
    if ((m = /^\/v1\/bibles\/(\d+)\/passages\/([^/]+)$/.exec(u.pathname))) {
      if (!versions[m[1]]) return json({ detail: 'not licensed' }, 400);
      return json({ id: m[2], content: `${UPSTREAM_TEXT} ${m[2]}`, reference: `Ref ${m[2]}` });
    }
    if ((m = /^\/v1\/verse-of-the-days\/(\d+)$/.exec(u.pathname))) return json({ day: Number(m[1]), passage_id: 'ISA.12.2', image_id: null });
    return json({}, 404);
  };
  return fake;
}

// Every upstream URL must be one of the three allowed endpoints.
const ALLOWED_UPSTREAM = [
  /^https:\/\/api\.youversion\.com\/v1\/bibles\?language_ranges%5B%5D=[a-z]{2}&page_size=99$/,
  /^https:\/\/api\.youversion\.com\/v1\/bibles\/\d+$/,
  /^https:\/\/api\.youversion\.com\/v1\/bibles\/\d+\/passages\/[0-9A-Z]{3}\.\d+(\.\d+(-\d+)?)?\?format=text$/,
  /^https:\/\/api\.youversion\.com\/v1\/verse-of-the-days\/\d{1,3}$/,
];

let noKey, withKey, fake, adminId, demoId, adminClient;
const bodies = []; // every response body, to check none carries the key
const record = (c) => new Proxy(c, {
  get(target, prop) {
    const v = target[prop];
    return typeof v === 'function' ? async (...args) => { const r = await v(...args); bodies.push(r.text); return r; } : v;
  },
});

before(async () => {
  noKey = await startTestServer({ scripture: createScripture({ appKey: '' }) });
  fake = fakeYouVersion();
  withKey = await startTestServer({
    scripture: createScripture({ appKey: KEY, fetch: fake.fetch, timeoutMs: 100 }),
    // The next signup becomes an admin; the demo account is listed too, and must still be refused.
    prepare: (dataDir) => {
      const db = new DatabaseSync(path.join(dataDir, 'ainos.db'), { readOnly: true });
      try {
        adminId = db.prepare('SELECT MAX(id) AS n FROM users').get().n + 1;
        demoId = db.prepare("SELECT id FROM users WHERE username = 'demo'").get().id;
      } finally {
        db.close();
      }
      return { adminUserIds: `${adminId}, ${demoId}, nonsense` };
    },
  });
  adminClient = await signup(withKey.base, 'catalogadmin'); // the first signup: adminId
});
after(async () => {
  await noKey?.close();
  await withKey?.close();
});

test('the bundled fallback is public-domain WEB text covering every hymn reference and the Verse of the Day list', () => {
  assert.equal(FALLBACK_SOURCE.abbreviation, 'WEB');
  assert.match(FALLBACK_SOURCE.license, /public domain/i);
  assert.match(FALLBACK_SOURCE.url, /^https:\/\/ebible\.org\//);
  assert.match(FALLBACK_SOURCE.sha256, /^[0-9a-f]{64}$/);
  for (const ref of [...HYMNS.flatMap((h) => h.scripture), ...VOTD_FALLBACK]) assert.ok(fallbackText(ref), `${ref} is bundled`);
  assert.equal(fallbackText('PSA.23'), null, 'whole chapters are not bundled');
  assert.equal(fallbackText('GEN.50.26'), null, 'nor verses Ainos never references');
  assert.ok(Object.keys(FALLBACK_VERSES).length < 200, 'the file stays small');
  assert.equal(referenceName('PHP.4.6-7'), 'Philippians 4:6-7');
  assert.equal(dayOfYear(new Date(Date.UTC(2026, 0, 1))), 1);
  assert.equal(dayOfYear(new Date(Date.UTC(2024, 11, 31))), 366);
});

test('a version is refused only when every language list loaded; a failed list is retried later, not on every request', async () => {
  const fake = fakeYouVersion();
  let failHindi = true;
  let clock = 0;
  const fetch = (url, init) => (failHindi && new URL(url).searchParams.get('language_ranges[]') === 'hi' ? Promise.reject(new TypeError('fetch failed')) : fake.fetch(url, init));
  const s = createScripture({ appKey: KEY, fetch, now: () => clock });
  assert.equal(await s.versionStatus(111), 'allowed');
  assert.equal(await s.versionStatus(999), 'unknown', 'the Hindi list failed: 999 might be Hindi');
  const calls = fake.calls.length;
  assert.equal(await s.versionStatus(999), 'unknown');
  assert.equal(fake.calls.length, calls, 'lists, failed ones included, are cached');
  failHindi = false;
  clock += 6 * 60 * 1000;
  assert.equal(await s.versionStatus(999), 'not_allowed', 'retried after 5 minutes');
  assert.equal(await createScripture({ appKey: '' }).versionStatus(111), 'unknown');
});

test('admins come from ADMIN_USER_IDS only, and a demo account never is one', () => {
  const ids = parseAdminIds(' 12,x, 7 ,0,-3,12');
  assert.deepEqual([...ids].sort(), ['12', '7']);
  assert.equal(isAdmin({ id: 7, username: 'grace' }, ids), true);
  assert.equal(isAdmin({ id: 8, username: 'grace' }, ids), false);
  assert.equal(isAdmin({ id: 7, username: 'demo' }, ids), false);
  assert.equal(isAdmin(null, ids), false);
  assert.equal(parseAdminIds(undefined).size, 0);
});

test('without a key: English gets the WEB text with its attribution, other languages the reference alone', async () => {
  const c = record(await signup(noKey.base, 'reader'));
  const r = await c.get('/api/scripture/php.4.6-7');
  assert.equal(r.status, 200);
  assert.equal(r.json.usfm, 'PHP.4.6-7');
  assert.equal(r.json.reference, 'Philippians 4:6-7');
  assert.equal(r.json.text, fallbackText('PHP.4.6-7'));
  assert.deepEqual(r.json.version, { id: null, abbreviation: 'WEB', title: 'World English Bible', copyright: 'Public domain' });
  assert.equal(r.json.source, 'fallback');
  const chapter = await c.get('/api/scripture/PSA.23');
  assert.equal(chapter.status, 200);
  assert.equal(chapter.json.text, null, 'a reference the bundle lacks still answers, with no text');
  assert.equal(chapter.json.reference, 'Psalm 23');

  await c.post('/api/me/language', { language: 'hi' });
  const hi = await c.get('/api/scripture/EPH.2.8');
  assert.equal(hi.status, 200);
  assert.deepEqual([hi.json.text, hi.json.version, hi.json.source, hi.json.reference], [null, null, 'none', 'Ephesians 2:8']);
  const votd = await c.get('/api/scripture/votd');
  assert.equal(votd.status, 200);
  assert.ok(VOTD_FALLBACK.includes(votd.json.usfm));
  const versions = await c.get('/api/scripture/versions?lang=en');
  assert.deepEqual([versions.json.versions, versions.json.fallback.abbreviation], [[], 'WEB']);
  assert.equal((await c.putJson('/api/me/bible-version', { version: 111 })).status, 400, 'no version can be chosen without a key');
});

test('bad references and versions are refused with 400, before anything is fetched', async () => {
  const c = record(await signup(withKey.base, 'checker'));
  const before = fake.calls.length;
  for (const ref of ['XYZ.1.1', 'EPH', 'EPH.0', 'EPH.2.8-2', 'EPH.2.8-8', 'EPH.2.1000', 'EPH.2.8,9', 'EPH.2.8%2F..%2F..%2Fbibles', '..%2Fapps', 'JHN.3.16-JHN.3.18']) {
    const r = await c.get(`/api/scripture/${ref}`);
    assert.equal(r.status, 400, `${ref} → ${r.status}`);
  }
  assert.equal(fake.calls.length, before, 'no upstream call for a bad reference');
  assert.equal((await c.get('/api/scripture/EPH.2.8?version=abc')).status, 400);
  assert.equal((await c.get('/api/scripture/EPH.2.8?version=-1')).status, 400);
  assert.equal((await c.get('/api/scripture/EPH.2.8?version=999')).status, 400, 'a version the key cannot use');
  assert.equal((await c.get('/api/scripture/versions?lang=xx')).status, 400);
  assert.equal((await client(withKey.base).get('/api/scripture/EPH.2.8')).status, 401, 'signed in only');
});

test('with a key: YouVersion text in the chosen version, with its attribution; the key stays upstream', async () => {
  const c = record(await signup(withKey.base, 'listener'));
  const versions = await c.get('/api/scripture/versions?lang=en');
  assert.deepEqual(versions.json.versions.map((v) => [v.id, v.abbreviation, v.title, v.copyright]), [[111, 'TST', 'Test Version', '© Test Publisher']]);
  assert.equal(versions.json.default, null, 'no default until the owner approves one');

  const plain = await c.get('/api/scripture/EPH.2.8');
  assert.equal(plain.json.source, 'fallback', 'no version chosen yet: the fallback');
  const r = await c.get('/api/scripture/EPH.2.8?version=111');
  assert.equal(r.status, 200);
  assert.equal(r.json.text, `${UPSTREAM_TEXT} EPH.2.8`);
  assert.equal(r.json.reference, 'Ref EPH.2.8');
  assert.deepEqual(r.json.version, { id: 111, abbreviation: 'TST', title: 'Test Version', copyright: '© Test Publisher' });
  assert.equal(r.json.source, 'youversion');

  // The saved version is used when none is asked for.
  assert.equal((await c.putJson('/api/me/bible-version', { version: 111 })).json.bible_version, 111);
  assert.equal((await c.get('/api/me')).json.bible_version, 111);
  assert.equal((await c.get('/api/scripture/JHN.3.16')).json.version.id, 111);
  assert.equal((await c.putJson('/api/me/bible-version', { version: 999 })).status, 400);
  assert.equal((await c.putJson('/api/me/bible-version', { version: '1; DROP TABLE users' })).status, 400);
  const votd = await c.get('/api/scripture/votd');
  assert.deepEqual([votd.json.usfm, votd.json.source, votd.json.version.id], ['ISA.12.2', 'youversion', 111]);
  assert.equal((await c.putJson('/api/me/bible-version', { version: null })).json.bible_version, null);
  assert.equal((await c.get('/api/me')).json.bible_version, null);

  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) {
    assert.equal(call.key, KEY, 'the key is sent as X-YVP-App-Key');
    assert.ok(!call.url.includes(KEY), 'and never in a URL');
    assert.ok(ALLOWED_UPSTREAM.some((re) => re.test(call.url)), `only the three endpoints, with server-built URLs: ${call.url}`);
  }
});

test('an API error or a timeout falls back to the public-domain text; the request never fails', async () => {
  const c = record(await signup(withKey.base, 'patient'));
  await c.putJson('/api/me/bible-version', { version: 111 });
  try {
    fake.mode = 'error';
    const err = await c.get('/api/scripture/EPH.2.8');
    assert.equal(err.status, 200);
    assert.deepEqual([err.json.text, err.json.source, err.json.version.abbreviation], [fallbackText('EPH.2.8'), 'fallback', 'WEB']);
    fake.mode = 'timeout';
    const started = Date.now();
    const slow = await c.get('/api/scripture/PHP.4.7?version=111');
    assert.equal(slow.status, 200);
    assert.equal(slow.json.text, fallbackText('PHP.4.7'));
    assert.ok(Date.now() - started < 2000, 'the timeout is enforced');
    // Today's reference came from YouVersion earlier (cached for an hour) and isn't bundled: the reference alone.
    const votd = await c.get('/api/scripture/votd');
    assert.equal(votd.status, 200);
    assert.deepEqual([votd.json.usfm, votd.json.text, votd.json.source], ['ISA.12.2', null, 'none']);
  } finally {
    fake.mode = 'ok';
  }
});

test('the Scripture routes are rate-limited per listener: 60 a minute', async () => {
  const c = await signup(withKey.base, 'eager');
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await c.get('/api/scripture/JHN.3.16')).status);
  assert.deepEqual([statuses.slice(0, 60).every((s) => s === 200), statuses[60]], [true, 429]);
  const other = await signup(withKey.base, 'calm');
  assert.equal((await other.get('/api/scripture/JHN.3.16')).status, 200, 'another listener is not affected');
});

test('a song lists its references by section; only a catalog admin may replace them, and it is audit-logged', async () => {
  const songId = HYMN_IDS.song('amazing-grace');
  const c = record(await signup(withKey.base, 'singer'));
  const hymn = (await c.get('/api/search?q=amazing%20grace')).json.tracks.find((t) => t.title === 'Amazing Grace');
  assert.equal(hymn.song_id, songId, 'a hymn track knows its song');
  const other = (await c.get('/api/search?q=a')).json.tracks.find((t) => t.genre !== 'Hymn');
  assert.equal(other.song_id, null);

  const page = await c.get(`/api/songs/${songId}`);
  assert.deepEqual([page.status, page.json.title, page.json.artist, page.json.public_domain, page.json.tracks.map((t) => t.id)], [200, 'Amazing Grace', 'Ainos Hymnal', true, [hymn.id]]);
  assert.equal((await c.get('/api/songs/nope')).status, 404);
  const got = await c.get(`/api/songs/${songId}/scripture`);
  assert.deepEqual(got.json.groups, [{ section_label: null, references: HYMNS[0].scripture.map((usfm) => ({ usfm, reference: referenceName(usfm) })) }]);
  assert.equal((await c.get('/api/songs/nope/scripture')).status, 404);

  const body = { references: ['TIT.2.11', { usfm: 'eph.2.8', section_label: 'V1' }] };
  assert.equal((await c.putJson(`/api/songs/${songId}/scripture`, body)).status, 403, 'not an admin');
  const demo = await login(withKey.base);
  assert.equal((await demo.putJson(`/api/songs/${songId}/scripture`, body)).status, 403, 'the demo, though listed, is never an admin');

  const admin = record(adminClient);
  assert.equal((await admin.get('/api/me')).json.id, adminId);
  for (const bad of [{}, { references: 'EPH.2.8' }, { references: Array(21).fill('EPH.2.8') }, { references: ['EPH.2.8', 'eph.2.8'] },
    { references: ['NOPE.1'] }, { references: [{ usfm: 'EPH.2.8', section_label: 'Verse one' }] }, { references: [42] }]) {
    assert.equal((await admin.putJson(`/api/songs/${songId}/scripture`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const put = await admin.putJson(`/api/songs/${songId}/scripture`, body);
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.groups, [
    { section_label: null, references: [{ usfm: 'TIT.2.11', reference: 'Titus 2:11' }] },
    { section_label: 'V1', references: [{ usfm: 'EPH.2.8', reference: 'Ephesians 2:8' }] },
  ]);
  assert.deepEqual((await c.get(`/api/songs/${songId}/scripture`)).json, put.json);

  const db = new DatabaseSync(path.join(withKey.dataDir, 'ainos.db'), { readOnly: true });
  try {
    const log = db.prepare("SELECT user_id, action, target_type, target_id, details FROM audit_log WHERE action = 'song.scripture.replace'").all();
    assert.equal(log.length, 1, 'one entry: refused and invalid attempts change nothing');
    assert.deepEqual({ ...log[0], details: JSON.parse(log[0].details) }, { user_id: adminId, action: 'song.scripture.replace', target_type: 'song', target_id: songId, details: { references: ['TIT.2.11', 'EPH.2.8'] } });
  } finally {
    db.close();
  }
  await admin.putJson(`/api/songs/${songId}/scripture`, { references: HYMNS[0].scripture });
});

test('no verse text is stored in any table, and no response ever carries the key', async () => {
  for (const srv of [noKey, withKey]) {
    const db = new DatabaseSync(path.join(srv.dataDir, 'ainos.db'), { readOnly: true });
    try {
      const needles = [UPSTREAM_TEXT, fallbackText('EPH.2.8'), fallbackText('PHP.4.7'), FALLBACK_VERSES['JHN.3.16']];
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
        const cols = db.prepare(`PRAGMA table_info(${name})`).all().filter((c) => /TEXT/i.test(c.type) || c.type === '').map((c) => c.name);
        for (const col of cols) {
          for (const needle of needles) {
            const n = db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE instr(${col}, ?) > 0`).get(needle).n;
            assert.equal(n, 0, `${name}.${col} holds verse text`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  assert.ok(bodies.length > 40);
  for (const b of bodies) assert.ok(!b.includes(KEY), 'a response carried the app key');
  assert.ok(!YOUVERSION_API.includes(KEY));
});
