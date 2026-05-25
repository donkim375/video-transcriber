# Backend Plan — FE↔BE Integration (`video-transcriber/`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `/faqs` endpoint and enrich `GET /talks` with `day_label` + `youtube_id` (joined from `source_videos`) so the frontend can render the schedule and group by day.

**Architecture:** Two route changes in `src/routes/`. One query change. Strict TDD — failing test first, then implementation.

**Tech Stack:** Fastify, Vitest, pg, Postgres (pgvector). Tests use `app.inject()` against a real Docker Postgres seeded with the project's migrations (see `tests/integration/db-setup.ts`).

**Working directory:** `/Users/donkim/Code/video-transcriber/video-transcriber/`

---

## Pre-flight

- [ ] **Step 0a: Confirm clean working tree and current branch**

```bash
cd /Users/donkim/Code/video-transcriber/video-transcriber
git status
git rev-parse --abbrev-ref HEAD
```
Expected: working tree clean, on a feature branch (create `feat/fe-be-integration-backend` if not).

- [ ] **Step 0b: Start the test Postgres container**

```bash
docker compose -f docker-compose.test.yml up -d
```
Expected: `pgvector` container `Up` on port `54329`. Verify with `docker ps | grep pgvector`.

- [ ] **Step 0c: Baseline — full test suite passes today**

```bash
npm test
```
Expected: all green. If anything is red before you start, stop and surface it — do not proceed.

---

## Task 1: RED — enriched `GET /talks` row shape

**Files:**
- Modify: `tests/routes/talks.test.ts`

- [ ] **Step 1.1: Add a failing assertion for `day_label` and `youtube_id`**

In `tests/routes/talks.test.ts`, extend the existing `seed()` helper to set a `day_label` on the source video, and add a new `it()` block inside the `describe('GET /talks', ...)` group. Place it right after the existing "lists all talks" test (around line 80).

Replace the existing `seed()` function with:

```ts
async function seed() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc12345678', youtubeId: 'abc12345678' })
  await setSourceVideoDayLabel(pool, sv.id, 'Day 1')
  const t1 = await insertTalk(pool, {
    sourceVideoId: sv.id,
    title: 'Vectors',
    speaker: 'Alice',
    conference: 'KubeCon 2024',
    talkIndex: 0,
    startMs: 0,
    endMs: 1000,
  })
  const t2 = await insertTalk(pool, {
    sourceVideoId: sv.id,
    title: 'DBs',
    speaker: 'Bob',
    conference: 'KubeCon 2024',
    talkIndex: 1,
    startMs: 1000,
    endMs: 2000,
  })
  await insertTranscript(pool, {
    talkId: t1.id,
    assemblyaiId: 'tx#0',
    rawText: 'about vectors',
    utterances: [],
  })
  return { sv, t1, t2 }
}
```

Add this import at the top alongside the existing `insertSourceVideo, insertTalk, insertTranscript` import line:

```ts
import { insertSourceVideo, insertTalk, insertTranscript, setSourceVideoDayLabel } from '../../src/db/queries.js'
```

Append this new test inside the `describe('GET /talks', ...)` block:

```ts
it('returns day_label and youtube_id joined from source_videos', async () => {
  await seed()
  const res = await app.inject({ method: 'GET', url: '/talks' })
  expect(res.statusCode).toBe(200)
  const rows = res.json()
  expect(rows).toHaveLength(2)
  for (const r of rows) {
    expect(r.day_label).toBe('Day 1')
    expect(r.youtube_id).toBe('abc12345678')
  }
})
```

- [ ] **Step 1.2: Run the test, verify it FAILS**

```bash
npm test -- talks.test.ts
```
Expected: the new test fails with `expected undefined to be "Day 1"`. The other tests should still pass.

- [ ] **Step 1.3: Commit the red test**

```bash
git add tests/routes/talks.test.ts
git commit -m "red: assert /talks rows include day_label and youtube_id"
```

---

## Task 2: GREEN — modify `GET /talks` to JOIN `source_videos`

**Files:**
- Modify: `src/routes/talks.ts`

- [ ] **Step 2.1: Change the list query to JOIN source_videos**

In `src/routes/talks.ts`, replace the body of the `app.get('/talks', ...)` handler. Current SQL is on lines 18–25. New version:

```ts
app.get('/talks', async (req, reply) => {
  const parsed = Query.safeParse(req.query)
  if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
  const { conference, speaker, limit, offset } = parsed.data
  const { rows } = await deps.pool.query(
    `select t.*, sv.day_label, sv.youtube_id
       from talks t
       join source_videos sv on sv.id = t.source_video_id
      where ($1::text is null or t.conference = $1)
        and ($2::text is null or t.speaker = $2)
      order by t.created_at desc
      limit $3 offset $4`,
    [conference ?? null, speaker ?? null, limit, offset]
  )
  return rows
})
```

The `GET /talks/:id` handler below stays unchanged.

- [ ] **Step 2.2: Run the talks test, verify the new test PASSES**

```bash
npm test -- talks.test.ts
```
Expected: all `talks.test.ts` tests green.

- [ ] **Step 2.3: Commit the green change**

```bash
git add src/routes/talks.ts
git commit -m "green: enrich GET /talks with day_label and youtube_id"
```

---

## Task 3: RED — `/faqs` route should not exist

**Files:**
- Modify: `tests/routes/faqs.test.ts`

- [ ] **Step 3.1: Replace the entire file with a single failing test**

Overwrite `tests/routes/faqs.test.ts` with:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from '../integration/db-setup.js'
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
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 90_000)

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('GET /faqs (removed)', () => {
  it('returns 404 — endpoint is deprecated', async () => {
    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3.2: Run the test, verify it FAILS**

```bash
npm test -- faqs.test.ts
```
Expected: fails with `expected 200 to be 404`.

- [ ] **Step 3.3: Commit the red test**

```bash
git add tests/routes/faqs.test.ts
git commit -m "red: /faqs should be removed and return 404"
```

---

## Task 4: GREEN — delete the `/faqs` route

**Files:**
- Delete: `src/routes/faqs.ts`
- Modify: `src/server.ts`
- Modify: `src/db/queries.ts`

- [ ] **Step 4.1: Delete the route file**

```bash
git rm src/routes/faqs.ts
```

- [ ] **Step 4.2: Remove the route import and registration from `src/server.ts`**

In `src/server.ts`, delete line 13:

```ts
import { registerFaqRoutes } from './routes/faqs.js'
```

And delete line 35:

```ts
await registerFaqRoutes(app, deps)
```

After the edit, the imports block (lines 9–14) should have four items (videos, talks, search, qa) and the registration block (lines 31–35) should call four `register*Routes` functions.

- [ ] **Step 4.3: Remove `getFaqsAcrossVideos` and `FaqRow` from `src/db/queries.ts`**

Delete the `FaqRow` interface and the `getFaqsAcrossVideos` function. At time of writing they occupy lines 104–127:

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

Leave `setSourceVideoFaqs` alone — it is still used by the worker to populate the `faqs` JSONB column.

- [ ] **Step 4.4: Run the faqs test, verify it PASSES**

```bash
npm test -- faqs.test.ts
```
Expected: the single test passes (404).

- [ ] **Step 4.5: Typecheck**

```bash
npm run typecheck
```
Expected: clean. If you see "imported but not used" or "no such file" errors, double-check Step 4.2 and Step 4.3 deletions.

- [ ] **Step 4.6: Run the full unit/route suite**

```bash
npm test
```
Expected: all green. If `videos.test.ts` or `qa.test.ts` reference `getFaqsAcrossVideos` (they shouldn't), surface it before continuing.

- [ ] **Step 4.7: Commit the deletion**

```bash
git add src/routes/faqs.ts src/server.ts src/db/queries.ts tests/routes/faqs.test.ts
git commit -m "green: remove deprecated /faqs route and getFaqsAcrossVideos query helper"
```

---

## Task 5: Manual smoke test

- [ ] **Step 5.1: Apply migrations on the test Postgres if not already done**

```bash
psql "postgres://test:test@localhost:54329/test" -c "drop schema public cascade; create schema public;"
psql "postgres://test:test@localhost:54329/test" -f src/db/migrations/001_initial.sql
psql "postgres://test:test@localhost:54329/test" -f src/db/migrations/002_content_type.sql
psql "postgres://test:test@localhost:54329/test" -f src/db/migrations/003_faqs_and_day_label.sql
```

- [ ] **Step 5.2: Start the API only (no worker needed for these checks)**

```bash
run_local npm run dev
```
Expected: `API listening on 3000` within a few seconds. Leave running for the next steps.

- [ ] **Step 5.3: `/faqs` returns 404**

In a new terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/faqs
```
Expected: `404`.

- [ ] **Step 5.4: `/talks` returns array with new fields (will be empty on a fresh DB — shape check only)**

```bash
curl -s http://localhost:3000/talks | jq
```
Expected: `[]` on a fresh DB. If you have seeded data, every element should have `day_label` and `youtube_id` keys.

- [ ] **Step 5.5: `/health` still works**

```bash
curl -s http://localhost:3000/health
```
Expected: `{"status":"ok"}`.

- [ ] **Step 5.6: Stop the dev server (Ctrl-C)**

---

## Task 6: Push the branch

- [ ] **Step 6.1: Push**

```bash
git push -u origin HEAD
```
Expected: branch pushed. Do **not** open a PR here — the frontend plan must merge first or simultaneously so the contract aligns.

---

## Done criteria

- `npm test` clean.
- `npm run typecheck` clean.
- `curl /faqs` → 404.
- Every `/talks` row contains `day_label` (string or null) and `youtube_id` (string).
- `src/routes/faqs.ts` deleted; `registerFaqRoutes` not referenced anywhere.
- `getFaqsAcrossVideos` and `FaqRow` removed from `src/db/queries.ts`.
- Three commits on the branch: `red: assert /talks ...`, `green: enrich GET /talks ...`, `red: /faqs should be removed ...`, `green: remove deprecated /faqs ...`. (Order may differ slightly if you batch differently — that's fine.)

## Out of scope

- Streaming chat.
- `/api/videos` proxy (FE side).
- Removing the `faqs` column on `source_videos` or the FAQ generation step in the worker.
- CORS changes.
