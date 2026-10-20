import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AINOS_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

if (!fs.existsSync(path.join(dataDir, 'ainos.db'))) {
  console.log('No catalog yet — generating one (takes ~15 seconds)...\n');
  const { generateCatalog } = await import('../scripts/generate.js');
  await generateCatalog({ dataDir });
  console.log('');
}

const app = createApp({ dataDir });
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
