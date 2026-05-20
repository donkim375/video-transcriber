import PgBoss from 'pg-boss'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { registerPipelineWorker } from './workers/pipeline.worker.js'
import { YouTubeService } from './services/youtube.js'
import { AssemblyAIService } from './services/assemblyai.js'
import { OpenAIEmbeddingService } from './services/embeddings.js'
import { ClaudeLLMService } from './services/llm.js'
import { QUEUE_PIPELINE } from './queues/jobs.js'

const cfg = loadConfig()
const pool = new Pool({ connectionString: cfg.databaseUrl })
const boss = new PgBoss({ connectionString: cfg.databaseUrl })

async function main() {
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
  await registerPipelineWorker(boss, {
    pool,
    youtube: new YouTubeService(),
    transcription: AssemblyAIService.fromApiKey(cfg.assemblyaiApiKey),
    embeddings: OpenAIEmbeddingService.fromApiKey(cfg.openaiApiKey),
    llm: ClaudeLLMService.fromApiKey(cfg.anthropicApiKey),
    tmpDir: '/tmp',
  })
  console.log('Worker started')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
