import { z } from 'zod'
import { getOverview } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({ scope: ScopeSchema.optional() }).strict()

export const getOverviewTool: ToolDefinition = {
  name: 'get_overview',
  description: 'Returns precomputed summaries and FAQs for every video and talk in scope. Use for conference-wide questions like "summarize the conference", "top ideas", "overall themes". Returns talk-level citations (no chunks).',
  input_schema: {
    type: 'object',
    properties: {
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
    const effectiveScope = parsed.scope ?? ctx.scope
    const o = await getOverview(ctx.pool, toScopeFilters(effectiveScope))

    const sources: CitationSource[] = []
    for (const v of o.videos) {
      for (const t of v.talks) {
        sources.push({
          type: 'talk',
          chunk_id: null,
          talk_id: t.talk_id,
          source_video_id: v.source_video_id,
          youtube_id: extractYoutubeId(t.youtube_deeplink),
          start_ms: t.start_ms,
          end_ms: t.end_ms,
          talk_title: t.talk_title ?? '',
          speaker: t.speaker ?? '',
          video_title: v.video_title,
          day_label: v.day_label,
          series_slug: v.series_slug,
          similarity: null,
        })
      }
    }
    return { json: o, sources }
  },
}

function extractYoutubeId(deeplink: string): string {
  const m = deeplink.match(/youtu\.be\/([^?]+)/)
  return m?.[1] ?? ''
}
