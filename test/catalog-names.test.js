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

test('until the owner picks, every display name is the old one', () => {
  for (const [kind, list] of Object.entries(keys)) {
    for (const key of list) assert.equal(displayName(kind, key, key.split('/').pop()), key.split('/').pop());
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
