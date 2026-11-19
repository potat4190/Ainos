// The interface is English only; songs come in English or Nepali. Every UI
// string exists in English, non-empty, and the two song languages match the
// server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, SONG_LANGUAGE_CODES, SONG_LANGUAGES as UI_SONG_LANGUAGES, errorText } from '../public/js/i18n.js';
import { LANGUAGES } from '../server/app.js';

test('the server and the UI offer the same song languages: English and Nepali', () => {
  assert.deepEqual([...SONG_LANGUAGE_CODES], ['en', 'ne']);
  assert.deepEqual([...LANGUAGES], ['en', 'ne']);
  assert.equal(UI_SONG_LANGUAGES.find((l) => l.code === 'ne').native, 'नेपाली');
});

test('the interface has English strings only, none empty', async () => {
  assert.deepEqual(Object.keys(STRINGS), ['en']);
  for (const [k, v] of Object.entries(STRINGS.en)) assert.ok(typeof v === 'string' && v.trim(), `en.${k} is empty`);
  const fs = await import('node:fs');
  for (const f of ['i18n.js', 'strings/listener.js', 'strings/church.js', 'strings/present.js']) {
    const src = fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^\s{2}(hi|ne|zh|ja|es): \{/m, `${f} has no blocks for other interface languages`);
  }
});

test('API error codes map to translated messages', () => {
  assert.equal(errorText({ status: 403, code: 'demo_not_allowed', message: 'server text' }), STRINGS.en.errDemoNotAllowed);
  assert.equal(errorText({ status: 429, code: 'rate_limited' }), STRINGS.en.errRateLimited);
  assert.equal(errorText({ status: 400, message: 'server text' }), 'server text', 'unknown codes show the server message');
});

// Spec 1.3: the faith is in the content, not in adjectives on every heading.
test('UI copy carries no "Christian" adjectives', async () => {
  const adjective = /christian|cristian|ईसाई|ख्रीष्टियन/i;
  for (const [key, value] of Object.entries(STRINGS.en)) assert.doesNotMatch(value, adjective, `en.${key}`);
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /christian/i, 'index.html title, meta and fallbacks');
  const i18n = fs.readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  const editorial = i18n.slice(i18n.indexOf('const EDITORIAL_I18N'), i18n.indexOf('const GENRE_I18N'));
  assert.doesNotMatch(editorial, adjective, 'editorial playlist names and descriptions');
});
