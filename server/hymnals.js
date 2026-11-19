// Numbered hymnals (spec 5.8). A church can project from one numbered hymnal,
// e.g. a Nepali church hymnal, and find its songs by number. The app ships with
// no hymnal content: a hymnal is added only after its publisher gives
// permission, and stays hidden until permission_note records that permission.

/** SQL condition: hymnal h is usable by the church bound to the next parameter. */
const VISIBLE = "h.permission_note IS NOT NULL AND trim(h.permission_note) <> '' AND (h.org_id IS NULL OR h.org_id = ?)";

/** Hymnals this church may use, by name. */
export async function visibleHymnals(store, orgId) {
  const rows = await store.all(`SELECT h.id, h.name, h.language, (SELECT count(*) FROM hymnal_entries e WHERE e.hymnal_id = h.id) AS entries
    FROM hymnals h WHERE ${VISIBLE}`, [orgId]);
  return rows.map((r) => ({ id: r.id, name: r.name, language: r.language, entries: Number(r.entries) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The hymnal a church has picked, or null when it has none or may no longer use it. */
export async function orgHymnal(store, org) {
  if (!org?.hymnal_id) return null;
  const row = await store.get(`SELECT h.id, h.name, h.language FROM hymnals h WHERE h.id = ? AND ${VISIBLE}`, [org.hymnal_id, org.id]);
  return row ? { id: row.id, name: row.name, language: row.language } : null;
}

/** Map of song id → hymn number in that hymnal. */
export async function hymnNumbers(store, hymnalId) {
  if (!hymnalId) return new Map();
  const rows = await store.all('SELECT song_id, number FROM hymnal_entries WHERE hymnal_id = ?', [hymnalId]);
  const out = new Map();
  for (const r of rows) if (!out.has(r.song_id) || Number(r.number) < out.get(r.song_id)) out.set(r.song_id, Number(r.number));
  return out;
}
