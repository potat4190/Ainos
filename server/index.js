import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AINOS_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

const usePostgres = !!process.env.DATABASE_URL;
const hasDb = fs.existsSync(path.join(dataDir, 'ainos.db'));
const hasMedia = fs.existsSync(path.join(dataDir, 'media'));
// Audio, art and the media signing key are always served from dataDir, so they
// are needed with Postgres too. The catalog is deterministic, so the generated
// files match the track ids that scripts/seed-postgres.js put in Postgres.
if (!hasMedia || (!usePostgres && !hasDb)) {
  // A database without its media/ folder (e.g. copied without data/media) means every song and cover would 404.
  console.log(hasDb
    ? `Catalog database found but ${path.join(dataDir, 'media')} is missing — regenerating the catalog (old database kept as ainos.db.bak; takes ~15 seconds)...\n`
    : 'No catalog yet — generating one (takes ~15 seconds)...\n');
  if (hasDb) {
    // generateCatalog deletes ainos.db; keep the old one (accounts, playlists, history) instead of losing it.
    for (const suffix of ['', '-wal', '-shm']) {
      const from = path.join(dataDir, `ainos.db${suffix}`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dataDir, `ainos.db.bak${suffix}`));
    }
  }
  const { generateCatalog } = await import('../scripts/generate.js');
  await generateCatalog({ dataDir });
  console.log('');
}

if (usePostgres) {
  console.log(`DATABASE_URL is set: accounts, playlists and plays are read from and written to the Postgres database at ${new URL(process.env.DATABASE_URL).host}.`);
  console.log('Unset DATABASE_URL to use the local SQLite database instead.\n');
}

const app = await createApp({ dataDir });
app.server.listen(PORT, HOST, () => {
  console.log(`Ainos is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network:  http://${a.address}:${PORT}`);
    }
  }
  console.log('Click "Try the demo" to sign in to the shared demo account (or log in as demo / ainos-demo).');
});

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
