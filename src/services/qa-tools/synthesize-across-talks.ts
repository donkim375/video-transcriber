import { z } from 'zod'
import { searchChunksHybrid } from '../../db/queries.js'
import { toScopeFilters, ScopeSchema } from '../qa-scope.js'
import type { ToolDefinition } from './types.js'
import type { CitationSource } from './citation-validator.js'

const InputSchema = z.object({
  idea: z.string().min(1),
  scope: ScopeSchema.optional(),
  per_talk_k: z.number().int().min(1).max(8).optional(),
}).strict()

const MAX_TALKS = 8
const CANDIDATE_POOL = 60

export const synthesizeAcrossTalksTool: ToolDefinition = {
  name: 'synthesize_across_talks',
  description: 'Cross-talk map-reduce for an idea. Pulls a wide pool of chunks, groups by talk, and produces a 1-2 sentence summary per talk of how that talk treats the idea. Use for "main conclusions about X across the day" or "how is X covered across talks". Returns chunk-level citations and per-talk mini-summaries.',
  input_schema: {
    type: 'object',
    properties: {
      idea: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          series_slug: { type: 'string' },
          source_video_id: { type: 'array', items: { type: 'string' } },
          talk_id: { type: 'string' },
          speaker: { type: 'string' },
        },
      },
      per_talk_k: { type: 'number' },
    },
    required: ['idea'],
  },
  async execute(input, ctx) {
    const parsed = InputSchema.parse(input)
    const perTalkK = parsed.per_talk_k ?? 3
    const filters = toScopeFilters(parsed.scope ?? ctx.scope)

    const [embedding] = await ctx.embeddings.embed([parsed.idea])
    if (!embedding) throw new Error('embedding failed')

    const rows = await searchChunksHybrid(ctx.pool, parsed.idea, embedding, CANDIDATE_POOL, filters)

    // group by talk_id, keep per-talk top chunks
    const byTalk = new Map<string, typeof rows>()
    for (const r of rows) {
      const arr = byTalk.get(r.talk_id) ?? []
      arr.push(r)
      byTalk.set(r.talk_id, arr)
    }

    const ranked = [...byTalk.entries()]
      .map(([talk_id, chunks]) => {
        const sorted = chunks.sort((a, b) => b.rrf_score - a.rrf_score).slice(0, perTalkK)
        const relevance = sorted[0]?.rrf_score ?? 0
        return { talk_id, chunks: sorted, relevance }
      })
      .sort((a, b) => b.relevance - a.relevance)

    const top = ranked.slice(0, MAX_TALKS)

    const summarised = await Promise.all(
      top.map(async (t) => {
        const first = t.chunks[0]!
        const mini_summary = await ctx.llm.summarizeForSynthesis({
          idea: parsed.idea,
          talkTitle: first.talk_title,
          speaker: first.speaker,
          evidence: t.chunks.map(c => c.text),
        })
        return {
          talk_id: t.talk_id,
          talk_title: first.talk_title,
          speaker: first.speaker,
          relevance: t.relevance,
          evidence_chunks: t.chunks.map(c => ({
            chunk_id: c.chunk_id,
            text: c.text,
            start_ms: c.start_ms ?? 0,
            youtube_deeplink: `https://youtu.be/${c.youtube_id}?t=${Math.floor((c.start_ms ?? 0) / 1000)}`,
          })),
          mini_summary,
        }
      })
    )

    const sources: CitationSource[] = []
    for (const t of top) {
      for (const c of t.chunks) {
        sources.push({
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
        })
      }
    }

    return {
      json: {
        per_talk_evidence: summarised,
        talks_considered: byTalk.size,
        talks_returned: top.length,
      },
      sources,
    }
  },
}
