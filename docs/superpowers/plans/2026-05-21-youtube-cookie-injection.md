# YouTube Cookie Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `yt-dlp` on Railway to authenticate as a signed-in user via base64-encoded cookies, bypassing YouTube's bot detection.

**Architecture:** A new optional secret `YOUTUBE_COOKIES_B64` is parsed by `loadConfig`. At process boot, if set, a new `writeCookiesFile` helper decodes the base64, validates the Netscape header, and writes the cookies to `/tmp/youtube-cookies.txt` with mode `0600`. `YouTubeService` gains a `cookiesPath` constructor option and appends `--cookies <path>` to both `yt-dlp` invocations. In production, the secret is required; in dev it's optional.

**Tech Stack:** TypeScript, Node 22 (`node:fs`, `node:buffer`), zod, vitest, yt-dlp.

**Branch:** `feat/yt-dlp-cookies` (already created off `main`, spec committed at 23cfc1f).

**Spec:** `docs/superpowers/specs/2026-05-21-youtube-cookie-injection-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/services/youtube-cookies.ts` | Create | `writeCookiesFile(b64, dir?)` — decode, validate header, write `0600`, return path |
| `src/config.ts` | Modify | Add `YOUTUBE_COOKIES_B64` to zod schema + `AppConfig`; scrub from env; runtime check for prod |
| `src/services/youtube.ts` | Modify | Constructor accepts `cookiesPath?: string`; both commands include `--cookies <path>` when set |
| `src/index.ts` | Modify | At boot, call `writeCookiesFile` and pass `cookiesPath` to `new YouTubeService` |
| `src/worker.ts` | Modify | Same boot wiring as `src/index.ts` |
| `tests/unit/youtube-cookies.test.ts` | Create | Decode/validate/write/permissions; rejects bad inputs |
| `tests/unit/youtube.test.ts` | Modify | Both commands include `--cookies` when configured; omit when not |
| `tests/unit/config.test.ts` | Modify | Prod requires `YOUTUBE_COOKIES_B64`; dev tolerates absence; scrub from env |
| `docs/cloud-setup-tutorial.md` | Modify | New "Step 1.7 — Export YouTube cookies"; update Known Limitations |

---

## Task 1: `writeCookiesFile` module

**Files:**
- Create: `src/services/youtube-cookies.ts`
- Test: `tests/unit/youtube-cookies.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/youtube-cookies.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCookiesFile } from '../../src/services/youtube-cookies.js'

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File\n'
const SAMPLE_COOKIES = NETSCAPE_HEADER +
  '# https://curl.se/docs/http-cookies.html\n' +
  '.youtube.com\tTRUE\t/\tTRUE\t9999999999\tSID\tabc123\n'

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'cookies-test-'))
}

describe('writeCookiesFile', () => {
  it('decodes base64 and writes the file to <dir>/youtube-cookies.txt', () => {
    const dir = mkTmp()
    try {
      const path = writeCookiesFile(b64(SAMPLE_COOKIES), dir)
      expect(path).toBe(join(dir, 'youtube-cookies.txt'))
      expect(readFileSync(path, 'utf8')).toBe(SAMPLE_COOKIES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the file with mode 0600', () => {
    const dir = mkTmp()
    try {
      const path = writeCookiesFile(b64(SAMPLE_COOKIES), dir)
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts the alternate "# HTTP Cookie File" header', () => {
    const dir = mkTmp()
    try {
      const content = '# HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9\tSID\tx\n'
      const path = writeCookiesFile(b64(content), dir)
      expect(readFileSync(path, 'utf8')).toBe(content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when decoded content lacks a Netscape cookies header', () => {
    const dir = mkTmp()
    try {
      expect(() => writeCookiesFile(b64('not a cookies file\n'), dir))
        .toThrow(/Netscape cookies\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when the base64 decodes to empty bytes', () => {
    const dir = mkTmp()
    try {
      expect(() => writeCookiesFile('', dir)).toThrow(/Netscape cookies\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run tests/unit/youtube-cookies.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/youtube-cookies.js'`.

- [ ] **Step 3: Implement `writeCookiesFile`**

Create `src/services/youtube-cookies.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VALID_HEADERS = ['# Netscape HTTP Cookie File', '# HTTP Cookie File']

export function writeCookiesFile(b64: string, dir = '/tmp'): string {
  const decoded = Buffer.from(b64, 'base64').toString('utf8')
  const firstLine = decoded.split('\n', 1)[0] ?? ''
  if (!VALID_HEADERS.includes(firstLine)) {
    throw new Error(
      'Invalid YOUTUBE_COOKIES_B64: decoded content is not a Netscape cookies.txt file ' +
      '(expected first line to be "# Netscape HTTP Cookie File")'
    )
  }
  const path = join(dir, 'youtube-cookies.txt')
  writeFileSync(path, decoded, { mode: 0o600 })
  return path
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/unit/youtube-cookies.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/youtube-cookies.ts tests/unit/youtube-cookies.test.ts
git commit -m "feat(youtube-cookies): writeCookiesFile decodes base64 and writes 0600 file"
```

---

## Task 2: Config schema + production gate

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these to `tests/unit/config.test.ts` (inside the `describe('loadConfig', ...)` block, before the closing `})`):

```ts
  it('accepts an optional YOUTUBE_COOKIES_B64 and exposes it on AppConfig', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.YOUTUBE_COOKIES_B64 = 'eyJjb29raWUiOiAiZGF0YSJ9'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.youtubeCookiesB64).toBe('eyJjb29raWUiOiAiZGF0YSJ9')
  })

  it('scrubs YOUTUBE_COOKIES_B64 from process.env after loading', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.YOUTUBE_COOKIES_B64 = 'secret-cookie-value'
    const { loadConfig } = await import('../../src/config.js')
    loadConfig()
    expect(process.env.YOUTUBE_COOKIES_B64).toBeUndefined()
  })

  it('does not require YOUTUBE_COOKIES_B64 in development', async () => {
    process.env.NODE_ENV = 'development'
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.YOUTUBE_COOKIES_B64
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  it('throws when YOUTUBE_COOKIES_B64 missing in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.YOUTUBE_COOKIES_B64
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/YOUTUBE_COOKIES_B64.*required.*production/i)
  })
```

- [ ] **Step 2: Run the tests and verify the new ones fail**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — at least the production-gate test (`cfg.youtubeCookiesB64` will be `undefined` and the prod throw test will not throw).

- [ ] **Step 3: Update `src/config.ts`**

Replace the entire file contents with:

```ts
import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  YOUTUBE_COOKIES_B64: z.string().optional(),
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
  youtubeCookiesB64?: string
  port: number
  nodeEnv: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid config: ${issues}`)
  }
  const config: AppConfig = {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: parsed.data.SUPABASE_CONNECTION_STRING,
    assemblyaiApiKey: parsed.data.ASSEMBLYAI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    youtubeCookiesB64: parsed.data.YOUTUBE_COOKIES_B64,
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
  }

  if (config.nodeEnv === 'production' && !config.youtubeCookiesB64) {
    throw new Error(
      'Invalid config: YOUTUBE_COOKIES_B64 is required in production ' +
      '(see docs/cloud-setup-tutorial.md Step 1.7)'
    )
  }

  // Scrub secrets from process.env so npm packages loaded after this point cannot read them
  for (const key of [
    'ASSEMBLYAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'SUPABASE_CONNECTION_STRING', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'YOUTUBE_COOKIES_B64',
  ]) {
    delete process.env[key]
  }

  return config
}
```

- [ ] **Step 4: Run the tests and verify all pass**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS — original 2 tests + 4 new tests = 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat(config): YOUTUBE_COOKIES_B64 secret required in production"
```

---

## Task 3: `YouTubeService` `cookiesPath` option

**Files:**
- Modify: `src/services/youtube.ts`
- Test: `tests/unit/youtube.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these to `tests/unit/youtube.test.ts` (after the existing `describe('YouTubeService.downloadAudio', ...)` block, at the end of the file):

```ts
describe('YouTubeService with cookiesPath', () => {
  it('includes --cookies in getMetadata when cookiesPath is set', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec, cookiesPath: '/tmp/youtube-cookies.txt' })
    await svc.getMetadata('https://youtu.be/abc')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain(`--cookies '/tmp/youtube-cookies.txt'`)
  })

  it('includes --cookies in downloadAudio when cookiesPath is set', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const svc = new YouTubeService({ exec, cookiesPath: '/tmp/youtube-cookies.txt' })
    await svc.downloadAudio('https://youtu.be/abc', '/tmp/abc.mp3')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain(`--cookies '/tmp/youtube-cookies.txt'`)
  })

  it('omits --cookies when cookiesPath is undefined', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec })
    await svc.getMetadata('https://youtu.be/abc')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).not.toContain('--cookies')
  })
})
```

- [ ] **Step 2: Run the tests and verify the new ones fail**

Run: `npx vitest run tests/unit/youtube.test.ts`
Expected: FAIL — the constructor does not accept `cookiesPath`, and the commands do not contain `--cookies`.

- [ ] **Step 3: Update `src/services/youtube.ts`**

Replace the entire file contents with:

```ts
import { exec as nodeExec } from 'node:child_process'
import { promisify } from 'node:util'
import type { IYouTubeService } from '../interfaces/youtube.js'
import type { VideoMetadata } from '../types/index.js'

const execAsync = promisify(nodeExec)

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>

export class YouTubeService implements IYouTubeService {
  private exec: ExecFn
  private cookiesPath?: string
  constructor(opts: { exec?: ExecFn; cookiesPath?: string } = {}) {
    this.exec = opts.exec ?? ((cmd) => execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 }))
    this.cookiesPath = opts.cookiesPath
  }

  private cookiesFlag(): string {
    return this.cookiesPath ? ` --cookies ${shellQuote(this.cookiesPath)}` : ''
  }

  async getMetadata(url: string): Promise<VideoMetadata> {
    const safe = shellQuote(url)
    const { stdout } = await this.exec(
      `yt-dlp --no-warnings${this.cookiesFlag()} --dump-json --skip-download ${safe}`
    )
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
      `yt-dlp --no-warnings${this.cookiesFlag()} -x --audio-format mp3 -o ${safeOut} ${safeUrl}`
    )
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
```

- [ ] **Step 4: Run the tests and verify all pass**

Run: `npx vitest run tests/unit/youtube.test.ts`
Expected: PASS — original 4 tests + 3 new tests = 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/youtube.ts tests/unit/youtube.test.ts
git commit -m "feat(youtube): pass --cookies to yt-dlp when cookiesPath is configured"
```

---

## Task 4: Wire cookies file at boot in `index.ts` and `worker.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/worker.ts`

These two files have no unit tests (they are top-level entrypoints; verification is `npm run typecheck` + running the binaries). We do not add bespoke entrypoint tests; the integration is implicit via the other tests + manual deploy verification.

- [ ] **Step 1: Update `src/index.ts`**

Replace the entire file contents with:

```ts
import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'
import { QUEUE_PIPELINE } from './queues/jobs.js'
import { YouTubeService } from './services/youtube.js'
import { writeCookiesFile } from './services/youtube-cookies.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })
const cookiesPath = cfg.youtubeCookiesB64
  ? writeCookiesFile(cfg.youtubeCookiesB64)
  : undefined

async function main() {
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
  const app = await buildServer({
    pool,
    youtube: new YouTubeService({ cookiesPath }),
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

- [ ] **Step 2: Update `src/worker.ts`**

Replace the entire file contents with:

```ts
import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { registerPipelineWorker } from './workers/pipeline.worker.js'
import { YouTubeService } from './services/youtube.js'
import { writeCookiesFile } from './services/youtube-cookies.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'
import { QUEUE_PIPELINE } from './queues/jobs.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })
const cookiesPath = cfg.youtubeCookiesB64
  ? writeCookiesFile(cfg.youtubeCookiesB64)
  : undefined

async function main() {
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
  await registerPipelineWorker(boss, {
    pool,
    youtube: new YouTubeService({ cookiesPath }),
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

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/worker.ts
git commit -m "feat(boot): write cookies file at startup, inject path into YouTubeService"
```

---

## Task 5: Update the operator tutorial

**Files:**
- Modify: `docs/cloud-setup-tutorial.md`

- [ ] **Step 1: Read the current file to find insertion points**

Run: `wc -l docs/cloud-setup-tutorial.md` and open it. Locate two anchors:
  1. The end of "Step 1.6" (or whichever last numbered step in Section 1 currently exists) — new content goes immediately after it.
  2. The "Known limitations" / "Troubleshooting" section — add a row pointing at Step 1.7 for the bot-detection error.

- [ ] **Step 2: Add "Step 1.7 — Export YouTube cookies"**

Insert after the last existing step in the Supabase/Railway setup section (before the troubleshooting block):

```markdown
### Step 1.7 — Export YouTube cookies (required in production)

YouTube's bot detection blocks requests from cloud-server IP ranges. `yt-dlp`
on Railway must authenticate as a logged-in user via a cookies file.

1. Open a clean browser profile and sign in to a **dedicated** low-value
   YouTube account (do not use your main account).
2. Install the **"Get cookies.txt LOCALLY"** browser extension.
3. Visit `https://www.youtube.com`, open the extension, click **Export**, save
   `cookies.txt`.
4. Base64-encode the file:
   - macOS: `base64 -i cookies.txt | pbcopy`
   - Linux: `base64 -w0 cookies.txt | xclip -selection clipboard`
5. In Railway, open the **api** service → **Variables** → add a new variable:
   - Name: `YOUTUBE_COOKIES_B64`
   - Value: paste the base64 string
6. Repeat step 5 for the **worker** service (same value).
7. Trigger a redeploy on both services.

**Refresh:** When downloads start failing with `Sign in to confirm you're not
a bot`, repeat steps 3–7. Cookies usually last several weeks.
```

- [ ] **Step 3: Update Known Limitations / Troubleshooting**

Find the existing row or section that mentions "Sign in to confirm you're not a bot" (if it does not exist, add a new row to the troubleshooting table). Replace it with:

```markdown
| `yt-dlp` error: `Sign in to confirm you're not a bot` | `YOUTUBE_COOKIES_B64` missing or expired. See [Step 1.7](#step-17--export-youtube-cookies-required-in-production). |
```

If the troubleshooting block is freeform prose (not a table), add this paragraph at the end of it:

```markdown
**`yt-dlp` error: `Sign in to confirm you're not a bot`** — Your
`YOUTUBE_COOKIES_B64` secret is missing or expired. Re-export per
[Step 1.7](#step-17--export-youtube-cookies-required-in-production).
```

- [ ] **Step 4: Verify rendering**

Run: `grep -n "Step 1.7" docs/cloud-setup-tutorial.md`
Expected: at least two matches — the heading and the cross-reference.

- [ ] **Step 5: Commit**

```bash
git add docs/cloud-setup-tutorial.md
git commit -m "docs(cloud-tutorial): Step 1.7 export YouTube cookies"
```

---

## Task 6: Verification gate and PR

**Files:** none modified (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: PASS — all unit tests including the new 5 + 4 + 3 = 12 cases added in Tasks 1–3, plus everything that was already passing.

- [ ] **Step 2: Integration tests**

Run: `npm run test:integration`
Expected: PASS — no integration test was added or changed; this verifies we didn't accidentally break anything.

If you're working outside docker (e.g., the user said skip integration), at minimum run `npm run test`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Push branch**

Run: `git push -u origin feat/yt-dlp-cookies`
Expected: branch pushed; PR URL hint printed.

- [ ] **Step 5: Open PR**

Run:

```bash
gh pr create --title "feat: YouTube cookie injection for cloud yt-dlp" --body "$(cat <<'EOF'
## Summary
- Adds optional `YOUTUBE_COOKIES_B64` secret (base64-encoded Netscape `cookies.txt`).
- New `writeCookiesFile` helper decodes at boot and writes `/tmp/youtube-cookies.txt` with mode 0600.
- `YouTubeService` accepts a `cookiesPath` and appends `--cookies <path>` to both `yt-dlp` invocations.
- Required in production (fails fast on missing secret); optional in dev.
- Tutorial gains Step 1.7 with the export + refresh ritual.

Spec: `docs/superpowers/specs/2026-05-21-youtube-cookie-injection-design.md`

## Test plan
- [ ] `npm run test` passes (includes new unit tests for cookies file, config gate, and yt-dlp flag).
- [ ] `npm run typecheck` passes.
- [ ] On Railway: set `YOUTUBE_COOKIES_B64` on api + worker, redeploy, retry the previously-failing video, confirm pipeline reaches `completed`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review (controller)

**Spec coverage:**
- Config secret with prod gate → Task 2.
- `writeCookiesFile` helper with validation + 0600 → Task 1.
- `YouTubeService` cookiesPath in both calls → Task 3.
- Boot wiring in both processes → Task 4.
- Operator workflow / tutorial → Task 5.
- Verification + PR → Task 6.

**Placeholder scan:** none. Every step has the exact code or command.

**Type consistency:** `cookiesPath` (Task 3, Task 4), `youtubeCookiesB64` (Task 2, Task 4), `writeCookiesFile(b64, dir?)` (Task 1, Task 4) — all match.

**Refresh ritual** is described in both the spec and the tutorial task; no contradictions.
