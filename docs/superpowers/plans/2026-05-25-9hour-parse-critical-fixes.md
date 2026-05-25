# 9-Hour Conference Parse — Critical Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing video-transcriber pipeline survive one manual run of a 9-hour, chapter-tagged conference video on prod Railway without silent failures or wasted transcription cost.

**Architecture:** Four surgical changes, no schema migration: env-configurable transcription poll timeout (Component 1); a `withRetry` helper applied at the service layer for AssemblyAI / OpenAI / Anthropic only (Component 2); chapter boundary validation post-segmentation (Component 3); explicit `retryLimit: 0` on pg-boss enqueue (Component 4). `YouTubeService` is deliberately not retried to avoid amplifying bot-detection signal.

**Tech Stack:** Node 22 + TypeScript ESM, Fastify, pg-boss, AssemblyAI SDK, OpenAI SDK, Anthropic SDK, Vitest. See `CLAUDE.md` for repo conventions (TDD required, failing test first).

---

## Source spec

`docs/superpowers/specs/2026-05-25-9hour-parse-critical-fixes-design.md`

## Prerequisites

- Current branch: `feat/9hour-parse-critical-fixes` (already created from `origin/main`, with spec committed as `d3f8c24`).
- All work in this plan stays on this branch.
- TDD: every code-producing task starts with a failing test (per `CLAUDE.md`).
- Working directory for all commands: `/Users/donkim/Code/video-transcriber/video-transcriber/`.

## File map (locked decomposition)

| File | Role | Touched in task |
|---|---|---|
| `src/config.ts` | Add `TRANSCRIPTION_POLL_TIMEOUT_MS` env var to zod schema + `AppConfig` field | 1 |
| `src/worker.ts` | Pass `pollTimeoutMs` into `registerPipelineWorker` deps | 1 |
| `src/services/retry.ts` | **NEW** — `withRetry` helper, ~50 LOC, one responsibility (transparent retry of external API calls) | 2 |
| `src/services/assemblyai.ts` | Wrap 4 SDK call sites with `withRetry` | 3 |
| `src/services/embeddings.ts` | Wrap 1 SDK call site with `withRetry` | 4 |
| `src/services/llm.ts` | Wrap 1 SDK call site (`invoke()`) with `withRetry` | 5 |
| `src/services/youtube.ts` | Add 1 banner comment documenting deliberate non-wrap; no logic change | 6 |
| `src/services/segmentation.ts` | Add `validateBoundaries` function | 7 |
| `src/workers/steps/segment.ts` | Call `validateBoundaries` after `strategy.segment()` | 8 |
| `src/index.ts` | Pass `{ retryLimit: 0 }` to `boss.send` in the `enqueueJob` closure | 9 |
| `tests/unit/config.test.ts` | Extend with `TRANSCRIPTION_POLL_TIMEOUT_MS` cases | 1 |
| `tests/unit/retry.test.ts` | **NEW** — retry helper unit tests | 2 |
| `tests/unit/assemblyai.test.ts` | Extend with retry-wired-through assertion | 3 |
| `tests/unit/embeddings.test.ts` | Extend with retry-wired-through assertion | 4 |
| `tests/unit/llm.test.ts` | Extend with retry-wired-through assertion | 5 |
| `tests/unit/youtube-no-retry.test.ts` | **NEW** — static guard (no `withRetry` in youtube.ts) | 6 |
| `tests/unit/segmentation.test.ts` | Extend with `validateBoundaries` cases | 7 |
| `tests/integration/pipeline-segment.test.ts` | Extend with malformed-chapters failure case | 8 |

No schema migrations. No frontend changes.

---

## Task 1: Configurable transcription poll timeout

**Files:**
- Modify: `src/config.ts`
- Modify: `src/worker.ts:23-30`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1.1: Write the failing test (parse + default)**

Append to `tests/unit/config.test.ts` (inside the existing `describe('loadConfig', ...)` block):

```typescript
  it('parses TRANSCRIPTION_POLL_TIMEOUT_MS when set', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.TRANSCRIPTION_POLL_TIMEOUT_MS = '3600000'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.transcriptionPollTimeoutMs).toBe(3_600_000)
  })

  it('defaults transcriptionPollTimeoutMs to 7_200_000 (120 min) when unset', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.TRANSCRIPTION_POLL_TIMEOUT_MS
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.transcriptionPollTimeoutMs).toBe(7_200_000)
  })

  it('rejects non-positive TRANSCRIPTION_POLL_TIMEOUT_MS', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.TRANSCRIPTION_POLL_TIMEOUT_MS = '0'
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/TRANSCRIPTION_POLL_TIMEOUT_MS/)
  })
```

- [ ] **Step 1.2: Run test, verify it fails**

```bash
npx vitest run tests/unit/config.test.ts -t TRANSCRIPTION_POLL_TIMEOUT_MS
```

Expected: 3 tests fail with `expected undefined to be 3600000` (or similar — the field does not exist yet on `AppConfig`).

- [ ] **Step 1.3: Implement in `src/config.ts`**

In the zod `Schema` object (currently lines 3-14), add:

```typescript
  TRANSCRIPTION_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
```

In the `AppConfig` interface (currently lines 16-27), add:

```typescript
  transcriptionPollTimeoutMs: number
```

In the `loadConfig` return object (currently lines 35-46), add:

```typescript
    transcriptionPollTimeoutMs: parsed.data.TRANSCRIPTION_POLL_TIMEOUT_MS,
```

- [ ] **Step 1.4: Run test, verify it passes**

```bash
npx vitest run tests/unit/config.test.ts
```

Expected: all `loadConfig` tests pass (including the 3 new ones).

- [ ] **Step 1.5: Wire to worker**

Edit `src/worker.ts:23-30`. Replace the `registerPipelineWorker` block:

```typescript
  await registerPipelineWorker(boss, {
    pool,
    youtube: new YouTubeService({ cookiesPath, ytDlpPath: resolveYtDlpPath() }),
    transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
    embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
    llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
    tmpDir: '/tmp',
    pollTimeoutMs: cfg.transcriptionPollTimeoutMs,
  })
```

(`PipelineDeps` in `src/workers/types.ts:15` already has `pollTimeoutMs?: number` — no type change needed.)

- [ ] **Step 1.6: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0, no errors.

- [ ] **Step 1.7: Commit**

```bash
git add src/config.ts src/worker.ts tests/unit/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): make transcription poll timeout configurable, default 120min

Adds TRANSCRIPTION_POLL_TIMEOUT_MS env var; passes through worker deps so
9-hour audio jobs don't hit the hardcoded 30-min poll cap in transcribe step.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `withRetry` helper

**Files:**
- Create: `src/services/retry.ts`
- Test: `tests/unit/retry.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `tests/unit/retry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { withRetry } from '../../src/services/retry.js'

describe('withRetry', () => {
  it('returns success on first attempt without retrying', async () => {
    const fn = vi.fn(async () => 'ok')
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on HTTP 429 and returns success on second attempt', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n += 1
      if (n === 1) {
        const err = new Error('rate limited') as Error & { status?: number }
        err.status = 429
        throw err
      }
      return 'ok'
    })
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on ECONNRESET (Node error code)', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n += 1
      if (n < 3) {
        const err = new Error('connection reset') as Error & { code?: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return 'ok'
    })
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on HTTP 400', async () => {
    const err = new Error('bad request') as Error & { status?: number }
    err.status = 400
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on TypeError', async () => {
    const fn = vi.fn(async () => { throw new TypeError('nope') })
    await expect(withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow(TypeError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws the last error after exhausting attempts', async () => {
    const err = new Error('always fails') as Error & { status?: number }
    err.status = 503
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })).rejects.toThrow('always fails')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('calls onAttempt for each retry with attempt number and error', async () => {
    const onAttempt = vi.fn()
    const err = new Error('boom') as Error & { status?: number }
    err.status = 500
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, onAttempt })).rejects.toThrow()
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt).toHaveBeenNthCalledWith(1, 1, err)
    expect(onAttempt).toHaveBeenNthCalledWith(2, 2, err)
  })

  it('honors custom isRetryable predicate', async () => {
    const err = new Error('weird') as Error & { code?: string }
    err.code = 'CUSTOM'
    const fn = vi.fn(async () => { throw err })
    const isRetryable = (e: unknown): boolean =>
      e instanceof Error && (e as Error & { code?: string }).code === 'CUSTOM'
    await expect(
      withRetry(fn, { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, isRetryable })
    ).rejects.toThrow('weird')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2.2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/retry.test.ts
```

Expected: all 8 tests fail with `Cannot find module '../../src/services/retry.js'`.

- [ ] **Step 2.3: Implement `src/services/retry.ts`**

Create `src/services/retry.ts`:

```typescript
// withRetry — transparent retry wrapper for external API calls.
//
// Used by AssemblyAIService, OpenAIEmbeddingService, and ClaudeLLMService only.
// Deliberately NOT used by YouTubeService — see docs/superpowers/specs/
// 2026-05-25-9hour-parse-critical-fixes-design.md, Component 2.

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  onAttempt?: (attempt: number, err: unknown) => void
  opName?: string
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])
const TRANSIENT_MSG = /fetch failed|socket hang up|timeout/i

export function defaultIsRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof TypeError) return false
  // Zod errors expose `.issues` — never retry validation failures.
  if (Array.isArray((err as { issues?: unknown[] }).issues)) return false

  const status = (err as { status?: number }).status
  if (typeof status === 'number') {
    if (status === 429) return true
    if (status >= 500 && status < 600) return true
    return false
  }

  const code = (err as { code?: string }).code
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true

  return TRANSIENT_MSG.test(err.message)
}

function defaultLog(opName: string | undefined, attempt: number, max: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(`[retry] op=${opName ?? 'anon'} attempt=${attempt}/${max} err=${msg}`)
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 10_000
  const isRetryable = opts.isRetryable ?? defaultIsRetryable

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt >= attempts || !isRetryable(err)) throw err

      if (opts.onAttempt) opts.onAttempt(attempt, err)
      else defaultLog(opts.opName, attempt, attempts, err)

      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
      const delay = Math.floor(Math.random() * cap)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
```

- [ ] **Step 2.4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/retry.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/services/retry.ts tests/unit/retry.test.ts
git commit -m "$(cat <<'EOF'
feat(retry): add withRetry helper with exponential-backoff + full-jitter

Generic helper for wrapping external API calls; retries on HTTP 429/5xx and
transient network errors, never on 4xx/Zod/TypeError. Used in subsequent
commits by AssemblyAI / OpenAI / Anthropic services. YouTubeService is
deliberately excluded.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wrap AssemblyAI calls with `withRetry`

**Files:**
- Modify: `src/services/assemblyai.ts`
- Test: `tests/unit/assemblyai.test.ts`

- [ ] **Step 3.1: Write the failing test (retry wired through)**

Append to `tests/unit/assemblyai.test.ts`:

```typescript
describe('AssemblyAIService retry behavior', () => {
  it('retries transcripts.submit on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3') },
      transcripts: {
        submit: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { id: 'tx-1' }
        }),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    const result = await svc.submit('/tmp/x.mp3')
    expect(result.assemblyaiId).toBe('tx-1')
    expect(client.transcripts.submit).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry transcripts.submit on 400', async () => {
    const err = new Error('bad audio') as Error & { status?: number }
    err.status = 400
    const client = {
      files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3') },
      transcripts: {
        submit: vi.fn(async () => { throw err }),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    await expect(svc.submit('/tmp/x.mp3')).rejects.toThrow('bad audio')
    expect(client.transcripts.submit).toHaveBeenCalledTimes(1)
  })

  it('retries files.upload on 429', async () => {
    let n = 0
    const client = {
      files: {
        upload: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('rate limited') as Error & { status?: number }
            err.status = 429
            throw err
          }
          return 'https://uploaded/audio.mp3'
        }),
      },
      transcripts: {
        submit: vi.fn(async () => ({ id: 'tx-1' })),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    await svc.submit('/tmp/x.mp3')
    expect(client.files.upload).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 3.2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/assemblyai.test.ts -t 'retry behavior'
```

Expected: 3 tests fail (`submit` called only once on transient failure).

- [ ] **Step 3.3: Wrap call sites in `src/services/assemblyai.ts`**

Add an import at the top of `src/services/assemblyai.ts` (after existing imports):

```typescript
import { withRetry } from './retry.js'
```

Replace the `submit` method body (currently lines 33-41):

```typescript
  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    const audio_url = await withRetry(
      () => this.client.files.upload(audioPath),
      { opName: 'assemblyai.files.upload' },
    )
    const { id } = await withRetry(
      () => this.client.transcripts.submit({
        audio_url,
        speaker_labels: true,
        speech_models: [...SPEECH_MODELS],
      }),
      { opName: 'assemblyai.transcripts.submit' },
    )
    return { assemblyaiId: id }
  }
```

Replace the `getStatus` method's first line (currently `const t = await this.client.transcripts.get(transcriptionId)` at line 44):

```typescript
    const t = await withRetry(
      () => this.client.transcripts.get(transcriptionId),
      { opName: 'assemblyai.transcripts.get.status' },
    )
```

Replace the `getResult` method's first line (currently `const t = await this.client.transcripts.get(transcriptionId)` at line 57):

```typescript
    const t = await withRetry(
      () => this.client.transcripts.get(transcriptionId),
      { opName: 'assemblyai.transcripts.get.result' },
    )
```

- [ ] **Step 3.4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/assemblyai.test.ts
```

Expected: all `AssemblyAIService` tests pass (existing + 3 new).

- [ ] **Step 3.5: Commit**

```bash
git add src/services/assemblyai.ts tests/unit/assemblyai.test.ts
git commit -m "$(cat <<'EOF'
feat(assemblyai): wrap SDK calls in withRetry for transient failures

Retries files.upload, transcripts.submit, and transcripts.get on 429/5xx and
transient network errors. Surfaces 4xx and validation errors immediately.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wrap OpenAI embeddings with `withRetry`

**Files:**
- Modify: `src/services/embeddings.ts`
- Test: `tests/unit/embeddings.test.ts`

- [ ] **Step 4.1: Write the failing test**

Append to `tests/unit/embeddings.test.ts`:

```typescript
describe('OpenAIEmbeddingService retry behavior', () => {
  it('retries embeddings.create on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      embeddings: {
        create: vi.fn(async ({ input }: { input: string[] }) => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { data: input.map(() => ({ embedding: [0.1] })) }
        }),
      },
    }
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 10 })
    const result = await svc.embed(['a', 'b'])
    expect(result).toEqual([[0.1], [0.1]])
    expect(client.embeddings.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry embeddings.create on 400', async () => {
    const err = new Error('invalid input') as Error & { status?: number }
    err.status = 400
    const client = { embeddings: { create: vi.fn(async () => { throw err }) } }
    const svc = new OpenAIEmbeddingService(client as any)
    await expect(svc.embed(['a'])).rejects.toThrow('invalid input')
    expect(client.embeddings.create).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 4.2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/embeddings.test.ts -t 'retry behavior'
```

Expected: first test fails (`create` called only once on transient).

- [ ] **Step 4.3: Wrap call site in `src/services/embeddings.ts`**

Add import at the top of `src/services/embeddings.ts`:

```typescript
import { withRetry } from './retry.js'
```

Replace the `embed` method body (currently lines 31-40):

```typescript
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const res = await withRetry(
        () => this.client.embeddings.create({ input: batch, model: this.model }),
        { opName: 'openai.embeddings.create' },
      )
      for (const item of res.data) out.push(item.embedding)
    }
    return out
  }
```

- [ ] **Step 4.4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/embeddings.test.ts
```

Expected: all `OpenAIEmbeddingService` tests pass (existing + 2 new).

- [ ] **Step 4.5: Commit**

```bash
git add src/services/embeddings.ts tests/unit/embeddings.test.ts
git commit -m "$(cat <<'EOF'
feat(embeddings): wrap OpenAI embeddings.create in withRetry

Retries each batch on 429/5xx and transient network errors. Prevents a single
rate-limit hit from forfeiting a completed transcription.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wrap Claude LLM with `withRetry`

**Files:**
- Modify: `src/services/llm.ts`
- Test: `tests/unit/llm.test.ts`

- [ ] **Step 5.1: Inspect existing test file**

```bash
head -60 tests/unit/llm.test.ts
```

Confirm the test file uses a `ClientLike` mock for `client.messages.create`. The test additions below follow that pattern.

- [ ] **Step 5.2: Write the failing test**

Append to `tests/unit/llm.test.ts`:

```typescript
describe('ClaudeLLMService retry behavior', () => {
  it('retries client.messages.create on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      messages: {
        create: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { content: [{ type: 'text', text: 'A summary.' }] }
        }),
      },
    }
    const svc = new ClaudeLLMService(client as any)
    const result = await svc.summarizeTalk('some transcript')
    expect(result).toBe('A summary.')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry client.messages.create on 400', async () => {
    const err = new Error('bad prompt') as Error & { status?: number }
    err.status = 400
    const client = { messages: { create: vi.fn(async () => { throw err }) } }
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.summarizeTalk('x')).rejects.toThrow('bad prompt')
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })
})
```

If `vi` and `ClaudeLLMService` are not already imported in the existing test file, add at the top:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { ClaudeLLMService } from '../../src/services/llm.js'
```

(Skip imports that are already present.)

- [ ] **Step 5.3: Run tests, verify they fail**

```bash
npx vitest run tests/unit/llm.test.ts -t 'retry behavior'
```

Expected: first test fails (`create` called only once on transient).

- [ ] **Step 5.4: Wrap call site in `src/services/llm.ts`**

Add import at the top of `src/services/llm.ts` (after existing imports):

```typescript
import { withRetry } from './retry.js'
```

Replace the `invoke` method body (currently lines 35-44):

```typescript
  private async invoke(system: string, user: string, maxTokens = 4096): Promise<string> {
    const res = await withRetry(
      () => this.client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      { opName: 'anthropic.messages.create' },
    )
    const blocks = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string')
    return blocks.map((b) => b.text as string).join('\n').trim()
  }
```

- [ ] **Step 5.5: Run tests, verify they pass**

```bash
npx vitest run tests/unit/llm.test.ts
```

Expected: all `ClaudeLLMService` tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add src/services/llm.ts tests/unit/llm.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): wrap Anthropic messages.create in withRetry

Retries summarize/segment/QA/FAQ calls on 429/5xx and transient network
errors. Covers ~20-30 per-talk summarization calls in a multi-hour run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Static guard — no retry in `YouTubeService`

**Files:**
- Modify: `src/services/youtube.ts` (one banner comment, no logic change)
- Create: `tests/unit/youtube-no-retry.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `tests/unit/youtube-no-retry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const YOUTUBE_SRC = resolve(__dirname, '../../src/services/youtube.ts')

describe('YouTubeService — no retry guard', () => {
  it('does not import or invoke withRetry', () => {
    const contents = readFileSync(YOUTUBE_SRC, 'utf8')
    expect(contents.includes('withRetry')).toBe(false)
  })

  it('contains the deliberate-non-wrap banner comment pointing at the spec', () => {
    const contents = readFileSync(YOUTUBE_SRC, 'utf8')
    expect(contents).toMatch(/9hour-parse-critical-fixes-design/)
  })
})
```

- [ ] **Step 6.2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/youtube-no-retry.test.ts
```

Expected: the banner-comment test fails (`youtube.ts` has no reference to the spec yet); the import test currently passes incidentally but the spec demands the explicit banner.

- [ ] **Step 6.3: Add banner comment to `src/services/youtube.ts`**

Prepend (above `import { exec as nodeExec } from 'node:child_process'`):

```typescript
// NOTE: YouTubeService is deliberately NOT wrapped with withRetry.
// Retrying yt-dlp invocations amplifies YouTube bot-detection signal and
// raises the risk of an account/IP block. On yt-dlp failure, the operator
// is expected to intervene manually (re-cookie, switch network, or fall
// back to manual audio upload).
//
// See docs/superpowers/specs/2026-05-25-9hour-parse-critical-fixes-design.md
// (Component 2) for the full rationale.
```

- [ ] **Step 6.4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/youtube-no-retry.test.ts
```

Expected: both tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/services/youtube.ts tests/unit/youtube-no-retry.test.ts
git commit -m "$(cat <<'EOF'
chore(youtube): document deliberate no-retry policy + add static guard

Static test asserts that src/services/youtube.ts contains no withRetry import
and references the design spec. Prevents future drift from accidentally
adding retries against YouTube and amplifying bot-detection signal.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `validateBoundaries` function

**Files:**
- Modify: `src/services/segmentation.ts`
- Test: `tests/unit/segmentation.test.ts`

- [ ] **Step 7.1: Write the failing tests**

Append to `tests/unit/segmentation.test.ts`:

```typescript
import { validateBoundaries } from '../../src/services/segmentation.js'

describe('validateBoundaries', () => {
  const good = [
    { title: 'Intro', speaker: '', startMs: 0, endMs: 5000 },
    { title: 'Talk 1', speaker: 'Alice', startMs: 5000, endMs: 13000 },
    { title: 'Talk 2', speaker: 'Bob', startMs: 13000, endMs: 24000 },
  ]

  it('passes on a valid contiguous boundary set', () => {
    expect(() => validateBoundaries(good, { audioDurationMs: 24000 })).not.toThrow()
  })

  it('throws on empty array', () => {
    expect(() => validateBoundaries([], { audioDurationMs: 24000 })).toThrow(/empty/i)
  })

  it('throws on zero-or-negative duration boundary, naming index', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 5000 },
      { title: 'B', speaker: '', startMs: 5000, endMs: 5000 },
      { title: 'C', speaker: '', startMs: 5000, endMs: 24000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 24000 })).toThrow(/boundary 1/)
  })

  it('throws on overlap, naming the offending index', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 6000 },
      { title: 'B', speaker: '', startMs: 5000, endMs: 13000 },
      { title: 'C', speaker: '', startMs: 13000, endMs: 24000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 24000 })).toThrow(/overlap.*boundary 1/i)
  })

  it('throws on gap larger than maxGapMs', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 5000 },
      { title: 'B', speaker: '', startMs: 200000, endMs: 240000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 240000 })).toThrow(/gap/i)
  })

  it('throws when intro starts after introMaxStartMs', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 90000, endMs: 100000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 100000 })).toThrow(/intro/i)
  })

  it('throws when last endMs covers less than minCoverageRatio of audio', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 50000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 100000 })).toThrow(/coverage/i)
  })

  it('respects custom minCoverageRatio', () => {
    const bs = [{ title: 'A', speaker: '', startMs: 0, endMs: 60000 }]
    expect(() =>
      validateBoundaries(bs, { audioDurationMs: 100000, minCoverageRatio: 0.5 })
    ).not.toThrow()
  })
})
```

- [ ] **Step 7.2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/segmentation.test.ts -t validateBoundaries
```

Expected: 8 tests fail with `validateBoundaries is not a function` or import error.

- [ ] **Step 7.3: Implement `validateBoundaries` in `src/services/segmentation.ts`**

Append to the end of `src/services/segmentation.ts`:

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
): void {
  if (boundaries.length === 0) {
    throw new Error('validateBoundaries: boundary array is empty')
  }

  const minCoverageRatio = opts.minCoverageRatio ?? 0.95
  const maxGapMs = opts.maxGapMs ?? 120_000
  const introMaxStartMs = opts.introMaxStartMs ?? 60_000

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    if (b.endMs <= b.startMs) {
      throw new Error(
        `validateBoundaries: boundary ${i} has non-positive duration ` +
        `(startMs=${b.startMs}, endMs=${b.endMs})`
      )
    }
  }

  for (let i = 0; i < boundaries.length - 1; i++) {
    const cur = boundaries[i]!
    const next = boundaries[i + 1]!
    if (next.startMs < cur.endMs) {
      throw new Error(
        `validateBoundaries: overlap between boundary ${i} (endMs=${cur.endMs}) ` +
        `and boundary ${i + 1} (startMs=${next.startMs})`
      )
    }
    const gap = next.startMs - cur.endMs
    if (gap > maxGapMs) {
      throw new Error(
        `validateBoundaries: gap of ${gap}ms between boundary ${i} and ${i + 1} ` +
        `exceeds maxGapMs=${maxGapMs}`
      )
    }
  }

  if (boundaries[0]!.startMs > introMaxStartMs) {
    throw new Error(
      `validateBoundaries: intro (boundary 0) starts at ${boundaries[0]!.startMs}ms, ` +
      `which exceeds introMaxStartMs=${introMaxStartMs}`
    )
  }

  const last = boundaries[boundaries.length - 1]!
  const required = opts.audioDurationMs * minCoverageRatio
  if (last.endMs < required) {
    throw new Error(
      `validateBoundaries: last boundary endMs=${last.endMs} covers less than ` +
      `${(minCoverageRatio * 100).toFixed(0)}% of audio duration ${opts.audioDurationMs}ms`
    )
  }
}
```

- [ ] **Step 7.4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/segmentation.test.ts
```

Expected: all `segmentation` tests pass (existing + 8 new `validateBoundaries` tests).

- [ ] **Step 7.5: Commit**

```bash
git add src/services/segmentation.ts tests/unit/segmentation.test.ts
git commit -m "$(cat <<'EOF'
feat(segmentation): add validateBoundaries sanity check

Asserts non-empty, non-zero duration, no overlaps, no large gaps, intro
near start, and >=95% audio coverage. Throws with the offending index in
the message so a malformed YouTube chapter set fails fast before embedding
and summarization burn LLM cost.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `validateBoundaries` into the segment step

**Files:**
- Modify: `src/workers/steps/segment.ts`
- Test: `tests/integration/pipeline-segment.test.ts`

- [ ] **Step 8.1: Write the failing test**

Append the following `describe` block to `tests/integration/pipeline-segment.test.ts` (after the existing `describe('runSegment', ...)` block, before EOF). It matches the existing file's import/setup conventions (`pool`, `insertSourceVideo`, `StepContext`, mock services, `tmpdir()`):

```typescript
describe('runSegment — boundary validation', () => {
  it('throws a descriptive error when chapters overlap', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/overlap',
      youtubeId: 'overlap',
    })
    const ctx: StepContext = {
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: 'tx-overlap', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService([], 'summary', 'answer'),
      tmpDir: tmpdir(),
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/overlap',
    }

    // transcription() fixture spans [0, 24000] via sampleUtterances.
    // Two overlapping chapters: [0,13000] and [5000,24000].
    const overlappingChapters = [
      { title: 'A', startMs: 0,    endMs: 13000 },
      { title: 'B', startMs: 5000, endMs: 24000 },
    ]

    await expect(
      runSegment(ctx, {
        transcription: transcription(),
        chapters: overlappingChapters,
        contentType: 'conference',
      })
    ).rejects.toThrow(/overlap/i)
  })
})
```

- [ ] **Step 8.2: Run test, verify it fails**

```bash
npm run test:integration -- -t 'boundary validation'
```

If Docker is not running first:

```bash
docker compose -f docker-compose.test.yml up -d
```

Then re-run.

Expected: the new test fails (`runSegment` currently does not call `validateBoundaries` and accepts overlapping chapters).

- [ ] **Step 8.3: Wire the call in `src/workers/steps/segment.ts`**

Add import (after existing imports):

```typescript
import { resolveSegmentationStrategy, sliceUtterancesByBoundary, validateBoundaries } from '../../services/segmentation.js'
```

(Replace the existing `import { resolveSegmentationStrategy, sliceUtterancesByBoundary } from '../../services/segmentation.js'` line with the line above.)

Insert validation immediately after `const boundaries: TalkBoundary[] = await strategy.segment(...)` (currently lines 30-35). After line 35 (`})`), add:

```typescript
  const audioDurationMs = input.transcription.utterances.length > 0
    ? Math.max(...input.transcription.utterances.map((u) => u.endMs))
    : 0
  validateBoundaries(boundaries, { audioDurationMs })
```

So the relevant block in `runSegment` reads:

```typescript
  const strategy = resolveSegmentationStrategy(input.contentType ?? 'auto')
  const boundaries: TalkBoundary[] = await strategy.segment({
    chapters: input.chapters,
    transcription: input.transcription,
    videoTitle: input.videoTitle,
    llm: ctx.llm,
  })
  const audioDurationMs = input.transcription.utterances.length > 0
    ? Math.max(...input.transcription.utterances.map((u) => u.endMs))
    : 0
  validateBoundaries(boundaries, { audioDurationMs })
```

- [ ] **Step 8.4: Run test, verify it passes**

```bash
npx vitest run tests/integration/pipeline-segment.test.ts
```

Expected: existing integration tests still pass; the new overlap test now passes (throws as expected).

- [ ] **Step 8.5: Commit**

```bash
git add src/workers/steps/segment.ts tests/integration/pipeline-segment.test.ts
git commit -m "$(cat <<'EOF'
feat(segment): validate chapter boundaries before embedding

runSegment now calls validateBoundaries(boundaries, { audioDurationMs })
after the strategy returns. Malformed YouTube chapters (overlaps, large
gaps, missing tail coverage) fail fast with a readable error rather than
silently producing a broken talk index.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Explicit `retryLimit: 0` on pg-boss enqueue

**Files:**
- Modify: `src/index.ts:29`

- [ ] **Step 9.1: Edit the enqueueJob closure**

In `src/index.ts:29`, the current line is:

```typescript
    enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
```

Replace with:

```typescript
    enqueueJob: async (data) =>
      (await boss.send(QUEUE_PIPELINE, data, { retryLimit: 0 })) ?? '',
```

- [ ] **Step 9.2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0, no errors. (If pg-boss's `send` typing rejects the third argument, see Step 9.3.)

- [ ] **Step 9.3: If typecheck fails on the third argument**

pg-boss accepts a `SendOptions` object as the third arg. If the TypeScript signature complains, cast the options:

```typescript
    enqueueJob: async (data) =>
      (await boss.send(QUEUE_PIPELINE, data, { retryLimit: 0 } as PgBoss.SendOptions)) ?? '',
```

The `PgBoss` namespace is already imported as the default `PgBoss` (line 1 of `src/index.ts`).

- [ ] **Step 9.4: Run the full unit suite (sanity)**

```bash
npm test
```

Expected: all unit tests pass — no test depends on `enqueueJob` internals.

- [ ] **Step 9.5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(queue): set explicit retryLimit:0 on pipeline job enqueue

pg-boss already defaults to no auto-retry, but encoding it explicitly
documents intent and prevents an accidental default change from causing
repeated yt-dlp invocations against YouTube on a failed pipeline run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Final verification

- [ ] **Step 10.1: Run full unit suite**

```bash
npm test
```

Expected: all green, including the new files (`retry.test.ts`, `youtube-no-retry.test.ts`) and extended files (`config.test.ts`, `assemblyai.test.ts`, `embeddings.test.ts`, `llm.test.ts`, `segmentation.test.ts`).

- [ ] **Step 10.2: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 10.3: Run integration suite (requires Docker test DB)**

```bash
npm run test:integration
```

Expected: all green, including the extended `pipeline-segment.test.ts`. If Docker is not running, start it first via `docker compose -f docker-compose.test.yml up -d`.

- [ ] **Step 10.4: Push branch**

```bash
git push -u origin feat/9hour-parse-critical-fixes
```

(Do not open a PR yet — user reviews locally first.)

- [ ] **Step 10.5: Hand off to user**

Report:
- Branch pushed: `feat/9hour-parse-critical-fixes`
- Commits: spec (Task 0, already on branch) + 9 task commits.
- Unit + typecheck + integration suite green.
- Ready for manual smoke: set `TRANSCRIPTION_POLL_TIMEOUT_MS=7200000` in Railway env (or accept the new default of 120 min), submit the 9-hour YouTube URL, watch `/videos/:id/status`.

---

## Spec coverage check

| Spec section | Task |
|---|---|
| Component 1 — configurable transcription poll timeout | Task 1 |
| Component 2 — `withRetry` helper | Task 2 |
| Component 2 — wrap AssemblyAI | Task 3 |
| Component 2 — wrap OpenAI embeddings | Task 4 |
| Component 2 — wrap Claude LLM | Task 5 |
| Component 2 — explicit non-wrap of YouTube + static guard | Task 6 |
| Component 3 — `validateBoundaries` function | Task 7 |
| Component 3 — call site in segment step | Task 8 |
| Component 4 — `retryLimit: 0` on pg-boss enqueue | Task 9 |
| Testing strategy (unit + integration + manual) | Task 10 + per-task tests |

No spec section unaccounted for.
