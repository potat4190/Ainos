// Postgres-specific behaviour, against real Postgres run in-process by PGlite
// (a dev dependency, never imported by the app): schema.pg.sql, and the
// deploy-time seed and catalog sync in scripts/seed-postgres.js. PGlite is
// not Supabase (no pooler, one role in practice), so a preview deployment
// stays the final check against the real thing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateCatalog, HYMN_IDS } from '../scripts/generate.js';
import { seedPostgres, schemaColumns } from '../scripts/seed-postgres.js';
import { ARTISTS, ALBUMS, TRACKS } from '../scripts/catalog-names.js';

const PGlite = await import('@electric-sql/pglite').then((m) => m.PGlite, () => null);
const SKIP = !PGlite && 'needs npm install (@electric-sql/pglite, a dev dependency)';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** pg's client interface (query(sql, params) → { rows, rowCount }, end()) over one PGlite database. */
function pgClient(db) {
  return {
    async query(sql, params) {
      if (params === undefined) { // may hold several statements (schema.pg.sql, BEGIN, …)
        const results = await db.exec(sql);
        const last = results[results.length - 1] || { rows: [] };
        return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
      }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async end() {},
  };
}

const SCHEMA = fs.readFileSync(path.join(ROOT, 'server', 'schema.pg.sql'), 'utf8');
// Tables that only schema.pg.sql's own GRANT block gives ainos_app.
const BLOCK_GRANTED = /GRANT SELECT, INSERT, UPDATE, DELETE ON ([^;]*?) TO ainos_app/.exec(SCHEMA)[1].split(/,\s*/);

/**
 * A database set up like Supabase: the owner applies the schema, the app and
 * the deploy-time sync connect as ainos_app (BYPASSRLS, row-level grants). As
 * in production, ainos_app was granted the tables that existed when the role
 * was made (here: all but BLOCK_GRANTED) and relies on schema.pg.sql for the rest.
 * connectTo('owner') and connectTo('app') switch roles on the one PGlite session.
 */
async function newDatabase({ schema = true } = {}) {
  const db = new PGlite();
  await db.exec('CREATE ROLE ainos_app BYPASSRLS; GRANT USAGE ON SCHEMA public TO ainos_app');
  if (schema) {
    await db.exec(SCHEMA);
    await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ainos_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ainos_app;
      REVOKE ALL ON ${BLOCK_GRANTED.join(', ')} FROM ainos_app`);
  }
  const connectTo = async (url) => {
    await db.exec(url === 'owner' ? 'RESET ROLE' : 'SET ROLE ainos_app');
    return pgClient(db);
  };
  return { db, connectTo };
}
const quiet = () => {};
const seed = (pg, sqliteFile, opts = {}) => seedPostgres({ sqliteFile, databaseUrl: 'app', migrationUrl: 'owner', log: quiet, connectTo: pg.connectTo, ...opts });
const rows = async (pg, sql, params) => (await pg.db.query(sql, params)).rows;
const count = async (pg, sql, params) => Number((await rows(pg, sql, params))[0].n);

let dir, full, noHymns, oldNames;
before(async () => {
  if (SKIP) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-pg-'));
  await generateCatalog({ dataDir: dir, quick: true, quiet: true, simulatedUsers: 5 });
  full = path.join(dir, 'ainos.db');
  // The catalog under its original names, as production had it before the owner's picks.
  const entries = [ARTISTS, ALBUMS, TRACKS].flatMap((t) => Object.values(t));
  const saved = entries.map((e) => ({ pick: e.pick, custom: e.custom }));
  try {
    for (const e of entries) Object.assign(e, { pick: null, custom: null });
    const old = path.join(dir, 'old-names');
    await generateCatalog({ dataDir: old, quick: true, quiet: true, simulatedUsers: 5 });
    oldNames = path.join(old, 'ainos.db');
  } finally {
    entries.forEach((e, i) => Object.assign(e, saved[i]));
  }
  // The catalog as production has it before Phase 1: no hymns, songs or Hymns playlist.
  noHymns = path.join(dir, 'no-hymns.db');
  fs.copyFileSync(full, noHymns);
  const db = new DatabaseSync(noHymns);
  const hymnTracks = db.prepare("SELECT id FROM tracks WHERE genre = 'Hymn'").all().map((r) => r.id);
  const refs = [...hymnTracks, HYMN_IDS.artist, HYMN_IDS.album, HYMN_IDS.playlist];
  const marks = (list) => list.map(() => '?').join(', ');
  for (const table of ['song_arrangements', 'song_sections', 'song_sources', 'song_themes', 'song_aliases', 'songs']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ?`).run(HYMN_IDS.playlist);
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(HYMN_IDS.playlist);
  db.prepare(`DELETE FROM search_index WHERE ref_id IN (${marks(refs)})`).run(...refs);
  db.prepare(`DELETE FROM track_files WHERE track_id IN (${marks(hymnTracks)})`).run(...hymnTracks);
  db.prepare("DELETE FROM tracks WHERE genre = 'Hymn'").run();
  db.prepare('DELETE FROM albums WHERE id = ?').run(HYMN_IDS.album);
  db.prepare('DELETE FROM artists WHERE id = ?').run(HYMN_IDS.artist);
  db.close();
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

/** A copy of the generated catalog with `edit(db)` applied. */
function editedCatalog(name, edit) {
  const file = path.join(dir, `${name}.db`);
  fs.copyFileSync(full, file);
  const db = new DatabaseSync(file);
  edit(db);
  db.close();
  return file;
}

test('schema.pg.sql applies, re-applies, and every table has row-level security and the app grant', { skip: SKIP }, async () => {
  const pg = await newDatabase({ schema: false });
  const sql = SCHEMA;
  await pg.db.exec(sql);
  await pg.db.exec(sql); // every statement must be safe to re-run
  const have = new Set((await rows(pg, "SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'")).map((r) => r.k));
  const missing = [...schemaColumns(sql)].flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)).filter((k) => !have.has(k));
  assert.deepEqual(missing, [], 'the deploy check would find every table and column');
  const tables = await rows(pg, "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'");
  assert.ok(tables.length >= 22);
  assert.deepEqual(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname), [], 'row-level security on');
  assert.equal(await count(pg, "SELECT COUNT(*) AS n FROM pg_policies WHERE schemaname = 'public'"), 0, 'and no policies');
  for (const t of ['rate_limits', 'audit_log', 'songs', 'song_aliases', 'song_themes', 'song_sources', 'song_sections', 'song_arrangements', 'song_scripture', 'user_settings']) {
    assert.equal((await rows(pg, "SELECT has_table_privilege('ainos_app', $1, 'SELECT,INSERT,UPDATE,DELETE') AS ok", [t]))[0].ok, true, `${t} granted`);
  }
});

test('an empty database is seeded with the whole catalog; a second run changes nothing', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  assert.deepEqual(await seed(pg, full), { seeded: true });
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM tracks'), 41);
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM songs WHERE public_domain = 1'), 8);
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = $1', [HYMN_IDS.playlist]), 8);
  const again = await seed(pg, full);
  assert.deepEqual(again.synced, { inserted: 0, updated: 0, deleted: 0 });
});

test('production upgrade: a database seeded before the hymns gains them, and nothing else changes', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, noHymns);
  const editorialBefore = await rows(pg, 'SELECT playlist_id, track_id, position FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE owner_id IS NULL) ORDER BY playlist_id, position');
  const tracksBefore = await rows(pg, 'SELECT * FROM tracks ORDER BY id');
  const result = await seed(pg, full);
  assert.equal(result.added, 8);
  const src = new DatabaseSync(full, { readOnly: true });
  try {
    for (const table of ['tracks', 'track_files', 'artists', 'albums', 'songs', 'song_aliases', 'song_themes', 'song_sources', 'song_sections', 'song_arrangements', 'song_scripture']) {
      assert.equal(await count(pg, `SELECT COUNT(*) AS n FROM ${table}`), src.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, `${table} matches the generated catalog`);
    }
  } finally {
    src.close();
  }
  assert.deepEqual((await rows(pg, 'SELECT track_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position', [HYMN_IDS.playlist])).map((r) => r.track_id),
    (await rows(pg, 'SELECT id FROM tracks WHERE album_id = $1 ORDER BY track_no', [HYMN_IDS.album])).map((r) => r.id), 'the Hymns playlist holds the album');
  const editorialAfter = await rows(pg, 'SELECT playlist_id, track_id, position FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE owner_id IS NULL) AND playlist_id <> $1 ORDER BY playlist_id, position', [HYMN_IDS.playlist]);
  assert.deepEqual(editorialAfter, editorialBefore, 'the six original editorial playlists are untouched');
  const tracksAfter = await rows(pg, "SELECT * FROM tracks WHERE genre <> 'Hymn' ORDER BY id");
  assert.deepEqual(tracksAfter, tracksBefore, 'original tracks, measurements included, are untouched');
  assert.deepEqual((await seed(pg, full)).synced, { inserted: 0, updated: 0, deleted: 0 }, 'and the next deploy changes nothing');
});

test('hymn edits follow the generator: measurements refresh, a dropped stanza goes; original tracks keep their values', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, full);
  let dropped;
  const edited = editedCatalog('edited', (db) => {
    db.prepare("UPDATE tracks SET duration_ms = duration_ms + 1000, loudness_lufs = loudness_lufs - 0.5 WHERE genre = 'Hymn' AND track_no = 1").run();
    db.prepare("UPDATE track_files SET bytes = bytes + 2 WHERE track_id IN (SELECT id FROM tracks WHERE genre = 'Hymn' AND track_no = 1)").run();
    db.prepare("UPDATE tracks SET loudness_lufs = loudness_lufs - 0.5, energy = 0 WHERE genre <> 'Hymn'").run();
    dropped = db.prepare("SELECT id FROM song_sections WHERE label = 'V4' ORDER BY id LIMIT 1").get().id;
    db.prepare('DELETE FROM song_sections WHERE id = ?').run(dropped);
  });
  const originals = await rows(pg, "SELECT id, loudness_lufs, energy FROM tracks WHERE genre <> 'Hymn' ORDER BY id");
  const r = await seed(pg, edited);
  assert.deepEqual(r.synced, { inserted: 0, updated: 3, deleted: 1 }, 'one hymn track + its two files updated, one stanza removed');
  assert.deepEqual(await rows(pg, "SELECT id, loudness_lufs, energy FROM tracks WHERE genre <> 'Hymn' ORDER BY id"), originals, 'original tracks keep their first-seed measurements');
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM song_sections WHERE id = $1', [dropped]), 0);
  assert.deepEqual((await seed(pg, full)).synced, { inserted: 1, updated: 3, deleted: 0 }, 'and back');
});

test('user and church rows survive every sync, even on the generator’s own songs and ids', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, noHymns);
  const user = Number((await rows(pg, "INSERT INTO users (username, display_name, created_at) VALUES ('grace', 'Grace', 0) RETURNING id"))[0].id);
  // A user playlist that happens to have the Hymns playlist's id (it can't in practice: ids are random).
  await pg.db.query("INSERT INTO playlists (id, owner_id, name, is_public, created_at, updated_at) VALUES ($1, $2, 'Mine', 0, 0, 0)", [HYMN_IDS.playlist, user]);
  await seed(pg, full);
  const songId = HYMN_IDS.song('amazing-grace');
  await pg.db.query("INSERT INTO song_sections (id, song_id, language, label, lines, org_id) VALUES ('church1', $1, 'en', 'V1', 'our own words', 'org-a')", [songId]);
  await pg.db.query(`INSERT INTO song_arrangements (id, song_id, org_id, name, section_order) VALUES ('church2', $1, 'org-a', 'Ours', '["V1"]')`, [songId]);
  const pruning = editedCatalog('pruning', (db) => db.prepare("DELETE FROM song_sections WHERE song_id = ? AND label = 'V4'").run(songId));
  await seed(pg, pruning);
  assert.deepEqual((await rows(pg, 'SELECT owner_id, name FROM playlists WHERE id = $1', [HYMN_IDS.playlist])).map((r) => [Number(r.owner_id), r.name]), [[user, 'Mine']], 'not renamed');
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = $1', [HYMN_IDS.playlist]), 0, 'no hymns appended to it');
  assert.equal(await count(pg, "SELECT COUNT(*) AS n FROM song_sections WHERE id = 'church1' AND lines = 'our own words'"), 1, 'church lyrics kept');
  assert.equal(await count(pg, "SELECT COUNT(*) AS n FROM song_arrangements WHERE id = 'church2'"), 1, 'church arrangement kept');
  assert.equal(await count(pg, "SELECT COUNT(*) AS n FROM song_sections WHERE song_id = $1 AND org_id IS NULL AND label = 'V4'", [songId]), 0, 'the global stanza was pruned');
});

test('a build missing tracks the database has: production refuses, preview skips only an older branch', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, full);
  await assert.rejects(seed(pg, noHymns), /refusing to continue/, 'production refuses');
  assert.deepEqual(await seed(pg, noHymns, { lostTracks: 'warn' }), { seeded: false, skipped: true, lost: 8 }, 'preview: an older branch skips');
  const renamed = editedCatalog('renamed', (db) => {
    const { id } = db.prepare("SELECT id FROM tracks WHERE genre <> 'Hymn' ORDER BY id LIMIT 1").get();
    const to = 'Renamed000000000000000';
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE tracks SET id = ? WHERE id = ?').run(to, id);
    const referencing = db.prepare("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'track_id' WHERE m.type = 'table'").all();
    for (const { name } of referencing) db.prepare(`UPDATE ${name} SET track_id = ? WHERE track_id = ?`).run(to, id);
    db.prepare('UPDATE search_index SET ref_id = ? WHERE ref_id = ?').run(to, id);
  });
  await assert.rejects(seed(pg, renamed, { lostTracks: 'warn' }), /refusing to continue/, 'a changed id is refused even in preview');
});

test('renaming the catalog: a database seeded under the old names takes the new ones, search included, ids unchanged', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, oldNames);
  const before = await rows(pg, "SELECT id, title FROM tracks WHERE genre <> 'Hymn' ORDER BY id");
  const r = await seed(pg, full);
  assert.equal(r.added ?? 0, 0, 'no tracks added');
  const src = new DatabaseSync(full, { readOnly: true });
  try {
    for (const [table, cols] of [['artists', 'id, name'], ['albums', 'id, title'], ['tracks', 'id, title'], ['search_index', 'kind, ref_id, title, subtitle, folded']]) {
      const order = table === 'search_index' ? 'kind, ref_id' : 'id';
      const want = src.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${order}`).all().map((o) => ({ ...o }));
      assert.deepEqual(await rows(pg, `SELECT ${cols} FROM ${table} ORDER BY ${order}`), want, `${table} has the new names`);
    }
  } finally {
    src.close();
  }
  const after = await rows(pg, "SELECT id, title FROM tracks WHERE genre <> 'Hymn' ORDER BY id");
  assert.deepEqual(after.map((t) => t.id), before.map((t) => t.id), 'same ids');
  assert.ok(after.every((t, i) => t.title !== before[i].title), 'every original track renamed');
  assert.deepEqual((await seed(pg, full)).synced, { inserted: 0, updated: 0, deleted: 0 });
});

test('Scripture references are seeded once per song; after that the admins’ edits survive deploys', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, noHymns);
  await seed(pg, full);
  const songId = HYMN_IDS.song('amazing-grace');
  const refsOf = async (id) => (await rows(pg, 'SELECT usfm_ref FROM song_scripture WHERE song_id = $1 ORDER BY position', [id])).map((r) => r.usfm_ref);
  assert.deepEqual(await refsOf(songId), ['EPH.2.8', '1CH.17.16', 'JHN.9.25'], 'seeded with the hymn');
  // An admin replaces the references (what PUT /api/songs/:id/scripture does).
  await pg.db.query('DELETE FROM song_scripture WHERE song_id = $1', [songId]);
  await pg.db.query("INSERT INTO song_scripture (song_id, section_label, usfm_ref, position) VALUES ($1, NULL, 'TIT.2.11', 0)", [songId]);
  const other = HYMN_IDS.song('abide-with-me');
  const otherBefore = await refsOf(other);
  await pg.db.query('DELETE FROM song_scripture WHERE song_id = $1 AND position > 0', [other]);
  assert.deepEqual((await seed(pg, full)).synced, { inserted: 0, updated: 0, deleted: 0 });
  assert.deepEqual(await refsOf(songId), ['TIT.2.11'], 'the edit survives the next deploy');
  assert.deepEqual(await refsOf(other), otherBefore.slice(0, 1), 'a trimmed list is not refilled');
});

test('a generated file that lost a table’s rows does not wipe the lyrics', { skip: SKIP }, async () => {
  const pg = await newDatabase();
  await seed(pg, full);
  const before = await count(pg, 'SELECT COUNT(*) AS n FROM song_sections');
  const broken = editedCatalog('broken', (db) => db.prepare('DELETE FROM song_sections').run());
  const r = await seed(pg, broken);
  assert.equal(r.synced.deleted, 0);
  assert.equal(await count(pg, 'SELECT COUNT(*) AS n FROM song_sections'), before);
});

test('CI runs these tests instead of skipping them', { skip: !process.env.CI && 'not in CI' }, () => {
  assert.ok(PGlite, 'npm ci installs PGlite');
});

test('production code never imports PGlite', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name) && /pglite/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
    }
  };
  for (const d of ['server', 'scripts', 'api', 'public']) walk(path.join(ROOT, d));
  if (/pglite/i.test(fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8'))) offenders.push('middleware.js');
  assert.deepEqual(offenders, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies?.['@electric-sql/pglite'] && /^\d+\.\d+\.\d+$/.test(pkg.devDependencies['@electric-sql/pglite']), 'a dev dependency at an exact version');
  // Vercel builds hold the database credentials: they install production dependencies only, exactly as locked.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercel.installCommand, 'npm ci --omit=dev');
});
