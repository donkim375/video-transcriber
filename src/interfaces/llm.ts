import type { TalkBoundary } from '../types/index.js'

export interface FaqItem {
  question: string
  answer: string
}

export interface FaqGenerationInput {
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  answerQuestion(question: string, context: string): Promise<string>
  generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]>
  summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string>
}
