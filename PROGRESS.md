# Progress
Last updated: 2026-10-29 · Current phase: 0 · Branch: phase-0-baseline

## Done (newest first)
- 2026-10-29 Setup · repo mapped, plan written to `PLAN.md` · commit (this one)

## Next
- Waiting for the owner's answers to the questions below, then P0.2: catalog snapshot test (`test/catalog-ids.test.js`, `test/fixtures/track-ids.json`).

## Open questions and answers
- Uncommitted work from 2026-10-28 → already committed in 8b708bf ("Share rate limits, fold search text, keep playlist positions unique"); only `.claude/launch.json` (a local Claude Code run config) is untracked → waiting: confirm, and say whether to gitignore it
- All spec "Open questions" and the planning questions → waiting (asked 2026-10-29)

## Blocked / skipped
- (none yet)

## Notes for the next session
- Baseline before any spec work: `npm test` = 57 tests, all pass (Node 24.22).
- `PLAN.md` lists every task (P0.1 … P6.6), the spec-vs-code conflicts and how each is resolved.
- The deploy schema check (`schemaColumns()` in `scripts/seed-postgres.js`) reads the first word of every line inside `CREATE TABLE IF NOT EXISTS x (...)` as a column name. Never put table-level `UNIQUE`/`CHECK` lines in a table body until P0.9 lands.
- New Postgres tables need a `GRANT` to `ainos_app` and an entry in the RLS array in `schema.pg.sql`, or the deploy check fails.
- `users.id` is an integer; `seededId()` takes a PRNG (`seededId(mulberry32(hashSeed('…')))`).
- Preview and Production share one Supabase database; the smoke test resets the live demo account.
