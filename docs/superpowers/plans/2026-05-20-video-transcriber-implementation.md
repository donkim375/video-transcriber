# YouTube Conference Transcription Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backend service that ingests YouTube conference videos, transcribes via AssemblyAI, segments into talks, embeds chunks, and exposes hybrid search + RAG Q&A APIs.

**Architecture:** Layer-first TDD. Pure logic → service interfaces + mocks → real services → DB layer (Docker Postgres) → pipeline orchestration (pg-boss) → Fastify API routes → smoke tests. Two processes (Fastify API + pg-boss worker) sharing a Supabase Postgres+pgvector DB.

**Tech Stack:** Node.js + TypeScript, Fastify, pg-boss, Supabase (Postgres+pgvector), AssemblyAI, yt-dlp, OpenAI embeddings, Anthropic Claude, Vitest, Docker (integration tests), Railway.

**Spec reference:** `docs/superpowers/specs/2026-05-20-video-transcriber-tdd-design.md`

---

## File Structure (locked in)

```
src/
  index.ts                        # Fastify server entrypoint (Layer 7)
  worker.ts                       # pg-boss worker entrypoint (Layer 6)
  config.ts                       # Env validation (Layer 1)
  db/
    client.ts                     # pg Pool singleton (Layer 5)
    migrations/001_initial.sql    # Schema (Layer 5)
  interfaces/                     # Service contracts (Layer 3)
    youtube.ts assemblyai.ts embeddings.ts llm.ts
  queues/jobs.ts                  # pg-boss types + names (Layer 6)
  routes/                         # API routes (Layer 7)
    videos.ts talks.ts search.ts qa.ts
  services/                       # Real impls (Layer 4)
    youtube.ts assemblyai.ts segmentation.ts chunker.ts
    embeddings.ts llm.ts rag.ts url-validator.ts
  workers/                        # Pipeline (Layer 6)
    pipeline.worker.ts
    steps/{download,transcribe,segment,embed,summarize}.ts
  types/index.ts                  # Shared types (Layer 3)
tests/
  unit/        # Layers 2, 3, 4
  integration/ # Layers 5, 6
  routes/      # Layer 7
  smoke/       # Layer 8
  fixtures/    # Layer 1
  mocks/       # Layer 3
```

---

## Layer 1 — Foundation

### Task 1.1: Initialize project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "video-transcriber",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "dev:worker": "tsx watch src/worker.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "docker compose -f docker-compose.test.yml up -d && vitest run --config vitest.integration.config.ts",
    "test:all": "npm test && npm run test:integration",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "assemblyai": "^4.7.0",
    "fastify": "^4.28.0",
    "openai": "^4.65.0",
    "pg": "^8.13.0",
    "pg-boss": "^10.1.0",
    "tiktoken": "^1.0.17",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
*.log
/tmp/
.DS_Store
coverage/
```

- [ ] **Step 4: Create .env.example**

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_CONNECTION_STRING=
ASSEMBLYAI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
PORT=3000
NODE_ENV=production
```

- [ ] **Step 5: Install and verify**

Run: `npm install && npx tsc --noEmit`
Expected: install succeeds; tsc passes (no source files yet — fine).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example
git commit -m "chore: initialize project scaffolding"
```

---

### Task 1.2: Vitest configs

**Files:**
- Create: `vitest.config.ts`
- Create: `vitest.integration.config.ts`

- [ ] **Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/routes/**/*.test.ts', 'tests/smoke/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
```

- [ ] **Step 2: Create vitest.integration.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
```

- [ ] **Step 3: Run unit vitest**

Run: `npx vitest run`
Expected: "No test files found" (or 0 tests). Exit 0 (vitest may exit 1 with no tests — that's OK at this point; the next layer adds tests).

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts vitest.integration.config.ts
git commit -m "chore: add vitest configs (unit + integration)"
```

---

### Task 1.3: Docker compose for integration tests

**Files:**
- Create: `docker-compose.test.yml`

- [ ] **Step 1: Create docker-compose.test.yml**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test
    ports:
      - "54329:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test -d test"]
      interval: 2s
      timeout: 5s
      retries: 15
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 2: Verify compose file is valid**

Run: `docker compose -f docker-compose.test.yml config`
Expected: prints normalized config, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.test.yml
git commit -m "chore: add docker compose for integration test postgres"
```

---

### Task 1.4: Test fixtures

**Files:**
- Create: `tests/fixtures/utterances.ts`
- Create: `tests/fixtures/chapters.ts`
- Create: `tests/fixtures/transcripts.ts`

- [ ] **Step 1: Create tests/fixtures/utterances.ts**

```typescript
import type { Utterance } from '../../src/types/index.js'

export const sampleUtterances: Utterance[] = [
  { speaker: 'A', text: 'Welcome to the conference.', startMs: 0, endMs: 2000 },
  { speaker: 'A', text: 'Our first talk is by Alice.', startMs: 2000, endMs: 5000 },
  { speaker: 'B', text: 'Thanks. Today I will discuss vectors.', startMs: 5000, endMs: 9000 },
  { speaker: 'B', text: 'Vectors are arrays of numbers.', startMs: 9000, endMs: 13000 },
  { speaker: 'A', text: 'Next up, Bob on databases.', startMs: 13000, endMs: 16000 },
  { speaker: 'C', text: 'Databases store data persistently.', startMs: 16000, endMs: 20000 },
  { speaker: 'C', text: 'Indexes make queries fast.', startMs: 20000, endMs: 24000 },
]
```

- [ ] **Step 2: Create tests/fixtures/chapters.ts**

```typescript
export const sampleChapters = [
  { title: 'Intro', startMs: 0, endMs: 5000 },
  { title: 'Alice on Vectors', startMs: 5000, endMs: 13000 },
  { title: 'Bob on Databases', startMs: 13000, endMs: 24000 },
]
```

- [ ] **Step 3: Create tests/fixtures/transcripts.ts**

```typescript
export const shortTranscript =
  'Welcome to the conference. Our first talk is by Alice. Thanks. Today I will discuss vectors. Vectors are arrays of numbers.'

export const longTranscript = Array.from({ length: 50 }, (_, i) =>
  `Sentence number ${i} discussing topic ${i % 5}.`
).join(' ')
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/
git commit -m "test: add shared fixtures (utterances, chapters, transcripts)"
```

(Note: `src/types/index.ts` does not yet exist — it will be created in Layer 3 Task 3.1. The fixtures import is intentional forward-reference. Steps below in Layer 3 verify the import resolves; this file will not be compiled until then.)

---

### Task 1.5: Foundation done-signal

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: errors about missing `../../src/types/index.js` in `tests/fixtures/utterances.ts`. That's expected at this stage; we'll resolve it in Layer 3. Note the error count and move on.

(If you prefer a passing typecheck before Layer 3, temporarily mark the `Utterance` type usage as `any` in `utterances.ts` and remove the `import type`. Otherwise the next clean typecheck is at the end of Layer 3.)

- [ ] **Step 2: Verify foundation layout**

Run: `ls -la && ls tests/fixtures/`
Expected: see `package.json`, `tsconfig.json`, `docker-compose.test.yml`, `vitest.config.ts`, `vitest.integration.config.ts`, `.env.example`, `.gitignore`, and three fixture files.

- [ ] **Step 3: Commit layer marker**

(Only commit if anything is unstaged. Otherwise skip.)

```bash
git status
```

---

## Layer 2 — Pure Logic Units

### Task 2.1: URL validator (TDD)

**Files:**
- Create: `tests/unit/url-validator.test.ts`
- Create: `src/services/url-validator.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/url-validator.test.ts
import { describe, it, expect } from 'vitest'
import { extractYouTubeId, isValidYouTubeUrl } from '../../src/services/url-validator.js'

describe('extractYouTubeId', () => {
  it('extracts id from standard watch URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts id from short youtu.be URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts id with extra query params', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ')
  })
  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeId('https://vimeo.com/12345')).toBeNull()
  })
  it('returns null for malformed input', () => {
    expect(extractYouTubeId('not a url')).toBeNull()
  })
})

describe('isValidYouTubeUrl', () => {
  it('accepts watch URL', () => {
    expect(isValidYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('rejects invalid URL', () => {
    expect(isValidYouTubeUrl('https://example.com')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/url-validator.test.ts`
Expected: FAIL — `Cannot find module '.../url-validator'`.

- [ ] **Step 3: Implement url-validator**

```typescript
// src/services/url-validator.ts
const ID_RE = /^[A-Za-z0-9_-]{11}$/

export function extractYouTubeId(input: string): string | null {
  if (typeof input !== 'string') return null
  try {
    const url = new URL(input)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1)
      return ID_RE.test(id) ? id : null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.searchParams.get('v') ?? ''
      return ID_RE.test(id) ? id : null
    }
    return null
  } catch {
    return null
  }
}

export function isValidYouTubeUrl(input: string): boolean {
  return extractYouTubeId(input) !== null
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/url-validator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/url-validator.test.ts src/services/url-validator.ts
git commit -m "feat: add YouTube URL validator/id extractor"
```

---

### Task 2.2: Chunker (TDD)

**Files:**
- Create: `tests/unit/chunker.test.ts`
- Create: `src/services/chunker.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/chunker.test.ts
import { describe, it, expect } from 'vitest'
import { chunkText } from '../../src/services/chunker.js'

describe('chunkText', () => {
  it('returns a single chunk for short input', () => {
    const chunks = chunkText('Short sentence.', { targetTokens: 400, overlapTokens: 50 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('Short sentence.')
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0)
  })

  it('splits long text into multiple chunks', () => {
    const longText = Array.from({ length: 300 }, (_, i) => `Sentence ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 100, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(140) // target + some slack for boundary
    }
  })

  it('chunks overlap by approximately overlapTokens', () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 80, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // Adjacent chunks share some text
    const a = chunks[0]!.text
    const b = chunks[1]!.text
    const tailWords = a.split(/\s+/).slice(-5)
    const headStart = b.split(/\s+/).slice(0, 30).join(' ')
    expect(tailWords.some((w) => headStart.includes(w))).toBe(true)
  })

  it('splits at sentence boundaries (no mid-sentence break)', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.'
    const chunks = chunkText(text, { targetTokens: 6, overlapTokens: 1 })
    for (const c of chunks) {
      expect(c.text.trim()).toMatch(/[.!?]$/)
    }
  })

  it('attaches sequential chunkIndex', () => {
    const longText = Array.from({ length: 100 }, (_, i) => `Sentence ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 60, overlapTokens: 10 })
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i))
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/chunker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement chunker**

```typescript
// src/services/chunker.ts
import { encoding_for_model } from 'tiktoken'

export interface Chunk {
  chunkIndex: number
  text: string
  tokenCount: number
}

export interface ChunkOptions {
  targetTokens: number
  overlapTokens: number
}

const SENTENCE_RE = /[^.!?]+[.!?]+(?:\s+|$)/g

function splitSentences(text: string): string[] {
  const matches = text.match(SENTENCE_RE)
  if (matches && matches.length > 0) return matches.map((s) => s.trim()).filter(Boolean)
  return [text.trim()].filter(Boolean)
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const enc = encoding_for_model('text-embedding-3-small')
  const countTokens = (s: string) => enc.encode(s).length

  try {
    const sentences = splitSentences(text)
    const sentencesWithTokens = sentences.map((s) => ({ text: s, tokens: countTokens(s) }))

    const chunks: Chunk[] = []
    let buffer: typeof sentencesWithTokens = []
    let bufferTokens = 0

    const flush = () => {
      if (buffer.length === 0) return
      const chunkText = buffer.map((s) => s.text).join(' ')
      chunks.push({
        chunkIndex: chunks.length,
        text: chunkText,
        tokenCount: bufferTokens,
      })
    }

    const carryOverlap = () => {
      // Take last sentences until ~overlapTokens
      const carry: typeof sentencesWithTokens = []
      let carryTokens = 0
      for (let i = buffer.length - 1; i >= 0; i--) {
        const s = buffer[i]!
        if (carryTokens + s.tokens > opts.overlapTokens && carry.length > 0) break
        carry.unshift(s)
        carryTokens += s.tokens
      }
      buffer = carry
      bufferTokens = carryTokens
    }

    for (const s of sentencesWithTokens) {
      if (bufferTokens + s.tokens > opts.targetTokens && buffer.length > 0) {
        flush()
        carryOverlap()
      }
      buffer.push(s)
      bufferTokens += s.tokens
    }
    flush()

    return chunks
  } finally {
    enc.free()
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/chunker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/chunker.test.ts src/services/chunker.ts
git commit -m "feat: add tiktoken-based chunker with sentence boundaries"
```

---

### Task 2.3: Segmentation parser (TDD)

**Files:**
- Create: `tests/unit/segmentation.test.ts`
- Create: `src/services/segmentation.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/segmentation.test.ts
import { describe, it, expect } from 'vitest'
import { boundariesFromChapters, sliceUtterancesByBoundary } from '../../src/services/segmentation.js'
import { sampleChapters } from '../fixtures/chapters.js'
import { sampleUtterances } from '../fixtures/utterances.js'

describe('boundariesFromChapters', () => {
  it('maps each chapter to a TalkBoundary', () => {
    const result = boundariesFromChapters(sampleChapters)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ title: 'Intro', startMs: 0, endMs: 5000 })
    expect(result[1]!.title).toBe('Alice on Vectors')
  })

  it('returns empty array for empty input', () => {
    expect(boundariesFromChapters([])).toEqual([])
  })

  it('parses speaker from "Title by Speaker" pattern', () => {
    const result = boundariesFromChapters([{ title: 'Vectors by Alice', startMs: 0, endMs: 1000 }])
    expect(result[0]).toMatchObject({ title: 'Vectors', speaker: 'Alice' })
  })

  it('sets empty speaker when not parseable', () => {
    const result = boundariesFromChapters([{ title: 'Intro', startMs: 0, endMs: 1000 }])
    expect(result[0]!.speaker).toBe('')
  })
})

describe('sliceUtterancesByBoundary', () => {
  it('returns utterances within [startMs, endMs)', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 5000, endMs: 13000 })
    expect(slice).toHaveLength(2)
    expect(slice[0]!.text).toBe('Thanks. Today I will discuss vectors.')
    expect(slice[1]!.text).toBe('Vectors are arrays of numbers.')
  })

  it('returns empty array when no utterances fall in range', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 100000, endMs: 200000 })
    expect(slice).toEqual([])
  })

  it('uses utterance start as inclusion criterion', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 0, endMs: 5000 })
    // Both intro utterances start before 5000ms
    expect(slice).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/segmentation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement segmentation**

```typescript
// src/services/segmentation.ts
import type { Utterance, TalkBoundary } from '../types/index.js'

export interface Chapter {
  title: string
  startMs: number
  endMs: number
}

const BY_RE = /^(.*?)\s+by\s+(.+)$/i

export function boundariesFromChapters(chapters: Chapter[]): TalkBoundary[] {
  return chapters.map((c) => {
    const match = c.title.match(BY_RE)
    if (match) {
      return { title: match[1]!.trim(), speaker: match[2]!.trim(), startMs: c.startMs, endMs: c.endMs }
    }
    return { title: c.title, speaker: '', startMs: c.startMs, endMs: c.endMs }
  })
}

export function sliceUtterancesByBoundary(utterances: Utterance[], boundary: TalkBoundary): Utterance[] {
  return utterances.filter((u) => u.startMs >= boundary.startMs && u.startMs < boundary.endMs)
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/segmentation.test.ts`
Expected: FAIL — `../types/index.js` does not exist yet. Continue to next step.

- [ ] **Step 5: Create minimal types stub**

This is the same file we'll fully populate in Layer 3 Task 3.1; we put a stub here so Layer 2 finishes clean.

```typescript
// src/types/index.ts
export interface Utterance {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export interface TalkBoundary {
  title: string
  speaker: string
  startMs: number
  endMs: number
}
```

- [ ] **Step 6: Run, expect pass**

Run: `npx vitest run tests/unit/segmentation.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests). tsc passes.

- [ ] **Step 7: Commit**

```bash
git add tests/unit/segmentation.test.ts src/services/segmentation.ts src/types/index.ts
git commit -m "feat: add chapter-based segmentation parser"
```

---

### Task 2.4: Layer 2 done-signal

- [ ] **Step 1: Run full unit suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc clean.

---

## Layer 3 — Service Contracts + Mocks

### Task 3.1: Complete core types

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add all core types**

Replace the contents of `src/types/index.ts` with:

```typescript
export interface VideoMetadata {
  title: string
  channel: string
  durationSeconds: number
  thumbnailUrl: string
  chapters: { title: string; startMs: number; endMs: number }[]
}

export interface Utterance {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export interface TranscriptionResult {
  assemblyaiId: string
  rawText: string
  utterances: Utterance[]
}

export type TranscriptionStatusValue = 'queued' | 'processing' | 'completed' | 'error'

export interface TranscriptionStatus {
  id: string
  status: TranscriptionStatusValue
  errorMessage?: string
}

export interface TalkBoundary {
  title: string
  speaker: string
  startMs: number
  endMs: number
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add complete core type definitions"
```

---

### Task 3.2: Service interfaces

**Files:**
- Create: `src/interfaces/youtube.ts`
- Create: `src/interfaces/assemblyai.ts`
- Create: `src/interfaces/embeddings.ts`
- Create: `src/interfaces/llm.ts`

- [ ] **Step 1: Create youtube interface**

```typescript
// src/interfaces/youtube.ts
import type { VideoMetadata } from '../types/index.js'

export interface IYouTubeService {
  getMetadata(url: string): Promise<VideoMetadata>
  downloadAudio(url: string, outputPath: string): Promise<void>
}
```

- [ ] **Step 2: Create assemblyai interface**

```typescript
// src/interfaces/assemblyai.ts
import type { TranscriptionResult, TranscriptionStatus } from '../types/index.js'

export interface ITranscriptionService {
  submit(audioPath: string): Promise<{ assemblyaiId: string }>
  getStatus(transcriptionId: string): Promise<TranscriptionStatus>
  getResult(transcriptionId: string): Promise<TranscriptionResult>
}
```

- [ ] **Step 3: Create embeddings interface**

```typescript
// src/interfaces/embeddings.ts
export interface IEmbeddingService {
  embed(texts: string[]): Promise<number[][]>
}
```

- [ ] **Step 4: Create llm interface**

```typescript
// src/interfaces/llm.ts
import type { TalkBoundary } from '../types/index.js'

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  answerQuestion(question: string, context: string): Promise<string>
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/
git commit -m "feat: add service contract interfaces"
```

---

### Task 3.3: Mock implementations

**Files:**
- Create: `tests/mocks/youtube.mock.ts`
- Create: `tests/mocks/assemblyai.mock.ts`
- Create: `tests/mocks/embeddings.mock.ts`
- Create: `tests/mocks/llm.mock.ts`

- [ ] **Step 1: Create youtube mock**

```typescript
// tests/mocks/youtube.mock.ts
import type { IYouTubeService } from '../../src/interfaces/youtube.js'
import type { VideoMetadata } from '../../src/types/index.js'

export class MockYouTubeService implements IYouTubeService {
  public downloads: { url: string; outputPath: string }[] = []
  constructor(private metadata: VideoMetadata) {}

  async getMetadata(_url: string): Promise<VideoMetadata> {
    return this.metadata
  }

  async downloadAudio(url: string, outputPath: string): Promise<void> {
    this.downloads.push({ url, outputPath })
  }
}
```

- [ ] **Step 2: Create assemblyai mock**

```typescript
// tests/mocks/assemblyai.mock.ts
import type { ITranscriptionService } from '../../src/interfaces/assemblyai.js'
import type { TranscriptionResult, TranscriptionStatus } from '../../src/types/index.js'

export class MockTranscriptionService implements ITranscriptionService {
  public submissions: string[] = []
  private statusByid: Record<string, TranscriptionStatus['status']> = {}

  constructor(private result: TranscriptionResult, private terminalStatus: TranscriptionStatus['status'] = 'completed') {}

  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    this.submissions.push(audioPath)
    const id = this.result.assemblyaiId
    this.statusByid[id] = 'queued'
    return { assemblyaiId: id }
  }

  async getStatus(transcriptionId: string): Promise<TranscriptionStatus> {
    this.statusByid[transcriptionId] = this.terminalStatus
    return { id: transcriptionId, status: this.terminalStatus }
  }

  async getResult(transcriptionId: string): Promise<TranscriptionResult> {
    if (transcriptionId !== this.result.assemblyaiId) {
      throw new Error(`Unknown transcription id ${transcriptionId}`)
    }
    return this.result
  }
}
```

- [ ] **Step 3: Create embeddings mock**

```typescript
// tests/mocks/embeddings.mock.ts
import type { IEmbeddingService } from '../../src/interfaces/embeddings.js'

export class MockEmbeddingService implements IEmbeddingService {
  public batches: string[][] = []
  constructor(private dimensions = 1536) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.batches.push(texts)
    return texts.map((t) => {
      const seed = t.length || 1
      return Array.from({ length: this.dimensions }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
    })
  }
}
```

- [ ] **Step 4: Create llm mock**

```typescript
// tests/mocks/llm.mock.ts
import type { ILLMService } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public answerCalls: { question: string; context: string }[] = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private answer = 'Mock answer.'
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
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/mocks/
git commit -m "test: add mock implementations of all service interfaces"
```

---

### Task 3.4: Contract tests for mocks

**Files:**
- Create: `tests/unit/mocks.test.ts`

- [ ] **Step 1: Write contract tests**

```typescript
// tests/unit/mocks.test.ts
import { describe, it, expect } from 'vitest'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

describe('MockYouTubeService', () => {
  it('returns provided metadata', async () => {
    const m = new MockYouTubeService({
      title: 'X', channel: 'C', durationSeconds: 1, thumbnailUrl: 't', chapters: [],
    })
    await expect(m.getMetadata('http://yt')).resolves.toMatchObject({ title: 'X' })
  })
  it('records downloads', async () => {
    const m = new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] })
    await m.downloadAudio('u', '/tmp/x.mp3')
    expect(m.downloads).toEqual([{ url: 'u', outputPath: '/tmp/x.mp3' }])
  })
})

describe('MockTranscriptionService', () => {
  it('submit -> getStatus completed -> getResult roundtrip', async () => {
    const m = new MockTranscriptionService({
      assemblyaiId: 'abc',
      rawText: 'hello',
      utterances: [],
    })
    const { assemblyaiId } = await m.submit('/tmp/x.mp3')
    expect(assemblyaiId).toBe('abc')
    const status = await m.getStatus('abc')
    expect(status.status).toBe('completed')
    const result = await m.getResult('abc')
    expect(result.rawText).toBe('hello')
  })
})

describe('MockEmbeddingService', () => {
  it('returns vectors with correct dimensions', async () => {
    const m = new MockEmbeddingService(1536)
    const vecs = await m.embed(['a', 'bb'])
    expect(vecs).toHaveLength(2)
    expect(vecs[0]).toHaveLength(1536)
  })
})

describe('MockLLMService', () => {
  it('returns configured boundaries/summary/answer', async () => {
    const m = new MockLLMService([{ title: 't', speaker: 's', startMs: 0, endMs: 1 }], 'S', 'A')
    await expect(m.segmentTranscript('x')).resolves.toHaveLength(1)
    await expect(m.summarizeTalk('x')).resolves.toBe('S')
    await expect(m.answerQuestion('q', 'c')).resolves.toBe('A')
  })
})
```

- [ ] **Step 2: Run, expect pass**

Run: `npx vitest run tests/unit/mocks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Layer done-signal**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/mocks.test.ts
git commit -m "test: contract tests verifying mock service behaviors"
```

---

## Layer 4 — Service Implementations

### Task 4.1: Config module

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const orig = { ...process.env }
  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, orig)
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, orig)
  })

  it('throws when ASSEMBLYAI_API_KEY missing', async () => {
    delete process.env.ASSEMBLYAI_API_KEY
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/ASSEMBLYAI_API_KEY/)
  })

  it('returns parsed config when all required env present', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.PORT = '3000'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.assemblyaiApiKey).toBe('a')
    expect(cfg.port).toBe(3000)
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config**

```typescript
// src/config.ts
import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),
})

export interface AppConfig {
  supabaseUrl?: string
  supabaseServiceRoleKey?: string
  databaseUrl: string
  assemblyaiApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  port: number
  nodeEnv: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid config: ${issues}`)
  }
  return {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: parsed.data.SUPABASE_CONNECTION_STRING,
    assemblyaiApiKey: parsed.data.ASSEMBLYAI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: add zod-validated config loader"
```

---

### Task 4.2: YouTubeService (yt-dlp wrapper)

**Files:**
- Create: `tests/unit/youtube.test.ts`
- Create: `src/services/youtube.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/youtube.test.ts
import { describe, it, expect, vi } from 'vitest'
import { YouTubeService } from '../../src/services/youtube.js'

const okMetadata = JSON.stringify({
  title: 'My Talk',
  channel: 'Channel X',
  duration: 3600,
  thumbnail: 'https://img/thumb.jpg',
  chapters: [
    { title: 'Intro', start_time: 0, end_time: 60 },
    { title: 'Body', start_time: 60, end_time: 3600 },
  ],
})

describe('YouTubeService.getMetadata', () => {
  it('parses yt-dlp JSON into VideoMetadata', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec })
    const meta = await svc.getMetadata('https://www.youtube.com/watch?v=abc')
    expect(meta.title).toBe('My Talk')
    expect(meta.channel).toBe('Channel X')
    expect(meta.durationSeconds).toBe(3600)
    expect(meta.chapters).toEqual([
      { title: 'Intro', startMs: 0, endMs: 60000 },
      { title: 'Body', startMs: 60000, endMs: 3600000 },
    ])
  })

  it('returns empty chapters when yt-dlp omits them', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ title: 't', channel: 'c', duration: 10, thumbnail: 'x' }),
      stderr: '',
    }))
    const svc = new YouTubeService({ exec })
    const meta = await svc.getMetadata('https://youtu.be/abc')
    expect(meta.chapters).toEqual([])
  })

  it('throws when yt-dlp exits with error', async () => {
    const exec = vi.fn(async () => { throw new Error('yt-dlp failed') })
    const svc = new YouTubeService({ exec })
    await expect(svc.getMetadata('https://youtu.be/abc')).rejects.toThrow(/yt-dlp/)
  })
})

describe('YouTubeService.downloadAudio', () => {
  it('runs yt-dlp with -x and writes to outputPath', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const svc = new YouTubeService({ exec })
    await svc.downloadAudio('https://youtu.be/abc', '/tmp/abc.mp3')
    expect(exec).toHaveBeenCalledOnce()
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain('yt-dlp')
    expect(cmd).toContain('-x')
    expect(cmd).toContain('/tmp/abc.mp3')
    expect(cmd).toContain('https://youtu.be/abc')
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/youtube.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement YouTubeService**

```typescript
// src/services/youtube.ts
import { exec as nodeExec } from 'node:child_process'
import { promisify } from 'node:util'
import type { IYouTubeService } from '../interfaces/youtube.js'
import type { VideoMetadata } from '../types/index.js'

const execAsync = promisify(nodeExec)

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>

export class YouTubeService implements IYouTubeService {
  private exec: ExecFn
  constructor(opts: { exec?: ExecFn } = {}) {
    this.exec = opts.exec ?? ((cmd) => execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 }))
  }

  async getMetadata(url: string): Promise<VideoMetadata> {
    const safe = shellQuote(url)
    const { stdout } = await this.exec(`yt-dlp --no-warnings --dump-json --skip-download ${safe}`)
    const parsed = JSON.parse(stdout)
    const chapters = Array.isArray(parsed.chapters)
      ? parsed.chapters.map((c: any) => ({
          title: String(c.title ?? ''),
          startMs: Math.round(Number(c.start_time ?? 0) * 1000),
          endMs: Math.round(Number(c.end_time ?? 0) * 1000),
        }))
      : []
    return {
      title: String(parsed.title ?? ''),
      channel: String(parsed.channel ?? parsed.uploader ?? ''),
      durationSeconds: Number(parsed.duration ?? 0),
      thumbnailUrl: String(parsed.thumbnail ?? ''),
      chapters,
    }
  }

  async downloadAudio(url: string, outputPath: string): Promise<void> {
    const safeUrl = shellQuote(url)
    const safeOut = shellQuote(outputPath)
    await this.exec(
      `yt-dlp --no-warnings -x --audio-format mp3 -o ${safeOut} ${safeUrl}`
    )
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/youtube.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/youtube.test.ts src/services/youtube.ts
git commit -m "feat: implement YouTubeService (yt-dlp wrapper)"
```

---

### Task 4.3: AssemblyAIService

**Files:**
- Create: `tests/unit/assemblyai.test.ts`
- Create: `src/services/assemblyai.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/assemblyai.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AssemblyAIService } from '../../src/services/assemblyai.js'

function makeFakeClient(overrides: any = {}) {
  return {
    files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3'), ...overrides.files },
    transcripts: {
      submit: vi.fn(async () => ({ id: 'tx-1' })),
      get: vi.fn(async () => ({ id: 'tx-1', status: 'completed', text: 'Hello world', utterances: [
        { speaker: 'A', text: 'Hello world', start: 0, end: 1000 },
      ] })),
      ...overrides.transcripts,
    },
  }
}

describe('AssemblyAIService.submit', () => {
  it('uploads audio and submits a transcript job', async () => {
    const client = makeFakeClient()
    const svc = new AssemblyAIService(client as any)
    const { assemblyaiId } = await svc.submit('/tmp/x.mp3')
    expect(assemblyaiId).toBe('tx-1')
    expect(client.files.upload).toHaveBeenCalledWith('/tmp/x.mp3')
    expect(client.transcripts.submit).toHaveBeenCalledWith(
      expect.objectContaining({ audio_url: 'https://uploaded/audio.mp3', speaker_labels: true })
    )
  })
})

describe('AssemblyAIService.getStatus', () => {
  it('maps assemblyai status strings to TranscriptionStatus', async () => {
    const client = makeFakeClient({ transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'queued' })) } })
    const svc = new AssemblyAIService(client as any)
    const status = await svc.getStatus('tx-1')
    expect(status).toEqual({ id: 'tx-1', status: 'queued' })
  })

  it('reports error with message', async () => {
    const client = makeFakeClient({
      transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'error', error: 'bad audio' })) },
    })
    const svc = new AssemblyAIService(client as any)
    const status = await svc.getStatus('tx-1')
    expect(status.status).toBe('error')
    expect(status.errorMessage).toBe('bad audio')
  })
})

describe('AssemblyAIService.getResult', () => {
  it('returns TranscriptionResult with utterances normalized', async () => {
    const client = makeFakeClient()
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.rawText).toBe('Hello world')
    expect(result.utterances).toEqual([{ speaker: 'A', text: 'Hello world', startMs: 0, endMs: 1000 }])
  })

  it('throws when transcript not in completed state', async () => {
    const client = makeFakeClient({
      transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'processing' })) },
    })
    const svc = new AssemblyAIService(client as any)
    await expect(svc.getResult('tx-1')).rejects.toThrow(/not completed/i)
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/assemblyai.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement AssemblyAIService**

```typescript
// src/services/assemblyai.ts
import { AssemblyAI } from 'assemblyai'
import type { ITranscriptionService } from '../interfaces/assemblyai.js'
import type {
  TranscriptionResult,
  TranscriptionStatus,
  TranscriptionStatusValue,
} from '../types/index.js'

type ClientLike = {
  files: { upload(p: string): Promise<string> }
  transcripts: {
    submit(p: { audio_url: string; speaker_labels: boolean }): Promise<{ id: string }>
    get(id: string): Promise<any>
  }
}

const STATUS_MAP: Record<string, TranscriptionStatusValue> = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  error: 'error',
}

export class AssemblyAIService implements ITranscriptionService {
  constructor(private client: ClientLike) {}

  static fromApiKey(apiKey: string): AssemblyAIService {
    return new AssemblyAIService(new AssemblyAI({ apiKey }) as unknown as ClientLike)
  }

  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    const audio_url = await this.client.files.upload(audioPath)
    const { id } = await this.client.transcripts.submit({ audio_url, speaker_labels: true })
    return { assemblyaiId: id }
  }

  async getStatus(transcriptionId: string): Promise<TranscriptionStatus> {
    const t = await this.client.transcripts.get(transcriptionId)
    const status = STATUS_MAP[String(t.status)] ?? 'error'
    const out: TranscriptionStatus = { id: t.id, status }
    if (status === 'error' && t.error) out.errorMessage = String(t.error)
    return out
  }

  async getResult(transcriptionId: string): Promise<TranscriptionResult> {
    const t = await this.client.transcripts.get(transcriptionId)
    if (t.status !== 'completed') {
      throw new Error(`Transcript ${transcriptionId} not completed (status: ${t.status})`)
    }
    const utterances = (t.utterances ?? []).map((u: any) => ({
      speaker: String(u.speaker ?? ''),
      text: String(u.text ?? ''),
      startMs: Number(u.start ?? 0),
      endMs: Number(u.end ?? 0),
    }))
    return {
      assemblyaiId: t.id,
      rawText: String(t.text ?? ''),
      utterances,
    }
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/assemblyai.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/assemblyai.test.ts src/services/assemblyai.ts
git commit -m "feat: implement AssemblyAIService with status/result mapping"
```

---

### Task 4.4: EmbeddingService

**Files:**
- Create: `tests/unit/embeddings.test.ts`
- Create: `src/services/embeddings.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/embeddings.test.ts
import { describe, it, expect, vi } from 'vitest'
import { OpenAIEmbeddingService } from '../../src/services/embeddings.js'

function fakeOpenAI(vectors: number[][]) {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string[] }) => ({
        data: input.map((_, i) => ({ embedding: vectors[i] ?? vectors[0]! })),
      })),
    },
  }
}

describe('OpenAIEmbeddingService.embed', () => {
  it('returns embeddings in input order', async () => {
    const client = fakeOpenAI([[1, 2, 3], [4, 5, 6]])
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 100 })
    const result = await svc.embed(['a', 'b'])
    expect(result).toEqual([[1, 2, 3], [4, 5, 6]])
  })

  it('batches large inputs', async () => {
    const client = fakeOpenAI([[0.1]])
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 2 })
    await svc.embed(['a', 'b', 'c', 'd', 'e'])
    expect(client.embeddings.create).toHaveBeenCalledTimes(3)
  })

  it('returns empty array for empty input', async () => {
    const client = fakeOpenAI([[0.1]])
    const svc = new OpenAIEmbeddingService(client as any)
    await expect(svc.embed([])).resolves.toEqual([])
    expect(client.embeddings.create).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/embeddings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement EmbeddingService**

```typescript
// src/services/embeddings.ts
import OpenAI from 'openai'
import type { IEmbeddingService } from '../interfaces/embeddings.js'

type ClientLike = {
  embeddings: {
    create(p: { input: string[]; model: string }): Promise<{ data: { embedding: number[] }[] }>
  }
}

export interface EmbeddingOptions {
  model?: string
  batchSize?: number
}

export class OpenAIEmbeddingService implements IEmbeddingService {
  private model: string
  private batchSize: number

  constructor(private client: ClientLike, opts: EmbeddingOptions = {}) {
    this.model = opts.model ?? 'text-embedding-3-small'
    this.batchSize = opts.batchSize ?? 128
  }

  static fromApiKey(apiKey: string, opts: EmbeddingOptions = {}): OpenAIEmbeddingService {
    return new OpenAIEmbeddingService(new OpenAI({ apiKey }) as unknown as ClientLike, opts)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const res = await this.client.embeddings.create({ input: batch, model: this.model })
      for (const item of res.data) out.push(item.embedding)
    }
    return out
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/embeddings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/embeddings.test.ts src/services/embeddings.ts
git commit -m "feat: implement OpenAIEmbeddingService with batching"
```

---

### Task 4.5: LLMService (Claude)

**Files:**
- Create: `tests/unit/llm.test.ts`
- Create: `src/services/llm.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/llm.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ClaudeLLMService } from '../../src/services/llm.js'

function fakeAnthropic(textBlock: string) {
  return {
    messages: {
      create: vi.fn(async () => ({ content: [{ type: 'text', text: textBlock }] })),
    },
  }
}

describe('ClaudeLLMService.segmentTranscript', () => {
  it('parses JSON array of boundaries from Claude', async () => {
    const json = JSON.stringify([
      { title: 'A', speaker: 'X', startMs: 0, endMs: 1000 },
      { title: 'B', speaker: 'Y', startMs: 1000, endMs: 2000 },
    ])
    const client = fakeAnthropic(json)
    const svc = new ClaudeLLMService(client as any)
    const out = await svc.segmentTranscript('some transcript')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ title: 'A', startMs: 0 })
  })

  it('extracts JSON when Claude adds prose around it', async () => {
    const client = fakeAnthropic('Here is the JSON:\n[{"title":"A","speaker":"X","startMs":0,"endMs":1}]\nDone.')
    const svc = new ClaudeLLMService(client as any)
    const out = await svc.segmentTranscript('x')
    expect(out).toHaveLength(1)
  })

  it('throws when no JSON array found', async () => {
    const client = fakeAnthropic('I cannot.')
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.segmentTranscript('x')).rejects.toThrow(/JSON/)
  })
})

describe('ClaudeLLMService.summarizeTalk', () => {
  it('returns the model text directly', async () => {
    const client = fakeAnthropic('Talk was great.')
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.summarizeTalk('x')).resolves.toBe('Talk was great.')
  })
})

describe('ClaudeLLMService.answerQuestion', () => {
  it('includes question and context in prompt', async () => {
    const client = fakeAnthropic('The answer is 42.')
    const svc = new ClaudeLLMService(client as any)
    const ans = await svc.answerQuestion('What is the answer?', 'Reference text.')
    expect(ans).toBe('The answer is 42.')
    const call = (client.messages.create as any).mock.calls[0][0]
    const userMsg = call.messages.find((m: any) => m.role === 'user')
    expect(userMsg.content).toContain('What is the answer?')
    expect(userMsg.content).toContain('Reference text.')
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/llm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement ClaudeLLMService**

```typescript
// src/services/llm.ts
import Anthropic from '@anthropic-ai/sdk'
import type { ILLMService } from '../interfaces/llm.js'
import type { TalkBoundary } from '../types/index.js'

type ClientLike = {
  messages: {
    create(p: any): Promise<{ content: { type: string; text?: string }[] }>
  }
}

const MODEL = 'claude-sonnet-4-6'

export class ClaudeLLMService implements ILLMService {
  constructor(private client: ClientLike) {}

  static fromApiKey(apiKey: string): ClaudeLLMService {
    return new ClaudeLLMService(new Anthropic({ apiKey }) as unknown as ClientLike)
  }

  private async invoke(system: string, user: string, maxTokens = 4096): Promise<string> {
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const blocks = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string')
    return blocks.map((b) => b.text as string).join('\n').trim()
  }

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    const sys =
      'You segment conference transcripts into individual talks. ' +
      'Respond with ONLY a JSON array of {title, speaker, startMs, endMs} objects. No prose.'
    const txt = await this.invoke(sys, `Transcript:\n${transcript}`, 4096)
    const match = txt.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('Claude segmentation: no JSON array in response')
    const parsed = JSON.parse(match[0]) as TalkBoundary[]
    return parsed
  }

  async summarizeTalk(transcript: string): Promise<string> {
    const sys = 'You write concise (3-5 sentence) summaries of conference talks. Plain prose, no markdown.'
    return this.invoke(sys, `Talk transcript:\n${transcript}`, 1024)
  }

  async answerQuestion(question: string, context: string): Promise<string> {
    const sys =
      'Answer the user question using only the provided context. ' +
      'Cite sources inline as [chunk:<id>] where the context provides such markers. ' +
      'If the answer is not in the context, say so.'
    const user = `Context:\n${context}\n\nQuestion: ${question}`
    return this.invoke(sys, user, 2048)
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/llm.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/llm.test.ts src/services/llm.ts
git commit -m "feat: implement ClaudeLLMService for segmentation/summary/QA"
```

---

### Task 4.6: RAG service

**Files:**
- Create: `tests/unit/rag.test.ts`
- Create: `src/services/rag.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/rag.test.ts
import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion, buildRagContext } from '../../src/services/rag.js'

describe('reciprocalRankFusion', () => {
  it('merges keyword and vector results with RRF', () => {
    const keyword = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const vector = [{ id: 'b' }, { id: 'd' }, { id: 'a' }]
    const merged = reciprocalRankFusion([keyword, vector], { k: 60 })
    expect(merged[0]!.id).toBe('b') // appears high in both
    expect(merged.map((r) => r.id)).toContain('a')
    expect(merged.map((r) => r.id)).toContain('d')
  })

  it('deduplicates by id', () => {
    const merged = reciprocalRankFusion([[{ id: 'x' }], [{ id: 'x' }]], { k: 60 })
    expect(merged).toHaveLength(1)
  })

  it('returns empty list for empty inputs', () => {
    expect(reciprocalRankFusion([], { k: 60 })).toEqual([])
    expect(reciprocalRankFusion([[]], { k: 60 })).toEqual([])
  })
})

describe('buildRagContext', () => {
  it('formats chunks with talk metadata and chunk ids', () => {
    const ctx = buildRagContext([
      { id: 'c1', text: 'First chunk.', talkTitle: 'Alice', speaker: 'A', startMs: 1000 },
      { id: 'c2', text: 'Second chunk.', talkTitle: 'Bob', speaker: 'B', startMs: 5000 },
    ])
    expect(ctx).toContain('[chunk:c1]')
    expect(ctx).toContain('Alice')
    expect(ctx).toContain('First chunk.')
    expect(ctx).toContain('[chunk:c2]')
  })
})
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/unit/rag.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement RAG helpers**

```typescript
// src/services/rag.ts
export interface RankedItem {
  id: string
  [k: string]: unknown
}

export function reciprocalRankFusion<T extends RankedItem>(
  lists: T[][],
  opts: { k: number }
): T[] {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    list.forEach((item, idx) => {
      const score = 1 / (opts.k + idx + 1)
      const existing = scores.get(item.id)
      if (existing) existing.score += score
      else scores.set(item.id, { item, score })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item)
}

export interface ChunkForContext {
  id: string
  text: string
  talkTitle: string
  speaker: string
  startMs: number
}

export function buildRagContext(chunks: ChunkForContext[]): string {
  return chunks
    .map((c) => {
      const ts = `${Math.floor(c.startMs / 1000)}s`
      return `[chunk:${c.id}] (Talk: "${c.talkTitle}" by ${c.speaker} @ ${ts})\n${c.text}`
    })
    .join('\n\n')
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/unit/rag.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/rag.test.ts src/services/rag.ts
git commit -m "feat: add RAG helpers (RRF + context builder)"
```

---

### Task 4.7: Layer 4 done-signal

- [ ] **Step 1: Full unit suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

---

## Layer 5 — Database Layer (Docker Postgres)

### Task 5.1: Migration SQL

**Files:**
- Create: `src/db/migrations/001_initial.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- src/db/migrations/001_initial.sql
create extension if not exists vector;

create table if not exists source_videos (
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

create table if not exists talks (
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

create table if not exists transcripts (
  id              uuid primary key default gen_random_uuid(),
  talk_id         uuid not null references talks(id) on delete cascade,
  assemblyai_id   text unique,
  raw_text        text,
  utterances      jsonb,
  summary         text,
  created_at      timestamptz default now()
);

create table if not exists chunks (
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

create index if not exists chunks_fts_idx on chunks using gin(to_tsvector('english', text));
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists talks_source_video_id_idx on talks(source_video_id);
create index if not exists chunks_talk_id_idx on chunks(talk_id);
create index if not exists transcripts_talk_id_idx on transcripts(talk_id);

create or replace function match_chunks(
  query_embedding vector(1536),
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
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Commit**

```bash
git add src/db/migrations/001_initial.sql
git commit -m "feat(db): add initial migration with pgvector + hnsw + match_chunks"
```

---

### Task 5.2: DB client + test harness

**Files:**
- Create: `src/db/client.ts`
- Create: `tests/integration/db-setup.ts`

- [ ] **Step 1: Create db client**

```typescript
// src/db/client.ts
import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool
  const cs = connectionString ?? process.env.DATABASE_URL ?? process.env.SUPABASE_CONNECTION_STRING
  if (!cs) throw new Error('No database connection string configured')
  pool = new Pool({ connectionString: cs, max: 10 })
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
```

- [ ] **Step 2: Create db-setup.ts**

```typescript
// tests/integration/db-setup.ts
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const { Pool } = pg

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:54329/test'

export async function waitForPostgres(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
    try {
      await probe.query('select 1')
      await probe.end()
      return
    } catch (e) {
      lastErr = e
      await probe.end().catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`Postgres not ready after ${timeoutMs}ms: ${String(lastErr)}`)
}

export function startContainer(): void {
  execSync('docker compose -f docker-compose.test.yml up -d', { stdio: 'inherit' })
}

export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(resolve('src/db/migrations/001_initial.sql'), 'utf8')
  await pool.query(sql)
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('truncate table chunks, transcripts, talks, source_videos restart identity cascade')
}

export function makeTestPool(): pg.Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 5 })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/db/client.ts tests/integration/db-setup.ts
git commit -m "feat(db): add pg pool client and integration test harness"
```

---

### Task 5.3: Migration integration test

**Files:**
- Create: `tests/integration/migrations.test.ts`

- [ ] **Step 1: Write test**

```typescript
// tests/integration/migrations.test.ts
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from './db-setup.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

afterAll(async () => {
  await pool.end()
})

describe('migrations', () => {
  it('creates all expected tables', async () => {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toContain('source_videos')
    expect(names).toContain('talks')
    expect(names).toContain('transcripts')
    expect(names).toContain('chunks')
  })

  it('creates the match_chunks function', async () => {
    const { rows } = await pool.query(
      `select proname from pg_proc where proname='match_chunks'`
    )
    expect(rows).toHaveLength(1)
  })

  it('creates hnsw index on chunks.embedding', async () => {
    const { rows } = await pool.query(
      `select indexname from pg_indexes where tablename='chunks' and indexname='chunks_embedding_idx'`
    )
    expect(rows).toHaveLength(1)
  })

  it('enables pgvector extension', async () => {
    const { rows } = await pool.query(`select extname from pg_extension where extname='vector'`)
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Start container and run**

Run: `docker compose -f docker-compose.test.yml up -d && npx vitest run --config vitest.integration.config.ts tests/integration/migrations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/migrations.test.ts
git commit -m "test(db): verify migration applies tables/index/function"
```

---

### Task 5.4: Query helpers + CRUD tests

**Files:**
- Create: `src/db/queries.ts`
- Create: `tests/integration/queries.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/queries.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo,
  getSourceVideoById,
  updateSourceVideoStatus,
  insertTalk,
  insertTranscript,
  insertChunk,
  listTalksForVideo,
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

afterAll(async () => {
  await pool.end()
})

describe('source_videos CRUD', () => {
  it('inserts and reads back', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    expect(sv.id).toBeTruthy()
    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.youtube_id).toBe('abc')
    expect(fetched!.status).toBe('pending')
  })

  it('updates status', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    await updateSourceVideoStatus(pool, sv.id, 'downloading')
    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('downloading')
  })

  it('enforces unique youtube_id', async () => {
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    await expect(
      insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/def', youtubeId: 'abc' })
    ).rejects.toThrow()
  })
})

describe('talks + transcripts + chunks', () => {
  it('inserts a full hierarchy and lists talks', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    const talk = await insertTalk(pool, {
      sourceVideoId: sv.id, title: 'T1', speaker: 'S1', talkIndex: 0, startMs: 0, endMs: 1000,
    })
    const transcript = await insertTranscript(pool, {
      talkId: talk.id, assemblyaiId: 'tx-1', rawText: 'hello', utterances: [],
    })
    await insertChunk(pool, {
      talkId: talk.id,
      transcriptId: transcript.id,
      chunkIndex: 0,
      text: 'hello world',
      startMs: 0, endMs: 1000,
      tokenCount: 2,
      embedding: Array.from({ length: 1536 }, () => 0.001),
    })
    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks).toHaveLength(1)
    expect(talks[0]!.title).toBe('T1')
  })
})
```

- [ ] **Step 2: Implement queries**

```typescript
// src/db/queries.ts
import type pg from 'pg'

export interface SourceVideoRow {
  id: string
  youtube_url: string
  youtube_id: string
  title: string | null
  channel: string | null
  duration_seconds: number | null
  thumbnail_url: string | null
  has_chapters: boolean
  status: string
  error_message: string | null
  created_at: Date
  updated_at: Date
}

export async function insertSourceVideo(
  pool: pg.Pool,
  v: { youtubeUrl: string; youtubeId: string; title?: string; channel?: string }
): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into source_videos (youtube_url, youtube_id, title, channel)
     values ($1, $2, $3, $4) returning id`,
    [v.youtubeUrl, v.youtubeId, v.title ?? null, v.channel ?? null]
  )
  return { id: rows[0].id }
}

export async function getSourceVideoById(pool: pg.Pool, id: string): Promise<SourceVideoRow | null> {
  const { rows } = await pool.query(`select * from source_videos where id = $1`, [id])
  return rows[0] ?? null
}

export async function getSourceVideoByYoutubeId(pool: pg.Pool, youtubeId: string): Promise<SourceVideoRow | null> {
  const { rows } = await pool.query(`select * from source_videos where youtube_id = $1`, [youtubeId])
  return rows[0] ?? null
}

export async function updateSourceVideoStatus(
  pool: pg.Pool,
  id: string,
  status: string,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `update source_videos set status = $2, error_message = $3, updated_at = now() where id = $1`,
    [id, status, errorMessage ?? null]
  )
}

export async function updateSourceVideoMetadata(
  pool: pg.Pool,
  id: string,
  m: { title: string; channel: string; durationSeconds: number; thumbnailUrl: string; hasChapters: boolean }
): Promise<void> {
  await pool.query(
    `update source_videos
       set title=$2, channel=$3, duration_seconds=$4, thumbnail_url=$5, has_chapters=$6, updated_at=now()
       where id=$1`,
    [id, m.title, m.channel, m.durationSeconds, m.thumbnailUrl, m.hasChapters]
  )
}

export interface TalkRow {
  id: string
  source_video_id: string
  title: string | null
  speaker: string | null
  conference: string | null
  talk_index: number
  start_ms: number
  end_ms: number
  youtube_deep_link: string | null
}

export async function insertTalk(
  pool: pg.Pool,
  t: { sourceVideoId: string; title: string; speaker: string; talkIndex: number; startMs: number; endMs: number; conference?: string; youtubeDeepLink?: string }
): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into talks (source_video_id, title, speaker, conference, talk_index, start_ms, end_ms, youtube_deep_link)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [t.sourceVideoId, t.title, t.speaker, t.conference ?? null, t.talkIndex, t.startMs, t.endMs, t.youtubeDeepLink ?? null]
  )
  return { id: rows[0].id }
}

export async function listTalksForVideo(pool: pg.Pool, sourceVideoId: string): Promise<TalkRow[]> {
  const { rows } = await pool.query(
    `select * from talks where source_video_id = $1 order by talk_index asc`,
    [sourceVideoId]
  )
  return rows
}

export async function getTalkById(pool: pg.Pool, id: string): Promise<TalkRow | null> {
  const { rows } = await pool.query(`select * from talks where id = $1`, [id])
  return rows[0] ?? null
}

export async function insertTranscript(
  pool: pg.Pool,
  t: { talkId: string; assemblyaiId: string; rawText: string; utterances: unknown[] }
): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into transcripts (talk_id, assemblyai_id, raw_text, utterances)
     values ($1,$2,$3,$4) returning id`,
    [t.talkId, t.assemblyaiId, t.rawText, JSON.stringify(t.utterances)]
  )
  return { id: rows[0].id }
}

export async function updateTranscriptSummary(pool: pg.Pool, transcriptId: string, summary: string): Promise<void> {
  await pool.query(`update transcripts set summary = $2 where id = $1`, [transcriptId, summary])
}

export async function getTranscriptByTalkId(pool: pg.Pool, talkId: string) {
  const { rows } = await pool.query(`select * from transcripts where talk_id = $1`, [talkId])
  return rows[0] ?? null
}

export interface ChunkInsert {
  talkId: string
  transcriptId: string
  chunkIndex: number
  text: string
  startMs: number | null
  endMs: number | null
  tokenCount: number
  embedding: number[]
}

function toPgVector(arr: number[]): string {
  return `[${arr.join(',')}]`
}

export async function insertChunk(pool: pg.Pool, c: ChunkInsert): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into chunks (talk_id, transcript_id, chunk_index, text, start_ms, end_ms, token_count, embedding)
     values ($1,$2,$3,$4,$5,$6,$7,$8::vector) returning id`,
    [c.talkId, c.transcriptId, c.chunkIndex, c.text, c.startMs, c.endMs, c.tokenCount, toPgVector(c.embedding)]
  )
  return { id: rows[0].id }
}
```

- [ ] **Step 3: Run test, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/queries.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src/db/queries.ts tests/integration/queries.test.ts
git commit -m "feat(db): add CRUD query helpers + integration tests"
```

---

### Task 5.5: Vector search test

**Files:**
- Create: `tests/integration/vector-search.test.ts`
- Modify: `src/db/queries.ts` (add `matchChunks`, `searchChunksFullText`)

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/vector-search.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk,
  matchChunks, searchChunksFullText,
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

afterAll(async () => {
  await pool.end()
})

function vec(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

async function seedThreeChunks() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const talk = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'S', talkIndex: 0, startMs: 0, endMs: 0 })
  const tr = await insertTranscript(pool, { talkId: talk.id, assemblyaiId: 'tx', rawText: '', utterances: [] })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 0, text: 'cats love fish', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 1, text: 'dogs chase squirrels', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(2) })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 2, text: 'cats nap a lot', startMs: 0, endMs: 1, tokenCount: 4, embedding: vec(3) })
  return talk.id
}

describe('matchChunks', () => {
  it('returns top-N by cosine similarity', async () => {
    await seedThreeChunks()
    const res = await matchChunks(pool, vec(1), 2)
    expect(res).toHaveLength(2)
    expect(res[0]!.similarity).toBeGreaterThanOrEqual(res[1]!.similarity)
  })
  it('filters by talk_id when provided', async () => {
    const talkId = await seedThreeChunks()
    const res = await matchChunks(pool, vec(1), 10, talkId)
    expect(res.length).toBe(3)
  })
})

describe('searchChunksFullText', () => {
  it('matches by english tsvector', async () => {
    await seedThreeChunks()
    const res = await searchChunksFullText(pool, 'cats', 10)
    const texts = res.map((r) => r.text)
    expect(texts.some((t) => t.includes('cats love fish'))).toBe(true)
    expect(texts.some((t) => t.includes('cats nap a lot'))).toBe(true)
  })
  it('returns empty when no match', async () => {
    await seedThreeChunks()
    const res = await searchChunksFullText(pool, 'aardvarks', 10)
    expect(res).toEqual([])
  })
})
```

- [ ] **Step 2: Add query helpers**

Append to `src/db/queries.ts`:

```typescript
export interface MatchChunkRow {
  id: string
  text: string
  talk_id: string
  start_ms: number
  end_ms: number
  similarity: number
}

export async function matchChunks(
  pool: pg.Pool,
  queryEmbedding: number[],
  matchCount: number,
  filterTalkId?: string
): Promise<MatchChunkRow[]> {
  const { rows } = await pool.query(
    `select * from match_chunks($1::vector, $2, $3)`,
    [toPgVector(queryEmbedding), matchCount, filterTalkId ?? null]
  )
  return rows
}

export interface FullTextChunkRow {
  id: string
  text: string
  talk_id: string
  start_ms: number | null
  end_ms: number | null
  rank: number
}

export async function searchChunksFullText(
  pool: pg.Pool,
  query: string,
  limit: number,
  filterTalkId?: string
): Promise<FullTextChunkRow[]> {
  const { rows } = await pool.query(
    `select id, text, talk_id, start_ms, end_ms,
            ts_rank(to_tsvector('english', text), plainto_tsquery('english', $1)) as rank
       from chunks
      where to_tsvector('english', text) @@ plainto_tsquery('english', $1)
        and ($3::uuid is null or talk_id = $3)
      order by rank desc
      limit $2`,
    [query, limit, filterTalkId ?? null]
  )
  return rows
}
```

- [ ] **Step 3: Run test, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/vector-search.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/vector-search.test.ts src/db/queries.ts
git commit -m "feat(db): add match_chunks + full-text search helpers with integration tests"
```

---

### Task 5.6: Layer 5 done-signal

- [ ] **Step 1: Run all integration tests**

Run: `npx vitest run --config vitest.integration.config.ts && npx tsc --noEmit`
Expected: all green.

---

## Layer 6 — Pipeline Orchestration

### Task 6.1: Pipeline step types + dependency container

**Files:**
- Create: `src/workers/types.ts`
- Create: `src/queues/jobs.ts`

- [ ] **Step 1: Create queues/jobs.ts**

```typescript
// src/queues/jobs.ts
export const QUEUE_PIPELINE = 'video.pipeline'

export interface PipelineJobData {
  sourceVideoId: string
  youtubeUrl: string
}
```

- [ ] **Step 2: Create workers/types.ts**

```typescript
// src/workers/types.ts
import type pg from 'pg'
import type { IYouTubeService } from '../interfaces/youtube.js'
import type { ITranscriptionService } from '../interfaces/assemblyai.js'
import type { IEmbeddingService } from '../interfaces/embeddings.js'
import type { ILLMService } from '../interfaces/llm.js'

export interface PipelineDeps {
  pool: pg.Pool
  youtube: IYouTubeService
  transcription: ITranscriptionService
  embeddings: IEmbeddingService
  llm: ILLMService
  tmpDir: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export interface StepContext extends PipelineDeps {
  sourceVideoId: string
  youtubeUrl: string
}
```

- [ ] **Step 3: Commit**

```bash
git add src/queues/jobs.ts src/workers/types.ts
git commit -m "feat(pipeline): add job + dependency types"
```

---

### Task 6.2: Pipeline step — download

**Files:**
- Create: `src/workers/steps/download.ts`
- Create: `tests/integration/pipeline-download.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-download.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { runDownload } from '../../src/workers/steps/download.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

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

describe('runDownload', () => {
  it('sets status downloading then updates metadata', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const youtube = new MockYouTubeService({
      title: 'Talk', channel: 'Chan', durationSeconds: 60, thumbnailUrl: 'http://t', chapters: [],
    })
    await runDownload({
      pool, youtube,
      transcription: new MockTranscriptionService({ assemblyaiId: 'x', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: '/tmp',
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/a',
    })
    const row = await getSourceVideoById(pool, sv.id)
    expect(row!.title).toBe('Talk')
    expect(row!.has_chapters).toBe(false)
    expect(youtube.downloads).toHaveLength(1)
  })

  it('marks has_chapters when metadata has chapters', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const youtube = new MockYouTubeService({
      title: 'T', channel: 'C', durationSeconds: 1, thumbnailUrl: '',
      chapters: [{ title: 'Intro', startMs: 0, endMs: 1000 }],
    })
    await runDownload({
      pool, youtube,
      transcription: new MockTranscriptionService({ assemblyaiId: 'x', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: '/tmp',
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/a',
    })
    const row = await getSourceVideoById(pool, sv.id)
    expect(row!.has_chapters).toBe(true)
  })
})
```

- [ ] **Step 2: Implement runDownload**

```typescript
// src/workers/steps/download.ts
import { join } from 'node:path'
import type { StepContext } from '../types.js'
import { updateSourceVideoStatus, updateSourceVideoMetadata } from '../../db/queries.js'

export interface DownloadResult {
  audioPath: string
}

export async function runDownload(ctx: StepContext): Promise<DownloadResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'downloading')
  const meta = await ctx.youtube.getMetadata(ctx.youtubeUrl)
  await updateSourceVideoMetadata(ctx.pool, ctx.sourceVideoId, {
    title: meta.title,
    channel: meta.channel,
    durationSeconds: meta.durationSeconds,
    thumbnailUrl: meta.thumbnailUrl,
    hasChapters: meta.chapters.length > 0,
  })
  const audioPath = join(ctx.tmpDir, `${ctx.sourceVideoId}.mp3`)
  await ctx.youtube.downloadAudio(ctx.youtubeUrl, audioPath)
  return { audioPath }
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-download.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add src/workers/steps/download.ts tests/integration/pipeline-download.test.ts
git commit -m "feat(pipeline): implement download step"
```

---

### Task 6.3: Pipeline step — transcribe

**Files:**
- Create: `src/workers/steps/transcribe.ts`
- Create: `tests/integration/pipeline-transcribe.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-transcribe.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { runTranscribe } from '../../src/workers/steps/transcribe.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('runTranscribe', () => {
  it('submits, polls, returns result, and deletes mp3', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const audioPath = join('/tmp', `${sv.id}.mp3`)
    writeFileSync(audioPath, 'dummy')
    const transcription = new MockTranscriptionService({
      assemblyaiId: 'tx-1',
      rawText: 'hello world',
      utterances: [{ speaker: 'A', text: 'hello world', startMs: 0, endMs: 1000 }],
    })
    const result = await runTranscribe(
      {
        pool,
        youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
        transcription,
        embeddings: new MockEmbeddingService(),
        llm: new MockLLMService(),
        tmpDir: '/tmp',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
        sourceVideoId: sv.id,
        youtubeUrl: 'https://youtu.be/a',
      },
      { audioPath }
    )
    expect(result.rawText).toBe('hello world')
    expect(transcription.submissions).toEqual([audioPath])
    expect(existsSync(audioPath)).toBe(false)
    const row = await getSourceVideoById(pool, sv.id)
    expect(row!.status).toBe('transcribing')
  })
})
```

- [ ] **Step 2: Implement runTranscribe**

```typescript
// src/workers/steps/transcribe.ts
import { unlinkSync, existsSync } from 'node:fs'
import type { StepContext } from '../types.js'
import type { TranscriptionResult } from '../../types/index.js'
import { updateSourceVideoStatus } from '../../db/queries.js'

export interface TranscribeInput {
  audioPath: string
}

export async function runTranscribe(
  ctx: StepContext,
  input: TranscribeInput
): Promise<TranscriptionResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'transcribing')

  const { assemblyaiId } = await ctx.transcription.submit(input.audioPath)
  // Persist assemblyai id immediately for crash recovery
  await ctx.pool.query(
    `update source_videos set updated_at = now(), error_message = null where id = $1`,
    [ctx.sourceVideoId]
  )
  await ctx.pool.query(
    `insert into transcripts (talk_id, assemblyai_id, raw_text) values (null, $1, '')
       on conflict do nothing`,
    [assemblyaiId]
  ).catch(() => { /* talk_id is NOT NULL — this insert is a no-op marker; ignore */ })

  const interval = ctx.pollIntervalMs ?? 2000
  const timeout = ctx.pollTimeoutMs ?? 30 * 60 * 1000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await ctx.transcription.getStatus(assemblyaiId)
    if (status.status === 'completed') break
    if (status.status === 'error') {
      throw new Error(`Transcription failed: ${status.errorMessage ?? 'unknown'}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }

  const result = await ctx.transcription.getResult(assemblyaiId)
  if (existsSync(input.audioPath)) {
    try { unlinkSync(input.audioPath) } catch { /* fine */ }
  }
  return result
}
```

(Note: the placeholder insert into transcripts is removed — `talk_id` is NOT NULL so it cannot be a pure marker. Drop the failed insert; assemblyai_id is persisted later when transcripts are written per-talk in the segment step.)

Replace the `runTranscribe` body to remove the placeholder insert:

```typescript
export async function runTranscribe(
  ctx: StepContext,
  input: TranscribeInput
): Promise<TranscriptionResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'transcribing')
  const { assemblyaiId } = await ctx.transcription.submit(input.audioPath)
  await ctx.pool.query(
    `update source_videos set updated_at = now() where id = $1`,
    [ctx.sourceVideoId]
  )

  const interval = ctx.pollIntervalMs ?? 2000
  const timeout = ctx.pollTimeoutMs ?? 30 * 60 * 1000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await ctx.transcription.getStatus(assemblyaiId)
    if (status.status === 'completed') break
    if (status.status === 'error') {
      throw new Error(`Transcription failed: ${status.errorMessage ?? 'unknown'}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }

  const result = await ctx.transcription.getResult(assemblyaiId)
  if (existsSync(input.audioPath)) {
    try { unlinkSync(input.audioPath) } catch { /* fine */ }
  }
  return result
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-transcribe.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add src/workers/steps/transcribe.ts tests/integration/pipeline-transcribe.test.ts
git commit -m "feat(pipeline): implement transcribe step (submit + poll + cleanup)"
```

---

### Task 6.4: Pipeline step — segment

**Files:**
- Create: `src/workers/steps/segment.ts`
- Create: `tests/integration/pipeline-segment.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-segment.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, listTalksForVideo, getTranscriptByTalkId } from '../../src/db/queries.js'
import { runSegment } from '../../src/workers/steps/segment.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

const baseCtx = (pool: any, sourceVideoId: string, llm = new MockLLMService()) => ({
  pool,
  youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
  transcription: new MockTranscriptionService({ assemblyaiId: 'tx', rawText: '', utterances: [] }),
  embeddings: new MockEmbeddingService(),
  llm,
  tmpDir: '/tmp',
  sourceVideoId,
  youtubeUrl: 'https://youtu.be/a',
})

describe('runSegment', () => {
  it('Path A: uses chapter metadata when available', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const result = await runSegment(baseCtx(pool, sv.id), {
      transcription: {
        assemblyaiId: 'tx-1',
        rawText: 'Welcome. Alice. Vectors. Bob. Databases.',
        utterances: sampleUtterances,
      },
      chapters: [
        { title: 'Intro', startMs: 0, endMs: 5000 },
        { title: 'Vectors by Alice', startMs: 5000, endMs: 13000 },
        { title: 'Databases by Bob', startMs: 13000, endMs: 24000 },
      ],
    })
    expect(result.talkIds).toHaveLength(3)
    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks[1]!.title).toBe('Vectors')
    expect(talks[1]!.speaker).toBe('Alice')
    const tr = await getTranscriptByTalkId(pool, talks[1]!.id)
    expect(tr!.raw_text).toContain('vectors')
  })

  it('Path B: falls back to LLM when no chapters', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const llm = new MockLLMService([
      { title: 'Alice', speaker: 'Alice', startMs: 0, endMs: 10000 },
    ])
    const result = await runSegment(baseCtx(pool, sv.id, llm), {
      transcription: { assemblyaiId: 'tx-1', rawText: 'all of it', utterances: sampleUtterances },
      chapters: [],
    })
    expect(result.talkIds).toHaveLength(1)
    expect(llm.segmentCalls).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Implement runSegment**

```typescript
// src/workers/steps/segment.ts
import type { StepContext } from '../types.js'
import type { TranscriptionResult, TalkBoundary } from '../../types/index.js'
import {
  updateSourceVideoStatus, insertTalk, insertTranscript,
} from '../../db/queries.js'
import { boundariesFromChapters, sliceUtterancesByBoundary } from '../../services/segmentation.js'

export interface SegmentInput {
  transcription: TranscriptionResult
  chapters: { title: string; startMs: number; endMs: number }[]
}

export interface SegmentResult {
  talkIds: { talkId: string; transcriptId: string; boundary: TalkBoundary; text: string }[]
}

function buildDeepLink(url: string, startMs: number): string {
  const sec = Math.floor(startMs / 1000)
  const u = new URL(url)
  u.searchParams.set('t', `${sec}s`)
  return u.toString()
}

export async function runSegment(ctx: StepContext, input: SegmentInput): Promise<SegmentResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'segmenting')

  const boundaries: TalkBoundary[] = input.chapters.length > 0
    ? boundariesFromChapters(input.chapters)
    : await ctx.llm.segmentTranscript(input.transcription.rawText)

  const out: SegmentResult['talkIds'] = []
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    const slice = sliceUtterancesByBoundary(input.transcription.utterances, b)
    const text = slice.map((u) => u.text).join(' ')
    const talk = await insertTalk(ctx.pool, {
      sourceVideoId: ctx.sourceVideoId,
      title: b.title,
      speaker: b.speaker,
      talkIndex: i,
      startMs: b.startMs,
      endMs: b.endMs,
      youtubeDeepLink: buildDeepLink(ctx.youtubeUrl, b.startMs),
    })
    const transcript = await insertTranscript(ctx.pool, {
      talkId: talk.id,
      assemblyaiId: `${input.transcription.assemblyaiId}#${i}`,
      rawText: text,
      utterances: slice,
    })
    out.push({ talkId: talk.id, transcriptId: transcript.id, boundary: b, text })
  }

  return { talkIds: out }
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-segment.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add src/workers/steps/segment.ts tests/integration/pipeline-segment.test.ts
git commit -m "feat(pipeline): implement segment step (chapter + LLM paths)"
```

---

### Task 6.5: Pipeline step — embed

**Files:**
- Create: `src/workers/steps/embed.ts`
- Create: `tests/integration/pipeline-embed.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-embed.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript,
} from '../../src/db/queries.js'
import { runEmbed } from '../../src/workers/steps/embed.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('runEmbed', () => {
  it('chunks and inserts embeddings for all talks', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const talk = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'S', talkIndex: 0, startMs: 0, endMs: 1000 })
    const tr = await insertTranscript(pool, { talkId: talk.id, assemblyaiId: 'tx#0', rawText: 'Hello world. Second sentence. Third sentence.', utterances: [] })
    const embed = new MockEmbeddingService()
    await runEmbed({
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
      embeddings: embed,
      llm: new MockLLMService(),
      tmpDir: '/tmp',
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/a',
    }, {
      talks: [{ talkId: talk.id, transcriptId: tr.id, text: 'Hello world. Second sentence. Third sentence.' }],
    })
    const { rows } = await pool.query('select count(*)::int as n from chunks where talk_id=$1', [talk.id])
    expect(rows[0].n).toBeGreaterThan(0)
    expect(embed.batches.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Implement runEmbed**

```typescript
// src/workers/steps/embed.ts
import type { StepContext } from '../types.js'
import { updateSourceVideoStatus, insertChunk } from '../../db/queries.js'
import { chunkText } from '../../services/chunker.js'

export interface EmbedInput {
  talks: { talkId: string; transcriptId: string; text: string }[]
}

export async function runEmbed(ctx: StepContext, input: EmbedInput): Promise<void> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'embedding')

  for (const talk of input.talks) {
    const chunks = chunkText(talk.text, { targetTokens: 400, overlapTokens: 50 })
    if (chunks.length === 0) continue
    const embeddings = await ctx.embeddings.embed(chunks.map((c) => c.text))
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!
      const e = embeddings[i]
      if (!e) throw new Error(`Missing embedding for chunk ${i}`)
      await insertChunk(ctx.pool, {
        talkId: talk.talkId,
        transcriptId: talk.transcriptId,
        chunkIndex: c.chunkIndex,
        text: c.text,
        startMs: null,
        endMs: null,
        tokenCount: c.tokenCount,
        embedding: e,
      })
    }
  }
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-embed.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add src/workers/steps/embed.ts tests/integration/pipeline-embed.test.ts
git commit -m "feat(pipeline): implement embed step (chunk + batch embed + insert)"
```

---

### Task 6.6: Pipeline step — summarize

**Files:**
- Create: `src/workers/steps/summarize.ts`
- Create: `tests/integration/pipeline-summarize.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-summarize.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, getTranscriptByTalkId, getSourceVideoById,
} from '../../src/db/queries.js'
import { runSummarize } from '../../src/workers/steps/summarize.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
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

describe('runSummarize', () => {
  it('summarizes each talk and marks video ready', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t1 = await insertTalk(pool, { sourceVideoId: sv.id, title: 'A', speaker: '', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'tx#0', rawText: 'text A', utterances: [] })
    const t2 = await insertTalk(pool, { sourceVideoId: sv.id, title: 'B', speaker: '', talkIndex: 1, startMs: 1, endMs: 2 })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'tx#1', rawText: 'text B', utterances: [] })
    const llm = new MockLLMService([], 'SUMMARY')
    await runSummarize({
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: '/tmp',
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/a',
    }, {
      talks: [
        { talkId: t1.id, transcriptId: tr1.id, text: 'text A' },
        { talkId: t2.id, transcriptId: tr2.id, text: 'text B' },
      ],
    })
    expect(llm.summarizeCalls).toEqual(['text A', 'text B'])
    expect((await getTranscriptByTalkId(pool, t1.id))!.summary).toBe('SUMMARY')
    expect((await getSourceVideoById(pool, sv.id))!.status).toBe('ready')
  })
})
```

- [ ] **Step 2: Implement runSummarize**

```typescript
// src/workers/steps/summarize.ts
import type { StepContext } from '../types.js'
import { updateSourceVideoStatus, updateTranscriptSummary } from '../../db/queries.js'

export interface SummarizeInput {
  talks: { talkId: string; transcriptId: string; text: string }[]
}

export async function runSummarize(ctx: StepContext, input: SummarizeInput): Promise<void> {
  for (const t of input.talks) {
    const summary = await ctx.llm.summarizeTalk(t.text)
    await updateTranscriptSummary(ctx.pool, t.transcriptId, summary)
  }
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'ready')
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-summarize.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add src/workers/steps/summarize.ts tests/integration/pipeline-summarize.test.ts
git commit -m "feat(pipeline): implement summarize step + final ready transition"
```

---

### Task 6.7: Pipeline worker orchestrator + pg-boss integration

**Files:**
- Create: `src/workers/pipeline.worker.ts`
- Create: `src/worker.ts`
- Create: `tests/integration/pipeline-worker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/integration/pipeline-worker.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import PgBoss from 'pg-boss'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
  TEST_DATABASE_URL,
} from './db-setup.js'
import {
  insertSourceVideo, getSourceVideoById, listTalksForVideo,
} from '../../src/db/queries.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'

const pool = makeTestPool()
let boss: PgBoss

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })

afterAll(async () => {
  await boss.stop({ graceful: true })
  await pool.end()
})

describe('pipeline worker', () => {
  it('runs full pipeline end-to-end with mocked services', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    // create dummy mp3 so transcribe step's unlink doesn't error
    const audioPath = join('/tmp', `${sv.id}.mp3`)
    writeFileSync(audioPath, 'dummy')

    const youtube = new MockYouTubeService({
      title: 'Conf 2026', channel: 'Chan', durationSeconds: 24, thumbnailUrl: 'http://t',
      chapters: [
        { title: 'Intro', startMs: 0, endMs: 5000 },
        { title: 'Vectors by Alice', startMs: 5000, endMs: 13000 },
        { title: 'Databases by Bob', startMs: 13000, endMs: 24000 },
      ],
    })
    const transcription = new MockTranscriptionService({
      assemblyaiId: 'tx-1',
      rawText: sampleUtterances.map((u) => u.text).join(' '),
      utterances: sampleUtterances,
    })

    await registerPipelineWorker(boss, {
      pool, youtube, transcription,
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: '/tmp',
      pollIntervalMs: 5,
      pollTimeoutMs: 5000,
    })

    await boss.send(QUEUE_PIPELINE, { sourceVideoId: sv.id, youtubeUrl: 'https://youtu.be/a' })

    // poll until completed (max 20s)
    for (let i = 0; i < 200; i++) {
      const row = await getSourceVideoById(pool, sv.id)
      if (row?.status === 'ready') break
      if (row?.status === 'error') throw new Error(`pipeline errored: ${row.error_message}`)
      await new Promise((r) => setTimeout(r, 100))
    }

    const row = await getSourceVideoById(pool, sv.id)
    expect(row!.status).toBe('ready')
    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks).toHaveLength(3)
  }, 30_000)
})
```

- [ ] **Step 2: Implement pipeline worker**

```typescript
// src/workers/pipeline.worker.ts
import type PgBoss from 'pg-boss'
import { runDownload } from './steps/download.js'
import { runTranscribe } from './steps/transcribe.js'
import { runSegment } from './steps/segment.js'
import { runEmbed } from './steps/embed.js'
import { runSummarize } from './steps/summarize.js'
import { updateSourceVideoStatus } from '../db/queries.js'
import { QUEUE_PIPELINE, type PipelineJobData } from '../queues/jobs.js'
import type { PipelineDeps } from './types.js'

export async function registerPipelineWorker(
  boss: PgBoss,
  deps: PipelineDeps
): Promise<void> {
  await boss.work<PipelineJobData>(
    QUEUE_PIPELINE,
    { teamSize: 2, teamConcurrency: 1 },
    async ([job]) => {
      const ctx = { ...deps, sourceVideoId: job.data.sourceVideoId, youtubeUrl: job.data.youtubeUrl }
      try {
        const dl = await runDownload(ctx)
        const meta = await deps.youtube.getMetadata(job.data.youtubeUrl)
        const transcription = await runTranscribe(ctx, { audioPath: dl.audioPath })
        const seg = await runSegment(ctx, { transcription, chapters: meta.chapters })
        const talks = seg.talkIds.map((t) => ({ talkId: t.talkId, transcriptId: t.transcriptId, text: t.text }))
        await runEmbed(ctx, { talks })
        await runSummarize(ctx, { talks })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await updateSourceVideoStatus(deps.pool, job.data.sourceVideoId, 'error', msg)
        throw err
      }
    }
  )
}
```

(Note: pg-boss v10 `work` callback signature is `async (jobs: Job[]) => void` — we destructure the first job because teamConcurrency: 1.)

- [ ] **Step 3: Create worker entrypoint**

```typescript
// src/worker.ts
import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { registerPipelineWorker } from './workers/pipeline.worker.js'
import { YouTubeService } from './services/youtube.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })

async function main() {
  await boss.start()
  await registerPipelineWorker(boss, {
    pool,
    youtube: new YouTubeService(),
    transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
    embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
    llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
    tmpDir: '/tmp',
  })
  console.log('Worker started')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-worker.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/workers/pipeline.worker.ts src/worker.ts tests/integration/pipeline-worker.test.ts
git commit -m "feat(pipeline): orchestrate steps via pg-boss worker"
```

---

### Task 6.8: Error handling test (one step fails → status=error)

**Files:**
- Create: `tests/integration/pipeline-error.test.ts`

- [ ] **Step 1: Write test**

```typescript
// tests/integration/pipeline-error.test.ts
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import PgBoss from 'pg-boss'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll, TEST_DATABASE_URL,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type { ITranscriptionService } from '../../src/interfaces/assemblyai.js'

const pool = makeTestPool()
let boss: PgBoss

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })

afterAll(async () => {
  await boss.stop({ graceful: true })
  await pool.end()
})

class FailingTranscription implements ITranscriptionService {
  async submit() { return { assemblyaiId: 'tx' } }
  async getStatus() { return { id: 'tx', status: 'error' as const, errorMessage: 'simulated' } }
  async getResult(): Promise<never> { throw new Error('should not be called') }
}

describe('pipeline error handling', () => {
  it('sets source_videos.status=error and stores message when a step throws', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await registerPipelineWorker(boss, {
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new FailingTranscription(),
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: '/tmp',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    })
    await boss.send(QUEUE_PIPELINE, { sourceVideoId: sv.id, youtubeUrl: 'https://youtu.be/a' })
    for (let i = 0; i < 200; i++) {
      const row = await getSourceVideoById(pool, sv.id)
      if (row?.status === 'error') break
      await new Promise((r) => setTimeout(r, 100))
    }
    const row = await getSourceVideoById(pool, sv.id)
    expect(row!.status).toBe('error')
    expect(row!.error_message).toMatch(/simulated/)
  }, 30_000)
})
```

- [ ] **Step 2: Run, expect pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-error.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/pipeline-error.test.ts
git commit -m "test(pipeline): verify failed step marks status=error with message"
```

---

### Task 6.9: Layer 6 done-signal

- [ ] **Step 1: Run all integration tests + typecheck**

Run: `npx vitest run --config vitest.integration.config.ts && npx tsc --noEmit`
Expected: all green.

---

## Layer 7 — API Routes

### Task 7.1: Fastify server scaffold

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `tests/routes/health.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/routes/health.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildServer({
    pool: {} as Pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService(),
    enqueueJob: async () => 'job-1',
  })
})

afterAll(async () => {
  await app.close()
})

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Implement server**

```typescript
// src/server.ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { IYouTubeService } from './interfaces/youtube.js'
import type { ITranscriptionService } from './interfaces/assemblyai.js'
import type { IEmbeddingService } from './interfaces/embeddings.js'
import type { ILLMService } from './interfaces/llm.js'
import { registerVideoRoutes } from './routes/videos.js'
import { registerTalkRoutes } from './routes/talks.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerQaRoutes } from './routes/qa.js'

export interface AppDeps {
  pool: Pool
  youtube: IYouTubeService
  transcription: ITranscriptionService
  embeddings: IEmbeddingService
  llm: ILLMService
  enqueueJob: (data: { sourceVideoId: string; youtubeUrl: string }) => Promise<string>
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ status: 'ok' }))
  await registerVideoRoutes(app, deps)
  await registerTalkRoutes(app, deps)
  await registerSearchRoutes(app, deps)
  await registerQaRoutes(app, deps)
  return app
}
```

- [ ] **Step 3: Create stub route files (will be implemented in 7.2–7.5)**

```typescript
// src/routes/videos.ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
export async function registerVideoRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}
```

```typescript
// src/routes/talks.ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
export async function registerTalkRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}
```

```typescript
// src/routes/search.ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
export async function registerSearchRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}
```

```typescript
// src/routes/qa.ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
export async function registerQaRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}
```

- [ ] **Step 4: Create index.ts**

```typescript
// src/index.ts
import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'
import { QUEUE_PIPELINE } from './queues/jobs.js'
import { YouTubeService } from './services/youtube.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })

async function main() {
  await boss.start()
  const app = await buildServer({
    pool,
    youtube: new YouTubeService(),
    transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
    embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
    llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
    enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
  })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`API listening on ${cfg.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/routes/health.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/index.ts src/routes/ tests/routes/health.test.ts
git commit -m "feat(api): scaffold Fastify server with health route + DI"
```

---

### Task 7.2: POST /videos + dedup + GET /videos

**Files:**
- Modify: `src/routes/videos.ts`
- Create: `tests/routes/videos.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/routes/videos.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { insertSourceVideo } from '../../src/db/queries.js'

const pool = makeTestPool()
let app: FastifyInstance
let enqueue = vi.fn(async () => 'job-1')

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
    enqueueJob: enqueue,
  })
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
  enqueue.mockClear()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('POST /videos', () => {
  it('creates a source_video, enqueues, returns id+status', async () => {
    const res = await app.inject({
      method: 'POST', url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.source_video_id).toBeTruthy()
    expect(body.status).toBe('pending')
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('rejects invalid URL with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/videos',
      payload: { youtube_url: 'not a url' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns existing record on duplicate, does not enqueue', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ', youtubeId: 'dQw4w9WgXcQ',
    })
    const res = await app.inject({
      method: 'POST', url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().source_video_id).toBe(sv.id)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('GET /videos', () => {
  it('lists videos with talk counts', async () => {
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'Video A' })
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b', title: 'Video B' })
    const res = await app.inject({ method: 'GET', url: '/videos' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toHaveProperty('talk_count')
  })
})

describe('GET /videos/:id', () => {
  it('returns video with talks array', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const res = await app.inject({ method: 'GET', url: `/videos/${sv.id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: sv.id, talks: [] })
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/videos/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /videos/:id/status', () => {
  it('returns status', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const res = await app.inject({ method: 'GET', url: `/videos/${sv.id}/status` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending')
  })
})
```

- [ ] **Step 2: Implement /videos routes**

Replace `src/routes/videos.ts`:

```typescript
// src/routes/videos.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { extractYouTubeId } from '../services/url-validator.js'
import {
  insertSourceVideo, getSourceVideoById, getSourceVideoByYoutubeId, listTalksForVideo,
} from '../db/queries.js'

const PostBody = z.object({
  youtube_url: z.string(),
  conference: z.string().optional(),
})

export async function registerVideoRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/videos', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    const youtubeId = extractYouTubeId(parsed.data.youtube_url)
    if (!youtubeId) return reply.code(400).send({ error: 'invalid youtube url' })

    const existing = await getSourceVideoByYoutubeId(deps.pool, youtubeId)
    if (existing) {
      return reply.code(200).send({ source_video_id: existing.id, status: existing.status })
    }

    const sv = await insertSourceVideo(deps.pool, {
      youtubeUrl: parsed.data.youtube_url,
      youtubeId,
    })
    await deps.enqueueJob({ sourceVideoId: sv.id, youtubeUrl: parsed.data.youtube_url })
    return reply.code(201).send({ source_video_id: sv.id, status: 'pending' })
  })

  app.get('/videos', async () => {
    const { rows } = await deps.pool.query(
      `select sv.id as source_video_id, sv.title, sv.channel, sv.status, sv.created_at,
              (select count(*) from talks t where t.source_video_id = sv.id)::int as talk_count
         from source_videos sv
        order by sv.created_at desc`
    )
    return rows
  })

  app.get<{ Params: { id: string } }>('/videos/:id', async (req, reply) => {
    const row = await getSourceVideoById(deps.pool, req.params.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    const talks = await listTalksForVideo(deps.pool, row.id)
    return { ...row, talks }
  })

  app.get<{ Params: { id: string } }>('/videos/:id/status', async (req, reply) => {
    const row = await getSourceVideoById(deps.pool, req.params.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return { status: row.status, current_step: row.status, error_message: row.error_message }
  })
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run tests/routes/videos.test.ts`
Expected: PASS (6 tests).

(Note: `tests/routes/videos.test.ts` uses the real Postgres from docker-compose, so the docker container must be running. The test imports `db-setup.js` from `../integration/`. The route test config is `vitest.config.ts`, which includes `tests/routes/**`. To keep routes-as-integration tests working, ensure the docker container is up before running.)

- [ ] **Step 4: Commit**

```bash
git add src/routes/videos.ts tests/routes/videos.test.ts
git commit -m "feat(api): POST/GET /videos with dedup, listing, status"
```

---

### Task 7.3: GET /talks endpoints

**Files:**
- Modify: `src/routes/talks.ts`
- Create: `tests/routes/talks.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/routes/talks.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { insertSourceVideo, insertTalk, insertTranscript } from '../../src/db/queries.js'

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
  })
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await app.close(); await pool.end() })

async function seed() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const t1 = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Vectors', speaker: 'Alice', conference: 'KubeCon 2024', talkIndex: 0, startMs: 0, endMs: 1000 })
  const t2 = await insertTalk(pool, { sourceVideoId: sv.id, title: 'DBs', speaker: 'Bob', conference: 'KubeCon 2024', talkIndex: 1, startMs: 1000, endMs: 2000 })
  await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'tx#0', rawText: 'about vectors', utterances: [] })
  return { sv, t1, t2 }
}

describe('GET /talks', () => {
  it('lists all talks', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
  })

  it('filters by speaker', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks?speaker=Alice' })
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].speaker).toBe('Alice')
  })

  it('applies limit and offset', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks?limit=1&offset=1' })
    expect(res.json()).toHaveLength(1)
  })
})

describe('GET /talks/:id', () => {
  it('returns talk with transcript and source_video', async () => {
    const { t1 } = await seed()
    const res = await app.inject({ method: 'GET', url: `/talks/${t1.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.transcript.raw_text).toBe('about vectors')
    expect(body.source_video).toBeTruthy()
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/talks/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Implement /talks routes**

```typescript
// src/routes/talks.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { getTalkById, getTranscriptByTalkId, getSourceVideoById } from '../db/queries.js'

const Query = z.object({
  conference: z.string().optional(),
  speaker: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function registerTalkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/talks', async (req, reply) => {
    const parsed = Query.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const { conference, speaker, limit, offset } = parsed.data
    const { rows } = await deps.pool.query(
      `select * from talks
         where ($1::text is null or conference = $1)
           and ($2::text is null or speaker = $2)
         order by created_at desc
         limit $3 offset $4`,
      [conference ?? null, speaker ?? null, limit, offset]
    )
    return rows
  })

  app.get<{ Params: { id: string } }>('/talks/:id', async (req, reply) => {
    const talk = await getTalkById(deps.pool, req.params.id)
    if (!talk) return reply.code(404).send({ error: 'not found' })
    const transcript = await getTranscriptByTalkId(deps.pool, talk.id)
    const sourceVideo = await getSourceVideoById(deps.pool, talk.source_video_id)
    return { ...talk, transcript, source_video: sourceVideo }
  })
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run tests/routes/talks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src/routes/talks.ts tests/routes/talks.test.ts
git commit -m "feat(api): GET /talks with filters + GET /talks/:id detail"
```

---

### Task 7.4: POST /search (hybrid)

**Files:**
- Modify: `src/routes/search.ts`
- Create: `tests/routes/search.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/routes/search.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk,
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
  })
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await app.close(); await pool.end() })

function vec(seed: number) { return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000) }

async function seedChunks() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const talk = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'S', talkIndex: 0, startMs: 0, endMs: 1 })
  const tr = await insertTranscript(pool, { talkId: talk.id, assemblyaiId: 'tx', rawText: '', utterances: [] })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 0, text: 'vectors are arrays of numbers', startMs: 0, endMs: 1, tokenCount: 5, embedding: vec(1) })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 1, text: 'databases store data', startMs: 0, endMs: 1, tokenCount: 4, embedding: vec(2) })
  return talk.id
}

describe('POST /search', () => {
  it('returns hybrid results', async () => {
    await seedChunks()
    const res = await app.inject({
      method: 'POST', url: '/search', payload: { query: 'vectors', limit: 5 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]).toHaveProperty('chunk_text')
    expect(body.results[0]).toHaveProperty('talk_id')
  })

  it('filters by talk_id', async () => {
    const talkId = await seedChunks()
    const res = await app.inject({
      method: 'POST', url: '/search', payload: { query: 'vectors', talk_id: talkId },
    })
    expect(res.statusCode).toBe(200)
    for (const r of res.json().results) expect(r.talk_id).toBe(talkId)
  })
})
```

- [ ] **Step 2: Implement /search**

```typescript
// src/routes/search.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { matchChunks, searchChunksFullText } from '../db/queries.js'
import { reciprocalRankFusion } from '../services/rag.js'

const Body = z.object({
  query: z.string().min(1),
  talk_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
})

export async function registerSearchRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/search', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    const { query, talk_id, limit } = parsed.data

    const [queryEmbedding] = await deps.embeddings.embed([query])
    if (!queryEmbedding) return reply.code(500).send({ error: 'embedding failed' })

    const [vectorRows, keywordRows] = await Promise.all([
      matchChunks(deps.pool, queryEmbedding, limit * 3, talk_id),
      searchChunksFullText(deps.pool, query, limit * 3, talk_id),
    ])

    const merged = reciprocalRankFusion<{ id: string } & Record<string, unknown>>([
      keywordRows.map((r) => ({ id: r.id, ...r })),
      vectorRows.map((r) => ({ id: r.id, ...r })),
    ], { k: 60 })

    const results = merged.slice(0, limit).map((c: any) => ({
      chunk_id: c.id,
      chunk_text: c.text,
      talk_id: c.talk_id,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
    }))
    return { results }
  })
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run tests/routes/search.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add src/routes/search.ts tests/routes/search.test.ts
git commit -m "feat(api): POST /search (hybrid vector + FTS with RRF)"
```

---

### Task 7.5: POST /qa (RAG)

**Files:**
- Modify: `src/routes/qa.ts`
- Create: `tests/routes/qa.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/routes/qa.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk,
} from '../../src/db/queries.js'

const pool = makeTestPool()
let app: FastifyInstance
const llm = new MockLLMService([], '', 'Vectors are arrays. [chunk:c1]')

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
    llm,
    enqueueJob: async () => 'job-1',
  })
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await app.close(); await pool.end() })

function vec(seed: number) { return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000) }

describe('POST /qa', () => {
  it('returns answer with sources', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const talk = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Vectors', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr = await insertTranscript(pool, { talkId: talk.id, assemblyaiId: 'tx', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 0, text: 'vectors are arrays of numbers', startMs: 0, endMs: 1, tokenCount: 5, embedding: vec(1) })

    const res = await app.inject({
      method: 'POST', url: '/qa', payload: { question: 'what are vectors?' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).toContain('Vectors')
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body.sources.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Implement /qa**

```typescript
// src/routes/qa.ts
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
  app.post('/qa', async (req, reply) => {
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
  })
}
```

- [ ] **Step 3: Run, expect pass**

Run: `npx vitest run tests/routes/qa.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add src/routes/qa.ts tests/routes/qa.test.ts
git commit -m "feat(api): POST /qa (RAG with citations)"
```

---

### Task 7.6: Layer 7 done-signal

- [ ] **Step 1: Run all unit + route tests + typecheck**

Run: `docker compose -f docker-compose.test.yml up -d && npx vitest run && npx tsc --noEmit`
Expected: all green.

---

## Layer 8 — Smoke Tests

### Task 8.1: Full pipeline smoke test

**Files:**
- Create: `tests/smoke/pipeline.smoke.test.ts`

- [ ] **Step 1: Write smoke test**

```typescript
// tests/smoke/pipeline.smoke.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import PgBoss from 'pg-boss'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll, TEST_DATABASE_URL,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import type { FastifyInstance } from 'fastify'

const pool = makeTestPool()
let app: FastifyInstance
let boss: PgBoss

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()

  const youtube = new MockYouTubeService({
    title: 'KubeCon Day 1', channel: 'CNCF', durationSeconds: 24, thumbnailUrl: 'http://t',
    chapters: [
      { title: 'Intro', startMs: 0, endMs: 5000 },
      { title: 'Vectors by Alice', startMs: 5000, endMs: 13000 },
      { title: 'Databases by Bob', startMs: 13000, endMs: 24000 },
    ],
  })
  const transcription = new MockTranscriptionService({
    assemblyaiId: 'tx-1',
    rawText: sampleUtterances.map((u) => u.text).join(' '),
    utterances: sampleUtterances,
  })
  const llm = new MockLLMService([], 'Mock summary.', 'Vectors are arrays of numbers. [chunk:any]')

  await registerPipelineWorker(boss, {
    pool, youtube, transcription,
    embeddings: new MockEmbeddingService(),
    llm,
    tmpDir: '/tmp',
    pollIntervalMs: 5,
    pollTimeoutMs: 5000,
  })

  app = await buildServer({
    pool, youtube, transcription,
    embeddings: new MockEmbeddingService(),
    llm,
    enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
  })
}, 120_000)

beforeEach(async () => {
  await pool.query('truncate table chunks, transcripts, talks, source_videos restart identity cascade')
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: true })
  await pool.end()
})

describe('full pipeline smoke', () => {
  it('submit → pipeline → search → qa', async () => {
    // Stage dummy mp3 file (required because transcribe step deletes it)
    // We don't know the sourceVideoId yet, so we'll glob — but easier: pre-write any file the test needs.
    // Implementation note: the download step calls youtube.downloadAudio with the sourceVideoId path; the mock does NOT create the file, so transcribe's unlink does no-op (existsSync false).
    // The transcribe step uses existsSync() guard — fine.

    const submit = await app.inject({
      method: 'POST', url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=smokeABC1234' },
    })
    expect(submit.statusCode).toBe(201)
    const sourceVideoId = submit.json().source_video_id

    // Wait up to 30s for status=ready
    let ready = false
    for (let i = 0; i < 300; i++) {
      const s = await app.inject({ method: 'GET', url: `/videos/${sourceVideoId}/status` })
      const body = s.json()
      if (body.status === 'ready') { ready = true; break }
      if (body.status === 'error') throw new Error(`Pipeline errored: ${body.error_message}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(ready).toBe(true)

    const video = await app.inject({ method: 'GET', url: `/videos/${sourceVideoId}` })
    expect(video.json().talks.length).toBe(3)

    const talks = await app.inject({ method: 'GET', url: '/talks' })
    expect(talks.json().length).toBe(3)

    const search = await app.inject({
      method: 'POST', url: '/search', payload: { query: 'vectors', limit: 5 },
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().results.length).toBeGreaterThan(0)

    const qa = await app.inject({
      method: 'POST', url: '/qa', payload: { question: 'what are vectors?' },
    })
    expect(qa.statusCode).toBe(200)
    expect(qa.json().answer).toMatch(/Vectors/)
    expect(qa.json().sources.length).toBeGreaterThan(0)
  }, 60_000)
})
```

- [ ] **Step 2: Run, expect pass**

Run: `docker compose -f docker-compose.test.yml up -d && npx vitest run tests/smoke/pipeline.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add tests/smoke/pipeline.smoke.test.ts
git commit -m "test: full pipeline smoke (submit → ready → search → qa)"
```

---

### Task 8.2: Layer 8 done-signal

- [ ] **Step 1: Run everything**

Run: `docker compose -f docker-compose.test.yml up -d && npx vitest run && npx vitest run --config vitest.integration.config.ts && npx tsc --noEmit`
Expected: all green.

---

## Layer 9 — README + Setup Docs

### Task 9.1: Write README

**Files:**
- Create: `README.md`
- Create: `railway.toml`

- [ ] **Step 1: Create railway.toml**

```toml
[build]
  builder = "NIXPACKS"

[deploy]
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3

[services.api]
  start = "node dist/index.js"

[services.worker]
  start = "node dist/worker.js"
```

- [ ] **Step 2: Create README.md**

```markdown
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

Apply the schema to your database:

```bash
psql "$SUPABASE_CONNECTION_STRING" -f src/db/migrations/001_initial.sql
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
```

- [ ] **Step 3: Verify clean clone setup (in another terminal)**

Run:
```bash
cd /tmp && rm -rf vt-verify && git clone <local-repo-path> vt-verify && cd vt-verify && npm install && npm run typecheck
```
Expected: install + typecheck succeeds.

(Local-only check; skip if you don't want to spend the time. The CI configuration should cover this.)

- [ ] **Step 4: Commit**

```bash
git add README.md railway.toml
git commit -m "docs: add README + railway deployment config"
```

---

### Task 9.2: Final done-signal

- [ ] **Step 1: Full verification**

Run: `docker compose -f docker-compose.test.yml up -d && npx vitest run && npx vitest run --config vitest.integration.config.ts && npx tsc --noEmit`
Expected: all green across unit, route, integration, and smoke layers.

- [ ] **Step 2: Stop docker**

Run: `docker compose -f docker-compose.test.yml down`
Expected: container stops cleanly.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ Project structure → Layer 1
- ✅ DB schema (incl. hnsw + match_chunks) → Layer 5 Task 5.1
- ✅ Service interfaces → Layer 3 Task 3.2
- ✅ Step 0 submit → Layer 7 Task 7.2
- ✅ Step 1 download → Layer 6 Task 6.2
- ✅ Step 2 transcribe (with assemblyai_id persistence) → Layer 6 Task 6.3
- ✅ Step 3 segment (Path A + B) → Layer 6 Task 6.4
- ✅ Step 4 chunk + embed → Layer 6 Task 6.5
- ✅ Step 5 summarize → Layer 6 Task 6.6
- ✅ API endpoints (videos, talks, search, qa) → Layer 7 Tasks 7.2–7.5
- ✅ pg-boss worker (teamSize: 2, teamConcurrency: 1) → Layer 6 Task 6.7
- ✅ Package scripts → Layer 1 Task 1.1
- ✅ Env vars → Layer 1 + Layer 4 Task 4.1
- ✅ Railway config → Layer 9 Task 9.1
- ✅ README → Layer 9 Task 9.1
- ✅ Smoke test (all mocks wired) → Layer 8 Task 8.1

**Known compromises (acceptable per spec/scope):**
- pg-boss retry config (3 retries, exponential backoff) — pg-boss applies defaults; explicit retry config can be added when registering the worker. Not blocking MVP.
- Transcription crash recovery uses `assemblyai_id` stored at segment time (in `transcripts.assemblyai_id`). True mid-flight crash recovery would require persisting the id on `source_videos` before segmenting. Spec calls this out but accepts the limitation for MVP.

---
