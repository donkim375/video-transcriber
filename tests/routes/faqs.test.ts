import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from '../integration/db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo,
  setSourceVideoFaqs,
  setSourceVideoDayLabel,
  updateSourceVideoStatus,
} from '../../src/db/queries.js'

const pool = makeTestPool()
let app: FastifyInstance

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService(),
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('GET /faqs', () => {
  it('returns flat list across ready videos with day_label', async () => {
    const v1 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v1', youtubeId: 'v1', title: 'Day 1',
    })
    await updateSourceVideoStatus(pool, v1.id, 'ready')
    await setSourceVideoDayLabel(pool, v1.id, 'Day 1')
    await setSourceVideoFaqs(pool, v1.id, [{ question: 'q1', answer: 'a1' }])

    const v2 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v2', youtubeId: 'v2', title: 'Day 2',
    })
    await updateSourceVideoStatus(pool, v2.id, 'ready')
    await setSourceVideoDayLabel(pool, v2.id, 'Day 2')
    await setSourceVideoFaqs(pool, v2.id, [{ question: 'q2', answer: 'a2' }])

    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.faqs).toHaveLength(2)
    expect(body.faqs[0].day_label).toBe('Day 1')
    expect(body.faqs[1].day_label).toBe('Day 2')
    expect(body.faqs[0].question).toBe('q1')
  })

  it('omits videos that are not ready', async () => {
    const v1 = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/v1', youtubeId: 'v1', title: 't',
    })
    await setSourceVideoFaqs(pool, v1.id, [{ question: 'q', answer: 'a' }])

    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.statusCode).toBe(200)
    expect(res.json().faqs).toEqual([])
  })

  it('returns Cache-Control with max-age=300', async () => {
    const res = await app.inject({ method: 'GET', url: '/faqs' })
    expect(res.headers['cache-control']).toContain('max-age=300')
  })
})
