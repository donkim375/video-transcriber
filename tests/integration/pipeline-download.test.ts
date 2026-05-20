import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
  truncateAll,
} from './db-setup.js'
import { insertSourceVideo, getSourceVideoById } from '../../src/db/queries.js'
import { runDownload } from '../../src/workers/steps/download.js'
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

function makeCtx(
  sourceVideoId: string,
  youtubeUrl: string,
  youtube: MockYouTubeService
): StepContext {
  return {
    pool,
    youtube,
    transcription: new MockTranscriptionService({ assemblyaiId: 'tx-1', rawText: '', utterances: [] }),
    embeddings: new MockEmbeddingService(),
    llm: new MockLLMService(),
    tmpDir: tmpdir(),
    sourceVideoId,
    youtubeUrl,
  }
}

describe('runDownload', () => {
  it('writes metadata and records the download', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/abc',
      youtubeId: 'abc',
    })
    const youtube = new MockYouTubeService({
      title: 'Conference 2024',
      channel: 'ConfChannel',
      durationSeconds: 1800,
      thumbnailUrl: 'https://img.test/thumb.jpg',
      chapters: [],
    })
    const ctx = makeCtx(sv.id, 'https://youtu.be/abc', youtube)
    const result = await runDownload(ctx)

    expect(result.audioPath).toContain(sv.id)
    expect(result.audioPath.endsWith('.mp3')).toBe(true)
    expect(youtube.downloads).toHaveLength(1)
    expect(youtube.downloads[0]!.url).toBe('https://youtu.be/abc')

    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.title).toBe('Conference 2024')
    expect(fetched!.channel).toBe('ConfChannel')
    expect(fetched!.duration_seconds).toBe(1800)
    expect(fetched!.thumbnail_url).toBe('https://img.test/thumb.jpg')
    expect(fetched!.has_chapters).toBe(false)
    expect(fetched!.status).toBe('downloading')
  })

  it('marks has_chapters when chapters are present', async () => {
    const sv = await insertSourceVideo(pool, {
      youtubeUrl: 'https://youtu.be/xyz',
      youtubeId: 'xyz',
    })
    const youtube = new MockYouTubeService({
      title: 'Multi-talk',
      channel: 'C',
      durationSeconds: 600,
      thumbnailUrl: '',
      chapters: [{ title: 'Intro', startMs: 0, endMs: 1000 }],
    })
    const ctx = makeCtx(sv.id, 'https://youtu.be/xyz', youtube)
    await runDownload(ctx)
    const fetched = await getSourceVideoById(pool, sv.id)
    expect(fetched!.has_chapters).toBe(true)
  })
})
