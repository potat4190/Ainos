// The service worker caches the app shell so the app starts offline. A module
// missing from SHELL_FILES is never cached, and an import of it then fails the
// whole app when there is no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const shell = JSON.parse(/const SHELL_FILES = (\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));

test('the service worker caches every script and stylesheet the app loads', () => {
  const files = [
    ...fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js')).map((f) => `/js/${f}`),
    ...fs.readdirSync(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css')).map((f) => `/css/${f}`),
  ];
  assert.deepEqual(files.filter((f) => !shell.includes(f)), [], 'add these to SHELL_FILES in public/sw.js and bump SHELL');
});

test('every app-shell file exists', () => {
  const missing = shell.filter((f) => f !== '/' && !fs.existsSync(path.join(PUBLIC, f)));
  assert.deepEqual(missing, []);
});
