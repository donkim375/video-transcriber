# Frontend Plan — FE↔BE Integration (`ai-engineer-recap-fe/`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Next.js marketing site to the real backend: chat calls `POST /qa` via a Next.js proxy, the schedule section renders from `GET /talks`, and the FE has a real test framework (Vitest + RTL + MSW).

**Architecture:** Three thin Next.js Route Handlers under `app/api/` that proxy to `${NEXT_PUBLIC_API_URL}/...`. The Claude SDK stays on the backend. TDD throughout: every implementation task is preceded by a failing test.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind v4, Vitest, @testing-library/react, MSW v2.

**Working directory:** `/Users/donkim/Code/video-transcriber/ai-engineer-recap-fe/`

---

## Pre-flight

- [ ] **Step 0a: Confirm clean tree and pick a branch**

```bash
cd /Users/donkim/Code/video-transcriber/ai-engineer-recap-fe
git status
git checkout -b feat/fe-be-integration
```

- [ ] **Step 0b: Install deps from lockfile**

```bash
pnpm install   # or npm install — match whichever lockfile is committed
```
Expected: completes without errors.

- [ ] **Step 0c: Confirm a baseline build works**

```bash
pnpm run build   # or npm run build
```
Expected: build succeeds. If broken before you start, stop and surface it.

---

## Task 1: Add the test framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1.1: Install dev dependencies**

```bash
pnpm add -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom msw
```

- [ ] **Step 1.2: Add test scripts to `package.json`**

In the `scripts` block of `package.json`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Final `scripts` block should be:

```json
"scripts": {
  "dev": "next dev -p 3001",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Note the `-p 3001` on `dev` — backend already owns port 3000.

- [ ] **Step 1.3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    include: ['app/**/*.test.{ts,tsx}', 'components/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
```

- [ ] **Step 1.4: Create `tests/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
```

- [ ] **Step 1.5: Verify the test runner boots (no tests yet — should exit 0)**

```bash
pnpm test
```
Expected: `No test files found, exiting with code 0` (or similar). Not a failure.

- [ ] **Step 1.6: Commit the framework setup**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts tests/setup.ts
git commit -m "chore: add vitest + RTL + MSW test framework"
```

---

## Task 2: Env config

**Files:**
- Create: `.env.local`
- Create: `.env.example`

- [ ] **Step 2.1: Add `.env.example` so future contributors know the var name**

```bash
echo "NEXT_PUBLIC_API_URL=http://localhost:3000" > .env.example
```

- [ ] **Step 2.2: Add `.env.local` for local dev (gitignored by Next.js by default)**

```bash
echo "NEXT_PUBLIC_API_URL=http://localhost:3000" > .env.local
```

Confirm `.env.local` is in `.gitignore`:

```bash
grep -E "^\.env\.local$|^\.env\*\.local$" .gitignore || echo ".env*.local" >> .gitignore
```

- [ ] **Step 2.3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: declare NEXT_PUBLIC_API_URL env var"
```

---

## Task 3: RED — `/api/qa` proxy route

**Files:**
- Create: `app/api/qa/route.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `app/api/qa/route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const originalFetch = global.fetch

describe('POST /api/qa', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://backend.test'
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.NEXT_PUBLIC_API_URL
  })

  it('forwards body to BACKEND/qa and returns the backend response verbatim', async () => {
    const backendBody = { answer: 'hello', sources: [], citations: [] }
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(backendBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const { POST } = await import('./route')
    const req = new Request('http://app.test/api/qa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is RAG?' }),
    })
    const res = await POST(req as any)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/qa',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ question: 'What is RAG?' }),
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(backendBody)
  })

  it('returns 502 when NEXT_PUBLIC_API_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_API_URL
    const { POST } = await import('./route')
    const req = new Request('http://app.test/api/qa', {
      method: 'POST',
      body: JSON.stringify({ question: 'x' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'backend url not configured' })
  })
})
```

Add `import { afterEach } from 'vitest'` to the imports if your linter requires explicit imports.

- [ ] **Step 3.2: Run the test, verify it FAILS**

```bash
pnpm test app/api/qa/route.test.ts
```
Expected: fails with module-not-found `./route`.

- [ ] **Step 3.3: Commit**

```bash
git add app/api/qa/route.test.ts
git commit -m "red: /api/qa proxy forwards body and handles missing env"
```

---

## Task 4: GREEN — implement `/api/qa`

**Files:**
- Create: `app/api/qa/route.ts`

- [ ] **Step 4.1: Write the route handler**

```ts
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  if (!apiUrl) {
    return NextResponse.json({ error: 'backend url not configured' }, { status: 502 })
  }

  const body = await request.text()
  const res = await fetch(`${apiUrl}/qa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 4.2: Run the tests, verify they PASS**

```bash
pnpm test app/api/qa/route.test.ts
```
Expected: both tests green.

- [ ] **Step 4.3: Commit**

```bash
git add app/api/qa/route.ts
git commit -m "green: add /api/qa proxy route"
```

---

## Task 5: RED — `/api/talks` proxy route

**Files:**
- Create: `app/api/talks/route.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const originalFetch = global.fetch

describe('GET /api/talks', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://backend.test'
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.NEXT_PUBLIC_API_URL
  })

  it('forwards query params and returns backend rows verbatim', async () => {
    const rows = [
      { id: 't1', title: 'Vectors', day_label: 'Day 1', youtube_id: 'abc', start_ms: 0, youtube_deep_link: 'https://youtu.be/abc?t=0' },
    ]
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const { GET } = await import('./route')
    const req = new Request('http://app.test/api/talks?limit=100&conference=AIE')
    const res = await GET(req as any)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/talks?limit=100&conference=AIE',
      expect.objectContaining({ method: 'GET' })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rows)
  })

  it('returns 502 when NEXT_PUBLIC_API_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_API_URL
    const { GET } = await import('./route')
    const req = new Request('http://app.test/api/talks')
    const res = await GET(req as any)
    expect(res.status).toBe(502)
  })
})
```

- [ ] **Step 5.2: Run, verify FAIL**

```bash
pnpm test app/api/talks/route.test.ts
```
Expected: module-not-found for `./route`.

- [ ] **Step 5.3: Commit**

```bash
git add app/api/talks/route.test.ts
git commit -m "red: /api/talks proxy forwards query params"
```

---

## Task 6: GREEN — implement `/api/talks`

**Files:**
- Create: `app/api/talks/route.ts`

- [ ] **Step 6.1: Write the route**

```ts
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  if (!apiUrl) {
    return NextResponse.json({ error: 'backend url not configured' }, { status: 502 })
  }

  const incoming = new URL(request.url)
  const target = `${apiUrl}/talks${incoming.search}`
  const res = await fetch(target, { method: 'GET' })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 6.2: Run, verify PASS**

```bash
pnpm test app/api/talks/route.test.ts
```

- [ ] **Step 6.3: Commit**

```bash
git add app/api/talks/route.ts
git commit -m "green: add /api/talks proxy route"
```

---

## Task 7: RED + GREEN — `/api/search` proxy (mirror of `/api/qa`)

**Files:**
- Create: `app/api/search/route.test.ts`
- Create: `app/api/search/route.ts`

- [ ] **Step 7.1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const originalFetch = global.fetch

describe('POST /api/search', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://backend.test'
    global.fetch = vi.fn()
  })
  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.NEXT_PUBLIC_API_URL
  })

  it('forwards body to BACKEND/search', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    const { POST } = await import('./route')
    const req = new Request('http://app.test/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'rag', limit: 5 }),
    })
    const res = await POST(req as any)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/search',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'rag', limit: 5 }) })
    )
    expect(res.status).toBe(200)
  })

  it('returns 502 when env missing', async () => {
    delete process.env.NEXT_PUBLIC_API_URL
    const { POST } = await import('./route')
    const res = await POST(new Request('http://app.test/api/search', { method: 'POST', body: '{}' }) as any)
    expect(res.status).toBe(502)
  })
})
```

- [ ] **Step 7.2: Run, verify FAIL**

```bash
pnpm test app/api/search/route.test.ts
```

- [ ] **Step 7.3: Implement the route — `app/api/search/route.ts`**

```ts
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  if (!apiUrl) {
    return NextResponse.json({ error: 'backend url not configured' }, { status: 502 })
  }
  const body = await request.text()
  const res = await fetch(`${apiUrl}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
```

- [ ] **Step 7.4: Run, verify PASS**

```bash
pnpm test app/api/search/route.test.ts
```

- [ ] **Step 7.5: Commit both red+green together (small enough)**

```bash
git add app/api/search/route.ts app/api/search/route.test.ts
git commit -m "feat: add /api/search proxy route with tests"
```

---

## Task 8: RED — `ChatSection` component behavior

**Files:**
- Create: `components/chat-section.test.tsx`

- [ ] **Step 8.1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatSection } from './chat-section'

const originalFetch = global.fetch

describe('<ChatSection />', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { global.fetch = originalFetch })

  it('sends a question to /api/qa and renders the answer + a citation link', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        answer: 'RAG retrieves chunks before answering.',
        sources: [],
        citations: [
          {
            video_id: 'sv1',
            video_title: 'Day 1: Vectors',
            day_label: 'Day 1',
            talk_id: 't1',
            talk_title: 'Vectors',
            start_ms: 30000,
            youtube_deeplink: 'https://youtu.be/abc?t=30',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    render(<ChatSection />)
    await userEvent.type(screen.getByPlaceholderText(/ask about the conference/i), 'what is rag?')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(screen.getByText(/rag retrieves chunks/i)).toBeInTheDocument()
    })
    const link = screen.getByRole('link', { name: /day 1: vectors/i })
    expect(link).toHaveAttribute('href', 'https://youtu.be/abc?t=30')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/qa',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ question: 'what is rag?' }),
      })
    )
  })

  it('shows an error bubble when /api/qa returns 500', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
    )
    render(<ChatSection />)
    await userEvent.type(screen.getByPlaceholderText(/ask about the conference/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    })
  })
})
```

The Send button currently renders a `<Send />` icon with no `aria-label`. The test queries by role `button` with name `/send/i` — to make this work, the implementation in Task 9 will add `aria-label="Send"` to the button.

- [ ] **Step 8.2: Run, verify FAIL**

```bash
pnpm test components/chat-section.test.tsx
```
Expected: fails because the current `ChatSection` uses fake streaming, not `/api/qa`, and the Send button has no accessible name.

- [ ] **Step 8.3: Commit**

```bash
git add components/chat-section.test.tsx
git commit -m "red: ChatSection calls /api/qa and renders citations"
```

---

## Task 9: GREEN — rewrite `ChatSection`

**Files:**
- Modify: `components/chat-section.tsx`

- [ ] **Step 9.1: Replace the component body**

Replace the entire contents of `components/chat-section.tsx` with:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Send } from 'lucide-react'

interface Citation {
  video_id: string
  video_title: string | null
  day_label: string | null
  talk_id: string
  talk_title: string | null
  start_ms: number
  youtube_deeplink: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  citations?: Citation[]
}

const suggestedQuestions = [
  'Summarize talk on evals',
  'Key ideas about harness engineering',
  'Fetch timestamps on model inference',
  'Compare approaches across sessions',
]

export function ChatSection() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'assistant', content: 'Ask me anything about the talk ideas.' },
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  async function handleSendMessage(text?: string) {
    const question = (text ?? input).trim()
    if (!question || isLoading) return

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: question }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setIsLoading(true)

    try {
      const res = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = (await res.json()) as { answer: string; citations: Citation[] }
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: data.answer, citations: data.citations },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', content: 'Something went wrong. Try again.' },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section className="py-20 px-4 border-t border-border">
      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h2 className="text-3xl md:text-4xl font-serif text-white mb-4">Ask about the Conference</h2>
          <p className="text-white/60">Explore insights and key takeaways from AI Engineer Singapore 2026</p>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="h-96 overflow-y-auto p-6 space-y-4 bg-black/20">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`px-4 py-2 rounded-lg max-w-xs lg:max-w-md ${
                    message.role === 'user'
                      ? 'bg-white/10 text-white'
                      : message.role === 'error'
                      ? 'bg-red-500/10 text-red-300'
                      : 'bg-white/5 text-white/80'
                  }`}
                >
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                  {message.citations && message.citations.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs">
                      {message.citations.map((c) => (
                        <li key={c.talk_id + c.start_ms}>
                          <a
                            href={c.youtube_deeplink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline text-white/70 hover:text-white"
                          >
                            {c.video_title ?? c.talk_title ?? 'source'}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="px-4 py-2 rounded-lg bg-white/5">
                  <div className="flex gap-2">
                    <div className="w-2 h-2 bg-white/60 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-white/60 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <div className="w-2 h-2 bg-white/60 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-border bg-black/40 space-y-4">
            {messages.length === 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {suggestedQuestions.map((question, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendMessage(question)}
                    className="px-3 py-2 text-sm rounded-full border border-white/20 text-white/70 hover:bg-white/5 hover:text-white transition-all"
                  >
                    {question}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isLoading) handleSendMessage()
                }}
                placeholder="Ask about the conference..."
                className="flex-1 bg-white/5 border-white/10 text-white placeholder:text-white/40"
                disabled={isLoading}
              />
              <Button
                onClick={() => handleSendMessage()}
                disabled={!input.trim() || isLoading}
                size="icon"
                aria-label="Send"
                className="bg-white text-black hover:bg-white/90"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
```

Notable changes from the original:
- Real `/api/qa` call, no `setInterval` fake stream.
- New `'error'` role for failure bubble (red tint).
- `aria-label="Send"` on the Send button so RTL can find it by role/name.
- Citations rendered as a `<ul>` under the assistant bubble.
- `onKeyPress` replaced with `onKeyDown` (React 19 deprecation).

- [ ] **Step 9.2: Run the test, verify PASS**

```bash
pnpm test components/chat-section.test.tsx
```

- [ ] **Step 9.3: Commit**

```bash
git add components/chat-section.tsx
git commit -m "green: ChatSection calls /api/qa and renders citations"
```

---

## Task 10: RED — `ScheduleSection` reads from `/api/talks`

**Files:**
- Create: `components/schedule-section.test.tsx`

- [ ] **Step 10.1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScheduleSection } from './schedule-section'

const originalFetch = global.fetch

describe('<ScheduleSection />', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { global.fetch = originalFetch })

  it('renders talks grouped by day_label, sorted by start_ms', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: 't2', title: 'Vectors part 2', speaker: 'A', day_label: 'Day 1', youtube_id: 'abc', start_ms: 60000, end_ms: 120000, youtube_deep_link: 'https://youtu.be/abc?t=60', talk_index: 1 },
        { id: 't1', title: 'Vectors part 1', speaker: 'A', day_label: 'Day 1', youtube_id: 'abc', start_ms: 0, end_ms: 60000, youtube_deep_link: 'https://youtu.be/abc?t=0', talk_index: 0 },
        { id: 't3', title: 'Closing', speaker: 'B', day_label: 'Day 2', youtube_id: 'def', start_ms: 0, end_ms: 30000, youtube_deep_link: 'https://youtu.be/def?t=0', talk_index: 0 },
      ]), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    render(<ScheduleSection />)

    await waitFor(() => {
      expect(screen.getByText('Vectors part 1')).toBeInTheDocument()
    })
    // Day 1 tab is active by default; both Day 1 talks shown, Day 2 talk hidden
    const titlesDay1 = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(titlesDay1).toEqual(['Vectors part 1', 'Vectors part 2'])

    // Switch to Day 2
    await userEvent.click(screen.getByRole('tab', { name: /day 2/i }))
    await waitFor(() => {
      expect(screen.getByText('Closing')).toBeInTheDocument()
    })

    // Watch link uses youtube_deep_link
    const watchLinks = screen.getAllByRole('link', { name: /watch/i })
    expect(watchLinks[0]).toHaveAttribute('href', 'https://youtu.be/def?t=0')
  })

  it('shows an error banner when /api/talks fails', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response('{}', { status: 500 })
    )
    render(<ScheduleSection />)
    await waitFor(() => {
      expect(screen.getByText(/couldn.t load the schedule/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 10.2: Run, verify FAIL**

```bash
pnpm test components/schedule-section.test.tsx
```
Expected: fails — current `ScheduleSection` uses `scheduleData` from a static file and doesn't fetch.

- [ ] **Step 10.3: Commit**

```bash
git add components/schedule-section.test.tsx
git commit -m "red: ScheduleSection fetches /api/talks and groups by day_label"
```

---

## Task 11: GREEN — rewrite `ScheduleSection`, delete static schedule

**Files:**
- Modify: `components/schedule-section.tsx`
- Delete: `lib/schedule-data.ts`

- [ ] **Step 11.1: Delete the static schedule file**

```bash
git rm lib/schedule-data.ts
```

- [ ] **Step 11.2: Replace the component**

Replace the entire contents of `components/schedule-section.tsx` with:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExternalLink } from 'lucide-react'

interface TalkRow {
  id: string
  title: string | null
  speaker: string | null
  day_label: string | null
  youtube_id: string | null
  start_ms: number
  end_ms: number
  youtube_deep_link: string | null
  talk_index: number
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ScheduleSection() {
  const [talks, setTalks] = useState<TalkRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeDay, setActiveDay] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/talks?limit=100')
        if (!res.ok) throw new Error(`status ${res.status}`)
        const rows = (await res.json()) as TalkRow[]
        if (cancelled) return
        setTalks(rows)
        const firstDay = rows.find((r) => r.day_label)?.day_label
        if (firstDay) setActiveDay(firstDay)
      } catch {
        if (!cancelled) setError("Couldn't load the schedule. Try again later.")
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <section className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 py-20">
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      </section>
    )
  }

  if (!talks) {
    return (
      <section className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 py-20">
          <p className="text-white/40 text-sm">Loading schedule…</p>
        </div>
      </section>
    )
  }

  const days = Array.from(new Set(talks.map((t) => t.day_label ?? 'Unscheduled')))
  const grouped: Record<string, TalkRow[]> = {}
  for (const day of days) grouped[day] = []
  for (const t of talks) grouped[t.day_label ?? 'Unscheduled'].push(t)
  for (const day of days) grouped[day].sort((a, b) => a.start_ms - b.start_ms)

  const currentDay = activeDay && grouped[activeDay] ? activeDay : days[0] ?? ''

  return (
    <section className="border-t border-border">
      <div className="max-w-5xl mx-auto px-4 py-20">
        <div className="mb-12">
          <h2 className="text-3xl md:text-4xl font-serif text-white mb-4">Conference Schedule</h2>
          <p className="text-white/60 text-sm">May 16 - 17, 2026 | Singapore</p>
        </div>

        <Tabs value={currentDay} onValueChange={setActiveDay} className="w-full">
          <TabsList className={`grid w-full max-w-md grid-cols-${Math.max(days.length, 1)} bg-white/5 border border-white/10 p-1 mb-8`}>
            {days.map((d) => (
              <TabsTrigger
                key={d}
                value={d}
                className="data-[state=active]:bg-white data-[state=active]:text-black text-white/60 text-sm"
              >
                {d}
              </TabsTrigger>
            ))}
          </TabsList>

          {days.map((d) => (
            <TabsContent key={d} value={d} className="space-y-2">
              {grouped[d].map((talk) => (
                <div
                  key={talk.id}
                  className="flex gap-4 py-3 px-4 hover:bg-white/5 rounded transition-colors group border-b border-white/5 last:border-b-0"
                >
                  <div className="flex-shrink-0 w-20 text-sm font-mono text-white/60 group-hover:text-white/80 transition-colors">
                    {formatOffset(talk.start_ms)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-serif text-white group-hover:text-white/90 transition-colors mb-1">
                      {talk.title ?? 'Untitled'}
                    </h3>
                    {talk.speaker && <p className="text-xs text-white/40 mb-1">{talk.speaker}</p>}
                  </div>
                  <div className="flex-shrink-0 flex gap-2 items-center">
                    {talk.youtube_deep_link && (
                      <a
                        href={talk.youtube_deep_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-white/5 text-white/60 hover:bg-white hover:text-black transition-all border border-white/10 hover:border-white"
                      >
                        <span className="hidden sm:inline">Watch</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  )
}
```

- [ ] **Step 11.3: Run the test, verify PASS**

```bash
pnpm test components/schedule-section.test.tsx
```

- [ ] **Step 11.4: Build to catch any other compile errors (the page should still render with no `lib/schedule-data.ts`)**

```bash
pnpm run build
```
Expected: build succeeds. If it fails because `app/page.tsx` or another file still imports `scheduleData`, remove that import.

- [ ] **Step 11.5: Commit**

```bash
git add components/schedule-section.tsx lib/schedule-data.ts
git commit -m "green: ScheduleSection renders from /api/talks; remove static schedule data"
```

---

## Task 12: Full verification

- [ ] **Step 12.1: Run all tests**

```bash
pnpm test
```
Expected: every test passes.

- [ ] **Step 12.2: Typecheck via build**

```bash
pnpm run build
```
Expected: clean.

- [ ] **Step 12.3: Manual smoke (requires backend running on :3000)**

In one terminal: `cd ../video-transcriber && run_local npm run dev`.
In another: `pnpm dev` (FE on :3001).
Open `http://localhost:3001`:

  - Chat: type "What is harness engineering?", press Send. A real answer appears with at least one citation link.
  - Schedule: tabs reflect `day_label` values from the DB. "Watch" links open YouTube at the right timestamp.

If the DB is empty, the schedule shows the empty/loading state — that's fine. Submit at least one video via `curl POST /videos` (see `docs/videos-cli-guide.md` in the backend repo) if you want real data.

- [ ] **Step 12.4: Backend down test**

Kill the backend. In the FE:

  - Chat: send a message → error bubble appears.
  - Refresh page → schedule shows "Couldn't load the schedule" banner.

- [ ] **Step 12.5: Push the branch**

```bash
git push -u origin HEAD
```
Do **not** open a PR until the backend plan has merged or is also ready — the FE contract assumes the BE's enriched `/talks` shape.

---

## Done criteria

- `pnpm test` clean (≥ 9 tests passing across proxy routes + components).
- `pnpm run build` clean.
- `components/chat-section.tsx` no longer uses `setInterval` or `sampleResponses`.
- `lib/schedule-data.ts` deleted.
- Three proxy routes exist: `app/api/qa/route.ts`, `app/api/talks/route.ts`, `app/api/search/route.ts`.
- Manual chat + schedule flows work against a live backend.
- `NEXT_PUBLIC_API_URL` documented in `.env.example`.

## Out of scope

- Auth, streaming SSE, transcript downloads, `/api/videos` proxy, Playwright E2E.
- Storybook or visual-regression tests.
- Caching on the proxy routes.
