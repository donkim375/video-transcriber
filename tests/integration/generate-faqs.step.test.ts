import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import PgBoss from 'pg-boss'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
  TEST_DATABASE_URL,
} from './db-setup.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { getSourceVideoById, insertSourceVideo, insertTalk } from '../../src/db/queries.js'

const pool = makeTestPool()
let boss: PgBoss

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  boss = new PgBoss({ connectionString: TEST_DATABASE_URL })
  await boss.start()
  await boss.createQueue(QUEUE_PIPELINE)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await boss.stop()
  await pool.end()
})

describe('FAQ pipeline step', () => {
  it('populates source_videos.faqs after the pipeline runs', async () => {
    const fakeFaqs = [{ question: 'q1?', answer: 'a1.' }]
    const llm = new MockLLMService(
      [{ title: 'Talk 1', speaker: 'A', startMs: 0, endMs: 1000 }],
      'Mock summary.',
      'unused',
      fakeFaqs
    )
    await registerPipelineWorker(boss, {
      pool,
      youtube: new MockYouTubeService({
        title: 'AI Engineer Day 1',
        channel: 'AI Engineer',
        durationSeconds: 60,
        thumbnailUrl: '',
        chapters: [],
      }),
      transcription: new MockTranscriptionService({
        assemblyaiId: 'tx',
        rawText: 'words',
        utterances: [{ startMs: 0, endMs: 1000, text: 'words', speaker: 'A' }],
      }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: '/tmp',
    })

    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/zzz',
      youtubeId: 'zzz',
    })
    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/zzz',
      contentType: 'single_speaker',
    })

    const deadline = Date.now() + 30_000
    let row = await getSourceVideoById(pool, sv.id)
    while (Date.now() < deadline && row?.faqs == null) {
      await new Promise((r) => setTimeout(r, 250))
      row = await getSourceVideoById(pool, sv.id)
    }
    expect(row?.faqs).toEqual(fakeFaqs)
    expect(llm.faqCalls).toHaveLength(1)
  }, 60_000)

  it('skips FAQ generation when faqs are already populated (idempotent)', async () => {
    const llm = new MockLLMService(
      [{ title: 'Talk 1', speaker: 'A', startMs: 0, endMs: 1000 }],
      'Mock summary.',
      'unused',
      [{ question: 'shouldnotbeused', answer: '...' }]
    )
    await registerPipelineWorker(boss, {
      pool,
      youtube: new MockYouTubeService({
        title: 't', channel: 'c', durationSeconds: 1, thumbnailUrl: '', chapters: [],
      }),
      transcription: new MockTranscriptionService({
        assemblyaiId: 'tx',
        rawText: 'words',
        utterances: [{ startMs: 0, endMs: 1000, text: 'words', speaker: 'A' }],
      }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: '/tmp',
    })

    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/idem',
      youtubeId: 'idem',
    })
    await pool.query(
      `update source_videos set faqs = $2::jsonb where id = $1`,
      [sv.id, JSON.stringify([{ question: 'pre', answer: 'existing' }])]
    )
    await boss.send(QUEUE_PIPELINE, {
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/idem',
      contentType: 'single_speaker',
    })

    await new Promise((r) => setTimeout(r, 5000))
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.faqs).toEqual([{ question: 'pre', answer: 'existing' }])
    expect(llm.faqCalls).toHaveLength(0)
  }, 60_000)
})
