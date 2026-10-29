// The song tables' own rules: each source is exactly one native track or one
// YouTube video, global lyrics are unique per section, and deleting a song
// removes everything that belongs to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteStore } from '../server/store.js';
import { THEMES, SECTION_LABEL } from '../server/songs.js';

let dir, store;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-songs-'));
  store = sqliteStore(path.join(dir, 'ainos.db'));
  await store.run("INSERT INTO artists (id, name, genre, image, color) VALUES ('a1', 'Artist', 'Hymn', 'x', '#000')");
  await store.run("INSERT INTO albums (id, artist_id, title, year, cover, color, released_at) VALUES ('al1', 'a1', 'Album', 1900, 'x', '#000', 0)");
  await store.run(`INSERT INTO tracks (id, album_id, artist_id, title, track_no, duration_ms, genre, loudness_lufs, peak_db, tempo, key, mode,
    energy, valence, danceability, acousticness, instrumentalness) VALUES ('t1', 'al1', 'a1', 'Track', 1, 1000, 'Hymn', -14, -1, 80, 0, 1, 0, 0, 0, 0, 0)`);
  await store.run("INSERT INTO songs (id, title, artist, language, public_domain, created_at, updated_at) VALUES ('s1', 'Amazing Grace', 'Ainos Hymnal', 'en', 1, 0, 0)");
});
after(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const addSource = (id, source, trackId, videoId) =>
  store.run('INSERT INTO song_sources (id, song_id, source, track_id, youtube_video_id) VALUES (?, ?, ?, ?, ?)', [id, 's1', source, trackId, videoId]);

test('a source is exactly one native track or one YouTube video', async () => {
  await addSource('src1', 'ainos', 't1', null);
  await addSource('src2', 'youtube', null, 'dQw4w9WgXcQ');
  for (const [source, track, video] of [['ainos', null, null], ['ainos', 't1', 'dQw4w9WgXcQ'], ['youtube', null, null], ['youtube', 't1', 'abcdefghijk'], ['upload', 't1', null]]) {
    await assert.rejects(addSource(`bad-${source}-${track}-${video}`, source, track, video), /CHECK constraint/i, `${source} ${track} ${video}`);
  }
  await assert.rejects(addSource('src3', 'youtube', null, 'dQw4w9WgXcQ'), /UNIQUE/i, 'one row per YouTube video');
  await assert.rejects(addSource('src4', 'ainos', 'no-such-track', null), /FOREIGN KEY/i, 'native sources point at a real track');
});

test('global lyrics are unique per song, language and section; each church can have its own', async () => {
  const add = (id, label, org) => store.run('INSERT INTO song_sections (id, song_id, language, label, lines, org_id) VALUES (?, ?, ?, ?, ?, ?)', [id, 's1', 'en', label, 'line', org]);
  await add('sec1', 'V1', null);
  await assert.rejects(add('sec2', 'V1', null), /UNIQUE/i, 'a second global V1');
  await add('sec3', 'V1', 'org-a');
  await add('sec4', 'V1', 'org-b');
  await assert.rejects(add('sec5', 'V1', 'org-a'), /UNIQUE/i, 'a second V1 for the same church');
  assert.equal((await store.get("SELECT COUNT(*) AS n FROM song_sections WHERE label = 'V1'")).n, 3);
});

test('deleting a song removes its aliases, themes, sources, sections and arrangements', async () => {
  await store.run("INSERT INTO song_aliases (song_id, alias, folded) VALUES ('s1', 'Amazing Grace!', 'amazing grace')");
  await store.run("INSERT INTO song_themes (song_id, theme) VALUES ('s1', 'grace')");
  await store.run(`INSERT INTO song_arrangements (id, song_id, name, section_order) VALUES ('arr1', 's1', 'All verses', '["V1"]')`);
  await store.run("DELETE FROM songs WHERE id = 's1'");
  for (const table of ['song_aliases', 'song_themes', 'song_sources', 'song_sections', 'song_arrangements']) {
    assert.equal((await store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, table);
  }
  assert.ok(await store.get("SELECT 1 AS x FROM tracks WHERE id = 't1'"), 'the native track itself stays');
});

test('themes and section labels are closed vocabularies', () => {
  assert.equal(new Set(THEMES).size, THEMES.length);
  for (const t of THEMES) assert.match(t, /^[a-z]+$/);
  for (const ok of ['V1', 'V9', 'PC', 'C', 'C2', 'B', 'T', 'I', 'E']) assert.match(ok, SECTION_LABEL);
  for (const bad of ['V0', 'V10', 'v1', 'C3', 'Chorus', '', 'V1 ']) assert.doesNotMatch(bad, SECTION_LABEL);
});
