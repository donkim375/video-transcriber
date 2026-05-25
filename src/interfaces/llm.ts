import type { TalkBoundary } from '../types/index.js'

export interface FaqItem {
  question: string
  answer: string
}

export interface FaqGenerationInput {
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export type AnthropicMessage =
  | { role: 'user'; content: string | Array<unknown> }
  | { role: 'assistant'; content: string | Array<unknown> }

export type AnthropicToolUse = {
  id: string
  name: string
  input: unknown
}

export type AnthropicCallResponse = {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >
}

export interface ToolCallOptions {
  system: string
  messages: AnthropicMessage[]
  tools: Array<{ name: string; description: string; input_schema: unknown }>
  tool_choice?: { type: 'auto' } | { type: 'none' } | { type: 'tool'; name: string }
  max_tokens?: number
  model?: string
  signal?: AbortSignal
}

export interface ILLMService {
  segmentTranscript(transcript: string): Promise<TalkBoundary[]>
  summarizeTalk(transcript: string): Promise<string>
  generateFaqs(input: FaqGenerationInput): Promise<FaqItem[]>
  summarizeForSynthesis(input: { idea: string; talkTitle: string; speaker: string; evidence: string[] }): Promise<string>
  toolCall(opts: ToolCallOptions): Promise<AnthropicCallResponse>
}
