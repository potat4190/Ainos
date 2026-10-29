# Progress
Last updated: 2026-10-29 · Current phase: 0 · Branch: phase-0-baseline

## Done (newest first)
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
- Phase 0 end: correctness review + security review (fresh subagents), fix findings, then preview deploy + smoke (blocked on Q3–Q5).

## Open questions and answers
Numbers match the batch asked on 2026-10-29 (full wording in that chat; summary here).
- Q1 `.claude/launch.json` untracked: gitignore `.claude/`? → yes (default), done
- Q2 Spec "uncommitted work": already committed in 8b708bf, mark closed? → waiting
- Q3 Push `phase-N-*` branches to GitHub for Vercel previews + PR per phase (never `main`)? → waiting
- Q4 Is `DATABASE_MIGRATION_URL` set for Preview builds? Separate Preview database possible? → waiting
- Q5 Preview protection: may I read `VERCEL_AUTOMATION_BYPASS_SECRET` from `.env.vercel.local`? → waiting
- Q6 HSTS: rely on Vercel's platform header (smoke checks it) or add our own? → waiting
- Q7 GitHub Actions CI (`npm test` + `npm audit`)? → waiting
- Q8 Global admin: `is_admin` column or env allowlist of user ids? → waiting (needed by Phase 2)
- Q9 New catalog names: I draft `scripts/catalog-names.js` or owner supplies? → waiting
- Q10 Hymn list (Amazing Grace, Be Thou My Vision, It Is Well, Holy Holy Holy, Come Thou Fount, All Hail the Power, Rock of Ages, Abide with Me); translations English-only? → waiting
- Q11 Hymn length: ~2 verses (90–120 s) or full? → waiting
- Q12 Cover art shows new names; rename editorial playlists too? → waiting
- Q13 Who reviews new hi/ne/zh/ja/es strings? → waiting
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
- P0.14 CI workflow — waiting on Q7
- Phase 0 preview deploy + smoke run — waiting on Q3, Q4, Q5

## Notes for the next session
- Baseline before any spec work: `npm test` = 57 tests, all pass (Node 24.22). After Phase 0 tasks: 86.
- `church-demo` is the assumed church demo username (Q20 pending); it is a constant in `server/demo.js` and reserved at signup.
- P0.14 (CI) not done; the plan's other Phase 0 tasks are committed.
- `PLAN.md` lists every task (P0.1 … P6.6), the spec-vs-code conflicts and how each is resolved.
- The deploy schema check (`schemaColumns()` in `scripts/seed-postgres.js`) reads the first word of every line inside `CREATE TABLE IF NOT EXISTS x (...)` as a column name. Never put table-level `UNIQUE`/`CHECK` lines in a table body until P0.9 lands.
- New Postgres tables need a `GRANT` to `ainos_app` and an entry in the RLS array in `schema.pg.sql`, or the deploy check fails.
- `users.id` is an integer; `seededId()` takes a PRNG (`seededId(mulberry32(hashSeed('…')))`).
- Preview and Production share one Supabase database; the smoke test resets the live demo account.
