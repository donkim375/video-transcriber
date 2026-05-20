# Run Video Transcriber Locally — Quickstart

End-to-end on your laptop, ~30 min including signups. No cloud deploy.

## What you need

**Local tools** (one-time install):
```bash
brew install yt-dlp ffmpeg     # yt-dlp needs ffmpeg to extract mp3
node -v                         # must be ≥ 22
docker info                     # Docker daemon must be running
```

**Three API keys** (sign up on each site, store in macOS Keychain in Step 3):
- AssemblyAI — https://www.assemblyai.com — ~$0.65/hr of audio
- OpenAI — https://platform.openai.com/api-keys — embeddings are ~$0.01 per 30-min talk
- Anthropic — https://console.anthropic.com — ~$0.50–1 per video for Claude

Total for a 10-min test video: well under $1.

## Step 1 — Start local Postgres

The existing `docker-compose.test.yml` runs `pgvector/pgvector:pg16` on port `54329`. It's set up for tests (data is ephemeral, stored in tmpfs), but as long as you don't restart the container, it works fine for a local session.

```bash
cd /Users/donkim/Code/video-transcriber
docker compose -f docker-compose.test.yml up -d
```

**Heads-up:** the data is wiped if you `docker compose down` or restart the container. If you want it to survive across days, edit `docker-compose.test.yml` and replace the `tmpfs:` block with `volumes: - pgdata:/var/lib/postgresql/data` plus a top-level `volumes: pgdata:` — but only do this if you don't run integration tests against the same container (tests assume an empty schema).

## Step 2 — Apply the schema

The container's connection string is:
```
postgres://test:test@localhost:54329/test
```

Apply the migration:
```bash
psql "postgres://test:test@localhost:54329/test" -f src/db/migrations/001_initial.sql
```

Verify:
```bash
psql "postgres://test:test@localhost:54329/test" -c "\dt"
```
You should see `source_videos`, `talks`, `transcripts`, `chunks`.

## Step 3 — Load secrets via Keychain (not `.env`)

Your project already has `.envrc` wired up to `dev-secrets.keychain` with helper functions (`openai_key`, `anthropic_key`, `assemblyai_key`, `supabase_conn`) and a `run_server` wrapper. See `docs/secure-local-secrets.md` for the full design. Don't create a `.env` file — store secrets in the keychain instead.

### 3a. Store the three API keys

You'll get a Keychain Access GUI prompt to enter your keychain password during `add-generic-password`. Click **Allow** (not "Always Allow") on subsequent read prompts.

```bash
echo "Type AssemblyAI key (invisible):" && read -s SECRET && security add-generic-password -s "video-transcriber" -a "assemblyai" -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
echo "Type OpenAI key (invisible):"     && read -s SECRET && security add-generic-password -s "video-transcriber" -a "openai"     -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
echo "Type Anthropic key (invisible):"  && read -s SECRET && security add-generic-password -s "video-transcriber" -a "anthropic"  -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
```

Confirm each is stored (byte count > 0):
```bash
security find-generic-password -s "video-transcriber" -a "openai" -w dev-secrets.keychain | wc -c
```

### 3b. Store the local Postgres connection string

Not really a secret, but keeping it in the keychain keeps the `.envrc` flow uniform.

```bash
echo "Paste connection string (postgres://test:test@localhost:54329/test):" \
  && read -s SECRET \
  && security add-generic-password -s "video-transcriber" -a "supabase-conn" -T "" -w "$SECRET" dev-secrets.keychain \
  && unset SECRET
```

### 3c. Add a `run_local` helper to `.envrc`

The existing `run_server` in `.envrc` requires `supabase_url` and `supabase_service_key`, which aren't used by local Postgres (and `_kc` errors on missing keys). Add a slimmer variant — append to `.envrc`:

```bash
# Local-only runner: skips Supabase URL/service-role (only used by deployed envs)
run_local() {
  ASSEMBLYAI_API_KEY=$(assemblyai_key) \
  OPENAI_API_KEY=$(openai_key) \
  ANTHROPIC_API_KEY=$(anthropic_key) \
  SUPABASE_CONNECTION_STRING=$(supabase_conn) \
  PORT=${PORT:-3000} \
  NODE_ENV=${NODE_ENV:-development} \
  "$@"
}
```

Re-approve `.envrc` after editing:
```bash
direnv allow .
```

### 3d. Smoke-test the secret pipeline

```bash
run_local node -e "console.log('OPENAI prefix:', process.env.OPENAI_API_KEY?.slice(0,7))"
```
Expected: prints something like `OPENAI prefix: sk-proj`. If it prints `undefined` or errors, the keychain entry is missing or named wrong.

> **Note:** Steps 4 below uses `run_local` instead of bare `npm run` — secrets are only present inside the `run_local` subprocess.

## Step 4 — Run the worker + API

Two terminals from the repo root.

**Terminal A (worker — pg-boss subscriber that runs the 5 pipeline steps):**
```bash
run_local npm run dev:worker
```
You should see "Worker started" in a couple of seconds. Keep this terminal visible — all step-by-step pipeline output prints here.

**Terminal B (API — Fastify on :3000):**
```bash
run_local npm run dev
```
Look for `API listening on 3000`.

## Step 5 — Submit a video

In a third terminal. **Pick a short conference talk** (~10 min) with chapter markers if possible — chapters trigger the deterministic segmentation path (Path A) which is much cheaper and faster than the LLM path (Path B).

```bash
curl -X POST http://localhost:3000/videos \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=C_GG5g38vLU"}'
```

Response:
```json
{"source_video_id":"<uuid>","status":"pending"}
```

## Step 6 — Watch it process

```bash
ID=f19ddd33-97a5-4b45-8f61-7bf19313c2a4
watch -n 2 "curl -s http://localhost:3000/videos/$ID/status"
```

Expected progression (~3–10 min for a 10-min video):
```
pending → downloading → transcribing → segmenting → embedding → ready
```

If it lands on `error`, the `error_message` field tells you which step failed. Check the worker terminal for stack trace.

## Step 7 — Query it

Once `status: ready`:

```bash
# Full video detail with talks
curl -s "http://localhost:3000/videos/$ID" | jq

# Hybrid search (vector + full-text + RRF)
curl -s -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query":"<word from the talk>","limit":5}' | jq

# RAG Q&A
curl -s -X POST http://localhost:3000/qa \
  -H "Content-Type: application/json" \
  -d '{"question":"<a question about the talk>"}' | jq
```

`/qa` returns `{answer, sources: [...]}` — each source has the chunk text and `talk_id` so you can trace citations back.

## Troubleshooting

- **`error: command not found: yt-dlp`** in worker logs → `brew install yt-dlp ffmpeg`, restart worker.
- **POST /videos returns 400 on a valid URL** → check the YouTube ID part is exactly 11 chars. `extractYouTubeId` in `src/services/url-validator.ts` requires `/^[A-Za-z0-9_-]{11}$/`.
- **Stuck at `transcribing` for >15 min** → AssemblyAI dashboard shows the actual job state; cross-reference with `transcripts.assemblyai_id` in the DB (`psql "$DB_URL" -c "select assemblyai_id from transcripts;"`).
- **Worker crashed but status still says `downloading`** → restart worker; the video is stuck. Currently there's no auto-resume (the "High priority" `assemblyai_id` persistence fix would address this). Workaround: delete the row and resubmit.
- **`docker compose down` lost my data** → expected with tmpfs. See Step 1 heads-up.
