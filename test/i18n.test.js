// Every UI string exists in all six languages (spec rule: never leave a key
// missing), with the same {placeholders}, so t() never falls back to English
// or shows a raw "{name}".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, LANGUAGE_CODES, errorText } from '../public/js/i18n.js';
import { LANGUAGES } from '../server/app.js';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('the server and the UI support the same languages', () => {
  assert.deepEqual([...LANGUAGE_CODES].sort(), [...LANGUAGES].sort());
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LANGUAGES].sort());
});

test('every language has every key, none empty, with the same placeholders', () => {
  const keys = Object.keys(STRINGS.en);
  for (const lang of LANGUAGE_CODES) {
    const dict = STRINGS[lang];
    assert.deepEqual(keys.filter((k) => !(k in dict)), [], `${lang} is missing keys`);
    assert.deepEqual(Object.keys(dict).filter((k) => !(k in STRINGS.en)), [], `${lang} has keys English lacks`);
    for (const k of keys) {
      assert.ok(typeof dict[k] === 'string' && dict[k].trim(), `${lang}.${k} is empty`);
      assert.deepEqual(placeholders(dict[k]), placeholders(STRINGS.en[k]), `${lang}.${k} placeholders`);
    }
  }
});

test('API error codes map to translated messages', () => {
  assert.equal(errorText({ status: 403, code: 'demo_not_allowed', message: 'server text' }), STRINGS.en.errDemoNotAllowed);
  assert.equal(errorText({ status: 429, code: 'rate_limited' }), STRINGS.en.errRateLimited);
  assert.equal(errorText({ status: 400, message: 'server text' }), 'server text', 'unknown codes show the server message');
});
