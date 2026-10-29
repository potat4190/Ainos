# Ainos — Project Context

Quick orientation for anyone (human or AI assistant) picking up work on this repo. The [README](README.md) covers setup, deploy steps and features in detail; this file covers what you need to know before changing code.

## What it is

Ainos (Greek *αἶνος*, "praise") is a Christian worship and praise music streaming app modelled on Spotify's architecture. It is a learning/demo project with an evidence report ([docs/HOW-SPOTIFY-WORKS.md](docs/HOW-SPOTIFY-WORKS.md)) that maps each feature to how Spotify does it.

- **Catalog:** 33 original tracks across 8 artists in 6 languages (en, hi, ne, zh, ja, es), plus 8 public-domain hymns (`scripts/hymns.js`: sourced melodies, every printed stanza as lyrics, a `songs` row each). All audio is synthesized from code at setup time, so there is no copyrighted audio.
- **One plan:** every user gets "All-Access" (high quality, unlimited skips, offline, Connect). There is no Free/Premium split; the old `plan` column is dropped by a migration.
- **Language drives everything:** the user's `language` sets the UI translation *and* which songs get recommended.
- **Demo:** "Try the demo" (`POST /api/auth/demo`) resets the shared `demo` account to a snapshot (`server/demo.js`) and signs in. `demo` / `ainos-demo` still works and does not reset.

## Stack

- **Node.js ≥ 22.13, ES modules, no framework, no build step.** Uses built-in `node:sqlite`, `node:test`, `node:http`.
- **Local:** zero dependencies; data is SQLite in `data/` (gitignored).
- **Production:** Vercel (one Function for `/api/*`, static files for app/audio/art, middleware for signed media) + Supabase Postgres. Only `pg` and `@vercel/functions` are npm dependencies, and only production uses them.
- **Frontend:** vanilla JS ES modules in `public/js/`, DOM built with the `h()` helper in `ui.js`. A strict CSP means **no inline scripts or styles**.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Generates the catalog on first run, serves `http://127.0.0.1:4321` |
| `npm run dev` | Same, with `--watch` |
| `npm run setup` | Wipes and regenerates `data/` |
| `npm test` | `node:test` suites in `test/`, run one file at a time |
| `node scripts/smoke.js <url>` | End-to-end check against a running deployment |

## Layout

```
server/      backend (app.js = routes; store.js = DB interface; one module per concern)
public/      frontend shell, JS modules, service worker, CSS
scripts/     catalog generator, synth, cover art, Postgres seeding, Vercel build, smoke test
api/         Vercel Function entry (wraps server/app.js)
middleware.js  Vercel middleware: HMAC check on /media/
test/        node:test suites + helpers.js (temp catalog + server on a random port)
docs/        evidence report, also readable inside the app
```

Key server modules: `app.js` (routes, security headers), `store.js` (SQLite/Postgres), `db.js` (SQLite schema + migrations), `schema.pg.sql` (Postgres schema + migrations), `auth.js` (scrypt, sessions, rate limits, signed media URLs), `catalog.js` (read models, search), `recommend.js` (ALS + co-listening + audio features), `events.js` (event pipeline, 30-second stream rule), `connect.js` (multi-device over SSE), `loudness.js` (BS.1770 loudness), `validate.js` (input validators), `audit.js` (org audit trail), `demo.js` (shared demo accounts, reset, `noDemo`).

## Conventions

- **One SQL dialect for both databases.** Write queries with `?` placeholders in the SQL subset SQLite and Postgres share. `store.js` rewrites `?` to `$1, $2…` for Postgres. Use `inList(values)` for `IN (...)` lists. All store calls are async (`all`, `get`, `run`, `tx`).
- **IDs:** 22-character base62 strings (`randomId()` / `seededId()` in `util.js`), URIs look like `ainos:track:<id>`.
- **API responses** loosely follow the Spotify Web API shape (`id`, `uri`, nested simplified `artist`/`album`). Errors look like `{ error: { status, message } }`.
- **Routes:** `r.get/post/put/patch/delete('/api/...', auth(async ({ req, res, user, params, query }) => ...))` in `server/app.js`. Throw `HttpError` for client errors.
- **Determinism:** the catalog generator is seeded (`mulberry32` + `hashSeed`), so the same code always gives the same track ids, audio and art. Production depends on this.
- **Comments** explain *why*, briefly; keep that style.

## Things to keep in sync (easy to miss)

| If you change… | Also change… |
|---|---|
| A table or column | Both `server/db.js` (SQLite, plus its `migrate()`) **and** `server/schema.pg.sql` (Postgres) |
| Supported languages | `LANGUAGES` in `server/app.js` **and** `public/js/i18n.js` (plus strings for every language in `STRINGS`) |
| Security headers / CSP | `SECURITY_HEADERS` in `server/app.js` **and** `headers` in `vercel.json` |
| Media URL signing | `signMediaPath`/`verifyMediaSignature` in `server/auth.js` **and** `middleware.js` |
| UI text | Add the key to every language in `public/js/i18n.js`, use it via `t('key')` |

## Gotchas

- **`schema.pg.sql` is the migration.** Every statement must be safe to re-run on a live database. Wrap changes to existing tables in `DO $ ... $` blocks that check first (`ALTER TABLE` locks the table even when it changes nothing). The app connects as `ainos_app`, which can only read and write rows, so the owner applies the file (Supabase SQL editor, or `DATABASE_MIGRATION_URL` at build time) and **new tables need a `GRANT` to `ainos_app`**. Every deploy checks that each table and column in the file exists and fails the build if not, so apply migrations before deploying code that needs them.
- **Previews have their own database** (Supabase project "ainos-preview", set in Vercel's Preview variables since 2026-10-29), so a preview deploy or a smoke test against it never touches production. A smoke test still resets the demo account of the database it runs against.
- **The demo account is shared.** Anything a demo visitor can publish would reach everyone, so demo playlists are forced private (`isDemo()` in `server/demo.js`). Guard any new "publish" or account-changing route the same way.
- **Changing `scripts/generate.js` can change track ids.** On Vercel, audio files are named by id; if a track already in Postgres is no longer generated, `seed-postgres.js` refuses to continue (preview builds skip the sync with a warning). Appending is fine: new catalog rows are synced in on deploy. `test/catalog-ids.test.js` fails on any change to an existing id or its audio. Treat changes to existing tracks as a data migration.
- **Generator-owned songs** (the hymns, `org_id` NULL, written by `generate.js`) are refreshed from `scripts/hymns.js` on every deploy: edit their lyrics there, not in the database, or a deploy will put them back.
- **Row-level security** is on with no policies in Postgres, so Supabase's public Data API sees nothing. The app connects with its own role. Don't add RLS policies without a reason.
- **Connect on Vercel** keeps devices in each instance's memory, so two devices only see each other if they hit the same instance. It works fully locally.
- **Event NDJSON logs** are written to `data/events/` only when running on SQLite.
- **Vercel path rewrite:** `/api/:path*` becomes `/api/index?__path=...`; `api/index.js` restores and re-encodes the original path.
- **Secrets:** `AINOS_SECRET` signs media URLs (locally it is `data/secret.key`, made by the generator). `.env*` files are gitignored; never commit them.

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `PORT`, `HOST` | local | Default `127.0.0.1:4321`; `HOST=0.0.0.0` to test Connect from a phone |
| `TRUST_PROXY` | local (optional) | `1` when running behind a TLS-terminating proxy or tunnel (nginx, Caddy, ngrok) that sets `X-Forwarded-*`; Vercel sets this up itself. Without it, HTTPS logins behind such a proxy are refused as cross-origin |
| `DATABASE_URL` | prod (optional locally) | Supabase transaction pooler URL (port 6543); switches the store to Postgres |
| `DATABASE_CA_CERT` | prod | Supabase CA certificate (PEM) for TLS verification |
| `AINOS_SECRET` | prod | Long random string for media URL signatures |
| `DATABASE_MIGRATION_URL` | build (optional) | Owner connection; when set, the build applies `schema.pg.sql` |
| `AINOS_SECRET_PREVIOUS` | prod (only while rotating) | The old `AINOS_SECRET`, still accepted for media URLs during a rotation (README: "Rotating secrets") |
| `YOUVERSION_APP_KEY` | prod + local (optional) | Used from Phase 2. YouVersion Platform App Key, sent as `X-YVP-App-Key`; missing → public-domain Scripture fallback |
| `YOUTUBE_API_KEY` | prod + local (optional) | Used from Phase 3. YouTube Data API v3 key, restricted to that API in Google Cloud; missing → search shows only the local index |
| `CRON_SECRET` | prod | Used from Phase 3. Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes, which refuse anything else |
| `YOUTUBE_DAILY_SEARCH_CAP` | prod (optional) | Used from Phase 3. Live YouTube searches allowed per day; default 80 (YouTube's default quota is 100) |
| `UPLOAD_BUCKET` | prod | Used from Phase 7 (not started). Private Supabase Storage bucket for verified uploads |

No key is ever read from `public/` code, embedded in HTML, logged or returned in a response.

## Testing

- `test/helpers.js` → `startTestServer()` generates a quick catalog in a temp dir and starts the app on a random port with SQLite; `login()` / `signup()` give a cookie-keeping client.
- Suites: `api` (routes, auth, playlists, security incl. CSRF and cookies, the demo reset on its own server), `audit`, `catalog-ids` (track ids and audio inputs never change; fixtures in `test/fixtures/`), `connect`, `crossfade` (pure timing and curve logic from `public/js/crossfade.js`), `i18n` (every key in all six languages), `loudness`, `media-signing` (server and middleware agree, secret rotation), `recommend`, `schema` (db.js and schema.pg.sql match; RLS and grants), `search`, `shell` (service worker caches every module), `smoke` (runs `scripts/smoke.js` locally), `store`, `validate`. `startTestServer(options)` passes options to `createApp`.
- Tests run with `--test-concurrency=1`.
- Adding catalog tracks on purpose: `AINOS_UPDATE_CATALOG_SNAPSHOT=1 npm test` appends them to the fixtures (it can never change an existing entry).

## Helpers for new routes

- `server/validate.js`: `str`, `int`, `oneOf`, `usfmRef`, `youtubeId`; each throws 400 `invalid_input`.
- `rateLimit(store, key, {limit, windowSec})` in `server/auth.js`: throws 429 with `Retry-After`; keys like `user:<id>:<bucket>`; windows up to a day.
- `noDemo(handler)` / `assertNotDemo(user)` in `server/demo.js`: 403 `demo_not_allowed` for both shared demo accounts (`demo`, `church-demo`).
- `audit(t, {orgId, userId, action, targetType, targetId, details})` in `server/audit.js`: pass the transaction handle.

## Current state (2026-10-29)

- The spec in `AINOS-SPEC.md` is being implemented phase by phase; `PROGRESS.md` is the running record and `PLAN.md` the task list. Phase 0 (baseline and guardrails) is on branch `phase-0-baseline`.
- Deployed to Vercel with Supabase Postgres (from `main`).
