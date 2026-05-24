import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo,
  getSourceVideoById,
  updateSourceVideoStatus,
  insertTalk,
  insertTranscript,
  insertChunk,
  listTalksForVideo,
  setSourceVideoFaqs,
  setSourceVideoDayLabel,
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

describe('source_videos CRUD', () => {
  it('inserts and reads back', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    expect(sv.id).toBeTruthy()
    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.youtube_id).toBe('abc')
    expect(fetched!.status).toBe('pending')
  })

  it('updates status', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    await updateSourceVideoStatus(pool, sv.id, 'downloading')
    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('downloading')
  })

  it('enforces unique youtube_id', async () => {
    await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    await expect(
      insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/def', youtubeId: 'abc' })
    ).rejects.toThrow()
  })

  it('setSourceVideoFaqs stores faqs jsonb and getSourceVideoById returns them', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/faq1', youtubeId: 'faq1' })
    const faqs = [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }]
    await setSourceVideoFaqs(pool, sv.id, faqs)
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.faqs).toEqual(faqs)
  })

  it('setSourceVideoDayLabel stores day_label', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/day1', youtubeId: 'day1' })
    await setSourceVideoDayLabel(pool, sv.id, 'Day 1')
    const row = await getSourceVideoById(pool, sv.id)
    expect(row?.day_label).toBe('Day 1')
  })
})

describe('talks + transcripts + chunks', () => {
  it('inserts a full hierarchy and lists talks', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/abc', youtubeId: 'abc' })
    const talk = await insertTalk(pool, {
      sourceVideoId: sv.id, title: 'T1', speaker: 'S1', talkIndex: 0, startMs: 0, endMs: 1000,
    })
    const transcript = await insertTranscript(pool, {
      talkId: talk.id, assemblyaiId: 'tx-1', rawText: 'hello', utterances: [],
    })
    await insertChunk(pool, {
      talkId: talk.id,
      transcriptId: transcript.id,
      chunkIndex: 0,
      text: 'hello world',
      startMs: 0, endMs: 1000,
      tokenCount: 2,
      embedding: Array.from({ length: 1536 }, () => 0.001),
    })
    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks).toHaveLength(1)
    expect(talks[0]!.title).toBe('T1')
  })
})
