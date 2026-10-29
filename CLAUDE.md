# Ainos — instructions for Claude Code

Ainos is a Christian worship and praise streaming app (Node.js ≥ 22.13, ES modules, no framework,
no build step; SQLite locally, Supabase Postgres + Vercel in production). See `context.md` for the
architecture, conventions and gotchas, and `README.md` for setup and deploy.

## Current work: the implementation spec

This repo is being built out from `AINOS-SPEC.md` (Phases 0–6; Phase 7 only with the owner's approval).

At the start of every session, before any work:

1. Read `AINOS-SPEC.md`, `PROGRESS.md` (if it exists) and `git log --oneline -20`; check `git status`.
2. Continue from the "Next" item in `PROGRESS.md`. Don't redo finished work, and don't rely on
   memory of earlier sessions: `PROGRESS.md` and the commits are the record.
3. Update `PROGRESS.md` after every task: done items with commit sha, the next task, open questions
   and answers, blockers, and notes for the next session.
4. When the owner answers a question or makes a decision in chat, write it into `PROGRESS.md`.
5. At the end of each phase: two fresh-subagent reviews (correctness + security), fix findings,
   smoke test against a Vercel preview, update `PROGRESS.md`, summarize, and stop for review.

## Hard rules

- Existing track ids must never change (see the id-snapshot test from Phase 0).
- `server/schema.pg.sql` runs on every deploy: every statement must be safe to re-run; wrap changes
  to existing tables in `DO $$ ... $$` checks.
- Schema changes go in both `server/db.js` and `server/schema.pg.sql`. Header/CSP changes go in both
  `SECURITY_HEADERS` (`server/app.js`) and `vercel.json`. UI strings go in all six languages in
  `public/js/i18n.js`, used via `t('key')`.
- One SQL dialect: `?` placeholders, `inList()` for `IN (...)`, async store calls.
- DOM only via `h()` from `public/js/ui.js`. No `innerHTML`, inline scripts, inline styles or
  inline event handlers (strict CSP).
- No new npm dependencies without asking the owner.
- No YouTube audio extraction, no Spotify SDK, no SongSelect scraping, no copyrighted lyrics in seed
  data. The YouTube player is always visible.
- Never commit secrets or `.env*` files. Never deploy to production, push to `main`, or run anything
  destructive against the live Supabase database without asking the owner.
- Never commit with failing tests, and never weaken or delete a test to make it pass.

## Commands

- `npm start` / `npm run dev` — local server at http://127.0.0.1:4321
- `npm test` — `node:test` suites in `test/` (run with `--test-concurrency=1`)
- `npm run setup` — wipe and regenerate `data/`
- `node scripts/smoke.js <url>` — end-to-end check against a deployment
