import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { IYouTubeService } from './interfaces/youtube.js'
import type { ITranscriptionService } from './interfaces/assemblyai.js'
import type { IEmbeddingService } from './interfaces/embeddings.js'
import type { ILLMService } from './interfaces/llm.js'
import { registerVideoRoutes } from './routes/videos.js'
import { registerTalkRoutes } from './routes/talks.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerQaRoutes } from './routes/qa.js'

export interface AppDeps {
  pool: Pool
  youtube: IYouTubeService
  transcription: ITranscriptionService
  embeddings: IEmbeddingService
  llm: ILLMService
  enqueueJob: (data: { sourceVideoId: string; youtubeUrl: string }) => Promise<string>
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ status: 'ok' }))
  await registerVideoRoutes(app, deps)
  await registerTalkRoutes(app, deps)
  await registerSearchRoutes(app, deps)
  await registerQaRoutes(app, deps)
  return app
}
