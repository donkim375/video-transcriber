import type { ILLMService, FaqItem, FaqGenerationInput } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public answerCalls: { question: string; context: string }[] = []
  public faqCalls: FaqGenerationInput[] = []
  public synthCalls: Array<{ idea: string; talkTitle: string; speaker: string; evidence: string[] }> = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private answer = 'Mock answer.',
    private faqs: FaqItem[] = [
      { question: 'q1?', answer: 'a1.' },
      { question: 'q2?', answer: 'a2.' },
    ]
  ) {}

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    this.segmentCalls.push(transcript)
    return this.boundaries
  }
  async summarizeTalk(transcript: string): Promise<string> {
    this.summarizeCalls.push(transcript)
    return this.summary
  }
  async answerQuestion(question: string, context: string): Promise<string> {
    this.answerCalls.push({ question, context })
    return this.answer
  }
  async generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]> {
    this.faqCalls.push(input)
    return this.faqs
  }
  async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
    this.synthCalls.push(input)
    return `Synth: ${input.talkTitle} on ${input.idea}.`
  }
}
