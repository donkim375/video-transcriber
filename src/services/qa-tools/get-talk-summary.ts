import { z } from 'zod'
import { getTalkSummaries } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  talk_id: z.string().uuid().optional(),
  speaker: z.string().min(1).optional(),
  scope: ScopeSchema.optional(),
}).strict()

export const getTalkSummaryTool: ToolDefinition = {
  name: 'get_talk_summary',
  description: 'Returns precomputed summaries for one or more talks. Pass talk_id for a specific talk (preferred — use resolve_entity first if needed). Pass speaker to get all of their talks (capped at 5). Returns talk-level citations.',
  input_schema: {
    type: 'object',
    properties: {
      talk_id: { type: 'string' },
      speaker: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
    },
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input ?? {})
    const baseScope = parsed.scope ?? ctx.scope
    const filters = toScopeFilters({
      ...baseScope,
      talk_id: parsed.talk_id ?? baseScope.talk_id,
      speaker: parsed.speaker ?? baseScope.speaker,
    })
    const talks = await getTalkSummaries(ctx.pool, { ...filters, limit: 5 })
    const sources: CitationSource[] = talks.map(t => ({
      type: 'talk',
      chunk_id: null,
      talk_id: t.talk_id,
      source_video_id: t.source_video_id,
      youtube_id: extractYoutubeId(t.youtube_deeplink),
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      talk_title: t.talk_title ?? '',
      speaker: t.speaker ?? '',
      video_title: null,
      day_label: null,
      series_slug: null,
      similarity: null,
    }))
    return { json: { talks }, sources }
  },
}

function extractYoutubeId(deeplink: string): string {
  const m = deeplink.match(/youtu\.be\/([^?]+)/)
  return m?.[1] ?? ''
}
