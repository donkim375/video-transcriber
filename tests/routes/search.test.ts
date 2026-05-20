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
  insertTalk,
  insertTranscript,
  insertChunk,
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
  })
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

async function seedChunks() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const talk = await insertTalk(pool, {
    sourceVideoId: sv.id,
    title: 'T',
    speaker: 'S',
    talkIndex: 0,
    startMs: 0,
    endMs: 1,
  })
  const tr = await insertTranscript(pool, {
    talkId: talk.id,
    assemblyaiId: 'tx',
    rawText: '',
    utterances: [],
  })
  await insertChunk(pool, {
    talkId: talk.id,
    transcriptId: tr.id,
    chunkIndex: 0,
    text: 'vectors are arrays of numbers',
    startMs: 0,
    endMs: 1,
    tokenCount: 5,
    embedding: vec(1),
  })
  await insertChunk(pool, {
    talkId: talk.id,
    transcriptId: tr.id,
    chunkIndex: 1,
    text: 'databases store data',
    startMs: 0,
    endMs: 1,
    tokenCount: 4,
    embedding: vec(2),
  })
  return talk.id
}

describe('POST /search', () => {
  it('returns hybrid results', async () => {
    await seedChunks()
    const res = await app.inject({
      method: 'POST',
      url: '/search',
      payload: { query: 'vectors', limit: 5 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]).toHaveProperty('chunk_text')
    expect(body.results[0]).toHaveProperty('talk_id')
  })

  it('filters by talk_id', async () => {
    const talkId = await seedChunks()
    const res = await app.inject({
      method: 'POST',
      url: '/search',
      payload: { query: 'vectors', talk_id: talkId },
    })
    expect(res.statusCode).toBe(200)
    for (const r of res.json().results) expect(r.talk_id).toBe(talkId)
  })
})
