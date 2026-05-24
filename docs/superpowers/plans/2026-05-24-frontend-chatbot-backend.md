# Frontend Chatbot — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the backend changes (CORS, rate limiting, citation fields, FAQ pre-generation, /faqs endpoint, day_label) needed to support the new public-facing Next.js frontend.

**Architecture:** Six small, mostly-independent changes to the existing Fastify + pg-boss backend. Schema migration adds two nullable columns. One new worker step for FAQ generation. One new route. CORS + rate-limit plugins wrap the existing server. `/qa` response is extended (additive, non-breaking) with citation fields the frontend renders as pills.

**Tech Stack:** Fastify, pg-boss, Postgres + pgvector, Anthropic Claude (Sonnet), Vitest, Docker Compose for tests.

**Spec:** `docs/superpowers/specs/2026-05-21-frontend-chatbot-design.md`

---

## File Structure

**New files:**
- `src/db/migrations/003_faqs_and_day_label.sql` — schema migration
- `src/services/faq-generation.ts` — pure FAQ generation logic (LLM-prompted, returns `Faq[]`)
- `src/workers/steps/generate-faqs.ts` — pipeline step: read talks, call FAQ service, persist
- `src/routes/faqs.ts` — `GET /faqs` endpoint
- `scripts/backfill-faqs.ts` — one-off script to populate FAQs + day_label for the two existing videos
- `tests/unit/faq-generation.test.ts` — FAQ service unit tests (mocked LLM)
- `tests/integration/generate-faqs.step.test.ts` — worker step test against real Postgres
- `tests/routes/faqs.test.ts` — `GET /faqs` route test
- `tests/integration/rate-limit.test.ts` — rate-limit integration test
- `tests/integration/cors.test.ts` — CORS header test

**Modified files:**
- `src/config.ts` — add `CORS_ALLOWED_ORIGIN`
- `src/server.ts` — register `@fastify/cors` + `@fastify/rate-limit`, register faqs route
- `src/db/queries.ts` — add `setSourceVideoFaqs`, `setSourceVideoDayLabel`, `getFaqsAcrossVideos`, extend `SourceVideoRow` with `faqs` + `day_label`
- `src/routes/qa.ts` — extend response with citation fields incl `youtube_deeplink`
- `src/workers/pipeline.worker.ts` — invoke the FAQ step after summarize
- `src/interfaces/llm.ts` — add `generateFaqs(transcript, talkSummaries)` method
- `src/services/llm.ts` — implement `generateFaqs` on `ClaudeLLMService`
- `tests/mocks/llm.mock.ts` — implement `generateFaqs` on mock
- `tests/integration/db-setup.ts` — add `003_faqs_and_day_label.sql` to migration list
- `tests/unit/config.test.ts` — tests for `CORS_ALLOWED_ORIGIN`
- `tests/routes/qa.test.ts` — extend assertions for citation fields

**Existing patterns to follow:**
- All zod-validated route bodies and config
- Tests use `tests/integration/db-setup.ts` helpers (`startContainer`, `waitForPostgres`, `applyMigrations`, `truncateAll`, `makeTestPool`)
- LLM access through `ILLMService` interface, never `Anthropic` directly in routes/workers
- Tests for `MockLLMService` constructor positional args: `(boundaries, summary, answer)` — extend with optional faqs arg

---

## Task 1: Schema migration (faqs + day_label columns)

**Files:**
- Create: `src/db/migrations/003_faqs_and_day_label.sql`
- Modify: `tests/integration/db-setup.ts`
- Test: `tests/integration/queries.test.ts` (gain one assertion via Task 2)

- [ ] **Step 1: Create migration file**

Create `src/db/migrations/003_faqs_and_day_label.sql`:

```sql
-- src/db/migrations/003_faqs_and_day_label.sql
alter table source_videos
  add column if not exists faqs jsonb,
  add column if not exists day_label text;
```

- [ ] **Step 2: Register migration in test harness**

Edit `tests/integration/db-setup.ts`. Find the `applyMigrations` function and add `'003_faqs_and_day_label.sql'` to the array:

```ts
export async function applyMigrations(pool: pg.Pool): Promise<void> {
  for (const file of ['001_initial.sql', '002_content_type.sql', '003_faqs_and_day_label.sql']) {
    const sql = readFileSync(resolve(`src/db/migrations/${file}`), 'utf8')
    await pool.query(sql)
  }
}
```

- [ ] **Step 3: Verify migration applies cleanly**

Run: `npm run test:integration -- tests/integration/queries.test.ts`
Expected: PASS — all existing queries tests still green after the new columns are added.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/003_faqs_and_day_label.sql tests/integration/db-setup.ts
git commit -m "feat(db): add faqs JSONB and day_label columns to source_videos"
```

---

## Task 2: Extend `SourceVideoRow` and add column-setter queries

**Files:**
- Modify: `src/db/queries.ts`
- Test: `tests/integration/queries.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/integration/queries.test.ts`. Add at the bottom of the file (inside the existing describe block, before `})`):

```ts
  it('setSourceVideoFaqs stores faqs jsonb and getSourceVideoById returns them', async () => {
    const { insertSourceVideo, setSourceVideoFaqs, getSourceVideoById } = await import('../../src/db/queries.js')
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/faq1', youtubeId: 'faq1' })
    const faqs = [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }]
    await setSourceVideoFaqs(pool, sv.id, faqs)
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.faqs).toEqual(faqs)
  })

  it('setSourceVideoDayLabel stores day_label', async () => {
    const { insertSourceVideo, setSourceVideoDayLabel, getSourceVideoById } = await import('../../src/db/queries.js')
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/day1', youtubeId: 'day1' })
    await setSourceVideoDayLabel(pool, sv.id, 'Day 1')
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.day_label).toBe('Day 1')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- tests/integration/queries.test.ts`
Expected: FAIL — `setSourceVideoFaqs is not a function` (and same for `setSourceVideoDayLabel`).

- [ ] **Step 3: Implement the queries**

Edit `src/db/queries.ts`. Add to the `SourceVideoRow` interface:

```ts
export interface SourceVideoRow {
  id: string
  youtube_url: string
  youtube_id: string
  title: string | null
  channel: string | null
  duration_seconds: number | null
  thumbnail_url: string | null
  has_chapters: boolean
  content_type: ContentType
  status: string
  error_message: string | null
  faqs: Array<{ question: string; answer: string }> | null
  day_label: string | null
  created_at: Date
  updated_at: Date
}
```

Then add these two functions after `updateSourceVideoMetadata`:

```ts
export async function setSourceVideoFaqs(
  pool: pg.Pool,
  id: string,
  faqs: Array<{ question: string; answer: string }>
): Promise<void> {
  await pool.query(
    `update source_videos set faqs = $2::jsonb, updated_at = now() where id = $1`,
    [id, JSON.stringify(faqs)]
  )
}

export async function setSourceVideoDayLabel(
  pool: pg.Pool,
  id: string,
  dayLabel: string
): Promise<void> {
  await pool.query(
    `update source_videos set day_label = $2, updated_at = now() where id = $1`,
    [id, dayLabel]
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- tests/integration/queries.test.ts`
Expected: PASS — both new tests pass; existing tests still pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts tests/integration/queries.test.ts
git commit -m "feat(db): add setSourceVideoFaqs, setSourceVideoDayLabel queries"
```

---

## Task 3: Add CORS config field

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `tests/unit/config.test.ts`. Add inside the existing `describe('loadConfig', ...)` block, after the last `it(...)`:

```ts
  it('accepts an optional CORS_ALLOWED_ORIGIN and exposes it on AppConfig', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.CORS_ALLOWED_ORIGIN = 'https://my-frontend.vercel.app'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.corsAllowedOrigin).toBe('https://my-frontend.vercel.app')
  })

  it('defaults corsAllowedOrigin to http://localhost:3001 when unset', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.CORS_ALLOWED_ORIGIN
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.corsAllowedOrigin).toBe('http://localhost:3001')
  })

  it('throws when CORS_ALLOWED_ORIGIN missing in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.YOUTUBE_COOKIES_B64 = 'eyJjb29raWUiOiAiZGF0YSJ9'
    delete process.env.CORS_ALLOWED_ORIGIN
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/CORS_ALLOWED_ORIGIN.*required.*production/i)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/config.test.ts`
Expected: FAIL — `cfg.corsAllowedOrigin` is undefined.

- [ ] **Step 3: Implement config changes**

Edit `src/config.ts`. Add to the zod `Schema`:

```ts
const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  YOUTUBE_COOKIES_B64: z.string().optional(),
  CORS_ALLOWED_ORIGIN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),
})
```

Add to the `AppConfig` interface:

```ts
export interface AppConfig {
  supabaseUrl?: string
  supabaseServiceRoleKey?: string
  databaseUrl: string
  assemblyaiApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  youtubeCookiesB64?: string
  corsAllowedOrigin: string
  port: number
  nodeEnv: string
}
```

In the `loadConfig` body, after the existing config object construction, set the default and add the prod-required check (place this block right after the existing `YOUTUBE_COOKIES_B64` production check):

```ts
  const config: AppConfig = {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: parsed.data.SUPABASE_CONNECTION_STRING,
    assemblyaiApiKey: parsed.data.ASSEMBLYAI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    youtubeCookiesB64: parsed.data.YOUTUBE_COOKIES_B64,
    corsAllowedOrigin: parsed.data.CORS_ALLOWED_ORIGIN ?? 'http://localhost:3001',
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
  }

  if (config.nodeEnv === 'production' && !config.youtubeCookiesB64) {
    throw new Error(
      'Invalid config: YOUTUBE_COOKIES_B64 is required in production ' +
      '(see docs/cloud-setup-tutorial.md Step 1.7)'
    )
  }
  if (config.nodeEnv === 'production' && !parsed.data.CORS_ALLOWED_ORIGIN) {
    throw new Error(
      'Invalid config: CORS_ALLOWED_ORIGIN is required in production ' +
      '(set it to the deployed frontend origin, e.g. https://your-app.vercel.app)'
    )
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/config.test.ts`
Expected: PASS — all config tests green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat(config): add CORS_ALLOWED_ORIGIN with prod requirement"
```

---

## Task 4: Wire `@fastify/cors`

**Files:**
- Modify: `src/server.ts`, `src/index.ts`
- Test: `tests/integration/cors.test.ts` (new)
- Install: `@fastify/cors`

- [ ] **Step 1: Install dependency**

Run: `npm install @fastify/cors`
Expected: dependency added to `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/integration/cors.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from './db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

const pool = makeTestPool()
let app: FastifyInstance

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService(),
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'https://my-frontend.vercel.app',
  })
}, 90_000)

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('CORS', () => {
  it('responds with Access-Control-Allow-Origin for the configured origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://my-frontend.vercel.app',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('https://my-frontend.vercel.app')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/cors.test.ts`
Expected: FAIL — either `corsAllowedOrigin` not on `AppDeps` (TS error) or missing CORS header.

- [ ] **Step 4: Add `corsAllowedOrigin` to AppDeps and register cors plugin**

Edit `src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Pool } from 'pg'
import type { IYouTubeService } from './interfaces/youtube.js'
import type { ITranscriptionService } from './interfaces/assemblyai.js'
import type { IEmbeddingService } from './interfaces/embeddings.js'
import type { ILLMService } from './interfaces/llm.js'
import { registerVideoRoutes } from './routes/videos.js'
import { registerTalkRoutes } from './routes/talks.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerQaRoutes } from './routes/qa.js'
import type { PipelineJobData } from './queues/jobs.js'

export interface AppDeps {
  pool: Pool
  youtube: IYouTubeService
  transcription: ITranscriptionService
  embeddings: IEmbeddingService
  llm: ILLMService
  enqueueJob: (data: PipelineJobData) => Promise<string>
  corsAllowedOrigin: string
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cors, { origin: deps.corsAllowedOrigin })
  app.get('/health', async () => ({ status: 'ok' }))
  await registerVideoRoutes(app, deps)
  await registerTalkRoutes(app, deps)
  await registerSearchRoutes(app, deps)
  await registerQaRoutes(app, deps)
  return app
}
```

- [ ] **Step 5: Wire the new field in src/index.ts**

Edit `src/index.ts`. Add `corsAllowedOrigin: cfg.corsAllowedOrigin` to the `buildServer` call:

```ts
const app = await buildServer({
  pool,
  youtube: new YouTubeService({ cookiesPath, ytDlpPath: resolveYtDlpPath() }),
  transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
  embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
  llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
  enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
  corsAllowedOrigin: cfg.corsAllowedOrigin,
})
```

- [ ] **Step 6: Update existing test files that build the server**

The `corsAllowedOrigin` field is now required on `AppDeps`. Update every test that calls `buildServer`:

Find all such tests:

```bash
grep -rln "buildServer({" tests/
```

For each match, add `corsAllowedOrigin: 'http://localhost:3001',` to the `buildServer` deps object. Example (for `tests/routes/qa.test.ts`):

```ts
app = await buildServer({
  pool,
  youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
  transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
  embeddings: new MockEmbeddingService(),
  llm,
  enqueueJob: async () => 'job-1',
  corsAllowedOrigin: 'http://localhost:3001',
})
```

- [ ] **Step 7: Run all tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all unit + route tests pass.

Run: `npm run test:integration -- tests/integration/cors.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/server.ts src/index.ts tests/integration/cors.test.ts tests/routes/*.ts tests/smoke/*.ts
git commit -m "feat(api): register @fastify/cors with configured allowed origin"
```

---

## Task 5: Wire `@fastify/rate-limit` on `/qa` and `/search`

**Files:**
- Modify: `src/server.ts`, `src/routes/qa.ts`, `src/routes/search.ts`
- Test: `tests/integration/rate-limit.test.ts` (new)
- Install: `@fastify/rate-limit`

- [ ] **Step 1: Install dependency**

Run: `npm install @fastify/rate-limit`
Expected: dependency added to `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/integration/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from './db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

const pool = makeTestPool()
let app: FastifyInstance

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService([], '', 'answer'),
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 90_000)

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('Rate limit on /qa', () => {
  it('returns 429 after exceeding the per-hour cap', async () => {
    // Hit /qa 10 times — all should be 200 (or 500 from no chunks; both are non-429)
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/qa',
        headers: { 'x-forwarded-for': '1.2.3.4' },
        payload: { question: `q${i}` },
      })
      expect(res.statusCode).not.toBe(429)
    }
    // 11th request from the same IP should be limited
    const res = await app.inject({
      method: 'POST',
      url: '/qa',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      payload: { question: 'q11' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/rate-limit.test.ts`
Expected: FAIL — request 11 returns 200 (or 500), not 429.

- [ ] **Step 4: Register the plugin**

Edit `src/server.ts`. Import and register `@fastify/rate-limit` globally (Fastify rate-limit doesn't gate by default — it adds route-level config support):

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
// ...
export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true })
  await app.register(cors, { origin: deps.corsAllowedOrigin })
  await app.register(rateLimit, { global: false })
  app.get('/health', async () => ({ status: 'ok' }))
  await registerVideoRoutes(app, deps)
  await registerTalkRoutes(app, deps)
  await registerSearchRoutes(app, deps)
  await registerQaRoutes(app, deps)
  return app
}
```

Note: `trustProxy: true` makes Fastify honor `x-forwarded-for` (required on Railway behind their proxy and for the test using `x-forwarded-for`).

- [ ] **Step 5: Apply route-level rate limit to `/qa`**

Edit `src/routes/qa.ts`. Add a `config` block on the route:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { matchChunks, getTalkById } from '../db/queries.js'
import { buildRagContext, type ChunkForContext } from '../services/rag.js'

const Body = z.object({
  question: z.string().min(1),
  talk_id: z.string().uuid().optional(),
})

export async function registerQaRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/qa',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

      const [queryEmbedding] = await deps.embeddings.embed([parsed.data.question])
      if (!queryEmbedding) return reply.code(500).send({ error: 'embedding failed' })

      const chunks = await matchChunks(deps.pool, queryEmbedding, 8, parsed.data.talk_id)
      const contextChunks: ChunkForContext[] = []
      for (const c of chunks) {
        const talk = await getTalkById(deps.pool, c.talk_id)
        contextChunks.push({
          id: c.id,
          text: c.text,
          talkTitle: talk?.title ?? '',
          speaker: talk?.speaker ?? '',
          startMs: c.start_ms ?? 0,
        })
      }
      const context = buildRagContext(contextChunks)
      const answer = await deps.llm.answerQuestion(parsed.data.question, context)

      return {
        answer,
        sources: chunks.map((c) => ({
          chunk_id: c.id,
          talk_id: c.talk_id,
          text: c.text,
          start_ms: c.start_ms,
          end_ms: c.end_ms,
          similarity: c.similarity,
        })),
      }
    }
  )
}
```

- [ ] **Step 6: Apply rate limit to `/search`**

Read the current `src/routes/search.ts`:

```bash
cat src/routes/search.ts
```

For the existing `app.post('/search', async (req, reply) => {...})`, change the signature to include the same config block:

```ts
app.post(
  '/search',
  {
    config: {
      rateLimit: { max: 10, timeWindow: '1 hour' },
    },
  },
  async (req, reply) => {
    // existing handler body unchanged
  }
)
```

- [ ] **Step 7: Run all tests**

Run: `npm run typecheck && npm test && npm run test:integration -- tests/integration/rate-limit.test.ts`
Expected: All pass; rate-limit test confirms 11th call returns 429.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/server.ts src/routes/qa.ts src/routes/search.ts tests/integration/rate-limit.test.ts
git commit -m "feat(api): rate limit /qa and /search at 10 req/hour/IP"
```

---

## Task 6: Extend `/qa` response with citation fields

**Files:**
- Modify: `src/db/queries.ts` (small helper), `src/routes/qa.ts`
- Test: `tests/routes/qa.test.ts`

- [ ] **Step 1: Add a query helper for source-video lookup**

Edit `src/db/queries.ts`. Add this helper after `getSourceVideoById`:

```ts
export async function getSourceVideoForTalk(
  pool: pg.Pool,
  talkId: string
): Promise<{ source_video_id: string; youtube_id: string; title: string | null; day_label: string | null } | null> {
  const { rows } = await pool.query(
    `select sv.id as source_video_id, sv.youtube_id, sv.title, sv.day_label
       from talks t join source_videos sv on t.source_video_id = sv.id
      where t.id = $1`,
    [talkId]
  )
  return rows[0] ?? null
}
```

- [ ] **Step 2: Write the failing test**

Edit `tests/routes/qa.test.ts`. Replace the existing `it('returns answer with sources', ...)` body to also assert the new citation fields. Append `setSourceVideoDayLabel` to the imports and add the assertions:

```ts
import {
  insertSourceVideo,
  insertTalk,
  insertTranscript,
  insertChunk,
  setSourceVideoDayLabel,
} from '../../src/db/queries.js'
```

Add a new test below the existing one:

```ts
  it('returns citations with youtube_deeplink for each source', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
      title: 'Day 1 talks',
    })
    await setSourceVideoDayLabel(pool, sv.id, 'Day 1')
    const talk = await insertTalk(pool, {
      sourceVideoId: sv.id,
      title: 'Daytona Sandboxes',
      speaker: 'Speaker A',
      talkIndex: 0,
      startMs: 30_000,
      endMs: 60_000,
    })
    const tr = await insertTranscript(pool, {
      talkId: talk.id,
      assemblyaiId: 'tx2',
      rawText: '',
      utterances: [],
    })
    await insertChunk(pool, {
      talkId: talk.id,
      transcriptId: tr.id,
      chunkIndex: 0,
      text: 'Daytona uses isolated sandboxes',
      startMs: 32_000,
      endMs: 40_000,
      tokenCount: 5,
      embedding: vec(2),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/qa',
      payload: { question: 'How does Daytona manage sandboxes?' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.citations)).toBe(true)
    expect(body.citations.length).toBeGreaterThan(0)
    const c = body.citations[0]
    expect(c.video_id).toBe(sv.id)
    expect(c.video_title).toBe('Day 1 talks')
    expect(c.day_label).toBe('Day 1')
    expect(c.talk_id).toBe(talk.id)
    expect(c.talk_title).toBe('Daytona Sandboxes')
    expect(c.start_ms).toBe(32_000)
    expect(c.youtube_deeplink).toBe('https://youtu.be/abc?t=32')
  })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration -- tests/routes/qa.test.ts`
Expected: FAIL — `body.citations` is `undefined`.

- [ ] **Step 4: Implement citation building in the route**

Edit `src/routes/qa.ts`. Add `getSourceVideoForTalk` to the imports and extend the response. Replace the return block with:

```ts
import { matchChunks, getTalkById, getSourceVideoForTalk } from '../db/queries.js'
// ...

      const citations = []
      for (const c of chunks) {
        const sv = await getSourceVideoForTalk(deps.pool, c.talk_id)
        const talk = await getTalkById(deps.pool, c.talk_id)
        if (!sv || !talk) continue
        const startSeconds = Math.floor((c.start_ms ?? 0) / 1000)
        citations.push({
          video_id: sv.source_video_id,
          video_title: sv.title,
          day_label: sv.day_label,
          talk_id: c.talk_id,
          talk_title: talk.title,
          start_ms: c.start_ms ?? 0,
          youtube_deeplink: `https://youtu.be/${sv.youtube_id}?t=${startSeconds}`,
        })
      }

      return {
        answer,
        sources: chunks.map((c) => ({
          chunk_id: c.id,
          talk_id: c.talk_id,
          text: c.text,
          start_ms: c.start_ms,
          end_ms: c.end_ms,
          similarity: c.similarity,
        })),
        citations,
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:integration -- tests/routes/qa.test.ts`
Expected: PASS — both old and new tests pass.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts src/routes/qa.ts tests/routes/qa.test.ts
git commit -m "feat(qa): add citations array with youtube_deeplink in /qa response"
```

---

## Task 7: Add `generateFaqs` to LLM interface + Claude implementation

**Files:**
- Modify: `src/interfaces/llm.ts`, `src/services/llm.ts`, `tests/mocks/llm.mock.ts`

- [ ] **Step 1: Extend the interface**

Edit `src/interfaces/llm.ts`:

```ts
import type { TalkBoundary } from '../types/index.js'

export interface FaqItem {
  question: string
  answer: string
}

export interface FaqGenerationInput {
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  answerQuestion(question: string, context: string): Promise<string>
  generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]>
}
```

- [ ] **Step 2: Implement on Claude service**

Edit `src/services/llm.ts`. Add a zod schema near the existing `BoundaryArraySchema` and the implementation method:

```ts
const FaqSchema = z.object({
  question: z.string(),
  answer: z.string(),
})
const FaqArraySchema = z.array(FaqSchema)
```

Then add the method on `ClaudeLLMService`:

```ts
  async generateFaqs(input: { videoTitle: string; talks: Array<{ title: string; summary: string }> }): Promise<Array<{ question: string; answer: string }>> {
    const sys =
      'Generate 6 FAQ pairs a curious visitor would ask about this video. ' +
      'Each answer must be grounded in the provided talk summaries (do not invent facts). ' +
      'Keep answers concise (1-3 sentences). ' +
      'Respond with ONLY a JSON array of {question, answer} objects. No prose.'
    const talksBlock = input.talks
      .map((t, i) => `Talk ${i + 1}: ${t.title}\nSummary: ${t.summary}`)
      .join('\n\n')
    const user = `Video title: ${input.videoTitle}\n\n${talksBlock}`
    const txt = await this.invoke(sys, user, 2048)
    const match = txt.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('Claude generateFaqs: no JSON array in response')
    const raw = JSON.parse(match[0])
    const result = FaqArraySchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        `Claude generateFaqs: malformed array: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      )
    }
    return result.data
  }
```

- [ ] **Step 3: Update the mock LLM**

Edit `tests/mocks/llm.mock.ts`:

```ts
import type { ILLMService, FaqItem, FaqGenerationInput } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public answerCalls: { question: string; context: string }[] = []
  public faqCalls: FaqGenerationInput[] = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private answer = 'Mock answer.',
    private faqs: FaqItem[] = [
      { question: 'q1?', answer: 'a1.' },
      { question: 'q2?', answer: 'a2.' },
    ]
  ) {}

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    this.segmentCalls.push(transcript)
    return this.boundaries
  }
  async summarizeTalk(transcript: string): Promise<string> {
    this.summarizeCalls.push(transcript)
    return this.summary
  }
  async answerQuestion(question: string, context: string): Promise<string> {
    this.answerCalls.push({ question, context })
    return this.answer
  }
  async generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]> {
    this.faqCalls.push(input)
    return this.faqs
  }
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: clean — no callers of `MockLLMService` break because the new arg is optional.

- [ ] **Step 5: Run unit tests**

Run: `npm test`
Expected: all unit tests still pass (e.g. `tests/unit/llm.test.ts` may or may not exercise FAQs; existing tests stay green).

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/llm.ts src/services/llm.ts tests/mocks/llm.mock.ts
git commit -m "feat(llm): add generateFaqs to ILLMService and ClaudeLLMService"
```

---

## Task 8: Pure FAQ-generation worker step

**Files:**
- Create: `src/workers/steps/generate-faqs.ts`
- Create: `tests/unit/faq-generation.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/faq-generation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateFaqsForVideo } from '../../src/workers/steps/generate-faqs.js'
import { MockLLMService } from '../mocks/llm.mock.js'

describe('generateFaqsForVideo', () => {
  it('passes the video title and talk summaries to the LLM, returns the faqs', async () => {
    const llm = new MockLLMService([], 'unused', 'unused', [
      { question: 'What is this?', answer: 'A talk.' },
    ])
    const result = await generateFaqsForVideo({
      llm,
      videoTitle: 'AI Engineer Day 1',
      talks: [
        { title: 'Daytona Sandboxes', summary: 'How Daytona isolates user code.' },
        { title: 'Vector DBs', summary: 'A tour of vector stores.' },
      ],
    })
    expect(result).toEqual([{ question: 'What is this?', answer: 'A talk.' }])
    expect(llm.faqCalls).toHaveLength(1)
    expect(llm.faqCalls[0]?.videoTitle).toBe('AI Engineer Day 1')
    expect(llm.faqCalls[0]?.talks).toHaveLength(2)
  })

  it('returns an empty array when there are no talks', async () => {
    const llm = new MockLLMService([], 'unused', 'unused', [
      { question: 'Q', answer: 'A' },
    ])
    const result = await generateFaqsForVideo({
      llm,
      videoTitle: 'Empty',
      talks: [],
    })
    expect(result).toEqual([])
    expect(llm.faqCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/faq-generation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the step**

Create `src/workers/steps/generate-faqs.ts`:

```ts
import type { ILLMService, FaqItem } from '../../src/interfaces/llm.js'

export interface GenerateFaqsInput {
  llm: ILLMService
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export async function generateFaqsForVideo(input: GenerateFaqsInput): Promise<FaqItem[]> {
  if (input.talks.length === 0) return []
  return input.llm.generateFaqs({
    videoTitle: input.videoTitle,
    talks: input.talks,
  })
}
```

Note: the relative import path is `../../src/interfaces/llm.js` because the test file lives at `tests/unit/...`. From within `src/workers/steps/generate-faqs.ts`, the correct path is `../../interfaces/llm.js`. Use this corrected version:

```ts
import type { ILLMService, FaqItem } from '../../interfaces/llm.js'

export interface GenerateFaqsInput {
  llm: ILLMService
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export async function generateFaqsForVideo(input: GenerateFaqsInput): Promise<FaqItem[]> {
  if (input.talks.length === 0) return []
  return input.llm.generateFaqs({
    videoTitle: input.videoTitle,
    talks: input.talks,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/faq-generation.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/workers/steps/generate-faqs.ts tests/unit/faq-generation.test.ts
git commit -m "feat(worker): pure generateFaqsForVideo step"
```

---

## Task 9: Wire FAQ step into pipeline + persistence

**Files:**
- Modify: `src/workers/pipeline.worker.ts`
- Test: `tests/integration/generate-faqs.step.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/generate-faqs.step.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import PgBoss from 'pg-boss'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
  TEST_DATABASE_URL,
} from './db-setup.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { getSourceVideoById, insertSourceVideo, insertTalk } from '../../src/db/queries.js'

const pool = makeTestPool()
let boss: PgBoss

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await boss.stop()
  await pool.end()
})

describe('FAQ pipeline step', () => {
  it('populates source_videos.faqs after the pipeline runs', async () => {
    const fakeFaqs = [{ question: 'q1?', answer: 'a1.' }]
    const llm = new MockLLMService(
      [{ title: 'Talk 1', speaker: 'A', startMs: 0, endMs: 1000 }],
      'Mock summary.',
      'unused',
      fakeFaqs
    )
    await registerPipelineWorker(boss, {
      pool,
      youtube: new MockYouTubeService({
        title: 'AI Engineer Day 1',
        channel: 'AI Engineer',
        durationSeconds: 60,
        thumbnailUrl: '',
        chapters: [],
      }),
      transcription: new MockTranscriptionService({
        assemblyaiId: 'tx',
        rawText: 'words',
        utterances: [{ start: 0, end: 1000, text: 'words', speaker: 'A' }],
      }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: '/tmp',
    })

    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/zzz',
      youtubeId: 'zzz',
    })
    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/zzz',
      contentType: 'single_speaker',
    })

    // Wait for the pipeline to finish (mirrors existing pipeline-worker.test pattern)
    const deadline = Date.now() + 30_000
    let row = await getSourceVideoById(pool, sv.id)
    while (Date.now() < deadline && row?.faqs == null) {
      await new Promise((r) => setTimeout(r, 250))
      row = await getSourceVideoById(pool, sv.id)
    }
    expect(row?.faqs).toEqual(fakeFaqs)
    expect(llm.faqCalls).toHaveLength(1)
  }, 60_000)

  it('skips FAQ generation when faqs are already populated (idempotent)', async () => {
    const llm = new MockLLMService(
      [{ title: 'Talk 1', speaker: 'A', startMs: 0, endMs: 1000 }],
      'Mock summary.',
      'unused',
      [{ question: 'shouldnotbeused', answer: '...' }]
    )
    await registerPipelineWorker(boss, {
      pool,
      youtube: new MockYouTubeService({
        title: 't', channel: 'c', durationSeconds: 1, thumbnailUrl: '', chapters: [],
      }),
      transcription: new MockTranscriptionService({
        assemblyaiId: 'tx',
        rawText: 'words',
        utterances: [{ start: 0, end: 1000, text: 'words', speaker: 'A' }],
      }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: '/tmp',
    })

    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/idem',
      youtubeId: 'idem',
    })
    // Pre-populate faqs to simulate a prior run
    await pool.query(
      `update source_videos set faqs = $2::jsonb where id = $1`,
      [sv.id, JSON.stringify([{ question: 'pre', answer: 'existing' }])]
    )
    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/idem',
      contentType: 'single_speaker',
    })

    // Wait long enough for pipeline; faqs should remain the pre-populated value
    await new Promise((r) => setTimeout(r, 5000))
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.faqs).toEqual([{ question: 'pre', answer: 'existing' }])
    expect(llm.faqCalls).toHaveLength(0)
  }, 60_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/generate-faqs.step.test.ts`
Expected: FAIL — faqs are never populated; first test times out.

- [ ] **Step 3: Wire the step in the pipeline worker**

Edit `src/workers/pipeline.worker.ts`:

```ts
import type PgBoss from 'pg-boss'
import { runDownload } from './steps/download.js'
import { runTranscribe } from './steps/transcribe.js'
import { runSegment } from './steps/segment.js'
import { runEmbed } from './steps/embed.js'
import { runSummarize } from './steps/summarize.js'
import { generateFaqsForVideo } from './steps/generate-faqs.js'
import {
  updateSourceVideoStatus,
  setSourceVideoFaqs,
  getSourceVideoById,
  listTalksForVideo,
  getTranscriptByTalkId,
} from '../db/queries.js'
import { QUEUE_PIPELINE, type PipelineJobData } from '../queues/jobs.js'
import type { PipelineDeps } from './types.js'

export async function registerPipelineWorker(
  boss: PgBoss,
  deps: PipelineDeps
): Promise<void> {
  await boss.work<PipelineJobData>(
    QUEUE_PIPELINE,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return
      const ctx = { ...deps, sourceVideoId: job.data.sourceVideoId, youtubeUrl: job.data.youtubeUrl }
      try {
        const dl = await runDownload(ctx)
        const meta = await deps.youtube.getMetadata(job.data.youtubeUrl)
        const transcription = await runTranscribe(ctx, { audioPath: dl.audioPath })
        const seg = await runSegment(ctx, {
          transcription,
          chapters: meta.chapters,
          contentType: job.data.contentType,
          videoTitle: meta.title,
        })
        const embedTalks = seg.talkIds.map((t) => ({
          talkId: t.talkId, transcriptId: t.transcriptId, utterances: t.utterances,
        }))
        const summarizeTalks = seg.talkIds.map((t) => ({
          talkId: t.talkId, transcriptId: t.transcriptId, text: t.text,
        }))
        await runEmbed(ctx, { talks: embedTalks })
        await runSummarize(ctx, { talks: summarizeTalks })

        // FAQ generation step — idempotent
        const existing = await getSourceVideoById(deps.pool, job.data.sourceVideoId)
        if (existing && existing.faqs == null) {
          const talks = await listTalksForVideo(deps.pool, job.data.sourceVideoId)
          const summaries: Array<{ title: string; summary: string }> = []
          for (const t of talks) {
            const tr = await getTranscriptByTalkId(deps.pool, t.id)
            summaries.push({ title: t.title ?? '', summary: tr?.summary ?? '' })
          }
          const faqs = await generateFaqsForVideo({
            llm: deps.llm,
            videoTitle: meta.title,
            talks: summaries,
          })
          if (faqs.length > 0) {
            await setSourceVideoFaqs(deps.pool, job.data.sourceVideoId, faqs)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await updateSourceVideoStatus(deps.pool, job.data.sourceVideoId, 'error', msg)
        throw err
      }
    }
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- tests/integration/generate-faqs.step.test.ts`
Expected: PASS — both new tests pass.

Run: `npm run test:integration -- tests/integration/pipeline-worker.test.ts`
Expected: PASS — existing pipeline-worker integration test still green.

Run: `npm run typecheck && npm test`
Expected: all unit tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/workers/pipeline.worker.ts tests/integration/generate-faqs.step.test.ts
git commit -m "feat(worker): generate FAQs after summarize step, idempotent"
```

---

## Task 10: `GET /faqs` endpoint

**Files:**
- Create: `src/routes/faqs.ts`
- Modify: `src/db/queries.ts`, `src/server.ts`
- Test: `tests/routes/faqs.test.ts` (new)

- [ ] **Step 1: Add a union-query helper**

Edit `src/db/queries.ts`. Add this function after `setSourceVideoDayLabel`:

```ts
export interface FaqRow {
  question: string
  answer: string
  video_id: string
  video_title: string | null
  day_label: string | null
}

export async function getFaqsAcrossVideos(pool: pg.Pool): Promise<FaqRow[]> {
  const { rows } = await pool.query(
    `select sv.id as video_id, sv.title as video_title, sv.day_label, faq
       from source_videos sv,
            jsonb_array_elements(sv.faqs) as faq
      where sv.status = 'ready' and sv.faqs is not null
      order by sv.day_label nulls last, sv.created_at`
  )
  return rows.map((r) => ({
    question: r.faq.question,
    answer: r.faq.answer,
    video_id: r.video_id,
    video_title: r.video_title,
    day_label: r.day_label,
  }))
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/routes/faqs.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo,
  setSourceVideoFaqs,
  setSourceVideoDayLabel,
  updateSourceVideoStatus,
} from '../../src/db/queries.js'

const pool = makeTestPool()
let app: FastifyInstance

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService(),
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('GET /faqs', () => {
  it('returns flat list across ready videos with day_label', async () => {
    const v1 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v1', youtubeId: 'v1', title: 'Day 1',
    })
    await updateSourceVideoStatus(pool, v1.id, 'ready')
    await setSourceVideoDayLabel(pool, v1.id, 'Day 1')
    await setSourceVideoFaqs(pool, v1.id, [{ question: 'q1', answer: 'a1' }])

    const v2 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v2', youtubeId: 'v2', title: 'Day 2',
    })
    await updateSourceVideoStatus(pool, v2.id, 'ready')
    await setSourceVideoDayLabel(pool, v2.id, 'Day 2')
    await setSourceVideoFaqs(pool, v2.id, [{ question: 'q2', answer: 'a2' }])

    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.faqs).toHaveLength(2)
    expect(body.faqs[0].day_label).toBe('Day 1')
    expect(body.faqs[1].day_label).toBe('Day 2')
    expect(body.faqs[0].question).toBe('q1')
  })

  it('omits videos that are not ready', async () => {
    const v1 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v1', youtubeId: 'v1', title: 't',
    })
    // status is 'pending' by default
    await setSourceVideoFaqs(pool, v1.id, [{ question: 'q', answer: 'a' }])

    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.statusCode).toBe(200)
    expect(res.json().faqs).toEqual([])
  })

  it('returns Cache-Control with max-age=300', async () => {
    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.headers['cache-control']).toContain('max-age=300')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration -- tests/routes/faqs.test.ts`
Expected: FAIL — `/faqs` returns 404 (route not registered).

- [ ] **Step 4: Implement the route**

Create `src/routes/faqs.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
import { getFaqsAcrossVideos } from '../db/queries.js'

export async function registerFaqRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/faqs', async (_req, reply) => {
    const faqs = await getFaqsAcrossVideos(deps.pool)
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
    return { faqs }
  })
}
```

- [ ] **Step 5: Register the route in the server**

Edit `src/server.ts`:

```ts
import { registerFaqRoutes } from './routes/faqs.js'
// ...
export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true })
  await app.register(cors, { origin: deps.corsAllowedOrigin })
  await app.register(rateLimit, { global: false })
  app.get('/health', async () => ({ status: 'ok' }))
  await registerVideoRoutes(app, deps)
  await registerTalkRoutes(app, deps)
  await registerSearchRoutes(app, deps)
  await registerQaRoutes(app, deps)
  await registerFaqRoutes(app, deps)
  return app
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:integration -- tests/routes/faqs.test.ts`
Expected: PASS — all three faqs tests green.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/faqs.ts src/db/queries.ts src/server.ts tests/routes/faqs.test.ts
git commit -m "feat(api): GET /faqs returns flat list across ready videos"
```

---

## Task 11: Backfill script for existing videos

**Files:**
- Create: `scripts/backfill-faqs.ts`

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-faqs.ts`:

```ts
/**
 * scripts/backfill-faqs.ts
 *
 * One-off script to populate source_videos.faqs for videos that reached
 * 'ready' before the FAQ pipeline step existed.
 *
 * Usage:
 *   npm run build && node dist/scripts/backfill-faqs.js
 *
 * Side effects:
 *   - Calls Anthropic Claude for each ready video missing faqs
 *   - Updates source_videos.faqs in Postgres
 *
 * Run twice safely — videos with non-null faqs are skipped.
 */
import { Pool } from 'pg'
import { loadConfig } from '../src/config.js'
import { ClaudeLLMService } from '../src/services/llm.js'
import { generateFaqsForVideo } from '../src/workers/steps/generate-faqs.js'
import {
  listTalksForVideo,
  getTranscriptByTalkId,
  setSourceVideoFaqs,
} from '../src/db/queries.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const llm = ClaudeLLMService.fromApiKey(cfg.anthropicApiKey)

  const { rows } = await pool.query(
    `select id, title from source_videos where status = 'ready' and faqs is null`
  )
  if (rows.length === 0) {
    console.log('No videos require FAQ backfill.')
    await pool.end()
    return
  }

  for (const v of rows) {
    console.log(`Generating FAQs for ${v.id} (${v.title})...`)
    const talks = await listTalksForVideo(pool, v.id)
    const summaries: Array<{ title: string; summary: string }> = []
    for (const t of talks) {
      const tr = await getTranscriptByTalkId(pool, t.id)
      summaries.push({ title: t.title ?? '', summary: tr?.summary ?? '' })
    }
    const faqs = await generateFaqsForVideo({
      llm,
      videoTitle: v.title ?? 'Untitled',
      talks: summaries,
    })
    if (faqs.length > 0) {
      await setSourceVideoFaqs(pool, v.id, faqs)
      console.log(`  → wrote ${faqs.length} FAQs`)
    } else {
      console.log('  → skipped (no talks)')
    }
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify the script compiles**

Run: `npm run typecheck`
Expected: clean (the file is included by `tsc --noEmit` over the project).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-faqs.ts
git commit -m "feat(scripts): backfill-faqs script for legacy ready videos"
```

---

## Task 12: Final verification gate + PR

**Files:** none — verification only

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`
Expected: all unit + route tests pass (the smoke test imports `buildServer` — make sure that file also includes `corsAllowedOrigin` per Task 4 step 6).

- [ ] **Step 2: Run integration suite**

Run: `npm run test:integration`
Expected: all integration tests pass, including the three new ones (`cors.test.ts`, `rate-limit.test.ts`, `generate-faqs.step.test.ts`, `routes/faqs.test.ts`).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Open the PR**

Run:

```bash
git push -u origin feat/frontend-chatbot-spec
gh pr create --title "feat: backend support for frontend chatbot (CORS, rate limit, FAQs, citations)" --body "$(cat <<'EOF'
## Summary
- Adds CORS plugin with required `CORS_ALLOWED_ORIGIN` config in production
- Rate-limits `/qa` and `/search` to 10 req/hour/IP via @fastify/rate-limit
- Extends `/qa` response with structured citation fields including `youtube_deeplink`
- New `source_videos.faqs` (JSONB) and `source_videos.day_label` columns (migration 003)
- New pipeline step generates FAQs after summarize; idempotent
- New `GET /faqs` endpoint returns the flat union of FAQs across ready videos with `Cache-Control`
- `scripts/backfill-faqs.ts` populates FAQs for the two existing ready videos

## Spec
`docs/superpowers/specs/2026-05-21-frontend-chatbot-design.md`

## Test plan
- [x] `npm run typecheck` clean
- [x] `npm test` — all unit + route tests pass
- [x] `npm run test:integration` — new tests for CORS, rate-limit, FAQ pipeline, /faqs route all pass

## Operator follow-up
After merge + Railway redeploy:
1. Set `CORS_ALLOWED_ORIGIN` on both Railway services (api + worker) to the Vercel frontend origin
2. Run `psql ... -c "UPDATE source_videos SET day_label = 'Day 1' WHERE youtube_id = ...; UPDATE source_videos SET day_label = 'Day 2' WHERE youtube_id = ...;"`
3. Run `node dist/scripts/backfill-faqs.js` once

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens with the listed changes.

---

## Self-Review

**Spec coverage check:**

| Spec section | Task(s) implementing it |
|---|---|
| Hero (frontend) | Out of scope (frontend plan) |
| Chatbox (frontend) | Out of scope (frontend plan) |
| Schedule (frontend) | Out of scope (frontend plan) |
| Backend §1 CORS | Tasks 3, 4 |
| Backend §2 Rate limiting | Task 5 |
| Backend §3 `/qa` citations w/ youtube_deeplink | Task 6 |
| Backend §4 FAQ pre-generation worker step | Tasks 1, 2, 7, 8, 9 |
| Backend §5 `GET /faqs` endpoint | Task 10 |
| Migration adds `faqs` JSONB + `day_label` TEXT | Task 1 |
| Backfill script | Task 11 |
| Unit + integration tests | Tasks 2, 3, 4, 5, 6, 8, 9, 10 |
| Verification gate (`typecheck` + `test:all`) | Task 12 |

All backend spec items covered. Frontend items intentionally deferred to a separate plan.

**Placeholder scan:** No "TBD," no "add validation," no "implement later." Every code step contains the full content. Backfill script note that "Run twice safely — videos with non-null faqs are skipped" is real behavior (the `select … where faqs is null` clause).

**Type consistency:** `FaqItem = { question; answer }` defined once in `src/interfaces/llm.ts` (Task 7) and used throughout (Tasks 8, 9, 10, 11). `setSourceVideoFaqs` signature consistent across Tasks 2, 9, 10, 11. `corsAllowedOrigin: string` consistent across `AppConfig` (Task 3) and `AppDeps` (Task 4). `youtube_deeplink` format `https://youtu.be/<id>?t=<seconds>` consistent between spec, Task 6 implementation, and Task 6 test.

**One known wrinkle:** Task 4 step 6 requires updating *every* `buildServer({...})` call site in tests. The grep command lists them; the engineer needs to add `corsAllowedOrigin` to each. Listed in the task and the grep command shows them concretely — this isn't a placeholder, it's a mechanical fan-out.
