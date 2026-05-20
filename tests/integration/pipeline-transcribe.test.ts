import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { runTranscribe } from '../../src/workers/steps/transcribe.js'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import { sampleUtterances } from '../fixtures/utterances.js'
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

describe('runTranscribe', () => {
  it('submits, polls until completed, returns result, and unlinks the mp3', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const audioPath = join(tmpdir(), `${sv.id}.mp3`)
    writeFileSync(audioPath, 'dummy')

    const transcription = new MockTranscriptionService({
      assemblyaiId: 'tx-final',
      rawText: 'hello world',
      utterances: sampleUtterances,
    })
    const ctx: StepContext = {
      pool,
      youtube: new MockYouTubeService({
        title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [],
      }),
      transcription,
      embeddings: new MockEmbeddingService(),
      llm: new MockLLMService(),
      tmpDir: tmpdir(),
      sourceVideoId: sv.id,
      youtubeUrl: 'https://youtu.be/abc',
      pollIntervalMs: 10,
      pollTimeoutMs: 5000,
    }

    const result = await runTranscribe(ctx, { audioPath })

    expect(result.assemblyaiId).toBe('tx-final')
    expect(result.rawText).toBe('hello world')
    expect(result.utterances).toEqual(sampleUtterances)
    expect(transcription.submissions).toEqual([audioPath])
    expect(transcription.statusCalls['tx-final']).toBeGreaterThanOrEqual(3)
    expect(existsSync(audioPath)).toBe(false)

    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.status).toBe('transcribing')
  })
})
