import type { Pool } from 'pg'
import type { IEmbeddingService } from '../../interfaces/embeddings.js'
import type { ILLMService } from '../../interfaces/llm.js'
import type { Scope } from '../qa-scope.js'
import type { CitationSource } from './citation-validator.js'

export type ToolContext = {
  pool: Pool
  embeddings: IEmbeddingService
  llm: ILLMService
  scope: Scope
  signal: AbortSignal
}

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>   // JSONSchema; Claude consumes this
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolExecutionResult>
}

export type ToolExecutionResult = {
  json: unknown                            // serialized for tool_result block
  sources: CitationSource[]                // appended to validator's source pool
}

export type ToolCall = {
  tool: string
  duration_ms: number
  ok: boolean
  error?: string
}
