import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'
import { QUEUE_PIPELINE } from './queues/jobs.js'
import { YouTubeService } from './services/youtube.js'
import { writeCookiesFile } from './services/youtube-cookies.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })
const cookiesPath = cfg.youtubeCookiesB64
  ? writeCookiesFile(cfg.youtubeCookiesB64)
  : undefined

async function main() {
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
  const app = await buildServer({
    pool,
    youtube: new YouTubeService({ cookiesPath }),
    transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
    embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
    llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
    enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
  })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`API listening on ${cfg.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
