import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'
import { getFaqsAcrossVideos } from '../db/queries.js'

export async function registerFaqRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/faqs', async (_req, reply) => {
    const faqs = await getFaqsAcrossVideos(deps.pool)
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
    return { faqs }
  })
}
