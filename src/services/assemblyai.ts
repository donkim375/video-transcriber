import { AssemblyAI } from 'assemblyai'
import type { ITranscriptionService } from '../interfaces/assemblyai.js'
import type {
  TranscriptionResult,
  TranscriptionStatus,
  TranscriptionStatusValue,
} from '../types/index.js'

type ClientLike = {
  files: { upload(p: string): Promise<string> }
  transcripts: {
    submit(p: { audio_url: string; speaker_labels: boolean; speech_models?: string[] }): Promise<{ id: string }>
    get(id: string): Promise<any>
  }
}

const SPEECH_MODELS = ['universal-3-pro'] as const

const STATUS_MAP: Record<string, TranscriptionStatusValue> = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  error: 'error',
}

export class AssemblyAIService implements ITranscriptionService {
  constructor(private client: ClientLike) {}

  static fromApiKey(apiKey: string): AssemblyAIService {
    return new AssemblyAIService(new AssemblyAI({ apiKey }) as unknown as ClientLike)
  }

  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    const audio_url = await this.client.files.upload(audioPath)
    const { id } = await this.client.transcripts.submit({
      audio_url,
      speaker_labels: true,
      speech_models: [...SPEECH_MODELS],
    })
    return { assemblyaiId: id }
  }

  async getStatus(transcriptionId: string): Promise<TranscriptionStatus> {
    const t = await this.client.transcripts.get(transcriptionId)
    const rawStatus = String(t.status)
    const mapped = STATUS_MAP[rawStatus]
    const status: TranscriptionStatusValue = mapped ?? 'error'
    const out: TranscriptionStatus = { id: t.id, status }
    if (status === 'error') {
      if (t.error) out.errorMessage = String(t.error)
      else if (!mapped) out.errorMessage = `Unknown AssemblyAI status: ${rawStatus}`
    }
    return out
  }

  async getResult(transcriptionId: string): Promise<TranscriptionResult> {
    const t = await this.client.transcripts.get(transcriptionId)
    if (t.status !== 'completed') {
      throw new Error(`Transcript ${transcriptionId} not completed (status: ${t.status})`)
    }
    const utterances = (t.utterances ?? []).map((u: any) => ({
      speaker: String(u.speaker ?? ''),
      text: String(u.text ?? ''),
      startMs: Number(u.start ?? 0),
      endMs: Number(u.end ?? 0),
      words: Array.isArray(u.words)
        ? u.words.map((w: any) => ({
            text: String(w.text ?? ''),
            startMs: Number(w.start ?? 0),
            endMs: Number(w.end ?? 0),
          }))
        : undefined,
    }))
    return {
      assemblyaiId: t.id,
      rawText: String(t.text ?? ''),
      utterances,
    }
  }
}
