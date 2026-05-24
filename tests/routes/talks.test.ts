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
import { insertSourceVideo, insertTalk, insertTranscript } from '../../src/db/queries.js'

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

async function seed() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const t1 = await insertTalk(pool, {
    sourceVideoId: sv.id,
    title: 'Vectors',
    speaker: 'Alice',
    conference: 'KubeCon 2024',
    talkIndex: 0,
    startMs: 0,
    endMs: 1000,
  })
  const t2 = await insertTalk(pool, {
    sourceVideoId: sv.id,
    title: 'DBs',
    speaker: 'Bob',
    conference: 'KubeCon 2024',
    talkIndex: 1,
    startMs: 1000,
    endMs: 2000,
  })
  await insertTranscript(pool, {
    talkId: t1.id,
    assemblyaiId: 'tx#0',
    rawText: 'about vectors',
    utterances: [],
  })
  return { sv, t1, t2 }
}

describe('GET /talks', () => {
  it('lists all talks', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
  })

  it('filters by speaker', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks?speaker=Alice' })
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].speaker).toBe('Alice')
  })

  it('applies limit and offset', async () => {
    await seed()
    const res = await app.inject({ method: 'GET', url: '/talks?limit=1&offset=1' })
    expect(res.json()).toHaveLength(1)
  })
})

describe('GET /talks/:id', () => {
  it('returns talk with transcript and source_video', async () => {
    const { t1 } = await seed()
    const res = await app.inject({ method: 'GET', url: `/talks/${t1.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.transcript.raw_text).toBe('about vectors')
    expect(body.source_video).toBeTruthy()
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/talks/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(404)
  })
})
