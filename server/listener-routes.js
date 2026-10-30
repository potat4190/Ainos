// Listener routes: YouTube sources, song lyrics and timings.
// Owner: Phases 3-4 (search, YouTube, lyrics). Registered by createApp (server/app.js) with the shared context.
import { HttpError, sendJson } from './http.js';
import { inList } from './store.js';
import { memberOrgIds } from './orgs.js';

export const LANGS = ['en', 'hi', 'ne', 'zh', 'ja', 'es']; // LANGUAGES in app.js (not imported: app.js imports this file)

// Display order of section labels (songs.js SECTION_LABEL).
const LABEL_ORDER = ['I', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'PC', 'C', 'C2', 'B', 'T', 'E'];
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
 * @param {object} ctx { r, store, auth, catalog, scripture, adminIds, clientIp, isSecure, trustProxy, log }
 *   r: Router (r.get/post/put/patch/delete(pattern, handler)); auth(handler) adds ctx.user or 401s.
 */
export function register({ r, store, auth }) {
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
}
