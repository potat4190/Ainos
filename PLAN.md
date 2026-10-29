# Plan: AINOS-SPEC.md Phases 0–6

Made 2026-10-29 from the spec plus a read of the code. One task = one commit; one branch per phase.
`PROGRESS.md` records what is done; this file records what each task is. If the two disagree,
`PROGRESS.md` and the commits win. Phase 7 is out of scope until the owner approves it.

Shorthand used below:

- **SYNC-DB** — `server/db.js` (SCHEMA + `migrate()`) and `server/schema.pg.sql`, including the
  `GRANT` block, the RLS `ARRAY[...]`, and a parser-safe table body: one column per line, closing
  `);` alone on its line, no table-level constraint lines unless the deploy parser skips them.
- **SYNC-HDR** — `SECURITY_HEADERS` in `server/app.js` and `headers` in `vercel.json`.
- **I18N** — `public/js/i18n.js`, all six languages.
- **SW** — `public/sw.js` `SHELL_FILES` plus a `SHELL` version bump.
- **WIPE** — the `resetDemo` wipe list in `server/demo.js`.
- Every new route gets a success, an auth-failure and a validation-failure test.

## Where the spec and the code disagree, and how this plan resolves it

| Spec says | Code has | Resolution |
| --- | --- | --- |
| Add a CSRF `Origin` check | One exists (`server/app.js` `sameOrigin`), comparing host only | Harden it (scheme + host, trust `x-forwarded-host` only behind the proxy) and test every method |
| `user_id TEXT`, `created_by TEXT` | `users.id` is INTEGER (BIGINT identity in Postgres) | New user columns are INTEGER / BIGINT |
| Playlist items table backs Liked Songs too | Liked Songs is `liked_tracks`, PK `(user_id, track_id)` | Owner question; proposal: `source_id` on `playlist_tracks`, new `liked_sources` table |
| Adding tracks is fine | `seed-postgres.js` refuses any id difference and never writes to a seeded database | P1.6: upsert mode when existing ids ⊆ generated ids, catalog rows only, gated so previews do not write |
| Table-level `UNIQUE` / `CHECK` in table definitions | The deploy schema check reads the first word of every line as a column | P0.9: parser skips constraint lines; multi-column uniques as `CREATE UNIQUE INDEX` |
| Rate limits per hour and per day | `purgeRateLimits` drops windows after 1 hour | P0.7: purge after 25 hours |
| HSTS present in production | No HSTS in the repo; a test ties both header lists together | Owner question; proposal: rely on Vercel's platform HSTS, smoke-check it on https |
| YouTube player always visible | Right panel is rebuilt on every player change and hidden on narrow screens | P3.11: a persistent `#yt-stage` outside the rebuilt panel, placed per breakpoint by CSS |
| New `songs` search group | The search page already labels tracks "Songs" | Owner question; proposal: new group "Songs", old group "Tracks" |
| `seededId('demo-church:…')` | `seededId` takes a PRNG | `seededId(mulberry32(hashSeed('demo-church:…')))` |
| `t('demo.notAllowed')` thrown by the server | The server has no i18n | Server returns `code: 'demo_not_allowed'`; the client maps codes to `t()` |
| `song_sections` arrives in Phase 4 | Phase 1 hymns need lyrics | Create `song_sections` in Phase 1 |
| Church demo seeded by generator and `seed-postgres.js` | Member user ids are identity integers that differ per database | Seed the demo church at runtime, idempotently, from the demo reset |
| Admin decided in Phase 3.2 | `PUT /api/songs/:id/scripture` (Phase 2) needs it | Decide the admin model before Phase 2 |

## Phase 0 — `phase-0-baseline`

- **P0.1** Add `PROGRESS.md` and `PLAN.md`.
- **P0.2** Catalog snapshot test: `test/catalog-ids.test.js`, `test/fixtures/track-ids.json` (33 sorted ids), plus a fingerprint of artist, album and editorial ids and a hash of each generated audio file, so later renames provably leave ids and audio alone. Lands before anything touches `generate.js`.
- **P0.3** Fix: add `/js/crossfade.js` to the service-worker shell (offline boot fails without it); `test/shell.test.js` asserts every `public/js/*.js` is in `SHELL_FILES`. SW.
- **P0.4** `Referrer-Policy: strict-origin-when-cross-origin`. SYNC-HDR. (S9)
- **P0.5** Harden the same-origin check and cookie flags (`Secure` on the clearing cookie too); tests for cross-origin POST/PUT/PATCH/DELETE, `Origin: null`, scheme mismatch. (S18)
- **P0.6** `server/validate.js`: `str`, `int`, `oneOf`, `usfmRef`, `youtubeId`; `test/validate.test.js`. (S10)
- **P0.7** `rateLimit(store, key, {limit, windowSec})` throwing 429 with `Retry-After`; `HttpError` gains `headers`; purge after 25 h.
- **P0.8** `isDemo` / `isChurchDemo` / `noDemo`; signup refuses the reserved demo usernames; client maps `demo_not_allowed`. I18N. (S19)
- **P0.9** Deploy schema parser skips constraint lines; `test/schema.test.js` checks SQLite and Postgres columns match and every table has RLS and a grant.
- **P0.10** `audit_log` table and `audit()` helper. SYNC-DB. (S5)
- **P0.11** Secret rotation: media signatures accept `AINOS_SECRET_PREVIOUS` during an overlap, in `server/auth.js` and `middleware.js`; README rotation plan. (S24)
- **P0.12** Smoke test checks security headers on `/` and `/api/...`. (S26)
- **P0.13** Document the spec's env vars in `context.md` and `README.md`, marked by phase.
- **P0.14** (if approved) GitHub Actions CI: `npm test` and `npm audit`. (S23)

## Phase 1 — `phase-1-catalog`

- **P1.1** Song tables: `songs`, `song_aliases`, `song_themes`, `song_sources`, `song_sections` (with `folded`; partial unique index for global rows). Closed theme list in `server/songs.js`. SYNC-DB.
- **P1.2** Synth: exported melody renderer with 3/4 support and a pure `melodyTimeline()`; existing styles untouched (P0.2 proves audio unchanged).
- **P1.3** `scripts/hymns.js`: at least 8 public-domain hymns with words/tune authors, years, sources, meter, tempo, key, notes, sections, themes. `test/hymns.test.js`.
- **P1.4** Demo snapshot picks independent of display names and new artists.
- **P1.5** Append the hymn album in a separate seeded block in `generate.js` (ids from `hashSeed('hymn:'+slug)`), writing tracks, files, search rows, songs, sources, sections, themes. Append to the id fixture.
- **P1.6** `seed-postgres.js` upsert mode for appended catalog rows on an already-seeded database; display columns only; gated (owner decision on previews).
- **P1.7** `scripts/catalog-names.js`: display names separate from seed keys; snapshot proves ids and audio unchanged. Owner approves names before production.
- **P1.8** Update `docs/HOW-SPOTIFY-WORKS.md` for renamed tracks.
- **P1.9** Remove most "Christian" adjectives from UI copy (I18N, `index.html` title/meta).

## Phase 2 — `phase-2-scripture`

- **P2.1** `song_scripture` and `user_settings` tables. SYNC-DB, WIPE.
- **P2.2** Hymn Scripture references in `scripts/hymns.js` (owner review).
- **P2.3** Bundled public-domain fallback text for referenced passages and the verse-of-the-day list.
- **P2.4** `server/scripture.js`: YouVersion client with injectable `fetch`, 5 s timeout, license-aware LRU, attribution, fallback. `test/scripture.test.js`. (S12, S14)
- **P2.5** Global admin check (model chosen by the owner).
- **P2.6** Routes: `GET /api/scripture/votd`, `GET /api/scripture/:ref`, `GET`/`PUT /api/songs/:id/scripture`, `GET`/`PUT /api/me/settings`. Smoke.
- **P2.7** UI: Scripture card (now playing + song page), Verse of the Day, Bible version picker. I18N, SW.

## Phase 3 — `phase-3-youtube`

- **P3.1** `youtube_video_cache`, `youtube_channels`, `search_cache`, `api_quota`. SYNC-DB.
- **P3.2** `server/youtube.js`: client with quota accounting, title cleaning, kind detection, duration parsing.
- **P3.3** Resumable, idempotent channel sync (`server/youtube-sync.js`, `scripts/sync-youtube.js`, `scripts/worship-channels.js`) with the 30-day rule. `test/youtube-sync.test.js`.
- **P3.4** `GET /api/cron/sync-youtube` behind `CRON_SECRET` (constant-time); `vercel.json` crons. (S16)
- **P3.5** `POST /api/admin/youtube/import`.
- **P3.6** Search path A: songs, aliases, lyric lines, Scripture refs, themes; additive `songs` key; `LIKE` escaping. (S11)
- **P3.7** Search path B: live YouTube fallback with caps, per-user/IP limits, negative cache, never for demo. (S15)
- **P3.8** CSP: YouTube frame/script/img origins only. SYNC-HDR. (S8)
- **P3.9** Events and Connect accept YouTube sources; recommender tolerates missing features.
- **P3.10** Player media-engine seam (no behavior change). SW.
- **P3.11** YouTube engine in a persistent, always-visible embed (≥ 200 × 200 at every breakpoint), queue shared with native tracks. (S17)
- **P3.12** Mixed song results in search with YouTube metadata unmodified.
- **P3.13** Playlists and Liked Songs accept YouTube sources (schema per owner decision). WIPE.
- **P3.14** (optional) "Open in Spotify" link.

## Phase 4 — `phase-4-lyrics`

- **P4.1** `song_arrangements`, `lyric_timings`. SYNC-DB.
- **P4.2** `public/js/lyrics-parse.js` paste parser (shared with server); ≥ 10 messy pastes in `test/lyrics.test.js`.
- **P4.3** `server/slides.js` slide splitter.
- **P4.4** Hymn arrangements and timings generated from the melody.
- **P4.5** Song, sections, arrangements and timings routes.
- **P4.6** Synced lyrics view in the now-playing panel. (S7)
- **P4.7** Paste-review-save and tap-to-sync editors.

## Phase 5 — `phase-5-churches`

- **P5.1** `orgs`, `org_members`, `org_invites`, `setlists`, `setlist_items`; session demo role. SYNC-DB.
- **P5.2** `server/orgs.js`: `ROLE_CAN`, `requireRole` (404 for non-members), visible org ids. (S1, S3)
- **P5.3** Org and member routes, last-admin rule, audit. `test/orgs.test.js` cross-tenant. (S2, S5)
- **P5.4** Invites: hashed tokens, expiry, max uses, revoke, redemption rate limit. (S4)
- **P5.5** Setlists and items (deferred position constraint like playlists).
- **P5.6** Org-scoped songs, lyrics, timings; `POST /api/songs`.
- **P5.7** `GET /api/orgs/:orgId/audit`.
- **P5.8** `DELETE /api/me`, `POST /api/sessions/revoke-all`. (S20)
- **P5.9** Church demo: reset via the existing demo reset, server-side role preview confined to the demo org. (S19)
- **P5.10** Church switcher, Members, Setlists, Songs pages, join page. I18N, SW.
- **P5.11** Church demo button, banner, role switcher.

## Phase 6 — `phase-6-projection`

- **P6.1** `GET /api/orgs/:orgId/setlists/:id/slides` gated by `projection.run`. `test/presentation.test.js`. (S6)
- **P6.2** Pure automatic-mode planner.
- **P6.3** Present on this screen, manual mode (keyboard, clicker).
- **P6.4** Presenter view over `BroadcastChannel`, Window Management API after the click.
- **P6.5** Automatic mode for native and YouTube sources, player visible. (S17)
- **P6.6** Present button on the song page.

## After every phase (process, not commits except fixes)

Correctness review and security review by fresh subagents → fixes → re-review until clean →
`node scripts/smoke.js` against a Vercel preview → update `PROGRESS.md` → summary → stop.
