import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../server.js'
import { extractYouTubeId } from '../services/url-validator.js'
import {
  insertSourceVideo,
  getSourceVideoById,
  getSourceVideoByYoutubeId,
  listTalksForVideo,
} from '../db/queries.js'

const PostBody = z.object({
  youtube_url: z.string(),
  conference: z.string().optional(),
})

export async function registerVideoRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/videos', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    const youtubeId = extractYouTubeId(parsed.data.youtube_url)
    if (!youtubeId) return reply.code(400).send({ error: 'invalid youtube url' })

    const existing = await getSourceVideoByYoutubeId(deps.pool, youtubeId)
    if (existing) {
      return reply.code(200).send({ source_video_id: existing.id, status: existing.status })
    }

    const sv = await insertSourceVideo(deps.pool, {
      youtubeUrl: parsed.data.youtube_url,
      youtubeId,
    })
    await deps.enqueueJob({ sourceVideoId: sv.id, youtubeUrl: parsed.data.youtube_url })
    return reply.code(201).send({ source_video_id: sv.id, status: 'pending' })
  })

  app.get('/videos', async () => {
    const { rows } = await deps.pool.query(
      `select sv.*,
              (select count(*) from talks t where t.source_video_id = sv.id)::int as talk_count
         from source_videos sv
        order by sv.created_at desc`
    )
    return rows
  })

  app.get<{ Params: { id: string } }>('/videos/:id', async (req, reply) => {
    const row = await getSourceVideoById(deps.pool, req.params.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    const talks = await listTalksForVideo(deps.pool, row.id)
    return { ...row, talks }
  })

  app.get<{ Params: { id: string } }>('/videos/:id/status', async (req, reply) => {
    const row = await getSourceVideoById(deps.pool, req.params.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return { status: row.status, current_step: row.status, error_message: row.error_message }
  })
}
