export type CitationSource = {
  type: 'chunk' | 'talk'
  chunk_id: string | null
  talk_id: string
  source_video_id: string
  youtube_id: string
  start_ms: number
  end_ms: number
  talk_title: string
  speaker: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  similarity: number | null
}

export type Citation = {
  chunk_id: string | null
  talk_id: string
  source_video_id: string
  youtube_id: string
  youtube_deeplink: string
  start_ms: number
  end_ms: number
  transcript_anchor: string
  talk_title: string
  speaker: string
  video_title: string | null
  day_label: string | null
  series_slug: string | null
  similarity: number | null
  source: 'chunk' | 'talk'
}

const MARKER_RE = /\[(chunk|talk):([0-9a-f-]{36})\]/gi

export interface ValidationResult {
  answer: string
  citations: Citation[]
  stripped: number
}

export function validateAndRewriteCitations(
  rawAnswer: string,
  sources: CitationSource[]
): ValidationResult {
  const byChunk = new Map<string, CitationSource>()
  const byTalk = new Map<string, CitationSource>()
  for (const s of sources) {
    if (s.type === 'chunk' && s.chunk_id) byChunk.set(s.chunk_id, s)
    if (s.type === 'talk') byTalk.set(s.talk_id, s)
  }

  const indexByKey = new Map<string, number>()
  const citations: Citation[] = []
  let stripped = 0

  const answer = rawAnswer.replace(MARKER_RE, (_, kind: string, id: string) => {
    const isChunk = kind.toLowerCase() === 'chunk'
    const src = isChunk ? byChunk.get(id) : byTalk.get(id)
    if (!src) {
      stripped += 1
      return ''
    }
    const key = isChunk ? `chunk:${id}` : `talk:${id}`
    let idx = indexByKey.get(key)
    if (idx === undefined) {
      idx = citations.length + 1
      indexByKey.set(key, idx)
      citations.push(toCitation(src))
    }
    return `[${idx}]`
  })

  return { answer, citations, stripped }
}

function toCitation(s: CitationSource): Citation {
  const anchor =
    s.type === 'chunk' && s.chunk_id ? `#chunk-${s.chunk_id}` : `#talk-${s.talk_id}`
  const startSec = Math.floor(s.start_ms / 1000)
  return {
    chunk_id: s.chunk_id,
    talk_id: s.talk_id,
    source_video_id: s.source_video_id,
    youtube_id: s.youtube_id,
    youtube_deeplink: `https://youtu.be/${s.youtube_id}?t=${startSec}`,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    transcript_anchor: anchor,
    talk_title: s.talk_title,
    speaker: s.speaker,
    video_title: s.video_title,
    day_label: s.day_label,
    series_slug: s.series_slug,
    similarity: s.similarity,
    source: s.type,
  }
}
