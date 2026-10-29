// Bring Postgres up to date and copy a generated SQLite catalog
// (scripts/generate.js) into it.
//
//   DATABASE_URL=postgres://... node scripts/seed-postgres.js [path/to/ainos.db]
//
// With DATABASE_MIGRATION_URL (a connection as the tables' owner) it first
// applies server/schema.pg.sql, which creates missing tables and migrates
// existing ones. The app's own role (DATABASE_URL) can only read and write
// rows, so without it the script only checks that every table and column in
// schema.pg.sql exists, and stops if not. The catalog is copied only when Postgres has no
// tracks yet, so user data is never overwritten. When tracks already exist it
// checks that their ids match the generated catalog: audio and art files are
// named after those ids, so a mismatch would mean every song 404s.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pgConnection } from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT, 'server', 'schema.pg.sql');
const CERT_ERRORS = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

// Parents before children, so foreign keys hold at every step.
const TABLES = [
  'artists', 'albums', 'tracks', 'track_files', 'users', 'playlists', 'playlist_tracks',
  'liked_tracks', 'followed_artists', 'streams', 'events', 'search_index',
];
const IDENTITY = ['users', 'playlist_tracks', 'events', 'streams'];

// Lines in a table body that declare a table constraint, not a column.
const CONSTRAINT_LINE = /^(PRIMARY|UNIQUE|CHECK|CONSTRAINT|FOREIGN|EXCLUDE)\b/i;

/**
 * Tables and their columns as declared in schema.pg.sql. Expects one column
 * per line inside CREATE TABLE IF NOT EXISTS name (...), with the closing ");"
 * alone on its own line; table constraint lines are skipped.
 */
export function schemaColumns(sql = fs.readFileSync(SCHEMA_FILE, 'utf8')) {
  const tables = new Map();
  const code = sql.replace(/--.*$/gm, '');
  for (const m of code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    tables.set(m[1], m[2].split('\n').map((l) => l.trim()).filter((l) => l && !CONSTRAINT_LINE.test(l)).map((l) => l.split(/\s+/)[0]));
  }
  for (const m of code.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) if (!tables.get(m[1])?.includes(m[2])) tables.get(m[1])?.push(m[2]);
  return tables;
}

async function connect(pg, databaseUrl) {
  const client = new pg.Client(pgConnection(databaseUrl));
  try {
    await client.connect();
  } catch (err) {
    if (CERT_ERRORS.has(err.code)) {
      err.message += '. The database certificate is not signed by a CA this machine trusts. For Supabase, download the CA certificate'
        + ' (Project Settings > Database > SSL configuration) and put its contents in the DATABASE_CA_CERT environment variable.';
    }
    throw err;
  }
  return client;
}

/** Apply schema.pg.sql in one transaction (a transaction pooler keeps it on one connection). */
async function applySchema(pg, databaseUrl) {
  const owner = await connect(pg, databaseUrl);
  try {
    await owner.query('BEGIN');
    // Never wait long behind live traffic for a lock: fail the deploy instead.
    await owner.query("SET LOCAL lock_timeout = '10s'");
    await owner.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await owner.end();
  }
}

/** Throw if a table or column in schema.pg.sql is missing, or the app's role cannot see it. */
async function checkSchema(client) {
  const have = new Set((await client.query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()'))
    .rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = [...schemaColumns()].flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)).filter((x) => !have.has(x));
  if (missing.length) {
    throw new Error(`The database schema is behind server/schema.pg.sql (missing: ${missing.join(', ')}). Apply schema.pg.sql as the tables' owner`
      + ' (Supabase SQL editor, or set DATABASE_MIGRATION_URL for the build), and grant the app role access to any new table.');
  }
}

export async function seedPostgres({ sqliteFile, databaseUrl, migrationUrl, log = console.log }) {
  const { default: pg } = await import('pg');
  if (migrationUrl) {
    await applySchema(pg, migrationUrl);
    log('✓ Postgres schema applied');
  }
  const src = new DatabaseSync(sqliteFile, { readOnly: true });
  let client;
  try {
    client = await connect(pg, databaseUrl);
    await checkSchema(client);
    log('✓ Postgres schema up to date');

    // Sort in JS: Postgres orders text by locale collation, SQLite by bytes.
    const generatedIds = src.prepare('SELECT id FROM tracks').all().map((r) => r.id).sort();
    const existing = (await client.query('SELECT id FROM tracks')).rows.map((r) => r.id).sort();
    if (existing.length) {
      const same = existing.length === generatedIds.length && existing.every((id, i) => id === generatedIds[i]);
      if (!same) throw new Error(`Postgres already has ${existing.length} tracks that do not match the generated catalog (${generatedIds.length}). Audio files would not line up; refusing to continue.`);
      log(`✓ Postgres already seeded (${existing.length} tracks match the generated catalog)`);
      return { seeded: false };
    }

    await client.query('BEGIN');
    for (const table of TABLES) {
      const rows = src.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const per = Math.max(1, Math.floor(30000 / cols.length)); // stay under Postgres' 65535-parameter limit
      for (let i = 0; i < rows.length; i += per) {
        const batch = rows.slice(i, i + per);
        let n = 0;
        const values = batch.map(() => `(${cols.map(() => `$${++n}`).join(', ')})`).join(', ');
        await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`, batch.flatMap((r) => cols.map((c) => r[c])));
      }
      log(`  ${table}: ${rows.length} rows`);
    }
    // Rows were inserted with explicit ids; move each identity sequence past them.
    for (const table of IDENTITY) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
    }
    await client.query('COMMIT');
    log('✓ Postgres seeded');
    return { seeded: true };
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client?.end();
    src.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqliteFile = process.argv[2] || path.join(ROOT, 'data', 'ainos.db');
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  if (!fs.existsSync(sqliteFile)) { console.error(`No catalog at ${sqliteFile}. Run "npm run setup" first.`); process.exit(1); }
  seedPostgres({ sqliteFile, databaseUrl: process.env.DATABASE_URL, migrationUrl: process.env.DATABASE_MIGRATION_URL }).catch((err) => { console.error(err.message); process.exit(1); });
}
