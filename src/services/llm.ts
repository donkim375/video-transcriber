import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { ILLMService } from '../interfaces/llm.js'
import type { TalkBoundary } from '../types/index.js'
import { withRetry } from './retry.js'

type ClientLike = {
  messages: {
    create(p: any): Promise<{ content: { type: string; text?: string }[] }>
  }
}

const MODEL = 'claude-sonnet-4-6'

const BoundarySchema = z.object({
  title: z.string(),
  speaker: z.string(),
  startMs: z.number(),
  endMs: z.number(),
})
const BoundaryArraySchema = z.array(BoundarySchema)

const FaqSchema = z.object({
  question: z.string(),
  answer: z.string(),
})
const FaqArraySchema = z.array(FaqSchema)

export class ClaudeLLMService implements ILLMService {
  constructor(private client: ClientLike) {}

  static fromApiKey(apiKey: string): ClaudeLLMService {
    return new ClaudeLLMService(new Anthropic({ apiKey }) as unknown as ClientLike)
  }

  private async invoke(system: string, user: string, maxTokens = 4096): Promise<string> {
    const res = await withRetry(
      () => this.client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      { opName: 'anthropic.messages.create' },
    )
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
    const raw = JSON.parse(match[0])
    const result = BoundaryArraySchema.safeParse(raw)
    if (!result.success) {
      throw new Error(`Claude segmentation: malformed boundary array: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    return result.data
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

  async summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string> {
    const sys = 'Given an idea and short evidence passages from one conference talk, produce a 1-2 sentence summary of how THIS talk treats the idea. Quote nothing. Plain prose.'
    const user = `Idea: ${input.idea}\nTalk: "${input.talkTitle}" by ${input.speaker}\nEvidence:\n${input.evidence.map((e, i) => `(${i + 1}) ${e}`).join('\n')}`
    const res = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: sys,
      messages: [{ role: 'user', content: user }],
    })
    const blocks = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string')
    return blocks.map((b) => b.text as string).join(' ').trim()
  }

  async generateFaqs(input: { videoTitle: string; talks: Array<{ title: string; summary: string }> }): Promise<Array<{ question: string; answer: string }>> {
    const sys =
      'Generate 6 FAQ pairs a curious visitor would ask about this video. ' +
      'Each answer must be grounded in the provided talk summaries (do not invent facts). ' +
      'Keep answers concise (1-3 sentences). ' +
      'Respond with ONLY a JSON array of {question, answer} objects. No prose.'
    const talksBlock = input.talks
      .map((t, i) => `Talk ${i + 1}: ${t.title}\nSummary: ${t.summary}`)
      .join('\n\n')
    const user = `Video title: ${input.videoTitle}\n\n${talksBlock}`
    const txt = await this.invoke(sys, user, 2048)
    const match = txt.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('Claude generateFaqs: no JSON array in response')
    const raw = JSON.parse(match[0])
    const result = FaqArraySchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        `Claude generateFaqs: malformed array: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      )
    }
    return result.data
  }
}
