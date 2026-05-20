# End-to-End Retest Guide

**Goal:** Submit a fresh video with `content_type: single_speaker`, confirm exactly one talk is produced, and verify search results carry populated `start_ms`/`end_ms`.

---

## 1. Restart Worker + API

In Terminal A (worker) and Terminal B (API), `Ctrl-C` the running processes if still up, then in each terminal:

```bash
cd ~/Code/video-transcriber
source .envrc
```

**Terminal A:**
```bash
run_local npm run dev:worker
```

**Terminal B:**
```bash
run_local npm run dev
```

---

## 2. Apply the New Migration

```bash
source .envrc
SUPABASE_CONNECTION_STRING=$(supabase_conn) \
  /opt/homebrew/opt/libpq/bin/psql "$SUPABASE_CONNECTION_STRING" \
  -f src/db/migrations/002_content_type.sql
```

**Expected:** `ALTER TABLE` x2 — or `NOTICE: column "content_type" already exists` if already run (safe to ignore).

---

## 3. Clear the Previous In-Flight Video

```bash
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_CONNECTION_STRING" \
  -c "delete from source_videos where youtube_url = '<paste-your-url>';"
```

**Expected:** `DELETE 1` — cascade clears its talks, transcripts, and chunks.

---

## 4. Resubmit with Explicit `content_type`

```bash
curl -sX POST http://localhost:3000/api/videos \
  -H 'content-type: application/json' \
  -d '{"youtube_url":"<paste-your-url>","content_type":"single_speaker"}' | jq
```

**Expected:** response includes `"content_type": "single_speaker"`.

Watch Terminal A logs for the full pipeline sequence:
```
downloading → transcribing → segmenting → embedding → summarizing → completed
```

---

## 5. Verify Single-Talk Segmentation

```bash
SV_ID=$(curl -s "http://localhost:3000/api/videos?youtube_url=<paste-your-url>" | jq -r '.id')

/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_CONNECTION_STRING" \
  -c "select id, talk_index, title, start_ms, end_ms
      from talks where source_video_id = '$SV_ID' order by talk_index;"
```

**Expected:** exactly one row, `talk_index = 0`, `start_ms = 0`, `end_ms ≈ video duration in ms`.

---

## 6. Verify Chunks Have Timestamps

```bash
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_CONNECTION_STRING" \
  -c "select count(*) total,
             count(*) filter (where start_ms is null) null_starts,
             count(*) filter (where end_ms is null) null_ends,
             min(start_ms), max(end_ms)
      from chunks c join talks t on t.id = c.talk_id
      where t.source_video_id = '$SV_ID';"
```

**Expected:** `null_starts = 0`, `null_ends = 0`, `min(start_ms) = 0`, `max(end_ms) ≈ video duration`.

---

## 7. Verify Search Response Surfaces Timestamps

```bash
curl -s "http://localhost:3000/api/search?q=<some-query-from-the-video>&limit=3" \
  | jq '.results[] | {chunk_id, start_ms, end_ms, text: (.text[0:80])}'
```

**Expected:** every result has non-null `start_ms` and `end_ms`. Click-through deep-linking with `?t=<start_ms/1000>s` will now work.

---

## Pass Criteria

| Check | Expected |
|---|---|
| ✅ Talk rows per video | Exactly one (not several) |
| ✅ Null timestamps in chunks | Zero `null` `start_ms` / `end_ms` |
| ✅ Search results | Include populated `start_ms` and `end_ms` |
| ✅ API response | Echoes `content_type` |
