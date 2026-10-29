// Guards the generated catalog against accidental data migrations. On Vercel,
// audio files are named by track id and Postgres keeps the loudness and
// features measured at first seed, so an existing track must keep its id and
// its audio. New tracks may be appended; nothing already shipped may change.
//
// To append new tracks to the fixtures after adding them on purpose:
//   AINOS_UPDATE_CATALOG_SNAPSHOT=1 npm test
// That only ever adds entries: it still fails if an existing one changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalog } from '../scripts/generate.js';
import { openDb } from '../server/db.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const IDS_FILE = path.join(FIXTURES, 'track-ids.json');
const PRINT_FILE = path.join(FIXTURES, 'catalog-fingerprint.json');
const UPDATE = process.env.AINOS_UPDATE_CATALOG_SNAPSHOT === '1';

let dir;
let current;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-ids-'));
  await generateCatalog({ dataDir: dir, quick: true, quiet: true });
  const db = openDb(path.join(dir, 'ainos.db'));
  try {
    const ids = (sql) => db.prepare(sql).all().map((r) => r.id).sort();
    // The audio of a track follows from its seed inputs (style, tempo, key, mode,
    // mastering target). Rounded values, so the check doesn't depend on the last
    // bit of floating point on a given machine.
    const tracks = Object.fromEntries(db.prepare('SELECT id, tempo, key, mode, duration_ms, loudness_lufs FROM tracks').all()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => [t.id, { tempo: t.tempo, key: t.key, mode: t.mode, duration_ms: t.duration_ms, loudness: Math.round(t.loudness_lufs * 10) / 10 }]));
    current = {
      trackIds: ids('SELECT id FROM tracks'),
      print: {
        artists: ids('SELECT id FROM artists'),
        albums: ids('SELECT id FROM albums'),
        editorial_playlists: ids('SELECT id FROM playlists WHERE owner_id IS NULL'),
        tracks,
      },
    };
  } finally {
    db.close();
  }
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

/** Ids in `before` that are missing from `now`: these would be a data migration. */
const lost = (before, now) => before.filter((id) => !now.includes(id));

test('every track id in the snapshot is still generated, and no unlisted track appears', () => {
  const snapshot = read(IDS_FILE);
  assert.deepEqual(lost(snapshot, current.trackIds), [], 'existing track ids changed or disappeared');
  if (UPDATE) write(IDS_FILE, current.trackIds);
  else assert.deepEqual(current.trackIds, snapshot, 'new tracks: append them with AINOS_UPDATE_CATALOG_SNAPSHOT=1');
});

test('existing artists, albums, editorial playlists and track audio are unchanged', () => {
  const snapshot = read(PRINT_FILE);
  for (const kind of ['artists', 'albums', 'editorial_playlists']) {
    assert.deepEqual(lost(snapshot[kind], current.print[kind]), [], `existing ${kind} ids changed or disappeared`);
  }
  for (const [id, was] of Object.entries(snapshot.tracks)) {
    assert.deepEqual(current.print.tracks[id], was, `audio inputs of track ${id} changed`);
  }
  if (UPDATE) write(PRINT_FILE, current.print);
  else assert.deepEqual(current.print, snapshot, 'new catalog entries: append them with AINOS_UPDATE_CATALOG_SNAPSHOT=1');
});
