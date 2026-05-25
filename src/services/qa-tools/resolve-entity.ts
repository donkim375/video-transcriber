import { z } from 'zod'
import { resolveEntities } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'

const InputSchema = z.object({
  query: z.string().min(1),
  scope: ScopeSchema.optional(),
}).strict()

export const resolveEntityTool: ToolDefinition = {
  name: 'resolve_entity',
  description: 'Resolves natural-language references ("Jane\'s talk", "the keynote", "the eval talk") into concrete talk candidates. Returns up to 3 candidates ranked by confidence (0-1). Use this before tools that need a specific talk_id when the user names a talk in prose.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
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
    required: ['query'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const effectiveScope = parsed.scope ?? ctx.scope
    const candidates = await resolveEntities(ctx.pool, parsed.query, toScopeFilters(effectiveScope))
    return { json: { candidates }, sources: [] }
  },
}
