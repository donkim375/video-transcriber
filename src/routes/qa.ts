import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { matchChunks, getTalkById } from '../db/queries.js'
import { buildRagContext, type ChunkForContext } from '../services/rag.js'

const Body = z.object({
  question: z.string().min(1),
  talk_id: z.string().uuid().optional(),
})

export async function registerQaRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/qa',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

      const [queryEmbedding] = await deps.embeddings.embed([parsed.data.question])
      if (!queryEmbedding) return reply.code(500).send({ error: 'embedding failed' })

      const chunks = await matchChunks(deps.pool, queryEmbedding, 8, parsed.data.talk_id)
      const contextChunks: ChunkForContext[] = []
      for (const c of chunks) {
        const talk = await getTalkById(deps.pool, c.talk_id)
        contextChunks.push({
          id: c.id,
          text: c.text,
          talkTitle: talk?.title ?? '',
          speaker: talk?.speaker ?? '',
          startMs: c.start_ms ?? 0,
        })
      }
      const context = buildRagContext(contextChunks)
      const answer = await deps.llm.answerQuestion(parsed.data.question, context)

      return {
        answer,
        sources: chunks.map((c) => ({
          chunk_id: c.id,
          talk_id: c.talk_id,
          text: c.text,
          start_ms: c.start_ms,
          end_ms: c.end_ms,
          similarity: c.similarity,
        })),
      }
    }
  )
}
