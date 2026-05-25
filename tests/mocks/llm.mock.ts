import type { ILLMService, FaqItem, FaqGenerationInput, AnthropicCallResponse, ToolCallOptions } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public faqCalls: FaqGenerationInput[] = []
  public synthCalls: Array<{ idea: string; talkTitle: string; speaker: string; evidence: string[] }> = []
  public toolCallLog: ToolCallOptions[] = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private faqs: FaqItem[] = [
      { question: 'q1?', answer: 'a1.' },
      { question: 'q2?', answer: 'a2.' },
    ],
    private toolCallResponses: AnthropicCallResponse[] = [],
  ) {}

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    this.segmentCalls.push(transcript)
    return this.boundaries
  }
  async summarizeTalk(transcript: string): Promise<string> {
    this.summarizeCalls.push(transcript)
    return this.summary
  }
  async generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]> {
    this.faqCalls.push(input)
    return this.faqs
  }
  async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
    this.synthCalls.push(input)
    return `Synth: ${input.talkTitle} on ${input.idea}.`
  }
  async toolCall(opts: ToolCallOptions): Promise<AnthropicCallResponse> {
    this.toolCallLog.push(opts)
    const next = this.toolCallResponses.shift()
    if (!next) throw new Error('MockLLMService: no scripted tool-call response')
    return next
  }

  pushToolCallResponse(resp: AnthropicCallResponse): void {
    this.toolCallResponses.push(resp)
  }
}
