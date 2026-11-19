// Live YouTube song search (AINOS-SPEC.md 3.3, path B). Owner: Phase 3.
//
// When the local index has too few songs for a query, a signed-in listener
// (never a demo) can ask YouTube once. The results are written to the catalog
// as global songs with a YouTube source, exactly like the curated videos
// (scripts/youtube-videos.js), so the next search for them is local (path A)
// and costs no quota. Only YouTube's own title, channel and thumbnail are
// kept, plus the duration: never audio, never lyrics.
//
// Quota (YouTube Data API, checked 2026-11-19): search.list has its own bucket
// of 100 calls a day; videos.list costs 1 of the 10,000 daily units. So live
// search is explicit (a button, not every keystroke), cached per query for
// 7 days (empty results too), limited per user and per address, and capped
// for the whole app per day (YOUTUBE_DAILY_SEARCH_CAP, default 80).

import { mulberry32, hashSeed, seededId, fold, searchText } from './util.js';

export const SEARCH_CACHE_MS = 7 * 24 * 3600 * 1000;
// YouTube's terms: cached API data is refreshed or deleted within 30 days.
export const VIDEO_CACHE_MS = 30 * 24 * 3600 * 1000;
const MIN_MS = 60 * 1000; // shorter is a clip or a Short, not a song
const MAX_MS = 20 * 60 * 1000; // longer is a whole service or a medley
const LANGS = ['en', 'hi', 'ne', 'zh', 'ja', 'es'];

// Same ids as the curated videos (scripts/generate.js YOUTUBE_IDS), so a video
// found live and later curated is one song, never two.
const idFor = (key) => seededId(mulberry32(hashSeed(key)));
export const liveIds = {
  song: (videoId) => idFor(`youtube-song:${videoId}`),
  source: (videoId) => idFor(`youtube-source:${videoId}`),
};

/** The cache key for a query: folded, words only, in order. */
export function queryKey(q) {
  return (fold(String(q || '').normalize('NFKC')).match(/[\p{L}\p{M}\p{N}]+/gu) || []).join(' ').slice(0, 100);
}

/** ISO 8601 duration (videos.list contentDetails.duration, e.g. PT4M13S) in ms, or null. */
export function isoDurationMs(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d || '');
  if (!m || d === 'P' || d === 'PT') return null;
  const [, days, h, min, s] = m.map((x) => Number(x || 0));
  return Math.round((((days * 24 + h) * 60 + min) * 60 + s) * 1000);
}

// Words that describe the video, not the song.
const NOISE = /\b(official|music|lyrics?|video|audio|visuali[sz]er|live|acoustic|hd|4k|hq|mv|feat\.?|ft\.?|version|performance|session|worship|with)\b/gi;
const isNoise = (seg) => !seg.replace(NOISE, '').replace(/[\s\p{P}]/gu, '');
const sameName = (a, b) => !!a && !!b && queryKey(a) === queryKey(b);

/** "Elevation Worship - VEVO" / "Hillsong Worship - Topic" -> the artist's name. */
export function cleanChannel(name) {
  return String(name || '').replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').trim();
}

/**
 * Ainos's song record for a video: its title and artist, from YouTube's
 * title and channel. YouTube's title itself is kept unmodified for display.
 * "Goodness of God | Live | Bethel Music" -> { title: 'Goodness of God', artist: 'Bethel Music' }
 */
export function songMeta(videoTitle, channelTitle) {
  const channel = cleanChannel(channelTitle);
  // Bracketed notes: "(Official Lyric Video)", "[Live]", "(feat. X)".
  const bare = String(videoTitle || '').replace(/\s*[([【][^)\]】]*[)\]】]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = bare.split(/\s+[-–—|│｜]\s+|\s*[|│｜]\s*/).map((s) => s.trim()).filter(Boolean);
  let artist = null;
  const rest = [];
  for (const p of parts) {
    if (isNoise(p)) continue;
    if (!artist && sameName(p, channel)) { artist = p; continue; }
    rest.push(p);
  }
  // "Artist - Title": with two parts left and none named like the channel,
  // the first is usually the artist.
  if (!artist && rest.length >= 2 && !sameName(rest[1], channel)) artist = rest.shift();
  const title = (rest[0] || bare || String(videoTitle || '')).slice(0, 120);
  return { title, artist: (artist || channel || 'YouTube').slice(0, 120) };
}

/** What kind of upload a title says it is (song_sources.kind), or null when it doesn't say. */
export function videoKind(title) {
  if (/\blyrics?\b/i.test(title)) return 'lyric';
  if (/\blive\b/i.test(title)) return 'live';
  if (/\b(instrumental|backing track|karaoke)\b/i.test(title)) return 'backing';
  if (/\bofficial\b/i.test(title)) return 'official';
  return null;
}

/**
 * The YouTube Data API v3 client. search(q, { lang }) resolves with up to 15
 * embeddable, public, non-live videos: { videoId, title, channelId,
 * channelTitle, thumbnail, durationMs, language }. Throws on any API error.
 */
export function createYouTubeSearch({ apiKey = process.env.YOUTUBE_API_KEY, fetch = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const base = 'https://www.googleapis.com/youtube/v3';
  async function call(path, params) {
    const url = `${base}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = data?.error?.errors?.[0]?.reason || `HTTP ${res.status}`;
      const err = new Error(`YouTube ${path}: ${reason}`);
      err.reason = reason;
      throw err;
    }
    return data;
  }
  return {
    enabled: !!apiKey,
    async search(q, { lang } = {}) {
      const found = await call('search', {
        part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '15', q,
        safeSearch: 'strict', ...(LANGS.includes(lang) ? { relevanceLanguage: lang } : {}),
      });
      const ids = [...new Set((found?.items || []).map((x) => x?.id?.videoId).filter((id) => /^[\w-]{11}$/.test(id || '')))];
      if (!ids.length) return [];
      const details = await call('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: '50' });
      const byId = new Map((details?.items || []).map((v) => [v.id, v]));
      return ids.map((id) => byId.get(id)).filter((v) => v
        && v.status?.embeddable === true && v.status?.privacyStatus === 'public'
        && (v.snippet?.liveBroadcastContent || 'none') === 'none')
        .map((v) => {
          const s = v.snippet || {};
          const language = String(s.defaultAudioLanguage || s.defaultLanguage || '').slice(0, 2).toLowerCase();
          return {
            videoId: v.id,
            title: String(s.title || '').slice(0, 300),
            channelId: s.channelId || null,
            channelTitle: String(s.channelTitle || '').slice(0, 200),
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            durationMs: isoDurationMs(v.contentDetails?.duration),
            language: LANGS.includes(language) ? language : null,
          };
        })
        .filter((v) => v.title && v.durationMs !== null && v.durationMs >= MIN_MS && v.durationMs <= MAX_MS);
    },
  };
}

/** Song ids a query found live in the last 7 days, or null when it has no fresh cache row. */
export async function cachedSearch(store, key, now = Date.now()) {
  const latest = await store.get('SELECT MAX(fetched_at) AS at FROM youtube_search_cache WHERE query = ?', [key]);
  const at = latest?.at == null ? null : Number(latest.at);
  if (at === null || at <= now - SEARCH_CACHE_MS) return null;
  const rows = await store.all('SELECT position, video_id FROM youtube_search_cache WHERE query = ? AND fetched_at = ? ORDER BY position', [key, at]);
  const videoIds = rows.map((r) => r.video_id).filter(Boolean);
  if (!videoIds.length) return [];
  const sources = await store.all(`SELECT song_id, youtube_video_id FROM song_sources WHERE source = 'youtube' AND youtube_video_id IN (${videoIds.map(() => '?').join(', ')})`, videoIds);
  const songOf = new Map(sources.map((s) => [s.youtube_video_id, s.song_id]));
  return [...new Set(videoIds.map((v) => songOf.get(v)).filter(Boolean))];
}

/**
 * Write live results to the catalog (songs, sources, the video cache, the
 * search index) and the query cache; returns the song ids in result order.
 * A video already in the catalog (curated, or found before) keeps its song.
 */
export async function saveResults(store, key, videos, { lang = 'en', now = Date.now() } = {}) {
  const songIds = [];
  await store.tx(async (t) => {
    // Older rows for the query stay until purged: they tie their videos' cached data to its 30-day limit.
    if (!videos.length) await t.run('INSERT INTO youtube_search_cache (query, position, video_id, fetched_at) VALUES (?, 0, NULL, ?)', [key, now]);
    for (const [i, v] of videos.entries()) {
      await t.run('INSERT INTO youtube_search_cache (query, position, video_id, fetched_at) VALUES (?, ?, ?, ?)', [key, i, v.videoId, now]);
      await t.run(`INSERT INTO youtube_video_cache (video_id, channel_id, title, channel_title, thumbnail_url, duration_ms, embeddable, default_language, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (video_id) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title, channel_title = excluded.channel_title,
          thumbnail_url = excluded.thumbnail_url, duration_ms = excluded.duration_ms, embeddable = 1, default_language = excluded.default_language, fetched_at = excluded.fetched_at`,
      [v.videoId, v.channelId, v.title, v.channelTitle, v.thumbnail, v.durationMs, v.language, now]);
      const existing = await t.get("SELECT song_id FROM song_sources WHERE source = 'youtube' AND youtube_video_id = ?", [v.videoId]);
      if (existing) {
        await t.run("UPDATE song_sources SET available = 1, last_checked_at = ? WHERE source = 'youtube' AND youtube_video_id = ?", [now, v.videoId]);
        songIds.push(existing.song_id);
        continue;
      }
      const songId = liveIds.song(v.videoId);
      const meta = songMeta(v.title, v.channelTitle);
      await t.run(`INSERT INTO songs (id, title, artist, language, ccli_number, public_domain, org_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`, [songId, meta.title, meta.artist, v.language || lang, now, now]);
      await t.run(`INSERT INTO song_sources (id, song_id, source, track_id, youtube_video_id, kind, available, last_checked_at)
        VALUES (?, ?, 'youtube', NULL, ?, ?, 1, ?) ON CONFLICT DO NOTHING`, [liveIds.source(v.videoId), songId, v.videoId, videoKind(v.title), now]);
      // Searchable by the song record, the channel and YouTube's own title.
      const subtitle = `${meta.artist} ${v.channelTitle} ${v.title}`.slice(0, 500);
      await t.run('INSERT INTO search_index (kind, ref_id, title, subtitle, folded) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        ['song', songId, meta.title, subtitle, searchText(meta.title, subtitle)]);
      songIds.push(songId);
    }
  });
  return [...new Set(songIds)];
}

/**
 * Housekeeping: forget query caches older than 7 days, and YouTube data of
 * live-found videos not refreshed within 30 days (their songs then stop
 * showing until a search finds them again). The curated videos are refreshed
 * by every deploy's catalog sync.
 */
export async function purgeYouTubeCache(store, now = Date.now()) {
  await store.run(`DELETE FROM youtube_video_cache WHERE fetched_at < ?
    AND video_id IN (SELECT video_id FROM youtube_search_cache WHERE video_id IS NOT NULL)`, [now - VIDEO_CACHE_MS]);
  await store.run('DELETE FROM youtube_search_cache WHERE fetched_at < ?', [now - VIDEO_CACHE_MS]);
}
