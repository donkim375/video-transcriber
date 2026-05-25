# Submitting Videos from the CLI

How to invoke the `POST /videos` endpoint (and its sibling status/detail endpoints) directly from the terminal using `curl`. Assumes the API is reachable at `http://localhost:3000` — adjust the host for staging/prod.

## Quick example

```bash
curl -X POST http://localhost:3000/videos \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=C_GG5g38vLU"}'
```

Response (newly enqueued):
```json
{
  "source_video_id": "f19ddd33-97a5-4b45-8f61-7bf19313c2a4",
  "status": "pending",
  "content_type": "auto"
}
```

If the YouTube ID has already been submitted, the endpoint is idempotent and returns the existing row with HTTP 200:
```json
{ "source_video_id": "...", "status": "ready" }
```

## Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `youtube_url` | string (URL) | yes | Any valid YouTube URL form — `youtube.com/watch?v=...`, `youtu.be/...`, etc. The handler extracts the 11-char video ID via `extractYouTubeId` (`src/services/url-validator.ts`). |
| `content_type` | enum | no | One of the values in `CONTENT_TYPES` (`src/types/index.ts`). Defaults to `"auto"`, which lets the pipeline decide. |
| `conference` | string | no | Free-text conference label, passed through to downstream segmentation. |

Validation is via `zod` (`src/routes/videos.ts:15`). A malformed body returns `400 { "error": "invalid body" }`; a URL with no extractable ID returns `400 { "error": "invalid youtube url" }`.

## Status codes

| Code | Meaning |
|---|---|
| `201` | New video accepted; pipeline job enqueued. |
| `200` | Video already exists (idempotent re-submit). Status reflects whatever stage it is in. |
| `400` | Body failed `zod` validation or YouTube URL was unparseable. |

## Polling the pipeline

Capture the ID from the POST response and poll `/videos/:id/status`:

```bash
ID=$(curl -sX POST http://localhost:3000/videos \
       -H 'Content-Type: application/json' \
       -d '{"youtube_url":"https://www.youtube.com/watch?v=C_GG5g38vLU"}' \
     | jq -r .source_video_id)

watch -n 2 "curl -s http://localhost:3000/videos/$ID/status | jq"
```

Status returns `{ status, current_step, error_message }`. Expected progression for a fresh video:

```
pending → downloading → transcribing → segmenting → embedding → ready
```

If it lands on `error`, `error_message` holds the reason. Cross-check the worker log for the stack trace.

## Inspecting the result

Once `status: "ready"`:

```bash
# Full video record including segmented talks
curl -s "http://localhost:3000/videos/$ID" | jq

# Just the list of videos in the system
curl -s http://localhost:3000/videos | jq
```

`GET /videos/:id` returns the source-video row merged with a `talks` array (one entry per segmented talk). `GET /videos` returns every source video with a `talk_count` aggregate, newest first.

## One-liner: submit and wait

```bash
URL="https://www.youtube.com/watch?v=C_GG5g38vLU"
ID=$(curl -sX POST http://localhost:3000/videos -H 'Content-Type: application/json' -d "{\"youtube_url\":\"$URL\"}" | jq -r .source_video_id)
echo "submitted $ID"
until [ "$(curl -s http://localhost:3000/videos/$ID/status | jq -r .status)" = "ready" ]; do
  sleep 5
  curl -s http://localhost:3000/videos/$ID/status | jq -c
done
echo "ready: $ID"
```

## Common pitfalls

- **`400 invalid youtube url`** — URL doesn't contain an 11-char video ID matching `/^[A-Za-z0-9_-]{11}$/`. Strip tracking params or paste the canonical `https://www.youtube.com/watch?v=<ID>` form.
- **Endpoint hangs on POST** — the API process is up, but the worker isn't draining `pg-boss`. Start it with `run_local npm run dev:worker` (see `docs/local-quickstart.md`).
- **Status stuck on `transcribing` for >15 min** — check the AssemblyAI dashboard against `transcripts.assemblyai_id` in Postgres. Workers don't currently auto-resume an interrupted job.
- **Different host** — for Railway/staging, swap `http://localhost:3000` for the deployed URL. Auth is not currently required on these endpoints.
