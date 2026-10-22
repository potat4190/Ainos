// Copy a generated SQLite catalog (scripts/generate.js) into Postgres.
//
//   DATABASE_URL=postgres://... node scripts/seed-postgres.js [path/to/ainos.db]
//
// Runs only when Postgres has no tracks yet, so user data is never overwritten.
// When tracks already exist it checks that their ids match the generated
// catalog: audio and art files are named after those ids, so a mismatch would
// mean every song 404s.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Parents before children, so foreign keys hold at every step.
const TABLES = [
  'artists', 'albums', 'tracks', 'track_files', 'users', 'playlists', 'playlist_tracks',
  'liked_tracks', 'followed_artists', 'streams', 'events', 'search_index',
];
const IDENTITY = ['users', 'playlist_tracks', 'events', 'streams'];

export async function seedPostgres({ sqliteFile, databaseUrl, log = console.log }) {
  const { default: pg } = await import('pg');
  const src = new DatabaseSync(sqliteFile, { readOnly: true });
  const client = new pg.Client({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
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
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
    src.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqliteFile = process.argv[2] || path.join(ROOT, 'data', 'ainos.db');
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  if (!fs.existsSync(sqliteFile)) { console.error(`No catalog at ${sqliteFile}. Run "npm run setup" first.`); process.exit(1); }
  seedPostgres({ sqliteFile, databaseUrl: process.env.DATABASE_URL }).catch((err) => { console.error(err.message); process.exit(1); });
}
