import { describe, it, expect } from 'vitest'
import { MockYouTubeService } from '../mocks/youtube.mock.js'
import { MockTranscriptionService } from '../mocks/assemblyai.mock.js'
import { MockEmbeddingService } from '../mocks/embeddings.mock.js'
import { MockLLMService } from '../mocks/llm.mock.js'

describe('MockYouTubeService', () => {
  it('returns provided metadata', async () => {
    const m = new MockYouTubeService({
      title: 'X', channel: 'C', durationSeconds: 1, thumbnailUrl: 't', chapters: [],
    })
    await expect(m.getMetadata('http://yt')).resolves.toMatchObject({ title: 'X' })
  })
  it('records downloads', async () => {
    const m = new MockYouTubeService({ title: '', channel: '', durationSeconds: 0, thumbnailUrl: '', chapters: [] })
    await m.downloadAudio('u', '/tmp/x.mp3')
    expect(m.downloads).toEqual([{ url: 'u', outputPath: '/tmp/x.mp3' }])
  })
})

describe('MockTranscriptionService', () => {
  it('submit -> getStatus completed -> getResult roundtrip', async () => {
    const m = new MockTranscriptionService({
      assemblyaiId: 'abc',
      rawText: 'hello',
      utterances: [],
    })
    const { assemblyaiId } = await m.submit('/tmp/x.mp3')
    expect(assemblyaiId).toBe('abc')
    const status = await m.getStatus('abc')
    expect(status.status).toBe('completed')
    const result = await m.getResult('abc')
    expect(result.rawText).toBe('hello')
  })
})

describe('MockEmbeddingService', () => {
  it('returns vectors with correct dimensions', async () => {
    const m = new MockEmbeddingService(1536)
    const vecs = await m.embed(['a', 'bb'])
    expect(vecs).toHaveLength(2)
    expect(vecs[0]).toHaveLength(1536)
  })
})

describe('MockLLMService', () => {
  it('returns configured boundaries/summary/answer', async () => {
    const m = new MockLLMService([{ title: 't', speaker: 's', startMs: 0, endMs: 1 }], 'S', 'A')
    await expect(m.segmentTranscript('x')).resolves.toHaveLength(1)
    await expect(m.summarizeTalk('x')).resolves.toBe('S')
    await expect(m.answerQuestion('q', 'c')).resolves.toBe('A')
  })
})
