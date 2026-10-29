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
import { planCatalog, upsertSql, CATALOG_SYNC, schemaColumns } from '../scripts/seed-postgres.js';
import { generateCatalog } from '../scripts/generate.js';

test('plan: seed an empty database, sync one whose tracks are all still generated, refuse otherwise', () => {
  assert.deepEqual(planCatalog(['a', 'b'], []), { action: 'seed' });
  assert.deepEqual(planCatalog(['a', 'b'], ['a', 'b']), { action: 'sync', added: [] });
  assert.deepEqual(planCatalog(['a', 'b', 'h1', 'h2'], ['a', 'b']), { action: 'sync', added: ['h1', 'h2'] }, 'appended hymns');
  assert.deepEqual(planCatalog(['a', 'c'], ['a', 'b']), { action: 'refuse', lost: ['b'] }, 'a track whose audio would 404');
  assert.deepEqual(planCatalog([], ['a']), { action: 'refuse', lost: ['a'] });
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

test('a sync only refreshes display fields: never ids, measured audio values or user data', () => {
  const columns = schemaColumns();
  const MEASURED = ['loudness_lufs', 'peak_db', 'tempo', 'key', 'mode', 'energy', 'valence', 'danceability', 'acousticness', 'instrumentalness', 'duration_ms', 'bytes'];
  const USER_TABLES = ['users', 'sessions', 'liked_tracks', 'followed_artists', 'streams', 'events', 'generated_playlists', 'rate_limits', 'audit_log', 'playlist_tracks'];
  for (const { table, key, update } of CATALOG_SYNC) {
    assert.ok(columns.has(table), `${table} is in schema.pg.sql`);
    assert.ok(!USER_TABLES.includes(table), `${table} holds user data`);
    for (const c of [...key, ...update]) assert.ok(columns.get(table).includes(c), `${table}.${c} exists`);
    for (const c of update) {
      assert.ok(!key.includes(c) && c !== 'id' && !c.endsWith('_id'), `${table}.${c}: keys and references are never rewritten`);
      assert.ok(!MEASURED.includes(c), `${table}.${c}: measured values stay as first seeded`);
    }
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
  for (const { table, where } of CATALOG_SYNC) {
    const rows = db.prepare(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`).all();
    if (table === 'playlists') {
      assert.ok(rows.length >= 6 && rows.every((r) => r.owner_id === null), 'editorial playlists only, not the demo’s private one');
    }
  }
  const demoPlaylist = db.prepare('SELECT id FROM playlists WHERE owner_id IS NOT NULL').get();
  assert.ok(demoPlaylist, 'the generator does write a private demo playlist');
  const synced = db.prepare(`SELECT ref_id FROM search_index WHERE ${CATALOG_SYNC.find((s) => s.table === 'search_index').where}`).all().map((r) => r.ref_id);
  assert.ok(!synced.includes(demoPlaylist.id));
});
