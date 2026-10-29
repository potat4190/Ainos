import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { searchScore, Catalog } from '../server/catalog.js';
import { sqliteStore } from '../server/store.js';
import { fold, searchText } from '../server/util.js';

test('folding drops Latin accents and case but keeps marks that change a word', () => {
  assert.equal(fold('Café Ünïcode'), 'cafe unicode');
  assert.equal(fold('ＡＢＣ'), 'abc', 'full-width letters');
  assert.notEqual(fold('राम'), fold('रम'), 'Devanagari vowel signs are kept');
  assert.notEqual(fold('が'), fold('か'), 'Japanese dakuten are kept');
  assert.equal(fold('ｶﾞ'), 'ガ', 'half-width katakana becomes the full-width letter');
});

test('search terms match whole words, vowel signs included', () => {
  assert.ok(searchScore(['cafe'], 'Café del Mar', '') > 0);
  assert.equal(searchScore(['रम'], 'राम', ''), 0);
  assert.ok(searchScore(['राम'], 'रामायण', '') > 0, 'a Devanagari prefix matches');
  assert.equal(searchScore(['か'], 'がんばれ', ''), 0);
  assert.ok(searchScore(['がん'], 'がんばれ', '') > 0);
});

test('an older database gets the folded column, and its rows stay searchable until the app fills it in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-search-'));
  const file = path.join(dir, 'ainos.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE search_index (kind TEXT NOT NULL, ref_id TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', PRIMARY KEY (kind, ref_id))");
  old.exec("INSERT INTO search_index VALUES ('playlist', 'p1', 'Morning Café', 'Songs for sunrise')");
  old.close();
  const store = sqliteStore(file);
  try {
    await store.run("INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES ('p1', NULL, 'Morning Café', 'Songs for sunrise', '#000000', 1, 0, 0)");
    const catalog = new Catalog(store);
    const found = async (q) => (await catalog.search(q)).playlists.map((p) => p.id);
    assert.deepEqual(await found('cafe'), ['p1'], 'rows without folded text are still candidates');
    assert.equal(await catalog.foldMissing(), 1);
    assert.equal((await store.get("SELECT folded FROM search_index WHERE ref_id = 'p1'")).folded, searchText('Morning Café', 'Songs for sunrise'));
    assert.deepEqual(await found('cafe'), ['p1'], 'and are found through it afterwards');
    assert.deepEqual(await found('sunset'), []);
    assert.equal(await catalog.foldMissing(), 0, 'nothing left to fill in');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
