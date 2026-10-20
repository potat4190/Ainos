# Ainos

A Spotify-style music streaming app, built to work the way Spotify works under the hood. It covers chunked streaming with signed URLs, next-track prefetching, loudness normalization, a client-side cache, an event pipeline with the 30-second stream rule, collaborative-filtering recommendations (Discover Weekly, Daily Mixes, Radio) and Connect-style control of one device from another.

**How Spotify works, with evidence:** [`docs/HOW-SPOTIFY-WORKS.md`](docs/HOW-SPOTIFY-WORKS.md). You can also read it inside the app under *Under the hood → Read the full evidence report*.

## Run it

Requires **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`). There are **no dependencies** to install.

```bash
npm start          # first run generates the catalog (~15 s), then serves http://127.0.0.1:4321
```

Log in with **demo / ainos-demo**, or sign up for a new account.

| Command | What it does |
|---|---|
| `npm start` | Start the server (`PORT`, `HOST` env vars; default `127.0.0.1:4321`) |
| `npm run dev` | Same, restarting on file changes |
| `npm run setup` | Regenerate the catalog from scratch (wipes `data/`) |
| `npm test` | 32 tests: streaming, auth, events, playlists, search, recommendations, Connect, loudness meter, security |

To use Connect from your phone, start with `HOST=0.0.0.0 npm start` (PowerShell: `$env:HOST="0.0.0.0"; npm start`), open the printed network address, and log in with the same account.

## What to try

1. **Play anything** and open the *Now playing* panel (right). It shows the quality, the track's measured loudness and the gain applied, the start latency, and a countdown to when the play counts as a stream.
2. **Let a track run into its last 30 seconds.** The next track preloads on a second audio deck. Under the hood shows the prefetched start latency (a few ms) next to the cold start (tens of ms).
3. **Open a second tab** (or a phone) and click the devices icon. The second tab shows what the first is playing and can control it. Pick "This browser" to move playback over at the same position.
4. **Settings → Switch to Free.** Quality drops to Low and you get 6 skips per hour.
5. **Download an album**, stop the server, and keep playing it in the already-open page. The service worker serves it from cache.
6. **Under the hood** shows live internals: deck states, latency, stutters, the cache, the event pipeline, recommender stats with a *Retrain now* button, and a Spotify → Ainos mapping table that links to the evidence.

## How it's built

```
server/
  index.js       entry point (generates the catalog on first run)
  app.js         HTTP API + static/media serving, security headers, routing
  http.js        tiny router, JSON helpers, HTTP Range file serving
  db.js          SQLite schema (node:sqlite) incl. an FTS5 search index
  auth.js        scrypt passwords, sessions, rate limiting, HMAC-signed media URLs
  catalog.js     read models (tracks, albums, artists, playlists, search)
  events.js      event ingestion → SQLite + hourly NDJSON buckets; 30-second rule
  recommend.js   implicit ALS + co-listening + audio features; Discover Weekly, Daily Mix, Radio
  connect.js     multi-device hub over Server-Sent Events (state, commands, transfer)
  loudness.js    ITU-R BS.1770-4 integrated loudness + normalization gain
scripts/
  generate.js    builds the catalog: synthesizes audio, measures loudness, seeds users
  synth.js       procedural music synthesizer (8 styles) + WAV encoder
  art.js         generated SVG cover art
public/
  index.html, css/app.css
  js/player.js   playback engine: two decks, prefetch, normalization, queue, events
  js/connect.js  device identity + push channel
  js/views.js    pages; js/app.js shell, router, panels; js/ui.js DOM helpers
  sw.js          service worker: app shell, LRU audio cache, offline downloads
docs/HOW-SPOTIFY-WORKS.md   the evidence report
test/            node:test suites
```

**About the music.** The catalog has 33 original instrumental tracks by 8 fictional artists, synthesized from code at setup time. That keeps the app free of copyrighted audio and dependencies. Masters are mixed at deliberately different loudness levels (−9 to −19 LUFS), so normalization has something to fix. To use your own audio, add rows to `tracks`/`track_files` pointing at 16-bit PCM WAV files under `data/media/`.

**Scale caveats.** SQLite, in-process recommendations and SSE fan-out are right for one machine. At Spotify scale each piece becomes a service: a CDN for media, Pub/Sub plus Dataflow for events, Voyager/Annoy indexes for nearest-neighbour search, and a stateful connect-state service. The evidence report covers where Ainos deliberately differs.
