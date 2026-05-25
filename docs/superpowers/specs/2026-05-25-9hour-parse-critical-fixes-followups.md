# 9-Hour Conference Parse — Follow-up & Untested Surfaces

Companion to `2026-05-25-9hour-parse-critical-fixes-design.md`. Records what the
critical-fixes PR did **not** verify, so we can close the loop in a later pass.

Status legend: 🟡 = needs verification; 🔴 = blocker before declaring 9-hour parse production-ready.

## Local — not yet exercised

| # | Item | Why skipped | Recommended check |
|---|------|-------------|-------------------|
| L1 | 🟡 Full 9-hour video submission end-to-end | Cost-prohibitive (one full AssemblyAI + Anthropic run per attempt). Local pipeline confirmed only against fixtures and the existing single-video integration test. | One full submission against a real 9h URL in a dev session, with `LOG_LEVEL=debug` on the worker. Validate poll loop survives `TRANSCRIPTION_POLL_TIMEOUT_MS=7200000`. |
| L2 | 🟡 Real transient failure observed at SDK boundary | Unit tests cover `withRetry` exhaustively, but no actual 429/5xx from AssemblyAI / OpenAI / Anthropic has been observed firing the wrapper in integration. | Inject a fault (e.g. block egress mid-run, or temporarily point at an invalid base URL) and confirm the worker logs `attempt n/N` lines and ultimately succeeds when the fault is removed. |
| L3 | 🟡 `validateBoundaries` against an LLM-produced boundary set | Validation tested only against hand-crafted overlap fixture. LLM fallback path (no chapters) has not been run against `validateBoundaries`. | Run the conference pipeline with `chapters: []` against a real transcript and verify behavior on a real LLM response. |
| L4 | 🟡 FE answer + citations rendering (F4) | Local DB is empty — chat endpoint has nothing to cite. Empty-state pass was used as evidence in Phase A. | Seed local DB with one ingested talk, run a question through `/api/qa`, and screenshot citations rendering in the FE. |
| L5 | 🟡 FE error-state path (F5) | BE was kept up throughout E2E run; no synthetic 500 path was rehearsed. | Use the `window.fetch` monkey-patch pattern from the e2e-testing-local skill to force a 500 on `/api/qa` and confirm the FE error UI renders. |

## Prod — entire deploy gate skipped this round

The user scoped this PR as "exclude prod deployment for now." Phase B and Phase C
of the e2e-testing skill were both deferred. **Do not declare 9-hour parse fixed
in prod until these are completed.**

| # | Item | Phase | Recommended check |
|---|------|-------|-------------------|
| P1 | 🔴 Code SHA on `api` and `worker` services matches the merge commit | B (deploy gate) | `railway status --service api` / `--service worker` after merge. |
| P2 | 🔴 `TRANSCRIPTION_POLL_TIMEOUT_MS=7200000` set on Railway `worker` service | B | `railway run --service worker -- bash -c 'echo len=${#TRANSCRIPTION_POLL_TIMEOUT_MS}'` (length only — never echo the value). |
| P3 | 🔴 No new migrations needed (this PR is code-only) — confirm by re-running `npm run db:diff` against the prod DB after deploy | B | Should be a no-op. If it isn't, the local schema has drifted. |
| P4 | 🔴 Both services restarted after env change | B | Check deploy timestamp on Railway dashboard or `railway status` JSON. |
| P5 | 🔴 Prod 9-hour submission survives the new 120-min poll window | C | One real 9h video against the prod URL after the env var is in place. Watch worker logs for the poll-loop heartbeat. |
| P6 | 🟡 Prod retry wrappers actually fire under real cloud-network conditions | C | Best-effort: monitor logs for `withRetry attempt` lines during the prod 9h run. Absence is not failure, but presence confirms the wrapper is reachable. |
| P7 | 🟡 yt-dlp datacenter-IP block — still expected for Railway | C (known infra gotcha) | This PR does not address it. If the prod 9h run fails on yt-dlp, that's a separate issue (cookies / IP), not a regression from this PR. |

## Not in scope of this PR (logged here so we don't lose them)

- Speaker-turn-aware chunking for `podcast_interview` strategy (TODO in `src/services/segmentation.ts:64`).
- Real content-type classifier — the `AutoStrategy` still hard-routes on chapter presence (`src/services/segmentation.ts:74`).
- Surfacing retry exhaustion in the source_videos `status_reason` column for user-visible diagnostics. Today the failure message lands in worker logs only.
- Cost-aware batch sizing for OpenAI embeddings on very long talks (the wrapper retries, but doesn't shrink the batch).

## Suggested next session

1. Merge this PR.
2. Run prod deploy gate (P1–P4). 30 min.
3. Submit one real 9-hour video against prod (P5). Walk away; check next morning.
4. If P5 passes, file separate tickets for L1–L5 and the not-in-scope items above.
