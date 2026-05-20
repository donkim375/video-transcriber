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
    }, { callsUntilTerminal: 0 })
    const { assemblyaiId } = await m.submit('/tmp/x.mp3')
    expect(assemblyaiId).toBe('abc')
    const status = await m.getStatus('abc')
    expect(status.status).toBe('completed')
    const result = await m.getResult('abc')
    expect(result.rawText).toBe('hello')
  })

  it('getStatus progresses queued -> processing -> completed across calls', async () => {
    const m = new MockTranscriptionService(
      { assemblyaiId: 'p1', rawText: '', utterances: [] },
      { callsUntilTerminal: 2 },
    )
    await m.submit('/tmp/a.mp3')
    expect((await m.getStatus('p1')).status).toBe('queued')
    expect((await m.getStatus('p1')).status).toBe('processing')
    expect((await m.getStatus('p1')).status).toBe('completed')
    // Holds terminal once exhausted
    expect((await m.getStatus('p1')).status).toBe('completed')
  })

  it('honours explicit statusSequence', async () => {
    const m = new MockTranscriptionService(
      { assemblyaiId: 'e1', rawText: '', utterances: [] },
      { statusSequence: ['queued', 'error'] },
    )
    await m.submit('/tmp/a.mp3')
    expect((await m.getStatus('e1')).status).toBe('queued')
    expect((await m.getStatus('e1')).status).toBe('error')
  })

  it('records statusCalls per id', async () => {
    const m = new MockTranscriptionService(
      { assemblyaiId: 'c1', rawText: '', utterances: [] },
      { callsUntilTerminal: 0 },
    )
    await m.getStatus('c1')
    await m.getStatus('c1')
    expect(m.statusCalls['c1']).toBe(2)
  })

  it('getResult throws for unknown id', async () => {
    const m = new MockTranscriptionService(
      { assemblyaiId: 'r1', rawText: '', utterances: [] },
    )
    await expect(m.getResult('not-r1')).rejects.toThrow(/Unknown transcription id/)
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
