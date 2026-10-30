// Scripture next to songs (AINOS-SPEC.md Phase 2): verse text from the
// YouVersion Platform API, in the listener's chosen Bible version, with the
// version's attribution. Ainos stores references only; text is fetched when
// shown and never written to a database.
//
// Only three upstream endpoints are ever called (Bible versions, passages,
// Verse of the Day), with URLs built here from validated values, so the
// routes can't be used as a proxy. The app key travels in a header and never
// appears in a URL, a log line or a response.
//
// Passage text is not cached: YouVersion publishes no caching terms per
// version, so every passage is fetched when asked for (rate-limited per user
// by the routes). Version lists are cached for 24 hours, Verse of the Day
// references for an hour.
//
// Fallback, when the key is missing or the API fails, times out or refuses a
// version: English gets the public-domain World English Bible text bundled in
// scripture-fallback.js (only the verses Ainos references); other languages,
// and references not bundled, get the reference with `text: null` (owner
// decision Q14). A song page never fails because of Scripture.
import { FALLBACK_SOURCE, FALLBACK_VERSES, VOTD_FALLBACK } from './scripture-fallback.js';
import { usfmRef } from './validate.js';

export const YOUVERSION_API = 'https://api.youversion.com/v1';
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const RETRY_MS = 5 * 60 * 1000; // a failed version list is retried after this

// Bible versions proposed per UI language once the owner approves them
// (Q14: listed from what the key can use; no hard-coded guesses). Until then a
// listener without a chosen version gets the fallback.
export const DEFAULT_VERSIONS = {};

// The language range sent to YouVersion for each UI language (BCP 47).
const LANGUAGE_RANGE = { en: 'en', hi: 'hi', ne: 'ne', zh: 'zh', ja: 'ja', es: 'es' };

// English book names, for references shown without YouVersion (which
// returns its own, localized, with each passage).
const BOOK_NAMES = {
  GEN: 'Genesis', EXO: 'Exodus', LEV: 'Leviticus', NUM: 'Numbers', DEU: 'Deuteronomy', JOS: 'Joshua', JDG: 'Judges', RUT: 'Ruth',
  '1SA': '1 Samuel', '2SA': '2 Samuel', '1KI': '1 Kings', '2KI': '2 Kings', '1CH': '1 Chronicles', '2CH': '2 Chronicles', EZR: 'Ezra',
  NEH: 'Nehemiah', EST: 'Esther', JOB: 'Job', PSA: 'Psalm', PRO: 'Proverbs', ECC: 'Ecclesiastes', SNG: 'Song of Songs', ISA: 'Isaiah',
  JER: 'Jeremiah', LAM: 'Lamentations', EZK: 'Ezekiel', DAN: 'Daniel', HOS: 'Hosea', JOL: 'Joel', AMO: 'Amos', OBA: 'Obadiah',
  JON: 'Jonah', MIC: 'Micah', NAM: 'Nahum', HAB: 'Habakkuk', ZEP: 'Zephaniah', HAG: 'Haggai', ZEC: 'Zechariah', MAL: 'Malachi',
  MAT: 'Matthew', MRK: 'Mark', LUK: 'Luke', JHN: 'John', ACT: 'Acts', ROM: 'Romans', '1CO': '1 Corinthians', '2CO': '2 Corinthians',
  GAL: 'Galatians', EPH: 'Ephesians', PHP: 'Philippians', COL: 'Colossians', '1TH': '1 Thessalonians', '2TH': '2 Thessalonians',
  '1TI': '1 Timothy', '2TI': '2 Timothy', TIT: 'Titus', PHM: 'Philemon', HEB: 'Hebrews', JAS: 'James', '1PE': '1 Peter',
  '2PE': '2 Peter', '1JN': '1 John', '2JN': '2 John', '3JN': '3 John', JUD: 'Jude', REV: 'Revelation',
};

/** "PHP.4.6-7" → "Philippians 4:6-7" (English). */
export function referenceName(usfm) {
  const [book, chapter, verses] = usfm.split('.');
  return `${BOOK_NAMES[book]} ${chapter}${verses ? `:${verses}` : ''}`;
}

/** The bundled public-domain text for a reference, or null when any verse of it isn't bundled (or it's a whole chapter). */
export function fallbackText(usfm) {
  const [book, chapter, verses] = usfm.split('.');
  if (!verses) return null;
  const [from, to = from] = verses.split('-').map(Number);
  const parts = [];
  for (let v = from; v <= to; v++) {
    const text = FALLBACK_VERSES[`${book}.${chapter}.${v}`];
    if (!text) return null;
    parts.push(text);
  }
  return parts.join(' ');
}

const FALLBACK_VERSION = { id: null, abbreviation: FALLBACK_SOURCE.abbreviation, title: FALLBACK_SOURCE.title, copyright: FALLBACK_SOURCE.copyright };

/** Day of the year, 1-366, in UTC. */
export function dayOfYear(date = new Date()) {
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}

class UpstreamError extends Error {}

/**
 * The Scripture service. `fetch` and `appKey` are injectable for tests.
 * Every method resolves (never rejects) for API trouble: callers get the
 * fallback, with `source` saying which text they got.
 */
export function createScripture({ appKey = process.env.YOUVERSION_APP_KEY, fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now, log = () => {} } = {}) {
  const versionLists = new Map(); // language → { at, versions }
  const versionInfo = new Map(); // id → { at, version }
  const votdRefs = new Map(); // day → { at, usfm }
  const loading = new Map(); // language → the version list being fetched, shared by concurrent callers

  // Redirects are refused: fetch would carry the key header to wherever one points.
  async function call(pathname, params = [], deadline = null) {
    const url = new URL(YOUVERSION_API + pathname);
    for (const [k, v] of params) url.searchParams.append(k, v);
    const signal = deadline ? AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]) : AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers: { 'X-YVP-App-Key': appKey, Accept: 'application/json' }, signal, redirect: 'error' });
    } catch (err) {
      throw new UpstreamError(err.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError('bad JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpstreamError('unexpected body');
    return body;
  }

  const versionDto = (b) => ({
    id: b.id,
    abbreviation: String(b.localized_abbreviation || b.abbreviation || ''),
    title: String(b.localized_title || b.title || ''),
    copyright: String(b.copyright || ''),
    language: String(b.language_tag || ''),
  });

  /** The versions the app key can use for a UI language ([] without a key or when the API fails; failures aren't cached). */
  async function listVersions(language) {
    const range = LANGUAGE_RANGE[language];
    if (!appKey || !range) return [];
    const hit = versionLists.get(language);
    if (hit && now() - hit.at < DAY_MS) return hit.versions;
    if (!loading.has(language)) loading.set(language, loadVersions(language, range).finally(() => loading.delete(language)));
    return loading.get(language);
  }

  // At most 5 pages, all within two timeouts' time.
  async function loadVersions(language, range) {
    const deadline = AbortSignal.timeout(timeoutMs * 2);
    try {
      const versions = [];
      let token = null;
      for (let page = 0; page < 5; page++) {
        const params = [['language_ranges[]', range], ['page_size', '99']];
        if (token) params.push(['page_token', token]);
        const body = await call('/bibles', params, deadline);
        for (const b of body.data || []) if (Number.isInteger(b.id)) versions.push(versionDto(b));
        token = body.next_page_token;
        if (!token) break;
      }
      versions.sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));
      versionLists.set(language, { at: now(), versions });
      for (const v of versions) versionInfo.set(v.id, { at: now(), version: v });
      return versions;
    } catch (err) {
      log('[scripture] versions', language, err.message);
      versionLists.set(language, { at: now() - DAY_MS + RETRY_MS, versions: [], failed: true });
      return [];
    }
  }

  /**
   * Whether the key can use a version, in any UI language: 'allowed',
   * 'not_allowed', or 'unknown' when a list could not be had (no key, API down).
   */
  async function versionStatus(id) {
    if (!appKey) return 'unknown';
    const languages = Object.keys(LANGUAGE_RANGE);
    const lists = await Promise.all(languages.map(listVersions)); // in parallel: one timeout at most
    if (lists.some((versions) => versions.some((v) => v.id === id))) return 'allowed';
    // Refuse only when every list loaded; a version in a list that failed may well be allowed.
    return languages.every((language) => !versionLists.get(language)?.failed) ? 'not_allowed' : 'unknown';
  }

  async function getVersion(id) {
    const hit = versionInfo.get(id);
    if (hit && now() - hit.at < DAY_MS) return hit.version;
    const version = versionDto(await call(`/bibles/${id}`));
    versionInfo.set(id, { at: now(), version });
    return version;
  }

  function fallback(usfm, language, reason) {
    const text = language === FALLBACK_SOURCE.language ? fallbackText(usfm) : null;
    return { usfm, reference: referenceName(usfm), text, version: text ? FALLBACK_VERSION : null, source: text ? 'fallback' : 'none', reason };
  }

  /**
   * A passage in a version (an id versionStatus() called 'allowed'), or the
   * fallback for `language`.
   */
  async function getPassage({ usfm, versionId = null, language = 'en', upstream = true }) {
    usfm = usfmRef(usfm);
    if (!appKey) return fallback(usfm, language, 'no_key');
    if (!upstream) return fallback(usfm, language, 'busy');
    if (!versionId) return fallback(usfm, language, 'no_version');
    try {
      const [body, version] = await Promise.all([call(`/bibles/${versionId}/passages/${usfm}`, [['format', 'text']]), getVersion(versionId)]);
      if (typeof body.content !== 'string' || !body.content.trim()) throw new UpstreamError('empty passage');
      return { usfm, reference: String(body.reference || referenceName(usfm)), text: body.content.trim(), version: { id: version.id, abbreviation: version.abbreviation, title: version.title, copyright: version.copyright }, source: 'youversion' };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      log('[scripture] passage', versionId, usfm, err.message);
      return fallback(usfm, language, 'unavailable');
    }
  }

  /** Today's Verse of the Day: YouVersion's reference when it can be had, else the bundled list's. */
  async function getVerseOfTheDay({ versionId = null, language = 'en', date = new Date(now()), upstream = true } = {}) {
    const day = dayOfYear(date);
    let usfm = null;
    if (appKey && upstream) {
      const hit = votdRefs.get(day);
      if (hit && now() - hit.at < HOUR_MS) usfm = hit.usfm;
      else {
        try {
          const body = await call(`/verse-of-the-days/${day}`);
          usfm = usfmRef(String(body.passage_id || ''));
          votdRefs.set(day, { at: now(), usfm });
        } catch (err) {
          log('[scripture] votd', day, err.message);
        }
      }
    }
    usfm ||= VOTD_FALLBACK[(day - 1) % VOTD_FALLBACK.length];
    return { day, ...(await getPassage({ usfm, versionId, language, upstream })) };
  }

  return { getPassage, getVerseOfTheDay, listVersions, versionStatus, hasKey: !!appKey };
}
