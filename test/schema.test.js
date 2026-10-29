// The two schemas must describe the same tables. Every deploy checks the live
// Postgres database against the tables and columns parsed from schema.pg.sql
// (scripts/seed-postgres.js), as the app's own role, so a new table also needs
// a GRANT to that role, and every table keeps row-level security on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaColumns } from '../scripts/seed-postgres.js';
import { openDb } from '../server/db.js';

const PG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'schema.pg.sql');
const pgSql = fs.readFileSync(PG_FILE, 'utf8');
const code = pgSql.replace(/--.*$/gm, '');

// Tables granted to the app role by hand before schema.pg.sql carried GRANTs.
const GRANTED_BY_HAND = ['users', 'sessions', 'artists', 'albums', 'tracks', 'track_files', 'playlists', 'playlist_tracks',
  'liked_tracks', 'followed_artists', 'events', 'streams', 'generated_playlists', 'search_index'];

function sqliteColumns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-schema-'));
  const db = openDb(path.join(dir, 'schema.db'));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    return new Map(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)]));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the deploy check parses columns, skipping table constraints and comments', () => {
  const sql = `
CREATE TABLE IF NOT EXISTS songs (
  id        TEXT PRIMARY KEY,
  org_id    TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('a', 'b')),
  -- note TEXT (a comment, not a column)
  PRIMARY KEY (id),
  UNIQUE (org_id, kind),
  unique_name TEXT,
  CHECK (org_id IS NOT NULL OR kind = 'a'),
  CONSTRAINT songs_x FOREIGN KEY (org_id) REFERENCES orgs(id),
  FOREIGN KEY (kind) REFERENCES kinds(id)
);
-- ALTER TABLE songs ADD COLUMN ghost TEXT
DO $$ BEGIN ALTER TABLE songs ADD COLUMN extra TEXT; END $$;`;
  assert.deepEqual(Object.fromEntries(schemaColumns(sql)), { songs: ['id', 'org_id', 'kind', 'unique_name', 'extra'] });
});

test('SQLite (db.js) and Postgres (schema.pg.sql) have the same tables and columns', () => {
  const pg = schemaColumns(pgSql);
  const lite = sqliteColumns();
  assert.deepEqual([...pg.keys()].sort(), [...lite.keys()].sort(), 'tables');
  for (const [table, cols] of pg) assert.deepEqual([...cols].sort(), [...lite.get(table)].sort(), `columns of ${table}`);
});

test('every Postgres table has row-level security on and is granted to the app role', () => {
  const tables = [...schemaColumns(pgSql).keys()];
  const rls = /FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/.exec(code);
  assert.ok(rls, 'the RLS loop is in schema.pg.sql');
  const rlsTables = [...rls[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(tables.filter((t) => !rlsTables.includes(t)), [], 'add these to the RLS array');

  const granted = [...code.matchAll(/GRANT SELECT, INSERT, UPDATE, DELETE ON ([\w,\s]+?) TO ainos_app/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const needGrant = tables.filter((t) => !GRANTED_BY_HAND.includes(t));
  assert.deepEqual(needGrant.filter((t) => !granted.includes(t)), [], 'add these to the GRANT block');
});

test('new tables use text ids, not identity columns (which would need a sequence grant too)', () => {
  for (const m of code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    if (GRANTED_BY_HAND.includes(m[1])) continue;
    assert.doesNotMatch(m[2], /GENERATED .* AS IDENTITY/i, `${m[1]} uses an identity column`);
  }
});
