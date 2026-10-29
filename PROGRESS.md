# Progress
Last updated: 2026-10-29 · Current phase: 1 · Branch: phase-1-catalog

## Done (newest first)
- 2026-10-29 Phase 1 · review fix: docs (sync, separate preview DB, generator-owned songs), Acoustic genre label, Holy Holy Holy note, hymn count · commit 7ac4a2b
- 2026-10-29 Phase 1 · review fix: sync refreshes hymn measurements, prunes dropped lyrics, appends editorial tracks, guards owned rows, previews warn on older branches; verified on preview Postgres · commit 8c5e86a
- 2026-10-29 Phase 1 · reviews round 1 (fresh subagents): correctness found no defects in the invariants, 3 medium operational issues; security nothing high/medium, 5 lows; fixed or recorded below
- 2026-10-29 Phase 1 · P1.7 wiring: generate.js uses picked display names (none picked yet → catalog byte-identical); tests hold for any picks · commit 1651db9
- 2026-10-29 Phase 1 · catalog sync verified on the preview Postgres with the hymns: 143 rows added, 0 updated; second run 0/0 (idempotent)
- 2026-10-29 Phase 1 · P1.5 hymn album, songs, lyrics, arrangements, Hymns playlist appended (snapshot: additions only); translations + review rows · commit 59dc01c
- 2026-10-29 Phase 1 · P1.3 `scripts/hymns.js`: 8 sourced public-domain hymns; `test/hymns.test.js` · commit d24ec99
- 2026-10-29 Phase 1 · P1.9 "Christian" adjectives removed from UI copy (20 keys × 6 languages, editorial descriptions, index.html); review rows in docs/i18n-review.md; guard test · commit 6e0c7c4
- 2026-10-29 Phase 1 · P1.6 seed-postgres catalog sync (seed / sync / refuse; display-only upserts); verified on the preview Postgres · commit 9e04e57
- 2026-10-29 Phase 1 · P1.4 demo snapshot independent of names and the hymnal · commit cd1b3de
- 2026-10-29 Phase 1 · P1.2 melody renderer (melodyTimeline, renderMelody) · commit daea83d
- 2026-10-29 Phase 1 · P1.1 song tables (+ song_sections and song_arrangements early, owner Q11) · commit bd7a4ee
- 2026-10-29 Phase 0 · MERGED: owner asked Claude to merge PR #2 → merge commit d6c724d on `main`; production deploy Ready (build log: schema up to date, already seeded with 33 tracks; owner had applied `audit_log`). No smoke test against production (owner rule).
- 2026-10-29 Phase 1 · P1.7 (draft only) `scripts/catalog-names.js`: 2 Scripture-based options per artist/album/track for owner approval; nothing uses it until picked; `test/catalog-names.test.js` · commit a6c3d46
- 2026-10-29 Phase 0 · DONE: pushed `phase-0-baseline`, PR #2 to `main`; preview build (commit 5ceb4b2) migrated the preview database (build log: schema applied, schema up to date, already seeded with 33 tracks); `scripts/smoke.js` against the preview: all checks passed, security headers included (HSTS comes from Vercel, which settles Q6)
- 2026-10-29 Preview database "ainos-preview" set up and Vercel Preview variables replaced (details under "Blocked / skipped") · commit 5ceb4b2
- 2026-10-29 Owner answers Q9–Q13 recorded; `docs/i18n-review.md` started · commit 896d061 (on phase-0-baseline)
- 2026-10-29 Phase 0 · final-review fix: forwarded addresses with ports; strict audit user ids; whole-second limiter windows · commit 49b86bf
- 2026-10-29 Phase 0 · final-review fix: `str()` keeps Hebrew CGJ, emoji flag tags, Mongolian/braille separators; non-empty text must show something · commit 1e14afb
- 2026-10-29 Phase 0 · review round 3 (one fresh reviewer, correctness + security, on the round-2 fixes): nothing medium or higher; lows fixed above
- 2026-10-29 Phase 0 · re-review fix: header check refuses unsafe script-src-elem/-attr/default-src · commit 260d79e
- 2026-10-29 Phase 0 · re-review fix: option checks for both limiters; windows capped at one day · commit 1a20051
- 2026-10-29 Phase 0 · re-review fix: `audit()` drops NUL, cuts by code point, keeps Dates, numeric user ids · commit b760da3
- 2026-10-29 Phase 0 · re-review fix: `str()` normalizes after stripping; fuller invisible list (fillers, tags); VT/FF/NEL; collapse spaces · commit 374552f
- 2026-10-29 Phase 0 · re-review fix (medium): per-IP limits use the rightmost X-Forwarded-For entry, validated · commit 9199a2b
- 2026-10-29 Phase 0 · re-review fix (medium): full-length audio hashes for one track per style (`renderMastered()`) · commit c56ebf8
- 2026-10-29 Phase 0 · reviews round 2 (fresh subagents): correctness found no defects, one coverage gap; security found one medium (introduced by the TRUST_PROXY fix); all fixed above
- 2026-10-29 Phase 0 · review fix: smoke header check tolerates duplicate headers, checks frame-ancestors + COOP · commit 4ec7c62
- 2026-10-29 Phase 0 · review fix: refuse cross-site (Sec-Fetch-Site) API requests on every method; text/plain only on /api/events · commit c5df342
- 2026-10-29 Phase 0 · review fix: forwarded headers trusted only behind a proxy; `TRUST_PROXY=1` for self-hosting; README leaked-secret note · commit e2d1e30
- 2026-10-29 Phase 0 · review fix: `audit()` survives any details value; clipped fields; commit-path test · commit df801bf
- 2026-10-29 Phase 0 · review fix: canonical `usfmRef`; `str()` strips invisible/bidi chars, NFC, line breaks → spaces · commit 48112b8
- 2026-10-29 Phase 0 · review fix: `noDemo` fails closed without a user · commit b92ff29
- 2026-10-29 Phase 0 · review fix: `rateLimit()` refuses bad options; purge per window type · commit 57ccef7
- 2026-10-29 Phase 0 · review fix: snapshot full-length audio inputs (`trackParams()`) + exact test WAV hashes · commit bf3b4b7
- 2026-10-29 Phase 0 · reviews round 1: correctness + security (fresh subagents); findings fixed above
- 2026-10-29 Phase 0 · P0.13 env vars + helpers documented in context.md / README · commit 6f9a00b
- 2026-10-29 Phase 0 · P0.12 smoke test checks security headers; smoke script tested locally · commit 0fffcf6
- 2026-10-29 Phase 0 · P0.11 media secret rotation (`AINOS_SECRET_PREVIOUS`, server + middleware), README plan · commit 91bba0e
- 2026-10-29 Phase 0 · P0.10 `audit_log` table + `audit()` · commit a371332
- 2026-10-29 Phase 0 · P0.9 deploy schema parser skips constraint lines; schema sync test · commit 18ac464
- 2026-10-29 Phase 0 · P0.8 `noDemo` guard for `demo` + `church-demo`; demo names reserved at signup; i18n parity test · commit 33de595
- 2026-10-29 Phase 0 · P0.7 `rateLimit()` with Retry-After; purge after 25 h · commit 686bf66
- 2026-10-29 Phase 0 · P0.6 `server/validate.js` · commit 8df3b6d
- 2026-10-29 Phase 0 · P0.5 CSRF check compares full origin; Secure logout cookie · commit 34a3a98
- 2026-10-29 Phase 0 · P0.4 Referrer-Policy strict-origin-when-cross-origin · commit ec1df2f
- 2026-10-29 Phase 0 · P0.3 fix: crossfade.js in the service-worker shell · commit 7452ac9
- 2026-10-29 Phase 0 · P0.2 catalog id + audio-input snapshot test · commit 4f83374
- 2026-10-29 Phase 0 · gitignore `.claude/` (owner Q1) · commit 96b9e0f
- 2026-10-29 Setup · repo mapped, plan written to `PLAN.md` · commit 03a55de

## Next
- Phase 1 end: correctness + security reviews (fresh subagents), fixes, push `phase-1-catalog`, PR, preview smoke, stop for owner review.
- Waiting on the owner: name picks in `scripts/catalog-names.js` (then P1.8: update names in docs/HOW-SPOTIFY-WORKS.md), and listening to the 8 hymns on the preview before they ship.

## Open questions and answers
- NEW (2026-10-29) Come, Thou Fount lyrics: the research used Robinson's original 1759 wording (4 stanzas, e.g. "Mount of God's unchanging Love", "Seal it from thy Courts above"); the familiar 3-stanza wording from the 1921 tune source is listed in that hymn's notes. Which should ship? → (2026-10-29) the familiar 3-stanza text, as printed with the tune in The Voice of Thanksgiving No. 3 (1921), No. 258 (transcribed from the page scan); the 1759 original is kept in the hymn's notes
- NEW (2026-10-29) Amazing Grace ships the 4 stanzas printed in Coronation Hymns (1910): Newton's 1–3 plus the later public-domain "When we've been there ten thousand years"; Newton's stanzas 4–6 are in its notes. Abide with Me ships the 5 stanzas printed in 1905 (Lyte's 1, 2, 6, 7, 8). OK? → (2026-10-29) yes to both: Amazing Grace as printed in 1910; Abide with Me the 5 printed stanzas
- NEW (2026-10-29) Be Thou My Vision: SLANE in the 1909 folk rhythm (Joyce, the tune's first printing) or the 1919/1927 hymn rhythm? → (2026-10-29) the 1909 folk original, as researched
Numbers match the batch asked on 2026-10-29 (full wording in that chat; summary here).
- Q1 `.claude/launch.json` untracked: gitignore `.claude/`? → yes (default), done
- Q2 Spec "uncommitted work": already committed in 8b708bf, mark closed? → waiting
- Q3 Push `phase-N-*` branches to GitHub for Vercel previews + PR per phase (never `main`)? → (2026-10-29) Yes: push each phase branch and open a PR to `main`. Never push or merge to `main`; the owner merges every PR after review. Branch protection is on for `main`. (For PR #2 the owner explicitly asked Claude to merge; that does not extend to later PRs.)
- Q4 Is `DATABASE_MIGRATION_URL` set for Preview builds? Separate Preview database possible? → (2026-10-29) Owner created a separate Supabase project, "ainos-preview", for previews; Claude finishes its setup (Vercel Preview variables via stdin, schema + seed, verify RLS). Follow-up answers (2026-10-29): create `ainos_app` in ainos-preview with a generated password piped straight into Vercel; `DATABASE_URL` = transaction pooler as `ainos_app`, `DATABASE_MIGRATION_URL` = session pooler as `postgres`; replace Preview `DATABASE_URL` and `AINOS_SECRET`; leave the shared `DATABASE_CA_CERT` (confirm the connection with the local `prod-ca-2021.crt`); add Preview `DATABASE_MIGRATION_URL`. No SQL for production's `ainos_app` exists (none in the repo or its history either): use the proposed grants and report them; never connect to production to inspect it. Status under "Blocked / skipped".
- Q5 Preview protection: may I read `VERCEL_AUTOMATION_BYPASS_SECRET` from `.env.vercel.local`? → (2026-10-29) Previews are protected. Never read any `.env*` file; read `VERCEL_AUTOMATION_BYPASS_SECRET` from the environment (ask if missing). Run smoke tests only against previews, never production without asking.
- Q6 HSTS: rely on Vercel's platform header (smoke checks it) or add our own? → settled by the preview smoke test: Vercel sends HSTS on previews; no header change needed
- Q7 GitHub Actions CI (`npm test` + `npm audit`)? → waiting
- Q8 Global admin: `is_admin` column or env allowlist of user ids? → waiting (needed by Phase 2)
- Q9 New catalog names: I draft `scripts/catalog-names.js` or owner supplies? → (2026-10-29) Claude drafts it for approval. Brief: titles from Scripture and worship themes (psalms, Gospels, grace, light, the cross); artist names clearly fictional and never close to real worship bands; 2 options per item so the owner picks. Do not deploy until approved.
- Q10 Hymn list (Amazing Grace, Be Thou My Vision, It Is Well, Holy Holy Holy, Come Thou Fount, All Hail the Power, Rock of Ages, Abide with Me); translations English-only? → (2026-10-29) All 8 approved. Use the original public-domain tune for each, not a modern hymnal arrangement or harmonization; check each melody against a scan of an old public-domain hymnal (e.g. Hymnary.org), not memory alone; record the source for each in `scripts/hymns.js`. Owner listens before they ship. English only for now.
- Q11 Hymn length: ~2 verses (90–120 s) or full? → (2026-10-29) Two verses of audio per hymn, but store ALL public-domain verses as lyrics (sections + arrangement) so churches can project the full hymn in manual mode; automatic mode covers only the verses with audio and timings. Same audio encoding settings as the existing catalog.
- Q12 Cover art shows new names; rename editorial playlists too? → (2026-10-29) Keep editorial playlist names and ids; only clean their descriptions per spec 1.3. Add one new "Hymns" playlist containing the new hymn album.
- Q13 Who reviews new hi/ne/zh/ja/es strings? → (2026-10-29) Claude translates and flags every new key for native review, and keeps a running list in `docs/i18n-review.md` (per language: key, English, translation).
- Q14 YouVersion key and default version per language; fallback WEB or KJV; English-only book names in search? → waiting
- Q15 Playlist schema: `source_id` on `playlist_tracks` + `liked_sources` table, or separate table? → waiting
- Q16 Official YouTube channel handles per language → waiting
- Q17 Search labels: new "Songs" group, old one renamed "Tracks"? → waiting
- Q18 YouTube plays logged as events only (not streams/recommendations) for now? → waiting
- Q19 No email today: skip verified email and 2FA? → waiting
- Q20 Church demo `church-demo` / `ainos-church-demo`, "Ainos Demo Church"; does `church-demo` exist in prod? → waiting
- Q21 Church demo shared or per-visitor sandbox? → waiting
- Q22 Last admin deleting their account: block (409) or delete the org? → waiting
- Q23 Invite links at `#/join/<token>`? → waiting
- Q24 Demo setlist "next Sunday" in the visitor's time zone (UTC fallback)? → waiting
- Q25 Section-label words in other languages for the lyrics parser, flagged for review? → waiting
- Q26 Phase 7 stays off until approved → noted

## Blocked / skipped
- Before merging Phase 1 to `main` (owner):
  1. Listen to the 8 hymns on the Phase 1 preview (owner Q10). Changes are fine before or after merging: the sync refreshes hymn measurements and lyrics; only removing a hymn after it reaches production is a manual data migration.
  2. Apply `server/schema.pg.sql` to production (Supabase SQL editor; safe to re-run; it adds the six song tables), or set `DATABASE_MIGRATION_URL` for Production builds. Otherwise the build's schema check fails on `songs`.
  3. Check that production's `ainos_app` may write the catalog tables, since every deploy now syncs the catalog as that role (read-only check): `SELECT t, has_table_privilege('ainos_app', t, 'SELECT,INSERT,UPDATE') FROM unnest(ARRAY['artists','albums','tracks','track_files','playlists','playlist_tracks','search_index']) AS t;` and `has_table_privilege('ainos_app', 'song_sections', 'DELETE')` after step 2. If any is false, grant it (or say so and Claude adds the grants to schema.pg.sql).
  4. Production `ainos_app` password rotation (Phase 0 incident) if not done yet.
- After Phase 1 is in production, a git revert of it would fail production builds (Postgres would have hymn tracks the build no longer generates); use Vercel's instant rollback instead, which doesn't rebuild.
- SECURITY (2026-10-29): a repo-wide grep by Claude Code did not exclude `.env*` files and printed the production `DATABASE_URL` line (with the `ainos_app` password) from `.env.vercel.local` into the session transcript. Not written to any file, commit or service. Owner action: rotate production `ainos_app`'s password, update Vercel Production `DATABASE_URL`, redeploy. Separately, a password-like string was quoted in chat earlier; the owner reset the preview database password.
- P0.14 CI workflow — waiting on Q7
- Preview database "ainos-preview": set up 2026-10-29 (done):
  - Supabase project "ainos-preview". Schema applied from `server/schema.pg.sql` as `postgres`; seeded as `ainos_app` from a freshly generated full catalog (`{"seeded":true}`: 8 artists, 11 albums, 33 tracks, 66 track files, 301 users, 7 playlists, 76 playlist tracks, 663 likes, 2 follows, 15,369 streams, 58 search rows; 16 tables).
  - Verified: all 16 public tables have row-level security on and 0 policies; TLS 1.3 to the pooler with the certificate verified against `prod-ca-2021.crt` (an unrelated CA is refused).
  - Role `ainos_app` (no SQL for production's existed in the repo or its history): `LOGIN BYPASSRLS`, password generated and piped straight to Vercel; `GRANT USAGE ON SCHEMA public`; `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`; `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public`; no default privileges (new tables get grants from schema.pg.sql's GRANT block, as in production). BYPASSRLS is needed because RLS is on with no policies: without it the seed was refused; production's `ainos_app` must have it too for the app to work. Not superuser, createdb or createrole.
  - Connections: `DATABASE_URL` = shared pooler, transaction mode (port 6543) as `ainos_app.<ref>`. The dedicated pooler host the owner gave is IPv6-only, which Vercel Functions cannot reach. `DATABASE_MIGRATION_URL` = shared pooler, session mode (port 5432) as `postgres.<ref>`.
  - Vercel Preview variables now: `DATABASE_URL` (replaced), `DATABASE_MIGRATION_URL` (new), `AINOS_SECRET` (replaced, new random 48 bytes), `DATABASE_CA_CERT` (unchanged, shared with Production). No Production or Development variable changed.
- Before merging Phase 0 to `main` (owner):
  1. `audit_log` must exist in the live database first, or the production build's schema check fails: either `DATABASE_MIGRATION_URL` is set for Production builds, or run `server/schema.pg.sql` in the Supabase SQL editor (safe to re-run).
  2. Check no real user already has the name `church-demo` (read-only: `SELECT id FROM users WHERE lower(username) = 'church-demo'`); this branch treats that name as a demo account (Q20).

## Review follow-ups deliberately left for later
- Phase 3: `song_sources_youtube` is unique across all songs; before churches add YouTube sources, decide whether one video row is shared or uniqueness is per song (and avoid leaking "someone already has it").
- Phase 3: search folds keep ’ and ' distinct; harmless today (search terms split on letters only) but normalize if lyric/alias search starts matching across apostrophes. `songs.artist` is "Ainos Hymnal", so searching a hymn writer's name needs the author in an alias or search text.
- Phase 3/4: the generator owns its hymns' lyrics, themes and arrangements (refreshed and pruned on every deploy); admin edits to them must go to scripts/hymns.js, not the database.
- Phase 5: new song rows by churches must never reuse a generator id (ids are deterministic and public); the sync's target guards already skip church rows.
- After the owner approves the hymn audio: add full-length hymn WAV hashes to the catalog snapshot (today only the 6-second test renders are hashed).
- Optional hardening: revoke Supabase's default anon/authenticated privileges on public tables (RLS already blocks them; same as every existing table); run the sync over DATABASE_MIGRATION_URL when set, so ainos_app could be read-only on catalog tables.
- docs/i18n-review.md is served publicly at /docs/i18n-review.md (nothing sensitive); move it if the owner prefers.
- `audit_log` keeps DELETE in its grant: the spec's church-demo reset (5.7) deletes the demo org's audit rows. Revisit in Phase 5 (e.g. column grants) if that changes.
- `errRateLimited` says "wait a minute", and the client ignores `Retry-After`; fix when Phase 2 adds per-day limits.
- Per-IP limits treat each IPv6 address separately (a /64 gives many); consider keying IPv6 by /64 when per-IP limits matter (Phase 3 path B, Phase 5 invites).
- Any demo visitor can trigger `/api/internals/retrain` (global 2/min); restricting it is a user-facing change, so not in Phase 0.
- `usfmRef` accepts the 66 Protestant books only (no deuterocanon); revisit if a Bible version needs them (Phase 2).
- Local dev: DNS rebinding could let a page reach `127.0.0.1:4321` with matching Host/Origin; it gets no victim cookie. Optional host allowlist later.
- Pre-existing, noted by review, not changed in Phase 0: media URL `exp` has no upper bound (a leaked URL could be signed far ahead only by someone holding the secret); `demo` / `ainos-demo` works in production because `seed-postgres.js` copies the generated demo password hash (README documents the password login as intended; owner may want it off in prod); `/api/internals` shows Node version and uptime to any signed-in user; the media middleware's 403 has no security headers (JSON body).
- Old browsers without `Sec-Fetch-Site` (Safari < 16.4) still let a cross-site link open `GET /api/connect/dealer` with the Lax cookie (nuisance only: a ghost Connect device).
- `str()` NFC also maps CJK compatibility ideographs to unified forms (standard trade-off).

## Notes for the next session
- Hymn research rules (owner Q10): original public-domain tune only (top voice, no modern arrangement); melody checked against a pre-1929 hymnal scan (e.g. Hymnary.org page images) plus the incipit and a MIDI/MusicXML where possible; words and tune before 1929; every stanza as printed in a cited source; record sources in scripts/hymns.js. Hymnary's MIDI/MusicXML downloads are bot-blocked for curl; CCEL MIDI files worked.
- Secrets (owner rule, 2026-10-29): never read `.env*` files, and exclude them from every search (`--exclude='.env*'`, or the Grep tool with a glob). Never echo, quote or reconstruct a secret in chat, even as an example; use placeholders like [YOUR-PASSWORD]. Secrets go to Vercel only through stdin.
- Every new UI string: add it to all six languages in `public/js/i18n.js` AND a row per language in `docs/i18n-review.md` (Q13).
- New "Hymns" editorial playlist (Q12): its id must come from its own seed (like the hymn tracks), not the global `rnd`, so existing editorial ids stay unchanged (snapshot test).
- Baseline before any spec work: `npm test` = 57 tests, all pass (Node 24.22). After Phase 0 tasks: 86.
- `church-demo` is the assumed church demo username (Q20 pending); it is a constant in `server/demo.js` and reserved at signup.
- P0.14 (CI) not done; the plan's other Phase 0 tasks are committed.
- Tooling gotcha: the Write/Edit tools can turn backslash-u escapes for invisible characters (e.g. the one for U+200B) into the literal characters, which then break regex literals or hide in strings. After writing such escapes, run a scan for literal U+0080–U+009F, U+00AD, U+0300–U+036F, U+061C, U+200B–U+200F, U+2028–U+2029, U+202A–U+202E, U+2060–U+206F, U+3164, U+FEFF, U+E0000–U+E007F in changed files (not i18n.js, whose Indic strings may legitimately contain ZWJ/ZWNJ).
- Commit only through a "run `npm test`, commit only if it exits 0" step; one commit (P0.8) was briefly made red and amended before anything was pushed.
- `PLAN.md` lists every task (P0.1 … P6.6), the spec-vs-code conflicts and how each is resolved.
- The deploy schema check (`schemaColumns()` in `scripts/seed-postgres.js`) reads the first word of every line inside `CREATE TABLE IF NOT EXISTS x (...)` as a column name. Never put table-level `UNIQUE`/`CHECK` lines in a table body until P0.9 lands.
- New Postgres tables need a `GRANT` to `ainos_app` and an entry in the RLS array in `schema.pg.sql`, or the deploy check fails.
- `users.id` is an integer; `seededId()` takes a PRNG (`seededId(mulberry32(hashSeed('…')))`).
- Preview and Production have separate Supabase databases since 2026-10-29 ("ainos-preview" for previews); a smoke test resets the demo account of the database it runs against.
