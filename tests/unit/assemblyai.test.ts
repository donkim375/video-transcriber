import { describe, it, expect, vi } from 'vitest'
import { AssemblyAIService } from '../../src/services/assemblyai.js'

function makeFakeClient(overrides: any = {}) {
  return {
    files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3'), ...overrides.files },
    transcripts: {
      submit: vi.fn(async () => ({ id: 'tx-1' })),
      get: vi.fn(async () => ({ id: 'tx-1', status: 'completed', text: 'Hello world', utterances: [
        { speaker: 'A', text: 'Hello world', start: 0, end: 1000 },
      ] })),
      ...overrides.transcripts,
    },
  }
}

describe('AssemblyAIService.submit', () => {
  it('uploads audio and submits a transcript job', async () => {
    const client = makeFakeClient()
    const svc = new AssemblyAIService(client as any)
    const { assemblyaiId } = await svc.submit('/tmp/x.mp3')
    expect(assemblyaiId).toBe('tx-1')
    expect(client.files.upload).toHaveBeenCalledWith('/tmp/x.mp3')
    expect(client.transcripts.submit).toHaveBeenCalledWith(
      expect.objectContaining({ audio_url: 'https://uploaded/audio.mp3', speaker_labels: true })
    )
  })
})

describe('AssemblyAIService.getStatus', () => {
  it('maps assemblyai status strings to TranscriptionStatus', async () => {
    const client = makeFakeClient({ transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'queued' })) } })
    const svc = new AssemblyAIService(client as any)
    const status = await svc.getStatus('tx-1')
    expect(status).toEqual({ id: 'tx-1', status: 'queued' })
  })

  it('reports error with message', async () => {
    const client = makeFakeClient({
      transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'error', error: 'bad audio' })) },
    })
    const svc = new AssemblyAIService(client as any)
    const status = await svc.getStatus('tx-1')
    expect(status.status).toBe('error')
    expect(status.errorMessage).toBe('bad audio')
  })

  it('emits errorMessage for unrecognized assemblyai status', async () => {
    const client = makeFakeClient({
      transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'frobnicating' })) },
    })
    const svc = new AssemblyAIService(client as any)
    const status = await svc.getStatus('tx-1')
    expect(status.status).toBe('error')
    expect(status.errorMessage).toBe('Unknown AssemblyAI status: frobnicating')
  })
})

describe('AssemblyAIService.getResult', () => {
  it('returns TranscriptionResult with utterances normalized', async () => {
    const client = makeFakeClient()
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.rawText).toBe('Hello world')
    expect(result.utterances).toEqual([{ speaker: 'A', text: 'Hello world', startMs: 0, endMs: 1000 }])
  })

  it('throws when transcript not in completed state', async () => {
    const client = makeFakeClient({
      transcripts: { get: vi.fn(async () => ({ id: 'tx-1', status: 'processing' })) },
    })
    const svc = new AssemblyAIService(client as any)
    await expect(svc.getResult('tx-1')).rejects.toThrow(/not completed/i)
  })

  it('passes through utterance words when present', async () => {
    const client = makeFakeClient({
      transcripts: {
        get: vi.fn(async () => ({
          id: 'tx-1',
          status: 'completed',
          text: 'Hello world.',
          utterances: [
            {
              speaker: 'A',
              text: 'Hello world.',
              start: 0,
              end: 1000,
              words: [
                { text: 'Hello',  start: 0,   end: 500 },
                { text: 'world.', start: 500, end: 1000 },
              ],
            },
          ],
        })),
      },
    })
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.utterances[0]!.words).toEqual([
      { text: 'Hello',  startMs: 0,   endMs: 500 },
      { text: 'world.', startMs: 500, endMs: 1000 },
    ])
  })

  it('leaves words undefined when AssemblyAI omits the field', async () => {
    const client = makeFakeClient()  // default makeFakeClient returns utterances without `words`
    const svc = new AssemblyAIService(client as any)
    const result = await svc.getResult('tx-1')
    expect(result.utterances[0]!.words).toBeUndefined()
  })
})

describe('AssemblyAIService retry behavior', () => {
  it('retries transcripts.submit on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3') },
      transcripts: {
        submit: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { id: 'tx-1' }
        }),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    const result = await svc.submit('/tmp/x.mp3')
    expect(result.assemblyaiId).toBe('tx-1')
    expect(client.transcripts.submit).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry transcripts.submit on 400', async () => {
    const err = new Error('bad audio') as Error & { status?: number }
    err.status = 400
    const client = {
      files: { upload: vi.fn(async () => 'https://uploaded/audio.mp3') },
      transcripts: {
        submit: vi.fn(async () => { throw err }),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    await expect(svc.submit('/tmp/x.mp3')).rejects.toThrow('bad audio')
    expect(client.transcripts.submit).toHaveBeenCalledTimes(1)
  })

  it('retries files.upload on 429', async () => {
    let n = 0
    const client = {
      files: {
        upload: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('rate limited') as Error & { status?: number }
            err.status = 429
            throw err
          }
          return 'https://uploaded/audio.mp3'
        }),
      },
      transcripts: {
        submit: vi.fn(async () => ({ id: 'tx-1' })),
        get: vi.fn(),
      },
    }
    const svc = new AssemblyAIService(client as any)
    await svc.submit('/tmp/x.mp3')
    expect(client.files.upload).toHaveBeenCalledTimes(2)
  })
})
