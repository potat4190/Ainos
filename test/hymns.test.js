// The public-domain hymns (scripts/hymns.js): every one provably public
// domain, sourced, and internally consistent, so the generator can render it
// and lyric timings line up with the melody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HYMNS, HYMN_ARTIST, HYMN_ALBUM } from '../scripts/hymns.js';
import { THEMES, SECTION_LABEL } from '../server/songs.js';
import { str, usfmRef } from '../server/validate.js';
import { melodyTimeline } from '../scripts/synth.js';

const PUBLIC_DOMAIN_BEFORE = 1929;
// Hymns whose public-domain status is disputed or still claimed (spec 1.1).
const EXCLUDED = ['great is thy faithfulness', 'how great thou art', 'in christ alone', 'because he lives'];

test('the owner-approved hymns, each once, in album order', () => {
  assert.deepEqual(HYMNS.map((h) => h.slug), ['amazing-grace', 'be-thou-my-vision', 'it-is-well', 'holy-holy-holy', 'come-thou-fount', 'all-hail-the-power', 'rock-of-ages', 'abide-with-me']);
  for (const h of HYMNS) assert.ok(!EXCLUDED.includes(h.title.toLowerCase()), h.title);
  assert.equal(HYMN_ARTIST.genre, 'Hymn');
  assert.equal(HYMN_ALBUM.released, Date.UTC(2026, 9, 29), 'a fixed release date, so deploys never rewrite it');
});

test('words and tune were both published before 1929, with a cited source for melody and lyrics', () => {
  const https = /^https:\/\/\S+$/;
  for (const h of HYMNS) {
    assert.ok(h.words.year < PUBLIC_DOMAIN_BEFORE && h.tune.year < PUBLIC_DOMAIN_BEFORE, `${h.slug}: years`);
    assert.ok(h.words.author && h.tune.name && h.tune.composer, `${h.slug}: authors`);
    for (const [what, src] of [['melody', h.melodySource], ['lyrics', h.lyricsSource]]) {
      assert.ok(src.year < PUBLIC_DOMAIN_BEFORE, `${h.slug}: ${what} source year`);
      assert.match(src.url, https, `${h.slug}: ${what} source url`);
      assert.ok(src.hymnal, `${h.slug}: ${what} source named`);
    }
    assert.ok(h.melodySource.checkedAgainst?.length >= 1, `${h.slug}: melody cross-checked`);
  }
});

test('melodies are playable and fill whole bars', () => {
  for (const h of HYMNS) {
    const [beatsPerBar, unit] = h.timeSignature;
    assert.ok([2, 3, 4, 6].includes(beatsPerBar) && [2, 4, 8].includes(unit), `${h.slug}: time signature`);
    assert.ok(h.melody.length >= 20, `${h.slug}: a real tune`);
    for (const [i, [pitch, beats]] of h.melody.entries()) {
      assert.ok(pitch === null || (Number.isInteger(pitch) && pitch >= 48 && pitch <= 84), `${h.slug} note ${i}: pitch in a singing range`);
      assert.ok(beats > 0 && beats <= 8 && Number.isInteger(beats * 4), `${h.slug} note ${i}: length in sixteenths`);
    }
    const total = h.melody.reduce((s, [, b]) => s + b, 0);
    assert.equal(total % beatsPerBar, 0, `${h.slug}: one pass is whole bars (pickup taken from the last bar)`);
    assert.ok(h.bpm >= 50 && h.bpm <= 120, `${h.slug}: a congregational tempo`);
    assert.ok(Number.isInteger(h.tonic) && ['major', 'minor'].includes(h.mode));
    const { seconds } = melodyTimeline(h.melody, { bpm: h.bpm, passes: h.audioVerses, beatsPerBar, pickupBeats: h.pickupBeats });
    assert.ok(seconds > 45 && seconds < 150, `${h.slug}: ${h.audioVerses} recorded verses last ${seconds.toFixed(0)} s`);
  }
});

test('lyrics: every stanza fits the tune line for line, within the app’s limits', () => {
  for (const h of HYMNS) {
    const verses = h.sections.filter((s) => s.label.startsWith('V'));
    const refrain = h.sections.find((s) => s.label === 'C');
    assert.deepEqual(verses.map((v) => v.label), verses.map((_, i) => `V${i + 1}`), `${h.slug}: stanzas numbered in order`);
    assert.equal(Boolean(refrain), h.cycle.includes('C'), `${h.slug}: refrain present exactly when the tune has one`);
    assert.deepEqual(h.cycle, refrain ? ['V', 'C'] : ['V']);
    const perPass = verses[0].lines.length + (refrain ? refrain.lines.length : 0);
    for (const v of verses) assert.equal(v.lines.length, verses[0].lines.length, `${h.slug} ${v.label}: same number of lines`);
    assert.equal(h.lineStarts.length, perPass, `${h.slug}: one line start per sung line`);
    assert.equal(h.lineStarts[0], 0);
    h.lineStarts.forEach((n, i) => {
      assert.ok(Number.isInteger(n) && n < h.melody.length && (i === 0 || n > h.lineStarts[i - 1]), `${h.slug}: line start ${i}`);
      assert.notEqual(h.melody[n][0], null, `${h.slug}: line ${i} starts on a sung note`);
    });
    assert.ok(Number.isInteger(h.audioVerses) && h.audioVerses >= 1 && h.audioVerses <= verses.length, `${h.slug}: recorded verses exist`);
    assert.ok(h.sections.length <= 30);
    for (const s of h.sections) {
      assert.match(s.label, SECTION_LABEL);
      assert.ok(s.lines.length >= 1 && s.lines.length <= 12, `${h.slug} ${s.label}: 1-12 lines`);
      for (const line of s.lines) assert.equal(str(line, { min: 1, max: 120 }), line, `${h.slug} ${s.label}: clean line "${line}"`);
    }
    assert.ok(h.themes.length >= 1 && h.themes.length <= 3 && h.themes.every((t) => THEMES.includes(t)), `${h.slug}: themes`);
    assert.ok(h.scripture.length >= 1 && h.scripture.length <= 3, `${h.slug}: 1-3 Scripture references`);
    for (const ref of h.scripture) assert.equal(usfmRef(ref), ref, `${h.slug}: ${ref} is a canonical USFM reference`);
    assert.equal(new Set(h.scripture).size, h.scripture.length, `${h.slug}: no repeated reference`);
  }
});

// ---- what the catalog generator writes for them ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { generateCatalog, HYMN_IDS, hymnOrder } from '../scripts/generate.js';

let dir, db;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-hymns-'));
  await generateCatalog({ dataDir: dir, quick: true, quiet: true, simulatedUsers: 5 });
  db = new DatabaseSync(path.join(dir, 'ainos.db'), { readOnly: true });
});
after(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each hymn is a native track with audio, on the Hymnal album', () => {
  const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY track_no').all(HYMN_IDS.album);
  assert.deepEqual(tracks.map((t) => t.id), HYMNS.map((h) => HYMN_IDS.track(h.slug)), 'ids from each hymn’s own seed, in album order');
  for (const [i, t] of tracks.entries()) {
    const h = HYMNS[i];
    assert.equal(t.title, h.title);
    assert.equal(t.artist_id, HYMN_IDS.artist);
    assert.equal(t.genre, 'Hymn');
    assert.equal(t.language, 'en');
    assert.equal(t.tempo, h.bpm);
    assert.ok(Number.isFinite(t.loudness_lufs) && t.loudness_lufs < -10);
    for (const q of ['high', 'low']) {
      const f = db.prepare('SELECT * FROM track_files WHERE track_id = ? AND quality = ?').get(t.id, q);
      assert.ok(f && fs.statSync(path.join(dir, f.file)).size === f.bytes, `${h.slug} ${q} file`);
    }
  }
  const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(HYMN_IDS.artist);
  assert.equal(artist.name, HYMN_ARTIST.name);
  assert.ok(fs.existsSync(path.join(dir, artist.image)));
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(HYMN_IDS.album);
  assert.equal(album.released_at, HYMN_ALBUM.released);
});

test('each hymn is a public-domain song with every stanza, its source, arrangements and themes', () => {
  for (const h of HYMNS) {
    const songId = HYMN_IDS.song(h.slug);
    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
    assert.equal(song.title, h.title);
    assert.equal(song.public_domain, 1);
    assert.equal(song.org_id, null);
    const source = db.prepare('SELECT * FROM song_sources WHERE song_id = ?').all(songId);
    assert.deepEqual(source.map((s) => [s.id, s.source, s.track_id, s.youtube_video_id]), [[HYMN_IDS.source(h.slug), 'ainos', HYMN_IDS.track(h.slug), null]]);
    const sections = db.prepare('SELECT label, lines, folded, language, org_id FROM song_sections WHERE song_id = ? ORDER BY id').all(songId);
    assert.deepEqual(sections.map((s) => s.label).sort(), h.sections.map((s) => s.label).sort(), `${h.slug}: all stanzas stored`);
    for (const s of h.sections) {
      const row = sections.find((r) => r.label === s.label);
      assert.equal(row.lines, s.lines.join('\n'));
      assert.ok(row.folded.length > 0 && row.language === 'en' && row.org_id === null);
    }
    const arrangements = Object.fromEntries(db.prepare('SELECT name, section_order FROM song_arrangements WHERE song_id = ?').all(songId).map((a) => [a.name, JSON.parse(a.section_order)]));
    assert.deepEqual(arrangements['All verses'], hymnOrder(h));
    assert.deepEqual(arrangements.Recording, hymnOrder(h, h.audioVerses));
    assert.equal(arrangements.Recording.filter((l) => l.startsWith('V')).length, h.audioVerses, `${h.slug}: the recording has ${h.audioVerses} verses`);
    assert.deepEqual(db.prepare('SELECT theme FROM song_themes WHERE song_id = ? ORDER BY theme').all(songId).map((r) => r.theme), [...h.themes].sort());
    assert.deepEqual(db.prepare('SELECT usfm_ref, section_label FROM song_scripture WHERE song_id = ? ORDER BY position').all(songId).map((r) => ({ ...r })),
      h.scripture.map((usfm_ref) => ({ usfm_ref, section_label: null })), `${h.slug}: Scripture references in order`);
  }
  // Searchable by first line where it differs from the title.
  const aliases = (slug) => db.prepare('SELECT alias FROM song_aliases WHERE song_id = ?').all(HYMN_IDS.song(slug)).map((r) => r.alias);
  assert.ok(aliases('it-is-well').some((x) => /^When peace,? like a river/i.test(x)), JSON.stringify(aliases('it-is-well')));
  assert.deepEqual(aliases('rock-of-ages'), [], 'no alias when the first line is the title');
});

test('a Hymns playlist holds the album; the feature-based editorial playlists stay as they were', () => {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(HYMN_IDS.playlist);
  assert.equal(p.name, 'Hymns');
  assert.equal(p.owner_id, null);
  assert.equal(p.is_public, 1);
  assert.deepEqual(db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(p.id).map((r) => r.track_id), HYMNS.map((h) => HYMN_IDS.track(h.slug)));
  const others = db.prepare('SELECT pt.track_id FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pl.owner_id IS NULL AND pl.id <> ?').all(p.id).map((r) => r.track_id);
  assert.ok(!others.some((id) => HYMNS.some((h) => HYMN_IDS.track(h.slug) === id)), 'hymns are not in the other editorial playlists');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM streams WHERE track_id IN (SELECT id FROM tracks WHERE genre = ?)').get('Hymn').n, 0, 'nor in the simulated listening');
});
