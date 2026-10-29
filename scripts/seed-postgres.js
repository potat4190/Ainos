// Bring Postgres up to date and copy a generated SQLite catalog
// (scripts/generate.js) into it.
//
//   DATABASE_URL=postgres://... node scripts/seed-postgres.js [path/to/ainos.db]
//
// With DATABASE_MIGRATION_URL (a connection as the tables' owner) it first
// applies server/schema.pg.sql, which creates missing tables and migrates
// existing ones. The app's own role (DATABASE_URL) can only read and write
// rows, so without it the script only checks that every table and column in
// schema.pg.sql exists, and stops if not.
//
// An empty database gets the whole generated catalog (and its simulated
// listeners). A database that already has it gets a catalog sync instead:
// every existing track id must still be generated (audio and art files are
// named after those ids, so a lost id would mean a song 404s); new catalog
// rows, such as appended hymns, are added and display fields (names, lyrics)
// refreshed. Measured values (loudness, audio features), existing playlist
// contents and all user data are never touched.
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
  'songs', 'song_aliases', 'song_themes', 'song_sources', 'song_sections', 'song_arrangements',
];

// The rows the generator owns, in foreign-key order: what a catalog sync may
// insert, and which columns it may refresh on rows that already exist. Only
// display fields are refreshed; tracks keep the loudness and features
// measured when they were first seeded. `where` picks the generated rows
// (the generator also writes a demo user and its private playlist).
export const CATALOG_SYNC = [
  { table: 'artists', key: ['id'], update: ['name', 'genre', 'language', 'bio', 'image', 'color'] },
  { table: 'albums', key: ['id'], update: ['title', 'year', 'type', 'cover', 'color'] },
  { table: 'tracks', key: ['id'], update: ['title'] },
  { table: 'track_files', key: ['track_id', 'quality'], update: [] },
  { table: 'playlists', key: ['id'], where: 'owner_id IS NULL', update: ['name', 'description', 'color'] },
  { table: 'search_index', key: ['kind', 'ref_id'], where: "kind <> 'playlist' OR ref_id IN (SELECT id FROM playlists WHERE owner_id IS NULL)", update: ['title', 'subtitle', 'folded'] },
  { table: 'songs', key: ['id'], where: 'org_id IS NULL', update: ['title', 'artist', 'language', 'ccli_number', 'public_domain', 'updated_at'] },
  { table: 'song_aliases', key: ['song_id', 'folded'], where: 'song_id IN (SELECT id FROM songs WHERE org_id IS NULL)', update: ['alias'] },
  { table: 'song_themes', key: ['song_id', 'theme'], where: 'song_id IN (SELECT id FROM songs WHERE org_id IS NULL)', update: [] },
  { table: 'song_sources', key: ['id'], where: 'song_id IN (SELECT id FROM songs WHERE org_id IS NULL)', update: ['kind'] },
  { table: 'song_sections', key: ['id'], where: 'org_id IS NULL', update: ['lines', 'folded'] },
  { table: 'song_arrangements', key: ['id'], where: 'org_id IS NULL', update: ['name', 'section_order'] },
];

/**
 * What to do with a database, given its track ids and the generated ones:
 * seed it (empty), sync it (every existing id is still generated; `added`
 * lists the new ones) or refuse (`lost`: ids whose audio would no longer exist).
 */
export function planCatalog(generatedIds, existingIds) {
  if (!existingIds.length) return { action: 'seed' };
  const generated = new Set(generatedIds);
  const lost = existingIds.filter((id) => !generated.has(id));
  if (lost.length) return { action: 'refuse', lost };
  const existing = new Set(existingIds);
  return { action: 'sync', added: generatedIds.filter((id) => !existing.has(id)) };
}

/**
 * INSERT for one batch of rows. With a key it becomes an upsert: existing
 * rows get the `update` columns, and only when one of them actually changed
 * (no rewrite on every deploy). RETURNING tells inserted rows (xmax = 0)
 * from updated ones.
 */
export function upsertSql(table, cols, key, update, rowCount) {
  let n = 0;
  const values = Array.from({ length: rowCount }, () => `(${cols.map(() => `$${++n}`).join(', ')})`).join(', ');
  let conflict = '';
  if (key.length) {
    conflict = update.length
      ? ` ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(', ')} WHERE ${update.map((c) => `${table}.${c} IS DISTINCT FROM excluded.${c}`).join(' OR ')}`
      : ` ON CONFLICT (${key.join(', ')}) DO NOTHING`;
  }
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}${conflict} RETURNING (xmax = 0) AS inserted`;
}

/** Run a statement per batch of rows, under Postgres' 65535-parameter limit. */
async function inBatches(client, rows, cols, sql) {
  const per = Math.max(1, Math.floor(30000 / cols.length));
  const results = [];
  for (let i = 0; i < rows.length; i += per) {
    const batch = rows.slice(i, i + per);
    results.push(...(await client.query(sql(batch.length), batch.flatMap((r) => cols.map((c) => r[c])))).rows);
  }
  return results;
}

/** Add new catalog rows and refresh display fields; see CATALOG_SYNC. */
async function syncCatalog(client, src, log) {
  const before = new Set((await client.query('SELECT id FROM playlists WHERE owner_id IS NULL')).rows.map((r) => r.id));
  const totals = { inserted: 0, updated: 0 };
  for (const { table, key, update, where } of CATALOG_SYNC) {
    const rows = src.prepare(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`).all();
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const result = await inBatches(client, rows, cols, (count) => upsertSql(table, cols, key, update, count));
    const inserted = result.filter((r) => r.inserted).length;
    totals.inserted += inserted;
    totals.updated += result.length - inserted;
    if (result.length) log(`  ${table}: ${inserted} added, ${result.length - inserted} updated`);
  }
  // A new editorial playlist (e.g. Hymns) gets its tracks; existing playlists
  // keep theirs. Row ids come from the identity sequence, not the generator.
  const cols = ['playlist_id', 'track_id', 'position', 'added_at'];
  for (const { id } of src.prepare('SELECT id FROM playlists WHERE owner_id IS NULL').all()) {
    if (before.has(id)) continue;
    const items = src.prepare('SELECT playlist_id, track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(id);
    if (!items.length) continue;
    await inBatches(client, items, cols, (count) => upsertSql('playlist_tracks', cols, [], [], count));
    totals.inserted += items.length;
    log(`  playlist_tracks: ${items.length} added to new playlist ${id}`);
  }
  return totals;
}
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
    const plan = planCatalog(generatedIds, existing);
    if (plan.action === 'refuse') {
      throw new Error(`Postgres has ${plan.lost.length} track(s) the generated catalog no longer has (${plan.lost.slice(0, 5).join(', ')}). Their audio would 404; refusing to continue.`);
    }
    if (plan.action === 'sync') {
      log(`✓ Postgres already seeded (${existing.length} tracks match the generated catalog${plan.added.length ? `; ${plan.added.length} new` : ''})`);
      await client.query('BEGIN');
      // Never wait long behind live traffic for a row lock: fail the deploy instead.
      await client.query("SET LOCAL lock_timeout = '10s'");
      const totals = await syncCatalog(client, src, log);
      await client.query('COMMIT');
      log(`✓ Catalog synced (${totals.inserted} rows added, ${totals.updated} updated)`);
      return { seeded: false, synced: totals, added: plan.added.length };
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
