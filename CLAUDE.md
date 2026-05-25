# video-transcriber — Agent Guide

## Skills to auto-use

- **e2e-testing-local** — Invoke for localhost E2E runs, FE↔BE smoke tests on localhost, or pre-deploy verification ("run e2e locally", "smoke test local"). Enforces empty-state-as-pass and the Playwright-vs-curl split. Path: `~/.claude/skills/e2e-testing-local/SKILL.md`.
- **e2e-testing-prod** — Invoke for prod verification, post-deploy smoke tests, or release gating ("verify in prod", "test against prod URL"). Requires local E2E to have passed first; enforces the deploy-gate checks (SHA, migrations, env, restart) and credential-safety patterns. Path: `~/.claude/skills/e2e-testing-prod/SKILL.md`.

## Project layout

- Backend: this repo (`video-transcriber`), Node/TypeScript, deployed on Railway as services `api` and `worker`. Prod URL: `https://video-transcriber-production-bdad.up.railway.app`.
- Frontend: sibling repo `ai-engineer-recap-fe` (Next.js, Vercel). Prod URL: `https://v0-ai-engineer-recap-fe.vercel.app`. Dev port `3001`, API on `3000`.
- DB: Supabase project ref `igipysgaetatphocjwkk`. Migrations live in `src/db/migrations/`. Local Docker Postgres on `localhost:54329`.

## Running locally

Two terminals, both with `.envrc` sourced:

```bash
# Terminal A
run_local npm run dev:worker
# Terminal B
run_local npm run dev
```

`run_local` unlocks the `dev-secrets` keychain — it requires an interactive terminal, so if you (the agent) try to start the server in a non-interactive shell it will hang on the password prompt. Ask the user to start it, or test against prod.

## Secrets

- `.envrc` resolves secrets through keychain helpers (`supabase_conn`, etc.) — do not export plaintext secrets. See memory `feedback_secret_exposure.md`.
- On Railway: set via `value | railway variable set KEY --stdin --service S --json`. Verify with `railway run --service S -- bash -c 'echo len=${#KEY}'` (length only — never echo the value).
- Service restarts are required after env changes; check deploy timestamp.

## Testing discipline

- TDD across both repos — failing test first, then implementation. See memory `feedback_tdd.md`.
- E2E runbook: `docs/e2e-retest-guide.md` (single-video pipeline) and the e2e-testing-local-then-prod skill (process + safety rails).

## Known infra gotchas

- **Supabase pooler URL** contains `uselibpqcompat`, which libpq rejects. Strip with `sed 's/[?&]uselibpqcompat[^&]*//g; s/?$//'` before passing to local `psql`. Prefer `railway run -- psql "$DB_URL"` inside the BE service instead.
- **yt-dlp from Railway IPs** gets "Sign in to confirm you're not a bot" even with valid cookies (datacenter IP block). Local works fine.
- **Migration drift**: code deploy is independent of schema. Always run Phase B (deploy gate) verification before declaring prod ready.
