# End-to-End Retest Guide

**Goal:** Submit a fresh YouTube video, drive it through the full pipeline, and verify that talk segmentation, chunk timestamps, and search responses are all correct.

## Why these checks

The pipeline must produce exactly one talk per single-speaker video, populate `start_ms`/`end_ms` on every chunk, and surface those timestamps in the `/search` response so deep-linking (`?t=<sec>s`) works. The contract is captured in [`docs/superpowers/specs/2026-05-20-segmentation-and-chunk-timestamps-spec.md`](./superpowers/specs/2026-05-20-segmentation-and-chunk-timestamps-spec.md). This guide is the runbook that exercises every clause of that spec end-to-end.

---

## Prereqs

- `.envrc` sourced in your shell (`source .envrc`).
- Local Docker Postgres up (or `DB_URL` pointing at a reachable Supabase — see Configuration).
- Worker running (Terminal A) and API running (Terminal B):
  ```bash
  # Terminal A
  cd ~/Code/video-transcriber && source .envrc
  run_local npm run dev:worker

  # Terminal B
  cd ~/Code/video-transcriber && source .envrc
  run_local npm run dev
  ```

Health check before you start:
```bash
curl -sf http://localhost:3000/health && echo
docker compose -f docker-compose.test.yml ps
```

`/health` should return `{"status":"ok"}` and the `postgres` (and any other test) containers should be `running (healthy)`.

---

## Configuration

Set these once at the top of your shell session. Every later step references them verbatim:

```bash
# Local Docker (default):
DB_URL='postgres://test:test@localhost:54329/test'
# Remote Supabase: uncomment + paste the full string, or grab it via the keychain helper:
# DB_URL="$(supabase_conn)"     # NOTE: this reprompts the keychain — confirm it's non-empty before using
# echo "${DB_URL:?DB_URL is empty}"  # sanity check

PSQL=/opt/homebrew/opt/libpq/bin/psql
YT_URL='https://www.youtube.com/watch?v=C_GG5g38vLU'   # replace per run
CONTENT_TYPE='single_speaker'   # or: conference | podcast_interview | auto
```

> If you use `$(supabase_conn)`, that helper reprompts the macOS keychain and writes errors to stderr. If the unlock silently fails, `DB_URL` ends up empty and `psql` falls back to the default Unix socket on port `5432` — which usually fails with a confusing error. Always `echo "$DB_URL"` once after setting it to confirm it looks like a real connection string.

---

## Step 1: Apply migrations

Idempotent — safe to re-run. Skip if you know the schema is already up to date.

```bash
"$PSQL" "$DB_URL" -f src/db/migrations/001_initial.sql
"$PSQL" "$DB_URL" -f src/db/migrations/002_content_type.sql
```

**Expected:** `CREATE TABLE` / `ALTER TABLE` statements for a clean DB, or `NOTICE: ... already exists` lines for a previously migrated DB (safe to ignore).

---

## Step 2: (optional) Clear previous run

Only needed if you're **reusing the same `YT_URL`**. A fresh URL will create a new `source_videos` row and you can skip this step.

```bash
"$PSQL" "$DB_URL" -c "delete from source_videos where youtube_url = '$YT_URL';"
```

**Expected:** `DELETE 1` (or `DELETE 0` if it wasn't there). Cascade clears any associated talks, transcripts, and chunks.

---

## Step 3: Submit + capture `source_video_id`

```bash
SV_ID=$(curl -sX POST http://localhost:3000/videos \
  -H 'content-type: application/json' \
  -d "{\"youtube_url\":\"$YT_URL\",\"content_type\":\"$CONTENT_TYPE\"}" \
  | tee /dev/stderr | jq -r '.source_video_id')
echo "SV_ID=$SV_ID"
```

**Expected:** the response (echoed to stderr by `tee`) includes `"content_type":"single_speaker"` (or whatever you set), `"status":"pending"`, and a UUID `source_video_id`. `$SV_ID` should now be a UUID.

If you re-submit the same URL the API returns `200` with the existing `source_video_id` (no `content_type` field on the reuse path) — that's fine, `$SV_ID` still gets captured.

---

## Step 4: Poll until ready

```bash
while :; do
  STATUS=$(curl -s "http://localhost:3000/videos/$SV_ID/status" | jq -r '.status')
  printf '%s  %s\n' "$(date +%T)" "$STATUS"
  case "$STATUS" in
    ready|error) break ;;
  esac
  sleep 5
done
```

**Expected step sequence** (visible in Terminal A worker logs; the polled `status` field is sampled every 5s, so fast steps like `segmenting` and `summarizing` are often skipped over):

```
downloading → transcribing → segmenting → embedding → summarizing → ready
```

Terminal state is `ready` on success or `error` on failure. If `error`, hit `GET /videos/$SV_ID/status` once more to see `error_message`.

---

## Step 5: Verify segmentation

```bash
"$PSQL" "$DB_URL" -c "
  select id, talk_index, title, start_ms, end_ms
    from talks
   where source_video_id = '$SV_ID'
   order by talk_index;"
```

**Expected for `single_speaker`:** exactly one row, `talk_index = 0`, `start_ms = 0`, `end_ms` close to the video duration in ms.

---

## Step 6: Verify chunk timestamps

```bash
"$PSQL" "$DB_URL" -c "
  select count(*)                                              as total,
         count(*) filter (where c.start_ms is null)            as null_starts,
         count(*) filter (where c.end_ms   is null)            as null_ends,
         min(c.start_ms)                                       as min_start,
         max(c.end_ms)                                         as max_end,
         count(distinct (c.start_ms, c.end_ms))                as distinct_spans
    from chunks c
    join talks  t on t.id = c.talk_id
   where t.source_video_id = '$SV_ID';"
```

**Expected:** `null_starts = 0`, `null_ends = 0`, `min_start` close to `0`, `max_end` ≈ video duration in ms, and `distinct_spans` ≈ `total` (one span per chunk).

**Note on `distinct_spans`:** Per-sentence spans are derived from AssemblyAI's word-level timestamps (see [`docs/superpowers/specs/2026-05-21-word-level-chunk-timestamps-design.md`](./superpowers/specs/2026-05-21-word-level-chunk-timestamps-design.md)). Even when AssemblyAI returns the whole video as a single utterance — common for monologues — sentences inside that utterance now get distinct spans, so `distinct_spans` should be `> 1` and typically close to `total`. If `distinct_spans = 1` on a multi-minute video, alignment is failing for every sentence; investigate the AssemblyAI response shape (missing `words[]`?) rather than treating it as expected.

---

## Step 7: Verify search response surfaces timestamps

Search is **`POST /search`** with a JSON body — there is no `GET` variant.

```bash
curl -sX POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"some phrase from the video","limit":3}' \
  | jq '.results[] | {chunk_id, start_ms, end_ms, text: (.chunk_text[0:80])}'
```

**Expected:** every result has non-null `start_ms` and `end_ms`. Deep-linking via `?t=$((start_ms/1000))s` is now meaningful.

---

## API-only verification fallback

If you don't have `psql` or direct DB access, you can cover all four pass criteria with HTTP alone.

**Segmentation (replaces Step 5):**
```bash
curl -s "http://localhost:3000/videos/$SV_ID" \
  | jq '{content_type, status, talks: [.talks[] | {talk_index, title, start_ms, end_ms}]}'
```
`talks` should be a single-element array for `single_speaker`. `GET /videos/:id` returns the full source-video record with a `talks` array attached.

**Chunk timestamps + search (replaces Steps 6 + 7):**
```bash
curl -sX POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"some phrase from the video","limit":10}' \
  | jq '{
      total: (.results | length),
      null_starts: ([.results[] | select(.start_ms == null)] | length),
      null_ends:   ([.results[] | select(.end_ms   == null)] | length),
      distinct_spans: ([.results[] | "\(.start_ms)-\(.end_ms)"] | unique | length),
      sample: [.results[] | {chunk_id, start_ms, end_ms}]
    }'
```
`null_starts` / `null_ends` must be `0`. `distinct_spans` should be `> 1` on any multi-minute video (see Step 6 note).

---

## Pass criteria

| Check | Expected |
|---|---|
| ✅ Talk rows per video | Exactly one for `single_speaker` (more for `conference` / `podcast_interview`) |
| ✅ Null timestamps in chunks | Zero `null` `start_ms` / `end_ms` |
| ✅ Chunk span granularity | `distinct_spans > 1` on multi-minute videos (typically ≈ chunk count) |
| ✅ Search results | Every result has populated `start_ms` and `end_ms` |
| ✅ API response | Submission echoes `content_type`; `/videos/:id` exposes the `talks` array |
