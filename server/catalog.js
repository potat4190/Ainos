// Read models for the catalog. Shapes are loosely modelled on the Spotify Web
// API (id + uri + nested simplified artist/album objects).
import { toUri } from './util.js';
import { stmt } from './db.js';

const TRACK_SELECT = `
  SELECT t.id, t.title, t.track_no, t.duration_ms, t.genre, t.language, t.tempo, t.key, t.mode,
         t.energy, t.valence, t.danceability, t.acousticness, t.loudness_lufs,
         a.id AS artist_id, a.name AS artist_name,
         al.id AS album_id, al.title AS album_title, al.cover AS album_cover, al.color AS album_color
  FROM tracks t
  JOIN artists a ON a.id = t.artist_id
  JOIN albums al ON al.id = t.album_id`;

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

export class Catalog {
  constructor(db) {
    this.db = db;
  }

  tracksByIds(ids) {
    if (!ids.length) return [];
    const rows = this.db.prepare(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const byId = new Map(rows.map((r) => [r.id, trackDto(r)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  track(id) {
    const r = this.db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id);
    return r ? trackDto(r) : null;
  }

  allTracks() {
    return this.db.prepare(`${TRACK_SELECT} ORDER BY a.name, al.year, t.track_no`).all().map(trackDto);
  }

  albumSummary(r) {
    return { id: r.id, uri: toUri('album', r.id), title: r.title, year: r.year, type: r.type, cover: '/' + r.cover, color: r.color, released_at: r.released_at, language: r.artist_language, artist: { id: r.artist_id, name: r.artist_name } };
  }

  album(id) {
    const r = this.db.prepare('SELECT al.*, a.name AS artist_name, a.language AS artist_language FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.id = ?').get(id);
    if (!r) return null;
    const tracks = this.db.prepare(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.track_no`).all(id).map(trackDto);
    return { ...this.albumSummary(r), tracks, duration_ms: tracks.reduce((s, t) => s + t.duration_ms, 0) };
  }

  albums({ newest = false, limit = 50, language = null } = {}) {
    // `a.language = NULL` is NULL for every row, so no language keeps the plain order.
    return this.db
      .prepare(`SELECT al.*, a.name AS artist_name, a.language AS artist_language FROM albums al JOIN artists a ON a.id = al.artist_id ORDER BY a.language = ? DESC, ${newest ? 'al.released_at DESC' : 'a.name, al.year'} LIMIT ?`)
      .all(language, limit)
      .map((r) => this.albumSummary(r));
  }

  artistSummary(r) {
    return { id: r.id, uri: toUri('artist', r.id), name: r.name, genre: r.genre, language: r.language, image: '/' + r.image, color: r.color };
  }

  artists({ language = null } = {}) {
    return this.db.prepare('SELECT * FROM artists ORDER BY language = ? DESC, name').all(language).map((r) => this.artistSummary(r));
  }

  artistsByIds(ids) {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM artists WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const byId = new Map(rows.map((r) => [r.id, this.artistSummary(r)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  artist(id) {
    const r = this.db.prepare('SELECT * FROM artists WHERE id = ?').get(id);
    if (!r) return null;
    // Count plays for this artist's tracks only (not an aggregate over the whole streams table).
    const plays = this.db.prepare('SELECT track_id, COUNT(*) AS n FROM streams WHERE track_id IN (SELECT id FROM tracks WHERE artist_id = ?) GROUP BY track_id').all(id);
    const playMap = new Map(plays.map((p) => [p.track_id, p.n]));
    const top = this.db
      .prepare(`${TRACK_SELECT} WHERE t.artist_id = ?`)
      .all(id)
      .sort((x, y) => (playMap.get(y.id) || 0) - (playMap.get(x.id) || 0))
      .slice(0, 5);
    const monthly = this.db
      .prepare('SELECT COUNT(DISTINCT s.user_id) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE t.artist_id = ? AND s.ended_at > ?')
      .get(id, Date.now() - 28 * 86400000).n;
    const albums = this.db.prepare('SELECT al.*, a.name AS artist_name, a.language AS artist_language FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.artist_id = ? ORDER BY al.released_at DESC').all(id).map((x) => this.albumSummary(x));
    return {
      ...this.artistSummary(r),
      bio: r.bio,
      monthly_listeners: monthly,
      top_tracks: top.map((t) => ({ ...trackDto(t), plays: playMap.get(t.id) || 0 })),
      albums,
    };
  }

  playlistSummary(r) {
    // Called once per playlist in every list (home, library, search): reuse compiled statements.
    const covers = stmt(this.db, 'SELECT DISTINCT al.cover FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? ORDER BY pt.position LIMIT 4')
      .all(r.id)
      .map((c) => '/' + c.cover);
    const count = stmt(this.db, 'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?').get(r.id).n;
    return {
      id: r.id, uri: toUri('playlist', r.id), name: r.name, description: r.description, color: r.color,
      owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : { id: null, name: 'Ainos' },
      editorial: r.owner_id == null, is_public: !!r.is_public, covers, track_count: count, updated_at: r.updated_at,
    };
  }

  playlistRow(id) {
    return this.db.prepare('SELECT p.*, u.display_name AS owner_name FROM playlists p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?').get(id);
  }

  playlist(id) {
    const r = this.playlistRow(id);
    if (!r) return null;
    const rows = this.db.prepare(`SELECT pt.position, pt.added_at, x.* FROM playlist_tracks pt JOIN (${TRACK_SELECT}) x ON x.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`).all(id);
    const tracks = rows.map((row) => ({ ...trackDto(row), position: row.position, added_at: row.added_at }));
    return { ...this.playlistSummary(r), tracks, duration_ms: tracks.reduce((s, t) => s + t.duration_ms, 0) };
  }

  editorialPlaylists() {
    return this.db.prepare('SELECT p.*, NULL AS owner_name FROM playlists p WHERE owner_id IS NULL ORDER BY name').all().map((r) => this.playlistSummary(r));
  }

  userPlaylists(userId) {
    return this.db
      .prepare('SELECT p.*, u.display_name AS owner_name FROM playlists p JOIN users u ON u.id = p.owner_id WHERE p.owner_id = ? ORDER BY p.updated_at DESC')
      .all(userId)
      .map((r) => this.playlistSummary(r));
  }

  genres() {
    return this.db
      .prepare(`SELECT a.genre, MIN(a.color) AS color, COUNT(t.id) AS tracks FROM artists a JOIN tracks t ON t.artist_id = a.id GROUP BY a.genre ORDER BY a.genre`)
      .all();
  }

  genre(name) {
    const tracks = this.db.prepare(`${TRACK_SELECT} WHERE t.genre = ? ORDER BY a.name, t.track_no`).all(name).map(trackDto);
    const artists = this.db.prepare('SELECT * FROM artists WHERE genre = ?').all(name).map((r) => this.artistSummary(r));
    return { name, tracks, artists };
  }

  /** Most-streamed tracks in a recent window, prioritizing the requested language. */
  popular(days = 7, limit = 10, language = null) {
    if (language) {
      const langRows = this.db
        .prepare('SELECT s.track_id, COUNT(*) AS n FROM streams s JOIN tracks t ON t.id = s.track_id WHERE s.ended_at > ? AND t.language = ? GROUP BY s.track_id ORDER BY n DESC LIMIT ?')
        .all(Date.now() - days * 86400000, language, limit);
      if (langRows.length < limit) {
        const have = new Set(langRows.map((r) => r.track_id));
        const extra = this.db.prepare('SELECT id FROM tracks WHERE language = ? ORDER BY track_no').all(language);
        for (const e of extra) {
          if (langRows.length >= limit) break;
          if (!have.has(e.id)) { langRows.push({ track_id: e.id, n: 0 }); have.add(e.id); }
        }
      }
      if (langRows.length) {
        const tracks = this.tracksByIds(langRows.map((r) => r.track_id));
        return tracks.map((t, i) => ({ ...t, plays: langRows[i].n }));
      }
    }
    const rows = this.db
      .prepare('SELECT track_id, COUNT(*) AS n FROM streams WHERE ended_at > ? GROUP BY track_id ORDER BY n DESC LIMIT ?')
      .all(Date.now() - days * 86400000, limit);
    const tracks = this.tracksByIds(rows.map((r) => r.track_id));
    return tracks.map((t, i) => ({ ...t, plays: rows[i].n }));
  }

  tracksByLanguage(language, limit = 20) {
    return this.db.prepare(`${TRACK_SELECT} WHERE t.language = ? ORDER BY a.name, al.year, t.track_no LIMIT ?`).all(language, limit).map(trackDto);
  }

  /** Full-text search via SQLite FTS5 (prefix matching, BM25 ranking). */
  search(q, limit = 8) {
    const terms = (q.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
    if (!terms.length) return { tracks: [], artists: [], albums: [], playlists: [], top: null };
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
    const rows = this.db
      .prepare('SELECT kind, ref_id, bm25(search_fts, 0, 0, 10.0, 2.0) AS rank FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT 80')
      .all(match);
    const ids = { track: [], artist: [], album: [], playlist: [] };
    for (const r of rows) if (ids[r.kind].length < limit) ids[r.kind].push(r.ref_id);
    const albums = ids.album.length
      ? this.db.prepare(`SELECT al.*, a.name AS artist_name, a.language AS artist_language FROM albums al JOIN artists a ON a.id = al.artist_id WHERE al.id IN (${ids.album.map(() => '?').join(',')})`).all(...ids.album).map((r) => this.albumSummary(r))
      : [];
    const playlists = ids.playlist.map((id) => this.playlistRow(id)).filter((r) => r && r.is_public).map((r) => this.playlistSummary(r));
    const result = {
      tracks: this.tracksByIds(ids.track),
      artists: this.artistsByIds(ids.artist),
      albums: ids.album.map((id) => albums.find((a) => a.id === id)).filter(Boolean),
      playlists,
    };
    const best = rows[0];
    result.top = best ? { kind: best.kind, item: (result[best.kind + 's'] || []).find((x) => x.id === best.ref_id) || null } : null;
    return result;
  }
}
