# YouTube Conference Transcription Service — TDD Design Spec

## Overview

A backend service that ingests YouTube conference videos, transcribes them via AssemblyAI, segments multi-talk videos into individual talks, generates per-talk summaries, and exposes a hybrid search + RAG Q&A API.

This spec restructures the original technical plan around a **test-driven development** workflow using a **layer-first** implementation order.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Test runner | Vitest | Native TS, fast, Jest-compatible API |
| External services in tests | Mocked via interfaces | Speed, no API cost, CI-friendly |
| Database in tests | Docker Postgres + pgvector for integration; mocked for unit | Catches real SQL issues without Supabase dependency |
| Done signal | `vitest run && tsc --noEmit` | Coverage thresholds incentivize meaningless tests in automated loops |
| Implementation order | Layer-first (pure logic → services → DB → orchestration → API) | Each layer independently testable with clear pass/fail |

---

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js + TypeScript |
| Web framework | Fastify |
| Job queue | pg-boss (Postgres-backed) |
| Database | Supabase (Postgres + pgvector) |
| Transcription | AssemblyAI (with speaker diarization) |
| Audio download | yt-dlp (CLI, via child process) |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dimensions) |
| LLM | Anthropic Claude (summaries, segmentation, Q&A) |
| Test runner | Vitest |
| Integration test DB | Docker `pgvector/pgvector:pg16` |
| Backend hosting | Railway |
| DB hosting | Supabase |

---

## Project Structure

```
/
├── src/
│   ├── index.ts                        # Fastify server entrypoint
│   ├── worker.ts                       # pg-boss worker entrypoint
│   ├── config.ts                       # Env var validation + constants
│   ├── db/
│   │   ├── client.ts                   # Supabase client singleton
│   │   └── migrations/
│   │       └── 001_initial.sql
│   ├── interfaces/                     # Contracts for all external services
│   │   ├── youtube.ts                  # IYouTubeService
│   │   ├── assemblyai.ts              # ITranscriptionService
│   │   ├── embeddings.ts             # IEmbeddingService
│   │   └── llm.ts                     # ILLMService (Claude)
│   ├── queues/
│   │   └── jobs.ts
│   ├── routes/
│   │   ├── videos.ts
│   │   ├── talks.ts
│   │   ├── search.ts
│   │   └── qa.ts
│   ├── services/
│   │   ├── youtube.ts                  # implements IYouTubeService
│   │   ├── assemblyai.ts              # implements ITranscriptionService
│   │   ├── segmentation.ts
│   │   ├── chunker.ts
│   │   ├── embeddings.ts             # implements IEmbeddingService
│   │   └── rag.ts
│   ├── workers/
│   │   ├── pipeline.worker.ts
│   │   └── steps/
│   │       ├── download.ts
│   │       ├── transcribe.ts
│   │       ├── segment.ts
│   │       ├── embed.ts
│   │       └── summarize.ts
│   └── types/
│       └── index.ts
├── tests/
│   ├── unit/                           # Fast, mocked, run always
│   │   ├── chunker.test.ts
│   │   ├── segmentation.test.ts
│   │   ├── url-validator.test.ts
│   │   ├── youtube.test.ts
│   │   ├── assemblyai.test.ts
│   │   ├── embeddings.test.ts
│   │   ├── rag.test.ts
│   │   └── pipeline.test.ts
│   ├── integration/                    # Docker Postgres, run separately
│   │   ├── db-setup.ts                # Test container lifecycle
│   │   ├── migrations.test.ts
│   │   ├── queries.test.ts
│   │   └── vector-search.test.ts
│   ├── routes/                         # API route tests
│   │   ├── videos.test.ts
│   │   ├── talks.test.ts
│   │   ├── search.test.ts
│   │   └── qa.test.ts
│   ├── e2e/                            # Full pipeline smoke
│   │   └── pipeline.e2e.test.ts
│   ├── fixtures/                       # Shared test data
│   │   ├── transcripts.ts
│   │   ├── chapters.ts
│   │   └── utterances.ts
│   └── mocks/                          # Mock implementations of interfaces
│       ├── youtube.mock.ts
│       ├── assemblyai.mock.ts
│       ├── embeddings.mock.ts
│       └── llm.mock.ts
├── docker-compose.test.yml             # Postgres + pgvector for integration tests
├── vitest.config.ts                    # Unit tests (default)
├── vitest.integration.config.ts        # Integration tests (Docker Postgres)
├── package.json
├── tsconfig.json
├── railway.toml
└── .env.example
```

---

## Database Schema

```sql
create extension if not exists vector;

create table source_videos (
  id              uuid primary key default gen_random_uuid(),
  youtube_url     text not null unique,
  youtube_id      text not null unique,
  title           text,
  channel         text,
  duration_seconds int,
  thumbnail_url   text,
  has_chapters    boolean default false,
  status          text not null default 'pending',
  error_message   text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table talks (
  id              uuid primary key default gen_random_uuid(),
  source_video_id uuid not null references source_videos(id) on delete cascade,
  title           text,
  speaker         text,
  conference      text,
  talk_index      int not null,
  start_ms        int not null,
  end_ms          int not null,
  youtube_deep_link text,
  created_at      timestamptz default now()
);

create table transcripts (
  id              uuid primary key default gen_random_uuid(),
  talk_id         uuid not null references talks(id) on delete cascade,
  assemblyai_id   text unique,
  raw_text        text,
  utterances      jsonb,
  summary         text,
  created_at      timestamptz default now()
);

create table chunks (
  id              uuid primary key default gen_random_uuid(),
  talk_id         uuid not null references talks(id) on delete cascade,
  transcript_id   uuid not null references transcripts(id) on delete cascade,
  chunk_index     int not null,
  text            text not null,
  start_ms        int,
  end_ms          int,
  token_count     int,
  embedding       vector(1536),
  created_at      timestamptz default now()
);

create index chunks_fts_idx on chunks using gin(to_tsvector('english', text));
create index chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index talks_source_video_id_idx on talks(source_video_id);
create index chunks_talk_id_idx on chunks(talk_id);
create index transcripts_talk_id_idx on transcripts(talk_id);

-- Vector similarity search function
create function match_chunks(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_talk_id uuid default null
)
returns table(id uuid, text text, talk_id uuid, start_ms int, end_ms int, similarity float)
language sql stable
as $$
  select
    chunks.id,
    chunks.text,
    chunks.talk_id,
    chunks.start_ms,
    chunks.end_ms,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where (filter_talk_id is null or chunks.talk_id = filter_talk_id)
    and 1 - (chunks.embedding <=> query_embedding) > match_threshold
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
```

---

## Service Interfaces

```typescript
interface IYouTubeService {
  getMetadata(url: string): Promise<VideoMetadata>
  downloadAudio(url: string, outputPath: string): Promise<void>
}

interface ITranscriptionService {
  transcribe(audioPath: string, options: TranscribeOptions): Promise<TranscriptionResult>
  getStatus(transcriptionId: string): Promise<TranscriptionStatus>
}

interface IEmbeddingService {
  embed(texts: string[]): Promise<number[][]>
}

interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  answerQuestion(question: string, context: string): Promise<string>
}
```

---

## Pipeline

### Step 0 — Submit video (`POST /videos`)
- Validate YouTube URL, extract video ID
- Check for duplicate (return existing if already processed)
- Insert `source_videos` row with `status: pending`
- Enqueue pg-boss job
- Return `{ source_video_id, status: "pending" }`

### Step 1 — Download
- Update `status: downloading`
- `IYouTubeService.getMetadata()` — title, channel, duration, chapters
- `IYouTubeService.downloadAudio()` — save to `/tmp/{id}.mp3`
- Update `source_videos` with metadata

### Step 2 — Transcribe
- Update `status: transcribing`
- `ITranscriptionService.transcribe()` — upload audio, request speaker diarization
- Store `assemblyai_id` for crash recovery
- Poll until complete
- Store `raw_text` and `utterances`
- Delete temp mp3

### Step 3 — Segment into talks
- Update `status: segmenting`
- **Path A (chapters available):** Parse chapter data, slice utterances
- **Path B (no chapters):** `ILLMService.segmentTranscript()` to identify boundaries
- Insert `talks` and `transcripts` rows

### Step 4 — Chunk and embed
- Update `status: embedding`
- Split `raw_text` into ~400-token chunks with 50-token overlap (sentence boundaries)
- `IEmbeddingService.embed()` — batch embed chunks
- Insert `chunks` rows

### Step 5 — Summarize
- `ILLMService.summarizeTalk()` for each talk
- Store in `transcripts.summary`
- Update `source_videos.status: ready`

---

## API Endpoints

### Videos
```
POST   /videos          { youtube_url, conference? } → { source_video_id, status }
GET    /videos          → [{ source_video_id, title, channel, status, talk_count, created_at }]
GET    /videos/:id      → { ...source_video, talks }
GET    /videos/:id/status → { status, current_step, error_message }
```

### Talks
```
GET    /talks           ?conference=&speaker=&limit=&offset= → [{ id, title, speaker, ... }]
GET    /talks/:id       → { ...talk, transcript, source_video }
```

### Search (hybrid)
```
POST   /search          { query, talk_id?, limit? } → { results: [{ chunk_text, talk_id, ... }] }
```
1. Keyword: `to_tsvector('english', text) @@ plainto_tsquery($query)`
2. Semantic: embed query → cosine similarity
3. Reciprocal rank fusion, deduplicate, return top N

### Q&A (RAG)
```
POST   /qa              { question, talk_id? } → { answer, sources }
```
1. Embed question
2. Top 8 chunks by cosine similarity
3. Build context with talk metadata
4. `ILLMService.answerQuestion()` with citation instructions

---

## TDD Implementation Order (Layer-First)

### Layer 1 — Foundation
- Project scaffold: `package.json`, `tsconfig.json`, Vitest configs
- `docker-compose.test.yml` with `pgvector/pgvector:pg16`
- Test fixtures (sample transcripts, chapters, utterances)
- Verify: `vitest run` runs with zero tests, `tsc --noEmit` passes

### Layer 2 — Pure Logic Units
No dependencies, no mocks. TDD red-green-refactor:
1. **URL validator** — extract YouTube video ID, reject invalid URLs
2. **Chunker** — tiktoken splitting, sentence boundaries, overlap
3. **Segmentation parser** — parse chapters into talk boundaries, slice utterances

### Layer 3 — Service Contracts + Mocks
1. Define `IYouTubeService`, `ITranscriptionService`, `IEmbeddingService`, `ILLMService`
2. Write mock implementations in `tests/mocks/`
3. Write contract tests against interfaces

### Layer 4 — Service Implementations
Implement behind interfaces; Layer 3 tests define expected behavior:
1. **YouTubeService** — yt-dlp wrapper (mock `child_process`)
2. **AssemblyAIService** — upload, poll, return utterances
3. **EmbeddingService** — batched OpenAI calls
4. **LLMService** — Claude for segmentation, summaries, Q&A
5. **RAG service** — retrieval + answer composition

### Layer 5 — Database Layer (Docker Postgres)
Integration tests against real Postgres:
1. Run migrations, verify schema
2. CRUD for source_videos, talks, transcripts, chunks
3. `match_chunks` vector search function
4. Full-text search

### Layer 6 — Pipeline Orchestration
Mocked services, test state machine:
1. State transitions (pending → downloading → ... → ready)
2. Error handling + retry
3. pg-boss job lifecycle

### Layer 7 — API Routes
Fastify injection with mock services:
1. Video submission, validation, dedup
2. Video/talk CRUD endpoints
3. Search endpoint
4. Q&A endpoint

### Layer 8 — End-to-End Smoke
Full pipeline with all mocks wired, verifying complete flow.

**Done signal per layer:** `vitest run && tsc --noEmit` passes.

**Commit discipline:** Each completed layer is committed as a clean, passing commit before starting the next layer.

---

## Worker Architecture

Separate process from Fastify API. Both deployed on Railway:

```toml
[services.api]
  start = "node dist/index.js"

[services.worker]
  start = "node dist/worker.js"
```

pg-boss config: `teamSize: 2`, `teamConcurrency: 1`. Retries up to 3 times with exponential backoff.

---

## Environment Variables

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_CONNECTION_STRING=
ASSEMBLYAI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
PORT=3000
NODE_ENV=production
```

---

## Post-MVP

- Auth (Clerk or Supabase Auth)
- Usage-based billing
- Playlist support
- Next.js frontend
- Cost tracking per video
- Vector index rebuild after bulk inserts
