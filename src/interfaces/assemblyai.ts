import type { TranscriptionResult, TranscriptionStatus } from '../types/index.js'

export interface ITranscriptionService {
  submit(audioPath: string): Promise<{ assemblyaiId: string }>
  getStatus(transcriptionId: string): Promise<TranscriptionStatus>
  getResult(transcriptionId: string): Promise<TranscriptionResult>
}
