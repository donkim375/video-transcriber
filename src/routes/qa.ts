import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../server.js'

export async function registerQaRoutes(app: FastifyInstance, _deps: AppDeps): Promise<void> {
  app.post('/qa', async (_req, reply) => reply.code(501).send({ error: 'qa route under upgrade' }))
}
