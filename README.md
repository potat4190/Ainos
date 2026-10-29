# Ainos — Christian Worship & Praise Music Streaming

A Christian faith-based music streaming app dedicated to Christian worship, praise, and devotional songs. Named after the Greek word *αἶνος* (*ainos*, meaning praise to God), it is built with full streaming architecture under the hood: chunked streaming with signed URLs, next-track prefetching, loudness normalization, a client-side cache, an event pipeline with the 30-second stream rule, language-aware collaborative-filtering recommendations (Discover Weekly, Daily Mixes, Praise Radio), and Connect-style control of one device from another.

## Key Features

- **Christian Worship & Devotional Focus**: Every artist, album, and track in the catalog is curated around Christian worship, sanctuary devotion, and praise.
- **Multi-Language Selector & Recommendations**: Switch seamlessly between **English (`en`)**, **Hindi (`hi`)**, **Nepali (`ne`)**, **Chinese (`zh`)**, **Japanese (`ja`)**, and **Spanish (`es`)** from the top bar or Settings. Switching languages immediately translates the UI text and updates Home recommendations, Discover Weekly, Daily Worship Mixes, Popular Worship Songs, and Praise Radio to recommend Christian songs in that language.
- **Unified All-Access Worship Plan**: No Free vs. Premium tier restrictions — every worshipper gets the single All-Access plan with **High (353 kbps lossless-grade PCM)** streaming quality, **unlimited skips**, **offline sanctuary downloads**, and **multi-device Connect** unlocked out of the box.

**How the streaming architecture works, with evidence:** [`docs/HOW-SPOTIFY-WORKS.md`](docs/HOW-SPOTIFY-WORKS.md). You can also read it inside the app under *Under the hood → Read the full evidence report*.

## Run it

Requires **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`). Running locally needs no `npm install`: the two packages in `package.json` (`pg`, `@vercel/functions`) are only used by the hosted deployment.

```bash
npm start          # first run generates the catalog (~15 s), then serves http://127.0.0.1:4321
```

Click **Try the demo**, or sign up for a new account.

### Try the demo

The button signs you in to one shared account, `demo`, through `POST /api/auth/demo` (the password never reaches the browser). Each demo sign-in first resets that account to a fixed snapshot (`server/demo.js`): two playlists, six liked songs, three followed artists and about three weeks of listening, so Home, Made For You and Your Stats have something to show. Demo sign-ins are rate-limited per visitor and overall.

Because the account is shared, visitors can see each other's changes until the next reset, and a new visitor's reset changes what an earlier visitor sees mid-session. Nothing a visitor does reaches other accounts: demo playlists always stay private, so they never appear in search. The app shows a banner in the demo explaining this, with a link to sign up. (The account can still be reached with `demo` / `ainos-demo`, which does not reset it; the tests use that.)

| Command | What it does |
|---|---|
| `npm start` | Start the server (`PORT`, `HOST` env vars; default `127.0.0.1:4321`; `TRUST_PROXY=1` behind an HTTPS proxy or tunnel) |
| `npm run dev` | Same, restarting on file changes |
| `npm run setup` | Regenerate the catalog from scratch (wipes `data/`) |
| `npm test` | Automated test suite: streaming, auth, events, playlists, search, multi-language recommendations, Connect, loudness meter, security |

To use Connect from your phone, start with `HOST=0.0.0.0 npm start` (PowerShell: `$env:HOST="0.0.0.0"; npm start`), open the printed network address, and log in with the same account.

## Deploy (Vercel + Supabase)

Locally everything lives in SQLite under `data/`. In production the same code runs on Vercel with its data in Supabase Postgres:

- **Database:** `server/store.js` gives the app one async query interface. Without `DATABASE_URL` it uses SQLite; with it, Postgres. The Postgres schema is in `server/schema.pg.sql` (row-level security is on with no policies, so Supabase's public Data API can read nothing; the app connects as its own role). The connection uses TLS and checks the server's certificate.
- **API:** `api/index.js` is a Vercel Function that serves every `/api/*` route.
- **Audio and art:** the catalog generator is deterministic, so `scripts/vercel-build.js` regenerates the same WAV and SVG files on every build and Vercel serves them as static files. `middleware.js` checks the HMAC signature on every `/media/` request, as the local server does.
- **Schema and migrations:** `server/schema.pg.sql` creates missing tables and migrates existing ones, so every statement in it must be safe to re-run. The app's database role (`ainos_app`) can only read and write rows, so the file is applied by the tables' owner: paste it into the Supabase SQL editor, or set `DATABASE_MIGRATION_URL` and the build applies it. **Every deploy** then checks, as the app's role, that every table and column in the file exists, and stops with a list of what is missing if not. On the first deploy it seeds the empty database from the generated catalog (`scripts/seed-postgres.js`). Later builds sync the catalog instead: every track already in the database must still be generated (its audio file is named by its id, so the build stops otherwise); new catalog rows, such as appended hymns, are added, and display fields (names, descriptions, lyrics) refreshed. Measured loudness and audio features, existing playlist contents and user data are never changed.

Environment variables on Vercel:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **Transaction pooler** connection string (port 6543) |
| `DATABASE_CA_CERT` | The CA certificate that signs your database's TLS certificate, as PEM text. Supabase uses its own CA: download it from *Project Settings → Database → SSL configuration* and paste the file's contents. Not needed for a database whose certificate is signed by a public CA. |
| `AINOS_SECRET` | A long random string; signs media URLs |
| `DATABASE_MIGRATION_URL` | Optional, build only: a connection as the tables' owner. When set, the build applies `schema.pg.sql` before checking it. |
| `AINOS_SECRET_PREVIOUS` | Only while rotating `AINOS_SECRET`: the old value, still accepted for media URLs (see *Rotating secrets*). |
| `YOUVERSION_APP_KEY` | Used from Phase 2, optional. YouVersion Platform App Key for Scripture text. Without it, Scripture falls back to public-domain text. |
| `YOUTUBE_API_KEY` | Used from Phase 3, optional. YouTube Data API v3 key, restricted in Google Cloud to that API only. Without it, search shows only the local index. |
| `CRON_SECRET` | Used from Phase 3. A long random string; Vercel sends it to cron routes, which refuse requests without it. |
| `YOUTUBE_DAILY_SEARCH_CAP` | Used from Phase 3, optional. Live YouTube searches allowed per day (default 80; YouTube's default quota is 100). |
| `UPLOAD_BUCKET` | Used from Phase 7 (not started). Private Supabase Storage bucket for verified uploads. |

Keys stay on the server: none is read from `public/`, put in HTML, logged or returned by the API.

### Rotating secrets

Rotate a secret when it may have leaked, and otherwise about once a year. Change it in the Vercel project settings and redeploy; secrets never go in the repo.

- **`AINOS_SECRET`** (signs media URLs, which live for up to an hour). Set `AINOS_SECRET_PREVIOUS` to the current value and `AINOS_SECRET` to a new long random string, then redeploy. The app and `middleware.js` accept both for now, so audio already queued in open tabs keeps playing. After at least an hour, delete `AINOS_SECRET_PREVIOUS` and redeploy. If the old secret leaked, skip the overlap: anyone holding it could keep signing URLs while it is accepted, so set only the new `AINOS_SECRET` (open tabs may need a reload to play).
- **`CRON_SECRET`** (Vercel sends it to cron routes, from Phase 3). Vercel reads the new value from project settings, so set it and redeploy; nothing else holds the old one.
- **API keys** (`YOUVERSION_APP_KEY` from Phase 2, `YOUTUBE_API_KEY` from Phase 3). Create a new key in the provider's console (for YouTube, restricted to the YouTube Data API), set it and redeploy, then delete the old key in the console. Without a key the app falls back (public-domain Scripture text, local-only search) rather than failing.

`node scripts/smoke.js https://<your-deployment>` runs an end-to-end check (login, every API route, signed audio, a temporary playlist) against any running copy. It signs in with *Try the demo*, so it resets the demo account.

Running `npm start` with `DATABASE_URL` set uses that database instead of SQLite (it prints which host), while audio and art still come from `data/`.

**Connect on serverless:** devices are tracked in each server instance's memory, so on Vercel two devices only see each other when their requests reach the same instance. It works fully when running locally.

## What to try

1. **Switch languages** using the language selector in the top bar (**English**, **हिन्दी (Hindi)**, **नेपाली (Nepali)**, **中文 (Chinese)**, **日本語 (Japanese)**, **Español (Spanish)**). Watch the interface localize and the Home screen recommend Christian worship songs in the selected language.
2. **Play anything** and open the *Now playing* panel (right). It shows the quality (up to High 353 kbps), the track's measured loudness and the gain applied, the start latency, and a countdown to when the play counts as a stream.
3. **Let a track run into its last 30 seconds.** The next track preloads on a second audio deck. Under the hood shows the prefetched start latency (a few ms) next to the cold start (tens of ms).
   With **Settings → Crossfade** on (2–12 s), the next song starts early on that second deck and the two fade across on an equal-power curve; pausing, seeking or skipping cuts the fade.
4. **Open a second tab** (or a phone) and click the devices icon. The second tab shows what the first is playing and can control it. Pick "This browser" to move playback over at the same position.
5. **Download an album**, stop the server, and keep playing it in the already-open page. The service worker serves it from cache.
6. **Under the hood** shows live internals: deck states, latency, stutters, the cache, the event pipeline, recommender stats with a *Retrain now* button, and a streaming architecture mapping table that links to the evidence.

## How it's built

```
server/
  index.js       entry point (generates the catalog on first run)
  app.js         HTTP API + static/media serving, security headers, routing
  store.js       async query interface over SQLite (local) or Postgres (DATABASE_URL)
  schema.pg.sql  Postgres schema for Supabase
  http.js        tiny router, JSON helpers, HTTP Range file serving
  db.js          SQLite schema (node:sqlite) + in-place migrations
  auth.js        scrypt passwords, sessions, rate limiting, HMAC-signed media URLs
  catalog.js     read models (tracks, albums, artists, playlists, language filtering, prefix search)
  events.js      event ingestion → database + hourly NDJSON buckets (local only); 30-second rule
  recommend.js   implicit ALS + co-listening + audio features + language filtering; Discover Weekly, Daily Mix, Radio
  connect.js     multi-device hub over Server-Sent Events (state, commands, transfer)
  loudness.js    ITU-R BS.1770-4 integrated loudness + normalization gain
scripts/
  generate.js    builds the Christian worship catalog across 6 languages, synthesizes audio, measures loudness, seeds users
  synth.js       procedural music synthesizer (8 styles) + WAV encoder
  art.js         generated SVG cover art
  seed-postgres.js  applies the Postgres schema, then copies a generated catalog into an empty database
  vercel-build.js   Vercel build: generate catalog, seed/verify Postgres, assemble dist/
  smoke.js       end-to-end check against a running deployment
api/index.js     Vercel Function for /api/*
middleware.js    Vercel middleware: signature check for /media/
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

**Scale caveats.** In-process recommendations and SSE fan-out are right for one machine. At global scale each piece becomes a service: a CDN for media, Pub/Sub plus Dataflow for events, Voyager/Annoy indexes for nearest-neighbour search, and a stateful connect-state service. The evidence report covers where Ainos deliberately differs.
