# Ainos — Project Context

Quick orientation for anyone (human or AI assistant) picking up work on this repo. The [README](README.md) covers setup, deploy steps and features in detail; this file covers what you need to know before changing code.

## What it is

Ainos (Greek *αἶνος*, "praise") is a Christian worship and praise music streaming app modelled on Spotify's architecture. It is a learning/demo project with an evidence report ([docs/HOW-SPOTIFY-WORKS.md](docs/HOW-SPOTIFY-WORKS.md)) that maps each feature to how Spotify does it.

- **Catalog:** 33 original tracks across 8 artists in 6 languages (en, hi, ne, zh, ja, es). All audio is synthesized from code at setup time, so there is no copyrighted audio.
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

Key server modules: `app.js` (routes, security headers), `store.js` (SQLite/Postgres), `db.js` (SQLite schema + migrations), `schema.pg.sql` (Postgres schema + migrations), `auth.js` (scrypt, sessions, rate limits, signed media URLs), `catalog.js` (read models, search), `recommend.js` (ALS + co-listening + audio features), `events.js` (event pipeline, 30-second stream rule), `connect.js` (multi-device over SSE), `loudness.js` (BS.1770 loudness).

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
- **Preview and Production share one database** on Vercel (same `DATABASE_URL`), so a preview deploy, or a smoke test against it, touches live data, including the demo account.
- **The demo account is shared.** Anything a demo visitor can publish would reach everyone, so demo playlists are forced private (`isDemo()` in `server/demo.js`). Guard any new "publish" or account-changing route the same way.
- **Changing `scripts/generate.js` can change track ids.** On Vercel, audio files are named by id; if the generated ids stop matching the ids already in Postgres, `seed-postgres.js` refuses to continue. Treat catalog changes as a data migration.
- **Row-level security** is on with no policies in Postgres, so Supabase's public Data API sees nothing. The app connects with its own role. Don't add RLS policies without a reason.
- **Connect on Vercel** keeps devices in each instance's memory, so two devices only see each other if they hit the same instance. It works fully locally.
- **Event NDJSON logs** are written to `data/events/` only when running on SQLite.
- **Vercel path rewrite:** `/api/:path*` becomes `/api/index?__path=...`; `api/index.js` restores and re-encodes the original path.
- **Secrets:** `AINOS_SECRET` signs media URLs (locally it is `data/secret.key`, made by the generator). `.env*` files are gitignored; never commit them.

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `PORT`, `HOST` | local | Default `127.0.0.1:4321`; `HOST=0.0.0.0` to test Connect from a phone |
| `DATABASE_URL` | prod (optional locally) | Supabase transaction pooler URL (port 6543); switches the store to Postgres |
| `DATABASE_CA_CERT` | prod | Supabase CA certificate (PEM) for TLS verification |
| `AINOS_SECRET` | prod | Long random string for media URL signatures |
| `DATABASE_MIGRATION_URL` | build (optional) | Owner connection; when set, the build applies `schema.pg.sql` |

## Testing

- `test/helpers.js` → `startTestServer()` generates a quick catalog in a temp dir and starts the app on a random port with SQLite; `login()` / `signup()` give a cookie-keeping client.
- Suites: `api` (routes, auth, playlists, security, the demo reset on its own server), `connect`, `crossfade` (pure timing and curve logic from `public/js/crossfade.js`), `loudness`, `recommend`, `search`, `store`. `startTestServer(options)` passes options to `createApp`.
- Tests run with `--test-concurrency=1`.

## Current state (2026-10-28)

- Branch `main`. Latest commit: "Use Spotify's colors and a green cross logo".
- Deployed to Vercel with Supabase Postgres.
- Uncommitted work in progress touches most server files, the scripts, the Postgres schema (unique deferred `(playlist_id, position)` constraint, `search_index.folded` column, shared `rate_limits` table) and adds `test/recommend.test.js`, `test/search.test.js`, `test/store.test.js`.
