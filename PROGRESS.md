# Progress
Last updated: 2026-10-29 · Current phase: 0 · Branch: phase-0-baseline

## Done (newest first)
- 2026-10-29 Phase 0 · gitignore `.claude/` (owner Q1) · commit (this one)
- 2026-10-29 Setup · repo mapped, plan written to `PLAN.md` · commit 03a55de

## Next
- P0.2: catalog snapshot test (`test/catalog-ids.test.js`, `test/fixtures/track-ids.json`).

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
- Baseline before any spec work: `npm test` = 57 tests, all pass (Node 24.22).
- `PLAN.md` lists every task (P0.1 … P6.6), the spec-vs-code conflicts and how each is resolved.
- The deploy schema check (`schemaColumns()` in `scripts/seed-postgres.js`) reads the first word of every line inside `CREATE TABLE IF NOT EXISTS x (...)` as a column name. Never put table-level `UNIQUE`/`CHECK` lines in a table body until P0.9 lands.
- New Postgres tables need a `GRANT` to `ainos_app` and an entry in the RLS array in `schema.pg.sql`, or the deploy check fails.
- `users.id` is an integer; `seededId()` takes a PRNG (`seededId(mulberry32(hashSeed('…')))`).
- Preview and Production share one Supabase database; the smoke test resets the live demo account.
