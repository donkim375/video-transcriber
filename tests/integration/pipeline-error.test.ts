import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PgBoss from 'pg-boss'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
  TEST_DATABASE_URL,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type {
  ITranscriptionService,
} from '../../src/interfaces/assemblyai.js'
import type {
  TranscriptionResult,
  TranscriptionStatus,
} from '../../src/types/index.js'
import { sampleChapters } from '../fixtures/chapters.js'

const pool = makeTestPool()
let boss: PgBoss

class FailingTranscription implements ITranscriptionService {
  async submit(_audioPath: string): Promise<{ assemblyaiId: string }> {
    return { assemblyaiId: 'failing-id' }
  }
  async getStatus(_id: string): Promise<TranscriptionStatus> {
    return { id: 'failing-id', status: 'error', errorMessage: 'AssemblyAI exploded' }
  }
  async getResult(_id: string): Promise<TranscriptionResult> {
    throw new Error('should not be called')
  }
}

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await pool.query('drop schema if exists pgboss cascade;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  await pool.end()
})

describe('pipeline error handling', () => {
  it('marks source_videos.status=error with the error_message when a step throws', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/err',
      youtubeId: 'err',
    })
    const audioPath = join(tmpdir(), `${sv.id}.mp3`)
    writeFileSync(audioPath, 'dummy')

    const youtube = new MockYouTubeService({
      title: 'X', channel: 'X', durationSeconds: 0, thumbnailUrl: '',
      chapters: sampleChapters,
    })

    await registerPipelineWorker(boss, {
      pool,
      youtube,
      transcription: new FailingTranscription(),
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: tmpdir(),
      pollIntervalMs: 5,
      pollTimeoutMs: 5000,
    })

    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/err',
      contentType: 'conference',
    })

    const deadline = Date.now() + 20_000
    let finalStatus = ''
    let finalMsg: string | null = null
    while (Date.now() < deadline) {
      const cur = await getSourceVideoById(pool, sv.id)
      if (cur && cur.status === 'error') {
        finalStatus = cur.status
        finalMsg = cur.error_message
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(finalStatus).toBe('error')
    expect(finalMsg).toContain('AssemblyAI exploded')
  }, 60_000)
})
