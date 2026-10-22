# Ainos — Christian Worship & Praise Music Streaming

A Christian faith-based music streaming app dedicated to Christian worship, praise, and devotional songs. Named after the Greek word *αἶνος* (*ainos*, meaning praise to God), it is built with full streaming architecture under the hood: chunked streaming with signed URLs, next-track prefetching, loudness normalization, a client-side cache, an event pipeline with the 30-second stream rule, language-aware collaborative-filtering recommendations (Discover Weekly, Daily Mixes, Praise Radio), and Connect-style control of one device from another.

## Key Features

- **Christian Worship & Devotional Focus**: Every artist, album, and track in the catalog is curated around Christian worship, sanctuary devotion, and praise.
- **Multi-Language Selector & Recommendations**: Switch seamlessly between **English (`en`)**, **Hindi (`hi`)**, **Nepali (`ne`)**, **Chinese (`zh`)**, **Japanese (`ja`)**, and **Spanish (`es`)** from the top bar or Settings. Switching languages immediately translates the UI text and updates Home recommendations, Discover Weekly, Daily Worship Mixes, Popular Worship Songs, and Praise Radio to recommend Christian songs in that language.
- **Unified All-Access Worship Plan**: No Free vs. Premium tier restrictions — every worshipper gets the single All-Access plan with **High (353 kbps lossless-grade PCM)** streaming quality, **unlimited skips**, **offline sanctuary downloads**, and **multi-device Connect** unlocked out of the box.

**How the streaming architecture works, with evidence:** [`docs/HOW-SPOTIFY-WORKS.md`](docs/HOW-SPOTIFY-WORKS.md). You can also read it inside the app under *Under the hood → Read the full evidence report*.

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
| `npm test` | Automated test suite: streaming, auth, events, playlists, search, multi-language recommendations, Connect, loudness meter, security |

To use Connect from your phone, start with `HOST=0.0.0.0 npm start` (PowerShell: `$env:HOST="0.0.0.0"; npm start`), open the printed network address, and log in with the same account.

## What to try

1. **Switch languages** using the language selector in the top bar (**English**, **हिन्दी (Hindi)**, **नेपाली (Nepali)**, **中文 (Chinese)**, **日本語 (Japanese)**, **Español (Spanish)**). Watch the interface localize and the Home screen recommend Christian worship songs in the selected language.
2. **Play anything** and open the *Now playing* panel (right). It shows the quality (up to High 353 kbps), the track's measured loudness and the gain applied, the start latency, and a countdown to when the play counts as a stream.
3. **Let a track run into its last 30 seconds.** The next track preloads on a second audio deck. Under the hood shows the prefetched start latency (a few ms) next to the cold start (tens of ms).
4. **Open a second tab** (or a phone) and click the devices icon. The second tab shows what the first is playing and can control it. Pick "This browser" to move playback over at the same position.
5. **Download an album**, stop the server, and keep playing it in the already-open page. The service worker serves it from cache.
6. **Under the hood** shows live internals: deck states, latency, stutters, the cache, the event pipeline, recommender stats with a *Retrain now* button, and a streaming architecture mapping table that links to the evidence.

## How it's built

```
server/
  index.js       entry point (generates the catalog on first run)
  app.js         HTTP API + static/media serving, security headers, routing
  http.js        tiny router, JSON helpers, HTTP Range file serving
  db.js          SQLite schema (node:sqlite) + in-place migrations + FTS5 search index
  auth.js        scrypt passwords, sessions, rate limiting, HMAC-signed media URLs
  catalog.js     read models (tracks, albums, artists, playlists, language filtering, search)
  events.js      event ingestion → SQLite + hourly NDJSON buckets; 30-second rule
  recommend.js   implicit ALS + co-listening + audio features + language filtering; Discover Weekly, Daily Mix, Radio
  connect.js     multi-device hub over Server-Sent Events (state, commands, transfer)
  loudness.js    ITU-R BS.1770-4 integrated loudness + normalization gain
scripts/
  generate.js    builds the Christian worship catalog across 6 languages, synthesizes audio, measures loudness, seeds users
  synth.js       procedural music synthesizer (8 styles) + WAV encoder
  art.js         generated SVG cover art
public/
  index.html, css/app.css
  js/i18n.js     translations & localization helpers (en, hi, ne, zh, ja, es)
  js/player.js   playback engine: two decks, prefetch, normalization, queue, events
  js/connect.js  device identity + push channel
  js/views.js    pages; js/app.js shell, router, panels; js/ui.js DOM helpers
  sw.js          service worker: app shell, LRU audio cache, offline downloads
docs/HOW-SPOTIFY-WORKS.md   the evidence report
test/            node:test suites
```

**About the music.** The catalog has 33 original Christian worship & devotional tracks across 8 artists spanning English, Hindi, Nepali, Chinese, Japanese, and Spanish, synthesized from code at setup time. That keeps the app free of copyrighted audio and external dependencies. Masters are mixed at deliberately different loudness levels (−9 to −19 LUFS), so normalization has something to fix. To use your own audio, add rows to `tracks`/`track_files` pointing at 16-bit PCM WAV files at `data/media/high/<track id>.wav` and `data/media/low/<track id>.wav`.

**Scale caveats.** SQLite, in-process recommendations and SSE fan-out are right for one machine. At global scale each piece becomes a service: a CDN for media, Pub/Sub plus Dataflow for events, Voyager/Annoy indexes for nearest-neighbour search, and a stateful connect-state service. The evidence report covers where Ainos deliberately differs.
