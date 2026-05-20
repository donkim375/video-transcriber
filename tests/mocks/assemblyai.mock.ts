import type { ITranscriptionService } from '../../src/interfaces/assemblyai.js'
import type { TranscriptionResult, TranscriptionStatus, TranscriptionStatusValue } from '../../src/types/index.js'

export interface MockTranscriptionServiceOptions {
  /** Status sequence returned by successive getStatus() calls. Last value is held once exhausted. */
  statusSequence?: TranscriptionStatusValue[]
  /** Convenience: terminal status to emit after the implicit `queued → processing` ramp. Ignored if statusSequence is provided. */
  terminalStatus?: TranscriptionStatusValue
  /** Number of getStatus() calls before reaching terminalStatus when statusSequence is not provided. Defaults to 2 (queued, processing, then terminal). */
  callsUntilTerminal?: number
}

export class MockTranscriptionService implements ITranscriptionService {
  public submissions: string[] = []
  public statusCalls: Record<string, number> = {}
  private readonly sequence: TranscriptionStatusValue[]

  constructor(private result: TranscriptionResult, options: MockTranscriptionServiceOptions = {}) {
    if (options.statusSequence && options.statusSequence.length > 0) {
      this.sequence = options.statusSequence
    } else {
      const terminal = options.terminalStatus ?? 'completed'
      const ramp = options.callsUntilTerminal ?? 2
      this.sequence = [
        ...Array.from({ length: Math.max(0, ramp - 1) }, () => 'queued' as TranscriptionStatusValue),
        ...(ramp >= 1 ? (['processing'] as TranscriptionStatusValue[]) : []),
        terminal,
      ]
    }
  }

  async submit(audioPath: string): Promise<{ assemblyaiId: string }> {
    this.submissions.push(audioPath)
    return { assemblyaiId: this.result.assemblyaiId }
  }

  async getStatus(transcriptionId: string): Promise<TranscriptionStatus> {
    const calls = (this.statusCalls[transcriptionId] ?? 0) + 1
    this.statusCalls[transcriptionId] = calls
    const idx = Math.min(calls - 1, this.sequence.length - 1)
    const status = this.sequence[idx]!
    return { id: transcriptionId, status }
  }

  async getResult(transcriptionId: string): Promise<TranscriptionResult> {
    if (transcriptionId !== this.result.assemblyaiId) {
      throw new Error(`Unknown transcription id ${transcriptionId}`)
    }
    return this.result
  }
}
