// Deploys keep working when the generated catalog grows: scripts/seed-postgres.js
// seeds an empty database, syncs one that already has the catalog (new rows
// added, display fields refreshed), and refuses one whose tracks would lose
// their audio. Postgres isn't available in tests, so this checks the plan,
// the SQL it builds and the rules for which columns a sync may touch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planCatalog, catalogAction, upsertSql, pruneSql, appendToPlaylist, CATALOG_SYNC, CATALOG_PRUNE, schemaColumns } from '../scripts/seed-postgres.js';
import { generateCatalog } from '../scripts/generate.js';

test('plan: seed an empty database, sync one whose tracks are all still generated, refuse otherwise', () => {
  assert.deepEqual(planCatalog(['a', 'b'], []), { action: 'seed' });
  assert.deepEqual(planCatalog(['a', 'b'], ['a', 'b']), { action: 'sync', added: [] });
  assert.deepEqual(planCatalog(['a', 'b', 'h1', 'h2'], ['a', 'b']), { action: 'sync', added: ['h1', 'h2'] }, 'appended hymns');
  assert.deepEqual(planCatalog(['a', 'c'], ['a', 'b']), { action: 'refuse', lost: ['b'], added: ['c'] }, 'a track whose audio would 404');
  assert.deepEqual(planCatalog([], ['a']), { action: 'refuse', lost: ['a'], added: [] });
});

test('upsert SQL: numbered placeholders, conflict target, and updates only when something changed', () => {
  assert.equal(upsertSql('tracks', ['id', 'title'], ['id'], ['title'], 2),
    'INSERT INTO tracks (id, title) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO UPDATE SET title = excluded.title'
    + ' WHERE tracks.title IS DISTINCT FROM excluded.title RETURNING (xmax = 0) AS inserted');
  assert.equal(upsertSql('t', ['a', 'b', 'c'], ['a', 'b'], ['c'], 1),
    'INSERT INTO t (a, b, c) VALUES ($1, $2, $3) ON CONFLICT (a, b) DO UPDATE SET c = excluded.c WHERE t.c IS DISTINCT FROM excluded.c RETURNING (xmax = 0) AS inserted');
  assert.equal(upsertSql('track_files', ['track_id', 'quality'], ['track_id', 'quality'], [], 1),
    'INSERT INTO track_files (track_id, quality) VALUES ($1, $2) ON CONFLICT (track_id, quality) DO NOTHING RETURNING (xmax = 0) AS inserted');
  assert.equal(upsertSql('playlist_tracks', ['a'], [], [], 3), 'INSERT INTO playlist_tracks (a) VALUES ($1), ($2), ($3) RETURNING (xmax = 0) AS inserted',
    'no key: a plain insert (new editorial playlists only)');
  const twoCols = upsertSql('songs', ['id', 'title', 'artist'], ['id'], ['title', 'artist'], 1);
  assert.match(twoCols, /SET title = excluded\.title, artist = excluded\.artist WHERE songs\.title IS DISTINCT FROM excluded\.title OR songs\.artist IS DISTINCT FROM excluded\.artist/);
});

test('a sync refreshes display fields only (and hymn audio measurements), never ids or user data, and guards the target row', () => {
  const columns = schemaColumns();
  const MEASURED = ['loudness_lufs', 'peak_db', 'tempo', 'key', 'mode', 'energy', 'valence', 'danceability', 'acousticness', 'instrumentalness', 'duration_ms', 'bytes'];
  const USER_TABLES = ['users', 'sessions', 'liked_tracks', 'followed_artists', 'streams', 'events', 'generated_playlists', 'rate_limits', 'audit_log', 'playlist_tracks'];
  for (const { table, key, update, where, target, regenerated } of CATALOG_SYNC) {
    assert.ok(columns.has(table), `${table} is in schema.pg.sql`);
    assert.ok(!USER_TABLES.includes(table), `${table} holds user data`);
    for (const c of [...key, ...update]) assert.ok(columns.get(table).includes(c), `${table}.${c} exists`);
    for (const c of update) {
      assert.ok(!key.includes(c) && c !== 'id' && !c.endsWith('_id'), `${table}.${c}: keys and references are never rewritten`);
      // Original tracks keep the measurements of their first seed; hymn audio is
      // rendered from scripts/hymns.js, so only hymn rows may follow it.
      if (MEASURED.includes(c)) assert.ok(regenerated && /genre = 'Hymn'/.test(where) && /genre = 'Hymn'/.test(target), `${table}.${c}: measured values only for hymns`);
    }
    // Rows a user or church can own are guarded in Postgres, not just picked from the generated file.
    if (update.length && /owner_id|org_id|song_id IN/.test(where || '')) assert.ok(target?.includes(`${table}.`), `${table}: target guard`);
  }
  const order = CATALOG_SYNC.map((s) => s.table);
  for (const [parent, child] of [['artists', 'albums'], ['albums', 'tracks'], ['tracks', 'track_files'], ['songs', 'song_sources'], ['tracks', 'song_sources'],
    ['songs', 'song_sections'], ['songs', 'song_aliases'], ['songs', 'song_themes'], ['songs', 'song_arrangements'], ['playlists', 'search_index']]) {
    assert.ok(order.indexOf(parent) < order.indexOf(child), `${parent} before ${child}`);
  }
});

let dir, db;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-seed-'));
  await generateCatalog({ dataDir: dir, quick: true, quiet: true, simulatedUsers: 5 });
  db = new DatabaseSync(path.join(dir, 'ainos.db'), { readOnly: true });
});
after(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sync reads only generator-owned rows from the generated catalog', () => {
  const read = (s) => db.prepare(`SELECT * FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ''}`).all();
  for (const s of CATALOG_SYNC) {
    const rows = read(s);
    assert.ok(rows.length > 0, `${s.table}${s.where ? ` (${s.where})` : ''} has generated rows`);
    if (s.table === 'playlists') assert.ok(rows.length >= 7 && rows.every((r) => r.owner_id === null), 'editorial playlists only, not the demo’s private one');
    if (['songs', 'song_sections', 'song_arrangements'].includes(s.table)) assert.ok(rows.every((r) => r.org_id === null), `${s.table}: global rows only`);
    if (s.regenerated && s.table === 'tracks') assert.ok(rows.length === 8 && rows.every((r) => r.genre === 'Hymn'), 'measurements refreshed for hymns only');
    if (s.regenerated && s.table === 'track_files') assert.equal(rows.length, 16, 'hymn files only');
  }
  for (const p of CATALOG_PRUNE) {
    const keep = db.prepare(`SELECT ${p.id} AS k FROM ${p.table}`).all();
    assert.ok(keep.length > 0 && keep.every((r) => typeof r.k === 'string' && r.k), `${p.table}: prune keys readable in SQLite`);
  }
  const demoPlaylist = db.prepare('SELECT id FROM playlists WHERE owner_id IS NOT NULL').get();
  assert.ok(demoPlaylist, 'the generator does write a private demo playlist');
  const synced = db.prepare(`SELECT ref_id FROM search_index WHERE ${CATALOG_SYNC.find((s) => s.table === 'search_index').where}`).all().map((r) => r.ref_id);
  assert.ok(!synced.includes(demoPlaylist.id));
});

test('a preview build older than its database skips the sync; production refuses', () => {
  const lost = planCatalog(['a'], ['a', 'hymn']);
  assert.equal(catalogAction(lost), 'refuse');
  assert.equal(catalogAction(lost, { lostTracks: 'refuse' }), 'refuse');
  assert.equal(catalogAction(lost, { lostTracks: 'warn' }), 'skip', 'a branch simply older than the database');
  assert.equal(catalogAction(planCatalog(['a', 'renamed'], ['a', 'b']), { lostTracks: 'warn' }), 'refuse', 'a changed id (one lost, one added) is refused even in preview');
  assert.equal(catalogAction(planCatalog(['a', 'b'], ['a']), { lostTracks: 'warn' }), 'sync', 'warn mode changes nothing else');
  assert.equal(catalogAction(planCatalog(['a'], []), { lostTracks: 'warn' }), 'seed');
});

test('upsert SQL with a target guard updates only rows the generator owns', () => {
  assert.equal(upsertSql('playlists', ['id', 'name'], ['id'], ['name'], 1, 'playlists.owner_id IS NULL'),
    'INSERT INTO playlists (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = excluded.name'
    + ' WHERE (playlists.owner_id IS NULL) AND (playlists.name IS DISTINCT FROM excluded.name) RETURNING (xmax = 0) AS inserted');
  assert.match(upsertSql('t', ['a', 'b'], ['a'], [], 1, 't.x IS NULL'), /ON CONFLICT \(a\) DO NOTHING RETURNING/, 'no update, no guard needed');
});

test('stale lyrics of generator-owned songs are pruned; church rows, sources and aliases never', () => {
  assert.deepEqual(CATALOG_PRUNE.map((p) => p.table).sort(), ['song_arrangements', 'song_sections', 'song_themes']);
  assert.equal(pruneSql(CATALOG_PRUNE.find((p) => p.table === 'song_sections')),
    'DELETE FROM song_sections WHERE song_id = ANY($1::text[]) AND org_id IS NULL AND NOT ((id) = ANY($2::text[]))');
  for (const p of CATALOG_PRUNE) {
    assert.match(pruneSql(p), /WHERE song_id = ANY\(\$1::text\[\]\)/, `${p.table}: limited to the generator's songs`);
    if (p.table !== 'song_themes') assert.equal(p.scope, 'org_id IS NULL', `${p.table}: global rows only`);
  }
});

test('editorial playlists gain only tracks the generator adds; playlists it does not fully own are left alone', () => {
  assert.deepEqual(appendToPlaylist(['a', 'b'], ['a', 'b', 'c']), ['c']);
  assert.deepEqual(appendToPlaylist([], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(appendToPlaylist(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(appendToPlaylist(['a', 'x'], ['a', 'b']), [], 'has a track the generator does not put there');
  assert.deepEqual(appendToPlaylist(['b', 'a'], ['a', 'b', 'c']), ['c'], 'order of existing tracks is kept');
});
