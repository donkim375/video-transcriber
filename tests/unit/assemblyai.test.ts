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
})
