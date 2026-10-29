import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../server/http.js';
import { str, int, oneOf, usfmRef, youtubeId, USFM_BOOKS } from '../server/validate.js';

/** Asserts fn throws a 400 HttpError. */
const rejects = (fn, label) => assert.throws(fn, (err) => err instanceof HttpError && err.status === 400 && err.code === 'invalid_input', label);

test('str: trims, removes control characters, counts code points, enforces bounds', () => {
  assert.equal(str('  Amazing Grace  ', { max: 120 }), 'Amazing Grace');
  assert.equal(str('a\u0000b\u001fc\u007f'), 'abc');
  assert.equal(str('line one\r\nline two\rthree\tend', { multiline: true }), 'line one\nline two\nthree\tend');
  assert.equal(str('one\ntwo'), 'onetwo', 'single-line text drops newlines');
  assert.equal(str('  x  ', { trim: false }), '  x  ');
  // Boundaries: exactly max is fine, one more is not; CJK and emoji count once each.
  assert.equal(str('a'.repeat(120), { max: 120 }), 'a'.repeat(120));
  rejects(() => str('a'.repeat(121), { max: 120 }));
  assert.equal(str('主'.repeat(5), { max: 5 }), '主'.repeat(5));
  assert.equal(str('🙏'.repeat(5), { max: 5 }), '🙏'.repeat(5));
  assert.equal(str('येशू', { max: 4 }), 'येशू', 'Devanagari vowel signs are code points too');
  rejects(() => str('येशू', { max: 3 }));
  assert.equal(str('', { min: 0 }), '');
  rejects(() => str('   ', { min: 1 }), 'blank after trimming');
  rejects(() => str('ab', { min: 3 }));
  for (const v of [undefined, null, 5, {}, ['a'], true]) rejects(() => str(v), String(v));
  assert.match((() => { try { str(undefined, { name: 'title' }); } catch (e) { return e.message; } })(), /^title /, 'messages name the field');
});

test('int: whole numbers within bounds, from numbers or digit strings', () => {
  assert.equal(int(5, { min: 1, max: 10 }), 5);
  assert.equal(int('42'), 42);
  assert.equal(int(' -3 ', { min: -5 }), -3);
  assert.equal(int(1, { min: 1, max: 1 }), 1, 'both bounds inclusive');
  rejects(() => int(0, { min: 1 }));
  rejects(() => int(11, { max: 10 }));
  for (const v of [1.5, '1.5', '1e3', '0x10', '', ' ', NaN, Infinity, null, undefined, '12345678901234567', [], {}, true, '9'.repeat(400)]) rejects(() => int(v), String(v));
});

test('oneOf: only listed values, compared exactly', () => {
  assert.equal(oneOf('en', ['en', 'hi']), 'en');
  rejects(() => oneOf('EN', ['en', 'hi']));
  rejects(() => oneOf(undefined, ['en']));
  rejects(() => oneOf(['en'], ['en']), 'an array containing the value is not the value');
});

test('usfmRef: chapters, verses and ranges in one chapter, for the 66 book codes', () => {
  assert.equal(USFM_BOOKS.length, 66);
  assert.equal(new Set(USFM_BOOKS).size, 66);
  for (const ok of ['ROM.12.1', 'PSA.23', 'PHP.4.6-7', 'EPH.2.8-9', '1CO.13.4', '3JN.1.2', 'PSA.119.176', 'GEN.1.1']) assert.equal(usfmRef(ok), ok);
  assert.equal(usfmRef(' rom.12.1 '), 'ROM.12.1', 'case-insensitive, trimmed');
  const badRefs = [
    'ROM', 'ROM.', 'ROM.12.', 'ROM.0', 'ROM.12.0', 'ROM.12.5-5', 'ROM.12.5-3', 'ROM.1234', 'ROM.12.1-2-3',
    'XYZ.1.1', '4JN.1.1', 'ROM 12:1', 'ROM.12:1', 'ROM.12.1,3', 'ROM.12-13', 'ROM.12.1-ROM.13.2', '../ROM.12.1',
    'ROM.12.1?x=1', 'ROM.12.1/..', 'https://api.example/ROM.12.1', '', 'R'.repeat(40), 5, null, undefined, {},
  ];
  for (const v of badRefs) rejects(() => usfmRef(v), String(v));
});

test('youtubeId: exactly 11 URL-safe characters', () => {
  for (const ok of ['dQw4w9WgXcQ', 'a-b_c-d_e-f', '00000000000']) assert.equal(youtubeId(ok), ok);
  for (const v of ['dQw4w9WgXc', 'dQw4w9WgXcQQ', 'dQw4w9WgXc!', 'dQw4w9WgX/Q', ' dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', '', null, 12345678901]) {
    rejects(() => youtubeId(v), String(v));
  }
});
