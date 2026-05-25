import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, updateTranscriptSummary,
  setSourceVideoDayLabel, setSourceVideoFaqs, getOverview,
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

afterAll(async () => { await pool.end() })

describe('getOverview', () => {
  it('joins two videos in same series with summaries and faqs', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a', title: 'Day 1' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv1.id])
    await setSourceVideoDayLabel(pool, sv1.id, 'Day 1')
    await setSourceVideoFaqs(pool, sv1.id, [{ question: 'Q1?', answer: 'A1' }])
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 60_000 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x1', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr1.id, 'T1 summary.')

    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b', title: 'Day 2' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv2.id])
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'Bob', talkIndex: 0, startMs: 0, endMs: 30_000 })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'x2', rawText: '', utterances: [] })
    await updateTranscriptSummary(pool, tr2.id, 'T2 summary.')

    const o = await getOverview(pool, { seriesSlug: 'aies-2026' })

    expect(o.videos).toHaveLength(2)
    const d1 = o.videos.find(v => v.day_label === 'Day 1')!
    expect(d1.faqs).toEqual([{ question: 'Q1?', answer: 'A1' }])
    expect(d1.talks).toHaveLength(1)
    expect(d1.talks[0]!.summary).toBe('T1 summary.')
    expect(d1.talks[0]!.youtube_deeplink).toBe('https://youtu.be/a?t=0')
  })
})
