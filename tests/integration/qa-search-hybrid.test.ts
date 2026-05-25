import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  startContainer, waitForPostgres, makeTestPool, applyMigrations, truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo, insertTalk, insertTranscript, insertChunk, searchChunksHybrid,
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

function vec(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
}

describe('searchChunksHybrid', () => {
  it('returns chunks with talk metadata joined', async () => {
    const sv = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const t = await insertTalk(pool, { sourceVideoId: sv.id, title: 'Vectors', speaker: 'Alice', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr = await insertTranscript(pool, { talkId: t.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t.id, transcriptId: tr.id, chunkIndex: 0, text: 'vectors are arrays of numbers', startMs: 0, endMs: 1, tokenCount: 5, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'vectors', vec(1), 10, {})
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.talk_title).toBe('Vectors')
    expect(r[0]!.speaker).toBe('Alice')
    expect(r[0]!.source_video_id).toBe(sv.id)
  })

  it('respects source_video_id scope filter', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'B', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'y', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t1.id, transcriptId: tr1.id, chunkIndex: 0, text: 'X word here', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })
    await insertChunk(pool, { talkId: t2.id, transcriptId: tr2.id, chunkIndex: 0, text: 'X word here', startMs: 0, endMs: 1, tokenCount: 3, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'X', vec(1), 10, { sourceVideoIds: [sv1.id] })
    expect(r.every(c => c.source_video_id === sv1.id)).toBe(true)
  })

  it('respects series_slug scope filter', async () => {
    const sv1 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/a', youtubeId: 'a' })
    const sv2 = await insertSourceVideo(pool, { youtubeUrl: 'https://youtu.be/b', youtubeId: 'b' })
    await pool.query('update source_videos set series_slug=$1 where id=$2', ['aies-2026', sv1.id])
    const t1 = await insertTalk(pool, { sourceVideoId: sv1.id, title: 'T1', speaker: 'A', talkIndex: 0, startMs: 0, endMs: 1 })
    const t2 = await insertTalk(pool, { sourceVideoId: sv2.id, title: 'T2', speaker: 'B', talkIndex: 0, startMs: 0, endMs: 1 })
    const tr1 = await insertTranscript(pool, { talkId: t1.id, assemblyaiId: 'x', rawText: '', utterances: [] })
    const tr2 = await insertTranscript(pool, { talkId: t2.id, assemblyaiId: 'y', rawText: '', utterances: [] })
    await insertChunk(pool, { talkId: t1.id, transcriptId: tr1.id, chunkIndex: 0, text: 'foobar', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })
    await insertChunk(pool, { talkId: t2.id, transcriptId: tr2.id, chunkIndex: 0, text: 'foobar', startMs: 0, endMs: 1, tokenCount: 1, embedding: vec(1) })

    const r = await searchChunksHybrid(pool, 'foobar', vec(1), 10, { seriesSlug: 'aies-2026' })
    expect(r.every(c => c.source_video_id === sv1.id)).toBe(true)
  })
})
