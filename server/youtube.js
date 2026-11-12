// YouTube Data API v3 client for the live search fallback (AINOS-SPEC.md 3.3
// path B; PLAN.md "Live YouTube search", L1). When a search finds no song,
// Ainos asks YouTube once, keeps the video ids and YouTube's own title,
// channel and thumbnail, and finds the song locally from then on.
//
// Only two endpoints are ever called (search.list, videos.list), with URLs
// built here from validated values. The API key travels in a header and
// never appears in a URL, a log line or a response. Nothing is downloaded but
// JSON: never audio, never a video.
//
// Quota: a search.list call costs 100 of the 10,000 daily units, a videos.list
// call 1 (up to 50 ids). The routes keep live searches rare (daily cap,
// per-user limits, remembered misses); this module only reports what happened.
//
// Every method resolves (never rejects) for API trouble, with a `reason`, so
// a search never fails because of YouTube.
import { fold } from './util.js';

export const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
/** YouTube's category id for Music: the only category a live search accepts. */
export const MUSIC_CATEGORY = '10';
export const SEARCH_RESULTS = 15; // spec 3.3
const IDS_PER_CALL = 50; // videos.list takes up to 50 ids per call
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PAUSE_MS = 60 * 1000; // after a timeout, network error or 5xx, no calls for this long
const QUOTA_PAUSE_MS = 3600 * 1000; // after YouTube says the quota is used up

/** An ISO 8601 duration as YouTube gives it ("PT4M13S", "PT1H2M", "P1DT3S") in milliseconds; null when it isn't one. */
export function isoDurationMs(value) {
  const m = typeof value === 'string' ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value) : null;
  if (!m || value === 'P' || value.endsWith('T')) return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x || 0));
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
}

/** What kind of recording a video title describes: 'lyric', 'live' or (the default) 'official'. */
export function videoKind(title) {
  const t = fold(String(title ?? ''));
  if (/\blyrics?\b/.test(t)) return 'lyric';
  if (/\blive\b/.test(t)) return 'live';
  return 'official';
}

// Words that describe the video, not the song: a bracketed part made only of
// these (and digits) is dropped, as is the same at the end after a dash or bar.
const NOISE = new Set(['official', 'lyric', 'lyrics', 'video', 'music', 'audio', 'live', 'hd', 'hq', '4k', 'visualizer', 'visualiser',
  'with', 'and', 'the', 'version', 'performance', 'acoustic', 'studio', 'full', 'new', 'song', 'worship', 'mv', 'cc', 'subtitles', 'captions']);
const isNoise = (text) => {
  const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => NOISE.has(w) || /^\d+$/.test(w));
};
const same = (a, b) => fold(a).replace(/[^\p{L}\p{N}]+/gu, '') === fold(b).replace(/[^\p{L}\p{N}]+/gu, '');

/** A channel's name as an artist name: without YouTube's "- Topic" and "VEVO" suffixes. */
export function artistFromChannel(channelTitle) {
  return String(channelTitle ?? '').replace(/\s+-\s+Topic$/i, '').replace(/\s*VEVO$/i, '').trim().slice(0, 120);
}

/**
 * Ainos's own song title for a video (the video keeps YouTube's title,
 * unmodified, wherever it is shown): "Carry My Cross - Official Lyric Video"
 * and "Carry My Cross (Live) | Victory Worship" both become "Carry My Cross".
 * Falls back to the whole title when nothing would be left.
 */
export function cleanSongTitle(title, channelTitle = '') {
  const full = String(title ?? '').replace(/\s+/g, ' ').trim();
  const artist = artistFromChannel(channelTitle);
  // Bracketed descriptions: (Official Video), [Live], (Lyrics) ...
  let t = full.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (whole, inner) => (isNoise(inner) || (artist && same(inner, artist)) ? ' ' : whole));
  // Parts split by " - ", " | ", " // " or " · ": drop the artist's name and pure descriptions.
  const parts = t.split(/\s+(?:[-–—|·]|\/\/)\s+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !isNoise(p) && !(artist && same(p, artist)));
  t = (kept.length ? kept : parts).join(' - ');
  t = t.replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  return (t || full).slice(0, 200);
}

/** The song a video is a recording of, in Ainos's own words: { title, artist, kind }. */
export function songFromVideo({ title, channelTitle }) {
  return { title: cleanSongTitle(title, channelTitle), artist: artistFromChannel(channelTitle), kind: videoKind(title) };
}

/** The thumbnail YouTube serves for every public video (the only image host the app's CSP allows for videos). */
export const thumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

function thumbnailOf(videoId, thumbnails) {
  for (const size of ['high', 'medium', 'default']) {
    const url = thumbnails?.[size]?.url;
    try {
      if (typeof url === 'string' && new URL(url).protocol === 'https:' && new URL(url).hostname === 'i.ytimg.com') return url;
    } catch { /* not a URL */ }
  }
  return thumbnailUrl(videoId);
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One videos.list item as Ainos keeps it; null when it has no usable id or title. */
function videoDto(item) {
  const id = item?.id;
  const sn = item?.snippet;
  if (typeof id !== 'string' || !VIDEO_ID.test(id) || !sn || typeof sn.title !== 'string' || !sn.title.trim()) return null;
  return {
    videoId: id,
    title: sn.title.slice(0, 300), // YouTube's title, unmodified
    channelId: text(sn.channelId, 64) || null,
    channelTitle: text(sn.channelTitle, 200),
    thumbnail: thumbnailOf(id, sn.thumbnails),
    durationMs: isoDurationMs(item.contentDetails?.duration),
    embeddable: item.status?.embeddable === true,
    public: item.status?.privacyStatus === 'public',
    live: sn.liveBroadcastContent === 'live' || sn.liveBroadcastContent === 'upcoming',
    categoryId: text(sn.categoryId, 8) || null,
    defaultLanguage: text(sn.defaultAudioLanguage || sn.defaultLanguage, 16) || null,
  };
}

/** Whether a live search may add this video: a public, embeddable, finished music video. */
export const isPlayableMusic = (v) => !!v && v.embeddable && v.public && !v.live && v.categoryId === MUSIC_CATEGORY && v.durationMs > 0;

class UpstreamError extends Error {
  constructor(message, reason = 'error') {
    super(message);
    this.reason = reason;
  }
}

/**
 * The YouTube client. `fetch`, `apiKey` and `now` are injectable for tests
 * (tests never call YouTube).
 *
 * Results are `{ ok: true, videos }` or `{ ok: false, reason, videos: [] }`
 * with reason 'no_key' | 'quota' | 'paused' | 'error'. Only an `ok` answer
 * says anything about YouTube's catalog: a failed call must not be remembered
 * as "nothing found".
 */
export function createYouTube({ apiKey = process.env.YOUTUBE_API_KEY, fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now, log = () => {} } = {}) {
  let pausedUntil = 0;
  let pauseReason = 'paused';

  function pause(ms, reason) {
    pausedUntil = now() + ms;
    pauseReason = reason;
  }

  // Redirects are refused: fetch would carry the key header to wherever one points.
  async function call(pathname, params) {
    if (now() < pausedUntil) throw new UpstreamError('paused', pauseReason);
    const url = new URL(YOUTUBE_API + pathname);
    for (const [k, v] of params) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (err) {
      pause(PAUSE_MS, 'paused');
      throw new UpstreamError(err?.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    let body = null;
    try {
      body = await res.json();
    } catch { /* judged below */ }
    if (!res.ok) {
      // Only the reason code is read from an error body; the body itself is never logged.
      const why = text(body?.error?.errors?.[0]?.reason, 40).replace(/[^A-Za-z]/g, '');
      if (res.status === 403 && /quota|dailyLimit|rateLimit/i.test(why)) {
        pause(QUOTA_PAUSE_MS, 'quota');
        throw new UpstreamError(`HTTP 403 ${why}`, 'quota');
      }
      if (res.status >= 500 || res.status === 429) pause(PAUSE_MS, 'paused');
      throw new UpstreamError(`HTTP ${res.status}${why ? ` ${why}` : ''}`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpstreamError('unexpected body');
    return body;
  }

  const failed = (what, err) => {
    if (!(err instanceof UpstreamError)) throw err;
    log('[youtube]', what, err.message);
    return { ok: false, reason: err.reason, videos: [] };
  };

  /**
   * Details for up to 50 video ids per unit, in the order asked. Ids YouTube
   * doesn't answer for (deleted, private) are simply missing from `videos`.
   */
  async function videoDetails(ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && VIDEO_ID.test(id)))];
    if (!apiKey) return { ok: false, reason: 'no_key', videos: [] };
    try {
      const found = new Map();
      for (let i = 0; i < wanted.length; i += IDS_PER_CALL) {
        const body = await call('/videos', [['part', 'snippet,contentDetails,status'], ['id', wanted.slice(i, i + IDS_PER_CALL).join(',')], ['maxResults', String(IDS_PER_CALL)]]);
        for (const item of Array.isArray(body.items) ? body.items : []) {
          const v = videoDto(item);
          if (v) found.set(v.videoId, v);
        }
      }
      return { ok: true, videos: wanted.map((id) => found.get(id)).filter(Boolean) };
    } catch (err) {
      return failed('videos', err);
    }
  }

  /**
   * One live search: embeddable music videos for `q`, best match first, with
   * their details. Costs one search.list call and one videos.list call.
   * `language` (a UI language code) only nudges YouTube's ranking.
   */
  async function searchVideos(q, { language = null } = {}) {
    const query = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    if (!apiKey) return { ok: false, reason: 'no_key', videos: [] };
    if (!query) return { ok: true, videos: [] };
    let ids;
    try {
      const params = [['part', 'id'], ['type', 'video'], ['videoEmbeddable', 'true'], ['videoCategoryId', MUSIC_CATEGORY],
        ['safeSearch', 'moderate'], ['maxResults', String(SEARCH_RESULTS)], ['q', query]];
      if (typeof language === 'string' && /^[a-z]{2}$/.test(language)) params.push(['relevanceLanguage', language]);
      const body = await call('/search', params);
      ids = (Array.isArray(body.items) ? body.items : []).map((item) => item?.id?.videoId).filter((id) => typeof id === 'string' && VIDEO_ID.test(id));
    } catch (err) {
      return failed('search', err);
    }
    if (!ids.length) return { ok: true, videos: [] };
    // The search's own filters are checked again on the details: only these fields are trusted.
    const details = await videoDetails(ids);
    return details.ok ? { ok: true, videos: details.videos.filter(isPlayableMusic) } : details;
  }

  return { searchVideos, videoDetails, hasKey: !!apiKey };
}
