import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AINOS_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

const usePostgres = !!process.env.DATABASE_URL; // data lives in Postgres; nothing to generate locally
const hasDb = fs.existsSync(path.join(dataDir, 'ainos.db'));
const hasMedia = fs.existsSync(path.join(dataDir, 'media'));
if (!usePostgres && (!hasDb || !hasMedia)) {
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

const app = await createApp({ dataDir });
app.server.listen(PORT, HOST, () => {
  console.log(`Ainos is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network:  http://${a.address}:${PORT}`);
    }
  }
  console.log('Demo login: demo / ainos-demo');
});

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
