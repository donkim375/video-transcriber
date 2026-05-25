import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, updateTranscriptSummary, getTalkSummaries,
} from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('getTalkSummaries', () => {
  it('returns by talk_id', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr.id, 'Hello.')

    const r = await getTalkSummaries(pool, { talkId: t.id })
    expect(r).toHaveLength(1)
    expect(r[0]!.summary).toBe('Hello.')
    expect(r[0]!.youtube_deeplink).toBe('https://youtu.be/a?t=0')
  })

  it('returns by speaker case-insensitive, capped at 5', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 7; i++) {
      const t = await insertTalk(pool, { sourceVideoId: sv.id, title: `T${i}`, speaker: 'Alice', talkIndex: i, startMs: i * 1000, endMs: (i + 1) * 1000 })
      const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: `x${i}`, rawText: '', utterances: [] })
      await updateTranscriptSummary(pool, tr.id, `Summary ${i}.`)
    }
    const r = await getTalkSummaries(pool, { speaker: 'alice' })
    expect(r).toHaveLength(5)
  })
})
