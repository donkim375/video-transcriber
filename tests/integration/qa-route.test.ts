import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { buildServer } from '../../src/server.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk, updateTranscriptSummary,
} from '../../src/db/queries.js'
import type { FastifyInstance } from 'fastify'

const pool = makeTestPool()
let app: FastifyInstance
let llm: MockLLMService

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
  llm = new MockLLMService()
  app = await buildServer({
    pool,
    youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
    transcription: new MockTranscriptionService({ assemblyaiId: '', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm,
    enqueueJob: async () => 'job-1',
    corsAllowedOrigin: 'http://localhost:3001',
  })
})

afterAll(async () => { await pool.end() })

describe('POST /qa (tool-use)', () => {
  it('rejects empty messages', async () => {
    const res = await app.inject({ method: 'POST', url: '/qa', payload: { messages: [] } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects last message not user', async () => {
    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('runs end-to-end with get_talk_summary path and validates citations', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'V' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Daytona', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr.id, 'Summary text.')

    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'get_talk_summary', input: { talk_id: t.id } }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `The talk covers Daytona [talk:${t.id}].` }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'main idea of daytona talk?' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).toBe('The talk covers Daytona [1].')
    expect(body.citations).toHaveLength(1)
    expect(body.citations[0].talk_id).toBe(t.id)
    expect(body.citations[0].youtube_deeplink).toBe('https://youtu.be/a?t=0')
    expect(body.citations[0].transcript_anchor).toBe(`#talk-${t.id}`)
  })

  it('strips invalid citation markers', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: 'x', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })

    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'search_chunks', input: { query: 'x' } }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A [chunk:00000000-0000-0000-0000-000000000000] then [done].' }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'x?' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).not.toContain('chunk:00000000')
  })

  it('returns 200 with partial:true when loop hits iteration cap', async () => {
    // 5 tool_use responses consume the 5 loop iterations; final tool_choice='none'
    // call consumes the end_turn — yielding reached_cap=true.
    for (let i = 0; i < 5; i++) {
      llm.pushToolCallResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu${i}`, name: 'get_metadata', input: {} }],
      })
    }
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Forced answer.' }],
    })

    const res = await app.inject({
      method: 'POST', url: '/qa',
      payload: { messages: [{ role: 'user', content: 'loop' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reached_cap).toBe(true)
    expect(body.answer).toBe('Forced answer.')
  })
})
