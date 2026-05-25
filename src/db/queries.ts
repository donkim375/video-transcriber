import type pg from 'pg'
import type { ContentType } from '../types/index.js'

export interface SourceVideoRow {
  id: string
  youtube_url: string
  youtube_id: string
  title: string | null
  channel: string | null
  duration_seconds: number | null
  thumbnail_url: string | null
  has_chapters: boolean
  content_type: ContentType
  status: string
  error_message: string | null
  faqs: Array<{ question: string; answer: string }> | null
  day_label: string | null
  created_at: Date
  updated_at: Date
}

export async function insertSourceVideo(
  pool: pg.Pool,
  v: { youtubeUrl: string; youtubeId: string; contentType?: ContentType; title?: string; channel?: string }
): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into source_videos (youtube_url, youtube_id, content_type, title, channel)
     values ($1, $2, $3, $4, $5) returning id`,
    [v.youtubeUrl, v.youtubeId, v.contentType ?? 'auto', v.title ?? null, v.channel ?? null]
  )
  return { id: rows[0].id }
}

export async function getSourceVideoById(pool: pg.Pool, id: string): Promise<SourceVideoRow | null> {
  const { rows } = await pool.query(`select * from source_videos where id = $1`, [id])
  return rows[0] ?? null
}

export async function getSourceVideoForTalk(
  pool: pg.Pool,
  talkId: string
): Promise<{ source_video_id: string; youtube_id: string; title: string | null; day_label: string | null } | null> {
  const { rows } = await pool.query(
    `select sv.id as source_video_id, sv.youtube_id, sv.title, sv.day_label
       from talks t join source_videos sv on t.source_video_id = sv.id
      where t.id = $1`,
    [talkId]
  )
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

export async function setSourceVideoFaqs(
  pool: pg.Pool,
  id: string,
  faqs: Array<{ question: string; answer: string }>
): Promise<void> {
  await pool.query(
    `update source_videos set faqs = $2::jsonb, updated_at = now() where id = $1`,
    [id, JSON.stringify(faqs)]
  )
}

export async function setSourceVideoDayLabel(
  pool: pg.Pool,
  id: string,
  dayLabel: string
): Promise<void> {
  await pool.query(
    `update source_videos set day_label = $2, updated_at = now() where id = $1`,
    [id, dayLabel]
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

export interface MatchChunkRow {
  chunk_id: string
  text: string
  talk_id: string
  talk_title: string
  speaker: string
  source_video_id: string
  youtube_id: string
  start_ms: number | null
  end_ms: number | null
  similarity: number
}

export interface ScopeFilters {
  talkId?: string
  sourceVideoIds?: string[]
  seriesSlug?: string
  speaker?: string
}

export async function matchChunks(
  pool: pg.Pool,
  queryEmbedding: number[],
  matchCount: number,
  scope: ScopeFilters = {}
): Promise<MatchChunkRow[]> {
  const { rows } = await pool.query(
    `select * from match_chunks($1::vector, $2, $3, $4, $5, $6)`,
    [
      toPgVector(queryEmbedding),
      matchCount,
      scope.talkId ?? null,
      scope.sourceVideoIds ?? null,
      scope.seriesSlug ?? null,
      scope.speaker ?? null,
    ]
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

export interface Metadata {
  total_videos: number
  total_talks: number
  total_duration_seconds: number
  series_slugs: string[]
  day_labels: string[]
  speakers: string[]
  talks: Array<{
    talk_id: string
    talk_title: string | null
    speaker: string | null
    talk_index: number
    start_ms: number
    end_ms: number
    day_label: string | null
  }>
}

export async function getMetadata(pool: pg.Pool, scope: ScopeFilters): Promise<Metadata> {
  const { rows: agg } = await pool.query(
    `select
       count(distinct sv.id)::int as total_videos,
       count(distinct t.id)::int as total_talks,
       coalesce(sum(distinct sv.duration_seconds), 0)::int as total_duration_seconds,
       array_remove(array_agg(distinct sv.series_slug), null) as series_slugs,
       array_remove(array_agg(distinct sv.day_label), null) as day_labels,
       array_remove(array_agg(distinct t.speaker), null) as speakers
     from talks t
     join source_videos sv on sv.id = t.source_video_id
     where ($1::uuid is null or t.id = $1)
       and ($2::uuid[] is null or sv.id = any($2))
       and ($3::text is null or sv.series_slug = $3)
       and ($4::text is null or t.speaker ilike '%' || $4 || '%')`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  const { rows: talks } = await pool.query(
    `select t.id as talk_id, t.title as talk_title, t.speaker, t.talk_index, t.start_ms, t.end_ms, sv.day_label
       from talks t
       join source_videos sv on sv.id = t.source_video_id
      where ($1::uuid is null or t.id = $1)
        and ($2::uuid[] is null or sv.id = any($2))
        and ($3::text is null or sv.series_slug = $3)
        and ($4::text is null or t.speaker ilike '%' || $4 || '%')
      order by sv.day_label nulls last, t.talk_index asc`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  return {
    total_videos: agg[0]?.total_videos ?? 0,
    total_talks: agg[0]?.total_talks ?? 0,
    total_duration_seconds: agg[0]?.total_duration_seconds ?? 0,
    series_slugs: agg[0]?.series_slugs ?? [],
    day_labels: agg[0]?.day_labels ?? [],
    speakers: agg[0]?.speakers ?? [],
    talks,
  }
}

export interface OverviewTalk {
  talk_id: string
  talk_title: string | null
  speaker: string | null
  summary: string | null
  start_ms: number
  end_ms: number
  youtube_deeplink: string
}

export interface OverviewVideo {
  source_video_id: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  faqs: Array<{ question: string; answer: string }>
  talks: OverviewTalk[]
}

export interface Overview {
  videos: OverviewVideo[]
}

export async function getOverview(pool: pg.Pool, scope: ScopeFilters): Promise<Overview> {
  const { rows } = await pool.query(
    `select
       sv.id as source_video_id, sv.title as video_title, sv.day_label, sv.series_slug, sv.youtube_id, sv.faqs,
       t.id as talk_id, t.title as talk_title, t.speaker, t.start_ms, t.end_ms,
       tr.summary
     from source_videos sv
     join talks t on t.source_video_id = sv.id
     left join transcripts tr on tr.talk_id = t.id
     where ($1::uuid is null or t.id = $1)
       and ($2::uuid[] is null or sv.id = any($2))
       and ($3::text is null or sv.series_slug = $3)
       and ($4::text is null or t.speaker ilike '%' || $4 || '%')
     order by sv.day_label nulls last, t.talk_index asc`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null]
  )

  const byVideo = new Map<string, OverviewVideo>()
  for (const r of rows) {
    let v = byVideo.get(r.source_video_id)
    if (!v) {
      v = {
        source_video_id: r.source_video_id,
        video_title: r.video_title,
        day_label: r.day_label,
        series_slug: r.series_slug,
        faqs: r.faqs ?? [],
        talks: [],
      }
      byVideo.set(r.source_video_id, v)
    }
    const startSec = Math.floor((r.start_ms ?? 0) / 1000)
    v.talks.push({
      talk_id: r.talk_id,
      talk_title: r.talk_title,
      speaker: r.speaker,
      summary: r.summary,
      start_ms: r.start_ms ?? 0,
      end_ms: r.end_ms ?? 0,
      youtube_deeplink: `https://youtu.be/${r.youtube_id}?t=${startSec}`,
    })
  }
  return { videos: [...byVideo.values()] }
}

export interface TalkSummaryRow {
  talk_id: string
  talk_title: string | null
  speaker: string | null
  summary: string | null
  start_ms: number
  end_ms: number
  source_video_id: string
  youtube_deeplink: string
}

export async function getTalkSummaries(pool: pg.Pool, scope: ScopeFilters & { limit?: number }): Promise<TalkSummaryRow[]> {
  const limit = scope.limit ?? 5
  const { rows } = await pool.query(
    `select t.id as talk_id, t.title as talk_title, t.speaker, tr.summary,
            t.start_ms, t.end_ms, sv.id as source_video_id, sv.youtube_id
       from talks t
       join source_videos sv on sv.id = t.source_video_id
       left join transcripts tr on tr.talk_id = t.id
      where ($1::uuid is null or t.id = $1)
        and ($2::uuid[] is null or sv.id = any($2))
        and ($3::text is null or sv.series_slug = $3)
        and ($4::text is null or t.speaker ilike '%' || $4 || '%')
      order by t.talk_index asc
      limit $5`,
    [scope.talkId ?? null, scope.sourceVideoIds ?? null, scope.seriesSlug ?? null, scope.speaker ?? null, limit]
  )
  return rows.map(r => ({
    talk_id: r.talk_id,
    talk_title: r.talk_title,
    speaker: r.speaker,
    summary: r.summary,
    start_ms: r.start_ms ?? 0,
    end_ms: r.end_ms ?? 0,
    source_video_id: r.source_video_id,
    youtube_deeplink: `https://youtu.be/${r.youtube_id}?t=${Math.floor((r.start_ms ?? 0) / 1000)}`,
  }))
}
