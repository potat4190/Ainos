// The display-name mapping (scripts/catalog-names.js) must cover the whole
// catalog, offer usable options, and stay clear of real worship acts and
// well-known modern worship song titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../scripts/generate.js';
import { ARTISTS, ALBUMS, TRACKS, displayName } from '../scripts/catalog-names.js';
import { str, usfmRef } from '../server/validate.js';

const keys = {
  artist: CATALOG.map((a) => a.name),
  album: CATALOG.flatMap((a) => a.albums.map((al) => `${a.name}/${al.title}`)),
  track: CATALOG.flatMap((a) => a.albums.flatMap((al) => al.tracks.map((t) => `${a.name}/${t}`))),
};
const tables = { artist: ARTISTS, album: ALBUMS, track: TRACKS };

// Worship acts and modern worship songs the names must not echo. Not
// exhaustive; extend it when a reviewer spots another.
const ACTS = ['hillsong', 'elevation', 'bethel', 'jesus culture', 'planetshakers', 'maverick city', 'cityalight', 'passion', 'vertical worship',
  'housefires', 'gateway worship', 'sovereign grace', 'rend collective', 'upperroom', 'victory worship', 'selah', 'aradhna', 'stream of praise',
  '赞美之泉', 'fuente de gracia', 'aviva', 'grupo grace', 'miel san marcos', 'su presencia', 'generación 12', 'barak', 'kabed', 'casting crowns',
  'mercyme', 'newsboys', 'leeland', 'kutless', 'for king & country', 'the belonging co', 'red rocks worship', 'influence music', 'the midnight',
  'faro encendido', 'common hymnal', 'the porter’s gate', 'indelible grace', 'citizens', 'all sons & daughters'];
const SONGS = ['way maker', 'goodness of god', 'oceans', '10,000 reasons', 'build my life', 'what a beautiful name', 'graves into gardens',
  'reckless love', 'cornerstone', 'king of kings', 'living hope', 'great are you lord', 'how great is our god', 'raise a hallelujah',
  'holy forever', 'gratitude', 'firm foundation', 'jireh', 'who you say i am', 'good good father', 'here i am to worship',
  'blessed be your name', 'mighty to save', 'in christ alone', 'shout to the lord', 'revelation song', 'the blessing', 'lord i need you',
  'do it again', 'o come to the altar', 'this is amazing grace', 'same god', 'promises', 'battle belongs', 'see a victory', 'surrounded',
  'defender', 'trust in god', 'holy spirit', 'heaven come', 'still', 'desert song', 'hosanna', 'stronger', 'behold', 'abide', 'agnus dei',
  'here again', 'spirit lead me', 'yet not i but through christ in me', 'thy word', 'on eagle’s wings', 'this little light of mine'];

test('every artist, album and track in the catalog has exactly one entry', () => {
  for (const [kind, list] of Object.entries(keys)) {
    assert.deepEqual(Object.keys(tables[kind]).sort(), [...list].sort(), kind);
  }
});

test('each entry offers two clean, distinct options with a Scripture reference, and a valid pick', () => {
  for (const [kind, table] of Object.entries(tables)) {
    for (const [key, e] of Object.entries(table)) {
      assert.ok([null, 'a', 'b'].includes(e.pick), `${key} pick`);
      assert.ok(e.custom === null || str(e.custom, { min: 1, max: 120 }) === e.custom, `${key} custom`);
      for (const opt of ['a', 'b']) {
        const [name, ref] = e[opt];
        assert.equal(str(name, { min: 1, max: 120 }), name, `${key} ${opt}: trimmed, 1-120 characters, no hidden characters`);
        assert.equal(usfmRef(ref), ref, `${key} ${opt}: reference`);
        assert.notEqual(name, key.split('/').pop(), `${key} ${opt}: differs from the old name`);
      }
      assert.notEqual(e.a[0], e.b[0], `${key}: two different options`);
    }
  }
});

test('no two tracks, albums or artists could end up with the same name', () => {
  for (const [kind, table] of Object.entries(tables)) {
    const seen = new Map();
    for (const [key, e] of Object.entries(table)) {
      for (const [name] of [e.a, e.b]) {
        const other = seen.get(name.toLowerCase());
        // A single shares its name with its only track, so album and track tables are checked separately.
        assert.ok(!other || other === key, `${kind} "${name}" is offered for both ${other} and ${key}`);
        seen.set(name.toLowerCase(), key);
      }
    }
  }
});

test('no option echoes a real worship act or a well-known worship song title', () => {
  for (const table of Object.values(tables)) {
    for (const [key, e] of Object.entries(table)) {
      for (const [name] of [e.a, e.b, e.custom ? [e.custom] : null].filter(Boolean)) {
        const n = name.toLowerCase();
        assert.ok(!ACTS.some((act) => new RegExp(`(^|[^\\p{L}])${act.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(n)), `${key}: "${name}" echoes a worship act`);
        assert.ok(!SONGS.includes(n), `${key}: "${name}" is a well-known worship song title`);
      }
    }
  }
});

// Draft options the 2026-10-29 check found too close to an existing song
// (the song in the comment). They stay in the file as options but are never shown.
const FLAGGED = [
  'morning by morning', // Pat Barrett, 2019
  'consider the lilies', // several hymns and choral songs
  'deep calls to deep', // Matt Redman
  'from the rising of the sun', // Paul Deming; Paul Baloche's "Rising"
  'streets of gold', 'the narrow way', // Jordan Feliz, 2018; Steffany Gretzinger
  'आशीष की वर्षा', 'showers of blessing', // the 1883 hymn
  'más blanco que la nieve', 'whiter than snow', // the 1872 hymn
  'un corazón limpio', 'a clean heart', // "Crea en mí un corazón limpio"; "Create in Me a Clean Heart"
  '新造的人', 'new creation', '生命河', 'river of life', // common worship titles
];

test('the chosen names avoid the titles the owner’s check flagged, and every entry has one', () => {
  for (const [kind, list] of Object.entries(keys)) {
    for (const key of list) {
      const e = tables[kind][key];
      assert.ok(e.pick || e.custom, `${key}: picked`);
      const name = displayName(kind, key, null);
      assert.ok(!FLAGGED.includes(name.toLowerCase()), `${key}: "${name}" was flagged`);
    }
  }
});

test('the display name is the owner’s custom name, else the picked option, else the old name', () => {
  for (const [kind, list] of Object.entries(keys)) {
    for (const key of list) {
      const e = tables[kind][key];
      const old = key.split('/').pop();
      assert.equal(displayName(kind, key, old), e.custom || (e.pick ? e[e.pick][0] : old), key);
    }
  }
  assert.equal(displayName('track', 'nope/nope', 'Fallback'), 'Fallback');
  // A pick or a custom name takes over (checked on a copy, so the draft stays untouched).
  const entry = TRACKS['Lumen Drift/First Glow'];
  const saved = { ...entry };
  try {
    entry.pick = 'b';
    assert.equal(displayName('track', 'Lumen Drift/First Glow', 'First Glow'), 'Before the Dawn');
    entry.custom = 'Bright Morning Star';
    assert.equal(displayName('track', 'Lumen Drift/First Glow', 'First Glow'), 'Bright Morning Star');
  } finally {
    Object.assign(entry, saved);
  }
});

test('a picked name reaches the catalog and search, while ids and audio stay as they were', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  const { generateCatalog } = await import('../scripts/generate.js');
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog-fingerprint.json', import.meta.url), 'utf8'));
  const entries = [ARTISTS['Lumen Drift'], ALBUMS['Lumen Drift/Slow Light'], TRACKS['Lumen Drift/First Glow']];
  const saved = entries.map((e) => ({ ...e }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-names-'));
  try {
    ARTISTS['Lumen Drift'].pick = 'a';
    ALBUMS['Lumen Drift/Slow Light'].pick = 'b';
    TRACKS['Lumen Drift/First Glow'].custom = 'Bright Morning Star';
    await generateCatalog({ dataDir: dir, quick: true, quiet: true, simulatedUsers: 5 });
    const db = new DatabaseSync(path.join(dir, 'ainos.db'), { readOnly: true });
    try {
      const track = db.prepare(`SELECT t.id, t.title, a.name AS artist, al.title AS album FROM tracks t
        JOIN artists a ON a.id = t.artist_id JOIN albums al ON al.id = t.album_id WHERE t.title = ?`).get('Bright Morning Star');
      assert.ok(track, 'the custom track name is used');
      assert.equal(track.artist, 'Lamplight Hours');
      assert.equal(track.album, 'A Lamp for My Feet');
      assert.ok(fixture.tracks[track.id], 'same track id as before the rename');
      const wav = db.prepare("SELECT file FROM track_files WHERE track_id = ? AND quality = 'high'").get(track.id).file;
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, wav))).digest('hex'), fixture.tracks[track.id].wav.high, 'same audio');
      const search = db.prepare("SELECT title, subtitle FROM search_index WHERE kind = 'track' AND ref_id = ?").get(track.id);
      assert.deepEqual({ ...search }, { title: 'Bright Morning Star', subtitle: 'Lamplight Hours A Lamp for My Feet' });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE title = 'First Glow'").get().n, 0, 'the old name is gone');
    } finally {
      db.close();
    }
  } finally {
    entries.forEach((e, i) => Object.assign(e, saved[i]));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
