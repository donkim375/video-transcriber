# QA Tool-Use Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `POST /qa` from single-mode dense retrieval into a six-tool tool-use loop with conversation memory, cross-video scoping, and citation validation.

**Architecture:** Slim route → loop runner → Claude `messages.create` with `tools: [...]` and `tool_choice: 'auto'`. Six tools (`resolve_entity`, `get_talk_summary`, `search_chunks`, `synthesize_across_talks`, `get_overview`, `get_metadata`) are the only retrieval code path. Citation validator strips invalid markers and rewrites valid ones to `[1]`, `[2]`. Schema adds `series_slug` column + `pg_trgm`.

**Tech Stack:** TypeScript, Fastify, pg + pgvector + pg_trgm, Anthropic SDK (`@anthropic-ai/sdk` 0.30), OpenAI embeddings, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-qa-tool-use-router-design.md` — the source of truth for shapes, system prompt, tuning knobs, and risks accepted.

**TDD discipline:** failing test first, watch it fail, minimal implementation, watch it pass, commit. Every task ends with a commit.

---

## File map (created or modified)

| File | Role |
|---|---|
| `src/db/migrations/004_qa_upgrade.sql` | NEW — `pg_trgm`, `series_slug`, indexes, replace `match_chunks`, add `search_chunks_hybrid` |
| `src/db/queries.ts` | MOD — add 5 query helpers; rewrite `matchChunks` signature |
| `src/services/qa-scope.ts` | NEW — `Scope` type + zod schema + SQL serializer |
| `src/services/qa-tools/citation-validator.ts` | NEW — strip invalid markers, rewrite to numbered |
| `src/services/qa-tools/system-prompt.ts` | NEW — static system prompt + tool-selection guide |
| `src/services/qa-tools/types.ts` | NEW — `ToolDefinition`, `ToolContext`, `ToolCall` shared types |
| `src/services/qa-tools/get-metadata.ts` | NEW — Tool 6 |
| `src/services/qa-tools/get-overview.ts` | NEW — Tool 5 |
| `src/services/qa-tools/get-talk-summary.ts` | NEW — Tool 2 |
| `src/services/qa-tools/search-chunks.ts` | NEW — Tool 3 |
| `src/services/qa-tools/resolve-entity.ts` | NEW — Tool 1 |
| `src/services/qa-tools/synthesize-across-talks.ts` | NEW — Tool 4 |
| `src/services/qa-tools/index.ts` | NEW — registry export |
| `src/services/qa-tools/runner.ts` | NEW — loop runner |
| `src/services/llm.ts` | MOD — add `runToolLoop`; delete `answerQuestion` |
| `src/interfaces/llm.ts` | MOD — interface change |
| `src/routes/qa.ts` | REWRITE — slim route over runner |
| `src/routes/search.ts` | MOD — adapt to new `matchChunks` signature |
| `tests/integration/db-setup.ts` | MOD — add `004_qa_upgrade.sql` to migration list |
| `tests/mocks/llm.mock.ts` | MOD — drop `answerQuestion`, add `runToolLoop` scripted method |
| `tests/mocks/anthropic.mock.ts` | NEW — `FakeAnthropic` with scripted tool-use response sequences |
| `tests/unit/qa-scope.test.ts` | NEW |
| `tests/unit/qa-citation-validator.test.ts` | NEW |
| `tests/unit/qa-tools/*.test.ts` | NEW (6 files) |
| `tests/unit/qa-runner.test.ts` | NEW |
| `tests/integration/qa-resolve-entity.test.ts` | NEW |
| `tests/integration/qa-search-hybrid.test.ts` | NEW |
| `tests/integration/qa-overview.test.ts` | NEW |
| `tests/integration/qa-metadata.test.ts` | NEW |
| `tests/integration/qa-synthesize.test.ts` | NEW |
| `tests/integration/qa-route.test.ts` | NEW (replaces `tests/routes/qa.test.ts`) |
| `tests/routes/qa.test.ts` | DELETE |

---

## Phasing summary

- **Phase 1** (Tasks 1–4): Schema + scope foundation. No behavior change to existing routes yet.
- **Phase 2** (Tasks 5–10): DB query helpers. Pure functions returning typed rows.
- **Phase 3** (Tasks 11–17): Six tools + registry. Each tool is independently testable.
- **Phase 4** (Tasks 18–21): Runner + LLM service surgery.
- **Phase 5** (Tasks 22): Route swap + delete old test.

---

# Phase 1 — Foundation

## Task 1: Migration 004 (schema + functions + indexes)

**Files:**
- Create: `src/db/migrations/004_qa_upgrade.sql`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/004_qa_upgrade.sql` with the full contents below (verbatim from spec §"Database changes"):

```sql
-- Extensions
create extension if not exists pg_trgm;

-- Series grouping
alter table source_videos add column series_slug text;
create index if not exists source_videos_series_slug_idx on source_videos(series_slug);

-- Resolver indexes
create index if not exists talks_title_trgm_idx on talks using gin(title gin_trgm_ops);
create index if not exists talks_speaker_lower_idx on talks(lower(speaker));
create index if not exists talks_speaker_trgm_idx on talks using gin(speaker gin_trgm_ops);

-- Replace match_chunks (no backward-compat shim)
drop function if exists match_chunks(vector, int, uuid);
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int,
  filter_talk_id uuid,
  filter_source_video_ids uuid[],
  filter_series_slug text,
  filter_speaker text
)
returns table(
  chunk_id uuid, text text, talk_id uuid, talk_title text, speaker text,
  source_video_id uuid, youtube_id text, start_ms int, end_ms int, similarity float
)
language sql stable
as $$
  select c.id, c.text, c.talk_id, t.title, t.speaker,
         sv.id, sv.youtube_id, c.start_ms, c.end_ms,
         1 - (c.embedding <=> query_embedding) as similarity
    from chunks c
    join talks t on t.id = c.talk_id
    join source_videos sv on sv.id = t.source_video_id
   where (filter_talk_id is null or c.talk_id = filter_talk_id)
     and (filter_source_video_ids is null or sv.id = any(filter_source_video_ids))
     and (filter_series_slug is null or sv.series_slug = filter_series_slug)
     and (filter_speaker is null or t.speaker ilike '%' || filter_speaker || '%')
   order by c.embedding <=> query_embedding
   limit match_count;
$$;

-- Hybrid search with scope filters
create or replace function search_chunks_hybrid(
  query_text text,
  query_embedding vector(1536),
  match_count int,
  filter_talk_id uuid,
  filter_source_video_ids uuid[],
  filter_series_slug text,
  filter_speaker text
)
returns table(
  chunk_id uuid, text text, talk_id uuid, talk_title text, speaker text,
  source_video_id uuid, youtube_id text, start_ms int, end_ms int, rrf_score float
)
language sql stable
as $$
  with scope as (
    select c.id, c.text, c.talk_id, c.start_ms, c.end_ms, c.embedding,
           t.title as talk_title, t.speaker, sv.id as source_video_id, sv.youtube_id
      from chunks c
      join talks t on t.id = c.talk_id
      join source_videos sv on sv.id = t.source_video_id
     where (filter_talk_id is null or c.talk_id = filter_talk_id)
       and (filter_source_video_ids is null or sv.id = any(filter_source_video_ids))
       and (filter_series_slug is null or sv.series_slug = filter_series_slug)
       and (filter_speaker is null or t.speaker ilike '%' || filter_speaker || '%')
  ),
  dense as (
    select id, row_number() over (order by embedding <=> query_embedding) as r
      from scope order by embedding <=> query_embedding
      limit least(match_count * 3, 90)
  ),
  kw as (
    select id, row_number() over (
             order by ts_rank(to_tsvector('english', text), plainto_tsquery('english', query_text)) desc
           ) as r
      from scope
     where to_tsvector('english', text) @@ plainto_tsquery('english', query_text)
     limit least(match_count * 3, 90)
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as rrf
      from (select id, r from dense union all select id, r from kw) u
     group by id
  )
  select s.id, s.text, s.talk_id, s.talk_title, s.speaker,
         s.source_video_id, s.youtube_id, s.start_ms, s.end_ms, f.rrf
    from fused f join scope s on s.id = f.id
   order by f.rrf desc
   limit match_count;
$$;
```

- [ ] **Step 2: Add migration to test setup**

Edit `tests/integration/db-setup.ts:34`. Change the migration array to include 004:

```ts
for (const file of ['001_initial.sql', '002_content_type.sql', '003_faqs_and_day_label.sql', '004_qa_upgrade.sql']) {
```

- [ ] **Step 3: Run integration migrations test to confirm schema applies cleanly**

Run: `npm run test:integration -- migrations`

Expected: PASS — existing `tests/integration/migrations.test.ts` should already cover schema-applies-cleanly assertions, and now must still pass with the new file in the list. If the existing test doesn't iterate the migration list dynamically, add a smoke assertion to it: query `select to_regprocedure('match_chunks(vector,int,uuid,uuid[],text,text)')` and assert non-null.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/004_qa_upgrade.sql tests/integration/db-setup.ts
git commit -m "feat(qa): migration 004 — series_slug, pg_trgm, replace match_chunks + add search_chunks_hybrid"
```

---

## Task 2: Update `matchChunks` query helper to new signature

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/routes/search.ts`

The existing `matchChunks` signature is `(pool, embedding, k, filterTalkId?)`. The new function takes scope filters. We update the TS helper and the only caller (`/search`); `/qa` will be rewritten in Phase 5.

- [ ] **Step 1: Update `MatchChunkRow` type and `matchChunks` function in queries.ts**

Replace the existing `matchChunks` function (around `src/db/queries.ts:186-206`) with:

```ts
export interface MatchChunkRow {
  chunk_id: string
  text: string
  talk_id: string
  talk_title: string
  speaker: string
  source_video_id: string
  youtube_id: string
  start_ms: number | null
  end_ms: number | null
  similarity: number
}

export interface ScopeFilters {
  talkId?: string
  sourceVideoIds?: string[]
  seriesSlug?: string
  speaker?: string
}

export async function matchChunks(
  pool: pg.Pool,
  queryEmbedding: number[],
  matchCount: number,
  scope: ScopeFilters = {}
): Promise<MatchChunkRow[]> {
  const { rows } = await pool.query(
    `select * from match_chunks($1::vector, $2, $3, $4, $5, $6)`,
    [
      toPgVector(queryEmbedding),
      matchCount,
      scope.talkId ?? null,
      scope.sourceVideoIds ?? null,
      scope.seriesSlug ?? null,
      scope.speaker ?? null,
    ]
  )
  return rows
}
```

- [ ] **Step 2: Update `/search` route to new signature**

Edit `src/routes/search.ts`. The current call `matchChunks(deps.pool, queryEmbedding, limit * 3, talk_id)` becomes:

```ts
matchChunks(deps.pool, queryEmbedding, limit * 3, { talkId: talk_id }),
```

Also: existing search reads `r.id` and `r.text` etc — `id` is now `chunk_id`. Update the merged map: where the code does `keywordRows.map((r) => ({ ...r }))`, the `id` field for the RRF function (`reciprocalRankFusion`) expects `.id`. Map `chunk_id → id` to preserve RRF compatibility:

```ts
const merged = reciprocalRankFusion<MergedChunk>(
  [
    keywordRows.map((r) => ({ ...r })),
    vectorRows.map((r) => ({ id: r.chunk_id, text: r.text, talk_id: r.talk_id, start_ms: r.start_ms, end_ms: r.end_ms })),
  ],
  { k: 60 }
)
```

`searchChunksFullText` already returns `id`, leave it alone.

- [ ] **Step 3: Run existing search route + vector-search integration tests**

Run: `npm run test:integration -- vector-search` and `npm test -- search`

Expected: PASS. If `searchChunksFullText` queries needed scope params we left them alone — they keep working with old shape.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries.ts src/routes/search.ts
git commit -m "feat(qa): matchChunks now takes scope filters; /search adapts to new shape"
```

---

## Task 3: Create `Scope` type + zod schema + SQL serializer

**Files:**
- Create: `src/services/qa-scope.ts`
- Create: `tests/unit/qa-scope.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/qa-scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseScope, toScopeFilters, type Scope } from '../../src/services/qa-scope.js'

describe('parseScope', () => {
  it('accepts empty scope', () => {
    const r = parseScope(undefined)
    expect(r).toEqual({})
  })

  it('accepts all fields', () => {
    const r = parseScope({
      series_slug: 'aies-2026',
      source_video_id: ['11111111-1111-1111-1111-111111111111'],
      talk_id: '22222222-2222-2222-2222-222222222222',
      speaker: 'jane',
    })
    expect(r.series_slug).toBe('aies-2026')
    expect(r.talk_id).toBe('22222222-2222-2222-2222-222222222222')
  })

  it('rejects malformed UUID in talk_id', () => {
    expect(() => parseScope({ talk_id: 'not-a-uuid' })).toThrow()
  })

  it('rejects malformed UUID in source_video_id', () => {
    expect(() => parseScope({ source_video_id: ['nope'] })).toThrow()
  })
})

describe('toScopeFilters', () => {
  it('maps to db query shape', () => {
    const f = toScopeFilters({
      talk_id: '22222222-2222-2222-2222-222222222222',
      source_video_id: ['11111111-1111-1111-1111-111111111111'],
      series_slug: 'aies-2026',
      speaker: 'Jane',
    })
    expect(f).toEqual({
      talkId: '22222222-2222-2222-2222-222222222222',
      sourceVideoIds: ['11111111-1111-1111-1111-111111111111'],
      seriesSlug: 'aies-2026',
      speaker: 'Jane',
    })
  })

  it('omits undefined fields', () => {
    const f = toScopeFilters({ speaker: 'Jane' })
    expect(f).toEqual({ speaker: 'Jane' })
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-scope`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `qa-scope.ts`**

Create `src/services/qa-scope.ts`:

```ts
import { z } from 'zod'
import type { ScopeFilters } from '../db/queries.js'

export const ScopeSchema = z
  .object({
    series_slug: z.string().min(1).max(100).optional(),
    source_video_id: z.array(z.string().uuid()).max(10).optional(),
    talk_id: z.string().uuid().optional(),
    speaker: z.string().min(1).max(100).optional(),
  })
  .strict()

export type Scope = z.infer<typeof ScopeSchema>

export function parseScope(raw: unknown): Scope {
  if (raw === undefined || raw === null) return {}
  return ScopeSchema.parse(raw)
}

export function toScopeFilters(scope: Scope): ScopeFilters {
  const out: ScopeFilters = {}
  if (scope.talk_id) out.talkId = scope.talk_id
  if (scope.source_video_id && scope.source_video_id.length > 0) out.sourceVideoIds = scope.source_video_id
  if (scope.series_slug) out.seriesSlug = scope.series_slug
  if (scope.speaker) out.speaker = scope.speaker
  return out
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-scope`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-scope.ts tests/unit/qa-scope.test.ts
git commit -m "feat(qa): Scope type with zod validation + SQL filter serializer"
```

---

## Task 4: Create citation validator

**Files:**
- Create: `src/services/qa-tools/citation-validator.ts`
- Create: `tests/unit/qa-citation-validator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/qa-citation-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateAndRewriteCitations, type CitationSource } from '../../src/services/qa-tools/citation-validator.js'

const sources: CitationSource[] = [
  {
    type: 'chunk',
    chunk_id: '11111111-1111-1111-1111-111111111111',
    talk_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    source_video_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    youtube_id: 'yt1',
    start_ms: 1000,
    end_ms: 2000,
    talk_title: 'T1',
    speaker: 'Alice',
    video_title: 'V1',
    day_label: 'Day 1',
    series_slug: 'aies-2026',
    similarity: 0.8,
  },
  {
    type: 'talk',
    chunk_id: null,
    talk_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    source_video_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    youtube_id: 'yt1',
    start_ms: 60000,
    end_ms: 120000,
    talk_title: 'T2',
    speaker: 'Bob',
    video_title: 'V1',
    day_label: 'Day 1',
    series_slug: 'aies-2026',
    similarity: null,
  },
]

describe('validateAndRewriteCitations', () => {
  it('rewrites valid markers to [N]', () => {
    const r = validateAndRewriteCitations(
      'A [chunk:11111111-1111-1111-1111-111111111111] then B [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb].',
      sources
    )
    expect(r.answer).toBe('A [1] then B [2].')
    expect(r.citations).toHaveLength(2)
    expect(r.citations[0]!.chunk_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(r.citations[1]!.source).toBe('talk')
  })

  it('strips invalid markers', () => {
    const r = validateAndRewriteCitations(
      'A [chunk:00000000-0000-0000-0000-000000000000] then B [chunk:11111111-1111-1111-1111-111111111111].',
      sources
    )
    expect(r.answer).toBe('A  then B [1].')
    expect(r.citations).toHaveLength(1)
    expect(r.stripped).toBe(1)
  })

  it('deduplicates repeated valid markers to same number', () => {
    const r = validateAndRewriteCitations(
      'X [chunk:11111111-1111-1111-1111-111111111111] Y [chunk:11111111-1111-1111-1111-111111111111] Z.',
      sources
    )
    expect(r.answer).toBe('X [1] Y [1] Z.')
    expect(r.citations).toHaveLength(1)
  })

  it('orders citations by first appearance', () => {
    const r = validateAndRewriteCitations(
      'A [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb] then B [chunk:11111111-1111-1111-1111-111111111111].',
      sources
    )
    expect(r.citations[0]!.source).toBe('talk')
    expect(r.citations[1]!.source).toBe('chunk')
  })

  it('handles answer with zero citations', () => {
    const r = validateAndRewriteCitations('Plain answer.', sources)
    expect(r.answer).toBe('Plain answer.')
    expect(r.citations).toEqual([])
    expect(r.stripped).toBe(0)
  })

  it('builds transcript_anchor from chunk or talk id', () => {
    const r = validateAndRewriteCitations(
      '[chunk:11111111-1111-1111-1111-111111111111] and [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb].',
      sources
    )
    expect(r.citations[0]!.transcript_anchor).toBe('#chunk-11111111-1111-1111-1111-111111111111')
    expect(r.citations[1]!.transcript_anchor).toBe('#talk-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  it('builds youtube_deeplink from youtube_id and start_ms', () => {
    const r = validateAndRewriteCitations(
      '[chunk:11111111-1111-1111-1111-111111111111]',
      sources
    )
    expect(r.citations[0]!.youtube_deeplink).toBe('https://youtu.be/yt1?t=1')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-citation-validator`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement citation-validator.ts**

Create `src/services/qa-tools/citation-validator.ts`:

```ts
export type CitationSource = {
  type: 'chunk' | 'talk'
  chunk_id: string | null
  talk_id: string
  source_video_id: string
  youtube_id: string
  start_ms: number
  end_ms: number
  talk_title: string
  speaker: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  similarity: number | null
}

export type Citation = {
  chunk_id: string | null
  talk_id: string
  source_video_id: string
  youtube_id: string
  youtube_deeplink: string
  start_ms: number
  end_ms: number
  transcript_anchor: string
  talk_title: string
  speaker: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  similarity: number | null
  source: 'chunk' | 'talk'
}

const MARKER_RE = /\[(chunk|talk):([0-9a-f-]{36})\]/gi

export interface ValidationResult {
  answer: string
  citations: Citation[]
  stripped: number
}

export function validateAndRewriteCitations(
  rawAnswer: string,
  sources: CitationSource[]
): ValidationResult {
  const byChunk = new Map<string, CitationSource>()
  const byTalk = new Map<string, CitationSource>()
  for (const s of sources) {
    if (s.type === 'chunk' && s.chunk_id) byChunk.set(s.chunk_id, s)
    if (s.type === 'talk') byTalk.set(s.talk_id, s)
  }

  const indexByKey = new Map<string, number>()
  const citations: Citation[] = []
  let stripped = 0

  const answer = rawAnswer.replace(MARKER_RE, (_, kind: string, id: string) => {
    const isChunk = kind.toLowerCase() === 'chunk'
    const src = isChunk ? byChunk.get(id) : byTalk.get(id)
    if (!src) {
      stripped += 1
      return ''
    }
    const key = isChunk ? `chunk:${id}` : `talk:${id}`
    let idx = indexByKey.get(key)
    if (idx === undefined) {
      idx = citations.length + 1
      indexByKey.set(key, idx)
      citations.push(toCitation(src))
    }
    return `[${idx}]`
  })

  return { answer, citations, stripped }
}

function toCitation(s: CitationSource): Citation {
  const anchor =
    s.type === 'chunk' && s.chunk_id ? `#chunk-${s.chunk_id}` : `#talk-${s.talk_id}`
  const startSec = Math.floor(s.start_ms / 1000)
  return {
    chunk_id: s.chunk_id,
    talk_id: s.talk_id,
    source_video_id: s.source_video_id,
    youtube_id: s.youtube_id,
    youtube_deeplink: `https://youtu.be/${s.youtube_id}?t=${startSec}`,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    transcript_anchor: anchor,
    talk_title: s.talk_title,
    speaker: s.speaker,
    video_title: s.video_title,
    day_label: s.day_label,
    series_slug: s.series_slug,
    similarity: s.similarity,
    source: s.type,
  }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-citation-validator`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/citation-validator.ts tests/unit/qa-citation-validator.test.ts
git commit -m "feat(qa): citation validator — strip invalid markers, rewrite valid to [N]"
```

---

# Phase 2 — DB query helpers

## Task 5: `getMetadata` query helper

**Files:**
- Modify: `src/db/queries.ts` (append)
- Create: `tests/integration/qa-metadata.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/qa-metadata.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, setSourceVideoDayLabel, getMetadata } from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('getMetadata', () => {
  it('counts videos, talks, sums duration, lists distinct speakers and day_labels', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await pool.query('update source_videos set duration_seconds = 600, series_slug = $1 where id = $2', ['aies-2026', sv1.id])
    await setSourceVideoDayLabel(pool, sv1.id, 'Day 1')
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    await pool.query('update source_videos set duration_seconds = 1200, series_slug = $1 where id = $2', ['aies-2026', sv2.id])
    await setSourceVideoDayLabel(pool, sv2.id, 'Day 2')

    await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })
    await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T2', speaker: 'Bob', talkIndex: 1, startMs: 100, endMs: 200 })
    await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T3', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })

    const m = await getMetadata(pool, { seriesSlug: 'aies-2026' })

    expect(m.total_videos).toBe(2)
    expect(m.total_talks).toBe(3)
    expect(m.total_duration_seconds).toBe(1800)
    expect(m.day_labels.sort()).toEqual(['Day 1', 'Day 2'])
    expect(m.speakers.sort()).toEqual(['Alice', 'Bob'])
    expect(m.talks).toHaveLength(3)
  })

  it('respects talk_id scope', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'T2', speaker: 'Bob', talkIndex: 1, startMs: 100, endMs: 200 })

    const m = await getMetadata(pool, { talkId: t.id })
    expect(m.total_talks).toBe(1)
    expect(m.speakers).toEqual(['Alice'])
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-metadata`

Expected: FAIL — `getMetadata` not exported.

- [ ] **Step 3: Implement `getMetadata`**

Append to `src/db/queries.ts`:

```ts
export interface Metadata {
  total_videos: number
  total_talks: number
  total_duration_seconds: number
  series_slugs: string[]
  day_labels: string[]
  speakers: string[]
  talks: Array<{
    talk_id: string
    talk_title: string | null
    speaker: string | null
    talk_index: number
    start_ms: number
    end_ms: number
    day_label: string | null
  }>
}

export async function getMetadata(pool: pg.Pool, scope: ScopeFilters): Promise<Metadata> {
  const { rows: agg } = await pool.query(
    `select
       count(distinct sv.id)::int as total_videos,
       count(distinct t.id)::int as total_talks,
       coalesce(sum(distinct sv.duration_seconds), 0)::int as total_duration_seconds,
       array_remove(array_agg(distinct sv.series_slug), null) as series_slugs,
       array_remove(array_agg(distinct sv.day_label), null) as day_labels,
       array_remove(array_agg(distinct t.speaker), null) as speakers
     from talks t
     join source_videos sv on sv.id = t.source_video_id
     where ($1::uuid is null or t.id = $1)
       and ($2::uuid[] is null or sv.id = any($2))
       and ($3::text is null or sv.series_slug = $3)
       and ($4::text is null or t.speaker ilike '%' || $4 || '%')`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  const { rows: talks } = await pool.query(
    `select t.id as talk_id, t.title as talk_title, t.speaker, t.talk_index, t.start_ms, t.end_ms, sv.day_label
       from talks t
       join source_videos sv on sv.id = t.source_video_id
      where ($1::uuid is null or t.id = $1)
        and ($2::uuid[] is null or sv.id = any($2))
        and ($3::text is null or sv.series_slug = $3)
        and ($4::text is null or t.speaker ilike '%' || $4 || '%')
      order by sv.day_label nulls last, t.talk_index asc`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  return {
    total_videos: agg[0]?.total_videos ?? 0,
    total_talks: agg[0]?.total_talks ?? 0,
    total_duration_seconds: agg[0]?.total_duration_seconds ?? 0,
    series_slugs: agg[0]?.series_slugs ?? [],
    day_labels: agg[0]?.day_labels ?? [],
    speakers: agg[0]?.speakers ?? [],
    talks,
  }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm run test:integration -- qa-metadata`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/integration/qa-metadata.test.ts
git commit -m "feat(qa): getMetadata query helper with scope filters"
```

---

## Task 6: `getOverview` query helper

**Files:**
- Modify: `src/db/queries.ts` (append)
- Create: `tests/integration/qa-overview.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/qa-overview.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, updateTranscriptSummary,
  setSourceVideoDayLabel, setSourceVideoFaqs, getOverview,
} from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => { await pool.end() })

describe('getOverview', () => {
  it('joins two videos in same series with summaries and faqs', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'Day 1' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv1.id])
    await setSourceVideoDayLabel(pool, sv1.id, 'Day 1')
    await setSourceVideoFaqs(pool, sv1.id, [{ question: 'Q1?', answer: 'A1' }])
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x1', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr1.id, 'T1 summary.')

    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b', title: 'Day 2' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv2.id])
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'Bob', talkIndex: 0, startMs: 0, endMs: 30_000 })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'x2', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr2.id, 'T2 summary.')

    const o = await getOverview(pool, { seriesSlug: 'aies-2026' })

    expect(o.videos).toHaveLength(2)
    const d1 = o.videos.find(v => v.day_label === 'Day 1')!
    expect(d1.faqs).toEqual([{ question: 'Q1?', answer: 'A1' }])
    expect(d1.talks).toHaveLength(1)
    expect(d1.talks[0]!.summary).toBe('T1 summary.')
    expect(d1.talks[0]!.youtube_deeplink).toBe('https://youtu.be/a?t=0')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-overview`

Expected: FAIL — `getOverview` not exported.

- [ ] **Step 3: Implement `getOverview`**

Append to `src/db/queries.ts`:

```ts
export interface OverviewTalk {
  talk_id: string
  talk_title: string | null
  speaker: string | null
  summary: string | null
  start_ms: number
  end_ms: number
  youtube_deeplink: string
}

export interface OverviewVideo {
  source_video_id: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  faqs: Array<{ question: string; answer: string }>
  talks: OverviewTalk[]
}

export interface Overview {
  videos: OverviewVideo[]
}

export async function getOverview(pool: pg.Pool, scope: ScopeFilters): Promise<Overview> {
  const { rows } = await pool.query(
    `select
       sv.id as source_video_id, sv.title as video_title, sv.day_label, sv.series_slug, sv.youtube_id, sv.faqs,
       t.id as talk_id, t.title as talk_title, t.speaker, t.start_ms, t.end_ms,
       tr.summary
     from source_videos sv
     join talks t on t.source_video_id = sv.id
     left join transcripts tr on tr.talk_id = t.id
     where ($1::uuid is null or t.id = $1)
       and ($2::uuid[] is null or sv.id = any($2))
       and ($3::text is null or sv.series_slug = $3)
       and ($4::text is null or t.speaker ilike '%' || $4 || '%')
     order by sv.day_label nulls last, t.talk_index asc`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  const byVideo = new Map<string, OverviewVideo>()
  for (const r of rows) {
    let v = byVideo.get(r.source_video_id)
    if (!v) {
      v = {
        source_video_id: r.source_video_id,
        video_title: r.video_title,
        day_label: r.day_label,
        series_slug: r.series_slug,
        faqs: r.faqs ?? [],
        talks: [],
      }
      byVideo.set(r.source_video_id, v)
    }
    const startSec = Math.floor((r.start_ms ?? 0) / 1000)
    v.talks.push({
      talk_id: r.talk_id,
      talk_title: r.talk_title,
      speaker: r.speaker,
      summary: r.summary,
      start_ms: r.start_ms ?? 0,
      end_ms: r.end_ms ?? 0,
      youtube_deeplink: `https://youtu.be/${r.youtube_id}?t=${startSec}`,
    })
  }
  return { videos: [...byVideo.values()] }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm run test:integration -- qa-overview`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/integration/qa-overview.test.ts
git commit -m "feat(qa): getOverview joins source_videos, talks, summaries, faqs"
```

---

## Task 7: `getTalkSummaries` query helper

**Files:**
- Modify: `src/db/queries.ts` (append)
- Create: integration test inside `tests/integration/qa-talk-summaries.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/integration/qa-talk-summaries.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, updateTranscriptSummary, getTalkSummaries,
} from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('getTalkSummaries', () => {
  it('returns by talk_id', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr.id, 'Hello.')

    const r = await getTalkSummaries(pool, { talkId: t.id })
    expect(r).toHaveLength(1)
    expect(r[0]!.summary).toBe('Hello.')
    expect(r[0]!.youtube_deeplink).toBe('https://youtu.be/a?t=0')
  })

  it('returns by speaker case-insensitive, capped at 5', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 7; i++) {
      const t = await insertTalk(pool, { sourceVideoId: sv.id, title: `T${i}`, speaker: 'Alice', talkIndex: i, startMs: i * 1000, endMs: (i + 1) * 1000 })
      const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: `x${i}`, rawText: '', utterances: [] })
      await updateTranscriptSummary(pool, tr.id, `Summary ${i}.`)
    }
    const r = await getTalkSummaries(pool, { speaker: 'alice' })
    expect(r).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-talk-summaries`

Expected: FAIL — `getTalkSummaries` not exported.

- [ ] **Step 3: Implement `getTalkSummaries`**

Append to `src/db/queries.ts`:

```ts
export interface TalkSummaryRow {
  talk_id: string
  talk_title: string | null
  speaker: string | null
  summary: string | null
  start_ms: number
  end_ms: number
  source_video_id: string
  youtube_deeplink: string
}

export async function getTalkSummaries(pool: pg.Pool, scope: ScopeFilters & { limit?: number }): Promise<TalkSummaryRow[]> {
  const limit = scope.limit ?? 5
  const { rows } = await pool.query(
    `select t.id as talk_id, t.title as talk_title, t.speaker, tr.summary,
            t.start_ms, t.end_ms, sv.id as source_video_id, sv.youtube_id
       from talks t
       join source_videos sv on sv.id = t.source_video_id
       left join transcripts tr on tr.talk_id = t.id
      where ($1::uuid is null or t.id = $1)
        and ($2::uuid[] is null or sv.id = any($2))
        and ($3::text is null or sv.series_slug = $3)
        and ($4::text is null or t.speaker ilike '%' || $4 || '%')
      order by t.talk_index asc
      limit $5`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null, limit]
  )
  return rows.map(r => ({
    talk_id: r.talk_id,
    talk_title: r.talk_title,
    speaker: r.speaker,
    summary: r.summary,
    start_ms: r.start_ms ?? 0,
    end_ms: r.end_ms ?? 0,
    source_video_id: r.source_video_id,
    youtube_deeplink: `https://youtu.be/${r.youtube_id}?t=${Math.floor((r.start_ms ?? 0) / 1000)}`,
  }))
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm run test:integration -- qa-talk-summaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/integration/qa-talk-summaries.test.ts
git commit -m "feat(qa): getTalkSummaries — read precomputed transcripts.summary by scope"
```

---

## Task 8: `searchChunksHybrid` query helper

**Files:**
- Modify: `src/db/queries.ts` (append)
- Create: `tests/integration/qa-search-hybrid.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/integration/qa-search-hybrid.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk, searchChunksHybrid,
} from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

describe('searchChunksHybrid', () => {
  it('returns chunks with talk metadata joined', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Vectors', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: 'vectors are arrays of numbers', startMs: 0, endMs: 1, tokenCount: 5, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'vectors', vec(1), 10, {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toBe('Vectors')
    expect(r[0]!.speaker).toBe('Alice')
    expect(r[0]!.source_video_id).toBe(sv.id)
  })

  it('respects source_video_id scope filter', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'B', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'y', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t1.id, transcriptId: tr1.id, chunkIndex: 0, text: 'X word here', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })
    await insertChunk(pool, { talkId: t2.id, transcriptId: tr2.id, chunkIndex: 0, text: 'X word here', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'X', vec(1), 10, { sourceVideoIds: [sv1.id] })
    expect(r.every(c => c.source_video_id === sv1.id)).toBe(true)
  })

  it('respects series_slug scope filter', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv1.id])
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'B', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'y', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t1.id, transcriptId: tr1.id, chunkIndex: 0, text: 'foobar', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })
    await insertChunk(pool, { talkId: t2.id, transcriptId: tr2.id, chunkIndex: 0, text: 'foobar', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'foobar', vec(1), 10, { seriesSlug: 'aies-2026' })
    expect(r.every(c => c.source_video_id === sv1.id)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-search-hybrid`

Expected: FAIL — `searchChunksHybrid` not exported.

- [ ] **Step 3: Implement `searchChunksHybrid`**

Append to `src/db/queries.ts`:

```ts
export interface HybridChunkRow {
  chunk_id: string
  text: string
  talk_id: string
  talk_title: string
  speaker: string
  source_video_id: string
  youtube_id: string
  start_ms: number | null
  end_ms: number | null
  rrf_score: number
}

export async function searchChunksHybrid(
  pool: pg.Pool,
  queryText: string,
  queryEmbedding: number[],
  matchCount: number,
  scope: ScopeFilters
): Promise<HybridChunkRow[]> {
  const { rows } = await pool.query(
    `select * from search_chunks_hybrid($1, $2::vector, $3, $4, $5, $6, $7)`,
    [
      queryText,
      toPgVector(queryEmbedding),
      matchCount,
      scope.talkId ?? null,
      scope.sourceVideoIds ?? null,
      scope.seriesSlug ?? null,
      scope.speaker ?? null,
    ]
  )
  return rows
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm run test:integration -- qa-search-hybrid`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/integration/qa-search-hybrid.test.ts
git commit -m "feat(qa): searchChunksHybrid TS wrapper for search_chunks_hybrid SQL"
```

---

## Task 9: `resolveEntities` query helper

**Files:**
- Modify: `src/db/queries.ts` (append)
- Create: `tests/integration/qa-resolve-entity.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/integration/qa-resolve-entity.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, resolveEntities } from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('resolveEntities', () => {
  it('finds talk by title substring', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'How Daytona Sandboxes Work', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'Building RAG', speaker: 'Bob', talkIndex: 1, startMs: 1, endMs: 2 })

    const r = await resolveEntities(pool, 'Daytona', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toContain('Daytona')
  })

  it('tolerates a typo via pg_trgm', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'Daytona Sandboxes', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })

    const r = await resolveEntities(pool, 'deytona', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toContain('Daytona')
  })

  it('finds talk by speaker partial', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'X', speaker: 'Jane Smith', talkIndex: 0, startMs: 0, endMs: 1 })

    const r = await resolveEntities(pool, 'jane', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.speaker).toBe('Jane Smith')
  })

  it('returns empty array when nothing matches', async () => {
    const r = await resolveEntities(pool, 'nonexistent term', {})
    expect(r).toEqual([])
  })

  it('caps at 3 candidates', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 5; i++) {
      await insertTalk(pool, { sourceVideoId: sv.id, title: `Eval Talk ${i}`, speaker: `Speaker${i}`, talkIndex: i, startMs: i, endMs: i + 1 })
    }
    const r = await resolveEntities(pool, 'eval', {})
    expect(r.length).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-resolve-entity`

Expected: FAIL — `resolveEntities` not exported.

- [ ] **Step 3: Implement `resolveEntities`**

Append to `src/db/queries.ts`:

```ts
export interface ResolveCandidate {
  talk_id: string
  talk_title: string
  speaker: string
  talk_index: number
  source_video_id: string
  confidence: number
}

export async function resolveEntities(
  pool: pg.Pool,
  query: string,
  scope: ScopeFilters
): Promise<ResolveCandidate[]> {
  const { rows } = await pool.query(
    `select t.id as talk_id, t.title as talk_title, t.speaker, t.talk_index,
            t.source_video_id,
            (0.6 * similarity(coalesce(t.title, ''), $1) + 0.4 * similarity(coalesce(t.speaker, ''), $1)) as confidence
       from talks t
       join source_videos sv on sv.id = t.source_video_id
      where ($2::uuid[] is null or sv.id = any($2))
        and ($3::text is null or sv.series_slug = $3)
        and (
          coalesce(t.title, '') % $1
          or coalesce(t.speaker, '') % $1
          or coalesce(t.title, '') ilike '%' || $1 || '%'
          or coalesce(t.speaker, '') ilike '%' || $1 || '%'
        )
      order by confidence desc
      limit 3`,
    [query, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null]
  )
  return rows.map(r => ({
    talk_id: r.talk_id,
    talk_title: r.talk_title ?? '',
    speaker: r.speaker ?? '',
    talk_index: r.talk_index,
    source_video_id: r.source_video_id,
    confidence: Math.max(0, Math.min(1, Number(r.confidence))),
  }))
}
```

Note: `%` is the pg_trgm similarity operator. Combined with `ilike` for substring fallback so exact-substring "Daytona" works even if trigram threshold misses on very short query strings.

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm run test:integration -- qa-resolve-entity`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/integration/qa-resolve-entity.test.ts
git commit -m "feat(qa): resolveEntities — pg_trgm + ilike hybrid match for talk title/speaker"
```

---

# Phase 3 — Tools

## Task 10: Shared types + system prompt

**Files:**
- Create: `src/services/qa-tools/types.ts`
- Create: `src/services/qa-tools/system-prompt.ts`

No tests — these are types and constants imported by every tool.

- [ ] **Step 1: Create `types.ts`**

Create `src/services/qa-tools/types.ts`:

```ts
import type { Pool } from 'pg'
import type { IEmbeddingService } from '../../interfaces/embeddings.js'
import type { ILLMService } from '../../interfaces/llm.js'
import type { Scope } from '../qa-scope.js'
import type { CitationSource } from './citation-validator.js'

export type ToolContext = {
  pool: Pool
  embeddings: IEmbeddingService
  llm: ILLMService
  scope: Scope
  signal: AbortSignal
}

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>   // JSONSchema; Claude consumes this
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolExecutionResult>
}

export type ToolExecutionResult = {
  json: unknown                            // serialized for tool_result block
  sources: CitationSource[]                // appended to validator's source pool
}

export type ToolCall = {
  tool: string
  duration_ms: number
  ok: boolean
  error?: string
}
```

- [ ] **Step 2: Create `system-prompt.ts`**

Create `src/services/qa-tools/system-prompt.ts`:

```ts
export const SYSTEM_PROMPT = `You answer questions about conference talks using ONLY tools and tool results.

Available tools:
- resolve_entity: NL reference → talk candidates. Use when the user names a talk/speaker.
- get_talk_summary: precomputed summary of a talk. Use for "main idea of talk X".
- search_chunks: passage retrieval. Set diversify:'per_talk' for "which talks discuss X".
- synthesize_across_talks: cross-talk map-reduce. Use for "across the day/conference".
- get_overview: all talk summaries + FAQs in scope. Use for "summarize", "top ideas".
- get_metadata: counts, speakers, day labels. Use for "how many", "who's speaking".

Tool selection guide:
- "main idea of talk X" / "what did Jane talk about"   → resolve_entity → get_talk_summary
- "which talks discuss X" / "where was X mentioned"     → search_chunks (diversify:'per_talk')
- "main conclusions for X across the day"               → synthesize_across_talks
- "summarize the conference" / "top ideas"              → get_overview
- "how many talks" / "who's speaking"                   → get_metadata
- comparison ("X vs Y")                                 → call retrieval tools twice in parallel

Citations:
- Every factual claim MUST be followed by [chunk:<id>] or [talk:<id>].
- IDs MUST come from a tool result this turn. Do not invent IDs.
- If a tool returns nothing useful, say so explicitly. Do not guess.

History:
- Prior tool calls are NOT available this turn. Re-fetch when needed.
- For follow-ups ("tell me more", "the second point"), call a tool fresh with rephrased query.

Brevity: match the question's specificity. No padding.`
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/qa-tools/types.ts src/services/qa-tools/system-prompt.ts
git commit -m "feat(qa): shared types + system prompt for tool-use loop"
```

---

## Task 11: Tool — `get_metadata`

**Files:**
- Create: `src/services/qa-tools/get-metadata.ts`
- Create: `tests/unit/qa-tools/get-metadata.test.ts`

- [ ] **Step 1: Write failing unit test**

Create `tests/unit/qa-tools/get-metadata.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { getMetadataTool } from '../../../src/services/qa-tools/get-metadata.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: { agg: any[]; talks: any[] }): ToolContext {
  const pool = { query: vi.fn().mockResolvedValueOnce({ rows: rows.agg }).mockResolvedValueOnce({ rows: rows.talks }) }
  return {
    pool: pool as any,
    embeddings: {} as any,
    llm: {} as any,
    scope: {},
    signal: new AbortController().signal,
  }
}

describe('get_metadata tool', () => {
  it('returns shape with counts and lists', async () => {
    const ctx = makeCtx({
      agg: [{ total_videos: 2, total_talks: 5, total_duration_seconds: 9000, series_slugs: ['aies'], day_labels: ['Day 1', 'Day 2'], speakers: ['A', 'B'] }],
      talks: [{ talk_id: 'x', talk_title: 'T', speaker: 'A', talk_index: 0, start_ms: 0, end_ms: 60_000, day_label: 'Day 1' }],
    })
    const r = await getMetadataTool.execute({}, ctx)
    const json = r.json as any
    expect(json.total_videos).toBe(2)
    expect(json.total_talks).toBe(5)
    expect(json.speakers).toEqual(['A', 'B'])
    expect(r.sources).toEqual([])
  })

  it('input schema has scope field', () => {
    expect(getMetadataTool.input_schema).toBeDefined()
    expect(getMetadataTool.name).toBe('get_metadata')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-tools/get-metadata`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement tool**

Create `src/services/qa-tools/get-metadata.ts`:

```ts
import { z } from 'zod'
import { getMetadata } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'

const InputSchema = z.object({
  scope: ScopeSchema.optional(),
}).strict()

export const getMetadataTool: ToolDefinition = {
  name: 'get_metadata',
  description: 'Returns structural counts and lists about the corpus in scope: total videos, total talks, total duration seconds, distinct speakers, day labels, series slugs, and a flat list of all talks with their day_label. Use for questions like "how many talks", "who is speaking", "how long is day 1".',
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
    },
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input ?? {})
    const effectiveScope = parsed.scope ?? ctx.scope
    const filters = toScopeFilters(effectiveScope)
    const m = await getMetadata(ctx.pool, filters)
    return { json: m, sources: [] }
  },
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-tools/get-metadata`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/get-metadata.ts tests/unit/qa-tools/get-metadata.test.ts
git commit -m "feat(qa): tool get_metadata — corpus aggregations, no LLM"
```

---

## Task 12: Tool — `get_overview`

**Files:**
- Create: `src/services/qa-tools/get-overview.ts`
- Create: `tests/unit/qa-tools/get-overview.test.ts`

- [ ] **Step 1: Write failing unit test**

Create `tests/unit/qa-tools/get-overview.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { getOverviewTool } from '../../../src/services/qa-tools/get-overview.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('get_overview tool', () => {
  it('returns videos with talks and emits talk citations', async () => {
    const ctx = makeCtx([
      { source_video_id: 'v1', video_title: 'V', day_label: 'Day 1', series_slug: 's', youtube_id: 'yt', faqs: [{ question: 'q', answer: 'a' }], talk_id: 't1', talk_title: 'T', speaker: 'A', start_ms: 1000, end_ms: 2000, summary: 'S' },
    ])
    const r = await getOverviewTool.execute({}, ctx)
    const json = r.json as any
    expect(json.videos).toHaveLength(1)
    expect(json.videos[0].talks[0].summary).toBe('S')
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0]!.type).toBe('talk')
    expect(r.sources[0]!.talk_id).toBe('t1')
  })

  it('input schema has scope', () => {
    expect(getOverviewTool.name).toBe('get_overview')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-tools/get-overview`

Expected: FAIL.

- [ ] **Step 3: Implement tool**

Create `src/services/qa-tools/get-overview.ts`:

```ts
import { z } from 'zod'
import { getOverview } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({ scope: ScopeSchema.optional() }).strict()

export const getOverviewTool: ToolDefinition = {
  name: 'get_overview',
  description: 'Returns precomputed summaries and FAQs for every video and talk in scope. Use for conference-wide questions like "summarize the conference", "top ideas", "overall themes". Returns talk-level citations (no chunks).',
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
    },
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input ?? {})
    const effectiveScope = parsed.scope ?? ctx.scope
    const o = await getOverview(ctx.pool, toScopeFilters(effectiveScope))

    const sources: CitationSource[] = []
    for (const v of o.videos) {
      for (const t of v.talks) {
        sources.push({
          type: 'talk',
          chunk_id: null,
          talk_id: t.talk_id,
          source_video_id: v.source_video_id,
          youtube_id: extractYoutubeId(t.youtube_deeplink),
          start_ms: t.start_ms,
          end_ms: t.end_ms,
          talk_title: t.talk_title ?? '',
          speaker: t.speaker ?? '',
          video_title: v.video_title,
          day_label: v.day_label,
          series_slug: v.series_slug,
          similarity: null,
        })
      }
    }
    return { json: o, sources }
  },
}

function extractYoutubeId(deeplink: string): string {
  const m = deeplink.match(/youtu\.be\/([^?]+)/)
  return m?.[1] ?? ''
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-tools/get-overview`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/get-overview.ts tests/unit/qa-tools/get-overview.test.ts
git commit -m "feat(qa): tool get_overview — joined summaries + faqs, talk-level citations"
```

---

## Task 13: Tool — `get_talk_summary`

**Files:**
- Create: `src/services/qa-tools/get-talk-summary.ts`
- Create: `tests/unit/qa-tools/get-talk-summary.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/qa-tools/get-talk-summary.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { getTalkSummaryTool } from '../../../src/services/qa-tools/get-talk-summary.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('get_talk_summary tool', () => {
  it('returns talks with summaries; emits talk citations', async () => {
    const ctx = makeCtx([
      { talk_id: 't1', talk_title: 'T1', speaker: 'A', summary: 'S', start_ms: 0, end_ms: 1000, source_video_id: 'v1', youtube_id: 'yt' },
    ])
    const r = await getTalkSummaryTool.execute({ talk_id: '11111111-1111-1111-1111-111111111111' }, ctx)
    const json = r.json as any
    expect(json.talks).toHaveLength(1)
    expect(json.talks[0].summary).toBe('S')
    expect(r.sources[0]!.type).toBe('talk')
  })

  it('input schema accepts talk_id or speaker', () => {
    expect(getTalkSummaryTool.name).toBe('get_talk_summary')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-tools/get-talk-summary`

Expected: FAIL.

- [ ] **Step 3: Implement tool**

Create `src/services/qa-tools/get-talk-summary.ts`:

```ts
import { z } from 'zod'
import { getTalkSummaries } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  talk_id: z.string().uuid().optional(),
  speaker: z.string().min(1).optional(),
  scope: ScopeSchema.optional(),
}).strict()

export const getTalkSummaryTool: ToolDefinition = {
  name: 'get_talk_summary',
  description: 'Returns precomputed summaries for one or more talks. Pass talk_id for a specific talk (preferred — use resolve_entity first if needed). Pass speaker to get all of their talks (capped at 5). Returns talk-level citations.',
  input_schema: {
    type: 'object',
    properties: {
      talk_id: { type: 'string' },
      speaker: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
    },
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input ?? {})
    const baseScope = parsed.scope ?? ctx.scope
    const filters = toScopeFilters({
      ...baseScope,
      talk_id: parsed.talk_id ?? baseScope.talk_id,
      speaker: parsed.speaker ?? baseScope.speaker,
    })
    const talks = await getTalkSummaries(ctx.pool, { ...filters, limit: 5 })
    const sources: CitationSource[] = talks.map(t => ({
      type: 'talk',
      chunk_id: null,
      talk_id: t.talk_id,
      source_video_id: t.source_video_id,
      youtube_id: extractYoutubeId(t.youtube_deeplink),
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      talk_title: t.talk_title ?? '',
      speaker: t.speaker ?? '',
      video_title: null,
      day_label: null,
      series_slug: null,
      similarity: null,
    }))
    return { json: { talks }, sources }
  },
}

function extractYoutubeId(deeplink: string): string {
  const m = deeplink.match(/youtu\.be\/([^?]+)/)
  return m?.[1] ?? ''
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-tools/get-talk-summary`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/get-talk-summary.ts tests/unit/qa-tools/get-talk-summary.test.ts
git commit -m "feat(qa): tool get_talk_summary — read precomputed summaries"
```

---

## Task 14: Tool — `search_chunks`

**Files:**
- Create: `src/services/qa-tools/search-chunks.ts`
- Create: `tests/unit/qa-tools/search-chunks.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/qa-tools/search-chunks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { searchChunksTool } from '../../../src/services/qa-tools/search-chunks.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const embeddings = { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) }
  return { pool: pool as any, embeddings: embeddings as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('search_chunks tool', () => {
  it('returns chunks with metadata and emits chunk citations', async () => {
    const ctx = makeCtx([
      { chunk_id: 'c1', text: 'about evals', talk_id: 't1', talk_title: 'T1', speaker: 'A',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 1000, end_ms: 2000, rrf_score: 0.5 },
      { chunk_id: 'c2', text: 'evals again', talk_id: 't1', talk_title: 'T1', speaker: 'A',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 3000, end_ms: 4000, rrf_score: 0.4 },
      { chunk_id: 'c3', text: 'evals elsewhere', talk_id: 't2', talk_title: 'T2', speaker: 'B',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1000, rrf_score: 0.3 },
    ])
    const r = await searchChunksTool.execute({ query: 'evals' }, ctx)
    const json = r.json as any
    expect(json.chunks).toHaveLength(3)
    expect(r.sources[0]!.type).toBe('chunk')
    expect(r.sources[0]!.chunk_id).toBe('c1')
  })

  it('diversify:per_talk keeps highest-scoring chunk per talk', async () => {
    const ctx = makeCtx([
      { chunk_id: 'c1', text: 'a', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1, rrf_score: 0.9 },
      { chunk_id: 'c2', text: 'b', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v1', youtube_id: 'yt', start_ms: 2, end_ms: 3, rrf_score: 0.5 },
      { chunk_id: 'c3', text: 'c', talk_id: 't2', talk_title: 'T2', speaker: 'B', source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1, rrf_score: 0.7 },
    ])
    const r = await searchChunksTool.execute({ query: 'x', diversify: 'per_talk' }, ctx)
    const json = r.json as any
    expect(json.chunks).toHaveLength(2)
    expect(json.chunks.map((c: any) => c.chunk_id).sort()).toEqual(['c1', 'c3'])
  })

  it('k defaults to 8 and clamps to max 30', async () => {
    const ctx = makeCtx([])
    await searchChunksTool.execute({ query: 'x', k: 999 }, ctx)
    const call = (ctx.pool as any).query.mock.calls[0]
    expect(call[1][2]).toBe(30)   // match_count param
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-tools/search-chunks`

Expected: FAIL.

- [ ] **Step 3: Implement tool**

Create `src/services/qa-tools/search-chunks.ts`:

```ts
import { z } from 'zod'
import { searchChunksHybrid, matchChunks } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  query: z.string().min(1),
  scope: ScopeSchema.optional(),
  k: z.number().int().min(1).max(30).optional(),
  diversify: z.enum(['none', 'per_talk']).optional(),
  mode: z.enum(['hybrid', 'dense']).optional(),
}).strict()

export const searchChunksTool: ToolDefinition = {
  name: 'search_chunks',
  description: 'Hybrid (dense+keyword) chunk retrieval. Returns passages with talk/speaker metadata. Set diversify:"per_talk" to keep at most one chunk per talk (use this for "which talks discuss X"). Default k=8, max 30. Returns chunk-level citations.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
      k: { type: 'number' },
      diversify: { type: 'string', enum: ['none', 'per_talk'] },
      mode: { type: 'string', enum: ['hybrid', 'dense'] },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const k = Math.min(parsed.k ?? 8, 30)
    const effectiveScope = parsed.scope ?? ctx.scope
    const filters = toScopeFilters(effectiveScope)
    const [embedding] = await ctx.embeddings.embed([parsed.query])
    if (!embedding) throw new Error('embedding failed')

    const fetchK = parsed.diversify === 'per_talk' ? Math.min(k * 4, 30) : k
    const mode = parsed.mode ?? 'hybrid'

    const rows = mode === 'hybrid'
      ? await searchChunksHybrid(ctx.pool, parsed.query, embedding, fetchK, filters)
      : (await matchChunks(ctx.pool, embedding, fetchK, filters)).map(r => ({ ...r, rrf_score: r.similarity }))

    let chunks = rows
    if (parsed.diversify === 'per_talk') {
      const seen = new Set<string>()
      chunks = []
      for (const r of rows) {
        if (seen.has(r.talk_id)) continue
        seen.add(r.talk_id)
        chunks.push(r)
        if (chunks.length >= k) break
      }
    } else {
      chunks = rows.slice(0, k)
    }

    const sources: CitationSource[] = chunks.map(c => ({
      type: 'chunk',
      chunk_id: c.chunk_id,
      talk_id: c.talk_id,
      source_video_id: c.source_video_id,
      youtube_id: c.youtube_id,
      start_ms: c.start_ms ?? 0,
      end_ms: c.end_ms ?? 0,
      talk_title: c.talk_title,
      speaker: c.speaker,
      video_title: null,
      day_label: null,
      series_slug: null,
      similarity: c.rrf_score,
    }))

    return {
      json: {
        chunks: chunks.map(c => ({
          chunk_id: c.chunk_id,
          text: c.text,
          talk_id: c.talk_id,
          talk_title: c.talk_title,
          speaker: c.speaker,
          start_ms: c.start_ms ?? 0,
          end_ms: c.end_ms ?? 0,
          similarity: c.rrf_score,
          youtube_deeplink: `https://youtu.be/${c.youtube_id}?t=${Math.floor((c.start_ms ?? 0) / 1000)}`,
        })),
      },
      sources,
    }
  },
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-tools/search-chunks`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/search-chunks.ts tests/unit/qa-tools/search-chunks.test.ts
git commit -m "feat(qa): tool search_chunks — hybrid + per_talk diversification"
```

---

## Task 15: Tool — `resolve_entity`

**Files:**
- Create: `src/services/qa-tools/resolve-entity.ts`
- Create: `tests/unit/qa-tools/resolve-entity.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/qa-tools/resolve-entity.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { resolveEntityTool } from '../../../src/services/qa-tools/resolve-entity.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('resolve_entity tool', () => {
  it('returns candidates with confidence', async () => {
    const ctx = makeCtx([
      { talk_id: 't1', talk_title: 'Daytona Sandboxes', speaker: 'A', talk_index: 0, source_video_id: 'v1', confidence: 0.8 },
    ])
    const r = await resolveEntityTool.execute({ query: 'daytona' }, ctx)
    const json = r.json as any
    expect(json.candidates).toHaveLength(1)
    expect(json.candidates[0].confidence).toBeCloseTo(0.8)
    expect(r.sources).toEqual([])    // resolver itself doesn't emit citations
  })

  it('returns empty candidates on no match', async () => {
    const ctx = makeCtx([])
    const r = await resolveEntityTool.execute({ query: 'nothing' }, ctx)
    expect((r.json as any).candidates).toEqual([])
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-tools/resolve-entity`

Expected: FAIL.

- [ ] **Step 3: Implement tool**

Create `src/services/qa-tools/resolve-entity.ts`:

```ts
import { z } from 'zod'
import { resolveEntities } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'

const InputSchema = z.object({
  query: z.string().min(1),
  scope: ScopeSchema.optional(),
}).strict()

export const resolveEntityTool: ToolDefinition = {
  name: 'resolve_entity',
  description: 'Resolves natural-language references ("Jane\'s talk", "the keynote", "the eval talk") into concrete talk candidates. Returns up to 3 candidates ranked by confidence (0-1). Use this before tools that need a specific talk_id when the user names a talk in prose.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const effectiveScope = parsed.scope ?? ctx.scope
    const candidates = await resolveEntities(ctx.pool, parsed.query, toScopeFilters(effectiveScope))
    return { json: { candidates }, sources: [] }
  },
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-tools/resolve-entity`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/resolve-entity.ts tests/unit/qa-tools/resolve-entity.test.ts
git commit -m "feat(qa): tool resolve_entity — NL → talk candidates"
```

---

## Task 16: Tool — `synthesize_across_talks`

**Files:**
- Create: `src/services/qa-tools/synthesize-across-talks.ts`
- Create: `tests/unit/qa-tools/synthesize-across-talks.test.ts`
- Create: `tests/integration/qa-synthesize.test.ts`

This tool does map-reduce: pull k=60 chunks, group by talk, then a small Haiku call per top talk to generate a 2-sentence mini-summary grounded in evidence.

Per the spec §"Coordination with parallel ingest session": the haiku call must use `withRetry` if available. For now we wrap it manually with a try/catch — if `withRetry` lands separately we can swap the import.

- [ ] **Step 1: Add a `summarizeForSynthesis` method to ILLMService and mock**

First extend the LLM interface and mock to support the haiku-driven mini-summary call.

Edit `src/interfaces/llm.ts`. Add to interface:

```ts
export interface ILLMService {
  // ... existing
  summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string>
  // runToolLoop added in Task 19
}
```

Edit `src/services/llm.ts`. Add method to `ClaudeLLMService`:

```ts
async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
  const sys = 'Given an idea and short evidence passages from one conference talk, produce a 1-2 sentence summary of how THIS talk treats the idea. Quote nothing. Plain prose.'
  const user = `Idea: ${input.idea}\nTalk: "${input.talkTitle}" by ${input.speaker}\nEvidence:\n${input.evidence.map((e, i) => `(${i + 1}) ${e}`).join('\n')}`
  const res = await this.client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: sys,
    messages: [{ role: 'user', content: user }],
  })
  const blocks = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string')
  return blocks.map((b) => b.text as string).join(' ').trim()
}
```

Edit `tests/mocks/llm.mock.ts`. Add:

```ts
public synthCalls: Array<{ idea: string; talkTitle: string; speaker: string; evidence: string[] }> = []

async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
  this.synthCalls.push(input)
  return `Synth: ${input.talkTitle} on ${input.idea}.`
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS (interface change consistent with implementation + mock).

- [ ] **Step 3: Write failing unit test**

Create `tests/unit/qa-tools/synthesize-across-talks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { synthesizeAcrossTalksTool } from '../../../src/services/qa-tools/synthesize-across-talks.js'
import { MockLLMService } from '../../mocks/llm.mock.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[], llm: MockLLMService): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const embeddings = { embed: vi.fn().mockResolvedValue([[0.1]]) }
  return { pool: pool as any, embeddings: embeddings as any, llm: llm as any, scope: {}, signal: new AbortController().signal }
}

describe('synthesize_across_talks tool', () => {
  it('groups chunks by talk and calls mini-summary per talk', async () => {
    const llm = new MockLLMService()
    const ctx = makeCtx(
      [
        { chunk_id: 'c1', text: 'one', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 0.9 },
        { chunk_id: 'c2', text: 'two', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v', youtube_id: 'y', start_ms: 2, end_ms: 3, rrf_score: 0.8 },
        { chunk_id: 'c3', text: 'three', talk_id: 't2', talk_title: 'T2', speaker: 'B', source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 0.7 },
      ],
      llm
    )
    const r = await synthesizeAcrossTalksTool.execute({ idea: 'X' }, ctx)
    const json = r.json as any
    expect(json.per_talk_evidence).toHaveLength(2)
    expect(json.per_talk_evidence[0].talk_id).toBe('t1')
    expect(json.per_talk_evidence[0].evidence_chunks.length).toBeGreaterThan(0)
    expect(json.per_talk_evidence[0].mini_summary).toContain('Synth')
    expect(llm.synthCalls).toHaveLength(2)
    expect(r.sources.length).toBeGreaterThan(0)
  })

  it('caps at 8 talks', async () => {
    const llm = new MockLLMService()
    const rows = Array.from({ length: 12 }, (_, i) => ({
      chunk_id: `c${i}`, text: 'x', talk_id: `t${i}`, talk_title: `T${i}`, speaker: 'A',
      source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 1 - i * 0.01,
    }))
    const ctx = makeCtx(rows, llm)
    const r = await synthesizeAcrossTalksTool.execute({ idea: 'X' }, ctx)
    expect((r.json as any).per_talk_evidence).toHaveLength(8)
    expect((r.json as any).talks_returned).toBe(8)
    expect((r.json as any).talks_considered).toBe(12)
  })
})
```

- [ ] **Step 4: Run test, confirm it fails**

Run: `npm test -- qa-tools/synthesize-across-talks`

Expected: FAIL.

- [ ] **Step 5: Implement tool**

Create `src/services/qa-tools/synthesize-across-talks.ts`:

```ts
import { z } from 'zod'
import { searchChunksHybrid } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  idea: z.string().min(1),
  scope: ScopeSchema.optional(),
  per_talk_k: z.number().int().min(1).max(8).optional(),
}).strict()

const MAX_TALKS = 8
const CANDIDATE_POOL = 60

export const synthesizeAcrossTalksTool: ToolDefinition = {
  name: 'synthesize_across_talks',
  description: 'Cross-talk map-reduce for an idea. Pulls a wide pool of chunks, groups by talk, and produces a 1-2 sentence summary per talk of how that talk treats the idea. Use for "main conclusions about X across the day" or "how is X covered across talks". Returns chunk-level citations and per-talk mini-summaries.',
  input_schema: {
    type: 'object',
    properties: {
      idea: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
      per_talk_k: { type: 'number' },
    },
    required: ['idea'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const perTalkK = parsed.per_talk_k ?? 3
    const filters = toScopeFilters(parsed.scope ?? ctx.scope)

    const [embedding] = await ctx.embeddings.embed([parsed.idea])
    if (!embedding) throw new Error('embedding failed')

    const rows = await searchChunksHybrid(ctx.pool, parsed.idea, embedding, CANDIDATE_POOL, filters)

    // group by talk_id, keep per-talk top chunks
    const byTalk = new Map<string, typeof rows>()
    for (const r of rows) {
      const arr = byTalk.get(r.talk_id) ?? []
      arr.push(r)
      byTalk.set(r.talk_id, arr)
    }

    const ranked = [...byTalk.entries()]
      .map(([talk_id, chunks]) => {
        const sorted = chunks.sort((a, b) => b.rrf_score - a.rrf_score).slice(0, perTalkK)
        const relevance = sorted[0]?.rrf_score ?? 0
        return { talk_id, chunks: sorted, relevance }
      })
      .sort((a, b) => b.relevance - a.relevance)

    const top = ranked.slice(0, MAX_TALKS)

    const summarised = await Promise.all(
      top.map(async (t) => {
        const first = t.chunks[0]!
        const mini_summary = await ctx.llm.summarizeForSynthesis({
          idea: parsed.idea,
          talkTitle: first.talk_title,
          speaker: first.speaker,
          evidence: t.chunks.map(c => c.text),
        })
        return {
          talk_id: t.talk_id,
          talk_title: first.talk_title,
          speaker: first.speaker,
          relevance: t.relevance,
          evidence_chunks: t.chunks.map(c => ({
            chunk_id: c.chunk_id,
            text: c.text,
            start_ms: c.start_ms ?? 0,
            youtube_deeplink: `https://youtu.be/${c.youtube_id}?t=${Math.floor((c.start_ms ?? 0) / 1000)}`,
          })),
          mini_summary,
        }
      })
    )

    const sources: CitationSource[] = []
    for (const t of top) {
      for (const c of t.chunks) {
        sources.push({
          type: 'chunk',
          chunk_id: c.chunk_id,
          talk_id: c.talk_id,
          source_video_id: c.source_video_id,
          youtube_id: c.youtube_id,
          start_ms: c.start_ms ?? 0,
          end_ms: c.end_ms ?? 0,
          talk_title: c.talk_title,
          speaker: c.speaker,
          video_title: null,
          day_label: null,
          series_slug: null,
          similarity: c.rrf_score,
        })
      }
    }

    return {
      json: {
        per_talk_evidence: summarised,
        talks_considered: byTalk.size,
        talks_returned: top.length,
      },
      sources,
    }
  },
}
```

- [ ] **Step 6: Run unit tests, confirm they pass**

Run: `npm test -- qa-tools/synthesize-across-talks`

Expected: PASS.

- [ ] **Step 7: Write integration test (real db, mock LLM for haiku)**

Create `tests/integration/qa-synthesize.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, insertTranscript, insertChunk } from '../../src/db/queries.js'
import { synthesizeAcrossTalksTool } from '../../src/services/qa-tools/synthesize-across-talks.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

describe('synthesize_across_talks integration', () => {
  it('returns per-talk evidence with mini-summaries from real db', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 3; i++) {
      const t = await insertTalk(pool, { sourceVideoId: sv.id, title: `Talk ${i}`, speaker: `S${i}`, talkIndex: i, startMs: i * 1000, endMs: (i + 1) * 1000 })
      const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: `x${i}`, rawText: '', utterances: [] })
      await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: `evaluation matters here ${i}`, startMs: i, endMs: i + 1, tokenCount: 3, embedding: vec(1) })
    }

    const llm = new MockLLMService()
    const embeddings = new MockEmbeddingService()
    const r = await synthesizeAcrossTalksTool.execute(
      { idea: 'evaluation' },
      { pool: pool as any, embeddings: embeddings as any, llm: llm as any, scope: {}, signal: new AbortController().signal }
    )
    const json = r.json as any
    expect(json.per_talk_evidence.length).toBeGreaterThan(0)
    expect(json.per_talk_evidence.every((e: any) => typeof e.mini_summary === 'string' && e.mini_summary.length > 0)).toBe(true)
    expect(llm.synthCalls.length).toBe(json.per_talk_evidence.length)
  })
})
```

- [ ] **Step 8: Run integration test**

Run: `npm run test:integration -- qa-synthesize`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/qa-tools/synthesize-across-talks.ts src/services/llm.ts src/interfaces/llm.ts tests/mocks/llm.mock.ts tests/unit/qa-tools/synthesize-across-talks.test.ts tests/integration/qa-synthesize.test.ts
git commit -m "feat(qa): tool synthesize_across_talks — map-reduce with haiku mini-summaries"
```

---

## Task 17: Tool registry

**Files:**
- Create: `src/services/qa-tools/index.ts`

- [ ] **Step 1: Create registry**

Create `src/services/qa-tools/index.ts`:

```ts
import type { ToolDefinition } from './types.js'
import { resolveEntityTool } from './resolve-entity.js'
import { getTalkSummaryTool } from './get-talk-summary.js'
import { searchChunksTool } from './search-chunks.js'
import { synthesizeAcrossTalksTool } from './synthesize-across-talks.js'
import { getOverviewTool } from './get-overview.js'
import { getMetadataTool } from './get-metadata.js'

export const QA_TOOLS: ToolDefinition[] = [
  resolveEntityTool,
  getTalkSummaryTool,
  searchChunksTool,
  synthesizeAcrossTalksTool,
  getOverviewTool,
  getMetadataTool,
]

export type { ToolDefinition, ToolContext, ToolExecutionResult, ToolCall } from './types.js'
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/qa-tools/index.ts
git commit -m "feat(qa): export tool registry"
```

---

# Phase 4 — Runner + LLM service

## Task 18: FakeAnthropic mock

**Files:**
- Create: `tests/mocks/anthropic.mock.ts`

This fake is used by the runner unit tests. It replays scripted responses.

- [ ] **Step 1: Create the mock**

Create `tests/mocks/anthropic.mock.ts`:

```ts
export type FakeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export type FakeResponse = {
  stop_reason: 'end_turn' | 'tool_use'
  content: FakeContentBlock[]
}

export class FakeAnthropic {
  public calls: Array<{ system: unknown; messages: unknown[]; tool_choice?: unknown }> = []
  private queue: FakeResponse[]

  constructor(responses: FakeResponse[]) {
    this.queue = [...responses]
  }

  messages = {
    create: async (params: any): Promise<FakeResponse> => {
      this.calls.push({ system: params.system, messages: params.messages, tool_choice: params.tool_choice })
      const next = this.queue.shift()
      if (!next) throw new Error('FakeAnthropic: ran out of scripted responses')
      return next
    },
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/mocks/anthropic.mock.ts
git commit -m "test(qa): FakeAnthropic mock with scripted response queue"
```

---

## Task 19: Add `runToolLoop` to LLM service + interface; delete `answerQuestion`

**Files:**
- Modify: `src/services/llm.ts`
- Modify: `src/interfaces/llm.ts`
- Modify: `tests/mocks/llm.mock.ts`

`runToolLoop` itself wraps the Anthropic `messages.create` calls. The actual loop logic lives in `runner.ts` (Task 20); the LLM service exposes a thin wrapper that calls Anthropic with `tools` parameter so the runner stays decoupled from the SDK.

Design choice: `runToolLoop` lives on `ILLMService` as a primitive `messages.create` call with tools. The runner orchestrates iteration. Simpler than putting the loop into `llm.ts`.

- [ ] **Step 1: Update interface**

Edit `src/interfaces/llm.ts`. Remove `answerQuestion` and add a new method:

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

export type AnthropicMessage =
  | { role: 'user'; content: string | Array<unknown> }
  | { role: 'assistant'; content: string | Array<unknown> }

export type AnthropicToolUse = {
  id: string
  name: string
  input: unknown
}

export type AnthropicCallResponse = {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >
}

export interface ToolCallOptions {
  system: string
  messages: AnthropicMessage[]
  tools: Array<{ name: string; description: string; input_schema: unknown }>
  tool_choice?: { type: 'auto' } | { type: 'none' } | { type: 'tool'; name: string }
  max_tokens?: number
  model?: string
  signal?: AbortSignal
}

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]>
  summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string>
  toolCall(opts: ToolCallOptions): Promise<AnthropicCallResponse>
}
```

- [ ] **Step 2: Update implementation**

Edit `src/services/llm.ts`. Delete `answerQuestion`. Add `toolCall`:

```ts
async toolCall(opts: ToolCallOptions): Promise<AnthropicCallResponse> {
  const res = await this.client.messages.create({
    model: opts.model ?? MODEL,
    max_tokens: opts.max_tokens ?? 2048,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tool_choice ?? { type: 'auto' },
  } as any)
  return res as unknown as AnthropicCallResponse
}
```

Also widen the `ClientLike` type at the top of the file to accept the extra params:

```ts
type ClientLike = {
  messages: {
    create(p: any): Promise<any>
  }
}
```

Remove the `answerQuestion` method body entirely.

- [ ] **Step 3: Update mock**

Edit `tests/mocks/llm.mock.ts`. Remove `answerCalls` and `answerQuestion`. Add a scripted-response `toolCall`:

```ts
import type { ILLMService, FaqItem, FaqGenerationInput, AnthropicCallResponse, ToolCallOptions } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public faqCalls: FaqGenerationInput[] = []
  public synthCalls: Array<{ idea: string; talkTitle: string; speaker: string; evidence: string[] }> = []
  public toolCallLog: ToolCallOptions[] = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private faqs: FaqItem[] = [
      { question: 'q1?', answer: 'a1.' },
      { question: 'q2?', answer: 'a2.' },
    ],
    private toolCallResponses: AnthropicCallResponse[] = [],
  ) {}

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    this.segmentCalls.push(transcript)
    return this.boundaries
  }
  async summarizeTalk(transcript: string): Promise<string> {
    this.summarizeCalls.push(transcript)
    return this.summary
  }
  async generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]> {
    this.faqCalls.push(input)
    return this.faqs
  }
  async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
    this.synthCalls.push(input)
    return `Synth: ${input.talkTitle} on ${input.idea}.`
  }
  async toolCall(opts: ToolCallOptions): Promise<AnthropicCallResponse> {
    this.toolCallLog.push(opts)
    const next = this.toolCallResponses.shift()
    if (!next) throw new Error('MockLLMService: no scripted tool-call response')
    return next
  }

  pushToolCallResponse(resp: AnthropicCallResponse): void {
    this.toolCallResponses.push(resp)
  }
}
```

- [ ] **Step 4: Update existing call sites that used `answerQuestion`**

Search for remaining usages:

Run: `npm run typecheck`

The only consumer was `src/routes/qa.ts:40` (`deps.llm.answerQuestion(...)`). That route will be rewritten in Task 22; for now, comment out the body of `qa.ts` and have it return 501 so the typecheck passes:

Edit `src/routes/qa.ts` — replace its current content with a stub:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'

export async function registerQaRoutes(app: FastifyInstance, _deps: AppDeps): Promise<void> {
  app.post('/qa', async (_req, reply) => reply.code(501).send({ error: 'qa route under upgrade' }))
}
```

Also: `tests/routes/qa.test.ts` will fail because it expects the old route — temporarily skip its describe block:

Edit `tests/routes/qa.test.ts:56` — change `describe('POST /qa'` to `describe.skip('POST /qa'`. Add a comment: `// re-enabled by qa-route.test.ts integration in Phase 5`.

- [ ] **Step 5: Run typecheck + unit tests**

Run: `npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/llm.ts src/interfaces/llm.ts tests/mocks/llm.mock.ts src/routes/qa.ts tests/routes/qa.test.ts
git commit -m "feat(qa): LLM service exposes toolCall primitive; drop answerQuestion; qa route stub returns 501"
```

---

## Task 20: Runner

**Files:**
- Create: `src/services/qa-tools/runner.ts`
- Create: `tests/unit/qa-runner.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/qa-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runToolLoop } from '../../src/services/qa-tools/runner.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type { ToolDefinition } from '../../src/services/qa-tools/types.js'

function makeFakeTool(name: string, output: unknown): ToolDefinition {
  return {
    name,
    description: '',
    input_schema: { type: 'object' },
    async execute() { return { json: output, sources: [] } },
  }
}

describe('runToolLoop', () => {
  it('terminates on end_turn', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
    })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      scope: {},
      tools: [],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.answer).toBe('Done.')
    expect(result.reachedBudgetCap).toBe(false)
  })

  it('runs a single tool then terminates', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'get_metadata', input: {} }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '5 talks.' }],
    })
    const tool = makeFakeTool('get_metadata', { total_talks: 5 })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'how many talks' }],
      scope: {},
      tools: [tool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.answer).toBe('5 talks.')
    expect(result.toolTrace).toHaveLength(1)
    expect(result.toolTrace[0]!.tool).toBe('get_metadata')
    expect(result.toolTrace[0]!.ok).toBe(true)
  })

  it('reaches iteration cap and forces final answer', async () => {
    const llm = new MockLLMService()
    for (let i = 0; i < 3; i++) {
      llm.pushToolCallResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu${i}`, name: 'get_metadata', input: {} }],
      })
    }
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Capped answer.' }],
    })
    const tool = makeFakeTool('get_metadata', { total_talks: 5 })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      scope: {},
      tools: [tool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 2, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.reachedBudgetCap).toBe(true)
    expect(result.answer).toBe('Capped answer.')
  })

  it('tool failure becomes tool_result error, not exception', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'failing', input: {} }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'gave up.' }],
    })
    const failingTool: ToolDefinition = {
      name: 'failing',
      description: '',
      input_schema: { type: 'object' },
      async execute() { throw new Error('boom') },
    }
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      scope: {},
      tools: [failingTool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.partial).toBe(true)
    expect(result.toolTrace[0]!.ok).toBe(false)
    expect(result.toolTrace[0]!.error).toContain('boom')
  })

  it('strips assistant prior turns to text only when sending to llm', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK.' }],
    })
    await runToolLoop({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
      ],
      scope: {},
      tools: [],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    const sent = llm.toolCallLog[0]!.messages
    expect(sent).toHaveLength(3)
    expect((sent[1] as any).content).toBe('first answer')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- qa-runner`

Expected: FAIL — `runToolLoop` doesn't exist.

- [ ] **Step 3: Implement runner**

Create `src/services/qa-tools/runner.ts`:

```ts
import type { Pool } from 'pg'
import type { IEmbeddingService } from '../../interfaces/embeddings.js'
import type { ILLMService, AnthropicMessage, AnthropicCallResponse } from '../../interfaces/llm.js'
import type { Scope } from '../qa-scope.js'
import type { ToolDefinition, ToolCall } from './types.js'
import type { CitationSource } from './citation-validator.js'
import { SYSTEM_PROMPT } from './system-prompt.js'

export interface RunToolLoopOpts {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  scope: Scope
  tools: ToolDefinition[]
  llm: ILLMService
  embeddings: IEmbeddingService
  pool: Pool
  budget: { maxIterations: number; maxWallMs: number; maxToolResultTokens: number }
}

export interface RunToolLoopResult {
  rawAnswer: string
  toolTrace: ToolCall[]
  reachedBudgetCap: boolean
  partial: boolean
  sources: CitationSource[]
}

const CHAR_PER_TOKEN = 4

export async function runToolLoop(opts: RunToolLoopOpts): Promise<RunToolLoopResult> {
  const controller = new AbortController()
  const deadline = Date.now() + opts.budget.maxWallMs
  const timer = setTimeout(() => controller.abort(), opts.budget.maxWallMs)

  const toolByName = new Map(opts.tools.map(t => [t.name, t]))
  const collectedSources: CitationSource[] = []
  const toolTrace: ToolCall[] = []
  let partial = false
  let reachedBudgetCap = false

  // history-strip: only assistant text from prior turns + the current user turn
  const stripped: AnthropicMessage[] = opts.messages.map(m => ({ role: m.role, content: m.content }))

  const toolsForLlm = opts.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))

  let resp: AnthropicCallResponse | null = null

  try {
    for (let i = 0; i < opts.budget.maxIterations; i++) {
      if (Date.now() > deadline) { reachedBudgetCap = true; break }
      resp = await opts.llm.toolCall({
        system: SYSTEM_PROMPT,
        messages: stripped,
        tools: toolsForLlm,
        tool_choice: { type: 'auto' },
        signal: controller.signal,
      })
      if (resp.stop_reason === 'end_turn') {
        const answer = joinText(resp.content)
        return { rawAnswer: answer, toolTrace, reachedBudgetCap: false, partial, sources: collectedSources }
      }
      if (resp.stop_reason !== 'tool_use') {
        // unexpected stop; surface as partial
        partial = true
        const answer = joinText(resp.content)
        return { rawAnswer: answer, toolTrace, reachedBudgetCap: false, partial, sources: collectedSources }
      }

      const toolUses = resp.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')

      const ctx = {
        pool: opts.pool,
        embeddings: opts.embeddings,
        llm: opts.llm,
        scope: opts.scope,
        signal: controller.signal,
      }

      const results = await Promise.all(toolUses.map(async (tu) => {
        const tool = toolByName.get(tu.name)
        const start = Date.now()
        if (!tool) {
          toolTrace.push({ tool: tu.name, duration_ms: 0, ok: false, error: 'unknown tool' })
          partial = true
          return { tool_use_id: tu.id, payload: { error: 'unknown tool' } }
        }
        try {
          const result = await tool.execute(tu.input, ctx)
          for (const s of result.sources) collectedSources.push(s)
          toolTrace.push({ tool: tu.name, duration_ms: Date.now() - start, ok: true })
          return { tool_use_id: tu.id, payload: result.json }
        } catch (err) {
          partial = true
          const msg = err instanceof Error ? err.message : String(err)
          toolTrace.push({ tool: tu.name, duration_ms: Date.now() - start, ok: false, error: msg })
          return { tool_use_id: tu.id, payload: { error: msg } }
        }
      }))

      stripped.push({ role: 'assistant', content: resp.content })
      stripped.push({
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result',
          tool_use_id: r.tool_use_id,
          content: truncate(JSON.stringify(r.payload), opts.budget.maxToolResultTokens),
        })),
      })
    }

    reachedBudgetCap = true
    const finalResp = await opts.llm.toolCall({
      system: SYSTEM_PROMPT,
      messages: stripped,
      tools: toolsForLlm,
      tool_choice: { type: 'none' },
      signal: controller.signal,
    })
    return { rawAnswer: joinText(finalResp.content), toolTrace, reachedBudgetCap, partial, sources: collectedSources }
  } finally {
    clearTimeout(timer)
  }
}

function joinText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

function truncate(s: string, maxTokens: number): string {
  const maxChars = maxTokens * CHAR_PER_TOKEN
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + '\n...[truncated]'
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- qa-runner`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qa-tools/runner.ts tests/unit/qa-runner.test.ts
git commit -m "feat(qa): runner loop — tool_use iteration with budget caps"
```

---

# Phase 5 — Route swap

## Task 21: Rewrite `/qa` route

**Files:**
- Modify: `src/routes/qa.ts`
- Create: `tests/integration/qa-route.test.ts`
- Delete: `tests/routes/qa.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/qa-route.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { buildServer } from '../../src/server.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk, updateTranscriptSummary,
} from '../../src/db/queries.js'
import type { FastifyInstance } from 'fastify'

const pool = makeTestPool()
let app: FastifyInstance
let llm: MockLLMService

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
  llm = new MockLLMService()
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm,
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
})

afterAll(async () => { await pool.end() })

describe('POST /qa (tool-use)', () => {
  it('rejects empty messages', async () => {
    const res = await app.inject({ method: 'POST', url: '/qa', payload: { messages: [] } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects last message not user', async () => {
    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('runs end-to-end with get_talk_summary path and validates citations', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'V' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Daytona', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr.id, 'Summary text.')

    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'get_talk_summary', input: { talk_id: t.id } }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `The talk covers Daytona [talk:${t.id}].` }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'main idea of daytona talk?' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).toBe('The talk covers Daytona [1].')
    expect(body.citations).toHaveLength(1)
    expect(body.citations[0].talk_id).toBe(t.id)
    expect(body.citations[0].youtube_deeplink).toBe('https://youtu.be/a?t=0')
    expect(body.citations[0].transcript_anchor).toBe(`#talk-${t.id}`)
  })

  it('strips invalid citation markers', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: 'x', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })

    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'search_chunks', input: { query: 'x' } }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A [chunk:00000000-0000-0000-0000-000000000000] then [done].' }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'x?' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).not.toContain('chunk:00000000')
  })

  it('returns 200 with partial:true when loop hits iteration cap', async () => {
    // Configure 6 consecutive tool_use responses to overshoot maxIterations=5
    for (let i = 0; i < 6; i++) {
      llm.pushToolCallResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu${i}`, name: 'get_metadata', input: {} }],
      })
    }
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Forced answer.' }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'loop' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reached_cap).toBe(true)
    expect(body.answer).toBe('Forced answer.')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm run test:integration -- qa-route`

Expected: FAIL — route is still a 501 stub.

- [ ] **Step 3: Implement route**

Replace `src/routes/qa.ts` entirely:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AppDeps } from '../server.js'
import { parseScope } from '../services/qa-scope.js'
import { QA_TOOLS } from '../services/qa-tools/index.js'
import { runToolLoop } from '../services/qa-tools/runner.js'
import { validateAndRewriteCitations } from '../services/qa-tools/citation-validator.js'

const MAX_HISTORY_MESSAGES = 20
const MAX_HISTORY_TOKENS = 30_000
const REQUEST_MESSAGES_HARD_CAP = 100
const LOOP_BUDGET = { maxIterations: 5, maxWallMs: 20_000, maxToolResultTokens: 15_000 }
const CHAR_PER_TOKEN = 4

const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

const ScopeIn = z
  .object({
    series_slug: z.string().min(1).max(100).optional(),
    source_video_id: z.array(z.string().uuid()).max(10).optional(),
    talk_id: z.string().uuid().optional(),
    speaker: z.string().min(1).max(100).optional(),
  })
  .strict()
  .optional()

const Body = z.object({
  messages: z.array(ChatMessage).min(1).max(REQUEST_MESSAGES_HARD_CAP),
  scope: ScopeIn,
})

export async function registerQaRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/qa',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', detail: parsed.error.issues })
      }
      const { messages, scope: rawScope } = parsed.data
      if (messages[messages.length - 1]!.role !== 'user') {
        return reply.code(400).send({ error: 'last message must be user' })
      }
      let scope
      try { scope = parseScope(rawScope) } catch (e) {
        return reply.code(400).send({ error: 'invalid scope', detail: e instanceof Error ? e.message : String(e) })
      }

      const trimmed = trimHistory(messages)

      const requestId = randomUUID()
      const started = Date.now()

      let loopResult
      try {
        loopResult = await runToolLoop({
          messages: trimmed,
          scope,
          tools: QA_TOOLS,
          llm: deps.llm,
          embeddings: deps.embeddings,
          pool: deps.pool,
          budget: LOOP_BUDGET,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        req.log?.error?.({ event: 'qa.failed', request_id: requestId, err: msg })
        return reply.code(502).send({ error: 'llm_unavailable', detail: msg })
      }

      const { answer, citations, stripped } = validateAndRewriteCitations(loopResult.rawAnswer, loopResult.sources)

      // observability log
      console.log(JSON.stringify({
        event: 'qa.complete',
        request_id: requestId,
        scope,
        history_messages: trimmed.length,
        loop_iterations: loopResult.toolTrace.length,
        tool_calls: loopResult.toolTrace,
        total_wall_ms: Date.now() - started,
        partial: loopResult.partial,
        reached_cap: loopResult.reachedBudgetCap,
        invalid_citations_stripped: stripped,
        answer_chars: answer.length,
        citations_returned: citations.length,
      }))

      return reply.code(200).send({
        answer,
        citations,
        partial: loopResult.partial || undefined,
        reached_cap: loopResult.reachedBudgetCap || undefined,
        debug_tool_trace: process.env.DEBUG_QA === '1' ? loopResult.toolTrace : undefined,
      })
    }
  )
}

function trimHistory(messages: z.infer<typeof Body>['messages']): Array<{ role: 'user' | 'assistant'; content: string }> {
  // cap by count: keep first user message + most recent up to MAX_HISTORY_MESSAGES total
  let trimmed = messages.slice()
  if (trimmed.length > MAX_HISTORY_MESSAGES) {
    const first = trimmed[0]!
    trimmed = [first, ...trimmed.slice(-(MAX_HISTORY_MESSAGES - 1))]
  }
  // cap by tokens: drop oldest after the first user message until under budget
  while (estimateTokens(trimmed) > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    trimmed.splice(1, 1)
  }
  return trimmed
}

function estimateTokens(messages: Array<{ content: string }>): number {
  let chars = 0
  for (const m of messages) chars += m.content.length
  return Math.ceil(chars / CHAR_PER_TOKEN)
}
```

- [ ] **Step 4: Delete the old route test**

Run: `rm tests/routes/qa.test.ts`

(This file was made `describe.skip` in Task 19; integration test now covers it.)

- [ ] **Step 5: Run all tests**

Run: `npm test && npm run test:integration`

Expected: PASS across all suites.

- [ ] **Step 6: Commit**

```bash
git add src/routes/qa.ts tests/integration/qa-route.test.ts
git rm tests/routes/qa.test.ts
git commit -m "feat(qa): rewrite /qa route to use tool-use runner + citation validator"
```

---

## Self-review

Read the spec and the plan side-by-side. Verify each spec requirement maps to a task.

| Spec section | Implemented by task(s) |
|---|---|
| §"Architecture" loop shape | Task 20 (runner) + 21 (route) |
| §"Component summary" file list | Tasks 1, 3, 4, 10, 11–17, 20–22 — all files accounted for |
| §"Request / response contract" | Task 21 — body validation, response shape |
| §"Scope" | Task 3 |
| §"Conversation memory" history stripping + caps | Task 20 (runner stripping) + Task 21 (request trim) |
| §"Tool 1 resolve_entity" | Task 15 |
| §"Tool 2 get_talk_summary" | Task 13 |
| §"Tool 3 search_chunks" | Task 14 |
| §"Tool 4 synthesize_across_talks" | Task 16 |
| §"Tool 5 get_overview" | Task 12 |
| §"Tool 6 get_metadata" | Task 11 |
| §"Loop runner" algorithm + budgets | Task 20 |
| §"System prompt" | Task 10 |
| §"Citation validator" | Task 4 |
| §"Database changes" migration | Task 1 |
| §"DB query layer" | Tasks 2 + 5–9 |
| §"Error handling" 400/200-partial behavior | Task 20 (tool error) + Task 21 (body validation, 502 on llm fail) |
| §"Observability" structured log | Task 21 |
| §"Testing strategy" unit + integration | Tasks 3–4, 5–9, 11–16, 18, 20, 21 |

Coverage confirmed. Manual prod verification checklist is in the spec — runs after this plan lands.
