import type { TalkBoundary } from '../types/index.js'

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  answerQuestion(question: string, context: string): Promise<string>
}
