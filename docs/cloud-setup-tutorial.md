# Cloud Setup Tutorial — Railway + Supabase

Step-by-step walkthrough for deploying video-transcriber to Railway + Supabase per the
design in `docs/superpowers/specs/2026-05-21-cloud-supabase-migration-design.md`.

Budget: ~45 minutes the first time. Cost: Supabase free tier + Railway ~$5/mo hobby plan
(or trial credits).

> **Important — secret hygiene.** Throughout this tutorial, set every secret value via the
> **Railway web dashboard** in your browser. Do not paste secret values into your terminal,
> into commit messages, into PR descriptions, or into any chat with an AI assistant. Do
> not run `railway variables`, `railway variables set`, or `railway run`. Those commands
> print or inject plaintext secrets where assistants and shell history can see them.

---

## Prerequisites

- GitHub account with this repo pushed to it.
- A credit card (Railway requires one even on the trial; Supabase doesn't for free tier).
- Your three API keys handy (do **not** paste them anywhere yet):
  - AssemblyAI — https://www.assemblyai.com/app/account
  - OpenAI — https://platform.openai.com/api-keys
  - Anthropic — https://console.anthropic.com/settings/keys
- Local repo on a branch that contains the new `nixpacks.toml` and updated `railway.toml`
  (the implementation plan will produce these — confirm the PR is merged to `main` before
  starting Part 2).

---

## Part 1 — Create the Supabase project (~10 min)

### 1.1 Sign up / log in

Go to https://supabase.com → "Start your project" → sign in with GitHub.

### 1.2 Create the project

In the Supabase dashboard:

1. Click **"New project"**.
2. **Organization:** your personal org (default).
3. **Name:** `video-transcriber-prod`.
4. **Database password:** click "Generate a password". **Copy it to your password manager
   immediately** — you'll need it once for the connection string, and Supabase won't show
   it again. Do **not** paste it into your terminal.
5. **Region:** pick the one geographically closest to where you'll host Railway. If unsure,
   `us-east-1` is a safe default; just match Railway's region in Part 2.
6. **Pricing plan:** Free.
7. Click **"Create new project"**. Provisioning takes ~2 minutes.

### 1.3 Enable pgvector

Once the project is provisioned:

1. In the left sidebar, click **"SQL Editor"** → **"New query"**.
2. Paste and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. You should see "Success. No rows returned."

### 1.4 Apply the schema migrations

Still in the SQL Editor:

1. **Migration 1.** Open `src/db/migrations/001_initial.sql` in your local editor, copy
   its entire contents, paste into a new SQL Editor query, and run. Expect "Success."
2. **Migration 2.** Same with `src/db/migrations/002_content_type.sql`.
3. **Verify:** in the left sidebar click **"Table Editor"**. You should see four tables:
   `source_videos`, `talks`, `transcripts`, `chunks`. (The `pgboss.*` tables will appear
   later when the worker first connects.)

### 1.5 Grab the connection string (but don't paste it anywhere yet)

1. Click the **gear icon (Project Settings)** in the bottom-left → **"Database"**.
2. Scroll to **"Connection string"** → tab **"URI"**.
3. **Connection mode:** select **"Session pooler"** (port `5432`). Do **not** pick:
   - **"Direct connection"** — resolves to IPv6-only on Supabase free tier; Railway
     containers have no IPv6 egress, so connections fail with `ENETUNREACH`.
   - **"Transaction pooler"** (port `6543`) — breaks pg-boss because it doesn't support
     `LISTEN/NOTIFY`.

   Session pooler is IPv4-reachable and runs PgBouncer in *session mode*, which preserves
   the connection state pg-boss needs.
4. The string looks like:
   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Note the user is `postgres.<project-ref>` (not just `postgres`) and the host is
   `aws-0-<region>.pooler.supabase.com` (not `db.<ref>.supabase.co`).
5. Replace `[YOUR-PASSWORD]` with the password you saved in step 1.2. **URL-encode any
   special characters** in the password — `@` → `%40`, `/` → `%2F`, `:` → `%3A`, `#` →
   `%23`, space → `%20`, `+` → `%2B`, `%` → `%25`. If the password has no special
   characters, no encoding is needed.
6. Append `?sslmode=require&uselibpqcompat=true` to the end:
   ```
   postgresql://postgres.<project-ref>:<encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true
   ```
   Why both flags? `sslmode=require` keeps the channel TLS-encrypted. `uselibpqcompat=true`
   tells the Node `pg-connection-string` library to interpret `require` the libpq way
   (encrypt, don't verify the CA chain) instead of the newer default of `verify-full`
   (which fails against the Supabase pooler cert chain with `SELF_SIGNED_CERT_IN_CHAIN`).
   Identity is asserted by the database password, not the CA chain.
7. Keep this string in your **password manager** for now. You'll paste it into Railway in
   Part 2.4 — directly in the browser, never via a terminal.

### 1.6 Export YouTube cookies (required in production)

YouTube's bot detection blocks `yt-dlp` requests from cloud-server IP ranges. The deployed
worker must authenticate as a signed-in user via a cookies file. Local dev runs from a
residential IP and doesn't need this; production fails fast at boot without it.

1. Open a clean browser profile and sign in to a **dedicated** low-value YouTube account.
   Do not use your main account — sessions can be revoked when YouTube detects automation.
2. Install the **"Get cookies.txt LOCALLY"** browser extension.
3. Visit `https://www.youtube.com`, open the extension, click **Export**, and save the
   resulting `cookies.txt` file.
4. Base64-encode it (single line, no wrapping):
   - macOS: `base64 -i cookies.txt | pbcopy`
   - Linux: `base64 -w0 cookies.txt | xclip -selection clipboard`
5. Keep the encoded string in your **password manager** for now. You'll paste it into both
   Railway services in Part 2.4 — directly in the browser, never via a terminal.

**Refresh ritual.** When downloads start failing with `Sign in to confirm you're not a
bot`, the cookies have expired (typically every few weeks). Repeat steps 3–4 and update
the `YOUTUBE_COOKIES_B64` variable on both Railway services, then redeploy.

---

## Part 2 — Create the Railway project (~15 min)

### 2.1 Sign up / log in

Go to https://railway.app → "Login" → "Login with GitHub". Authorize Railway to read your
repos.

### 2.2 Create the project from your GitHub repo

1. Click **"New Project"** → **"Deploy from GitHub repo"**.
2. Pick `<your-username>/video-transcriber`. If you don't see it, click "Configure GitHub
   App" and grant access.
3. Railway will detect `railway.toml` and offer to create the services it declares
   (`api` and `worker`). Confirm.
4. **First deploys will start and FAIL** — that's expected, env vars aren't set yet. Don't
   panic; proceed to 2.3.

### 2.3 Verify the two services exist

In the project view you should see two service cards: **api** and **worker**. If only one
appeared, click "+ New" → "GitHub Repo" → pick the same repo, and Railway will let you
create the second service from the same `railway.toml`.

### 2.4 Set environment variables on each service

This is the critical "secret hygiene" step. **Do everything below in the browser. Do not
use the Railway CLI in this session.**

#### 2.4.1 — api service

1. Click the **api** service card → **"Variables"** tab → **"+ New Variable"** for each:

   | Name | Value |
   |---|---|
   | `SUPABASE_CONNECTION_STRING` | Paste the URI you assembled in Part 1.5 |
   | `OPENAI_API_KEY` | Your OpenAI key (`sk-...`) |
   | `ANTHROPIC_API_KEY` | Your Anthropic key (`sk-ant-...`) |
   | `ASSEMBLYAI_API_KEY` | Your AssemblyAI key |
   | `YOUTUBE_COOKIES_B64` | Base64 cookies string from Part 1.6 |
   | `NODE_ENV` | `production` |

2. Do **not** add `PORT` — Railway injects it automatically because the api service has a
   public URL.

> **Why does the api need `ASSEMBLYAI_API_KEY` if it never calls AssemblyAI at request time?**
> Because `loadConfig` (`src/config.ts`) validates the key as required at boot, and
> `src/index.ts` constructs an `AssemblyAIService` instance during startup as part of the
> dependency-injection wiring. A per-service split was considered and ruled out — making
> the key optional would require code changes outside the scope of this migration, and
> both services share the same Railway dashboard anyway.

#### 2.4.2 — worker service

1. Click the **worker** service card → **"Variables"** tab → **"+ New Variable"** for each:

   | Name | Value |
   |---|---|
   | `SUPABASE_CONNECTION_STRING` | Same URI as in 2.4.1 |
   | `OPENAI_API_KEY` | Same as api |
   | `ANTHROPIC_API_KEY` | Same as api |
   | `ASSEMBLYAI_API_KEY` | Same as api |
   | `YOUTUBE_COOKIES_B64` | Same value as api |
   | `NODE_ENV` | `production` |

> **Why duplicate the same values across services?** Railway scopes variables per
> service, so each service has its own copy. Both services need all four keys per the
> reasoning in 2.4.1.

### 2.5 Expose the api publicly

1. Click the **api** service → **"Settings"** tab → **"Networking"** section.
2. Click **"Generate Domain"**. Railway gives you a URL like `your-name-api.up.railway.app`.
3. Confirm the **worker** service has **no** public domain (no inbound traffic should ever
   reach the worker).

### 2.6 Trigger a redeploy

1. Click the **api** service → **"Deployments"** tab → top-right **"Deploy"** (or the
   three-dot menu → "Redeploy").
2. Watch the build logs. You should see Nixpacks installing `nodejs_22`, `yt-dlp`, and
   `ffmpeg`, then `npm ci`, then `npm run build`. Build takes ~3–5 min the first time.
3. Once the build is green, the deploy log should print **`API listening on 8080`** (or
   whichever port Railway injected). The healthcheck on `/health` should pass.
4. Repeat for the **worker** service. Look for **`Worker started`** in the logs, and shortly
   after, pg-boss schema messages (it creates its tables on first connect).

---

## Part 3 — Verify end-to-end (~10 min)

### 3.1 Health check

In your local terminal:

```bash
curl https://your-name-api.up.railway.app/health
```

Expect: `{"status":"ok"}`.

### 3.2 Confirm pg-boss tables exist

Back in the Supabase dashboard → SQL Editor → run:

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('public','pgboss')
ORDER BY 1, 2;
```

You should see your four app tables in `public` plus several `pgboss.*` tables. If
`pgboss.*` is missing, the worker hasn't connected yet — check its Railway logs.

### 3.3 Submit a test video

Pick a short conference talk (~10 min, ideally one with chapter markers — those trigger
the cheaper deterministic-segmentation path).

```bash
API=https://your-name-api.up.railway.app

curl -X POST "$API/videos" \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=C_GG5g38vLU"}'
```

Response:

```json
{"source_video_id":"<uuid>","status":"pending"}
```

### 3.4 Watch it process

```bash
ID=<paste-the-uuid>
watch -n 5 "curl -s $API/videos/$ID/status"
```

Expected progression over ~5 min:

```
pending → downloading → transcribing → segmenting → embedding → ready
```

If it lands on `error`, the `error_message` field tells you which step failed. Cross-check
with the worker logs in Railway.

### 3.5 Search + QA

Once `status: ready`:

```bash
curl -s "$API/videos/$ID" | jq

curl -s -X POST "$API/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"<word from the talk>","limit":5}' | jq

curl -s -X POST "$API/qa" \
  -H "Content-Type: application/json" \
  -d '{"question":"<a question about the talk>"}' | jq
```

`/qa` returns `{answer, sources: [...]}` with `talk_id` citations.

### 3.6 Log sanity check

In Railway, view the latest logs for each service. Scan for:

- ❌ Any `sk-…` substring → an API key leaked into logs. Rotate the key in the provider's
  dashboard, update the Railway env var, redeploy.
- ❌ Any `postgresql://…` substring including a real password → connection string leaked.
  Rotate the DB password in Supabase, update Railway env var, redeploy.
- ❌ Any `Bearer …` or `Authorization:` header echoes.

If logs are clean: you're done.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails: `yt-dlp: command not found` during runtime | Missing or misnamed Nixpacks package | Confirm `nixpacks.toml` is at repo root and contains `nixPkgs = ["nodejs_22", "yt-dlp", "ffmpeg"]`. Trigger redeploy. |
| Worker logs: `password authentication failed` | Wrong password in connection string | Re-copy from your password manager; check `:` and `@` are URL-safe (URL-encode any `@`, `:`, `/` in the password). |
| Worker logs: `relation "pgboss.job" does not exist` | First boot didn't complete; pg-boss didn't get to create its schema | Check the Postgres user has `CREATE` privilege (the default Supabase `postgres` user does). Redeploy worker. |
| Worker logs: `ENETUNREACH` to an IPv6 address (e.g. `2406:…:5432`) | Using **Direct connection** (`db.<ref>.supabase.co`) — IPv6-only on Supabase free tier; Railway has no IPv6 egress | Switch the connection string to the **Session pooler** host `aws-0-<region>.pooler.supabase.com` (port 5432, user `postgres.<project-ref>`). Redeploy. |
| Worker logs: `Invalid URL` from `pg-connection-string` | Malformed connection string — usually unencoded special chars in the password, leftover `[YOUR-PASSWORD]` placeholder, or wrapping quotes | URL-encode `@/:#%+ ` in the password; remove any quotes; re-save in Railway. |
| Worker logs: `SELF_SIGNED_CERT_IN_CHAIN` | `sslmode=require` is being interpreted as `verify-full` by newer `pg-connection-string`, which can't validate Supabase's pooler cert against Node's built-in CAs | Append `&uselibpqcompat=true` to the connection string so `require` means "encrypt, don't verify CA" (libpq semantics). Identity is still asserted by the DB password. |
| Worker logs: connection drops every few minutes, or `LISTEN/NOTIFY` errors | Using the **Transaction** pooler (port 6543) instead of the Session pooler (5432) | Switch the connection string to the Session pooler (port 5432, user `postgres.<project-ref>`) in Railway → redeploy worker. |
| Worker logs: `yt-dlp` error `Sign in to confirm you're not a bot` | `YOUTUBE_COOKIES_B64` missing, malformed, or expired | Re-export per [Step 1.6](#16-export-youtube-cookies-required-in-production); base64-encode; update on both Railway services; redeploy. |
| Boot fails with `Invalid config: YOUTUBE_COOKIES_B64 is required in production` | The secret isn't set on this service in production mode | Follow [Step 1.6](#16-export-youtube-cookies-required-in-production) and set the variable on both api and worker. |
| Boot fails with `Invalid YOUTUBE_COOKIES_B64: decoded content is not a Netscape cookies.txt file` | The base64 decoded to non-cookies content, or you pasted raw cookies (not base64) | Re-encode with `base64 -i cookies.txt` (macOS) or `base64 -w0 cookies.txt` (Linux); make sure the file starts with `# Netscape HTTP Cookie File`. |
| `/videos/<id>/status` stuck on `transcribing` for >15 min | AssemblyAI job didn't return | Check AssemblyAI dashboard for the actual job state. Cross-reference `transcripts.assemblyai_id` via Supabase SQL Editor. |
| API responds 502 / never starts | `loadConfig` threw on missing env var | Check api deploy logs for `Invalid config: …`. Add the missing variable in Railway → Variables → redeploy. |
| Healthcheck times out | Cold start exceeded `healthcheckTimeout = 30` | Bump to 60 in `railway.toml`, commit, push, deploy. |

---

## Ongoing operations

- **Deploying a code change:** push to your branch → open PR → run `npm run test:all` +
  `npm run typecheck` locally → merge to `main` → in Railway click "Deploy" on each
  service (deploys are manual per the design).
- **Rotating a key:** generate the new key in the provider's dashboard → update the
  Railway env var via the dashboard → redeploy the affected service → revoke the old key.
- **Adding a new env var:** add it to `loadConfig` (`src/config.ts`) with the appropriate
  Zod schema entry → set the value in Railway dashboard for each service that needs it →
  redeploy.
- **Schema migrations:** write `src/db/migrations/00N_*.sql` locally → test against local
  Docker Postgres → apply to Supabase prod via SQL Editor as in Part 1.4. There is no
  automatic migration runner today.

---

## What you can ignore (out of scope per the design spec)

- Staging environment — local Docker Postgres serves as the dev/staging surrogate. When
  you outgrow that: create a second Supabase project, add a Railway environment, point
  the env's `SUPABASE_CONNECTION_STRING` at the new DB, apply migrations there.
- Custom domain — `*.up.railway.app` is fine until you need a brand domain. Railway
  → Networking → "Custom Domain" when ready.
- CI gating, auto-deploy, log shipping, alerting, autoscaling, secret rotation policy —
  all deferred. Add as small follow-ups when the need arises.
