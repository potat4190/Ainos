// Songs in English or Nepali only, and numbered hymnals (spec 5.8): the hymn
// number parser, old languages moved to English, and a hymnal that stays
// hidden until its permission is recorded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, signup } from './helpers.js';
import { parseHymnNumber, westernDigits, devanagariDigits } from '../public/js/hymn-number.js';
import { SONG_LANGUAGES, songLanguage } from '../server/languages.js';
import { inOtherLanguage } from '../server/youtube-import.js';
import { openDb } from '../server/db.js';

test('hymn numbers are read in Western and Nepali digits', () => {
  for (const q of ['123', ' 123 ', '#123', '# 123', 'hymn 123', 'Hymn 123', 'no. 123', '१२३', 'भजन १२३', 'भजन 123', '#१२३']) {
    assert.equal(parseHymnNumber(q), 123, q);
  }
  for (const q of ['', 'amazing grace', '0', '12345', 'hymn', '123 amazing', 'psalm 23', '-5', '1.5']) {
    assert.equal(parseHymnNumber(q), null, q);
  }
  assert.equal(westernDigits('भजन ४५'), 'भजन 45');
  assert.equal(devanagariDigits(1990), '१९९०');
});

test('song languages are English and Nepali only', () => {
  assert.deepEqual(SONG_LANGUAGES, ['en', 'ne']);
  assert.equal(songLanguage('ne'), 'ne');
  for (const old of ['hi', 'zh', 'ja', 'es', '', null, undefined, 'NE']) assert.equal(songLanguage(old), 'en', String(old));
  assert.equal(songLanguage('es', 'ne'), 'ne');
  // Live search drops videos YouTube tags with another language; untagged ones are kept.
  assert.equal(inOtherLanguage({ defaultLanguage: 'es' }), true);
  assert.equal(inOtherLanguage({ defaultLanguage: 'ne' }), false);
  assert.equal(inOtherLanguage({ defaultLanguage: 'en-US' }), false);
  assert.equal(inOtherLanguage({}), false);
});

test('opening an older database moves other languages to English and hides other-language global songs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-lang-'));
  const file = path.join(dir, 'old.db');
  try {
    let db = openDb(file);
    db.exec(`INSERT INTO users (username, display_name, language, created_at) VALUES ('u-hi', 'U', 'hi', 0), ('u-ne', 'N', 'ne', 0);
      INSERT INTO orgs (id, name, default_language, created_by, created_at) VALUES ('o-es', 'Iglesia', 'es', 1, 0);
      INSERT INTO artists (id, name, genre, language, bio, image, color) VALUES ('ar-zh', 'Z', 'House', 'zh', '', 'x', '#000');
      INSERT INTO songs (id, title, artist, language, org_id, created_at, updated_at) VALUES
        ('s-ja', 'Global ja', 'A', 'ja', NULL, 0, 0), ('s-en', 'Global en', 'A', 'en', NULL, 0, 0), ('s-church', 'Church es', 'A', 'es', 'o-es', 0, 0);
      INSERT INTO song_sources (id, song_id, source, youtube_video_id, available) VALUES
        ('src-ja', 's-ja', 'youtube', 'aaaaaaaaaaa', 1), ('src-en', 's-en', 'youtube', 'bbbbbbbbbbb', 1), ('src-church', 's-church', 'youtube', 'ccccccccccc', 1);`);
    db.close();
    db = openDb(file); // the migration runs on every open
    const lang = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
    assert.deepEqual(lang('SELECT username, language FROM users ORDER BY username'), [{ username: 'u-hi', language: 'en' }, { username: 'u-ne', language: 'ne' }]);
    assert.equal(db.prepare("SELECT default_language FROM orgs WHERE id = 'o-es'").get().default_language, 'en');
    assert.equal(db.prepare("SELECT language FROM artists WHERE id = 'ar-zh'").get().language, 'en');
    assert.deepEqual(lang('SELECT id, available FROM song_sources ORDER BY id'),
      [{ id: 'src-church', available: 1 }, { id: 'src-en', available: 1 }, { id: 'src-ja', available: 0 }]);
    // A church's own song keeps its language.
    assert.equal(db.prepare("SELECT language FROM songs WHERE id = 's-church'").get().language, 'es');
    assert.ok(db.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'hymnal_id'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv?.close(); });

test('a hymnal stays hidden until its permission is recorded, then numbers songs in search and on slides', async () => {
  const store = srv.app.store;
  const A = await signup(srv.base, 'hymn-admin');
  const B = await signup(srv.base, 'hymn-other');
  const orgA = (await A.post('/api/orgs', { name: 'Kathmandu Fellowship' })).json.id;
  const orgB = (await B.post('/api/orgs', { name: 'Other Church' })).json.id;
  const song = await A.post(`/api/orgs/${orgA}/songs`, { title: 'येशू मेरो', text: 'Verse 1\nयेशू मेरो प्रभु' });
  assert.equal(song.status, 201, song.text);

  // No hymnal at all: nothing to pick, songs carry no number.
  assert.deepEqual((await A.get(`/api/orgs/${orgA}/hymnals`)).json, []);
  assert.equal((await A.get(`/api/orgs/${orgA}/songs`)).json.find((s) => s.id === song.json.id).hymn_number, null);

  // A hymnal without recorded permission is never shown or pickable.
  await store.run("INSERT INTO hymnals (id, name, language, permission_note, org_id, created_at) VALUES ('h-1', 'Nepali Hymnal', 'ne', NULL, NULL, 0)");
  await store.run('INSERT INTO hymnal_entries (hymnal_id, number, song_id) VALUES (?, ?, ?)', ['h-1', 123, song.json.id]);
  assert.deepEqual((await A.get(`/api/orgs/${orgA}/hymnals`)).json, []);
  assert.equal((await A.patch(`/api/orgs/${orgA}`, { hymnal_id: 'h-1' })).status, 400);

  // Once permission is recorded it is offered; another church's own hymnal is not.
  await store.run("UPDATE hymnals SET permission_note = 'Publisher permission (test)', permission_at = 1 WHERE id = 'h-1'");
  await store.run("INSERT INTO hymnals (id, name, language, permission_note, org_id, created_at) VALUES ('h-b', 'B only', 'ne', 'ok', ?, 0)", [orgB]);
  assert.deepEqual((await A.get(`/api/orgs/${orgA}/hymnals`)).json, [{ id: 'h-1', name: 'Nepali Hymnal', language: 'ne', entries: 1 }]);
  assert.equal((await A.patch(`/api/orgs/${orgA}`, { hymnal_id: 'h-b' })).status, 400);

  const set = await A.patch(`/api/orgs/${orgA}`, { hymnal_id: 'h-1' });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.hymnal, { id: 'h-1', name: 'Nepali Hymnal', language: 'ne' });
  assert.equal(set.json.name, 'Kathmandu Fellowship'); // a hymnal change leaves the name alone
  const audit = await store.all("SELECT action FROM audit_log WHERE org_id = ? AND action = 'org.hymnal'", [orgA]);
  assert.equal(audit.length, 1);

  const listed = (await A.get(`/api/orgs/${orgA}/songs`)).json.find((s) => s.id === song.json.id);
  assert.equal(listed.hymn_number, 123);

  const sl = await A.post(`/api/orgs/${orgA}/setlists`, { name: 'Sunday', service_date: '2026-11-22' });
  await A.putJson(`/api/orgs/${orgA}/setlists/${sl.json.id}/items`, { items: [{ kind: 'song', song_id: song.json.id }] });
  const deck = (await A.get(`/api/orgs/${orgA}/setlists/${sl.json.id}/slides`)).json;
  assert.equal(deck.items[0].hymnNumber, 123);

  // Permission withdrawn: the hymnal disappears again and numbers go with it.
  await store.run("UPDATE hymnals SET permission_note = NULL WHERE id = 'h-1'");
  assert.equal((await A.get(`/api/orgs/${orgA}`)).json.hymnal, null);
  assert.equal((await A.get(`/api/orgs/${orgA}/songs`)).json.find((s) => s.id === song.json.id).hymn_number, null);

  // Clearing the choice, and an empty PATCH.
  assert.equal((await A.patch(`/api/orgs/${orgA}`, { hymnal_id: null })).status, 200);
  assert.equal((await A.patch(`/api/orgs/${orgA}`, {})).status, 400);
  // Another church can't reach this church's hymnals.
  assert.equal((await B.get(`/api/orgs/${orgA}/hymnals`)).status, 404);
});
