import { z } from 'zod'
import { getMetadata } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'

const InputSchema = z.object({
  scope: ScopeSchema.optional(),
}).strict()

export const getMetadataTool: ToolDefinition = {
  name: 'get_metadata',
  description: 'Returns structural counts and lists about the corpus in scope: total videos, total talks, total duration seconds, distinct speakers, day labels, series slugs, and a flat list of all talks with their day_label. Use for questions like "how many talks", "who is speaking", "how long is day 1".',
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
    const filters = toScopeFilters(effectiveScope)
    const m = await getMetadata(ctx.pool, filters)
    return { json: m, sources: [] }
  },
}
