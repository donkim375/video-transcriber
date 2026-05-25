import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, insertTranscript, insertChunk } from '../../src/db/queries.js'
import { synthesizeAcrossTalksTool } from '../../src/services/qa-tools/synthesize-across-talks.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

describe('synthesize_across_talks integration', () => {
  it('returns per-talk evidence with mini-summaries from real db', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 3; i++) {
      const t = await insertTalk(pool, { sourceVideoId: sv.id, title: `Talk ${i}`, speaker: `S${i}`, talkIndex: i, startMs: i * 1000, endMs: (i + 1) * 1000 })
      const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: `x${i}`, rawText: '', utterances: [] })
      await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: `evaluation matters here ${i}`, startMs: i, endMs: i + 1, tokenCount: 3, embedding: vec(1) })
    }

    const llm = new MockLLMService()
    const embeddings = new MockEmbeddingService()
    const r = await synthesizeAcrossTalksTool.execute(
      { idea: 'evaluation' },
      { pool: pool as any, embeddings: embeddings as any, llm: llm as any, scope: {}, signal: new AbortController().signal }
    )
    const json = r.json as any
    expect(json.per_talk_evidence.length).toBeGreaterThan(0)
    expect(json.per_talk_evidence.every((e: any) => typeof e.mini_summary === 'string' && e.mini_summary.length > 0)).toBe(true)
    expect(llm.synthCalls.length).toBe(json.per_talk_evidence.length)
  })
})
