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
