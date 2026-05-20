import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { matchChunks, searchChunksFullText } from '../db/queries.js'
import { reciprocalRankFusion } from '../services/rag.js'

const Body = z.object({
  query: z.string().min(1),
  talk_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
})

interface MergedChunk extends Record<string, unknown> {
  id: string
  text: string
  talk_id: string
  start_ms: number | null
  end_ms: number | null
}

export async function registerSearchRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/search', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    const { query, talk_id, limit } = parsed.data

    const [queryEmbedding] = await deps.embeddings.embed([query])
    if (!queryEmbedding) return reply.code(500).send({ error: 'embedding failed' })

    const [vectorRows, keywordRows] = await Promise.all([
      matchChunks(deps.pool, queryEmbedding, limit * 3, talk_id),
      searchChunksFullText(deps.pool, query, limit * 3, talk_id),
    ])

    const merged = reciprocalRankFusion<MergedChunk>(
      [
        keywordRows.map((r) => ({ ...r })),
        vectorRows.map((r) => ({ ...r })),
      ],
      { k: 60 }
    )

    const results = merged.slice(0, limit).map((c) => ({
      chunk_id: c.id,
      chunk_text: c.text,
      talk_id: c.talk_id,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
    }))
    return { results }
  })
}
