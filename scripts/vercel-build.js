// Build step for Vercel (see vercel.json).
//  1. Generate the catalog. It is deterministic, so the track ids, audio and
//     art are the same on every build.
//  2. With DATABASE_URL set: check the Postgres schema (and apply it first when
//     DATABASE_MIGRATION_URL is set), then seed it on the first deploy, or
//     sync the generated catalog into it (scripts/seed-postgres.js). Preview
//     builds of a branch older than the preview database's catalog skip the
//     sync with a warning; production builds refuse.
//  3. Assemble dist/: the app shell, the docs, the audio and the artwork.
//     Vercel serves these as static files; middleware.js checks the signature
//     on every /media/ request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalog } from './generate.js';
import { seedPostgres } from './seed-postgres.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(ROOT, 'dist');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-build-'));

console.log('Generating catalog...');
await generateCatalog({ dataDir: work, quiet: true });

if (process.env.DATABASE_URL) {
  await seedPostgres({
    sqliteFile: path.join(work, 'ainos.db'), databaseUrl: process.env.DATABASE_URL, migrationUrl: process.env.DATABASE_MIGRATION_URL,
    lostTracks: process.env.VERCEL_ENV === 'preview' ? 'warn' : 'refuse',
  });
} else {
  console.log('DATABASE_URL is not set; skipping the database step.');
}

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), dist, { recursive: true });
fs.mkdirSync(path.join(dist, 'docs'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
  fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(dist, 'docs', f));
}
fs.cpSync(path.join(work, 'media'), path.join(dist, 'media'), { recursive: true });
fs.cpSync(path.join(work, 'art'), path.join(dist, 'art'), { recursive: true });
fs.rmSync(work, { recursive: true, force: true });

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).reduce((s, e) => s + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
console.log(`✓ dist/ ready (${(size(dist) / 1e6).toFixed(1)} MB)`);
