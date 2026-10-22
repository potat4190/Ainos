// Event delivery. Clients batch playback events and POST them; the server
// (1) appends them to hourly NDJSON files, mirroring Spotify's event delivery
// pipeline that lands events in hourly buckets for batch jobs, (2) stores them
// in the database for queries, and (3) derives "streams" (plays of 30 s or more).
// The NDJSON files need a writable disk, so they are skipped when no logDir is
// given (e.g. on serverless hosts).

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';
import { inList } from './store.js';

export const STREAM_THRESHOLD_MS = 30_000;
const TYPES = new Set(['play_start', 'play_end', 'pause', 'resume', 'seek', 'error', 'latency', 'prefetch', 'cache_hit', 'transfer']);
const REASONS = new Set(['trackdone', 'fwdbtn', 'backbtn', 'clickrow', 'endplay', 'remote', 'logout', 'appload', 'trackerror', 'playbtn', 'transfer', 'unknown']);

const clean = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(Math.round(v), 24 * 3600 * 1000)) : null);
// Client clock (epoch ms). Must not go through int(), which caps durations at 24 h.
const epochMs = (v) => (Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : null);

export class EventPipeline {
  /** @param {import('./store.js').Store} store */
  constructor(store, logDir, { onStreams } = {}) {
    this.store = store;
    this.dir = logDir || null;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
    this.onStreams = onStreams || (() => {});
  }

  async ingest(user, body) {
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) throw new HttpError(400, 'Expected { events: [...] }');
    if (events.length > 200) throw new HttpError(413, 'Too many events in one batch (max 200)');
    const now = Date.now();
    const accepted = [];
    // One lookup for every track id in the batch, instead of one per event.
    const ids = [...new Set(events.map((e) => clean(e?.track_id, 40)).filter(Boolean))];
    const known = new Set(ids.length ? (await this.store.all(`SELECT id FROM tracks WHERE id IN (${inList(ids)})`, ids)).map((r) => r.id) : []);
    for (const e of events) {
      if (!e || typeof e !== 'object' || !TYPES.has(e.type)) continue;
      const trackId = clean(e.track_id, 40);
      if (trackId && !known.has(trackId)) continue;
      const reason = REASONS.has(e.reason) ? e.reason : e.reason == null ? null : 'unknown';
      const extra = e.data && typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 2000) : null;
      accepted.push({
        user_id: user.id, device_id: clean(e.device_id, 64) || 'unknown', type: e.type, track_id: trackId,
        ms_played: int(e.ms_played), position_ms: int(e.position_ms), reason, context_uri: clean(e.context_uri, 120),
        client_ts: epochMs(e.ts), server_ts: now, payload: extra,
      });
    }
    const plays = accepted.filter((a) => a.type === 'play_end' && a.track_id && a.ms_played >= STREAM_THRESHOLD_MS);
    if (accepted.length) {
      // Multi-row inserts: one round trip per table, which matters on a remote database.
      await this.store.tx(async (t) => {
        await t.run(`INSERT INTO events (user_id, device_id, type, track_id, ms_played, position_ms, reason, context_uri, client_ts, server_ts, payload)
                     VALUES ${accepted.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        accepted.flatMap((a) => [a.user_id, a.device_id, a.type, a.track_id, a.ms_played, a.position_ms, a.reason, a.context_uri, a.client_ts, a.server_ts, a.payload]));
        if (plays.length) {
          await t.run(`INSERT INTO streams (user_id, track_id, ms_played, context_uri, ended_at) VALUES ${plays.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            plays.flatMap((a) => [a.user_id, a.track_id, a.ms_played, a.context_uri, now]));
        }
      });
    }
    const streams = plays.length;
    if (accepted.length && this.dir) {
      const hour = new Date(now).toISOString().slice(0, 13); // 2026-10-20T14
      fs.appendFile(path.join(this.dir, `${hour}.ndjson`), accepted.map((a) => JSON.stringify(a)).join('\n') + '\n', () => {});
    }
    if (streams) this.onStreams(streams);
    return { accepted: accepted.length, rejected: events.length - accepted.length, streams_counted: streams };
  }

  async stats() {
    const [totalRow, byType, latencyRows] = await Promise.all([
      this.store.get('SELECT COUNT(*) AS n FROM events'),
      this.store.all('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC'),
      this.store.all("SELECT payload FROM events WHERE type = 'latency' ORDER BY id DESC LIMIT 200"),
    ]);
    const total = totalRow.n;
    const files = this.dir ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson')).sort().slice(-5) : [];
    const latency = latencyRows
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
