import type { ITranscriptionService } from '../../src/interfaces/assemblyai.js'
import type { TranscriptionResult, TranscriptionStatus } from '../../src/types/index.js'

export class MockTranscriptionService implements ITranscriptionService {
  public submissions: string[] = []
  private statusByid: Record<string, TranscriptionStatus['status']> = {}

  constructor(private result: TranscriptionResult, private terminalStatus: TranscriptionStatus['status'] = 'completed') {}

  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    this.submissions.push(audioPath)
    const id = this.result.assemblyaiId
    this.statusByid[id] = 'queued'
    return { assemblyaiId: id }
  }

  async getStatus(transcriptionId: string): Promise<TranscriptionStatus> {
    this.statusByid[transcriptionId] = this.terminalStatus
    return { id: transcriptionId, status: this.terminalStatus }
  }

  async getResult(transcriptionId: string): Promise<TranscriptionResult> {
    if (transcriptionId !== this.result.assemblyaiId) {
      throw new Error(`Unknown transcription id ${transcriptionId}`)
    }
    return this.result
  }
}
