# QA Tool-Use Router Upgrade — Design

**Date:** 2026-05-25
**Scope:** Rewrite `/qa` from a single-mode dense-retrieval endpoint into a tool-use loop over six specialized retrieval tools, with conversation memory, cross-video scoping, and citation validation. Target use case: a 9-hour conference video with 15–20 talks today, with day1/day2 cross-video readiness for tomorrow.
**Non-goals:** see §11.

## Problem

Today's `/qa` (`src/routes/qa.ts`) does one thing: dense top-8 over chunks. Of the four user-intent classes we need to support, only the "specific passage" lookup works well:

| Intent | Example | Today |
|---|---|---|
| 1. Specific talk | "main idea of talk X" | Partial — chunks instead of the precomputed `transcripts.summary` |
| 2. Idea → talks | "which talks discuss X" | Broken — top-8 clusters into one talk; no diversity |
| 3. Cross-talk synthesis | "conclusions for X across the day" | Broken — 8 chunks ≈ 3% of a 9hr corpus |
| 4. Conference-wide | "top 10 ideas", "summary" | Broken — never reads existing summaries/FAQs |
| 5. Speaker-scoped | "what did Jane say" | Broken — no entity resolution |
| 6. Temporal | "the second talk", "the morning keynote" | Broken — no positional resolution |
| 7. Comparative | "X vs Y" | Broken — single retrieval pass |
| 8. Quote/timestamp | "where was X mentioned" | Partial — returns citations but no diversification |
| 9. Definitional | "what is X" | Partial |
| 10. Recommendation | "which talk should I watch about X" | Broken |
| 11. Meta/structural | "how many talks", "who's speaking" | Broken — chunk retrieval is the wrong tool |
| 12. Follow-up / multi-hop | "tell me more about the second one" | Broken — no conversation history server-side |

Secondary issues:
- N+1 hydration in citation building (`qa.ts:29–57`, ~24 sequential queries per request).
- No scope dimension beyond `talk_id` — can't filter by `source_video_id`, by series, or by speaker.
- No grounding validation; hallucinated `[chunk:X]` IDs reach the user.
- FE owns conversation state but BE accepts only `{question}` — multi-turn doesn't work.

## Non-goals

Explicitly out of scope:
- Anthropic prompt caching (deferred until repeat-traffic justifies).
- Cross-encoder reranking (deferred until corpus ≥5k chunks).
- HNSW `ef_search` tuning, partitioning, alternate index (deferred until ≥100k chunks).
- Server-side conversation persistence (deferred until auth).
- Per-user / per-tier rate limits (deferred until auth).
- SSE streaming response (deferred; demo UX acceptable without it).
- Provider fallback (deferred; single-tenant risk accepted).
- Embedding cache (deferred until repeat-query rate is observable).
- Multi-tenancy / `owner_id` schema (deferred).
- FE work — citation rendering changes, transcript-anchor scrolling, `localStorage` history. Documented in §8 for the FE engineer but not implemented in this spec.

## Architecture

`POST /qa` becomes a slim route over a stateless tool-use loop. The loop driver (`runToolLoop`) issues `messages.create` calls to Claude with `tools: [...]` and `tool_choice: 'auto'`, executing tool calls in parallel, until Claude emits a terminal `end_turn`. A citation validator then strips any inline `[chunk:<id>]` or `[talk:<id>]` markers whose IDs weren't returned by a tool this turn, and rewrites valid markers to `[1]`, `[2]`, …

```
POST /qa { messages[], scope? }
  │
  ▼
[Route: qa.ts]                — parse, normalize scope, hand off
  │
  ▼
[runToolLoop(messages, scope, tools, budget)]
  │  ──► messages.create({ system, tools, messages, tool_choice:'auto' })
  │      └─ tool_use blocks
  │  ◄── execute tools in parallel (each with same scope context)
  │  ──► messages.create({ ..., messages + tool_result })
  │      └─ either more tool_use or final text
  │  ◄── done (or iteration cap → force-final with tool_choice:'none')
  ▼
[CitationValidator]            — strip invalid markers, rewrite to [1],[2],…
  ▼
{ answer, citations, partial?, reached_cap?, debug_tool_trace? }
```

### Component summary

| Component | File | Purpose |
|---|---|---|
| Route | `src/routes/qa.ts` (rewrite) | Body parse, scope validation, runner invocation, citation post-processing, response shape |
| Loop runner | `src/services/qa-tools/runner.ts` (new) | Drives Claude tool-use loop with budgets |
| System prompt | `src/services/qa-tools/system-prompt.ts` (new) | Static prompt + tool-selection guide |
| Tool registry | `src/services/qa-tools/index.ts` (new) | Exports the six `ToolDefinition`s |
| Tool 1 `resolve_entity` | `src/services/qa-tools/resolve-entity.ts` (new) | NL → `{talk_id, speaker, ...}` candidates |
| Tool 2 `get_talk_summary` | `src/services/qa-tools/get-talk-summary.ts` (new) | Read precomputed summaries |
| Tool 3 `search_chunks` | `src/services/qa-tools/search-chunks.ts` (new) | Hybrid retrieval + optional per-talk diversification |
| Tool 4 `synthesize_across_talks` | `src/services/qa-tools/synthesize-across-talks.ts` (new) | Map-reduce; haiku per-talk mini-summaries |
| Tool 5 `get_overview` | `src/services/qa-tools/get-overview.ts` (new) | All summaries + FAQs in scope |
| Tool 6 `get_metadata` | `src/services/qa-tools/get-metadata.ts` (new) | Aggregations (counts, speakers, day labels) |
| Citation validator | `src/services/qa-tools/citation-validator.ts` (new) | Strip invalid markers, rewrite to numbered |
| Scope type | `src/services/qa-scope.ts` (new) | Single typed scope; serializes to SQL params |
| LLM service | `src/services/llm.ts` (modify) | Add `runToolLoop` method; delete unused `answerQuestion` |
| LLM interface | `src/interfaces/llm.ts` (modify) | Mirror change |
| DB queries | `src/db/queries.ts` (modify) | Add 5 new helpers, replace `matchChunks` signature |
| Migration | `src/db/migrations/004_qa_upgrade.sql` (new) | Schema + functions + indexes |
| Search route | `src/routes/search.ts` (modify) | Adapt to new `matchChunks` signature |

## Request / response contract

### Request

```ts
type ChatMessage = { role: 'user' | 'assistant', content: string }

type Scope = {
  series_slug?: string
  source_video_id?: string[]   // OR semantics
  talk_id?: string             // narrowest; wins over broader
  speaker?: string             // case-insensitive contains
}

type QaRequest = {
  messages: ChatMessage[]      // oldest first; last must be role:'user'
  scope?: Scope
}
```

**Validation rules:**
- `messages` non-empty, last role is `'user'` — else 400.
- ≤100 messages hard cap — else 400.
- All UUIDs in scope validated; bad UUIDs → 400.
- Total `messages[]` token estimate >30k → trim oldest (keep first user message) until under budget.

**Scope filters AND together** at the SQL level (any non-null filter narrows results). Stating precedence narrow → broad: `talk_id` > `source_video_id` > `series_slug` > unscoped. When `talk_id` is set, broader filters in the same scope are redundant — Claude is instructed via the system prompt to omit them, but the SQL is correct either way.

### Response

```ts
type Citation = {
  chunk_id: string | null            // null when source === 'talk'
  talk_id: string
  source_video_id: string
  youtube_id: string
  youtube_deeplink: string           // full URL — external
  start_ms: number
  end_ms: number
  transcript_anchor: string          // e.g. "#chunk-<id>" or "#talk-<id>"
  talk_title: string
  speaker: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  similarity: number | null
  source: 'chunk' | 'talk'
}

type QaResponse = {
  answer: string                     // citations rewritten to [1],[2],…
  citations: Citation[]              // [i-1] in answer maps to citations[i-1]
  partial?: boolean                  // any tool failed or loop capped
  reached_cap?: boolean              // iteration or wall-clock cap hit
  debug_tool_trace?: ToolCall[]      // only when DEBUG_QA=1
}
```

**Citation contract notes:**
- Backward compatible: existing fields (`video_id` → `source_video_id`, `talk_id`, `talk_title`, `start_ms`, `youtube_deeplink`, `day_label`, `video_title`) preserved or renamed-only on `source_video_id`. FE chat-section continues to work.
- BE emits IDs + anchor fragments for internal navigation. FE composes `` `/talks/${c.talk_id}${c.transcript_anchor}` ``. External URLs (YouTube) are fully resolved.
- Citations ordered by first appearance in answer. Deduplicated by `(chunk_id ?? talk_id)`.

## Conversation memory

**FE owns conversation state.** Each request sends the full history; BE is stateless. When auth lands, a `GET /qa/history` can hydrate; the request contract stays the same.

**History stripping inside the runner:**
- Prior assistants' `tool_use` blocks and prior users' `tool_result` blocks are NOT sent to Claude on subsequent turns. Only final assistant text from each prior turn is retained.
- Rationale: a `synthesize_across_talks` result can be 8k tokens; preserving all prior tool_results inflates the prompt 5–10× per turn for limited benefit.
- Tradeoff: Claude must re-fetch evidence for follow-ups. The system prompt makes this explicit ("Prior tool calls are NOT available. Re-fetch when needed.").

**FE persistence guidance** (out of scope for BE, documented for FE engineer):
- Use `localStorage` with key `qa-history:v1:<series_slug | 'global'>`.
- Local cap ~50 messages; BE trims to 20 on send.
- Version key (`v1`) enables clean invalidation on schema bump.
- "Clear conversation" button; small footnote: "Conversation stays in your browser."
- Wrap writes in try/catch; on quota error, prune oldest and retry.

## Tool specifications

All tools take a `scope: Scope` argument plus tool-specific inputs. All return JSON the runner serializes to a `tool_result` content block. Output shapes designed so Claude can cite directly from them (`[chunk:<id>]` / `[talk:<id>]`).

### Tool 1 — `resolve_entity`

```ts
input:  { query: string, scope?: Scope }
output: {
  candidates: Array<{
    talk_id: string
    talk_title: string
    speaker: string
    talk_index: number
    source_video_id: string
    confidence: number      // 0–1
  }>                         // max 3
}
```

Implementation: hybrid match on `talks.title` (`pg_trgm` GIN index) + `talks.speaker` (lower(speaker) index + trigram). Scoring: `0.6 * trigram_sim(title) + 0.4 * trigram_sim(speaker)`, clamped to [0,1]. Returns empty array on no match — never throws.

### Tool 2 — `get_talk_summary`

```ts
input:  { talk_id?: string, speaker?: string, scope?: Scope }
output: {
  talks: Array<{
    talk_id: string
    talk_title: string
    speaker: string
    summary: string
    start_ms: number
    end_ms: number
    source_video_id: string
    youtube_deeplink: string
  }>                          // max 5
}
```

Reads `transcripts.summary` (precomputed by ingest pipeline). `talk_id` wins; otherwise filters by `speaker` ± scope. Cap of 5 bounds prompt size when a prolific speaker has many talks.

### Tool 3 — `search_chunks`

```ts
input: {
  query: string
  scope?: Scope
  k?: number                  // default 8, max 30
  diversify?: 'none' | 'per_talk'   // default 'none'
  mode?: 'hybrid' | 'dense'   // default 'hybrid'
}
output: {
  chunks: Array<{
    chunk_id: string
    text: string
    talk_id: string
    talk_title: string
    speaker: string
    start_ms: number
    end_ms: number
    similarity: number
    youtube_deeplink: string
  }>
}
```

Implementation: `searchChunksHybrid` SQL function (RRF over dense+FTS with k=60 then top-N). `diversify:'per_talk'` post-processes to keep highest-scoring chunk per `talk_id` (JS, cheap). `dense` mode bypasses RRF for use cases where keyword match isn't desired.

### Tool 4 — `synthesize_across_talks`

```ts
input:  { idea: string, scope?: Scope, per_talk_k?: number /* default 3 */ }
output: {
  per_talk_evidence: Array<{
    talk_id: string
    talk_title: string
    speaker: string
    relevance: number
    evidence_chunks: Array<{ chunk_id, text, start_ms, youtube_deeplink }>
    mini_summary: string      // ≤2 sentences, haiku-generated, grounded in evidence
  }>                          // max 8 talks
  talks_considered: number
  talks_returned: number
}
```

Implementation: hybrid retrieval k=60, group by `talk_id`, keep top-8 by max chunk similarity, take top-`per_talk_k` chunks per talk, run a small parallel `messages.create` (Haiku 4.5) per talk to produce the mini-summary grounded in that talk's evidence. Outer Claude does the reduce in its final answer. Per-call cost: ~$0.01.

### Tool 5 — `get_overview`

```ts
input:  { scope?: Scope }
output: {
  videos: Array<{
    source_video_id: string
    video_title: string
    day_label: string | null
    series_slug: string | null
    faqs: Array<{ question: string, answer: string }>
    talks: Array<{
      talk_id, talk_title, speaker, summary,
      start_ms, end_ms, youtube_deeplink
    }>
  }>
}
```

Zero LLM calls. Pure SQL join. For one 9hr video this is ~20 summaries + ~6 FAQs ≈ 4k tokens.

### Tool 6 — `get_metadata`

```ts
input:  { scope?: Scope }
output: {
  total_videos: number
  total_talks: number
  total_duration_seconds: number
  series_slugs: string[]
  day_labels: string[]
  speakers: string[]
  talks: Array<{
    talk_id, talk_title, speaker, talk_index,
    start_ms, end_ms, day_label
  }>
}
```

Pure SQL aggregations. No chunk retrieval.

## Loop runner

`src/services/qa-tools/runner.ts`. Single function:

```ts
async function runToolLoop(opts: {
  messages: ChatMessage[]
  scope: Scope
  tools: ToolRegistry
  llm: ILLMService
  budget: {
    maxIterations: 5
    maxWallMs: 20_000
    maxToolResultTokens: 15_000
  }
}): Promise<{
  answer: string
  toolTrace: ToolCall[]
  reachedBudgetCap: boolean
  partial: boolean
}>
```

**Algorithm:**

1. Strip prior turns: keep only final assistant text per prior assistant message.
2. Build initial `messages.create` request: static system prompt, six tools, `tool_choice:'auto'`, full history + current user turn.
3. For `i = 1..maxIterations`:
   - Issue `messages.create` (wrapped in `withRetry`).
   - If `stop_reason === 'end_turn'`: join text blocks, return.
   - If `stop_reason === 'tool_use'`:
     - Extract tool_use blocks.
     - Execute in parallel via `Promise.all`, each with the shared `ToolContext` (pool, embeddings, llm, scope, signal).
     - Truncate any tool_result whose estimated tokens exceed `maxToolResultTokens` (char-count / 4 heuristic — close enough; Anthropic's token counter API is not on the hot path); append `"...[truncated]"` footer.
     - Append assistant message (raw `resp.content`) and user message (`tool_result` blocks) to messages.
     - Continue.
4. Iteration cap reached: one more `messages.create` with `tool_choice:'none'` to force a final text. Return with `reachedBudgetCap:true`.

**Wall-clock budget:** `AbortController` shared across all Claude calls and tool executions. On timeout: short-circuit to step 4.

**Tool error policy:** a thrown tool execution becomes `tool_result: {error: '<msg>'}` — never propagates. Loop sets `partial:true`.

**Parallelism:** Claude often emits 2–3 simultaneous tool_uses (e.g., "X vs Y" → two `search_chunks` calls). `Promise.all` runs them concurrently.

## System prompt

```
You answer questions about conference talks using ONLY tools and tool results.

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

Brevity: match the question's specificity. No padding.
```

## Citation validator

`src/services/qa-tools/citation-validator.ts`:

1. Collect the set of valid IDs returned by any tool this turn (chunk_ids and talk_ids).
2. Scan `answer` for `[chunk:<uuid>]` and `[talk:<uuid>]` markers.
3. For each marker:
   - If ID is in the valid set: assign a numbered index by first appearance; rewrite marker to `[N]`.
   - If not: delete the marker text; log `qa.invalid_citation_stripped`.
4. Build the `citations[]` array in numbered order, joining IDs to talk/video metadata using the data already collected from tool results (no new DB queries).
5. Deduplicate: same `(chunk_id ?? talk_id)` collapses to a single citation entry; multiple `[N]`s in the answer can point to the same citation.

## Database changes

### Migration `004_qa_upgrade.sql`

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

-- Replace match_chunks (no backward-compat shim — see §11)
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

### TypeScript queries (`src/db/queries.ts`)

| Function | Signature |
|---|---|
| `resolveEntities` | `(pool, query, scope) → Candidate[]` |
| `getTalkSummaries` | `(pool, {talk_id?, speaker?, scope}) → TalkSummary[]` |
| `searchChunksHybrid` | `(pool, query, embedding, scope, {k}) → ChunkHit[]` |
| `getOverview` | `(pool, scope) → Overview` |
| `getMetadata` | `(pool, scope) → Metadata` |
| `matchChunks` | `(pool, embedding, k, scope) → ChunkHit[]` *(rewritten signature)* |

## Error handling

| Failure | Status | Body | Logged |
|---|---|---|---|
| Body validation (missing/empty messages, last not user, malformed scope, >100 messages) | 400 | `{error, detail}` | warn |
| Scope yields zero rows everywhere | 200 | `{answer:'No content matches your scope.', citations:[], partial:false}` | info |
| Tool throws | 200 | `{answer, citations, partial:true}` | warn per tool |
| Embedding service down | 200 | partial answer or "couldn't search right now" | error |
| DB unavailable | 200 | `{answer:'service temporarily unavailable', partial:true}` | error |
| Anthropic call fails after retries | 502 | `{error:'llm_unavailable'}` | error |
| Loop hits iteration or wall-clock cap | 200 | `{answer, citations, partial:true, reached_cap:true}` | warn |
| Claude cites invalid ID | (silent) | marker stripped from answer | warn per stripped marker |

500 is reserved for unexpected exceptions only. Every known failure shape returns a 200 with degraded payload.

## Observability

One structured log line per request on completion:

```json
{
  "event": "qa.complete",
  "request_id": "<uuid>",
  "scope": {"series_slug": "...", "source_video_id": "...", "talk_id": "...", "speaker": "..."},
  "history_messages": 4,
  "loop_iterations": 2,
  "tool_calls": [
    {"tool": "resolve_entity", "duration_ms": 45, "ok": true},
    {"tool": "search_chunks", "duration_ms": 180, "ok": true, "result_chunks": 8}
  ],
  "total_wall_ms": 3420,
  "partial": false,
  "reached_cap": false,
  "invalid_citations_stripped": 0,
  "answer_chars": 612,
  "citations_returned": 5
}
```

No question text at info level (PII boundary). Debug level can include it for local development.

## Testing strategy (TDD)

### Unit (vitest, no DB)

| File | Coverage |
|---|---|
| `tests/unit/qa-runner.test.ts` | end_turn termination; iteration cap → force-final; parallel tool execution; tool failure becomes `tool_result.error`; wall-clock timeout; truncation footer |
| `tests/unit/qa-citation-validator.test.ts` | strip invalid; rewrite valid to `[N]`; first-appearance ordering; dedupe; zero-citation answer |
| `tests/unit/qa-scope.test.ts` | precedence; UUID validation; SQL param serialization |
| `tests/unit/qa-tools/resolve-entity.test.ts` | input shape; output shape; mock pool |
| `tests/unit/qa-tools/get-talk-summary.test.ts` | input shape; output shape; cap of 5 |
| `tests/unit/qa-tools/search-chunks.test.ts` | input shape; `diversify:'per_talk'` post-processing |
| `tests/unit/qa-tools/synthesize-across-talks.test.ts` | grouping by talk_id; haiku call count; cap of 8 talks |
| `tests/unit/qa-tools/get-overview.test.ts` | shape |
| `tests/unit/qa-tools/get-metadata.test.ts` | aggregation counts |

Mock: `tests/mocks/anthropic.mock.ts` — `FakeAnthropic` with scripted response sequences (tool_use sequences, end_turn responses, errors).

### Integration (vitest + Docker Postgres)

| File | Coverage |
|---|---|
| `tests/integration/qa-resolve-entity.test.ts` | trigram fuzzy match; typo tolerance; speaker partial match |
| `tests/integration/qa-search-hybrid.test.ts` | RRF beats dense-only on keyword queries; `diversify:'per_talk'` returns ≤1 per talk; all four scope filters narrow correctly |
| `tests/integration/qa-overview.test.ts` | 2 videos, same series_slug → joined correctly |
| `tests/integration/qa-metadata.test.ts` | counts, distinct speakers, distinct day_labels |
| `tests/integration/qa-synthesize.test.ts` | map-reduce grouping (mock LLM for mini-summaries) |
| `tests/integration/qa-route.test.ts` (replaces `tests/routes/qa.test.ts`) | end-to-end with scripted mock LLM: (a) `get_talk_summary` path; (b) `resolve_entity → search_chunks` path; (c) loop cap force-final; (d) `messages:[]` → 400; (e) multi-turn → prior tool_results NOT sent to mock LLM |

### Manual verification (one-shot, prod)

After deploy and 9hr video ingest:

- [ ] Type 1: "what is the main idea of the Daytona talk?" → cites talk summary; YouTube link works.
- [ ] Type 2: "which talks discuss evaluation?" → ≥2 distinct talks.
- [ ] Type 3: "what conclusions about agents across the conference?" → per-talk evidence synthesis.
- [ ] Type 4: "summarize the conference" / "top 10 ideas" → grounded in FAQs/summaries.
- [ ] Type 5: speaker-scoped question → returns their talks.
- [ ] Type 11: "how many talks?" → exact integer.
- [ ] Follow-up: "tell me more about the second one" → references prior turn.
- [ ] Citation click → YouTube opens at correct timestamp.
- [ ] Transcript anchor → `/talks/[id]` loads (when FE wires it).

## File / phasing plan

### Commit order

1. **Migration 004** — schema first. Verify migrations test still green.
2. **DB query layer** — five new helpers + replaced `matchChunks`. Integration tests per helper.
3. **Scope + citation validator** — pure functions, unit tests.
4. **Tools, six commits** — order: metadata → overview → talk_summary → search_chunks → resolve_entity → synthesize. Each with unit + integration tests.
5. **Runner + FakeAnthropic mock** — unit tests with scripted sequences.
6. **Route swap** — new `qa.ts`, new test file replaces old. Delete `answerQuestion` from `llm.ts` and `interfaces/llm.ts`.
7. **Manual verification** on prod after parallel ingest session lands the 9hr video.

### Coordination with parallel ingest session

Reviewed `docs/superpowers/specs/2026-05-25-9hour-parse-critical-fixes-design.md`. Single shared file: `src/services/llm.ts`.

- Ingest wraps the private `invoke()` with `withRetry`.
- QA adds a new method `runToolLoop` that calls `client.messages.create` directly (multi-turn, tools-enabled — different shape from `invoke`), wrapping each call site explicitly in `withRetry`.
- No blocking dependency. Whoever merges second does the trivial rebase: ensure QA's `runToolLoop` Claude calls are wrapped consistently with `withRetry`.
- All other ingest changes (transcribe poll timeout, segment validator, pg-boss `retryLimit`, embedding/assemblyai wrap) are orthogonal — QA picks them up as free wins (resilient embedding for query, resilient Anthropic for outer + haiku calls).

## Tuning knobs — every hardcoded constant in one place

For future optimization. Each row: current value, where it lives, why it was chosen, when to revisit.

| Knob | Value | Where | Reason | Revisit when |
|---|---|---|---|---|
| `maxIterations` (loop) | 5 | `runner.ts` budget | Cross-talk + comparative plausibly needs 3–4; 5 leaves slack | Observed `reached_cap:true` >5% of requests |
| `maxWallMs` (loop) | 20,000 | `runner.ts` budget | Type 3 worst-case ~5s; 20s = 4× safety | P95 wall-clock approaches 15s |
| `maxToolResultTokens` (loop) | 15,000 | `runner.ts` budget | `get_overview` for one 9hr video ~4k; 15k = 3–4× safety | More than one video in `get_overview`; sustained truncation |
| `MAX_HISTORY_MESSAGES` (request trim) | 20 | route validation | Multi-turn UX fine at 20; bigger inflates prompt cost | Auth + persistence add long sessions |
| `MAX_HISTORY_TOKENS` (request trim) | 30,000 | route validation | ~40% of Sonnet's input budget reserved for history | Same |
| `REQUEST_MESSAGES_HARD_CAP` | 100 | route validation | Abuse guard | — |
| `get_talk_summary` result cap | 5 talks | tool 2 | Prompt-size cap; prolific speaker edge | Speaker scope returns >5 useful talks regularly |
| `search_chunks` default `k` | 8 | tool 3 | Today's `/qa` default — preserves baseline behavior | Recall@k measurements show shortfall |
| `search_chunks` max `k` | 30 | tool 3 | Prompt-size ceiling (~15k tokens of text) | Same |
| Hybrid candidate pool | least(k * 3, 90) | `search_chunks_hybrid` SQL | Standard RRF candidate ratio with abuse-guard ceiling | Recall improves on larger pool |
| RRF constant | 60 | `search_chunks_hybrid` | Industry-standard RRF k | A/B tested alternatives show win |
| `synthesize_across_talks` candidate pool | k=60 (chunks) | tool 4 | Enough to cover 20-talk video | More talks per call needed |
| `synthesize_across_talks` max talks returned | 8 | tool 4 | Prompt-size + cost cap | Synthesis quality regression at 8 |
| `synthesize_across_talks` default `per_talk_k` | 3 chunks | tool 4 | Evidence breadth without bloat | Mini-summaries too thin |
| `synthesize_across_talks` mini-summary length | ≤2 sentences | tool 4 prompt | Concise enough to keep outer prompt manageable | Outer answer needs more nuance |
| Haiku model for mini-summaries | `claude-haiku-4-5-20251001` | tool 4 | Cost-effective; quality sufficient | Quality concerns surface |
| Outer Claude model | `claude-sonnet-4-6` | `llm.ts` MODEL | Existing project default | Anthropic releases better/cheaper |
| Resolver candidates | 3 | tool 1 | Claude picks among small set | Disambiguation fails regularly |
| Resolver scoring weights | title 0.6 / speaker 0.4 | tool 1 | Title is the more distinctive | Empirical resolver miss rate |
| `pg_trgm` similarity threshold | default (≥0.3 in `similarity()`) | tool 1 SQL | Trigram default; permissive | False positives observed |
| Embedding model | `text-embedding-3-small` (1536d) | `embeddings.ts` | Existing project default | Recall regression vs. larger model |
| Embedding batch size | 128 | `embeddings.ts` | Existing project default | OpenAI rate-limit issues |
| HNSW `m` | 16 | migration 001 | pgvector default | Chunk count >100k |
| HNSW `ef_construction` | 64 | migration 001 | Build-time tradeoff | Same |
| HNSW `ef_search` | unset (default 40) | runtime | pgvector default | Recall regression at scale |
| Rate limit | 10 / hour per IP | `qa.ts` route config | Demo phase guard | Auth lands; users complain |
| Anthropic max_tokens (existing) | 2048 (answer) | `llm.ts` invoke | Today's setting | Truncated answers observed |
| Citation marker format | `[chunk:<uuid>]` / `[talk:<uuid>]` → `[N]` | validator + system prompt | Numbered easier for FE | FE wants per-citation rich attribution |
| Tool result truncation footer | `"...[truncated]"` | runner | Visible to Claude for awareness | — |
| FE `localStorage` cap | 50 messages | (FE) | UX choice; safely under quota | Persistence pattern changes |
| FE `localStorage` key version | `v1` | (FE) | Bump on schema change | Schema bump |

## Risks accepted (documented, not mitigated)

- **History stripping loses continuity.** If Claude needs the same evidence two turns running, it re-fetches. Cost: ~$0.01 extra per follow-up; latency: ~200ms. Acceptable vs. 5–10× prompt inflation.
- **Hardcoded 9hr-video defaults.** Several knobs (max talks=8 in synthesize, cap 5 in talk_summary) are tuned for a 20-talk corpus. Multi-day conferences with 60+ talks may need re-tuning — recorded in tuning-knobs table.
- **Single-tenant rate limit.** 10/hr is wrong for multi-user but right for demo.
- **No reranker.** Hybrid RRF alone; precision degrades past ~5k chunks. Recorded.
- **No prompt caching.** Repeat-traffic cost win deferred until productization justifies.
- **No streaming.** Multi-turn loop pushes P95 to 4–6s; demo UX accepts.
- **Mock LLM tests don't exercise real Claude tool-use behavior.** Schema correctness is asserted, but actual model judgment is verified only via manual prod checks. Same risk profile as existing tests.

## Summary of file changes

| File | Change |
|---|---|
| `src/db/migrations/004_qa_upgrade.sql` | **NEW** — `pg_trgm`, `series_slug`, indexes, replace `match_chunks`, add `search_chunks_hybrid` |
| `src/db/queries.ts` | Add `resolveEntities`, `getTalkSummaries`, `searchChunksHybrid`, `getOverview`, `getMetadata`; rewrite `matchChunks` signature |
| `src/services/qa-scope.ts` | **NEW** |
| `src/services/qa-tools/runner.ts` | **NEW** |
| `src/services/qa-tools/citation-validator.ts` | **NEW** |
| `src/services/qa-tools/system-prompt.ts` | **NEW** |
| `src/services/qa-tools/index.ts` | **NEW** — registry |
| `src/services/qa-tools/resolve-entity.ts` | **NEW** |
| `src/services/qa-tools/get-talk-summary.ts` | **NEW** |
| `src/services/qa-tools/search-chunks.ts` | **NEW** |
| `src/services/qa-tools/synthesize-across-talks.ts` | **NEW** |
| `src/services/qa-tools/get-overview.ts` | **NEW** |
| `src/services/qa-tools/get-metadata.ts` | **NEW** |
| `src/services/llm.ts` | Add `runToolLoop`; delete `answerQuestion` |
| `src/interfaces/llm.ts` | Mirror change |
| `src/routes/qa.ts` | Rewrite — slim route over runner |
| `src/routes/search.ts` | Adapt to new `matchChunks` signature |
| `tests/unit/qa-*.test.ts` | **NEW** (3 files) |
| `tests/unit/qa-tools/*.test.ts` | **NEW** (6 files) |
| `tests/integration/qa-*.test.ts` | **NEW** (6 files) |
| `tests/routes/qa.test.ts` | Deleted; replaced by `tests/integration/qa-route.test.ts` |
| `tests/mocks/llm.mock.ts` | Add `runToolLoop` scripted method; remove `answerQuestion` |
| `tests/mocks/anthropic.mock.ts` | **NEW** — `FakeAnthropic` with scripted tool-use sequences |

No FE changes. No worker changes. No `server.ts` changes.
