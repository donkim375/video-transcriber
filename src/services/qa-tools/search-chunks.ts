import { z } from 'zod'
import { searchChunksHybrid, matchChunks } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  query: z.string().min(1),
  scope: ScopeSchema.optional(),
  k: z.number().int().min(1).optional(),
  diversify: z.enum(['none', 'per_talk']).optional(),
  mode: z.enum(['hybrid', 'dense']).optional(),
}).strict()

export const searchChunksTool: ToolDefinition = {
  name: 'search_chunks',
  description: 'Hybrid (dense+keyword) chunk retrieval. Returns passages with talk/speaker metadata. Set diversify:"per_talk" to keep at most one chunk per talk (use this for "which talks discuss X"). Default k=8, max 30. Returns chunk-level citations.',
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
      k: { type: 'number' },
      diversify: { type: 'string', enum: ['none', 'per_talk'] },
      mode: { type: 'string', enum: ['hybrid', 'dense'] },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const k = Math.min(parsed.k ?? 8, 30)
    const effectiveScope = parsed.scope ?? ctx.scope
    const filters = toScopeFilters(effectiveScope)
    const [embedding] = await ctx.embeddings.embed([parsed.query])
    if (!embedding) throw new Error('embedding failed')

    const fetchK = parsed.diversify === 'per_talk' ? Math.min(k * 4, 30) : k
    const mode = parsed.mode ?? 'hybrid'

    const rows = mode === 'hybrid'
      ? await searchChunksHybrid(ctx.pool, parsed.query, embedding, fetchK, filters)
      : (await matchChunks(ctx.pool, embedding, fetchK, filters)).map(r => ({ ...r, rrf_score: r.similarity }))

    let chunks = rows
    if (parsed.diversify === 'per_talk') {
      const seen = new Set<string>()
      chunks = []
      for (const r of rows) {
        if (seen.has(r.talk_id)) continue
        seen.add(r.talk_id)
        chunks.push(r)
        if (chunks.length >= k) break
      }
    } else {
      chunks = rows.slice(0, k)
    }

    const sources: CitationSource[] = chunks.map(c => ({
      type: 'chunk',
      chunk_id: c.chunk_id,
      talk_id: c.talk_id,
      source_video_id: c.source_video_id,
      youtube_id: c.youtube_id,
      start_ms: c.start_ms ?? 0,
      end_ms: c.end_ms ?? 0,
      talk_title: c.talk_title,
      speaker: c.speaker,
      video_title: null,
      day_label: null,
      series_slug: null,
      similarity: c.rrf_score,
    }))

    return {
      json: {
        chunks: chunks.map(c => ({
          chunk_id: c.chunk_id,
          text: c.text,
          talk_id: c.talk_id,
          talk_title: c.talk_title,
          speaker: c.speaker,
          start_ms: c.start_ms ?? 0,
          end_ms: c.end_ms ?? 0,
          similarity: c.rrf_score,
          youtube_deeplink: `https://youtu.be/${c.youtube_id}?t=${Math.floor((c.start_ms ?? 0) / 1000)}`,
        })),
      },
      sources,
    }
  },
}
