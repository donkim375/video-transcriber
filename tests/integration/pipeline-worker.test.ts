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
import {
  insertSourceVideo,
  getSourceVideoById,
  listTalksForVideo,
  getTranscriptByTalkId,
} from '../../src/db/queries.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import { sampleChapters } from '../fixtures/chapters.js'

const pool = makeTestPool()
let boss: PgBoss

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

describe('pipeline worker (pg-boss)', () => {
  it('runs the full pipeline end-to-end via pg-boss', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const audioPath = join(tmpdir(), `${sv.id}.mp3`)
    writeFileSync(audioPath, 'dummy')

    const youtube = new MockYouTubeService({
      title: 'Conference',
      channel: 'C',
      durationSeconds: 24,
      thumbnailUrl: 'https://img.test/t.jpg',
      chapters: sampleChapters,
    })
    const transcription = new MockTranscriptionService({
      assemblyaiId: 'tx-final',
      rawText: 'hello world',
      utterances: sampleUtterances,
    })
    const embeddings = new MockEmbeddingService()
    const llm = new MockLLMService([], 'A summary.')

    await registerPipelineWorker(boss, {
      pool,
      youtube,
      transcription,
      embeddings,
      llm,
      tmpDir: tmpdir(),
      pollIntervalMs: 5,
      pollTimeoutMs: 5000,
    })

    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/abc',
      contentType: 'conference',
    })

    const deadline = Date.now() + 20_000
    let finalStatus = ''
    while (Date.now() < deadline) {
      const cur = await getSourceVideoById(pool, sv.id)
      if (cur && (cur.status === 'ready' || cur.status === 'error')) {
        finalStatus = cur.status
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(finalStatus).toBe('ready')

    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks.length).toBe(sampleChapters.length)
    for (const t of talks) {
      const tx = await getTranscriptByTalkId(pool, t.id)
      expect(tx.summary).toBe('A summary.')
    }
  }, 60_000)
})
