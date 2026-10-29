// Small input validators for route handlers. Each returns the clean value or
// throws HttpError(400), so a handler reads like
//   const title = str(body.title, { name: 'title', min: 1, max: 120 });
// Every new route validates its input through these (spec S10).
import { HttpError } from './http.js';

const bad = (message) => new HttpError(400, message, 'invalid_input');

// Every way of breaking a line: CRLF, CR, LF, VT, FF, NEL, LS, PS.
const LINE_BREAK = /\r\n?|[\n\u000b\u000c\u0085\u2028\u2029]/g;
// Control characters (C0 except tab and newline, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Invisible characters that can hide text or reverse how it reads to other
// people: soft hyphen, Arabic letter mark, Hangul fillers, zero-width space,
// LRM/RLM, bidi embeddings, overrides and isolates, word joiner and other
// invisible operators, BOM, and tag characters (hidden ASCII) except inside
// an emoji flag sequence (the first alternative keeps those). Kept because
// real text needs them: ZWNJ/ZWJ (Indic scripts, emoji), variation selectors,
// the combining grapheme joiner (Biblical Hebrew pointing), the Mongolian
// vowel separator and the braille blank.
const INVISIBLE = /(\u{1f3f4}[\u{e0020}-\u{e007e}]{1,7}\u{e007f})|[\u00ad\u061c\u115f\u1160\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
// Text must show something: a character that is not whitespace, a mark, a
// default-ignorable character or a blank filler.
const VISIBLE = /[^\p{White_Space}\p{M}\p{Default_Ignorable_Code_Point}\u2800\u3164\u115f\u1160\uffa0]/u;

/**
 * A string of min..max characters, counted as Unicode code points in NFC (so
 * CJK, emoji and Devanagari count the same however they were typed). Control
 * and invisible formatting characters are removed. In multiline text line
 * breaks become \n; otherwise line breaks and tabs become spaces, and (when
 * trimming) runs of spaces become one. With min > 0 the text must also show
 * something, not only marks, joiners or blank fillers.
 */
export function str(value, { name = 'value', min = 0, max = 200, trim = true, multiline = false } = {}) {
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  let s = value.toWellFormed().replace(LINE_BREAK, '\n');
  if (!multiline) s = s.replace(/[\n\t]/g, ' ');
  // Normalize after removing: a character removed between a letter and its
  // accent would otherwise leave two spellings of the same text.
  s = s.replace(CONTROL, '').replace(INVISIBLE, (m, flag) => flag || '').normalize('NFC');
  if (trim) s = (multiline ? s : s.replace(/ {2,}/g, ' ')).trim();
  const n = [...s].length;
  if (n < min || (min > 0 && !VISIBLE.test(s))) throw bad(min === 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
  if (n > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}

/** An integer in min..max. Accepts digit strings, since query parameters are strings. */
export function int(value, { name = 'value', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && /^-?\d{1,16}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(n)) throw bad(`${name} must be a whole number`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}

/** One of a fixed list of values. */
export function oneOf(value, list, { name = 'value' } = {}) {
  if (!list.includes(value)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return value;
}

// The 66 books of the Protestant canon, as USFM book codes.
export const USFM_BOOKS = [
  'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST', 'JOB',
  'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP',
  'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI',
  '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV',
];
const USFM_REF = /^([1-3]?[A-Z]{2,3})\.(\d{1,3})(?:\.(\d{1,3})(?:-(\d{1,3}))?)?$/;

/**
 * A Scripture reference in USFM form: a whole chapter (PSA.23), a verse
 * (ROM.12.1) or a verse range within one chapter (PHP.4.6-7). Returned in one
 * canonical spelling (upper-case book, no leading zeros), since references are
 * stored, used as cache keys and sent upstream.
 */
export function usfmRef(value, { name = 'reference' } = {}) {
  const m = typeof value === 'string' && value.length <= 20 ? USFM_REF.exec(value.trim().toUpperCase()) : null;
  if (!m || !USFM_BOOKS.includes(m[1])) throw bad(`${name} must look like ROM.12.1 or PSA.23`);
  const [, book, chapter, from, to] = m;
  const [c, f, t] = [chapter, from, to].map((x) => (x === undefined ? undefined : Number(x)));
  if (c < 1 || (f !== undefined && f < 1) || (t !== undefined && t <= f)) throw bad(`${name} is not a valid passage`);
  return `${book}.${c}${f !== undefined ? `.${f}` : ''}${t !== undefined ? `-${t}` : ''}`;
}

/** A YouTube video id: exactly 11 characters of [A-Za-z0-9_-]. */
export function youtubeId(value, { name = 'video id' } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw bad(`${name} must be an 11-character YouTube video id`);
  return value;
}
