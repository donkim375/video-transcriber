# Video Transcriber

Backend service that ingests YouTube conference videos, transcribes via AssemblyAI, segments into individual talks, and exposes hybrid search + RAG Q&A APIs.

## Prerequisites

- Node.js 22+
- Docker (for integration tests)
- `yt-dlp` in PATH (for production audio download)
- API keys: AssemblyAI, OpenAI, Anthropic
- A Postgres database with the `pgvector` extension (Supabase recommended)

## Local Setup

```bash
git clone <repo>
cd video-transcriber
npm install
cp .env.example .env
# edit .env with your keys + database URL
```

Apply the schema to your database. Run migrations in order; each is idempotent:

```bash
psql "$SUPABASE_CONNECTION_STRING" -f src/db/migrations/001_initial.sql
psql "$SUPABASE_CONNECTION_STRING" -f src/db/migrations/002_content_type.sql
```

## Running

In two terminals:

```bash
npm run dev          # Fastify API on :3000
npm run dev:worker   # pg-boss worker
```

Submit a video:

```bash
curl -X POST http://localhost:3000/videos \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=..."}'
```

Poll status:

```bash
curl http://localhost:3000/videos/<id>/status
```

## Tests

Unit + route tests (some require Docker Postgres):

```bash
docker compose -f docker-compose.test.yml up -d
npm test
```

Integration tests (Docker Postgres):

```bash
npm run test:integration
```

All:

```bash
npm run test:all
```

Typecheck:

```bash
npm run typecheck
```

## Environment Variables

| Name | Required | Description |
|---|---|---|
| `SUPABASE_CONNECTION_STRING` | yes | Postgres connection string |
| `ASSEMBLYAI_API_KEY` | yes | AssemblyAI API key |
| `OPENAI_API_KEY` | yes | OpenAI API key (for embeddings) |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key (for Claude) |
| `PORT` | no | API port (default 3000) |
| `NODE_ENV` | no | `production` or `development` |
| `SUPABASE_URL` | no | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Service role key |

## Deployment (Railway)

Two services share one Postgres:

- `api` runs `node dist/index.js`
- `worker` runs `node dist/worker.js`

`railway.toml` is included in the repo. Configure env vars in the Railway dashboard.

## Architecture

See `docs/superpowers/specs/2026-05-20-video-transcriber-tdd-design.md` for the full design spec.
