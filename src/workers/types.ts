import type pg from 'pg'
import type { IYouTubeService } from '../interfaces/youtube.js'
import type { ITranscriptionService } from '../interfaces/assemblyai.js'
import type { IEmbeddingService } from '../interfaces/embeddings.js'
import type { ILLMService } from '../interfaces/llm.js'

export interface PipelineDeps {
  pool: pg.Pool
  youtube: IYouTubeService
  transcription: ITranscriptionService
  embeddings: IEmbeddingService
  llm: ILLMService
  tmpDir: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export interface StepContext extends PipelineDeps {
  sourceVideoId: string
  youtubeUrl: string
}
