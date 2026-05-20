# Content-Type-Aware Segmentation + Chunk Timestamps — Design Spec

## Overview

Post-MVP improvement to the video transcription pipeline addressing two issues observed in the first production run:

1. **Over-segmentation of single-speaker content.** The chapter+LLM segmentation pipeline (designed for multi-talk conferences) split short single-speaker videos into several artificial "talks," fragmenting the search index.
2. **Null timestamps in search results.** Chunks were inserted with `start_ms = null` and `end_ms = null`, so search hits could not deep-link into the source video at the correct moment.

This spec restructures segmentation around a **strategy pattern** keyed on a user-declared `content_type`, and threads utterance-level timestamps from AssemblyAI all the way through chunking into the `chunks` table.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Segmentation dispatch | Strategy pattern on `content_type` | Future replacement with an ML classifier requires only a new `AutoStrategy` body; downstream code is untouched |
| Content types | `single_speaker`, `conference`, `podcast_interview`, `auto` | Covers our actual workload; `auto` is the future classifier hook |
| Default `content_type` | `'auto'` | Backwards-compatible: callers that omit the field get a sensible default |
| Auto strategy placeholder | Delegates to `SingleSpeakerStrategy` | Most videos we ingest are single-speaker; safer default than the conference path |
| Chunk timespan | `min(startMs)` … `max(endMs)` across the chunk's sentences | Sentences inherit utterance timestamps; chunks span their member sentences |
| Sentence → utterance mapping | Each sentence inherits the timestamps of the utterance it was split from | AssemblyAI gives utterance-level timestamps; sentence-level interpolation would be guesswork |
| API surface | New optional `content_type` field on `POST /api/videos` body | Non-breaking; existing clients keep working |
| Persistence | New column `source_videos.content_type` with CHECK constraint | Preserves the user's intent for re-runs and analytics |
| Migration policy | Additive only (`alter table ... add column if not exists`) | Safe for the existing single-table installation |

---

## Stack Changes

No new dependencies. Reuses existing tiktoken-based chunker and AssemblyAI utterance output.

---

## Database Schema Delta

New migration: `src/db/migrations/002_content_type.sql`

```sql
alter table source_videos
  add column if not exists content_type text not null default 'auto';

-- Enforce allowed values; guard makes the migration safely re-runnable.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'source_videos_content_type_check'
  ) then
    alter table source_videos
      add constraint source_videos_content_type_check
      check (content_type in ('single_speaker', 'conference', 'podcast_interview', 'auto'));
  end if;
end$$;
```

`chunks` table is unchanged — `start_ms` and `end_ms` columns already existed but were being written as `null`.

---

## Type System

`src/types/index.ts` adds:

```ts
export type ContentType = 'single_speaker' | 'conference' | 'podcast_interview' | 'auto'

export const CONTENT_TYPES: ContentType[] = [
  'single_speaker',
  'conference',
  'podcast_interview',
  'auto',
]
```

---

## Segmentation Strategy Pattern

`src/services/segmentation.ts` is rewritten around an interface:

```ts
export interface SegmentationContext {
  chapters: Chapter[]
  transcription: TranscriptionResult
  videoTitle?: string
  llm: ILLMService
}

export interface SegmentationStrategy {
  readonly name: ContentType
  segment(ctx: SegmentationContext): Promise<TalkBoundary[]>
}

export function resolveSegmentationStrategy(contentType: ContentType): SegmentationStrategy
```

A module-level `STRATEGIES: Record<ContentType, SegmentationStrategy>` registry is built once at import time; `resolveSegmentationStrategy` is a pure lookup.

### Strategies

- **`SingleSpeakerStrategy`** — Returns a single boundary spanning the entire video. `title = videoTitle ?? 'Full Talk'`, `speaker = ''`, `startMs = 0`, `endMs = max(utterance.endMs)`. No LLM call, no chapter parsing.
- **`ConferenceStrategy`** — Retains the original behaviour: if YouTube chapters are present, derive talks from chapters via `boundariesFromChapters`; otherwise call `llm.segmentTranscript(rawText)` for boundary detection.
- **`PodcastInterviewStrategy`** — Treats the whole video as a single talk (interviews don't have meaningful internal segmentation for our retrieval goals). `title = videoTitle ?? 'Episode'`.
- **`AutoStrategy`** — Heuristic placeholder for a future classifier. If `ctx.chapters.length > 0`, delegates to `ConferenceStrategy` (chapter-based segmentation); otherwise delegates to `SingleSpeakerStrategy`. Replacement plan: train a lightweight classifier on `{title, duration, chapter_count, speaker_count}` and route accordingly.

### sliceUtterancesByBoundary

Already-existing helper, unchanged. Filters `TranscriptionResult.utterances` to those falling within `[startMs, endMs)`.

---

## Chunker Changes

`src/services/chunker.ts` exposes a new utterance-aware variant:

```ts
export interface TimedChunk extends Chunk {
  startMs: number | null
  endMs: number | null
}

export function chunkUtterances(
  utterances: Utterance[],
  opts: ChunkOptions
): TimedChunk[]
```

Implementation:
1. Each utterance is split into sentences via the existing `SENTENCE_RE` regex.
2. Each sentence inherits its parent utterance's `startMs` and `endMs`.
3. The shared `accumulate(items, opts)` helper packs sentences into chunks using the same token budget + overlap logic as `chunkText`.
4. Chunk timespan: `min(startMs)` and `max(endMs)` across the chunk's sentences.

`chunkText(text, opts)` is preserved unchanged for back-compat (returns `Chunk[]` with no timestamps).

---

## Pipeline Wiring

### `PipelineJobData` (`src/queues/jobs.ts`)

```ts
export interface PipelineJobData {
  sourceVideoId: string
  youtubeUrl: string
  contentType: ContentType
}
```

### `runSegment` (`src/workers/steps/segment.ts`)

- Calls `resolveSegmentationStrategy(input.contentType ?? 'auto').segment(...)`.
- `SegmentResult.talkIds[i]` now carries `utterances: Utterance[]` (the slice of utterances for that talk) so the embed step can chunk with timestamps.

### `runEmbed` (`src/workers/steps/embed.ts`)

- Input shape: `{ talks: { talkId, transcriptId, utterances: Utterance[] }[] }`.
- Uses `chunkUtterances(...)` instead of `chunkText(...)`.
- Passes `c.startMs` and `c.endMs` from `TimedChunk` to `insertChunk` (previously hardcoded `null`).

### `pipeline.worker.ts`

Splits segment output into two views per talk:
```ts
const embedTalks = seg.talkIds.map((t) => ({
  talkId: t.talkId, transcriptId: t.transcriptId, utterances: t.utterances,
}))
const summarizeTalks = seg.talkIds.map((t) => ({
  talkId: t.talkId, transcriptId: t.transcriptId, text: t.text,
}))
```

---

## API Changes

### `POST /api/videos`

Body schema (`src/routes/videos.ts`) accepts optional `content_type`:

```ts
const Body = z.object({
  youtube_url: z.string().url(),
  content_type: z.enum(['single_speaker', 'conference', 'podcast_interview', 'auto']).optional(),
})
```

Behaviour:
- If omitted, `content_type` defaults to `'auto'`.
- Persisted on `source_videos.content_type`.
- Passed through to `PipelineJobData.contentType`.
- Echoed back in the response payload as `content_type`.

### DB Queries

`src/db/queries.ts`:
- `SourceVideoRow.content_type: ContentType` added.
- `insertSourceVideo` accepts optional `contentType` (default `'auto'`); INSERT statement includes the column.

---

## Test Updates

Already in place:
- `tests/integration/db-setup.ts` — `applyMigrations` loops over `['001_initial.sql', '002_content_type.sql']`.
- `tests/integration/pipeline-embed.test.ts` — calls `runEmbed` with `utterances` (not `text`); asserts `chunks.start_ms` and `chunks.end_ms` are non-null.
- All existing unit/route tests pass unchanged (70/70 green).

Added in this change set:
- `tests/unit/segmentation.test.ts` — extended with cases for `resolveSegmentationStrategy` (each content type returns the right `.name`), `SingleSpeakerStrategy` (one boundary spanning `[0, max(endMs)]`), `ConferenceStrategy` (chapter-based + LLM fallback), `PodcastInterviewStrategy` (single boundary, `'Episode'` fallback), and `AutoStrategy` (delegates to single-speaker behaviour).
- `tests/unit/chunker.test.ts` — extended with cases for `chunkUtterances`: chunk `startMs` is the minimum of contained utterance starts, `endMs` is the maximum, empty utterance list returns `[]`, and chunk text preserves utterance order.
- `tests/routes/videos.test.ts` — extended with cases for `POST /videos` accepting `content_type`, rejecting invalid values with 400, defaulting to `'auto'` when omitted, and echoing the value in the 201 response + passing it through to `enqueueJob`.

---

## Incidental Fix: AssemblyAI `speech_models`

The AssemblyAI SDK deprecated the singular `speech_model` field in favour of a `speech_models: string[]` array. The first production run failed with this drift. `src/services/assemblyai.ts` now passes `speech_models: ['universal-3-pro']` on submit, and the `ClientLike.transcripts.submit` shim type was widened to accept the new field. This is unrelated to segmentation/chunking but ships in the same change set because it was discovered while validating the pipeline.

---

## Files Touched

| Layer | File | Change |
|---|---|---|
| Types | `src/types/index.ts` | Add `ContentType`, `CONTENT_TYPES` |
| DB schema | `src/db/migrations/002_content_type.sql` | New migration |
| DB queries | `src/db/queries.ts` | Add `content_type` to row + insert |
| Queues | `src/queues/jobs.ts` | Add `contentType` to `PipelineJobData` |
| Service: segmentation | `src/services/segmentation.ts` | Strategy pattern, 4 strategies, resolver |
| Service: chunker | `src/services/chunker.ts` | Add `chunkUtterances` + `TimedChunk`; refactor `accumulate` |
| Service: AssemblyAI | `src/services/assemblyai.ts` | Switch to `speech_models: ['universal-3-pro']` |
| Worker step: segment | `src/workers/steps/segment.ts` | Use resolver; thread utterances into result |
| Worker step: embed | `src/workers/steps/embed.ts` | Switch to `chunkUtterances`; persist timestamps |
| Worker entrypoint | `src/workers/pipeline.worker.ts` | Split seg output into embed/summarize views |
| API | `src/routes/videos.ts` | Accept + echo `content_type` |
| Server wiring | `src/server.ts` | Typed `enqueueJob(data: PipelineJobData)` |
| Tests | `tests/integration/db-setup.ts` | Apply 002 migration |
| Tests | `tests/integration/pipeline-embed.test.ts` | Utterance-shaped input, timestamp assertions |
| Tests | `tests/unit/segmentation.test.ts` | Cases for strategies + resolver |
| Tests | `tests/unit/chunker.test.ts` | Cases for `chunkUtterances` |
| Tests | `tests/routes/videos.test.ts` | Cases for `content_type` validation + echo |

---

## Verification

```bash
npx tsc --noEmit                                                       # type-clean
npm test                                                                # 70/70 unit + route
npx vitest run --config vitest.integration.config.ts                    # integration suite
```

End-to-end verification: see "End-to-End Retest Guide" in the chat.

---

## Future Work

- **AutoStrategy ML classifier.** Train on `{title, duration, chapter_count, speaker_count}` → `ContentType`. Replace the body of `AutoStrategy.segment` with a classify-then-dispatch call.
- **PodcastInterviewStrategy.** Currently a single-boundary placeholder. A future iteration could segment on host/guest turns using speaker diarization.
- **Chunk timestamp interpolation.** Sentences within a single utterance currently share the utterance's timespan. Word-level timestamps from AssemblyAI would allow per-sentence precision.
