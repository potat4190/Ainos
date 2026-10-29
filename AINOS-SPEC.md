# Ainos Feature & Security Implementation Spec

Oct 29, 2026 · @Rhidaya

This spec turns Ainos from a Christian-labelled Spotify demo into a gospel-centered worship tool for listeners and churches. Build it in phases 0 to 7, in order; each phase ships, passes `npm test`, and deploys before the next starts.

## Rules for Claude Code

Read this whole section before writing code. These rules exist because Ainos is live on Vercel with Supabase Postgres, and several of its conventions break silently if ignored.

### Before you start

1. Read `context.md`, `README.md` and `docs/HOW-SPOTIFY-WORKS.md` in the repo first. If anything in this spec conflicts with the code as it stands, the code wins for *existing* behavior; stop and report the conflict instead of guessing.
2. Check `git status`. The repo had uncommitted work in progress on 2026-10-28 (deferred `(playlist_id, position)` unique constraint, `search_index.folded` column, shared `rate_limits` table, new `test/recommend.test.js`, `test/search.test.js`, `test/store.test.js`). Do not start a phase until that work is committed or the owner says how to handle it.
3. Inspect the real schema (`server/db.js`, `server/schema.pg.sql`) and route table (`server/app.js`) before adding anything. Table and column names in this spec are targets; reuse existing tables where they already fit (for example, reuse `tracks`, `playlists`, `rate_limits`, `search_index` rather than creating parallel ones).

### How to work

1. One phase per branch (`phase-0-baseline`, `phase-1-catalog`, …). One task per commit. Never mix two phases in one commit.
2. After every task: run `npm test` (suites run one file at a time with `--test-concurrency=1`). Do not commit with a failing test. After each phase: run `node scripts/smoke.js <url>` against a preview deployment.
3. Write the test for a task before or alongside the code. Every new route gets at least one success test, one auth-failure test and one validation-failure test in `test/`.
4. Keep the zero-dependency rule: local dev uses only Node built-ins (`node:sqlite`, `node:test`, `node:http`). Do not add npm packages. If a task truly needs one, stop and ask, explaining why.
5. Follow existing conventions exactly: ES modules, no framework, no build step; routes as `r.get/post/put/patch/delete('/api/...', auth(async ({ req, res, user, params, query }) => ...))`; throw `HttpError` for client errors; errors as `{ error: { status, message } }`; 22-character base62 ids from `randomId()` / `seededId()`; URIs as `ainos:<type>:<id>`; responses in the Spotify Web API shape; comments explain *why*, briefly.
6. All SQL uses `?` placeholders in the subset SQLite and Postgres share; `store.js` rewrites them for Postgres. Use `inList(values)` for `IN (...)`. All store calls are async (`all`, `get`, `run`, `tx`).
7. Frontend: vanilla JS modules in `public/js/`, DOM built only with `h()` from `ui.js`. Never use `innerHTML`, `insertAdjacentHTML`, `document.write`, inline `<script>`, inline `style=` attributes or inline event handlers. The CSP forbids them and they create XSS holes.
8. Every user-visible string goes through `t('key')`, with the key added for all six languages (en, hi, ne, zh, ja, es) in `public/js/i18n.js`. If you cannot translate a string well, add the English text for that language and list the key under Open questions; never leave a key missing.

### Keep-in-sync table (from context.md, extended for this spec)

| If you change… | Also change… |
| --- | --- |
| A table or column | `server/db.js` (SQLite + its `migrate()`) **and** `server/schema.pg.sql` (Postgres) |
| Supported languages | `LANGUAGES` in `server/app.js` **and** `public/js/i18n.js` (strings for every language) |
| Security headers / CSP | `SECURITY_HEADERS` in `server/app.js` **and** `headers` in `vercel.json` |
| Media URL signing | `signMediaPath`/`verifyMediaSignature` in `server/auth.js` **and** `middleware.js` |
| UI text | Every language in `public/js/i18n.js`, used via `t('key')` |
| A new environment variable | The env table in `context.md` and `README.md`, plus Vercel project settings (owner does this) |
| A new cron job | `vercel.json` `crons` **and** the protected route in `server/app.js` |
| A new route | Route tests in `test/api.test.js` (or a new suite) **and** `scripts/smoke.js` if it is user-facing |

### Things that must never break

- **`server/schema.pg.sql` runs on every deploy.** Every statement must be safe to re-run on a live database: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and changes to existing tables inside `DO $$ ... $$` blocks that check `information_schema` first. `ALTER TABLE` locks the table even when it changes nothing, so never run a bare `ALTER TABLE` unconditionally.
- **Track ids must not change.** `scripts/generate.js` is seeded (`mulberry32` + `hashSeed`); audio files on Vercel are named by track id, and `seed-postgres.js` refuses to continue if generated ids stop matching Postgres. Adding tracks is fine; changing the seed inputs of existing tracks is a data migration. Before editing `generate.js`, write a test that snapshots all current track ids and asserts they are unchanged.
- **Row-level security stays on with no policies** on every existing table. The app connects with its own role. The only allowed exception is Supabase Realtime authorization in Phase 6, and only on Realtime's own messages table.
- **The shared demo account (`demo` / `ainos-demo`) keeps working** and resets for each visitor. New features must degrade gracefully for it (see Security).
- **Secrets never reach the browser or the repo.** `.env*` stays gitignored.

## Decisions and non-goals

Ainos owns its native catalog and hands everything else to services that already hold the licenses. Every feature below follows from that.

### In scope

| Area | Decision |
| --- | --- |
| Native catalog | Keep the synthesized catalog as the core. Add public-domain hymns (words and melody published before 1929) synthesized by the existing synth. These get the full pipeline: signed URLs, loudness, offline, Connect, recommendations, 30-second stream rule. |
| Real worship songs (e.g. "Carry My Cross" by Victory Worship) | Searchable and playable through the **YouTube IFrame embed** only, in a visible player at least 200 × 200 px. Ainos stores the video ID and its own song record, never the audio. |
| Spotify | Optional "Open in Spotify" link-out or Spotify embed on a song page. No Web Playback SDK (needs Premium for every listener, no commercial use without Spotify's written approval, dev mode capped at 5 users). |
| Scripture | YouVersion Platform API, key on the server only, references stored as USFM (`ROM.12.1`), text fetched at request time. Fallback: public-domain text (KJV or WEB). |
| Lyrics | Public-domain hymns ship with lyrics. Modern songs: the church pastes lyrics it already has under its own CCLI Church Copyright License, private to that church. |
| Projection | PowerPoint-style presentation: present on this screen or in presenter view with a second screen; slides advance manually or automatically with the song's synced lyrics. |
| Church accounts | Phase 5: private church content (lyrics, setlists, slides). Phase 7: verified artist uploads with review queue. |

### Explicitly out of scope (do not build)

- **Discord-bot style streaming.** No `yt-dlp`, no extracting or proxying YouTube audio, no converting Spotify links into YouTube downloads. YouTube shut down Groovy and Rythm with cease-and-desist letters in 2021, and Hydra in 2023. It also breaks often because YouTube blocks cloud-server requests.
- **Hosting copyrighted audio.** No uploads of recordings the uploader does not own, no caching of third-party audio.
- **CCLI SongSelect import.** CCLI has retired its SongSelect API Partner Program and is not accepting new partners; scraping SongSelect is against its terms. Lyrics come from church paste only.
- **Public open uploads** before Phase 7's verification, rights statement and review queue exist.
- **Altering YouTube's metadata.** Video titles and thumbnails are shown as YouTube returns them wherever the video itself appears.

## Phase 0: Baseline and guardrails

Phase 0 changes no user-facing behavior. It adds the safety nets every later phase relies on.

### Tasks

1. **Track-id snapshot test.** Add `test/catalog-ids.test.js`: generate the catalog into a temp dir (as `startTestServer()` does) and assert the full sorted list of existing track ids equals a committed snapshot file `test/fixtures/track-ids.json`. New tracks may be appended to the snapshot; existing ids must never change.
2. **Header check in the smoke test.** Extend `scripts/smoke.js` to fetch `/` and `/api/...` and assert: `Content-Security-Policy` present and contains no `unsafe-inline` in `script-src`; `Referrer-Policy` is `strict-origin-when-cross-origin` (see task 3); `X-Content-Type-Options: nosniff`; `Strict-Transport-Security` present in production.
3. **Referrer-Policy.** Read the current value in `SECURITY_HEADERS` and `vercel.json`. YouTube embeds must identify the app through the HTTP Referer header; if the current value is `no-referrer` or `same-origin`, change it to `strict-origin-when-cross-origin` in both places. Do not change any other header in this task.
4. **CSRF origin check.** Add a helper in `server/app.js` (or the existing middleware layer) that rejects any `POST`, `PUT`, `PATCH`, `DELETE` whose `Origin` header is present and does not match the app's own origin. Confirm session cookies are `HttpOnly`, `Secure` (production), `SameSite=Lax` or `Strict`. Add tests for a cross-origin POST being refused.
5. **Input limit helpers.** Add `server/validate.js` with small pure functions: `str(value, {min, max, trim})`, `int(value, {min, max})`, `oneOf(value, list)`, `usfmRef(value)`, `youtubeId(value)` (`/^[A-Za-z0-9_-]{11}$/`). Each throws `HttpError(400, …)` on failure. Every new route in later phases validates input through these.
6. **Rate-limit helper.** Reuse the shared `rate_limits` table. Expose one function, e.g. `rateLimit(store, key, {limit, windowSec})`, keyed by `user:<id>:<bucket>` or `ip:<addr>:<bucket>`. Throws `HttpError(429, …)` with a `Retry-After` header.
7. **Demo-account guard.** Add `isDemo(user)` and a `noDemo` wrapper that throws `HttpError(403, t-key 'demo.notAllowed')` for actions the shared demo account must not do (create church, upload, invite, edit org content). The guard recognizes both shared demo accounts (listener and church); the church demo's allowed actions inside the demo church are defined in Phase 5.7.
8. **Audit log helper.** Create the `audit_log` table (see Data model) and `audit(store, {orgId, userId, action, targetType, targetId, details})`. Used from Phase 5 on.
9. **Docs.** Add the new environment variables below to the env table in `context.md` and `README.md`, marked "used from Phase N".

### Environment variables added by this spec

| Variable | Where | Phase | Meaning |
| --- | --- | --- | --- |
| `YOUVERSION_APP_KEY` | prod + local (optional) | 2 | YouVersion Platform App Key, sent as `X-YVP-App-Key`. Missing → Scripture falls back to public-domain text. |
| `YOUTUBE_API_KEY` | prod + local (optional) | 3 | YouTube Data API v3 key. Restricted in Google Cloud to the YouTube Data API only. Missing → search shows only the local index. |
| `CRON_SECRET` | prod | 3 | Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron calls; the cron route rejects anything else. |
| `YOUTUBE_DAILY_SEARCH_CAP` | prod (optional) | 3 | Max live `search.list` calls per day the app allows itself. Default 80, leaving headroom under YouTube's default of 100. |
| `UPLOAD_BUCKET` | prod | 7 | Supabase Storage bucket for verified uploads (private). |

No key is ever read from `public/` code, embedded in HTML, or logged.

### Done when

- [ ] `npm test` passes, including the new id-snapshot and CSRF tests
- [ ] `scripts/smoke.js` passes against a preview deploy with the header checks
- [ ] No user-facing change except the Referrer-Policy fix, if it was needed

## Data model

The central idea: a **song** (what is sung: title, lyrics, Scripture) is separate from its **sources** (ways to play it: a native track or a YouTube video). Ainos owns songs forever; data borrowed from YouTube lives in a cache that is refreshed or deleted within 30 days.

### Rules for every table here

- Add each table to **both** `server/db.js` (SQLite, inside `migrate()`) and `server/schema.pg.sql` (Postgres, `CREATE TABLE IF NOT EXISTS`, re-runnable).
- Follow the repo's existing conventions for ids (`TEXT` 22-char base62), timestamps (match how existing tables store them — check before writing), booleans (`INTEGER` 0/1 in both dialects) and JSON (`TEXT` holding JSON; parse in JS, never query inside it).
- Enable row-level security with **no policies** on each new Postgres table, like the existing ones: `ALTER TABLE x ENABLE ROW LEVEL SECURITY` inside a `DO $$` block that checks `pg_class.relrowsecurity` first.
- `org_id NULL` means global catalog content; non-null means private to that church.
- Create tables in the phase that first needs them (phase in brackets), not all at once.

### Tables

```sql
-- [0] audit trail for org actions
audit_log (id TEXT PK, org_id TEXT NULL, user_id TEXT NULL, action TEXT NOT NULL,
           target_type TEXT, target_id TEXT, details TEXT /*JSON*/, created_at)
  INDEX (org_id, created_at)

-- [1] a song as sung, independent of any recording
songs (id TEXT PK, title TEXT NOT NULL, artist TEXT NOT NULL, language TEXT NOT NULL,
       ccli_number TEXT NULL, public_domain INTEGER NOT NULL DEFAULT 0,
       org_id TEXT NULL /*no FK: orgs arrives in Phase 5; checked in code*/,
       created_by TEXT NULL, created_at, updated_at)
  INDEX (org_id), INDEX (language)

-- [1] alternate titles, transliterations, other-language titles ("Yeshu mero" / "येशू मेरो")
song_aliases (song_id TEXT REFERENCES songs(id) ON DELETE CASCADE, alias TEXT NOT NULL,
              folded TEXT NOT NULL, PRIMARY KEY (song_id, folded))

-- [1] theme / season tags: advent, christmas, lent, easter, pentecost, grace, cross,
--     praise, prayer, thanksgiving, communion, evening ... (closed list in code)
song_themes (song_id TEXT REFERENCES songs(id) ON DELETE CASCADE, theme TEXT NOT NULL,
             PRIMARY KEY (song_id, theme))

-- [1] how to play a song: one row per native track or YouTube video
song_sources (id TEXT PK, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
              source TEXT NOT NULL CHECK (source IN ('ainos','youtube')),
              track_id TEXT NULL,          -- set when source = 'ainos'
              youtube_video_id TEXT NULL,  -- set when source = 'youtube', 11 chars
              kind TEXT NULL,              -- 'official' | 'lyric' | 'live' | 'backing'
              available INTEGER NOT NULL DEFAULT 1, last_checked_at NULL,
              CHECK ((source='ainos' AND track_id IS NOT NULL AND youtube_video_id IS NULL)
                  OR (source='youtube' AND youtube_video_id IS NOT NULL AND track_id IS NULL)))
  UNIQUE (youtube_video_id), INDEX (song_id), INDEX (track_id)

-- [2] Scripture references; section_label NULL = whole song
song_scripture (song_id TEXT REFERENCES songs(id) ON DELETE CASCADE,
                section_label TEXT NULL, usfm_ref TEXT NOT NULL, position INTEGER NOT NULL,
                PRIMARY KEY (song_id, usfm_ref))

-- [3] YouTube API data: refresh or delete within 30 days (fetched_at)
youtube_video_cache (video_id TEXT PK, channel_id TEXT, title TEXT, channel_title TEXT,
                     thumbnail_url TEXT, duration_ms INTEGER, embeddable INTEGER,
                     default_language TEXT NULL, fetched_at NOT NULL)
  INDEX (fetched_at)

-- [3] curated official worship channels; the nightly sync walks these
youtube_channels (channel_id TEXT PK, handle TEXT NOT NULL, display_name TEXT,
                  language TEXT, uploads_playlist_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
                  sync_page_token TEXT NULL, last_synced_at NULL)

-- [3] live-search results cache, including empty (negative) results
search_cache (query_folded TEXT, language TEXT, results TEXT /*JSON video ids*/,
              fetched_at NOT NULL, PRIMARY KEY (query_folded, language))

-- [3] daily quota accounting for external APIs
api_quota (day TEXT, bucket TEXT, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, bucket))

-- [4] lyrics, stored once per section per language
song_sections (id TEXT PK, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
               language TEXT NOT NULL, label TEXT NOT NULL,   -- 'V1','C','V2','B','PC','T'
               lines TEXT NOT NULL,                           -- newline-separated
               org_id TEXT NULL,                              -- church-pasted lyrics are private
               UNIQUE (song_id, language, label, org_id))

-- [4] order a section list is sung in, e.g. ["V1","C","V2","C","B","C","C"]
song_arrangements (id TEXT PK, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
                   org_id TEXT NULL, name TEXT NOT NULL, section_order TEXT NOT NULL /*JSON*/)

-- [4] time-synced lyrics for ONE specific recording (track or video)
lyric_timings (id TEXT PK, source_id TEXT NOT NULL REFERENCES song_sources(id) ON DELETE CASCADE,
               language TEXT NOT NULL, arrangement_id TEXT NULL, offset_ms INTEGER DEFAULT 0,
               timings TEXT NOT NULL /*JSON [{label, line, ms}]*/,
               created_by TEXT, org_id TEXT NULL, updated_at)

-- [5] churches and organizations
orgs (id TEXT PK, name TEXT NOT NULL, default_language TEXT NOT NULL,
      bible_version_id INTEGER NULL, created_by TEXT NOT NULL, created_at)
org_members (org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
             role TEXT NOT NULL CHECK (role IN ('admin','leader','operator','member')),
             joined_at, PRIMARY KEY (org_id, user_id))
org_invites (id TEXT PK, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
             token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
             max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
             expires_at NOT NULL, revoked_at NULL, created_by TEXT NOT NULL, created_at)

-- [5] Sunday setlists
setlists (id TEXT PK, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          name TEXT NOT NULL, service_date TEXT NULL, created_by TEXT, updated_at)
  INDEX (org_id, service_date)
setlist_items (id TEXT PK, setlist_id TEXT NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
               position INTEGER NOT NULL,
               kind TEXT NOT NULL CHECK (kind IN ('song','scripture','text','blank')),
               song_id TEXT NULL, arrangement_id TEXT NULL, source_id TEXT NULL,
               usfm_ref TEXT NULL, text TEXT NULL,
               UNIQUE (setlist_id, position)   -- deferrable in Postgres, like playlists
              )

-- [7] verified uploads
uploads (id TEXT PK, org_id TEXT NOT NULL, uploaded_by TEXT NOT NULL, song_id TEXT NULL,
         storage_path TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','removed')),
         rights_statement TEXT NOT NULL, rights_attested_at NOT NULL,
         loudness_lufs REAL NULL, duration_ms INTEGER NULL,
         reviewed_by TEXT NULL, reviewed_at NULL, created_at)
```

### Changes to existing tables

| Table | Change | Phase | How |
| --- | --- | --- | --- |
| Playlist items (the table behind playlists and Liked Songs) | Allow an item to be a `song_sources.id` as well as a native `track_id`. | 3 | Add nullable `source_id`. If `track_id` is `NOT NULL` in SQLite, rebuild the table inside `migrate()` with the copy-and-rename pattern in one transaction; in Postgres, `ALTER COLUMN track_id DROP NOT NULL` inside a `DO $$` check, plus a `CHECK` that exactly one of the two is set. Keep the deferred `(playlist_id, position)` unique constraint. |
| `search_index` | Index songs and their aliases, not just tracks. | 3 | Add a `kind` value (or column) for `song`, reuse `folded`. |
| `users` | No new columns. Org roles live in `org_members`. | — | — |
| `tracks` | No schema change. Public-domain hymns are new rows generated by `generate.js`. | 1 | Append only; id snapshot test guards existing ids. |

If the existing playlist schema makes the `source_id` change risky, stop and propose the alternative (a separate `playlist_external_items` table merged by position in `catalog.js`) before writing it.

## Phase 1: Gospel-centered catalog

The app is currently Christian in its labels, not its content: tracks like "Sunset Protocol", "Ice Engine" and "Pixel Weather" by artists like "Neon Harbor" and "Velvet Static" appear under headings such as "Christian artists you might like". Phase 1 makes the content itself gospel-centered.

### 1.1 Public-domain hymn album

- Add a new artist (e.g. "Ainos Hymnal") and album(s) of public-domain hymns synthesized by the existing synth in `scripts/`. Start with: Amazing Grace, Be Thou My Vision, It Is Well with My Soul, Holy Holy Holy, Come Thou Fount. Exclude any hymn whose public-domain status is disputed or still claimed by a current publisher (for example Great Is Thy Faithfulness, which Hope Publishing still licenses). Verify each hymn: words **and** tune first published before 1929, by date of the work, not by assumption. Record the source and year for each in a new file `scripts/hymns.js`.
- Each hymn in `scripts/hymns.js` holds: title, author, composer, year, tune name, the melody as note data the synth can play (pitch, duration), meter/tempo, key, and the lyrics as sections (V1, V2, …, C if present).
- New tracks are **appended** with their own seed inputs (e.g. `hashSeed('hymn:' + slug)`), so existing track ids stay identical. The Phase 0 snapshot test must still pass with only appended ids.
- Each hymn also becomes a `songs` row (`public_domain = 1`) with `song_sections` in English, a `song_sources` row pointing to the native track, and `song_themes` tags. Treat the insert as seed data that both the SQLite generator and `seed-postgres.js` write, idempotently (upsert by deterministic id).
- Translations: include a translated hymn in hi, ne, zh, ja or es only if that specific translation is itself public domain; record its source. Otherwise list it under Open questions. Never machine-translate hymn lyrics and present them as the hymn.

### 1.2 Rename the existing catalog

- Rename existing tracks, albums and artists to Scripture- and worship-themed names (e.g. "Sunset Protocol" → a title drawn from a psalm). **Do not change the seed inputs that produce track ids, audio or art.** If names are part of the seed input in `generate.js`, separate display names from seed keys first (keep the old string as the seed key, add a new display name), and prove ids are unchanged with the snapshot test.
- Write the new names into a single mapping file (`scripts/catalog-names.js`) so the owner can review and edit them in one place. Leave the mapping for the owner to approve before deploying (see Open questions).
- Update any copy in `docs/HOW-SPOTIFY-WORKS.md` that names the old tracks.

### 1.3 Copy cleanup

- Remove most repeated "Christian" adjectives in UI strings (for example "Christian songs and more", "Most streamed Christian songs", "Christian releases", "Christian artists you might like"). Keep the faith in the content, not the adjectives: e.g. "Worship artists you might like", "New releases", "Popular this week".
- All edits go through `public/js/i18n.js` for every language.

### Done when

- [ ] At least 8 public-domain hymns play natively with lyrics, each with a recorded source and year
- [ ] All original track ids unchanged (snapshot test)
- [ ] Catalog display names come from one reviewed mapping file

## Phase 2: Scripture next to songs

Every song can show the passages it draws on, in the listener's language and chosen Bible version, through the YouVersion Platform API. Ainos stores only references; verse text is fetched when shown.

### 2.1 Server module `server/scripture.js`

- `getPassage({ usfm, versionId, format: 'text' })` calls the YouVersion REST API (`https://api.youversion.com`) with header `X-YVP-App-Key: process.env.YOUVERSION_APP_KEY`. Use built-in `fetch` with a 5-second timeout (`AbortSignal.timeout`). No SDK, no npm package.
- `getVerseOfTheDay({ versionId })` for the Home card.
- `listVersions(language)` to offer versions per UI language. Cache the version list in memory for 24 hours.
- **Caching passage text:** short in-memory cache only (e.g. 1 hour, max \~500 entries, LRU), and only as long as YouVersion's terms for that version allow. Check the license and permissions data the API returns for each version; if a version forbids caching, do not cache it. Never persist verse text in Postgres or SQLite.
- **Attribution:** every response includes the version's abbreviation, name and copyright line from the API; the UI must display them wherever verse text appears.
- **Fallback:** if the key is missing, the API errors, times out or the version is not licensed for this app, return public-domain text (KJV or World English Bible) bundled as a small static file, or return the reference alone with `text: null`. Never fail the whole song page.

### 2.2 Routes

| Method + path | Auth | Purpose | Validation | Limits |
| --- | --- | --- | --- | --- |
| `GET /api/scripture/:ref?version=` | logged-in or demo | Passage text + attribution | `usfmRef()` regex, e.g. `^[1-3]?[A-Z]{2,3}\.\d{1,3}(\.\d{1,3}(-\d{1,3})?)?$`; max 1 chapter; version id integer from the allowed list | `rateLimit` 60/min per user, 600/day per user |
| `GET /api/scripture/votd?version=` | logged-in or demo | Verse of the Day | version id | cached 1 hour |
| `GET /api/songs/:id/scripture` | logged-in or demo | References for a song, grouped by section | song id | — |
| `PUT /api/songs/:id/scripture` | catalog admin (global) or org `leader`+ (org song) | Replace a song's references | array ≤ 20 refs, each `usfmRef()` | audit-logged |

The route must not act as an open proxy: it only ever calls the passages, versions and VOTD endpoints, with server-built URLs, never a URL or path taken from the client.

### 2.3 UI

- Song page and now-playing panel: a "Scripture" card listing references (e.g. Romans 12:1); tapping one expands the passage with attribution.
- Settings: Bible version picker filtered to the user's language, stored on the user (reuse an existing settings column or a small `user_settings` key-value table; check what exists first).
- Home: Verse of the Day card.
- Check language coverage before shipping: list which Bible versions the app key can actually use in en, hi, ne, zh, ja, es. Any language without a licensed version shows the reference and the public-domain fallback only. Record the result under Open questions.

### 2.4 Seed data

- Tag every public-domain hymn from Phase 1 with 1–3 references (e.g. It Is Well → `PHP.4.7`, Amazing Grace → `EPH.2.8`). Write these as human-chosen data in `scripts/hymns.js`, reviewed by the owner, not generated.

### Done when

- [ ] Song pages show references and expandable passages with attribution
- [ ] Works with no `YOUVERSION_APP_KEY` set (fallback path tested)
- [ ] No verse text in any database table
- [ ] Tests cover bad refs (400), rate limit (429), API timeout (fallback), and that the key never appears in any response body

## Phase 3: Song search and YouTube playback

A user types "carry my cross" and gets one ranked list mixing native songs and official worship videos; native ones play through the Ainos pipeline, YouTube ones in a visible embed. Every search hits the Ainos database first; YouTube is searched only on a miss.

**Budget that shapes everything:** new YouTube projects get 100 `search.list` calls per day plus 10,000 units for other endpoints. `playlistItems.list` and `videos.list` cost 1 unit per call (up to 50 items each). So index channels in bulk and keep live search rare.

### 3.1 Curated channel list (manual, once)

- `scripts/worship-channels.js` exports an array of `{ handle, language }`, e.g. `@victoryworship` (en/tl), Hillsong, Elevation Worship, Bethel, CityAlight, plus Nepali, Hindi, Chinese, Japanese and Spanish worship ministries. The owner maintains this list; Claude Code adds only channels the owner names, and verifies each is the official channel.
- On first sync, each handle is resolved to a channel id and uploads playlist id with `channels.list?forHandle=` (1 unit) and stored in `youtube_channels`.

### 3.2 Sync job `scripts/sync-youtube.js` + cron route

1. For each enabled channel (resume from `sync_page_token`), call `playlistItems.list` on its uploads playlist, 50 per page.
2. Collect video ids; call `videos.list?part=snippet,contentDetails,status&id=` in batches of 50 for title, channel, thumbnail, duration and `status.embeddable`.
3. Upsert `youtube_video_cache` (set `fetched_at`). For each embeddable video, find or create a `songs` row: match on folded title + artist against existing songs and `song_aliases`; otherwise create a song from a **cleaned internal title** (strip "(Official Lyric Video)", "| Victory Worship", "\[Live\]", etc.) with artist = channel display name. Insert a `song_sources` row (`kind` from the title: official/lyric/live).
4. **30-day rule:** in the same run, re-fetch `videos.list` for any cached video with `fetched_at` older than 25 days. Deleted, private or no-longer-embeddable videos → `song_sources.available = 0` and delete their `youtube_video_cache` row. Any cache row that cannot be refreshed within 30 days is deleted.
5. Track quota in `api_quota` (`bucket = 'yt_units'`). Stop the run cleanly before 8,000 units per day.
6. Write progress after every page (upserts only), so a timeout or overlapping run cannot corrupt data.

Run locally with `node scripts/sync-youtube.js`. In production, `vercel.json` gets a nightly cron calling `GET /api/cron/sync-youtube`, which:

- rejects any request whose `Authorization` header is not exactly `Bearer ${process.env.CRON_SECRET}` (constant-time compare) with 401;
- processes one channel (or a few) per invocation to stay within Vercel Function time limits, resuming next night via `sync_page_token`;
- returns a small JSON summary, never the API key.

Also add an admin-only route `POST /api/admin/youtube/import` taking a pasted YouTube URL: parse out the 11-char id with `youtubeId()`, fetch details with `videos.list`, attach to an existing or new song. Admin = a hard-coded allowlist of user ids in an env var or a new `is_admin` flag; check what the app has.

### 3.3 Search route `GET /api/search?q=&type=`

Extend the existing search route rather than adding a new one.

1. Validate `q`: trim, 1–100 chars. Fold it with the same folding used for `search_index.folded`. Escape `%` and `_` if `LIKE` is used.
2. **Path A — local:** one query over `search_index` covering native tracks, songs, song aliases (transliterations), and lyric lines from `song_sections` the user may see (global + their orgs). Also match Scripture (`?q=psalm 23` → parse to `PSA.23`) and themes (`advent`).
3. **Path B — live fallback** only if path A returns fewer than \~3 good song matches **and** the user is logged in (not demo) **and** the folded query is not in `search_cache` younger than 7 days **and** the daily cap (`YOUTUBE_DAILY_SEARCH_CAP`, default 80) is not reached:
   - call `search.list?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q=…&relevanceLanguage=<user language>`;
   - then `videos.list` for those ids (1 unit) to get duration and status;
   - store results (including an empty result) in `search_cache`; upsert videos and songs exactly as the sync job does, so the next search for it is path A;
   - per-user rate limit for path B: 10/hour, 30/day; per-IP 30/hour.
4. **Merge and rank:** text-match score, then boost curated-channel sources and songs in the user's language. Group duplicate videos (official, lyric, live) under one song result with a version list.
5. **Response shape** (Spotify-like, plus new fields):

```json
{ "songs": { "items": [ {
  "id": "<song id>", "uri": "ainos:song:<id>", "name": "Carry My Cross",
  "artist": { "name": "Victory Worship" }, "language": "en",
  "sources": [
    { "id": "<source id>", "source": "youtube", "playback": "embed", "kind": "official",
      "youtube": { "videoId": "…", "title": "<YouTube title, unmodified>",
                   "channelTitle": "…", "thumbnail": "https://i.ytimg.com/…", "duration_ms": 0 } },
    { "id": "…", "source": "ainos", "playback": "native", "track": { /* existing track object */ } }
  ] } ] },
  "tracks": { /* existing shape, unchanged */ } }
```

Existing response keys keep their shape so the current frontend does not break; `songs` is additive.

### 3.4 Playback

- **Native:** unchanged pipeline.
- **YouTube:** the now-playing panel swaps to a YouTube IFrame player, loaded from `https://www.youtube-nocookie.com/embed/<id>` via the IFrame API script `https://www.youtube.com/iframe_api`. Rules:
  - visible, at least 200 × 200 px, never covered by overlays, never hidden or shrunk to play audio only;
  - YouTube's own title and thumbnail shown unmodified wherever the video appears; Ainos's song record ("Carry My Cross · Victory Worship") is shown in lists and the player bar;
  - the existing player bar drives it via `playVideo`, `pauseVideo`, `seekTo`, `setVolume`; `onStateChange` ENDED advances the Ainos queue, so native and YouTube items share one queue;
  - no autoplay until more than half of the player is visible.
- Log a play event for YouTube sources (for recommendations) with `source: 'youtube'`; the 30-second rule can use the player's current time. No loudness or audio features exist for them; recommendation code must tolerate missing features.
- **Offline:** download option disabled for YouTube sources, with a tooltip via `t()`.
- **Connect:** the other device loads the same embed from the shared state.
- Spotify: optional "Open in Spotify" link on a song page if the owner adds a Spotify URL to the song; no SDK.

### 3.5 Library

- Playlists and Liked Songs accept `song_sources.id` items (Data model: playlist items change). Existing playlist tests must still pass unchanged.
- Unavailable sources (`available = 0`) show greyed out with "No longer available" and are skipped by the queue.

### 3.6 CSP and headers (both `SECURITY_HEADERS` and `vercel.json`)

Add only:

- `frame-src https://www.youtube-nocookie.com https://www.youtube.com`
- `script-src` += `https://www.youtube.com` (for `iframe_api`) and `https://s.ytimg.com` only if the IFrame API actually loads from it (check in the browser network tab)
- `img-src` += `https://i.ytimg.com`
- keep `Referrer-Policy: strict-origin-when-cross-origin` (Phase 0)

No `unsafe-inline`, no wildcards.

### Done when

- [ ] Searching "carry my cross" returns the Victory Worship song from the local index once its channel is synced, with zero YouTube search calls
- [ ] A song not in the index triggers exactly one live search, then is found locally on the next search
- [ ] YouTube songs play in a visible embed, controlled by the player bar, and advance the queue
- [ ] Cron route rejects requests without the secret; sync is resumable and idempotent
- [ ] Cache rows older than 30 days are refreshed or deleted (tested with a mocked clock)
- [ ] Demo user never triggers path B

## Phase 4: Synced lyrics

While a song plays, its lyrics show in the now-playing view and scroll along with the music, the current line highlighted, like Spotify's lyrics view. Lyrics are stored once as labelled sections plus an arrangement; the same data drives projection slides in Phase 6.

### 4.1 Lyrics model rules

- Section labels: `V1`…`V9`, `PC` (pre-chorus), `C`, `C2`, `B` (bridge), `T` (tag), `I` (intro, no lines), `E` (ending). Display names come from i18n (`t('section.V', {n})`).
- `lines` is newline-separated plain text. Max 12 lines per section, 120 chars per line, 30 sections per song per language. Reject anything else with 400.
- Global lyrics (`org_id IS NULL`) are only public-domain hymns or text the owner adds. Uniqueness for global rows needs a **partial unique index** `(song_id, language, label) WHERE org_id IS NULL` (SQLite and Postgres both support partial indexes), because `UNIQUE` treats NULLs as distinct.
- **Visibility:** a user sees global sections plus sections whose `org_id` is one of their orgs. A song can be global (e.g. "Carry My Cross" from YouTube) while its lyrics are private to each church that pasted them.

### 4.2 Lyrics paste parser `public/js/lyrics-parse.js` (pure, shared with server)

- Input: pasted text. Split on blank lines into blocks. A block's first line is a label if it matches (case-insensitive, any language list in i18n) `verse 1`, `v1`, `[Verse 1]`, `chorus`, `refrain`, `bridge`, `pre-chorus`, `tag`, `ending`, `intro`; otherwise auto-label `V1`, `V2`… in order and mark as "needs review".
- Repeated identical blocks become one section referenced twice in the arrangement.
- Output: `{ sections: [...], arrangement: ["V1","C","V2","C","B","C"] }` shown for confirmation before save. Unit-test with at least 10 messy pastes (extra spaces, Windows line endings, labels in brackets, Devanagari text, CJK text, no labels at all).
- Run the same parser server-side to validate; never trust the client's parse.

### 4.3 Slide splitter `server/slides.js` (pure, used by Phase 6)

- `toSlides(sections, arrangement, { maxLines: 2 | 3 | 4 })` → ordered slides `{ id, label, lines[], sectionIndex, repeatIndex, startMs? }`.
- Splits a section into slides of at most `maxLines`, never splitting mid-line; balances the last slide (5 lines with max 4 → 3 + 2, not 4 + 1).
- When timings exist for the chosen source, each slide gets `startMs` = the time of its first line (used by automatic projection).
- Deterministic slide ids (`${label}-${repeatIndex}-${n}`).

### 4.4 Timings

- **Native hymns:** the generator knows when every melody note starts. Emit `lyric_timings` automatically from `scripts/hymns.js` (line start times from the melody), written by the generator and `seed-postgres.js` idempotently. No hand timing.
- **YouTube and other recordings: tap-to-sync.** A leader plays the source and taps (button or Space) at the start of each line; the UI records `ms` per line, allows nudging ±100 ms per line and a global `offset_ms`, then saves to `lyric_timings` for that `source_id`. Timings belong to one specific recording, never to the song.
- Timings made from org lyrics are org-scoped.

### 4.5 Lyrics view

- A "Lyrics" button in the player bar opens the lyrics view in the now-playing panel (and full-screen on mobile), for whichever source is playing, native or YouTube.
- **With timings:** the current line is highlighted and auto-scrolls into the middle of the view; past lines dimmed. Clicking a line seeks to it (`audio.currentTime` for native, `seekTo` for YouTube). If the user scrolls manually, auto-scroll pauses until they tap "Back to current line" or 5 seconds pass.
- **Without timings:** the lyrics show as static text in arrangement order, with a note (via `t()`) that synced lyrics aren't available for this version; leaders see a "Sync lyrics" link to tap-to-sync.
- **No lyrics:** the button is disabled with a tooltip.
- Sync loop uses `requestAnimationFrame` (or the YouTube player's current time polled at \~4 Hz), never `setInterval` faster than needed; stops when the view is closed.
- The lyrics view works for the listener demo with the public-domain hymns.

### 4.6 Routes

| Method + path | Who | Purpose |
| --- | --- | --- |
| `GET /api/songs/:id?lang=` | any logged-in, demo | Song + visible sections + arrangements + sources |
| `PUT /api/songs/:id/sections` | global admin, or org `leader`/`admin` for `org_id` rows | Replace sections for one language and org; body validated with the parser |
| `POST /api/songs/:id/arrangements` / `PATCH /api/arrangements/:id` / `DELETE …` | same | Manage arrangements; `section_order` labels must exist |
| `GET /api/sources/:id/timings?lang=` | any logged-in, demo | Timings visible to the user |
| `PUT /api/sources/:id/timings` | global admin or org `leader`+ | Save tap-to-sync result; ≤ 400 entries; `ms` strictly increasing, ≤ source duration |
| `POST /api/songs` | org `leader`+ | Create an org song by hand (title, artist, language, CCLI number) |

Every write is audit-logged when `org_id` is set. All org checks use the Phase 5 `requireRole` helper; until Phase 5 ships, only global admin writes exist.

### Done when

- [ ] Every Phase 1 hymn shows synced lyrics that follow playback
- [ ] Clicking a line seeks; manual scroll pauses auto-scroll
- [ ] Paste → review → save works for messy input in at least en, ne, hi, zh
- [ ] Tap-to-sync saves timings for a YouTube source and the lyrics view follows it on replay
- [ ] Org lyrics are invisible to non-members (tested)

## Phase 5: Church accounts and setlists

A church is an organization with members and roles. Its lyrics, arrangements, timings and setlists are private to its members. This phase carries the biggest new security risk: one church reading or editing another's data.

### 5.1 Roles

| Action | admin | leader | operator | member |
| --- | --- | --- | --- | --- |
| View org setlists and org lyrics | ✓ | ✓ | ✓ | ✓ |
| Create/edit songs, lyrics, arrangements, timings | ✓ | ✓ | — | — |
| Create/edit/delete setlists | ✓ | ✓ | — | — |
| Present a setlist (projection) | ✓ | ✓ | ✓ | — |
| Invite, remove members, change roles | ✓ | — | — | — |
| Rename or delete the org | ✓ | — | — | — |

Implement as one table in code, `ROLE_CAN = { 'setlist.edit': ['admin','leader'], … }`, not scattered `if` statements.

### 5.2 Access helper (one place, used everywhere)

- `server/orgs.js` exports `requireRole(store, user, orgId, permission)`: loads `org_members` for `(orgId, user.id)` from the database, checks `ROLE_CAN[permission]`, returns the membership, otherwise throws `HttpError(404)` (404, not 403, so a non-member cannot learn the org exists).
- Every org-scoped query carries the org in its `WHERE`: `WHERE id = ? AND org_id = ?`. Never fetch by id and check afterwards. An org id sent by the client is only ever used as input to `requireRole`, never trusted on its own.
- Child objects (setlist items, presentations, org sections, timings) are always loaded through their org: e.g. a setlist item update joins `setlists` and checks `setlists.org_id`.
- An org must always keep at least one admin: refuse removing or demoting the last admin (409).
- `noDemo` on every org write and on org creation.

### 5.3 Invites

- Token: 32 random bytes from `node:crypto`, base64url. Store only its SHA-256 hash in `org_invites.token_hash`. Show the link (`/join/<token>`) once, to the admin who made it.
- Defaults: expires in 7 days; `max_uses` 1 for `admin`/`leader` invites, 25 for `member`; role fixed per invite. Revocable (`revoked_at`).
- Redeem: `POST /api/invites/redeem { token }` → must be logged in; constant-time compare via hash lookup; check expiry, revoked, uses; insert membership in a transaction that increments `uses`. Rate limit: 10 attempts/hour per IP and per user. Generic error message for every failure.
- Audit-log create, redeem, revoke.

### 5.4 Setlists

- A setlist = ordered items: `song` (with arrangement and preferred source), `scripture` (USFM ref; text from Phase 2 at show time), `text` (call to worship, announcement; ≤ 500 chars), `blank`.
- Reordering uses the same deferred `(setlist_id, position)` unique-constraint pattern as playlists; copy that code path rather than inventing a new one.
- Limits: 40 items per setlist, 500 setlists per org.

### 5.5 Account and privacy

- Member data stored: user id, display name, role, join date. No phone numbers, birthdays or addresses. No public member lists; members see names only within their own org.
- `DELETE /api/me` (account deletion) removes memberships, timings and drafts the user created that are not org-owned, and anonymizes `audit_log.user_id`. Org-owned content stays with the org.
- `POST /api/sessions/revoke-all` ("log out all devices") deletes every session for the user.
- Church admins: offer two-factor auth and require a verified email **only if** the app already sends email; otherwise list both under Open questions and do not build an email sender in this phase.

### 5.6 Routes

| Method + path | Permission |
| --- | --- |
| `POST /api/orgs` | logged in, not demo (creator becomes admin) |
| `GET /api/me/orgs` | logged in |
| `GET /api/orgs/:orgId` · `PATCH` · `DELETE` | member · `org.edit` · `org.delete` |
| `GET /api/orgs/:orgId/members` · `PATCH /members/:userId` · `DELETE /members/:userId` | member · `members.manage` · `members.manage` (or self, to leave) |
| `POST /api/orgs/:orgId/invites` · `GET` · `DELETE /invites/:id` | `members.manage` |
| `POST /api/invites/redeem` | logged in, not demo |
| `GET/POST /api/orgs/:orgId/setlists` · `GET/PATCH/DELETE /setlists/:id` | member (read) · `setlist.edit` (write) |
| `PUT /api/orgs/:orgId/setlists/:id/items` | `setlist.edit` |
| `GET /api/orgs/:orgId/setlists/:id/slides` | `projection.run` (returns the slides for the Present dialog) |
| `GET /api/orgs/:orgId/audit` | admin |

Frontend: a church switcher in the sidebar, Members, Setlists and Songs pages, all using `h()` and `t()`.

### 5.7 Church demo account

Visitors can try the whole church side without signing up, the same way the listener demo (`demo` / `ainos-demo`) works today. The church demo lives entirely inside one seeded demo church and resets when the next visitor starts it.

**Login**

- A second shared account, `church-demo` / `ainos-church-demo` (confirm under Open questions), and a "Try the church demo" button on the login page next to the existing demo button.
- **Reuse the existing demo reset mechanism.** Read how the `demo` account resets today and extend it to the church demo; do not write a second reset system.
- On login, the church demo user lands on the demo church's Setlists page with a banner (via `t()`): this is a shared demo and changes reset for the next visitor.

**Seeded demo church**

- One org, "Ainos Demo Church" (name from i18n), with deterministic ids from `seededId('demo-church:…')`, written idempotently by both the SQLite generator path and `seed-postgres.js`.
- **Reset** = in one transaction, delete every row whose `org_id` is the demo org (sections, arrangements, timings, setlists, items, audit rows), then re-run the demo seed.
- Seeded content (public-domain only, no copyrighted lyrics, nothing taken from YouTube):
  - 6–8 Phase 1 hymns with lyrics, arrangements and auto-generated timings, so both projection modes work;
  - one setlist dated next Sunday (computed at reset time): 4 songs, 1 Scripture reading, 1 text item ("Welcome"), 1 blank;
  - three placeholder members with display names only ("Demo Leader", "Demo Operator", "Demo Member"); they are not real accounts and cannot log in.

**Role preview**

- A banner control, "Viewing as: Admin ▾", lets the visitor switch between admin, leader, operator and member to see what each role can do.
- Enforced on the server, never only in the UI: the demo session stores `demoRole`; `requireRole` uses it **only** when the user is the church demo account **and** the org is the demo org. For every other org and user it is ignored. Tested.

**Allowed inside the demo church**

- Paste and edit lyrics, arrangements and tap-to-sync timings; build and edit setlists; present a setlist in either mode, on this screen or in presenter view.

**Not allowed (403 with a friendly `t()` message)**

- Create another org; see, join or search any other org.
- Create or redeem invites (the invite screen shows why it is disabled); add or remove real members; delete or rename the demo org.
- Uploads (Phase 7), live YouTube search (path B), account deletion, password change, "log out all devices".

Normal text size limits apply, and pasted demo content is wiped at reset. Like the listener demo, concurrent visitors share one state until the next reset.

### Done when

- [ ] Cross-tenant tests pass: a member of church A gets 404 on every read, write and delete of church B's songs, lyrics, setlists, items, invites, members and audit log
- [ ] Role tests pass for every row of the roles table
- [ ] Last-admin protection, invite expiry/revocation/use limits, and redemption rate limits tested
- [ ] Listener demo account cannot create or join a church
- [ ] Church demo: login works, role preview is enforced server-side and only in the demo org, reset restores the seed, every forbidden action returns 403

## Phase 6: Projection (presentation mode)

Projection works like presenting a PowerPoint deck. A leader clicks **Present** on a setlist, chooses where to present and how slides advance, and the lyrics show as full-screen slides. Nothing else is in scope for this phase.

### 6.1 The Present dialog

A **Present** button on every setlist (and on a single song page) opens a dialog with two choices:

1. **Where**
   - **Present on this screen:** the current window goes full screen and shows the slides, like PowerPoint's slideshow. `Esc` exits.
   - **Presenter view (use another screen):** this window becomes the presenter view and a second window shows the slides full screen on the other display (a projector or TV), like PowerPoint's presenter view.
2. **Mode**
   - **Manual:** slides advance only when the presenter clicks or presses a key.
   - **Automatic:** the song plays and the slides advance by themselves, following that song's synced lyrics (Phase 4 timings).

Then **Start**.

### 6.2 Slides

- Built from the setlist items with `server/slides.js` (Phase 4): songs → lyric slides in arrangement order; `scripture` → the passage text (Phase 2) with its attribution line; `text` → one slide; `blank` → a black slide.
- White text on black, auto-fitted so every line fits the screen with a margin. No other styling options.
- CSP: no inline `style=` attributes; set font size with CSSOM (`el.style.setProperty('--slide-size', …)`) and stylesheet classes.
- Full screen via the Fullscreen API on the user's click.

### 6.3 Presenter view (two screens)

- The presenter window shows the current slide, the next slide, and a strip of all slides to click and jump to.
- The slides window is opened by the presenter window. Where the browser supports the Window Management API (`window.getScreenDetails()`, Chromium), ask permission and open it full screen on the other display automatically. Otherwise open it as a normal window with a "Click to go full screen" prompt the user drags onto the projector.
- The two windows stay in sync with `BroadcastChannel('ainos-present-' + sessionId)`. No server round trip and no database table: the presentation lives only in the browser while it runs.

### 6.4 Manual mode

- Next: click, `→`, `↓`, `PageDown`, `Space`. Previous: `←`, `↑`, `PageUp`. Presentation clickers send PageUp/PageDown, so they work with no setup.
- In presenter view, clicking any slide in the strip jumps to it.

### 6.5 Automatic mode

- Each song plays from its chosen source and slides advance when playback reaches each slide's `startMs`. Non-song items (Scripture, text, blank) wait for a click, then the next song starts.
- Available only for songs whose chosen source has timings. If some songs in the setlist lack timings, the dialog says which ones and those songs fall back to manual; if none have timings, the Automatic option is disabled.
- The presenter can pause, or click forward/back at any time; a manual click on a song re-syncs playback to that slide's `startMs`.
- **YouTube sources:** the YouTube player must stay visible (at least 200 × 200 px, not covered). In presenter view it sits in the presenter window; on "this screen" it sits visibly in a corner of the slideshow. It is never hidden to play audio only.

### 6.6 Permissions

- Church setlists: only org roles with `projection.run` (admin, leader, operator) see the Present button.
- Church demo: works fully inside the demo church.

### Done when

- [ ] Present on this screen runs a full setlist in manual mode with keyboard and clicker
- [ ] Presenter view drives a second window on another display, staying in sync
- [ ] Automatic mode advances slides with a native hymn's timings and with a tap-synced YouTube song
- [ ] Songs without timings fall back to manual, and the dialog explains it
- [ ] Members without `projection.run`, and members of other churches, cannot start a presentation (tested)

## Phase 7 (later): Verified artist and church uploads

Verified churches and independent worship artists can publish original songs they own, especially in languages big platforms underserve. Do not start this phase until Phases 0–6 are live and the owner approves it; it is the riskiest feature in the spec.

### 7.1 Who can upload

- Only orgs with `verified = 1` (add the column in this phase, re-runnable migration). Verification is manual: the owner approves an application (`POST /api/orgs/:orgId/verification-request`, reviewed in an admin page). No self-service verification.
- Within a verified org, only `admin` and `leader` roles may upload.

### 7.2 Upload flow

1. **Rights statement:** before upload, the uploader confirms in a checkbox with fixed text (in i18n) that they own or control both the recording and the song, or the song is public domain. Store the exact statement text and timestamp in `uploads`.
2. **Upload:** client requests a short-lived signed upload URL from `POST /api/uploads` (validates declared size ≤ 50 MB and type `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/flac`, `audio/ogg`); the file goes to a **private** Supabase Storage bucket (`UPLOAD_BUCKET`) under `pending/<uploadId>`. The browser never holds a service key.
3. **Processing (isolated job, not the main API function):** check the real file signature (magic bytes), not the name or `Content-Type`; reject files over 15 minutes; decode and **re-encode** to the app's own format with a known-good encoder, which also strips metadata and malformed data; run the existing `loudness.js` (BS.1770) to store `loudness_lufs`; store duration. Any failure → `status = 'rejected'` with a reason.
4. **Review queue:** `status = 'pending'` until the owner approves in an admin page; approved files move to `approved/<id>` and get a `songs` + `song_sources` row (add `'upload'` to the `source` CHECK in a re-runnable migration).
5. **Serving:** only through signed, expiring URLs. Extend `signMediaPath`/`verifyMediaSignature` in `server/auth.js` **and** `middleware.js` together to cover the new storage path. Uploaded audio never goes through `scripts/generate.js` or the static audio folder, which must stay deterministic.

### 7.3 Takedown

- A public "Report a problem" form on every uploaded song (copyright or abuse), rate-limited, creating a report row for the owner.
- `POST /api/admin/uploads/:id/remove` sets `status = 'removed'`, marks sources unavailable immediately, and audit-logs it. Repeat infringers lose upload rights.
- Publish a short copyright and takedown policy page (owner writes the text).

### Done when

- [ ] Only verified orgs can upload; demo and unverified orgs get 403
- [ ] A renamed non-audio file (e.g. `.exe` renamed to `.mp3`) is rejected by signature check
- [ ] Uploaded audio plays only via signed URLs and at normalized loudness
- [ ] Nothing is public before approval; removal takes effect immediately

## Security requirements

The existing base stays: scrypt passwords, sessions, rate limits, HMAC-signed media URLs, a strict CSP, and RLS on with no policies. The checklist below is what the new features add. Each item names the phase that must ship it; a phase is not done until its items are tested.

| # | Requirement | Phase | Where |
| --- | --- | --- | --- |
| S1 | Every org-scoped route goes through `requireRole`; org id in the SQL `WHERE`; 404 for non-members | 5 | `server/orgs.js`, all org routes |
| S2 | Cross-tenant test for every org resource (read, write, delete) | 5 | `test/orgs.test.js` |
| S3 | Least-privilege roles from one `ROLE_CAN` table; last admin cannot be removed | 5 | `server/orgs.js` |
| S4 | Invites: hashed tokens, expiry, use limits, revocation, redemption rate limit, generic errors | 5 | `org_invites`, invite routes |
| S5 | Audit log for every org write (who, what, when) | 0 / 5 | `audit_log`, `audit()` |
| S6 | Presentations: only roles with `projection.run` can load a setlist's slides; the presenter and slides windows sync only through a same-origin `BroadcastChannel`; screen-placement permission (Window Management API) is requested only after the user clicks Present | 6 | `/setlists/:id/slides`, `public/js/` |
| S7 | Stored-XSS defense: all user text (lyrics, titles, setlist text) rendered via `h()` with text nodes; no `innerHTML` anywhere | 4 / 5 / 6 | `public/js/` |
| S8 | Strict CSP preserved; only the YouTube origins in Phase 3.6 added; no `unsafe-inline`, no wildcards; changes mirrored in `vercel.json` | 3 | `SECURITY_HEADERS`, `vercel.json` |
| S9 | `Referrer-Policy: strict-origin-when-cross-origin` | 0 | both header lists |
| S10 | Size limits on every text field (titles ≤ 120, lines ≤ 120 chars, ≤ 12 lines/section, ≤ 30 sections, ≤ 40 setlist items, text items ≤ 500, search ≤ 100) | 0–6 | `server/validate.js` |
| S11 | Search input folded, length-capped, `LIKE` wildcards escaped | 3 | search route |
| S12 | API keys (YouTube, YouVersion, storage) only in server env vars; never in `public/`, HTML, logs or responses (tested) | 2 / 3 / 7 | env, `server/*` |
| S13 | YouTube key restricted in Google Cloud to the YouTube Data API only (owner action) | 3 | Google Cloud console |
| S14 | No open proxy: Scripture and search routes build upstream URLs server-side, validate input (USFM regex, video id regex) and are rate-limited | 2 / 3 | `scripture.js`, search |
| S15 | Quota-exhaustion defense: live YouTube search only for logged-in non-demo users, per-user and per-IP limits, negative-result caching, daily cap with a friendly "try again later" | 3 | search, `api_quota` |
| S16 | Cron route checks `Authorization: Bearer ${CRON_SECRET}` with a constant-time compare; sync is idempotent and resumable | 3 | `/api/cron/sync-youtube` |
| S17 | YouTube data refreshed or deleted within 30 days; video titles and thumbnails shown unmodified; the YouTube player is never hidden, including during automatic projection | 3 / 6 | sync job, UI |
| S18 | CSRF: `SameSite=Lax`/`Strict` cookies and `Origin` check on every state-changing method | 0 | `server/app.js` |
| S19 | Listener demo cannot create or join churches, upload, invite, or trigger live YouTube search. Church demo is confined to the demo church: role preview only there, no invites, uploads or live search (5.7) | 0–7 | `noDemo` |
| S20 | Account deletion and "log out all devices"; minimal member data; no public member lists (youth groups may include minors) | 5 | `/api/me`, sessions |
| S21 | Optional 2FA and verified email for church admins, only if email sending already exists | 5 | Open question |
| S22 | Uploads: magic-byte check, size and duration limits, re-encode in an isolated job, private bucket, signed URLs only, hidden until approved, takedown path | 7 | upload pipeline |
| S23 | Dependencies stay minimal (`pg`, `@vercel/functions`); `npm audit` in CI; lockfile committed | all | CI |
| S24 | Secret rotation plan for `AINOS_SECRET`, `CRON_SECRET`, API keys; signing accepts old + new secret during a short overlap | 0 | `auth.js`, `middleware.js`, README |
| S25 | Supabase backups on, and one test restore done (owner action) | 5 | Supabase dashboard |
| S26 | `scripts/smoke.js` checks security headers on every deploy | 0 | smoke test |

Priority if time is short: S1–S2 (tenant isolation) and S12–S16 (keys and quota) matter most the moment church accounts and YouTube search go live.

## Testing plan

Every suite uses `node:test` and `startTestServer()` / `login()` / `signup()` from `test/helpers.js`, runs on SQLite in a temp dir, and must pass with `--test-concurrency=1`. External APIs (YouTube, YouVersion) are never called in tests: inject a fake `fetch` into the modules (pass it as a parameter or module-level setter), and mock the clock for anything date-based.

| Suite | Phase | Covers |
| --- | --- | --- |
| `test/catalog-ids.test.js` (new) | 0 | Existing track ids unchanged; only appended ids allowed |
| `test/api.test.js` (extend) | 0 | CSRF origin check, demo guard, security headers on responses |
| `test/validate.test.js` (new) | 0 | Every validator: valid, boundary, invalid |
| `test/hymns.test.js` (new) | 1 | Every hymn has source + year before 1929, sections, a native track and a song row |
| `test/scripture.test.js` (new) | 2 | USFM validation, fallback with no key, timeout fallback, attribution present, key never in response |
| `test/search.test.js` (extend) | 3 | Path A only for indexed songs; path B once then cached; negative cache; demo never path B; quota cap; transliteration aliases; lyric-line and Scripture search; existing search results unchanged |
| `test/youtube-sync.test.js` (new) | 3 | Pagination + resume, idempotent upsert, title cleaning, 30-day refresh/delete with mocked clock, unavailable videos marked, cron secret required |
| `test/store.test.js` (extend) | 3 | Playlist items with `source_id`; existing playlist ordering and deferred unique constraint still work |
| `test/lyrics.test.js` (new) | 4 | Paste parser on ≥ 10 messy inputs (en, ne, hi, zh, CRLF, no labels); slide splitter balancing and `startMs`; timings validation; hymn timings generated for every hymn line |
| `test/orgs.test.js` (new) | 5 | Full roles matrix; cross-tenant 404 on every org resource; church demo (reset restores seed, role preview ignored outside the demo org, forbidden actions 403); last-admin rule; invites (expiry, revoke, max uses, rate limit); account deletion |
| `test/presentation.test.js` (new) | 6 | Slides endpoint permission and cross-tenant 404; slide building for every item kind; automatic-mode planner (which songs have timings, fallback to manual, slide index for a given playback time) as pure functions |
| `test/uploads.test.js` (new) | 7 | Verified-only; magic-byte rejection; pending invisible; removal immediate |
| `test/connect.test.js`, `loudness`, `recommend` (existing) | all | Must keep passing untouched; recommendation code tolerates tracks with no audio features |

Manual checks per phase (owner, in a browser): Phase 3 — play a YouTube song from search on desktop and phone; Phase 4 — synced lyrics follow a native hymn and a tap-synced YouTube song; Phase 6 — present a setlist on this screen and in presenter view with a second display, in both manual and automatic modes.

`scripts/smoke.js` gains, per phase: search returns `songs`; a Scripture route responds (fallback OK); the cron route returns 401 without the secret; the slides route returns 404 for a user outside the org.

## Open questions

Claude Code stops and asks the owner when it reaches one of these, rather than guessing. The owner ticks each once answered and writes the answer beside it.

- [ ] **Uncommitted work:** commit, stash or discard the in-progress changes from 2026-10-28 before Phase 0?
- [ ] **New catalog names:** approve the mapping in `scripts/catalog-names.js` (Phase 1.2).
- [ ] **Hymn list and translations:** which public-domain hymns, and which public-domain translations exist in hi, ne, zh, ja, es (Phase 1.1)?
- [ ] **Bible versions:** which versions the YouVersion App Key can use per language; default version per language (Phase 2).
- [ ] **Worship channels:** the exact official channel handles to index, per language (Phase 3.1).
- [ ] **Admin identity:** add an `is_admin` flag, or an env-var allowlist of user ids, for global admin actions (Phase 3.2)?
- [ ] **Playlist schema change:** add `source_id` to the existing playlist items table, or use a separate external-items table (Data model)?
- [ ] **Email:** does the app send email today? If not, skip verified email and 2FA for now, or add an email provider (Phase 5.5)?
- [ ] **Phase 7 go-ahead:** approve verified uploads, and write the copyright and takedown policy text.
- [ ] **Translations of new UI strings:** who reviews hi, ne, zh, ja, es strings added by each phase?
- [ ] **Church demo credentials:** confirm `church-demo` / `ainos-church-demo`, and the demo church's name (Phase 5.7).
- [ ] **Demo sharing:** keep the church demo shared like the listener demo, or give each visitor a private sandbox copy that expires (Phase 5.7)?

## Sources

The external rules this spec depends on. Re-check them before building the phase that relies on each, since quotas and terms change.

- [YouTube Data API overview: quota](https://developers.google.com/youtube/v3/getting-started) — 100 `search.list` calls/day plus 10,000 units for other endpoints by default (Phase 3)
- [YouTube API Services: Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) — embed ≥ 200 × 200 px, Referer identification, autoplay rules (Phases 0, 3)
- [Complying with YouTube's Developer Policies](https://developers.google.cn/youtube/terms/developer-policies-guide) — unmodified titles and thumbnails, user-data rules (Phase 3)
- [YouTube Analytics API docs: 30-day refresh-or-delete rule](https://developers.google.com/youtube/analytics/migration) (Phase 3)
- [Analysis of the 30-day rule and ID exemptions](https://singhamandeep.com/?p=1426) — no published exemption for video ids (Phase 3)
- [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) — Premium required, no commercial use without approval (Decisions)
- [Spotify Web API after the February 2026 changes](https://vorplabs.com/agent-tools/spotify-cli) — dev mode limits (Decisions)
- [YouVersion Platform Services review](https://learnofchrist.com/resources/youversion-platform-services) and [YouVersion Platform Core SDK overview](https://www.mintlify.com/youversion/platform-sdk-react/api/core/overview) — free App Key, `X-YVP-App-Key` header, per-version licenses (Phase 2)
- [CCLI SongSelect Partner API notes](https://git.stadtmission-butzbach.de/public/pp-planer/src/branch/master/CCLI-API.md) — partner program retired, automated retrieval forbidden (Decisions, Phase 4)
- [SongSelect and the Church Copyright Licence](https://creonline.co.uk/?p=5131) — projection is covered by the church's own licence (Decisions)
- [Tubefilter: YouTube shutting down Discord music bots](https://www.tubefilter.com/?p=161734) and [Is YouTube killing every Discord music bot?](https://www.shulex.com/blog/is-youtube-killing-every-discord-music-bot%3f-en-us) (Decisions)
- Repo: `context.md`, `README.md`, `docs/HOW-SPOTIFY-WORKS.md` — conventions, keep-in-sync table, gotchas (all phases)
