import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from './db-setup.js'
import {
  insertSourceVideo,
  insertTalk,
  insertTranscript,
  getSourceVideoById,
} from '../../src/db/queries.js'
import { runEmbed } from '../../src/workers/steps/embed.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type { StepContext } from '../../src/workers/types.js'

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

describe('runEmbed', () => {
  it('chunks per talk, batch embeds, and inserts chunks rows', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const talk = await insertTalk(pool, {
      sourceVideoId: sv.id, title: 'T', speaker: 'S', talkIndex: 0, startMs: 0, endMs: 10000,
    })
    const tx = await insertTranscript(pool, {
      talkId: talk.id, assemblyaiId: 'tx-1', rawText: 'hello', utterances: [],
    })

    const embeddings = new MockEmbeddingService()
    const ctx: StepContext = {
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: 'tx-1', rawText: '', utterances: [] }),
      embeddings,
      llm: new MockLLMService(),
      tmpDir: tmpdir(),
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/abc',
    }

    const text = 'Welcome to the conference. Our first talk is by Alice. Today I will discuss vectors. Vectors are arrays of numbers.'
    await runEmbed(ctx, { talks: [{ talkId: talk.id, transcriptId: tx.id, text }] })

    const { rows: chunkRows } = await pool.query('select * from chunks where talk_id = $1 order by chunk_index asc', [talk.id])
    expect(chunkRows.length).toBeGreaterThan(0)
    for (const r of chunkRows) {
      expect(r.transcript_id).toBe(tx.id)
      expect(r.text.length).toBeGreaterThan(0)
      expect(r.token_count).toBeGreaterThan(0)
    }
    expect(embeddings.batches.length).toBeGreaterThan(0)

    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('embedding')
  })
})
