import type { Pool } from 'pg'
import type { IEmbeddingService } from '../../interfaces/embeddings.js'
import type { ILLMService, AnthropicMessage, AnthropicCallResponse } from '../../interfaces/llm.js'
import type { Scope } from '../qa-scope.js'
import type { ToolDefinition, ToolCall } from './types.js'
import type { CitationSource } from './citation-validator.js'
import { SYSTEM_PROMPT } from './system-prompt.js'

export interface RunToolLoopOpts {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  scope: Scope
  tools: ToolDefinition[]
  llm: ILLMService
  embeddings: IEmbeddingService
  pool: Pool
  budget: { maxIterations: number; maxWallMs: number; maxToolResultTokens: number }
}

export interface RunToolLoopResult {
  answer: string
  rawAnswer: string
  toolTrace: ToolCall[]
  reachedBudgetCap: boolean
  partial: boolean
  sources: CitationSource[]
}

const CHAR_PER_TOKEN = 4

export async function runToolLoop(opts: RunToolLoopOpts): Promise<RunToolLoopResult> {
  const controller = new AbortController()
  const deadline = Date.now() + opts.budget.maxWallMs
  const timer = setTimeout(() => controller.abort(), opts.budget.maxWallMs)

  const toolByName = new Map(opts.tools.map(t => [t.name, t]))
  const collectedSources: CitationSource[] = []
  const toolTrace: ToolCall[] = []
  let partial = false
  let reachedBudgetCap = false

  // history-strip: only assistant text from prior turns + the current user turn
  const stripped: AnthropicMessage[] = opts.messages.map(m => ({ role: m.role, content: m.content }))

  const toolsForLlm = opts.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))

  let resp: AnthropicCallResponse | null = null

  try {
    for (let i = 0; i < opts.budget.maxIterations; i++) {
      if (Date.now() > deadline) { reachedBudgetCap = true; break }
      resp = await opts.llm.toolCall({
        system: SYSTEM_PROMPT,
        messages: stripped,
        tools: toolsForLlm,
        tool_choice: { type: 'auto' },
        signal: controller.signal,
      })
      if (resp.stop_reason === 'end_turn') {
        const answer = joinText(resp.content)
        return { answer, rawAnswer: answer, toolTrace, reachedBudgetCap: false, partial, sources: collectedSources }
      }
      if (resp.stop_reason !== 'tool_use') {
        // unexpected stop; surface as partial
        partial = true
        const answer = joinText(resp.content)
        return { answer, rawAnswer: answer, toolTrace, reachedBudgetCap: false, partial, sources: collectedSources }
      }

      const toolUses = resp.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')

      const ctx = {
        pool: opts.pool,
        embeddings: opts.embeddings,
        llm: opts.llm,
        scope: opts.scope,
        signal: controller.signal,
      }

      const results = await Promise.all(toolUses.map(async (tu) => {
        const tool = toolByName.get(tu.name)
        const start = Date.now()
        if (!tool) {
          toolTrace.push({ tool: tu.name, duration_ms: 0, ok: false, error: 'unknown tool' })
          partial = true
          return { tool_use_id: tu.id, payload: { error: 'unknown tool' } }
        }
        try {
          const result = await tool.execute(tu.input, ctx)
          for (const s of result.sources) collectedSources.push(s)
          toolTrace.push({ tool: tu.name, duration_ms: Date.now() - start, ok: true })
          return { tool_use_id: tu.id, payload: result.json }
        } catch (err) {
          partial = true
          const msg = err instanceof Error ? err.message : String(err)
          toolTrace.push({ tool: tu.name, duration_ms: Date.now() - start, ok: false, error: msg })
          return { tool_use_id: tu.id, payload: { error: msg } }
        }
      }))

      stripped.push({ role: 'assistant', content: resp.content })
      stripped.push({
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result',
          tool_use_id: r.tool_use_id,
          content: truncate(JSON.stringify(r.payload), opts.budget.maxToolResultTokens),
        })),
      })
    }

    reachedBudgetCap = true
    const finalResp = await opts.llm.toolCall({
      system: SYSTEM_PROMPT,
      messages: stripped,
      tools: toolsForLlm,
      tool_choice: { type: 'none' },
      signal: controller.signal,
    })
    const answer = joinText(finalResp.content)
    return { answer, rawAnswer: answer, toolTrace, reachedBudgetCap, partial, sources: collectedSources }
  } finally {
    clearTimeout(timer)
  }
}

function joinText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

function truncate(s: string, maxTokens: number): string {
  const maxChars = maxTokens * CHAR_PER_TOKEN
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + '\n...[truncated]'
}
