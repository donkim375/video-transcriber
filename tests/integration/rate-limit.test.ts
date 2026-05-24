import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from './db-setup.js'
import { buildServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

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
    llm: new MockLLMService([], '', 'answer'),
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
}, 90_000)

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('Rate limit on /qa', () => {
  it('returns 429 after exceeding the per-hour cap', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/qa',
        headers: { 'x-forwarded-for': '1.2.3.4' },
        payload: { question: `q${i}` },
      })
      expect(res.statusCode).not.toBe(429)
    }
    const res = await app.inject({
      method: 'POST',
      url: '/qa',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      payload: { question: 'q11' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
