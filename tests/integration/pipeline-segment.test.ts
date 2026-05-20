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
  getSourceVideoById,
  listTalksForVideo,
  getTranscriptByTalkId,
} from '../../src/db/queries.js'
import { runSegment } from '../../src/workers/steps/segment.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import type { StepContext } from '../../src/workers/types.js'
import type { TranscriptionResult, TalkBoundary } from '../../src/types/index.js'

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

function transcription(): TranscriptionResult {
  return {
    assemblyaiId: 'tx-1',
    rawText: 'full transcript text',
    utterances: sampleUtterances,
  }
}

describe('runSegment', () => {
  it('uses chapter-based boundaries when chapters are present (Path A)', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const llm = new MockLLMService([], 'summary', 'answer')
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
    const chapters = [{ title: 'Vectors by Alice', startMs: 5000, endMs: 13000 }]
    const result = await runSegment(ctx, { transcription: transcription(), chapters, contentType: 'conference' })

    expect(result.talkIds).toHaveLength(1)
    expect(result.talkIds[0]!.boundary.title).toBe('Vectors')
    expect(result.talkIds[0]!.boundary.speaker).toBe('Alice')
    expect(llm.segmentCalls).toHaveLength(0)

    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks).toHaveLength(1)
    expect(talks[0]!.title).toBe('Vectors')
    expect(talks[0]!.speaker).toBe('Alice')
    expect(talks[0]!.youtube_deep_link).toBe('https://youtu.be/abc?t=5s')
    expect(talks[0]!.start_ms).toBe(5000)
    expect(talks[0]!.end_ms).toBe(13000)

    const tx = await getTranscriptByTalkId(pool, talks[0]!.id)
    expect(tx).toBeTruthy()
    expect(tx.assemblyai_id).toBe('tx-1#0')
    expect(tx.raw_text).toContain('vectors')

    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('segmenting')
  })

  it('falls back to LLM segmentation when no chapters (Path B)', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/xyz',
      youtubeId: 'xyz',
    })
    const boundaries: TalkBoundary[] = [
      { title: 'LLM Talk', speaker: 'Speaker', startMs: 0, endMs: 24000 },
    ]
    const llm = new MockLLMService(boundaries, 'summary', 'answer')
    const ctx: StepContext = {
      pool,
      youtube: new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] }),
      transcription: new MockTranscriptionService({ assemblyaiId: 'tx-1', rawText: '', utterances: [] }),
      embeddings: new MockEmbeddingService(),
      llm,
      tmpDir: tmpdir(),
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/xyz',
    }

    const result = await runSegment(ctx, { transcription: transcription(), chapters: [], contentType: 'conference' })

    expect(result.talkIds).toHaveLength(1)
    expect(result.talkIds[0]!.boundary.title).toBe('LLM Talk')
    expect(llm.segmentCalls).toHaveLength(1)
    expect(llm.segmentCalls[0]).toBe('full transcript text')

    const talks = await listTalksForVideo(pool, sv.id)
    expect(talks).toHaveLength(1)
    expect(talks[0]!.title).toBe('LLM Talk')
  })
})
