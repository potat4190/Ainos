// Read models for the catalog. Shapes are loosely modelled on the Spotify Web
// API (id + uri + nested simplified artist/album objects).
import { toUri, fold, searchText } from './util.js';
import { inList } from './store.js';

const TRACK_SELECT = `
  SELECT t.id, t.title, t.track_no, t.duration_ms, t.genre, t.language, t.tempo, t.key, t.mode,
         t.energy, t.valence, t.danceability, t.acousticness, t.loudness_lufs,
         a.id AS artist_id, a.name AS artist_name,
         al.id AS album_id, al.title AS album_title, al.cover AS album_cover, al.color AS album_color
  FROM tracks t
  JOIN artists a ON a.id = t.artist_id
  JOIN albums al ON al.id = t.album_id`;

const ALBUM_SELECT = 'SELECT al.*, a.name AS artist_name, a.language AS artist_language FROM albums al JOIN artists a ON a.id = al.artist_id';

export function trackDto(r) {
  return {
    id: r.id,
    uri: toUri('track', r.id),
    title: r.title,
    track_no: r.track_no,
    duration_ms: r.duration_ms,
    genre: r.genre,
    language: r.language,
    artist: { id: r.artist_id, name: r.artist_name },
    album: { id: r.album_id, title: r.album_title, cover: '/' + r.album_cover, color: r.album_color },
    features: {
      tempo: r.tempo, key: r.key, mode: r.mode, energy: round(r.energy), valence: round(r.valence),
      danceability: round(r.danceability), acousticness: round(r.acousticness), loudness: round(r.loudness_lufs, 1),
    },
  };
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ---- search: prefix matching over title/subtitle words, titles weigh 5x ----
// Marks belong to their word: Devanagari vowel signs are marks, for example.
const words = (s) => fold(s || '').match(/[\p{L}\p{M}\p{N}]+/gu) || [];
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Score one document for the query terms; 0 = not every term matched. */
export function searchScore(terms, title, subtitle) {
  const tw = words(title), sw = words(subtitle);
  const ft = fold(title || ''), fs = fold(subtitle || '');
  let score = 0;
  for (const term of terms) {
    // CJK text has no spaces between words, so match those terms anywhere.
    const inTitle = CJK.test(term) ? ft.includes(term) : tw.some((w) => w.startsWith(term));
    const inSub = CJK.test(term) ? fs.includes(term) : sw.some((w) => w.startsWith(term));
    if (!inTitle && !inSub) return 0;
    score += (inTitle ? 10 : 0) + (inSub ? 2 : 0);
  }
  // Shorter titles rank first among equals, like BM25's length normalization.
  return score + 1 / (1 + tw.length);
}

export class Catalog {
  /** @param {import('./store.js').Store} store */
  constructor(store) {
    this.store = store;
  }

  async tracksByIds(ids) {
    if (!ids.length) return [];
    const rows = await this.store.all(`${TRACK_SELECT} WHERE t.id IN (${inList(ids)})`, ids);
    const byId = new Map(rows.map((r) => [r.id, trackDto(r)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async track(id) {
    const r = await this.store.get(`${TRACK_SELECT} WHERE t.id = ?`, [id]);
    return r ? trackDto(r) : null;
  }

  albumSummary(r) {
    return { id: r.id, uri: toUri('album', r.id), title: r.title, year: r.year, type: r.type, cover: '/' + r.cover, color: r.color, released_at: r.released_at, language: r.artist_language, artist: { id: r.artist_id, name: r.artist_name } };
  }

  async album(id) {
    const r = await this.store.get(`${ALBUM_SELECT} WHERE al.id = ?`, [id]);
    if (!r) return null;
    const tracks = (await this.store.all(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.track_no`, [id])).map(trackDto);
    return { ...this.albumSummary(r), tracks, duration_ms: tracks.reduce((s, t) => s + t.duration_ms, 0) };
  }

  async albums({ newest = false, limit = 50, language = null } = {}) {
    // Albums in the requested language first (CASE keeps NULL handling identical on both engines).
    const rows = await this.store.all(
      `${ALBUM_SELECT} ORDER BY CASE WHEN a.language = ? THEN 0 ELSE 1 END, ${newest ? 'al.released_at DESC' : 'a.name, al.year'} LIMIT ?`,
      [language, limit],
    );
    return rows.map((r) => this.albumSummary(r));
  }

  artistSummary(r) {
    return { id: r.id, uri: toUri('artist', r.id), name: r.name, genre: r.genre, language: r.language, image: '/' + r.image, color: r.color };
  }

  async artists({ language = null } = {}) {
    const rows = await this.store.all('SELECT * FROM artists ORDER BY CASE WHEN language = ? THEN 0 ELSE 1 END, name', [language]);
    return rows.map((r) => this.artistSummary(r));
  }

  async artistsByIds(ids) {
    if (!ids.length) return [];
    const rows = await this.store.all(`SELECT * FROM artists WHERE id IN (${inList(ids)})`, ids);
    const byId = new Map(rows.map((r) => [r.id, this.artistSummary(r)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async artist(id) {
    const r = await this.store.get('SELECT * FROM artists WHERE id = ?', [id]);
    if (!r) return null;
    const [plays, trackRows, monthly, albumRows] = await Promise.all([
      // Plays for this artist's tracks only (not an aggregate over the whole streams table).
      this.store.all('SELECT track_id, COUNT(*) AS n FROM streams WHERE track_id IN (SELECT id FROM tracks WHERE artist_id = ?) GROUP BY track_id', [id]),
      this.store.all(`${TRACK_SELECT} WHERE t.artist_id = ?`, [id]),
      this.store.get('SELECT COUNT(DISTINCT s.user_id) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE t.artist_id = ? AND s.ended_at > ?', [id, Date.now() - 28 * 86400000]),
      this.store.all(`${ALBUM_SELECT} WHERE al.artist_id = ? ORDER BY al.released_at DESC`, [id]),
    ]);
    const playMap = new Map(plays.map((p) => [p.track_id, p.n]));
    const top = trackRows.sort((x, y) => (playMap.get(y.id) || 0) - (playMap.get(x.id) || 0)).slice(0, 5);
    return {
      ...this.artistSummary(r),
      bio: r.bio,
      monthly_listeners: monthly.n,
      top_tracks: top.map((t) => ({ ...trackDto(t), plays: playMap.get(t.id) || 0 })),
      albums: albumRows.map((x) => this.albumSummary(x)),
    };
  }

  /** Summaries for many playlist rows with two queries in total (covers + counts). */
  async playlistSummaries(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [coverRows, countRows] = await Promise.all([
      this.store.all(`SELECT pt.playlist_id, al.cover, MIN(pt.position) AS pos FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id
                      WHERE pt.playlist_id IN (${inList(ids)}) GROUP BY pt.playlist_id, al.cover ORDER BY pt.playlist_id, pos`, ids),
      this.store.all(`SELECT playlist_id, COUNT(*) AS n FROM playlist_tracks WHERE playlist_id IN (${inList(ids)}) GROUP BY playlist_id`, ids),
    ]);
    const covers = new Map();
    for (const c of coverRows) {
      const list = covers.get(c.playlist_id) || [];
      if (list.length < 4) list.push('/' + c.cover);
      covers.set(c.playlist_id, list);
    }
    const counts = new Map(countRows.map((c) => [c.playlist_id, c.n]));
    return rows.map((r) => ({
      id: r.id, uri: toUri('playlist', r.id), name: r.name, description: r.description, color: r.color,
      owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : { id: null, name: 'Ainos' },
      editorial: r.owner_id == null, is_public: !!r.is_public, covers: covers.get(r.id) || [], track_count: counts.get(r.id) || 0, updated_at: r.updated_at,
    }));
  }

  playlistRow(id) {
    return this.store.get('SELECT p.*, u.display_name AS owner_name FROM playlists p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?', [id]);
  }

  async playlist(id) {
    const r = await this.playlistRow(id);
    if (!r) return null;
    const [rows, [summary]] = await Promise.all([
      this.store.all(`SELECT pt.position, pt.added_at, x.* FROM playlist_tracks pt JOIN (${TRACK_SELECT}) x ON x.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`, [id]),
      this.playlistSummaries([r]),
    ]);
    const tracks = rows.map((row) => ({ ...trackDto(row), position: row.position, added_at: row.added_at }));
    return { ...summary, tracks, duration_ms: tracks.reduce((s, t) => s + t.duration_ms, 0) };
  }

  async editorialPlaylists() {
    return this.playlistSummaries(await this.store.all('SELECT p.*, NULL AS owner_name FROM playlists p WHERE owner_id IS NULL ORDER BY name'));
  }

  async userPlaylists(userId) {
    return this.playlistSummaries(await this.store.all(
      'SELECT p.*, u.display_name AS owner_name FROM playlists p JOIN users u ON u.id = p.owner_id WHERE p.owner_id = ? ORDER BY p.updated_at DESC', [userId]));
  }

  genres() {
    return this.store.all('SELECT a.genre, MIN(a.color) AS color, COUNT(t.id) AS tracks FROM artists a JOIN tracks t ON t.artist_id = a.id GROUP BY a.genre ORDER BY a.genre');
  }

  async genre(name) {
    const [tracks, artists] = await Promise.all([
      this.store.all(`${TRACK_SELECT} WHERE t.genre = ? ORDER BY a.name, t.track_no`, [name]),
      this.store.all('SELECT * FROM artists WHERE genre = ?', [name]),
    ]);
    return { name, tracks: tracks.map(trackDto), artists: artists.map((r) => this.artistSummary(r)) };
  }

  /** Most-streamed tracks in a recent window, prioritizing the requested language. */
  async popular(days = 7, limit = 10, language = null) {
    const since = Date.now() - days * 86400000;
    let rows;
    if (language) {
      rows = await this.store.all(
        'SELECT s.track_id, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.ended_at > ? AND t.language = ? GROUP BY s.track_id ORDER BY n DESC LIMIT ?',
        [since, language, limit]);
      if (rows.length < limit) {
        // Top up with unplayed songs in that language so the shelf is never short.
        const have = new Set(rows.map((r) => r.track_id));
        for (const e of await this.store.all('SELECT id FROM tracks WHERE language = ? ORDER BY track_no, id', [language])) {
          if (rows.length >= limit) break;
          if (!have.has(e.id)) { rows.push({ track_id: e.id, n: 0 }); have.add(e.id); }
        }
      }
    }
    if (!rows?.length) {
      rows = await this.store.all('SELECT track_id, COUNT(*) AS n FROM streams WHERE ended_at > ? GROUP BY track_id ORDER BY n DESC LIMIT ?', [since, limit]);
    }
    const plays = new Map(rows.map((r) => [r.track_id, r.n]));
    return (await this.tracksByIds(rows.map((r) => r.track_id))).map((t) => ({ ...t, plays: plays.get(t.id) }));
  }

  /** Search with prefix matching; every term must match the title or subtitle. */
  async search(q, limit = 8) {
    const terms = [...new Set(words(q.normalize('NFKC')))].slice(0, 8);
    if (!terms.length) return { tracks: [], artists: [], albums: [], playlists: [], top: null };
    // Only rows containing every term leave the database; searchScore then
    // checks for word prefixes. Terms are letters, marks and digits only, so
    // they hold no LIKE wildcards. Rows not folded yet are always candidates.
    const docs = await this.store.all(
      `SELECT kind, ref_id, title, subtitle FROM search_index WHERE folded = '' OR (${terms.map(() => 'folded LIKE ?').join(' AND ')})`,
      terms.map((t) => `%${t}%`));
    const hits = docs
      .map((d) => ({ kind: d.kind, ref_id: d.ref_id, score: searchScore(terms, d.title, d.subtitle) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
    const ids = { track: [], artist: [], album: [], playlist: [] };
    for (const h of hits) if (ids[h.kind] && ids[h.kind].length < limit) ids[h.kind].push(h.ref_id);

    const [tracks, artists, albumRows, playlistRows] = await Promise.all([
      this.tracksByIds(ids.track),
      this.artistsByIds(ids.artist),
      ids.album.length ? this.store.all(`${ALBUM_SELECT} WHERE al.id IN (${inList(ids.album)})`, ids.album) : [],
      ids.playlist.length ? this.store.all(`SELECT p.*, u.display_name AS owner_name FROM playlists p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id IN (${inList(ids.playlist)}) AND p.is_public = 1`, ids.playlist) : [],
    ]);
    const albums = new Map(albumRows.map((r) => [r.id, this.albumSummary(r)]));
    const playlists = await this.playlistSummaries(ids.playlist.map((id) => playlistRows.find((r) => r.id === id)).filter(Boolean));
    const result = { tracks, artists, albums: ids.album.map((id) => albums.get(id)).filter(Boolean), playlists };
    const best = hits.find((h) => ids[h.kind]);
    result.top = best ? { kind: best.kind, item: (result[best.kind + 's'] || []).find((x) => x.id === best.ref_id) || null } : null;
    return result;
  }

  /** Fill in folded text for search rows written without it (by older versions). */
  async foldMissing() {
    const rows = await this.store.all("SELECT kind, ref_id, title, subtitle FROM search_index WHERE folded = ''");
    for (const r of rows) {
      // folded = '' again: a row rewritten in the meantime already has the newer text.
      await this.store.run("UPDATE search_index SET folded = ? WHERE kind = ? AND ref_id = ? AND folded = ''", [searchText(r.title, r.subtitle), r.kind, r.ref_id]);
    }
    return rows.length;
  }
}
