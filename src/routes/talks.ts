import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { getTalkById, getTranscriptByTalkId, getSourceVideoById } from '../db/queries.js'

const Query = z.object({
  conference: z.string().optional(),
  speaker: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export async function registerTalkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/talks', async (req, reply) => {
    const parsed = Query.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const { conference, speaker, limit, offset } = parsed.data
    const { rows } = await deps.pool.query(
      `select * from talks
         where ($1::text is null or conference = $1)
           and ($2::text is null or speaker = $2)
         order by created_at desc
         limit $3 offset $4`,
      [conference ?? null, speaker ?? null, limit, offset]
    )
    return rows
  })

  app.get<{ Params: { id: string } }>('/talks/:id', async (req, reply) => {
    const talk = await getTalkById(deps.pool, req.params.id)
    if (!talk) return reply.code(404).send({ error: 'not found' })
    const transcript = await getTranscriptByTalkId(deps.pool, talk.id)
    const sourceVideo = await getSourceVideoById(deps.pool, talk.source_video_id)
    return { ...talk, transcript, source_video: sourceVideo }
  })
}
