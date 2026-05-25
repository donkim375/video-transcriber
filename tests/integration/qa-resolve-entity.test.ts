import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, resolveEntities } from '../../src/db/queries.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

beforeEach(async () => { await truncateAll(pool) })
afterAll(async () => { await pool.end() })

describe('resolveEntities', () => {
  it('finds talk by title substring', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'How Daytona Sandboxes Work', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'Building RAG', speaker: 'Bob', talkIndex: 1, startMs: 1, endMs: 2 })

    const r = await resolveEntities(pool, 'Daytona', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toContain('Daytona')
  })

  it('tolerates a typo via pg_trgm', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'Daytona Sandboxes', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })

    const r = await resolveEntities(pool, 'deytona', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toContain('Daytona')
  })

  it('finds talk by speaker partial', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'X', speaker: 'Jane Smith', talkIndex: 0, startMs: 0, endMs: 1 })

    const r = await resolveEntities(pool, 'jane', {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.speaker).toBe('Jane Smith')
  })

  it('returns empty array when nothing matches', async () => {
    const r = await resolveEntities(pool, 'nonexistent term', {})
    expect(r).toEqual([])
  })

  it('caps at 3 candidates', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    for (let i = 0; i < 5; i++) {
      await insertTalk(pool, { sourceVideoId: sv.id, title: `Eval Talk ${i}`, speaker: `Speaker${i}`, talkIndex: i, startMs: i, endMs: i + 1 })
    }
    const r = await resolveEntities(pool, 'eval', {})
    expect(r.length).toBeLessThanOrEqual(3)
  })
})
