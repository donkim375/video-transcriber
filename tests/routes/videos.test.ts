import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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
import { insertSourceVideo } from '../../src/db/queries.js'

const pool = makeTestPool()
let app: FastifyInstance
const enqueue = vi.fn(async () => 'job-1')

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
    enqueueJob: enqueue,
  })
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
  enqueue.mockClear()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

describe('POST /videos', () => {
  it('creates a source_video, enqueues, returns id+status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.source_video_id).toBeTruthy()
    expect(body.status).toBe('pending')
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('rejects invalid URL with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/videos',
      payload: { youtube_url: 'not a url' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns existing record on duplicate, does not enqueue', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
      youtubeId: 'dQw4w9WgXcQ',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/videos',
      payload: { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().source_video_id).toBe(sv.id)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('GET /videos', () => {
  it('lists videos with talk counts', async () => {
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'Video A' })
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b', title: 'Video B' })
    const res = await app.inject({ method: 'GET', url: '/videos' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toHaveProperty('talk_count')
  })
})

describe('GET /videos/:id', () => {
  it('returns video with talks array', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const res = await app.inject({ method: 'GET', url: `/videos/${sv.id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: sv.id, talks: [] })
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/videos/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /videos/:id/status', () => {
  it('returns status', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const res = await app.inject({ method: 'GET', url: `/videos/${sv.id}/status` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending')
  })
})
