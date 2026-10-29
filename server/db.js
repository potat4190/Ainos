import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  language      TEXT NOT NULL DEFAULT 'en',  -- UI language + which songs get recommended
  is_simulated  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS artists (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  genre  TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  bio    TEXT NOT NULL DEFAULT '',
  image  TEXT NOT NULL,
  color  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id        TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  title     TEXT NOT NULL,
  year      INTEGER NOT NULL,
  type      TEXT NOT NULL DEFAULT 'album',
  cover     TEXT NOT NULL,
  color     TEXT NOT NULL,
  released_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id            TEXT PRIMARY KEY,
  album_id      TEXT NOT NULL REFERENCES albums(id),
  artist_id     TEXT NOT NULL REFERENCES artists(id),
  title         TEXT NOT NULL,
  track_no      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  genre         TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT 'en',  -- language the song is sung in (ISO 639-1)
  -- one row per encoded file lives in track_files; these are analysis results
  loudness_lufs REAL NOT NULL,
  peak_db       REAL NOT NULL,
  tempo         REAL NOT NULL,
  key           INTEGER NOT NULL,
  mode          INTEGER NOT NULL,
  energy        REAL NOT NULL,
  valence       REAL NOT NULL,
  danceability  REAL NOT NULL,
  acousticness  REAL NOT NULL,
  instrumentalness REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id, track_no);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_id);

CREATE TABLE IF NOT EXISTS track_files (
  track_id    TEXT NOT NULL REFERENCES tracks(id),
  quality     TEXT NOT NULL,          -- 'low' | 'high'
  file        TEXT NOT NULL,          -- path under data/media
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sample_rate INTEGER NOT NULL,
  bitrate_kbps INTEGER NOT NULL,
  header_bytes INTEGER NOT NULL,
  PRIMARY KEY (track_id, quality)
);

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = editorial
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#5b4bdb',
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlists_owner ON playlists(owner_id);

-- Positions are not declared unique here: SQLite checks uniqueness row by row
-- during an UPDATE, which would reject reorders. Transactions run one at a
-- time on SQLite (store.js), so two edits cannot pick the same position.
CREATE TABLE IF NOT EXISTS playlist_tracks (
  id          INTEGER PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id),
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_tracks_pos ON playlist_tracks(playlist_id, position);

CREATE TABLE IF NOT EXISTS liked_tracks (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS followed_artists (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_id)
);

-- Raw client events (the "event delivery" firehose).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  device_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  track_id    TEXT,
  ms_played   INTEGER,
  position_ms INTEGER,
  reason      TEXT,
  context_uri TEXT,
  client_ts   INTEGER,
  server_ts   INTEGER NOT NULL,
  payload     TEXT
);
CREATE INDEX IF NOT EXISTS events_user_ts ON events(user_id, server_ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type, id);

-- Derived: a "stream" is a play of 30 seconds or more.
CREATE TABLE IF NOT EXISTS streams (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id  TEXT NOT NULL REFERENCES tracks(id),
  ms_played INTEGER NOT NULL,
  context_uri TEXT,
  ended_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS streams_user ON streams(user_id, ended_at);
CREATE INDEX IF NOT EXISTS streams_track ON streams(track_id, ended_at);

-- Personalized playlists are snapshotted per period (week/day) so they stay stable.
CREATE TABLE IF NOT EXISTS generated_playlists (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  period     TEXT NOT NULL,
  title      TEXT NOT NULL,
  description TEXT NOT NULL,
  track_ids  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, period)
);

-- Search documents (tracks, artists, albums, public playlists). Ranking is done
-- in the app (catalog.js), so the same code works on SQLite and Postgres.
-- folded = searchText(title, subtitle) (util.js); '' until it is filled in.
CREATE TABLE IF NOT EXISTS search_index (
  kind     TEXT NOT NULL,
  ref_id   TEXT NOT NULL,
  title    TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  folded   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, ref_id)
);

-- Fixed-window rate limits (auth.js), shared by every server process.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL
);

-- Who did what to a church's data (audit.js). No foreign keys: rows outlive
-- the users and orgs they mention (account deletion, Phase 5, will anonymize them).
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_org ON audit_log(org_id, created_at);

-- Songs: what is sung (title, lyrics), separate from the recordings that play
-- it (song_sources). org_id NULL = global catalog; otherwise private to that
-- church (orgs arrive in Phase 5, so org_id has no foreign key; checked in code).
CREATE TABLE IF NOT EXISTS songs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,
  language      TEXT NOT NULL,
  ccli_number   TEXT,
  public_domain INTEGER NOT NULL DEFAULT 0,
  org_id        TEXT,
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_org ON songs(org_id);
CREATE INDEX IF NOT EXISTS songs_language ON songs(language);

-- Other titles, transliterations and translations a song is searched by.
CREATE TABLE IF NOT EXISTS song_aliases (
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  alias   TEXT NOT NULL,
  folded  TEXT NOT NULL,
  PRIMARY KEY (song_id, folded)
);

-- Theme and season tags, from the closed list in songs.js.
CREATE TABLE IF NOT EXISTS song_themes (
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  theme   TEXT NOT NULL,
  PRIMARY KEY (song_id, theme)
);
CREATE INDEX IF NOT EXISTS song_themes_theme ON song_themes(theme);

-- How to play a song: a native track or a YouTube video, exactly one of them.
CREATE TABLE IF NOT EXISTS song_sources (
  id               TEXT PRIMARY KEY,
  song_id          TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('ainos', 'youtube')),
  track_id         TEXT REFERENCES tracks(id),
  youtube_video_id TEXT,
  kind             TEXT,
  available        INTEGER NOT NULL DEFAULT 1,
  last_checked_at  INTEGER,
  CHECK ((source = 'ainos' AND track_id IS NOT NULL AND youtube_video_id IS NULL) OR (source = 'youtube' AND youtube_video_id IS NOT NULL AND track_id IS NULL))
);
CREATE INDEX IF NOT EXISTS song_sources_song ON song_sources(song_id);
CREATE INDEX IF NOT EXISTS song_sources_track ON song_sources(track_id);
CREATE UNIQUE INDEX IF NOT EXISTS song_sources_youtube ON song_sources(youtube_video_id);

-- Lyrics, once per section per language; lines are newline-separated.
-- folded = searchText(lines) for lyric search. Church-pasted lyrics carry
-- their org_id. UNIQUE treats NULLs as distinct, so global rows get their own
-- partial unique index.
CREATE TABLE IF NOT EXISTS song_sections (
  id       TEXT PRIMARY KEY,
  song_id  TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  label    TEXT NOT NULL,
  lines    TEXT NOT NULL,
  folded   TEXT NOT NULL DEFAULT '',
  org_id   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS song_sections_org ON song_sections(song_id, language, label, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS song_sections_global ON song_sections(song_id, language, label) WHERE org_id IS NULL;

-- The order sections are sung in, e.g. ["V1","C","V2","C"] (JSON).
CREATE TABLE IF NOT EXISTS song_arrangements (
  id            TEXT PRIMARY KEY,
  song_id       TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  org_id        TEXT,
  name          TEXT NOT NULL,
  section_order TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS song_arrangements_song ON song_arrangements(song_id);
`;

// Language tags for the artists of the original (pre-language) seed catalog,
// used once to upgrade databases created before songs had a language.
const LEGACY_ARTIST_LANGUAGES = {
  'Lumen Drift': 'en', 'Juniper Lane': 'en', 'Neon Harbor': 'en',
  'Copper Fox': 'hi', 'Ossa': 'ne', 'Velvet Static': 'zh', 'Kite Theory': 'ja', 'Polar Bloom': 'es',
};

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** Bring databases created by older versions up to the current schema. */
function migrate(db) {
  const users = columns(db, 'users');
  if (!users.includes('language')) db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
  // There is a single plan now; the old free/premium column is gone.
  if (users.includes('plan')) db.exec('ALTER TABLE users DROP COLUMN plan');

  if (!columns(db, 'artists').includes('language')) {
    db.exec("ALTER TABLE artists ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
    const set = db.prepare('UPDATE artists SET language = ? WHERE name = ?');
    for (const [name, lang] of Object.entries(LEGACY_ARTIST_LANGUAGES)) set.run(lang, name);
  }
  if (!columns(db, 'tracks').includes('language')) {
    db.exec("ALTER TABLE tracks ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
    db.exec('UPDATE tracks SET language = (SELECT a.language FROM artists a WHERE a.id = tracks.artist_id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS tracks_language ON tracks(language)');

  // Search used to live in an FTS5 table; move its rows into search_index.
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'").get();
  if (hasFts) {
    db.exec("INSERT OR IGNORE INTO search_index (kind, ref_id, title, subtitle) SELECT kind, ref_id, title, COALESCE(subtitle, '') FROM search_fts");
    db.exec('DROP TABLE search_fts');
  }
  // The app fills in folded for these rows when it starts (Catalog.foldMissing).
  if (!columns(db, 'search_index').includes('folded')) db.exec("ALTER TABLE search_index ADD COLUMN folded TEXT NOT NULL DEFAULT ''");
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
