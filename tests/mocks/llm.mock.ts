import type { ILLMService } from '../../src/interfaces/llm.js'
import type { TalkBoundary } from '../../src/types/index.js'

export class MockLLMService implements ILLMService {
  public segmentCalls: string[] = []
  public summarizeCalls: string[] = []
  public answerCalls: { question: string; context: string }[] = []

  constructor(
    private boundaries: TalkBoundary[] = [],
    private summary = 'Mock summary.',
    private answer = 'Mock answer.'
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
}
