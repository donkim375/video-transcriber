import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import PgBoss from 'pg-boss'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, TEST_DATABASE_URL,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import { registerPipelineWorker } from '../../src/workers/pipeline.worker.js'
import { QUEUE_PIPELINE } from '../../src/queues/jobs.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import type { FastifyInstance } from 'fastify'

const pool = makeTestPool()
let app: FastifyInstance
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

  const youtube = new MockYouTubeService({
    title: 'KubeCon Day 1', channel: 'CNCF', durationSeconds: 24, thumbnailUrl: 'http://t',
    chapters: [
      { title: 'Intro', startMs: 0, endMs: 5000 },
      { title: 'Vectors by Alice', startMs: 5000, endMs: 13000 },
      { title: 'Databases by Bob', startMs: 13000, endMs: 24000 },
    ],
  })
  const transcription = new MockTranscriptionService({
    assemblyaiId: 'tx-1',
    rawText: sampleUtterances.map((u) => u.text).join(' '),
    utterances: sampleUtterances,
  })
  const llm = new MockLLMService([], 'Mock summary.')

  await registerPipelineWorker(boss, {
    pool, youtube, transcription,
    embeddings: new MockEmbeddingService(),
    llm,
    tmpDir: '/tmp',
    pollIntervalMs: 5,
    pollTimeoutMs: 5000,
  })

  app = await buildServer({
    pool, youtube, transcription,
    embeddings: new MockEmbeddingService(),
    llm,
    enqueueJob: async (data) => (await boss.send(QUEUE_PIPELINE, data)) ?? '',
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 120_000)

beforeEach(async () => {
  await pool.query('truncate table chunks, transcripts, talks, source_videos restart identity cascade')
})

afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: true })
  await pool.end()
})

describe('full pipeline smoke', () => {
  it('submit → pipeline → search → qa', async () => {
    const submit = await app.inject({
      method: 'POST', url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=smokeABC123' },
    })
    expect(submit.statusCode).toBe(201)
    const sourceVideoId = submit.json().source_video_id

    let ready = false
    for (let i = 0; i < 300; i++) {
      const s = await app.inject({ method: 'GET', url: `/videos/${sourceVideoId}/status` })
      const body = s.json()
      if (body.status === 'ready') { ready = true; break }
      if (body.status === 'error') throw new Error(`Pipeline errored: ${body.error_message}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(ready).toBe(true)

    const video = await app.inject({ method: 'GET', url: `/videos/${sourceVideoId}` })
    expect(video.json().talks.length).toBe(3)

    const talks = await app.inject({ method: 'GET', url: '/talks' })
    expect(talks.json().length).toBe(3)

    const search = await app.inject({
      method: 'POST', url: '/search', payload: { query: 'vectors', limit: 5 },
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().results.length).toBeGreaterThan(0)

    // /qa route is being rewritten to tool-use loop in Task 21 — endpoint returns 501 stub here.
    const qa = await app.inject({
      method: 'POST', url: '/qa', payload: { messages: [{ role: 'user', content: 'what are vectors?' }] },
    })
    expect([200, 501]).toContain(qa.statusCode)
  }, 60_000)
})
