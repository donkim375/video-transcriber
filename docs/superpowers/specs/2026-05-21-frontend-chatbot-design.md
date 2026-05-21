# Frontend Landing Page with AI Chatbot — Design Spec

**Date:** 2026-05-21
**Status:** Approved (pending user review of written spec)

## Problem

The video-transcriber backend has two `ready` videos (AI Engineer Singapore conference, Day 1 and Day 2) with full transcripts, segmented talks, embeddings, and a working `/qa` RAG endpoint. There is no public-facing way to consume this content. We need a frontend that lets the conference audience:

1. **View** the transcribed videos (read-only — no submission of new URLs).
2. **Chat** about the talks via the existing RAG pipeline.

## Goal

Ship a single-page Next.js site, deployed on Vercel, that style-matches https://ai.engineer/singapore and exposes the existing backend as a polished public experience.

## Non-Goals

- ❌ Video submission from the UI (only the backend `POST /videos` accepts new URLs)
- ❌ User auth / accounts
- ❌ Streaming chat responses (v1 ships non-streaming; revisit if latency is perceptible)
- ❌ Shareable conversation URLs / persisted chat history beyond browser memory
- ❌ Admin UI for managing videos or FAQs
- ❌ Search-by-keyword UI (the `POST /search` endpoint stays internal for v1)
- ❌ Mobile-bespoke design beyond responsive Tailwind defaults

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Browser (Vercel CDN)      │         │  Railway: Fastify API        │
│                            │  HTTPS  │                              │
│  Next.js 15 App Router     │ ──────▶ │  GET  /videos                │
│  Tailwind + shadcn/ui      │         │  GET  /faqs       (new)      │
│  In-memory chat state      │         │  POST /qa     (rate-limited) │
│                            │         │                              │
│  Env: NEXT_PUBLIC_API_URL  │         │  Env: CORS_ALLOWED_ORIGIN    │
└────────────────────────────┘         │       (Vercel URL)           │
                                       │                              │
                                       │  Worker (separate Railway    │
                                       │  service) — FAQ pre-gen step │
                                       │  added to pipeline           │
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                              ┌──────────────┐
                                              │  Supabase    │
                                              │  Postgres    │
                                              │              │
                                              │  + source_   │
                                              │    videos.   │
                                              │    faqs JSONB│
                                              │  + source_   │
                                              │    videos.   │
                                              │    day_label │
                                              └──────────────┘
```

## Page Structure (single route: `/`)

Scroll-driven vertical stack, three sections:

### Hero
- Background: muted, looping MP4 (`/public/hero.mp4`, user-provided, 10–30s, ~5–10MB)
- Overlay: scripted typewriter chat demo showing pre-written prompts and answers
  - Example prompts: `"Give me a summary of all the talks"`, `"How did Daytona manage sandboxes?"`
  - The demo does **not** call `/qa`; it's a hardcoded animation.
- Title + tagline
- Subtle scroll-cue indicator

### Chatbox (library-wide RAG)
- Section heading: "Ask the conference"
- Suggested-question chips (6–10 chips) above the input. Each chip is a pre-generated, cached FAQ; clicking returns the cached answer with **no LLM call**.
- Input field + send button
- Message list:
  - User messages right-aligned
  - Assistant messages left-aligned, with citation pills below
  - Citation pill format: `Day 1 · 14:32 — Daytona talk` → clicking opens `https://youtu.be/<id>?t=872` in a new tab
- Rate-limit handling: on 429, show a friendly message ("You've asked a lot of great questions — try again in ~N minutes")

### Schedule (Day-by-Day)
- Two sections: "Day 1" and "Day 2", each rendering a list of talks for that video
- Each talk: title + 1-line AI summary
- Click anywhere on a talk → opens YouTube at the talk's `start_ms` in a new tab
- No embedded player

### Footer
- Minimal: credit line + GitHub link

## Visual Style

Matched to https://ai.engineer/singapore via v0.dev:
1. Take a screenshot of the reference site
2. Paste into v0 with prompt: "Match this conference site's style for a recap page with hero + chatbot + schedule"
3. Iterate on v0 output until visual fidelity is acceptable
4. Export v0 output as the starting Next.js project

## Backend Changes

### 1. CORS

Install `@fastify/cors`, register in `src/server.ts`:
```ts
import cors from '@fastify/cors'
await app.register(cors, { origin: cfg.corsAllowedOrigin })
```
New env var `CORS_ALLOWED_ORIGIN` added to `src/config.ts` zod schema (required in production, defaults to `http://localhost:3001` in dev). Scrubbed from `process.env` like other secrets.

### 2. Rate limiting

Install `@fastify/rate-limit`. Apply globally with route-level overrides for `/qa` and `/search`:
- `/qa`, `/search`: 10 requests / hour / IP
- Other routes: 100 / hour / IP (cheap, prevents general abuse)

Returns `429` with `Retry-After` header. Body: `{"error":"rate_limit_exceeded","retry_after_seconds":N}`.

### 3. `/qa` citation extension

Current `/qa` response (verify during implementation) returns `{answer, sources?}`. Extend each source to:
```ts
type QaCitation = {
  video_id: string         // UUID of source_videos row
  video_title: string
  day_label: string | null // e.g. "Day 1"
  talk_id: string          // UUID of talks row
  talk_title: string
  start_ms: number         // talk start in ms (or chunk start, whichever is more useful)
  youtube_deeplink: string // built server-side: `https://youtu.be/${youtube_id}?t=${Math.floor(start_ms/1000)}`
}
```
Frontend renders the array as citation pills. No frontend timestamp math.

### 4. FAQ pre-generation worker step

New step in `src/workers/pipeline.worker.ts`, runs after `ready`:
- Input: `source_videos.id`
- Reads the video's talks (titles + summaries + transcripts) and chapters
- Calls Claude Sonnet with a prompt: "Generate 6 questions a curious visitor would ask, plus a concise grounded answer for each. Use only the provided transcript material."
- Returns `Array<{question: string, answer: string}>` (6 items)
- Stores in new column `source_videos.faqs JSONB`
- Idempotent: skip if `faqs` is already non-null
- Failures are non-fatal — video still reaches `ready`; FAQ retry is a separate concern (out of scope for v1)

Migration: add `faqs JSONB` and `day_label TEXT` to `source_videos` (one migration file, both columns).

Backfill: a one-off script `scripts/backfill-faqs.ts` that re-enqueues the FAQ step for both existing `ready` videos. Also manually sets `day_label` via SQL UPDATE (two rows).

### 5. New endpoint: `GET /faqs`

Returns the union of FAQ chips across all `ready` videos:
```ts
type FaqResponse = {
  faqs: Array<{
    question: string
    answer: string
    video_id: string
    video_title: string
    day_label: string | null
  }>
}
```
No pagination — the union of 2 videos × 6 chips = 12 items max, well within a single response.

Caching: response is mostly-static. Set `Cache-Control: public, max-age=300, stale-while-revalidate=3600`. Vercel/CDN can cache it; Railway returns it cheaply.

## Data Flow

### Chat query (real, hits LLM)
```
1. User types in chatbox → POST /qa { question: string, top_k?: 5 }
2. Backend: rate-limit check → embed question → vector search → top-K chunks
3. Backend: send chunks + question to Sonnet → answer
4. Backend: build citations (Day label, talk title, youtube_deeplink)
5. Response: { answer: string, citations: QaCitation[] }
6. Frontend: append to message list, render citation pills
```

### FAQ chip click (free, no LLM)
```
1. Page mounts → GET /faqs → array cached client-side
2. User clicks a chip
3. Frontend: append { user: question, assistant: cached.answer, citations: [{video,day_label,...}] } to message list
4. No backend call, no LLM token spent
```

### Schedule click
```
1. Page mounts → GET /videos → array of two ready videos
2. For each video: GET /videos/:id → talks array
3. Render Day 1 / Day 2 sections from sorted talks
4. Click on talk → window.open('https://youtu.be/<youtube_id>?t=<seconds>')
```

## Tech Stack

- Next.js 15 (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- No state management library — chat state is `useState<Message[]>`
- v0.dev for initial component generation from reference screenshot
- Vitest + React Testing Library for frontend tests

## Deployment

- **Frontend repo:** new GitHub repo `video-transcriber-frontend`
- **Deploy target:** Vercel, autodeploy from `main`
- **Frontend env var:** `NEXT_PUBLIC_API_URL=https://video-transcriber-production-bdad.up.railway.app`
- **Backend env var added on Railway:** `CORS_ALLOWED_ORIGIN=<Vercel production URL>`
- **Backend env var for local dev:** defaults to `http://localhost:3001` (Next.js default port + 1, since Railway dev runs on 3000)

## Testing

### Backend (this repo)
- Unit: FAQ-generation step with mocked LLM (asserts prompt construction + storage shape + idempotency)
- Route: `GET /faqs` returns the expected union shape
- Route: `POST /qa` includes citation fields with `youtube_deeplink` constructed correctly
- Route: rate limiter returns 429 with `Retry-After` after 11th call within an hour from one IP
- Existing 112 tests stay green

### Frontend (new repo)
- Chip click → message appended without fetch to `/qa`
- Send button → fetch to `/qa` called with current input
- Citation pill renders as `<a target="_blank">` with the deeplink from response
- 429 response → friendly inline error, send button re-enabled
- Snapshot tests for Hero, Chatbox, Schedule components

### E2E
- Skipped for v1. Add Playwright later if regressions appear.

## Operator Workflow

For future videos (added via backend `POST /videos` only):
1. Submit URL to Railway API as today
2. Pipeline runs to `ready` + new FAQ step
3. Operator manually sets `day_label` via SQL (`UPDATE source_videos SET day_label = 'Day 3' WHERE id = ...`)
4. Frontend's `GET /faqs` and `GET /videos` automatically include the new content; no deploy needed.

## Failure Modes

| Failure | User experience |
|---|---|
| `/qa` rate-limited | Friendly "try again in N minutes" message inline in chat |
| `/qa` 5xx | "Something went wrong — please try again" inline error; input re-enabled |
| `/faqs` 5xx on load | Chips section silently omitted; chatbox still works |
| Backend offline entirely | Page still renders (schedule data is static at build... actually no, /videos is dynamic — show a "service temporarily unavailable" banner above the chat section) |
| FAQ step fails for a video | Video still reaches `ready`; chips for that video are missing but everything else works |

## Open Decisions (for the plan, not blocking design approval)

- Exact prompt for FAQ generation (will draft in the plan)
- Whether `start_ms` in citations is talk-level or chunk-level (chunk is more precise, talk is more meaningful — likely chunk for now, easy to swap)
- Vercel custom domain (skip for v1, use `*.vercel.app`)
