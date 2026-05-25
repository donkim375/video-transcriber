# FE ↔ BE Integration — `ai-engineer-recap-fe` wires to `video-transcriber`

**Date:** 2026-05-25
**Status:** Draft, awaiting user review
**Scope:** Two repos, two parallel implementation plans, after this spec is approved.

## Goal

Make the v0-generated marketing site (`ai-engineer-recap-fe`) talk to the real backend (`video-transcriber`):

1. Chat box calls real RAG Q&A via `POST /qa` (Claude SDK stays on the backend — option **A** from brainstorm).
2. Schedule section pulls talks from `GET /talks` (no more hardcoded `lib/schedule-data.ts`).
3. `/faqs` endpoint deprecated and removed.
4. Backend-triggered `/videos` ingestion stays unchanged (out of scope here; CLI guide for that lives in `docs/videos-cli-guide.md`).

## Out of scope

- Streaming chat (SSE) — deferred per Q3.
- Auth — no auth on the existing endpoints, not changing.
- Playwright/E2E — separate effort.
- Transcript download links in `ScheduleSection` (no BE endpoint exists yet).
- Removing the `faqs` column on `source_videos` or the FAQ generation step in the worker.

## Architecture

```
Browser ──► ai-engineer-recap-fe (Next.js)
              ├─ ChatSection ─────► /api/qa     ──► BACKEND/qa     ──► Postgres + OpenAI (embed) + Anthropic (answer)
              ├─ ChatSection ─────► /api/search ──► BACKEND/search ──► Postgres + OpenAI (embed)
              └─ ScheduleSection ► /api/talks   ──► BACKEND/talks  ──► Postgres
```

- FE owns: page composition, three thin Next.js proxy route handlers, UI state. **No Claude SDK on the FE.**
- BE owns: all LLM/embedding calls, RAG, DB. `/faqs` removed.
- Boundary: HTTPS JSON. FE env var `NEXT_PUBLIC_API_URL` points to the backend (reused from prior config).
- Failure isolation: BE outage degrades chat + schedule with clear error states; FE keeps serving static content.

## Backend changes (`video-transcriber/`)

### Remove `/faqs`

- Delete `src/routes/faqs.ts`.
- Remove `registerFaqRoutes` import and registration in `src/server.ts` (lines 13, 35).
- Delete `getFaqsAcrossVideos` and `FaqRow` from `src/db/queries.ts` (lines 104–127 at time of writing).
- Delete any `/faqs` route tests under `tests/`.
- Leave the `faqs` column on `source_videos` and the FAQ generation step in the worker in place.

### Enrich `GET /talks`

Today `/talks` returns raw `talks` rows. The FE needs `day_label` (for day1/day2 grouping) and the source video's `youtube_id` (for fallback links).

Change `src/routes/talks.ts` list query to:

```sql
select t.*, sv.day_label, sv.youtube_id
  from talks t
  join source_videos sv on sv.id = t.source_video_id
 where ($1::text is null or t.conference = $1)
   and ($2::text is null or t.speaker = $2)
 order by t.created_at desc
 limit $3 offset $4
```

Row shape adds two fields; existing consumers unaffected.

### CORS

`corsAllowedOrigin` already comes from a single env var. The FE-as-proxy path is server-to-server, so CORS only matters if/when the browser hits the BE directly. Keep permissive in dev, strict (FE origin only) in prod. No code change required.

### Out of scope for BE

- `/qa` and `/search` are unchanged.
- `/videos*` are unchanged.

## Frontend changes (`ai-engineer-recap-fe/`)

### New proxy route handlers

All three read `process.env.NEXT_PUBLIC_API_URL`, forward the request, and propagate status. Return `502` with `{ error: "backend url not configured" }` if the env var is missing. All export `const dynamic = 'force-dynamic'`.

- `app/api/qa/route.ts` — `POST` → `${API}/qa`. Body: `{ question, talk_id? }`.
- `app/api/search/route.ts` — `POST` → `${API}/search`. Body: `{ query, talk_id?, limit? }`.
- `app/api/talks/route.ts` — `GET` → `${API}/talks` (passes through `conference`, `speaker`, `limit`, `offset` query params).

### `components/chat-section.tsx`

- Delete `sampleResponses` array and the `setInterval` fake-stream loop.
- Rewrite `handleSendMessage`: `await fetch('/api/qa', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question }) })`. Push one assistant message containing `data.answer`.
- Render `data.citations` as a compact list under the answer; each item links to `citation.youtube_deeplink` and shows `citation.video_title`.
- Loading state: existing bouncing dots until response arrives.
- Error state: render an error bubble with retry button; do not crash.
- Keep the four `suggestedQuestions`.

### `components/schedule-section.tsx`

- Delete `lib/schedule-data.ts`.
- Make `app/page.tsx` (or just `ScheduleSection`) fetch `/api/talks?limit=100` once on mount. No `conference` filter for v1 — we group by `day_label` instead and want every talk back. (Server Component preferred; client-side `useEffect` acceptable if simpler.)
- Group results by `day_label` to populate the two tabs. Talks with `day_label = null` go into a third "Unscheduled" tab only if any exist; otherwise skip that tab.
- Within each tab, sort by `start_ms` ascending. Format the offset as `H:MM` (e.g. `0:00`, `1:23:45`) for the time column.
- "Watch" button → `talk.youtube_deep_link`. Hide the "Transcript" button.
- Loading state: skeleton rows. Empty state: friendly message. Error state: banner.

### Env config

- Add `NEXT_PUBLIC_API_URL=http://localhost:3000` to `.env.local`. Configure on Vercel for preview + prod.
- BE dev port conflicts with FE dev port (both default to 3000). FE dev server runs on `:3001` (pin via `next dev -p 3001` in `package.json`).

### Out of scope for FE

- `/api/videos` proxy.
- `/api/faqs` (deprecated).
- Streaming.
- Auth.

## TDD approach (mandatory, both repos)

Failing tests written and committed **before** any implementation code. See [Memory: TDD required across both repos].

### Backend TDD sequence

1. **Red:** add test to `tests/routes/talks.test.ts` (or equivalent) asserting `GET /talks` rows include `day_label` and `youtube_id`. Run → fails.
2. **Red:** add test asserting `GET /faqs` returns `404`. Run → fails (currently 200).
3. **Green:** delete `/faqs`, modify `/talks` query. Tests pass.
4. **Cleanup:** delete `getFaqsAcrossVideos`, `FaqRow`, and the now-orphaned `/faqs` test file.
5. **Verify:** `npm test`, `npm run typecheck`, and `curl http://localhost:3000/health` all clean.

### Frontend TDD sequence

FE has no test framework today. Adding one is the first task.

1. **Setup:** install `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `msw`. Add `test`, `test:watch` scripts. Add `vitest.config.ts` and a setup file that registers MSW + RTL matchers. Commit.
2. **Red — proxy routes:**
   - `app/api/qa/route.test.ts`: forwards POST body to `${API}/qa`, returns BE response verbatim; returns 502 if env missing.
   - `app/api/talks/route.test.ts`: forwards query params; returns BE rows.
   - `app/api/search/route.test.ts`: same pattern as `/qa`.
3. **Red — components:**
   - `chat-section.test.tsx`: typing a question + clicking send calls `/api/qa` (MSW handler) and renders the answer text plus a citation link with the deeplink.
   - `chat-section.test.tsx`: BE returns 500 → error bubble appears, no crash.
   - `schedule-section.test.tsx`: with MSW returning two talks across `day_label = "day1"` and `"day2"` → both tabs populate; switching tabs shows the right talks sorted by `start_ms`.
4. **Green:** implement the proxy routes and the component rewrites until each test goes green.
5. **Refactor:** small cleanups only, no behavior change. Tests stay green.

### Per-PR gate (both repos)

- `npm test` clean.
- `npm run typecheck` (BE) / `next build` (FE) clean.
- Commit messages reference the test they satisfy (`red: …`, `green: …`, `refactor: …`).

## Data flow & error handling

### Chat happy path

1. User types question → ChatSection POSTs `{ question }` to `/api/qa`.
2. Next.js route forwards to `${API}/qa`.
3. BE embeds the question (OpenAI), retrieves 8 chunks (pgvector), builds context, calls Claude, assembles citations.
4. BE returns `{ answer, sources, citations }`.
5. FE renders one assistant message + citation links to `youtube_deeplink`.

### Schedule happy path

1. Page loads → fetches `/api/talks?limit=100` once.
2. Next.js route forwards to `${API}/talks?...`.
3. BE returns enriched talk rows.
4. FE groups by `day_label`, sorts each group by `start_ms`, renders tabs.

### Error matrix

| Failure | FE behavior | Surfaced as |
|---|---|---|
| `NEXT_PUBLIC_API_URL` unset | Route handler returns 502 | Error toast / banner |
| BE unreachable (fetch throws) | Route handler returns 502 | Error toast / banner |
| BE returns 4xx | Forward status; chat error bubble with retry | Chat bubble / schedule banner |
| BE returns 5xx | Forward status; same as above | Same |
| `/talks` returns empty | Render empty state | Friendly message |
| `/qa` answer with no citations | Render answer only | Silent |
| Slow BE (>10s) | No client-side timeout v1; spinner stays | User can wait or refresh |

No client-side retries v1. No circuit breaker. Latency complaints are the trigger to revisit streaming.

### Logging

- BE already has `logger: false` in `src/server.ts`. Not touching.
- FE proxy routes: `console.error` on BE 5xx so Vercel logs catch it.

## Deployment & ops

- BE: existing Railway setup, unchanged.
- FE: existing v0 / Vercel pipeline. New env var `NEXT_PUBLIC_API_URL` configured per environment.
- No new infra.

## Implementation strategy

Two parallel plans, dispatched as separate agents after this spec is approved:

1. **Backend plan** — `video-transcriber/` agent. Owns `/faqs` removal + `/talks` enrichment + tests.
2. **Frontend plan** — `ai-engineer-recap-fe/` agent. Owns test framework setup + proxy routes + component rewrites + tests.

Sync point: backend agent must merge its `/talks` shape change before FE agent can verify component tests against a real BE. Until then, FE tests use MSW mocks that match the new contract — they can be written and pass independently.

## Manual verification checklist (end of work)

Run both servers (BE `:3000`, FE `:3001`) and walk through:

1. Chat: send "What is harness engineering?" → real answer + ≥1 citation linking to a YouTube timestamp.
2. Schedule: page loads → both tabs populated from `/api/talks`. "Watch" link jumps to correct timestamp.
3. Kill BE → chat shows error bubble; schedule shows error banner.
4. Unset `NEXT_PUBLIC_API_URL` → both surfaces show 502-driven error states.
5. `curl http://localhost:3000/health` → `{status:"ok"}`.
6. `curl http://localhost:3000/faqs` → `404`.

## References

- CLI guide for ingestion: `docs/videos-cli-guide.md`.
- BE endpoint summary (post-removal): `/health`, `/videos*`, `/talks*`, `/search`, `/qa`.
- FE proxy routes: `/api/qa`, `/api/search`, `/api/talks`.
