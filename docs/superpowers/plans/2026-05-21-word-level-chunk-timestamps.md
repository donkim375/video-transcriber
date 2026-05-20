# Word-Level Chunk Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace utterance-level sentence span inheritance with per-sentence spans derived from AssemblyAI's already-returned word timestamps, fixing the collapsed-span deep-linking bug for all `content_type` modes.

**Architecture:** Three-touch change. (1) Extend `Utterance` with an optional `words` field. (2) `AssemblyAIService.getResult` plucks `u.words` (already in the SDK response) and exposes it. (3) `chunkUtterances` aligns each sentence to a slice of its parent utterance's words and uses the first/last word's timestamps as the sentence span; falls back to the utterance span when words are absent or alignment fails. No DB migration, no API change.

**Tech Stack:** TypeScript, Vitest, tiktoken (existing), AssemblyAI SDK (existing).

**Spec:** `docs/superpowers/specs/2026-05-21-word-level-chunk-timestamps-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types/index.ts` | Add `Word` interface; extend `Utterance` with optional `words?: Word[]` |
| `src/services/assemblyai.ts` | Capture `u.words` when mapping AssemblyAI's response into `TranscriptionResult` |
| `src/services/chunker.ts` | Add `normalize` + `alignSentenceToWords` helpers; teach `chunkUtterances` to use words when present, fall back when absent |
| `tests/fixtures/utterances-with-words.ts` | New fixture: utterances populated with word-level data |
| `tests/unit/chunker.test.ts` | Four new test cases (per-sentence precision, fallback, robustness, alignment failure) |
| `tests/unit/assemblyai.test.ts` | One new test case (words pass through) |

---

### Task 1: Add `Word` type, extend `Utterance`, create with-words fixture

**Files:**
- Modify: `src/types/index.ts`
- Create: `tests/fixtures/utterances-with-words.ts`

- [ ] **Step 1: Create the fixture (will fail to compile without the new type)**

`tests/fixtures/utterances-with-words.ts`:
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

- [ ] **Step 2: Run typecheck to confirm it fails**

Run: `npx tsc --noEmit`
Expected: error in `tests/fixtures/utterances-with-words.ts` — `'words' does not exist in type 'Utterance'`.

- [ ] **Step 3: Add the type**

Edit `src/types/index.ts`. After the existing `Utterance` declaration block, replace it (keeping ordering near the other transcription types):

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
  words?: Word[]
}
```

- [ ] **Step 4: Run typecheck to confirm it passes**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 5: Run the full unit + route suite to confirm no breakage**

Run: `npm test`
Expected: all existing tests still pass (the change is purely additive; `words` is optional).

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts tests/fixtures/utterances-with-words.ts
git commit -m "feat: add Word type and optional words to Utterance"
```

---

### Task 2: Chunker — per-sentence precision (TDD)

**Files:**
- Modify: `src/services/chunker.ts`
- Test: `tests/unit/chunker.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/chunker.test.ts`, inside the existing `describe('chunkUtterances', ...)` block (just before its closing `})`):

```ts
  it('derives per-sentence spans from words when present', () => {
    const { utterancesWithWords } = require('../fixtures/utterances-with-words.js') as typeof import('../fixtures/utterances-with-words.js')
    // Tiny token budget forces each sentence into its own chunk.
    const chunks = chunkUtterances(utterancesWithWords, { targetTokens: 5, overlapTokens: 0 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ text: 'Hello world.',           startMs: 0,    endMs: 1000 })
    expect(chunks[1]).toMatchObject({ text: 'This is a test.',        startMs: 1500, endMs: 4000 })
    expect(chunks[2]).toMatchObject({ text: 'Another sentence here.', startMs: 5000, endMs: 7000 })
  })
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/unit/chunker.test.ts -t "derives per-sentence spans from words"`
Expected: FAIL — `chunks[1].startMs` is `0` (old behavior: inherits utterance.startMs), expected `1500`.

- [ ] **Step 3: Implement `normalize` + `alignSentenceToWords` in `src/services/chunker.ts`**

Open `src/services/chunker.ts`. After the `import type { Utterance } from '../types/index.js'` line, also import `Word`:

```ts
import type { Utterance, Word } from '../types/index.js'
```

After `SENTENCE_RE` and before `function splitSentences(...)`, add:

```ts
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface AlignResult {
  startMs: number
  endMs: number
  nextCursor: number
}

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

  if (startMs === null || endMs === null) return null
  // Require at least 50% of sentence tokens to have matched. Anything less is
  // likely a desync between utterance.text and utterance.words — fall back.
  if (matched * 2 < sentenceTokens.length) return null

  return { startMs, endMs, nextCursor: i }
}
```

- [ ] **Step 4: Rewrite `chunkUtterances` to use the helper**

Replace the existing `chunkUtterances` function body:

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
        let startMs: number | null = u.startMs
        let endMs: number | null = u.endMs
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

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/unit/chunker.test.ts -t "derives per-sentence spans from words"`
Expected: PASS.

- [ ] **Step 6: Run the full chunker test file to confirm no regressions**

Run: `npx vitest run tests/unit/chunker.test.ts`
Expected: all chunker tests pass (existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/services/chunker.ts tests/unit/chunker.test.ts
git commit -m "feat: chunkUtterances derives per-sentence spans from word timestamps"
```

---

### Task 3: Chunker — back-compat fallback regression test

**Files:**
- Test: `tests/unit/chunker.test.ts`

This task adds a regression test pinning the fallback path: utterances without a `words` field must still produce chunks with their utterance's span.

- [ ] **Step 1: Write the test**

Append to `tests/unit/chunker.test.ts` inside the `describe('chunkUtterances', ...)` block:

```ts
  it('falls back to utterance span when words are absent', () => {
    // Note: same fixture shape as the words case but with `words` omitted.
    const utts: Utterance[] = [
      { speaker: 'A', text: 'Hello world. This is a test.', startMs: 0,    endMs: 4000 },
      { speaker: 'A', text: 'Another sentence here.',       startMs: 5000, endMs: 7000 },
    ]
    const chunks = chunkUtterances(utts, { targetTokens: 5, overlapTokens: 0 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ text: 'Hello world.',           startMs: 0,    endMs: 4000 })
    expect(chunks[1]).toMatchObject({ text: 'This is a test.',        startMs: 0,    endMs: 4000 })
    expect(chunks[2]).toMatchObject({ text: 'Another sentence here.', startMs: 5000, endMs: 7000 })
  })
```

- [ ] **Step 2: Run the test to confirm it passes (regression protection)**

Run: `npx vitest run tests/unit/chunker.test.ts -t "falls back to utterance span when words are absent"`
Expected: PASS — Task 2's implementation already preserves the fallback path because `u.words` is undefined for these utterances.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/chunker.test.ts
git commit -m "test: pin chunker fallback when utterance has no words"
```

---

### Task 4: Chunker — alignment robustness (contractions, numbers, punctuation)

**Files:**
- Test: `tests/unit/chunker.test.ts`

Verifies that `normalize` correctly strips punctuation so contractions ("It's"), decimals ("3.14"), and trailing punctuation ("percent.") all align.

- [ ] **Step 1: Write the test**

Append to `tests/unit/chunker.test.ts` inside the `describe('chunkUtterances', ...)` block:

```ts
  it('aligns sentences containing contractions, decimals, and punctuation', () => {
    const utts: Utterance[] = [
      {
        speaker: 'A',
        text: "It's 3.14 percent.",
        startMs: 0,
        endMs: 2000,
        words: [
          { text: "It's",     startMs: 0,    endMs: 400  },
          { text: '3.14',     startMs: 400,  endMs: 1200 },
          { text: 'percent.', startMs: 1200, endMs: 2000 },
        ],
      },
    ]
    const chunks = chunkUtterances(utts, { targetTokens: 50, overlapTokens: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ startMs: 0, endMs: 2000 })
  })
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/chunker.test.ts -t "aligns sentences containing contractions"`
Expected: PASS — `normalize` strips apostrophes, decimal points, and trailing periods, leaving `"its"`, `"314"`, `"percent"` to match.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/chunker.test.ts
git commit -m "test: chunker alignment handles contractions, decimals, punctuation"
```

---

### Task 5: Chunker — per-sentence alignment failure falls back independently

**Files:**
- Test: `tests/unit/chunker.test.ts`

Verifies that when one sentence fails alignment (fewer than 50% of its tokens match the word array), only that sentence falls back to the utterance span; subsequent sentences in the same utterance still align correctly.

- [ ] **Step 1: Write the test**

Append to `tests/unit/chunker.test.ts` inside the `describe('chunkUtterances', ...)` block:

```ts
  it('falls back per-sentence on alignment failure without poisoning subsequent sentences', () => {
    // Utterance text has two sentences. The first sentence ("Foo bar baz quux.")
    // shares no tokens with the words array — alignment must fail and fall back
    // to the utterance span (0, 5000). The second sentence ("Hello world.") aligns.
    const utts: Utterance[] = [
      {
        speaker: 'A',
        text: 'Foo bar baz quux. Hello world.',
        startMs: 0,
        endMs: 5000,
        words: [
          { text: 'Hello',  startMs: 3000, endMs: 3500 },
          { text: 'world.', startMs: 3500, endMs: 5000 },
        ],
      },
    ]
    const chunks = chunkUtterances(utts, { targetTokens: 5, overlapTokens: 0 })
    expect(chunks).toHaveLength(2)
    // First sentence: alignment failed (0/4 tokens match) → fallback to utterance span.
    expect(chunks[0]).toMatchObject({ text: 'Foo bar baz quux.', startMs: 0,    endMs: 5000 })
    // Second sentence: aligned cleanly.
    expect(chunks[1]).toMatchObject({ text: 'Hello world.',      startMs: 3000, endMs: 5000 })
  })
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/chunker.test.ts -t "falls back per-sentence on alignment failure"`
Expected: PASS — `alignSentenceToWords` returns `null` for the first sentence (0% match < 50% threshold), the cursor is unchanged (`cursor = 0` for the next iteration), and the second sentence aligns from `cursor=0` finding "Hello" / "world." in the words array.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/chunker.test.ts
git commit -m "test: per-sentence alignment failure falls back independently"
```

---

### Task 6: AssemblyAI service — pluck words from the response (TDD)

**Files:**
- Modify: `src/services/assemblyai.ts`
- Test: `tests/unit/assemblyai.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/assemblyai.test.ts` inside the existing `describe('AssemblyAIService.getResult', ...)` block (just before its closing `})`):

```ts
  it('passes through utterance words when present', async () => {
    const client = makeFakeClient({
      transcripts: {
        get: vi.fn(async () => ({
          id: 'tx-1',
          status: 'completed',
          text: 'Hello world.',
          utterances: [
            {
              speaker: 'A',
              text: 'Hello world.',
              start: 0,
              end: 1000,
              words: [
                { text: 'Hello',  start: 0,   end: 500 },
                { text: 'world.', start: 500, end: 1000 },
              ],
            },
          ],
        })),
      },
    })
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.utterances[0]!.words).toEqual([
      { text: 'Hello',  startMs: 0,   endMs: 500 },
      { text: 'world.', startMs: 500, endMs: 1000 },
    ])
  })

  it('leaves words undefined when AssemblyAI omits the field', async () => {
    const client = makeFakeClient()  // default makeFakeClient returns utterances without `words`
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.utterances[0]!.words).toBeUndefined()
  })
```

- [ ] **Step 2: Run the tests to confirm the first one fails**

Run: `npx vitest run tests/unit/assemblyai.test.ts -t "passes through utterance words"`
Expected: FAIL — `result.utterances[0].words` is `undefined`, expected the mapped array.

- [ ] **Step 3: Update the AssemblyAI mapping**

Edit `src/services/assemblyai.ts`. Locate the `utterances` mapping inside `getResult` and replace it with:

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

- [ ] **Step 4: Run both new tests to confirm they pass**

Run: `npx vitest run tests/unit/assemblyai.test.ts`
Expected: all assemblyai tests pass (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/assemblyai.ts tests/unit/assemblyai.test.ts
git commit -m "feat: AssemblyAIService.getResult passes through word timestamps"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Unit + route tests**

Run: `npm test`
Expected: all green. Test counts should be the previous total + 6 new (4 chunker + 2 assemblyai).

- [ ] **Step 3: Integration tests (Docker Postgres must be up)**

Run: `npm run test:integration`
Expected: all green. No new integration tests are added by this plan — the change is contained to in-memory transformations between AssemblyAI fetch and `insertChunk`, and the existing `pipeline-embed.test.ts` assertion ("chunk timestamps are non-null") continues to hold.

- [ ] **Step 4 (optional): E2E retest**

Follow `docs/e2e-retest-guide.md` end-to-end using `https://www.youtube.com/watch?v=C_GG5g38vLU` (the regression case from the prior spec). In Step 6 (chunk timestamps query), `distinct_spans` should now be `> 1` — proof that the single-utterance collapse is fixed.

---

## Self-Review

**Spec coverage:**
- "Add `Word` interface and optional `words` on `Utterance`" → Task 1.
- "AssemblyAI service plucks `u.words`" → Task 6.
- "Normalize + alignSentenceToWords helpers" → Task 2 Step 3.
- "Rewire `chunkUtterances` to consume words with per-utterance cursor" → Task 2 Step 4.
- "Fallback when words absent / alignment fails" → Tasks 3 & 5.
- "Tests: per-sentence precision, fallback, robustness, alignment failure" → Tasks 2-5.
- "No DB / API / pipeline changes" → confirmed by absence of corresponding tasks.

**Placeholder scan:** No TODO, TBD, "implement later," or vague handwaving. Every step has exact code or exact command + expected output.

**Type consistency:**
- `Word` interface name matches across types file, chunker import, and fixture.
- Field naming `words` (plural) consistent everywhere.
- `alignSentenceToWords` signature `(sentence: string, words: Word[], cursor: number) => AlignResult | null` matches between definition (Task 2 Step 3) and call site (Task 2 Step 4).
- `AlignResult` shape `{ startMs: number; endMs: number; nextCursor: number }` consistent.
- Fixture uses `{ text, startMs, endMs }` matching `Word` interface (no `start`/`end` raw fields — those are the AssemblyAI SDK shape, mapped only inside `assemblyai.ts`).
