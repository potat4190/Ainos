// The live YouTube fallback for search (AINOS-SPEC.md 3.3 path B, S15;
// PLAN.md "Live YouTube search", L3). When the catalog has too few songs for
// a query, YouTube is searched once, the best music videos are added to the
// catalog (server/youtube-import.js) and the query is remembered, so the next
// search for that song is answered from the catalog without the API key.
//
// YouTube allows about 100 searches a day, so a live search is the exception.
// It runs only when all of these hold:
//   - the client asked for it (live=1, sent once typing has stopped);
//   - a key is set, and the user is not a shared demo account;
//   - the catalog found fewer than MIN_LOCAL_SONGS songs;
//   - the query was not sent to YouTube in the last 7 days (hits and misses
//     are both remembered, in search_cache);
//   - the user (10 an hour, 30 a day) and their address (30 an hour) are
//     within their limits, and the app within its daily cap.
// It never fails a search: whatever happens, the caller answers from the
// catalog, with `live` saying what happened.
import { HttpError } from './http.js';
import { rateLimit, rateLimitAllows } from './auth.js';
import { isDemo } from './demo.js';
import { fold } from './util.js';
import { inList } from './store.js';
import { songFromVideo } from './youtube.js';
import { importVideo, splitTitles } from './youtube-import.js';

export const MIN_LOCAL_SONGS = 3; // fewer songs than this in the catalog: worth asking YouTube
export const MAX_ADDED = 3; // videos one live search may add (owner, Q29)
export const CACHE_MS = 7 * 24 * 3600 * 1000; // a query goes to YouTube at most once a week
const MIN_LETTERS = 3; // shorter queries are someone still typing
const LIMITS = { userHour: 10, userDay: 30, ipHour: 30 };

/** The query as remembered in search_cache: folded words, single spaces ('' when there is nothing to search for). */
export function foldQuery(q) {
  const words = fold(String(q ?? '').normalize('NFKC')).match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  const key = words.slice(0, 8).join(' ').slice(0, 100);
  return [...key.replace(/ /g, '')].length >= MIN_LETTERS ? key : '';
}

/**
 * @param {object} deps store; youtube (server/youtube.js client); dailyCap: live
 *   searches a day for the whole app; verifiedChannels: names of the owner's
 *   verified official channels, whose videos are taken first; clientIp(req); log
 */
export function createLiveSearch({ store, youtube, dailyCap = 80, verifiedChannels = [], clientIp, log = () => {}, now = Date.now }) {
  const verified = new Set(verifiedChannels.map((name) => fold(name)));

  // Who may spend a live search, and on what: the user's hour and day, their
  // address's hour, and the app's day. `refusal` is what run() answers when one is used up.
  const allowances = (req, user) => [
    { key: `user:${user.id}:yt-search`, limit: LIMITS.userHour, windowSec: 3600, refusal: 'limited' },
    { key: `user:${user.id}:yt-search`, limit: LIMITS.userDay, windowSec: 86_400, refusal: 'limited' },
    { key: `ip:${clientIp(req)}:yt-search`, limit: LIMITS.ipHour, windowSec: 3600, refusal: 'limited' },
    { key: 'youtube:search:all', limit: dailyCap, windowSec: 86_400, refusal: 'capped' },
  ];

  // Count one use of each allowance; the first refusal when one is over (a
  // request racing this one took the last use). A 429 is an answer here, not an error.
  async function spend(list) {
    for (const a of list) {
      try {
        await rateLimit(store, a.key, { limit: a.limit, windowSec: a.windowSec, now: now() });
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) return a.refusal;
        throw err;
      }
    }
    return null;
  }

  /**
   * Maybe search YouTube for `q` and add what it finds.
   * Returns what happened:
   *   'off'         not asked for, no key, a demo account, or nothing to search for
   *   'enough'      the catalog already has enough songs
   *   'cached'      this query went to YouTube within the last week
   *   'limited'     this user or address has made too many live searches
   *   'capped'      the app's daily allowance is used up (or YouTube's quota is)
   *   'unavailable' YouTube could not be asked, or something went wrong (nothing is remembered)
   *   'searched'    YouTube was asked; search the catalog again
   * Never throws: a live search must not fail the search it came with.
   */
  async function run(args) {
    try {
      return await attempt(args);
    } catch (err) {
      log('[live-search]', err?.message);
      return 'unavailable';
    }
  }

  async function attempt({ req, user, q, wanted, localSongs }) {
    if (!wanted || !youtube?.hasKey || !user || isDemo(user)) return 'off';
    const key = foldQuery(q);
    if (!key) return 'off';
    if (localSongs >= MIN_LOCAL_SONGS) return 'enough';
    const language = user.language || 'en';
    const at = now();
    const fresh = await store.get('SELECT 1 AS x FROM search_cache WHERE query_folded = ? AND language = ? AND fetched_at > ?', [key, language, at - CACHE_MS]);
    if (fresh) return 'cached';

    // Refusals first, counting nothing: an attempt that never reaches YouTube
    // must not use up anyone's allowance (nor the app's).
    const list = allowances(req, user);
    for (const a of list) {
      if (!(await rateLimitAllows(store, a.key, { limit: a.limit, windowSec: a.windowSec, now: at }))) return a.refusal;
    }
    const blocked = youtube.blocked?.(); // the client is pausing after an outage or a quota answer
    if (blocked) return blocked === 'quota' ? 'capped' : 'unavailable';

    // Claim the query before asking, so the same search arriving twice at once asks YouTube once.
    const claim = await store.run(`INSERT INTO search_cache (query_folded, language, results, fetched_at) VALUES (?, ?, '[]', ?)
      ON CONFLICT (query_folded, language) DO UPDATE SET results = '[]', fetched_at = excluded.fetched_at WHERE search_cache.fetched_at <= ?`,
    [key, language, at, at - CACHE_MS]);
    if (!claim.changes) return 'cached';

    // From here on the claim says "nothing found"; anything short of a finished
    // search takes it back, so the query can be tried again.
    const release = async () => {
      try {
        await store.run('DELETE FROM search_cache WHERE query_folded = ? AND language = ? AND fetched_at = ?', [key, language, at]);
      } catch (err) {
        log('[live-search] release', err?.message);
      }
    };
    try {
      const refused = await spend(list);
      if (refused) { await release(); return refused; }
      return await searchAndImport({ q, user, key, language, at, release });
    } catch (err) {
      await release();
      throw err;
    }
  }

  async function searchAndImport({ q, user, key, language, at, release }) {
    let found;
    try {
      found = await youtube.searchVideos(q, { language }); // the words as typed (the client cuts them to 100 characters)
    } catch (err) {
      log('[live-search]', err?.message);
      found = { ok: false, reason: 'error', videos: [] };
    }
    if (!found.ok) {
      // Not an answer about YouTube's catalog: forget the claim so the query can be tried again.
      await release();
      return found.reason === 'quota' ? 'capped' : 'unavailable';
    }

    // Verified official channels first, then YouTube's own order; at most MAX_ADDED.
    const ranked = [...found.videos.filter((v) => verified.has(fold(v.channelTitle || ''))), ...found.videos.filter((v) => !verified.has(fold(v.channelTitle || '')))];
    // Videos an admin hid, or that belong to a church's song, don't take one of the places.
    const ids = ranked.map((v) => v.videoId);
    const barred = new Set(ids.length ? (await store.all(`SELECT ss.youtube_video_id AS id FROM song_sources ss JOIN songs s ON s.id = ss.song_id
      WHERE ss.youtube_video_id IN (${inList(ids)}) AND (ss.available <> 1 OR s.org_id IS NOT NULL)`, ids)).map((r) => r.id) : []);
    const chosen = ranked.filter((v) => !barred.has(v.videoId)).slice(0, MAX_ADDED);
    // Plainly titled videos first ("Way Maker" on the artist's channel), so one that
    // names the artist in its title ("Way Maker - Leeland") finds that song already there.
    const order = [...chosen.filter((v) => !splitTitles(songFromVideo(v).title).length), ...chosen.filter((v) => splitTitles(songFromVideo(v).title).length)];
    const kept = [];
    for (const video of order) {
      try {
        const r = await importVideo(store, video, { language, userId: user.id, via: 'search', now: at });
        if (r.status === 'added' || r.status === 'exists') kept.push(video.videoId);
      } catch (err) {
        log('[live-search] import', video.videoId, err?.message);
      }
    }
    kept.sort((a, b) => chosen.findIndex((v) => v.videoId === a) - chosen.findIndex((v) => v.videoId === b));
    await store.run('UPDATE search_cache SET results = ? WHERE query_folded = ? AND language = ? AND fetched_at = ?', [JSON.stringify(kept), key, language, at]);
    return 'searched';
  }

  return { run };
}
