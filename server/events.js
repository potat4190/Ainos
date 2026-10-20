// Event delivery. Clients batch playback events and POST them; the server
// (1) appends them to hourly NDJSON files, mirroring Spotify's event delivery
// pipeline that lands events in hourly buckets for batch jobs, (2) stores them
// in SQLite for queries, and (3) derives "streams" (plays of 30 s or more).

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';
import { tx } from './db.js';

export const STREAM_THRESHOLD_MS = 30_000;
export const FREE_SKIPS_PER_HOUR = 6;
const TYPES = new Set(['play_start', 'play_end', 'pause', 'resume', 'seek', 'error', 'latency', 'prefetch', 'cache_hit', 'transfer']);
const REASONS = new Set(['trackdone', 'fwdbtn', 'backbtn', 'clickrow', 'endplay', 'remote', 'logout', 'appload', 'trackerror', 'playbtn', 'transfer', 'unknown']);

const clean = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(Math.round(v), 24 * 3600 * 1000)) : null);

export class EventPipeline {
  constructor(db, dataDir, { onStreams } = {}) {
    this.db = db;
    this.dir = path.join(dataDir, 'events');
    fs.mkdirSync(this.dir, { recursive: true });
    this.onStreams = onStreams || (() => {});
    this.insEvent = db.prepare(`INSERT INTO events (user_id, device_id, type, track_id, ms_played, position_ms, reason, context_uri, client_ts, server_ts, payload)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insStream = db.prepare('INSERT INTO streams (user_id, track_id, ms_played, context_uri, ended_at) VALUES (?, ?, ?, ?, ?)');
    this.trackExists = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
  }

  ingest(user, body) {
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) throw new HttpError(400, 'Expected { events: [...] }');
    if (events.length > 200) throw new HttpError(413, 'Too many events in one batch (max 200)');
    const now = Date.now();
    const accepted = [];
    for (const e of events) {
      if (!e || typeof e !== 'object' || !TYPES.has(e.type)) continue;
      const trackId = clean(e.track_id, 40);
      if (trackId && !this.trackExists.get(trackId)) continue;
      const reason = REASONS.has(e.reason) ? e.reason : e.reason == null ? null : 'unknown';
      const extra = e.data && typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 2000) : null;
      accepted.push({
        user_id: user.id, device_id: clean(e.device_id, 64) || 'unknown', type: e.type, track_id: trackId,
        ms_played: int(e.ms_played), position_ms: int(e.position_ms), reason, context_uri: clean(e.context_uri, 120),
        client_ts: int(e.ts) ?? null, server_ts: now, payload: extra,
      });
    }
    let streams = 0;
    tx(this.db, () => {
      for (const a of accepted) {
        this.insEvent.run(a.user_id, a.device_id, a.type, a.track_id, a.ms_played, a.position_ms, a.reason, a.context_uri, a.client_ts, a.server_ts, a.payload);
        if (a.type === 'play_end' && a.track_id && a.ms_played >= STREAM_THRESHOLD_MS) {
          this.insStream.run(a.user_id, a.track_id, a.ms_played, a.context_uri, now);
          streams++;
        }
      }
    });
    if (accepted.length) {
      const hour = new Date(now).toISOString().slice(0, 13); // 2026-10-20T14
      fs.appendFile(path.join(this.dir, `${hour}.ndjson`), accepted.map((a) => JSON.stringify(a)).join('\n') + '\n', () => {});
    }
    if (streams) this.onStreams(streams);
    return { accepted: accepted.length, rejected: events.length - accepted.length, streams_counted: streams };
  }

  /** Forward-button skips in the last hour (free tier limit). */
  skipsLastHour(userId) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'play_end' AND reason = 'fwdbtn' AND server_ts > ?")
      .get(userId, Date.now() - 3600_000).n;
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const byType = this.db.prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC').all();
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson')).sort().slice(-5);
    const latency = this.db
      .prepare("SELECT payload FROM events WHERE type = 'latency' ORDER BY id DESC LIMIT 200")
      .all()
      .map((r) => { try { return JSON.parse(r.payload); } catch { return null; } })
      .filter((p) => p && Number.isFinite(p.ms));
    const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    return {
      total, by_type: byType, hourly_files: files,
      latency_ms: {
        samples: latency.length,
        median_all: median(latency.map((l) => l.ms)),
        median_prefetched: median(latency.filter((l) => l.prefetched).map((l) => l.ms)),
        median_cold: median(latency.filter((l) => !l.prefetched).map((l) => l.ms)),
      },
    };
  }
}
