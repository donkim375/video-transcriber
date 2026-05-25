import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk,
  matchChunks, searchChunksFullText,
} from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await pool.end()
})

function vec(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

async function seedThreeChunks() {
  const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
  const talk = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T', speaker: 'S', talkIndex: 0, startMs: 0, endMs: 0 })
  const tr = await insertTranscript(pool, { talkId: talk.id, assemblyaiId: 'tx', rawText: '', utterances: [] })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 0, text: 'cats love fish', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 1, text: 'dogs chase squirrels', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(2) })
  await insertChunk(pool, { talkId: talk.id, transcriptId: tr.id, chunkIndex: 2, text: 'cats nap a lot', startMs: 0, endMs: 1, tokenCount: 4, embedding: vec(3) })
  return talk.id
}

describe('matchChunks', () => {
  it('returns top-N by cosine similarity', async () => {
    await seedThreeChunks()
    const res = await matchChunks(pool, vec(1), 2)
    expect(res).toHaveLength(2)
    expect(res[0]!.similarity).toBeGreaterThanOrEqual(res[1]!.similarity)
  })
  it('filters by talk_id when provided', async () => {
    const talkId = await seedThreeChunks()
    const res = await matchChunks(pool, vec(1), 10, { talkId })
    expect(res.length).toBe(3)
  })
})

describe('searchChunksFullText', () => {
  it('matches by english tsvector', async () => {
    await seedThreeChunks()
    const res = await searchChunksFullText(pool, 'cats', 10)
    const texts = res.map((r) => r.text)
    expect(texts.some((t) => t.includes('cats love fish'))).toBe(true)
    expect(texts.some((t) => t.includes('cats nap a lot'))).toBe(true)
  })
  it('returns empty when no match', async () => {
    await seedThreeChunks()
    const res = await searchChunksFullText(pool, 'aardvarks', 10)
    expect(res).toEqual([])
  })
})
