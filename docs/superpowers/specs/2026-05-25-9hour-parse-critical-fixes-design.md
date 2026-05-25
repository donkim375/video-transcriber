# 9-Hour Conference Parse — Critical Fixes Design

**Date:** 2026-05-25
**Scope:** One-shot manual parse of a 9-hour, chapter-tagged conference video on prod Railway. Not a productization.
**Assumption set:**
- Source video has YouTube chapter markers (confirmed by operator).
- Deployment target is prod Railway with `YOUTUBE_COOKIES_B64` set; cookies are assumed to work.
- Operator falls back to manual audio upload if cookies fail (out of scope for this design).

## Problem

The existing pipeline (see `docs/superpowers/specs/` history and `src/workers/pipeline.worker.ts`) was built for short conference talks. For a 9-hour input, three known failure modes exist today:

1. **Transcription poll timeout is 30 min, hardcoded** (`src/workers/steps/transcribe.ts:22`). AssemblyAI universal-3-pro on 9h audio can exceed this under queue load — hard fail with no retry.
2. **No retry on transient failures** of external API calls (AssemblyAI / OpenAI embeddings / Anthropic Claude). One 429 mid-pipeline kills the job *after* the operator has burned $6–10 of transcription cost.
3. **No sanity check on chapter boundaries.** If YouTube returns malformed or partial chapter data, the pipeline silently processes garbage.

## Non-goals

Explicitly out of scope (do not implement):
- Multi-tenancy / `owner_id` schema work.
- Cost guardrails, quotas, or duration caps.
- AssemblyAI webhook support (polling stays).
- Step checkpointing (`last_completed_step` column).
- Speaker-turn-aware chunking.
- LLM-driven segmentation rewrite (chapters cover the case).
- Frontend changes.
- Any retry against YouTube / yt-dlp — see Component 2 below.

## Architecture

Four surgical changes, no schema migration:

- **Component 1:** Make `pollTimeoutMs` env-configurable, default 120 min.
- **Component 2:** Add a `withRetry` helper. Wrap external API calls in AssemblyAI / OpenAI / Anthropic services **only**. Explicitly do **not** wrap `YouTubeService`.
- **Component 3:** Validate chapter-derived boundaries after `strategy.segment()`. Fail fast on malformed chapters.
- **Component 4:** Pass `retryLimit: 0` explicitly to pg-boss `send()` so the no-auto-retry guarantee is code-visible.

Data flow is unchanged from today: `download → getMetadata → transcribe (poll) → segment (chapters) → embed → summarize → FAQ`.

## Component 1 — Configurable transcription poll timeout

**Files:**
- `src/config.ts` — add `TRANSCRIPTION_POLL_TIMEOUT_MS` to the zod schema as `z.coerce.number().int().positive().default(7_200_000)` (120 min). Expose on `AppConfig` as `transcriptionPollTimeoutMs: number`.
- `src/workers/types.ts` — add `pollTimeoutMs?: number` to `PipelineDeps`.
- `src/worker.ts:23-30` — when calling `registerPipelineWorker`, pass `pollTimeoutMs: cfg.transcriptionPollTimeoutMs`.
- `src/workers/steps/transcribe.ts` — no change. Line 22 already reads `ctx.pollTimeoutMs ?? 30 * 60 * 1000`; the new value flows through automatically.

**Default rationale:** AssemblyAI universal-3-pro on 9h audio usually completes in 30–60 min; queue spikes can push past 90. 120 gives one safety margin without enabling indefinite hangs.

## Component 2 — `withRetry` helper

**New file:** `src/services/retry.ts` (~40 LOC).

**Signature:**

```typescript
export interface RetryOptions {
  attempts?: number       // default 3
  baseDelayMs?: number    // default 500
  maxDelayMs?: number     // default 10_000
  isRetryable?: (err: unknown) => boolean
  onAttempt?: (attempt: number, err: unknown) => void
  opName?: string         // for logging
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>
```

**Behavior:**
- Up to `attempts` invocations of `fn`. First call is attempt 1.
- Between attempts: sleep `random(0, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))` — full jitter exponential backoff.
- Throws the last error if all attempts fail.
- `onAttempt` (or a default logger) logs `[retry] op=<opName> attempt=N/MAX err=<message>`.

**Default `isRetryable`:**
- Returns **true** for: HTTP 429; HTTP 5xx; Node error codes `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`; messages matching `/fetch failed|socket hang up|timeout/i`.
- Returns **false** for: HTTP 4xx other than 429; `ZodError`; `TypeError`; anything thrown by our own code.

**Wrap points (3 service files; YouTubeService is intentionally excluded):**

1. `src/services/assemblyai.ts`
   - Wrap `client.files.upload(...)` (1 call site)
   - Wrap `client.transcripts.submit(...)` (1 call site)
   - Wrap `client.transcripts.get(...)` used by `getStatus` and `getResult` (2 call sites)
2. `src/services/embeddings.ts`
   - Wrap the `openai.embeddings.create(...)` call inside the batch loop (1 site).
3. `src/services/llm.ts:36`
   - Wrap `client.messages.create(...)` inside `invoke()` (1 site, covers segmentation/summarize/QA/FAQ).

**Explicit non-wrap:**
- `src/services/youtube.ts` — neither `getMetadata` nor `downloadAudio` is wrapped. Top-of-file comment documents this and points readers at this spec. Rationale: any extra YouTube hit increases bot-detection signal; the operator prefers manual intervention over automated retry against YouTube.

**Cost ceiling per call:** 3 attempts × ~10s max backoff ≈ 30s worst case. Negligible against 9h transcription wall-clock.

## Component 3 — Chapter boundary validator

**File:** `src/services/segmentation.ts` — add a new exported function:

```typescript
export interface BoundaryValidationOptions {
  audioDurationMs: number
  minCoverageRatio?: number   // default 0.95
  maxGapMs?: number           // default 120_000 (2 min)
  introMaxStartMs?: number    // default 60_000 (1 min)
}

export function validateBoundaries(
  boundaries: TalkBoundary[],
  opts: BoundaryValidationOptions,
): void
```

**Throws `Error` with a readable message naming the offending boundary index on:**
1. Empty boundary array.
2. Any `boundaries[i].endMs <= boundaries[i].startMs` (zero-or-negative duration).
3. `boundaries[i+1].startMs < boundaries[i].endMs` (overlap).
4. `boundaries[i+1].startMs - boundaries[i].endMs > maxGapMs` (large gap).
5. `boundaries[0].startMs > introMaxStartMs` (missing intro coverage).
6. `last.endMs < audioDurationMs * minCoverageRatio` (missing tail coverage).

**Call site:** `src/workers/steps/segment.ts`, immediately after `const boundaries: TalkBoundary[] = await strategy.segment(...)`:

```typescript
const audioDurationMs = input.transcription.utterances.length > 0
  ? Math.max(...input.transcription.utterances.map(u => u.endMs))
  : 0
validateBoundaries(boundaries, { audioDurationMs })
```

(Implementation can reuse `endMsFromUtterances` from `segmentation.ts:38` rather than recomputing inline.)

**Why fail fast:** embedding + summarizing junk costs ~$0.50 in LLM calls plus minutes of wall-clock, and produces a confusing chatbot afterward. Better to surface a clear error and let the operator inspect chapters.

## Component 4 — Explicit `retryLimit: 0` on pg-boss enqueue

**File:** the `enqueueJob` wiring (likely `src/server.ts` or wherever `deps.enqueueJob` is constructed; resolve at implementation time).

**Change:** when calling `boss.send(QUEUE_PIPELINE, data)`, pass `{ retryLimit: 0 }` as the third argument so pg-boss never auto-requeues the pipeline job on failure. The pg-boss default is already `0`, but making it explicit:
- Prevents an accidental future change to the default from causing repeated yt-dlp invocations against YouTube.
- Documents intent in code: "operator decides what to do on failure."

## Error surfacing

All four components surface failures through the existing path:
- Thrown error → caught at `pipeline.worker.ts:69-72` → `updateSourceVideoStatus(... 'error', msg)`.
- Operator sees the message via `GET /videos/:id/status` (`routes/videos.ts:60-64`).
- `withRetry` additionally logs each retry attempt to `console` so partial failures are visible without being silent.

## Testing (TDD per `CLAUDE.md`)

All new code is test-driven. Failing test first, then implementation.

**Unit tests (vitest):**

- `tests/unit/retry.test.ts` (new):
  - Returns success on first attempt.
  - Retries on 429, succeeds on 2nd attempt.
  - Retries on `ECONNRESET`, succeeds on 3rd attempt.
  - Does **not** retry on HTTP 400.
  - Does **not** retry on `ZodError`.
  - Throws last error after exhausting `attempts`.
  - Backoff delay stays within `[0, maxDelayMs]` bound (use deterministic RNG injection or assert via fake timers).
  - `opName` appears in the log line emitted by the default `onAttempt`.

- `tests/unit/segmentation.test.ts` (extend existing):
  - `validateBoundaries` passes on valid chapter set.
  - Throws on empty array.
  - Throws on overlap, naming the offending index.
  - Throws on >2 min gap.
  - Throws when intro starts >1 min in.
  - Throws when last `endMs` covers <95% of audio.

- `tests/unit/config.test.ts` (extend existing):
  - `TRANSCRIPTION_POLL_TIMEOUT_MS` parsed when set.
  - Defaults to `7_200_000` when unset.
  - Rejects non-positive values.

- `tests/unit/youtube-no-retry.test.ts` (new, ~10 LOC):
  - Asserts that `YouTubeService` source code contains no `withRetry(` invocation. Read `src/services/youtube.ts` via `readFileSync` and assert `!contents.includes('withRetry')`. Lightweight static guard — if a future change adds retry to yt-dlp calls, this test fails loudly with a pointer to this spec.

**Integration tests (existing, must still pass unchanged):**
- `tests/integration/pipeline-embed.test.ts`
- `tests/integration/pipeline-summarize.test.ts`
- `tests/integration/vector-search.test.ts`
- `tests/integration/pipeline.smoke.test.ts`

**Manual verification (not automated):**
- Pre-flight: run `yt-dlp --dump-json --skip-download <conference-url>` locally with the production cookie file. Confirm `chapters` field is non-empty and chapter timestamps look sane. This is a one-off, indistinguishable from any single user fetching metadata.
- Submit the URL to prod, poll `/videos/:id/status`, confirm `status` progresses through `downloading → transcribing → segmenting → embedding → summarizing → ready` and not back to `error`.

## Risks accepted (documented, not mitigated)

- **AssemblyAI itself fails permanently on a 9h file** (e.g., transcript size beyond an internal limit). Mitigation: not implemented; operator falls back to splitting the audio externally. Out of scope.
- **Cookie bot-block at yt-dlp step.** Mitigation: not implemented; operator falls back to manual audio upload. Out of scope.
- **Job-level resume after partial failure.** A failure after transcription forces re-transcription on the next manual submit. Cost ~$6–10. Accepted because retry wrappers (Component 2) cover the most likely transient failures already.
- **Concurrent jobs.** Out of scope — this design assumes a single manual run.

## Summary of file changes

| File | Change |
|---|---|
| `src/config.ts` | Add `TRANSCRIPTION_POLL_TIMEOUT_MS` env var + `transcriptionPollTimeoutMs` on `AppConfig` |
| `src/workers/types.ts` | Add `pollTimeoutMs?: number` to `PipelineDeps` |
| `src/worker.ts` | Pass `pollTimeoutMs: cfg.transcriptionPollTimeoutMs` to `registerPipelineWorker` |
| `src/services/retry.ts` | **NEW** — `withRetry` helper |
| `src/services/assemblyai.ts` | Wrap 4 SDK call sites with `withRetry` |
| `src/services/embeddings.ts` | Wrap 1 SDK call site with `withRetry` |
| `src/services/llm.ts` | Wrap 1 SDK call site (`invoke()`) with `withRetry` |
| `src/services/youtube.ts` | Add comment documenting deliberate non-wrap; no code change |
| `src/services/segmentation.ts` | Add `validateBoundaries` function |
| `src/workers/steps/segment.ts` | Call `validateBoundaries` after `strategy.segment()` |
| `src/server.ts` (or wherever `enqueueJob` lives) | Pass `{ retryLimit: 0 }` to `boss.send` |
| `tests/unit/retry.test.ts` | **NEW** |
| `tests/unit/youtube-no-retry.test.ts` | **NEW** |
| `tests/unit/segmentation.test.ts` | Extend with `validateBoundaries` cases |
| `tests/unit/config.test.ts` | Extend with new env var cases |

No migrations. No schema changes. No frontend changes.
