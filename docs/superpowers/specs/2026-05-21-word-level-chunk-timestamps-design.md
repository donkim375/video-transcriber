# Word-Level Chunk Timestamps — Design Spec

## Overview

Follow-up to `2026-05-20-segmentation-and-chunk-timestamps-spec.md`. That change wired utterance-level timestamps from AssemblyAI through into `chunks.start_ms`/`end_ms`, but left a known limitation: every sentence within a single AssemblyAI utterance inherits the same span. For monologue content (the `single_speaker` content type) AssemblyAI frequently returns the entire video as one utterance, collapsing every chunk to the same `(start_ms, end_ms)` pair and breaking deep-linking — search results jump to the start of the whole transcript regardless of where the match actually appears.

AssemblyAI already returns word-level timestamps inside `utterance.words[]` (and at the top-level `words[]`) on every transcript response, paid-for but discarded by the current pipeline. This spec rewires the chunker to compute per-sentence spans from those word timestamps, applying uniformly to every `content_type`.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Precision target | Per-sentence | Search results consume one timestamp per chunk for deep-linking; per-word precision adds payload and storage without a clear UI payoff |
| Scope | Universal (all `content_type` values) | The fix is mode-agnostic — every mode funnels through `chunkUtterances`. Conferences benefit too: long single-speaker utterances inside a conference talk no longer collapse |
| Sentence source of truth | `utterance.text` split by existing `SENTENCE_RE` | Reuses tested logic; only the *timestamp source* changes |
| Span derivation | Align sentence tokens against `utterance.words[]`, take first word's `start` and last word's `end` | Forgiving token alignment handles AssemblyAI's text/word punctuation drift |
| Alignment failure handling | Fall back to `(utterance.startMs, utterance.endMs)` | Preserves today's behavior — no regression — and keeps the change non-fatal under SDK surprises |
| `Utterance.words` field | Optional | Existing fixtures, mocks, and tests stay compiling; absence triggers the same fallback as alignment failure |
| Existing data | Forward-only | Production volume is small; affected videos can be re-submitted. No backfill migration |
| Persistence | None | All work is in-memory between AssemblyAI fetch and `insertChunk`; existing `chunks.start_ms`/`end_ms` columns are sufficient |

---

## Stack Changes

No new dependencies. The AssemblyAI SDK already surfaces `TranscriptUtterance.words: TranscriptWord[]` (`node_modules/assemblyai/dist/types/openapi.generated.d.ts:3586`) on every transcript.

---

## Database

No schema change. `chunks.start_ms` and `chunks.end_ms` columns exist from the prior migration and are already being populated; only their *values* become more precise.

---

## Type System

`src/types/index.ts`:

```ts
export interface Word {
  text: string
  startMs: number
  endMs: number
}

export interface Utterance {
  speaker: string
  text: string
  startMs: number
  endMs: number
  words?: Word[]   // NEW — optional for back-compat with existing mocks/fixtures
}
```

`Word` is a public type (exported) so chunker tests can import it cleanly. The field is `words` (plural), matching AssemblyAI's casing.

---

## AssemblyAI Service Change

`src/services/assemblyai.ts` — inside `getResult`, when mapping `t.utterances`, also pluck `u.words`:

```ts
const utterances = (t.utterances ?? []).map((u: any) => ({
  speaker: String(u.speaker ?? ''),
  text: String(u.text ?? ''),
  startMs: Number(u.start ?? 0),
  endMs: Number(u.end ?? 0),
  words: Array.isArray(u.words)
    ? u.words.map((w: any) => ({
        text: String(w.text ?? ''),
        startMs: Number(w.start ?? 0),
        endMs: Number(w.end ?? 0),
      }))
    : undefined,
}))
```

If AssemblyAI returns an utterance without `words` (vanishingly rare with the universal model, but possible with legacy models), the field is left `undefined` and the chunker falls back. The `ClientLike` shim type need not change — `words` is read from the SDK's already-typed response.

---

## Chunker Change

`src/services/chunker.ts` adds a private helper and modifies `chunkUtterances`:

```ts
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface AlignResult { startMs: number; endMs: number; nextCursor: number }

function alignSentenceToWords(
  sentence: string,
  words: Word[],
  cursor: number,
): AlignResult | null {
  const sentenceTokens = sentence.split(/\s+/).map(normalize).filter(Boolean)
  if (sentenceTokens.length === 0 || cursor >= words.length) return null

  let startMs: number | null = null
  let endMs: number | null = null
  let matched = 0
  let i = cursor

  while (i < words.length && matched < sentenceTokens.length) {
    const w = normalize(words[i]!.text)
    if (w && w === sentenceTokens[matched]) {
      if (startMs === null) startMs = words[i]!.startMs
      endMs = words[i]!.endMs
      matched++
    }
    i++
  }

  // Require at least 50% of sentence tokens to have matched — otherwise the
  // alignment is unreliable and the caller should fall back to the utterance span.
  if (startMs === null || endMs === null) return null
  if (matched * 2 < sentenceTokens.length) return null

  return { startMs, endMs, nextCursor: i }
}
```

`chunkUtterances` walks each utterance's sentences with a shared per-utterance word cursor:

```ts
export function chunkUtterances(utterances: Utterance[], opts: ChunkOptions): TimedChunk[] {
  const enc = encoding_for_model('text-embedding-3-small')
  const countTokens = (s: string) => enc.encode(s).length
  try {
    const items: TimedSentence[] = []
    for (const u of utterances) {
      const sentences = splitSentences(u.text)
      let cursor = 0
      for (const s of sentences) {
        let startMs = u.startMs
        let endMs = u.endMs
        if (u.words && u.words.length > 0) {
          const aligned = alignSentenceToWords(s, u.words, cursor)
          if (aligned) {
            startMs = aligned.startMs
            endMs = aligned.endMs
            cursor = aligned.nextCursor
          }
        }
        items.push({ text: s, tokens: countTokens(s), startMs, endMs })
      }
    }
    return accumulate(items, opts)
  } finally {
    enc.free()
  }
}
```

The `accumulate` function is unchanged — chunk-level min/max-over-sentences logic still works, it just receives more granular sentence spans.

**Behavior summary:**
- Utterance with `words[]` and aligning sentences → per-sentence spans.
- Utterance with `words[]` but a sentence fails alignment (< 50% match) → that sentence falls back to utterance span; subsequent sentences continue from `cursor` unchanged.
- Utterance without `words[]` → all sentences fall back to utterance span (today's behavior, unchanged).

---

## Pipeline Wiring

No change. `runSegment`, `runEmbed`, and `pipeline.worker.ts` pass `Utterance[]` through unchanged — the new `words` field rides along because the `Utterance` interface was extended, not replaced.

---

## API

No change. `POST /videos`, `GET /videos/:id`, and `POST /search` shapes are identical. Search responses surface the same `start_ms`/`end_ms` fields with more precise values.

---

## Test Updates

New fixture `tests/fixtures/utterances-with-words.ts`:

```ts
import type { Utterance } from '../../src/types/index.js'

// Three sentences across two utterances, each word with a distinct start/end.
// Designed so chunker tests can assert per-sentence spans without ambiguity.
export const utterancesWithWords: Utterance[] = [
  {
    speaker: 'A',
    text: 'Hello world. This is a test.',
    startMs: 0,
    endMs: 4000,
    words: [
      { text: 'Hello',  startMs: 0,    endMs: 500 },
      { text: 'world.', startMs: 500,  endMs: 1000 },
      { text: 'This',   startMs: 1500, endMs: 2000 },
      { text: 'is',     startMs: 2000, endMs: 2300 },
      { text: 'a',      startMs: 2300, endMs: 2500 },
      { text: 'test.',  startMs: 2500, endMs: 4000 },
    ],
  },
  {
    speaker: 'A',
    text: 'Another sentence here.',
    startMs: 5000,
    endMs: 7000,
    words: [
      { text: 'Another',  startMs: 5000, endMs: 5800 },
      { text: 'sentence', startMs: 5800, endMs: 6500 },
      { text: 'here.',    startMs: 6500, endMs: 7000 },
    ],
  },
]
```

New unit tests in `tests/unit/chunker.test.ts`:

1. **`chunkUtterances` with `words` — per-sentence precision.**
   With a small `targetTokens` value that forces each sentence into its own chunk, assert:
   - chunk for "Hello world." → `startMs=0`, `endMs=1000` (under the old behavior this would be `(0, 4000)` — the utterance span)
   - chunk for "This is a test." → `startMs=1500`, `endMs=4000` (under the old behavior this would also be `(0, 4000)`)
   - chunk for "Another sentence here." → `startMs=5000`, `endMs=7000`

   The first two chunks are the meaningful regression assertions; the third happens to span the whole second utterance either way.
2. **`chunkUtterances` without `words` — fallback preserved.**
   Same input shape but `words` field omitted: every sentence's span equals its parent utterance's span. Asserts back-compat.
3. **Alignment robustness — punctuation, contractions, numbers.**
   Sentence `"It's 3.14 percent."` aligned against word array `[{text: "It's"}, {text: "3.14"}, {text: "percent."}]` — alignment succeeds, all three tokens matched after normalization.
4. **Alignment failure — fallback per sentence, not per utterance.**
   Sentence that shares no tokens with the words array → that single sentence falls back to utterance span; subsequent sentences in the same utterance still align. Verifies the cursor advances correctly and one bad sentence doesn't poison the rest.

No changes to existing unit tests in `chunker.test.ts` — they use fixtures without `words[]`, exercising the fallback path which is unchanged.

No changes to `tests/integration/pipeline-embed.test.ts` — its assertion is "chunk timestamps are non-null," which still holds. The integration suite continues to pass without modification.

No changes to `tests/unit/segmentation.test.ts` or `tests/routes/videos.test.ts`.

---

## Files Touched

| Layer | File | Change |
|---|---|---|
| Types | `src/types/index.ts` | Add `Word` interface; add optional `words` to `Utterance` |
| Service: AssemblyAI | `src/services/assemblyai.ts` | Pluck `u.words` in `getResult` mapping |
| Service: chunker | `src/services/chunker.ts` | Add `normalize` + `alignSentenceToWords` helpers; consume words in `chunkUtterances` |
| Tests | `tests/fixtures/utterances-with-words.ts` | New fixture |
| Tests | `tests/unit/chunker.test.ts` | Four new cases (with-words, without-words fallback, robustness, per-sentence failure) |

---

## Verification

```bash
npx tsc --noEmit                                           # type-clean
npm test                                                    # unit + route (existing 70/70 + 4 new)
npx vitest run --config vitest.integration.config.ts        # integration suite
```

End-to-end retest: follow `docs/e2e-retest-guide.md`. The single-utterance regression case (Tejas Kumar's "Harnesses in AI" monologue, `https://www.youtube.com/watch?v=C_GG5g38vLU`) should now show `distinct_spans > 1` in the chunks query.

---

## Future Work

- **Per-word offsets in search response.** If a future UI wants to highlight or scrub within a chunk, expose word-level offsets via a new search field. Out of scope here.
- **Backfill script.** A re-process command for legacy videos with collapsed spans, if production volume grows past the point where manual re-submits work.
