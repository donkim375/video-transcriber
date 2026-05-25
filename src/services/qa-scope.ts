import { z } from 'zod'
import type { ScopeFilters } from '../db/queries.js'

export const ScopeSchema = z
  .object({
    series_slug: z.string().min(1).max(100).optional(),
    source_video_id: z.array(z.string().uuid()).max(10).optional(),
    talk_id: z.string().uuid().optional(),
    speaker: z.string().min(1).max(100).optional(),
  })
  .strict()

export type Scope = z.infer<typeof ScopeSchema>

export function parseScope(raw: unknown): Scope {
  if (raw === undefined || raw === null) return {}
  return ScopeSchema.parse(raw)
}

export function toScopeFilters(scope: Scope): ScopeFilters {
  const out: ScopeFilters = {}
  if (scope.talk_id) out.talkId = scope.talk_id
  if (scope.source_video_id && scope.source_video_id.length > 0) out.sourceVideoIds = scope.source_video_id
  if (scope.series_slug) out.seriesSlug = scope.series_slug
  if (scope.speaker) out.speaker = scope.speaker
  return out
}
