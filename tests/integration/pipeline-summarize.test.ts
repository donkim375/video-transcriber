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
  getTranscriptByTalkId,
} from '../../src/db/queries.js'
import { runSummarize } from '../../src/workers/steps/summarize.js'
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

describe('runSummarize', () => {
  it('summarizes each talk, stores summary, and marks status=ready', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const talkA = await insertTalk(pool, {
      sourceVideoId: sv.id, title: 'A', speaker: 'sa', talkIndex: 0, startMs: 0, endMs: 1000,
    })
    const txA = await insertTranscript(pool, {
      talkId: talkA.id, assemblyaiId: 'tx-A', rawText: 'A text', utterances: [],
    })
    const talkB = await insertTalk(pool, {
      sourceVideoId: sv.id, title: 'B', speaker: 'sb', talkIndex: 1, startMs: 1000, endMs: 2000,
    })
    const txB = await insertTranscript(pool, {
      talkId: talkB.id, assemblyaiId: 'tx-B', rawText: 'B text', utterances: [],
    })

    const llm = new MockLLMService([], 'Generated summary.', 'answer')
    const ctx: StepContext = {
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: 'tx-1', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: tmpdir(),
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/abc',
    }

    await runSummarize(ctx, {
      talks: [
        { talkId: talkA.id, transcriptId: txA.id, text: 'A talk text' },
        { talkId: talkB.id, transcriptId: txB.id, text: 'B talk text' },
      ],
    })

    expect(llm.summarizeCalls).toEqual(['A talk text', 'B talk text'])

    const txARow = await getTranscriptByTalkId(pool, talkA.id)
    const txBRow = await getTranscriptByTalkId(pool, talkB.id)
    expect(txARow.summary).toBe('Generated summary.')
    expect(txBRow.summary).toBe('Generated summary.')

    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('ready')
  })
})
