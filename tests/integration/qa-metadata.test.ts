import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import { insertSourceVideo, insertTalk, setSourceVideoDayLabel, getMetadata } from '../../src/db/queries.js'

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

describe('getMetadata', () => {
  it('counts videos, talks, sums duration, lists distinct speakers and day_labels', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    await pool.query('update source_videos set duration_seconds = 600, series_slug = $1 where id = $2', ['aies-2026', sv1.id])
    await setSourceVideoDayLabel(pool, sv1.id, 'Day 1')
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    await pool.query('update source_videos set duration_seconds = 1200, series_slug = $1 where id = $2', ['aies-2026', sv2.id])
    await setSourceVideoDayLabel(pool, sv2.id, 'Day 2')

    await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })
    await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T2', speaker: 'Bob', talkIndex: 1, startMs: 100, endMs: 200 })
    await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T3', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })

    const m = await getMetadata(pool, { seriesSlug: 'aies-2026' })

    expect(m.total_videos).toBe(2)
    expect(m.total_talks).toBe(3)
    expect(m.total_duration_seconds).toBe(1800)
    expect(m.day_labels.sort()).toEqual(['Day 1', 'Day 2'])
    expect(m.speakers.sort()).toEqual(['Alice', 'Bob'])
    expect(m.talks).toHaveLength(3)
  })

  it('respects talk_id scope', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 100 })
    await insertTalk(pool, { sourceVideoId: sv.id, title: 'T2', speaker: 'Bob', talkIndex: 1, startMs: 100, endMs: 200 })

    const m = await getMetadata(pool, { talkId: t.id })
    expect(m.total_talks).toBe(1)
    expect(m.speakers).toEqual(['Alice'])
  })
})
