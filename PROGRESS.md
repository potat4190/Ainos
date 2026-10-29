# Progress
Last updated: 2026-10-29 · Current phase: 0 · Branch: phase-0-baseline

## Done (newest first)
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
- Phase 0: reviews done and findings fixed (89 tests pass). Remaining: push `phase-0-baseline`, run `node scripts/smoke.js <preview url>` against the Vercel preview (blocked on Q3–Q5), then the owner reviews and merges (see "Before merging Phase 0" below). Then Phase 1 on `phase-1-catalog`, starting with P1.1 (song tables); P1.3/P1.7 need Q9/Q10 answers.

## Open questions and answers
Numbers match the batch asked on 2026-10-29 (full wording in that chat; summary here).
- Q1 `.claude/launch.json` untracked: gitignore `.claude/`? → yes (default), done
- Q2 Spec "uncommitted work": already committed in 8b708bf, mark closed? → waiting
- Q3 Push `phase-N-*` branches to GitHub for Vercel previews + PR per phase (never `main`)? → (2026-10-29) Yes: push each phase branch and open a PR to `main`. Never push or merge to `main`; the owner merges every PR after review. Branch protection is on for `main`.
- Q4 Is `DATABASE_MIGRATION_URL` set for Preview builds? Separate Preview database possible? → (2026-10-29) Owner created a separate Supabase project, "ainos-preview", for previews; Claude finishes its setup (Vercel Preview variables via stdin, schema + seed, verify RLS). Follow-up answers (2026-10-29): create `ainos_app` in ainos-preview with a generated password piped straight into Vercel; `DATABASE_URL` = transaction pooler as `ainos_app`, `DATABASE_MIGRATION_URL` = session pooler as `postgres`; replace Preview `DATABASE_URL` and `AINOS_SECRET`; leave the shared `DATABASE_CA_CERT` (confirm the connection with the local `prod-ca-2021.crt`); add Preview `DATABASE_MIGRATION_URL`. No SQL for production's `ainos_app` exists (none in the repo or its history either): use the proposed grants and report them; never connect to production to inspect it. Status under "Blocked / skipped".
- Q5 Preview protection: may I read `VERCEL_AUTOMATION_BYPASS_SECRET` from `.env.vercel.local`? → (2026-10-29) Previews are protected. Never read any `.env*` file; read `VERCEL_AUTOMATION_BYPASS_SECRET` from the environment (ask if missing). Run smoke tests only against previews, never production without asking.
- Q6 HSTS: rely on Vercel's platform header (smoke checks it) or add our own? → waiting
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
- SECURITY (2026-10-29): a repo-wide grep by Claude Code did not exclude `.env*` files and printed the production `DATABASE_URL` line (with the `ainos_app` password) from `.env.vercel.local` into the session transcript. Not written to any file, commit or service. Owner action: rotate production `ainos_app`'s password, update Vercel Production `DATABASE_URL`, redeploy. Separately, a password-like string was quoted in chat earlier; the owner reset the preview database password.
- P0.14 CI workflow — waiting on Q7
- Phase 0 preview deploy + smoke run — waiting on the preview database setup (below). Do not push a phase branch until Preview's `DATABASE_URL` points at "ainos-preview", or the preview build would connect to production.
- Preview database "ainos-preview" setup (2026-10-29), step (a) findings reported to the owner, waiting:
  - Inputs: `PREVIEW_DB_PASSWORD` is now visible to the session. CA file: `Downloads/prod-ca-2021.crt` (confirmed). Still missing: the transaction and session pooler URLs (both answers arrived with the placeholder text instead of the URLs).
  - Vercel Preview today: `DATABASE_URL` (Preview only, 7 days old, presumably the shared production DB), `AINOS_SECRET` (Preview only), `DATABASE_CA_CERT` (one entry shared by Preview and Production). No `DATABASE_MIGRATION_URL`. Replacing the two Preview-only ones needs the owner's OK.
  - Differs from the owner's plan: production's app connects as the restricted role `ainos_app`, with only `DATABASE_MIGRATION_URL` as the owner. Proposed: create `ainos_app` in ainos-preview with a generated password and the same grants, `DATABASE_URL` = transaction pooler as `ainos_app`, `DATABASE_MIGRATION_URL` = session pooler as `postgres`. Keep `DATABASE_CA_CERT` as is (same Supabase CA). Seed from a freshly generated catalog, not `data/ainos.db` (local accounts).
- Before merging Phase 0 to `main` (owner):
  1. `audit_log` must exist in the live database first, or the production build's schema check fails: either `DATABASE_MIGRATION_URL` is set for Production builds, or run `server/schema.pg.sql` in the Supabase SQL editor (safe to re-run).
  2. Check no real user already has the name `church-demo` (read-only: `SELECT id FROM users WHERE lower(username) = 'church-demo'`); this branch treats that name as a demo account (Q20).

## Review follow-ups deliberately left for later
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
- Preview and Production share one Supabase database; the smoke test resets the live demo account.
