// Listener routes: YouTube sources, song lyrics and timings.
// Owner: Phases 3-4 (search, YouTube, lyrics). Registered by createApp (server/app.js) with the shared context.
import { HttpError, sendJson, readJson } from './http.js';
import { inList } from './store.js';
import { memberOrgIds, requireRole } from './orgs.js';
import { assertAdmin } from './admin.js';
import { audit } from './audit.js';
import { int, oneOf, str, youtubeId } from './validate.js';
import { randomId } from './util.js';
import { rateLimit } from './auth.js';
import { importVideo, hideVideo, parseVideoUrl, isImportable, ImportError } from './youtube-import.js';

export const LANGS = ['en', 'hi', 'ne', 'zh', 'ja', 'es']; // LANGUAGES in app.js (not imported: app.js imports this file)

// Display order of section labels (songs.js SECTION_LABEL).
const LABEL_ORDER = ['I', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'PC', 'C', 'C2', 'B', 'T', 'E'];
// Tap-to-sync limits (spec 4.6): at most 400 timed lines, within the recording.
const MAX_TIMINGS = 400;
const MAX_RECORDING_MS = 2 * 3600 * 1000; // when the recording's length isn't known (curated videos)
const bad = (message) => new HttpError(400, message, 'invalid_input');
const labelRank = (l) => { const i = LABEL_ORDER.indexOf(l); return i < 0 ? LABEL_ORDER.length : i; };

/** `?lang=` when it is a supported language, else null (all languages). */
export function langParam(query) {
  const lang = query?.get?.('lang');
  return LANGS.includes(lang) ? lang : null;
}

/** SQL (and params) for "global, or one of these orgs": org lyrics are invisible to non-members. */
function visible(column, orgIds) {
  return orgIds.length ? { sql: `(${column} IS NULL OR ${column} IN (${inList(orgIds)}))`, params: orgIds } : { sql: `${column} IS NULL`, params: [] };
}

/** Timings rows the user may see for these sources, by source id. */
export async function timingsBySource(store, sourceIds, orgIds, lang = null) {
  const out = new Map(sourceIds.map((id) => [id, []]));
  if (!sourceIds.length) return out;
  const v = visible('org_id', orgIds);
  const rows = await store.all(
    `SELECT id, source_id, language, arrangement_id, offset_ms, timings, org_id, updated_at FROM lyric_timings
     WHERE source_id IN (${inList(sourceIds)}) AND ${v.sql}${lang ? ' AND language = ?' : ''} ORDER BY source_id, org_id, language, id`,
    [...sourceIds, ...v.params, ...(lang ? [lang] : [])]);
  for (const r of rows) {
    let timings;
    try { timings = JSON.parse(r.timings); } catch { continue; }
    if (!Array.isArray(timings)) continue;
    out.get(r.source_id).push({ id: r.id, language: r.language, arrangement_id: r.arrangement_id, offset_ms: Number(r.offset_ms) || 0, org_id: r.org_id, timings });
  }
  return out;
}

/**
 * Lyrics a user may see for one song: sections and arrangements (global plus
 * their orgs'), and its sources with any timings. Spec 4.6 GET /api/songs/:id.
 */
export async function songLyrics(store, catalog, songId, user, lang = null) {
  const orgIds = await memberOrgIds(store, user);
  const v = visible('org_id', orgIds);
  const [sectionRows, arrangementRows, sourcesBySong] = await Promise.all([
    store.all(`SELECT id, language, label, lines, org_id FROM song_sections WHERE song_id = ? AND ${v.sql}${lang ? ' AND language = ?' : ''}`,
      [songId, ...v.params, ...(lang ? [lang] : [])]),
    store.all(`SELECT id, name, section_order, org_id FROM song_arrangements WHERE song_id = ? AND ${v.sql} ORDER BY org_id, id`, [songId, ...v.params]),
    catalog.sourcesBySong([songId]),
  ]);
  const sections = sectionRows
    .map((r) => ({ id: r.id, language: r.language, label: r.label, lines: r.lines.split('\n'), org_id: r.org_id }))
    .sort((a, b) => (a.org_id ?? '').localeCompare(b.org_id ?? '') || a.language.localeCompare(b.language) || labelRank(a.label) - labelRank(b.label));
  const arrangements = arrangementRows.flatMap((r) => {
    try {
      const order = JSON.parse(r.section_order);
      return Array.isArray(order) ? [{ id: r.id, name: r.name, section_order: order, org_id: r.org_id }] : [];
    } catch { return []; }
  });
  const sources = sourcesBySong.get(songId);
  const timings = await timingsBySource(store, sources.map((s) => s.id), orgIds, lang);
  return { sections, arrangements, sources: sources.map((s) => ({ ...s, timings: timings.get(s.id) })) };
}

/**
 * @param {object} ctx { r, store, auth, catalog, scripture, youtube, youtubeDailySearchCap, adminIds, clientIp, isSecure, trustProxy, log }
 *   r: Router (r.get/post/put/patch/delete(pattern, handler)); auth(handler) adds ctx.user or 401s.
 */
export function register({ r, store, auth, catalog, adminIds, youtube }) {
  // One playable source with its song, so a queued or transferred YouTube item
  // ("yt:<source id>") can be shown and played on any device (spec 3.4 Connect).
  r.get('/api/sources/:id', auth(async ({ res, user, params }) => {
    const id = params.id;
    const row = typeof id === 'string' && id.length <= 64
      ? await store.get('SELECT s.id, s.title, s.artist, s.language, s.org_id FROM song_sources ss JOIN songs s ON s.id = ss.song_id WHERE ss.id = ?', [id]) : null;
    if (!row || (row.org_id !== null && !(await memberOrgIds(store, user)).includes(row.org_id))) throw new HttpError(404, 'Source not found', 'not_found');
    const source = (await catalog.sourcesBySong([row.id])).get(row.id).find((x) => x.id === id);
    if (!source) throw new HttpError(404, 'Source not found', 'not_found'); // unavailable, or YouTube's data is gone
    sendJson(res, 200, { song: { id: row.id, name: row.title, artist: { name: row.artist }, language: row.language }, source });
  }));

  // Timings for one recording, as far as the user may see them (global + their orgs').
  r.get('/api/sources/:id/timings', auth(async ({ res, user, params, query }) => {
    const id = params.id;
    const source = typeof id === 'string' && id.length <= 64
      ? await store.get('SELECT ss.id, s.org_id FROM song_sources ss JOIN songs s ON s.id = ss.song_id WHERE ss.id = ?', [id]) : null;
    const orgIds = source ? await memberOrgIds(store, user) : [];
    if (!source || (source.org_id !== null && !orgIds.includes(source.org_id))) throw new HttpError(404, 'Source not found');
    const timings = await timingsBySource(store, [source.id], orgIds, langParam(query));
    sendJson(res, 200, { source_id: source.id, timings: timings.get(source.id) });
  }));

  // ---------------- YouTube videos in the catalog (spec 3.2 admin import; PLAN.md L2) ----------------
  /** A song with one of its sources, as GET /api/sources/:id gives it (source null when it is hidden or unavailable). */
  async function songWithSource(songId, sourceId) {
    const song = await store.get('SELECT id, title, artist, language FROM songs WHERE id = ?', [songId]);
    const source = (await catalog.sourcesBySong([songId])).get(songId).find((x) => x.id === sourceId) || null;
    return { song: { id: song.id, name: song.title, artist: { name: song.artist }, language: song.language }, source };
  }

  // A catalog admin pastes a YouTube link (or a video id): the video becomes a
  // source of the song its title names, or of `song_id` when given, which also
  // moves a video the live search matched to the wrong song. Costs one
  // videos.list unit; nothing is fetched from the pasted address itself.
  r.post('/api/admin/youtube/import', auth(async ({ req, res, user }) => {
    assertAdmin(user, adminIds);
    await rateLimit(store, `user:${user.id}:yt-import`, { limit: 60, windowSec: 3600, message: 'Too many imports, try again in an hour' });
    const body = await readJson(req);
    const videoId = parseVideoUrl(body.url);
    if (!videoId) throw bad('url must be a YouTube video link or an 11-character video id');
    const songId = body.song_id == null || body.song_id === '' ? null : str(body.song_id, { name: 'song_id', min: 1, max: 64 });
    const language = body.language == null || body.language === '' ? user.language : oneOf(body.language, LANGS, { name: 'language' });
    const found = await youtube.videoDetails([videoId]);
    if (!found.ok) {
      throw new HttpError(503, found.reason === 'no_key' ? 'YouTube isn’t set up on this server (YOUTUBE_API_KEY)' : 'YouTube can’t be reached right now, try again later', 'youtube_unavailable');
    }
    const video = found.videos[0];
    if (!video) throw new HttpError(404, 'YouTube has no public video with that id', 'not_found');
    if (!isImportable(video)) throw bad(video.live ? 'Live streams can’t be added' : 'That video can’t be embedded, so it can’t be played in Ainos');
    let result;
    try {
      result = await importVideo(store, video, { language, userId: user.id, via: 'admin', songId });
    } catch (err) {
      if (err instanceof ImportError) throw new HttpError(404, err.message, err.code);
      throw err;
    }
    if (result.status === 'private') throw new HttpError(409, 'That video already belongs to a church’s song', 'conflict');
    sendJson(res, result.status === 'added' ? 201 : 200, { status: result.status, created_song: result.createdSong, ...(await songWithSource(result.songId, result.sourceId)) });
  }));

  // Take a video out of the catalog (a wrong match, or not a worship song). It
  // stays out: a later live search never adds it back; only an admin import does.
  r.delete('/api/admin/youtube/:videoId', auth(async ({ res, user, params }) => {
    assertAdmin(user, adminIds);
    let videoId;
    try { videoId = youtubeId(params.videoId); } catch { throw new HttpError(404, 'Video not found', 'not_found'); }
    if (!(await hideVideo(store, videoId, { userId: user.id }))) throw new HttpError(404, 'Video not found', 'not_found');
    sendJson(res, 200, { ok: true });
  }));

  // Tap-to-sync (spec 4.4, 4.6): save the line times for one recording. A
  // church leader saves timings for their church (made from the lyrics their
  // church sees); a catalog admin saves the global ones. Timings belong to the
  // recording, never to the song, and replace that church's earlier sync.
  r.put('/api/sources/:id/timings', auth(async ({ req, res, user, params }) => {
    const id = typeof params.id === 'string' && params.id.length <= 64 ? params.id : null;
    const source = id ? await store.get(`SELECT ss.id, ss.song_id, ss.source, s.org_id AS song_org, t.duration_ms AS track_ms, y.duration_ms AS video_ms
      FROM song_sources ss JOIN songs s ON s.id = ss.song_id
      LEFT JOIN tracks t ON t.id = ss.track_id LEFT JOIN youtube_video_cache y ON y.video_id = ss.youtube_video_id WHERE ss.id = ?`, [id]) : null;
    if (!source) throw new HttpError(404, 'Source not found', 'not_found');
    const body = await readJson(req);
    const orgId = body.org_id == null || body.org_id === '' ? null : body.org_id;
    // Who may save: a leader of the church named (their church's timings), else a catalog admin (global ones).
    let membership = null;
    if (orgId !== null) membership = await requireRole(store, user, orgId, 'song.edit');
    else assertAdmin(user, adminIds);
    // A church's song is only ever synced by that church.
    if (source.song_org !== null && source.song_org !== (membership?.org_id ?? null)) throw new HttpError(404, 'Source not found', 'not_found');
    const language = oneOf(body.language, LANGS, { name: 'language' });
    const offsetMs = body.offset_ms == null ? 0 : int(body.offset_ms, { name: 'offset_ms', min: -60_000, max: 60_000 });
    const arrangementId = body.arrangement_id == null || body.arrangement_id === '' ? null : str(body.arrangement_id, { name: 'arrangement_id', min: 1, max: 64 });
    if (!Array.isArray(body.timings) || !body.timings.length) throw bad('timings must be a non-empty list');
    if (body.timings.length > MAX_TIMINGS) throw bad(`At most ${MAX_TIMINGS} timed lines`);

    // The lines must exist in the lyrics this church (or everyone, for global timings) sees.
    const orgs = membership ? [membership.org_id] : [];
    const v = visible('org_id', orgs);
    const sections = await store.all(`SELECT label, lines, org_id FROM song_sections WHERE song_id = ? AND language = ? AND ${v.sql}`, [source.song_id, language, ...v.params]);
    const lineCount = new Map();
    for (const s of sections) if (!lineCount.has(s.label) || s.org_id) lineCount.set(s.label, s.lines.split('\n').length);
    const durationMs = Number(source.track_ms || source.video_ms) || MAX_RECORDING_MS;
    let last = -1;
    const timings = body.timings.map((x, i) => {
      if (!x || typeof x !== 'object') throw bad(`timings[${i}] must be an object`);
      const label = typeof x.label === 'string' ? x.label : '';
      const line = int(x.line, { name: `timings[${i}].line`, min: 0, max: 50 });
      const ms = int(x.ms, { name: `timings[${i}].ms`, min: 0, max: durationMs });
      if (!lineCount.has(label) || line >= lineCount.get(label)) throw bad(`timings[${i}]: no line ${line + 1} in section ${label}`);
      if (ms <= last) throw bad(`timings[${i}].ms must be later than the line before`);
      last = ms;
      return { label, line, ms };
    });
    if (arrangementId) {
      const arr = await store.get(`SELECT id FROM song_arrangements WHERE id = ? AND song_id = ? AND ${v.sql}`, [arrangementId, source.song_id, ...v.params]);
      if (!arr) throw bad('arrangement_id: arrangement not found for that song');
    }

    await store.tx(async (t) => {
      // Touch the source row first: on Postgres this locks it, so two saves for the same
      // recording run one after the other and the delete-then-insert leaves one row.
      await t.run('UPDATE song_sources SET available = available WHERE id = ?', [source.id]);
      const scope = orgId === null ? 'org_id IS NULL' : 'org_id = ?';
      const scopeParams = orgId === null ? [] : [orgId];
      await t.run(`DELETE FROM lyric_timings WHERE source_id = ? AND language = ? AND ${scope} AND ${arrangementId ? 'arrangement_id = ?' : 'arrangement_id IS NULL'}`,
        [source.id, language, ...scopeParams, ...(arrangementId ? [arrangementId] : [])]);
      await t.run('INSERT INTO lyric_timings (id, source_id, language, arrangement_id, offset_ms, timings, created_by, org_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomId(), source.id, language, arrangementId, offsetMs, JSON.stringify(timings), user.id, orgId, Date.now()]);
      await audit(t, { orgId, userId: user.id, action: 'timings.replace', targetType: 'source', targetId: source.id,
        details: { language, arrangement_id: arrangementId, lines: timings.length, offset_ms: offsetMs } });
    });
    const saved = await timingsBySource(store, [source.id], orgs, language);
    sendJson(res, 200, { source_id: source.id, timings: saved.get(source.id) });
  }));
}
