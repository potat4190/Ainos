import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
  is_simulated  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  genre  TEXT NOT NULL,
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, title, subtitle,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
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
