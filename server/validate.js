// Small input validators for route handlers. Each returns the clean value or
// throws HttpError(400), so a handler reads like
//   const title = str(body.title, { name: 'title', min: 1, max: 120 });
// Every new route validates its input through these (spec S10).
import { HttpError } from './http.js';

const bad = (message) => new HttpError(400, message, 'invalid_input');

// C0 control characters and DEL; tabs and newlines are allowed only in multiline text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const CONTROL_ONE_LINE = /[\u0000-\u001f\u007f]/g;

/**
 * A string of min..max characters (counted as Unicode code points, so CJK and
 * emoji count once). Control characters are removed; CRLF becomes LF.
 */
export function str(value, { name = 'value', min = 0, max = 200, trim = true, multiline = false } = {}) {
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  let s = value.replace(/\r\n?/g, '\n').replace(multiline ? CONTROL : CONTROL_ONE_LINE, '');
  if (trim) s = s.trim();
  const n = [...s].length;
  if (n < min) throw bad(min === 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
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
 * (ROM.12.1) or a verse range within one chapter (PHP.4.6-7). Book codes are
 * matched case-insensitively and returned upper-case.
 */
export function usfmRef(value, { name = 'reference' } = {}) {
  const m = typeof value === 'string' && value.length <= 20 ? USFM_REF.exec(value.trim().toUpperCase()) : null;
  if (!m || !USFM_BOOKS.includes(m[1])) throw bad(`${name} must look like ROM.12.1 or PSA.23`);
  const [, , chapter, from, to] = m;
  if (Number(chapter) < 1 || (from && Number(from) < 1) || (to && Number(to) <= Number(from))) throw bad(`${name} is not a valid passage`);
  return m[0];
}

/** A YouTube video id: exactly 11 characters of [A-Za-z0-9_-]. */
export function youtubeId(value, { name = 'video id' } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw bad(`${name} must be an 11-character YouTube video id`);
  return value;
}
