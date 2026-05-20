import Anthropic from '@anthropic-ai/sdk'
import type { ILLMService } from '../interfaces/llm.js'
import type { TalkBoundary } from '../types/index.js'

type ClientLike = {
  messages: {
    create(p: any): Promise<{ content: { type: string; text?: string }[] }>
  }
}

const MODEL = 'claude-sonnet-4-6'

export class ClaudeLLMService implements ILLMService {
  constructor(private client: ClientLike) {}

  static fromApiKey(apiKey: string): ClaudeLLMService {
    return new ClaudeLLMService(new Anthropic({ apiKey }) as unknown as ClientLike)
  }

  private async invoke(system: string, user: string, maxTokens = 4096): Promise<string> {
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const blocks = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string')
    return blocks.map((b) => b.text as string).join('\n').trim()
  }

  async segmentTranscript(transcript: string): Promise<TalkBoundary[]> {
    const sys =
      'You segment conference transcripts into individual talks. ' +
      'Respond with ONLY a JSON array of {title, speaker, startMs, endMs} objects. No prose.'
    const txt = await this.invoke(sys, `Transcript:\n${transcript}`, 4096)
    const match = txt.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('Claude segmentation: no JSON array in response')
    const parsed = JSON.parse(match[0]) as TalkBoundary[]
    return parsed
  }

  async summarizeTalk(transcript: string): Promise<string> {
    const sys = 'You write concise (3-5 sentence) summaries of conference talks. Plain prose, no markdown.'
    return this.invoke(sys, `Talk transcript:\n${transcript}`, 1024)
  }

  async answerQuestion(question: string, context: string): Promise<string> {
    const sys =
      'Answer the user question using only the provided context. ' +
      'Cite sources inline as [chunk:<id>] where the context provides such markers. ' +
      'If the answer is not in the context, say so.'
    const user = `Context:\n${context}\n\nQuestion: ${question}`
    return this.invoke(sys, user, 2048)
  }
}
