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
const llm = new MockLLMService([], '', 'Vectors are arrays. [chunk:c1]')

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
    llm,
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

describe('POST /qa', () => {
  it('returns answer with sources', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const talk = await insertTalk(pool, {
      sourceVideoId: sv.id,
      title: 'Vectors',
      speaker: 'Alice',
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

    const res = await app.inject({
      method: 'POST',
      url: '/qa',
      payload: { question: 'what are vectors?' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).toContain('Vectors')
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body.sources.length).toBeGreaterThan(0)
  })
})
