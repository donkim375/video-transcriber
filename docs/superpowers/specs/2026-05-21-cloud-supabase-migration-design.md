# Cloud Migration: Railway + Supabase

**Status:** Design approved. Implementation plan to follow.
**Date:** 2026-05-21
**Owner:** donkim

## Goal

Move the video-transcriber from a fully local stack (Docker Postgres + localhost
Node processes + macOS-keychain secrets) to a hosted production deployment:

- **Compute:** Railway, two services (`api` + `worker`) — config already in `railway.toml`.
- **Database:** Supabase Postgres 16 with `pgvector` — replaces local Docker Postgres for prod.
- **Secrets:** Railway per-service env vars, set via the **Railway web dashboard only**.

The local dev path (Docker Postgres + keychain + `run_local`) stays intact and unchanged.

## Decisions locked in

| Decision | Choice | Rationale |
|---|---|---|
| Compute platform | Railway | `railway.toml` already declares both services; lowest friction. |
| Data migration | Fresh start | Local Docker Postgres uses `tmpfs`; data is already ephemeral. Re-submitting a few videos costs <$1. |
| Secrets store | Railway env vars (option A) | Adequate for solo project; the choice of store does not change the LLM-exposure threat model — discipline at the CLI boundary does (see "Secrets handling"). |
| Environments | Prod only (for now) | Local Docker = staging surrogate. Path to add staging later is small (new Supabase project + Railway environment). |
| System binaries | Nixpacks `nixpacks.toml` | Declarative, no Dockerfile. Co-located on both services for build uniformity. |
| pg-boss DB connection | Supabase **direct connection** (port 5432) | pg-boss uses `LISTEN/NOTIFY`, which is incompatible with the transaction pooler (port 6543). Direct connection sidesteps the issue; free-tier connection budget is sufficient for two services. |
| Deploy trigger | Manual (for now) | Solo, pre-traffic. Auto-deploy on `main` deferred until CI gating is in place. |

## Target architecture

```
                  ┌─────────────────────────────────────────────────┐
                  │  Railway project: video-transcriber (prod env)  │
                  │                                                 │
   Internet ─────►│  Service: api      (Nixpacks build, Node 22)    │
                  │    └ start: node dist/index.js                  │
                  │    └ public URL: <name>.up.railway.app          │
                  │    └ healthcheck: GET /health                   │
                  │                                                 │
                  │  Service: worker   (Nixpacks build, Node 22)    │
                  │    └ start: node dist/worker.js                 │
                  │    └ no public URL                              │
                  │    └ nixPkgs: yt-dlp, ffmpeg                    │
                  │                                                 │
                  │  Env vars (per service, set via dashboard):     │
                  │    SUPABASE_CONNECTION_STRING                   │
                  │    OPENAI_API_KEY                               │
                  │    ANTHROPIC_API_KEY                            │
                  │    ASSEMBLYAI_API_KEY                           │
                  │    NODE_ENV=production                          │
                  │    PORT  (api only — Railway injects)           │
                  └───────────────────────┬─────────────────────────┘
                                          │
                                pg direct (5432, TLS)
                                          │
                  ┌───────────────────────▼─────────────────────────┐
                  │  Supabase project: video-transcriber-prod       │
                  │   - Postgres 16 + pgvector                      │
                  │   - schema: source_videos, talks, transcripts,  │
                  │             chunks, pgboss.*                    │
                  └─────────────────────────────────────────────────┘

   External APIs (called from worker): AssemblyAI, OpenAI, Anthropic, YouTube (yt-dlp)
   Local dev (unchanged): Docker pgvector on :54329 + keychain + run_local
```

### Notes on the topology

- **Two services, one Railway project.** Each service has its own env-var namespace. We set the
  full secret set on both services. A per-service least-privilege split was considered (e.g.
  withhold `ASSEMBLYAI_API_KEY` from the api) but `loadConfig` in `src/config.ts` requires
  `ASSEMBLYAI_API_KEY` at boot and `src/index.ts` constructs `AssemblyAIService` during api
  startup, so withholding the key would crash the api. A code change to make the key optional
  is out of scope for this migration; both services share the Railway dashboard anyway, so the
  marginal blast-radius benefit is small.
- **Worker has no public URL.** No inbound attack surface; only outbound calls to AssemblyAI,
  OpenAI, Anthropic, YouTube, and the Supabase Postgres.
- **pg-boss runs inside the worker process** — polls Postgres for jobs. No separate queue
  service.
- **`yt-dlp` + `ffmpeg`** are provided by Nixpacks via `nixpacks.toml`. Both services use the
  same Nixpacks config for build uniformity even though the api strictly does not need them.

## Code & config changes

### New: `nixpacks.toml` (repo root)

```toml
[phases.setup]
nixPkgs = ["nodejs_22", "yt-dlp", "ffmpeg"]

[phases.build]
cmds = ["npm ci", "npm run build"]
```

### Modify: `railway.toml`

```toml
[build]
  builder = "NIXPACKS"

[deploy]
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3

[services.api]
  start = "node dist/index.js"
  healthcheckPath = "/health"
  healthcheckTimeout = 30

[services.worker]
  start = "node dist/worker.js"
```

### Code: no changes required

- `GET /health` already exists at `src/server.ts:24` (returns `{status:'ok'}`). Sufficient for
  Railway's healthcheck contract (process-alive). A DB-connectivity probe could be added later
  but is out of scope for this migration.
- `loadConfig` (`src/config.ts`) already accepts `SUPABASE_CONNECTION_STRING`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY` and scrubs them from
  `process.env` after read. No change needed.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are declared optional in `config.ts` and
  currently unused. We do not set them in Railway. They remain available for future
  Supabase-client features without re-touching config.

## Secrets handling

### Threat model

The secret store itself (Railway encrypted env vars) is **not** the leak point. Cloud
secret stores all encrypt at rest and inject at runtime. The leak surface is the **bridges
between cloud secrets and the local terminal an LLM/AI agent can observe** — CLI commands
that print plaintext, local subprocesses that inherit prod env, and accidental log echoes.

| Action | LLM exposure |
|---|---|
| Set value via Railway web dashboard | None — value lives in browser DOM briefly, then encrypted server-side. |
| `railway variables` (list) | High — prints all values plaintext to stdout. |
| `railway variables set FOO=bar` | High — value in argv, `ps`, shell history. |
| `railway run <cmd>` | High — injects prod secrets into a local subprocess the agent shares. |
| `railway variables --json > .env` | High — persists plaintext to disk. |
| `railway logs` after a flow that logged a secret | Medium — depends on whether the app logged it. |
| App logging the config object | High — mitigated by never logging `AppConfig`. |

### Rules during this migration

1. **All secret values are set by the user via the Railway web dashboard.** The AI agent
   never runs `railway variables*` commands and never sees secret values.
2. **No CLI access to prod secrets in this session.** No `railway run`, no
   `railway variables`, no `--json > .env`.
3. **The `delete process.env[key]` scrub in `loadConfig` stays.** Even inside the deployed
   container, npm packages loaded after `loadConfig()` cannot read secrets from
   `process.env`.
4. **No secret values in commits, PR descriptions, issues, or chat.** No exceptions.
5. **App code must never log `AppConfig` or its fields.** Existing code does not — verify
   during PR review.

### What gets set where, per service

Both services receive the full set. The api never *calls* AssemblyAI at runtime, but
`loadConfig` requires `ASSEMBLYAI_API_KEY` at boot and `src/index.ts` constructs the
service at startup — withholding the key would crash the api.

| Variable | api | worker | Source |
|---|:-:|:-:|---|
| `SUPABASE_CONNECTION_STRING` | ✅ | ✅ | Supabase → Project Settings → Database → URI (direct connection, port 5432). Append `?sslmode=require`. |
| `OPENAI_API_KEY` | ✅ | ✅ | OpenAI console. |
| `ANTHROPIC_API_KEY` | ✅ | ✅ | Anthropic console. |
| `ASSEMBLYAI_API_KEY` | ✅ | ✅ | AssemblyAI dashboard. |
| `NODE_ENV=production` | ✅ | ✅ | Static. |
| `PORT` | (Railway-injected) | n/a | Railway sets this automatically for services with a public URL. |

### Local dev (unchanged)

- `dev-secrets.keychain` + `.envrc` + `run_local` continue to work against Docker Postgres at
  `localhost:54329`.
- The Supabase prod connection string is **not** stored in the local keychain. If a one-off
  local-against-prod operation is ever needed, retrieve from Supabase dashboard at that
  moment and inject inline (`SUPABASE_CONNECTION_STRING=$(...) node script.js`), never persist.

## Migration steps (in order)

1. **Create Supabase project** `video-transcriber-prod` (free tier; pick a region close to
   the Railway region you'll use).
2. **Enable pgvector** in Supabase SQL Editor:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. **Apply schema migrations** via Supabase SQL Editor (or `psql` with the direct connection
   string fetched ad-hoc — do not persist it):
   - `src/db/migrations/001_initial.sql`
   - `src/db/migrations/002_content_type.sql`
   Verify with `\dt` — expect `source_videos`, `talks`, `transcripts`, `chunks`.
4. **Branch + commit infrastructure:** create `feat/cloud-deploy`, add `nixpacks.toml`,
   update `railway.toml`. Open PR.
5. **Local checks:** `npm run test:all` + `npm run typecheck` must pass before merge.
6. **Merge PR to `main`.**
7. **Create Railway project:** connect the GitHub repo. Railway auto-detects `railway.toml`
   and creates two services (`api`, `worker`).
8. **First deploy will fail** (no env vars set). Expected — proceed.
9. **Set env vars per service in Railway dashboard** (user-only; agent never sees values).
   Use the table in "Secrets handling → What gets set where, per service."
10. **Redeploy** both services. Watch logs for:
    - api: `API listening on <port>`
    - worker: `Worker started` and pg-boss table creation messages on first boot.
11. **Verify** (see "Verification" below).

## Verification

After both services are green:

1. **Health check:** `curl https://<api-host>.up.railway.app/health` → `{"status":"ok"}`.
2. **DB schema in Supabase:** SQL Editor → `\dt` shows `source_videos`, `talks`,
   `transcripts`, `chunks`, plus `pgboss.*` tables created on first worker boot.
3. **End-to-end submit:** POST a short (~10 min) conference talk to `/videos`, poll
   `/videos/<id>/status`. Expect progression
   `pending → downloading → transcribing → segmenting → embedding → ready` within ~5 min.
4. **Search + QA:** hit `/search` and `/qa` against the new video — answers should cite the
   correct `talk_id` and chunk text.
5. **Log sanity:** scan recent `railway logs` (api and worker) for accidental secret echoes.
   Expect structured request/job logs; **no** `sk-…`, no connection string, no AssemblyAI
   key. If any appear, treat as an incident: rotate the affected key and patch the log site.

## Rollback & what stays usable locally

- **Local dev is unaffected.** Docker Postgres on `:54329`, keychain-backed `.envrc`,
  `run_local`, integration tests — all continue to work. Nothing in this migration removes
  or changes the local path.
- **Rollback** = redeploy the last green Railway commit (Railway → service → Deployments →
  "Redeploy"). Supabase data is non-destructive across redeploys; schema changes only happen
  when migrations are run explicitly.
- **Emergency diagnosis** of a wedged prod: fetch the Supabase connection string ad-hoc from
  the Supabase dashboard and point a local worker at it for a single session. Do **not**
  store this string in the keychain permanently.

## Out of scope (deferred)

All deferrable; design accommodates each as an additive follow-up.

- Staging environment (second Supabase project + second Railway environment).
- Custom domain + TLS cert (Railway provides `*.up.railway.app` until needed).
- CI gating on `main` (GitHub Actions runs `test:all` + `typecheck` before allowing merge).
- Auto-deploy on push to `main` (flip after CI is in place).
- Log shipping / alerting (Sentry, Logtail, etc.).
- Autoscaling (worker concurrency, api replicas).
- Secret rotation cadence and runbook.
- DB-connectivity probe inside `/health`.
- Backup / point-in-time-recovery posture (Supabase free tier has limited PITR).
