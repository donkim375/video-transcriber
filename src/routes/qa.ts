import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AppDeps } from '../server.js'
import { parseScope } from '../services/qa-scope.js'
import { QA_TOOLS } from '../services/qa-tools/index.js'
import { runToolLoop } from '../services/qa-tools/runner.js'
import { validateAndRewriteCitations } from '../services/qa-tools/citation-validator.js'

const MAX_HISTORY_MESSAGES = 20
const MAX_HISTORY_TOKENS = 30_000
const REQUEST_MESSAGES_HARD_CAP = 100
const LOOP_BUDGET = { maxIterations: 5, maxWallMs: 20_000, maxToolResultTokens: 15_000 }
const CHAR_PER_TOKEN = 4

const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

const ScopeIn = z
  .object({
    series_slug: z.string().min(1).max(100).optional(),
    source_video_id: z.array(z.string().uuid()).max(10).optional(),
    talk_id: z.string().uuid().optional(),
    speaker: z.string().min(1).max(100).optional(),
  })
  .strict()
  .optional()

const Body = z.object({
  messages: z.array(ChatMessage).min(1).max(REQUEST_MESSAGES_HARD_CAP),
  scope: ScopeIn,
})

export async function registerQaRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/qa',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', detail: parsed.error.issues })
      }
      const { messages, scope: rawScope } = parsed.data
      if (messages[messages.length - 1]!.role !== 'user') {
        return reply.code(400).send({ error: 'last message must be user' })
      }
      let scope
      try { scope = parseScope(rawScope) } catch (e) {
        return reply.code(400).send({ error: 'invalid scope', detail: e instanceof Error ? e.message : String(e) })
      }

      const trimmed = trimHistory(messages)

      const requestId = randomUUID()
      const started = Date.now()

      let loopResult
      try {
        loopResult = await runToolLoop({
          messages: trimmed,
          scope,
          tools: QA_TOOLS,
          llm: deps.llm,
          embeddings: deps.embeddings,
          pool: deps.pool,
          budget: LOOP_BUDGET,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        req.log?.error?.({ event: 'qa.failed', request_id: requestId, err: msg })
        return reply.code(502).send({ error: 'llm_unavailable', detail: msg })
      }

      const { answer, citations, stripped } = validateAndRewriteCitations(loopResult.rawAnswer, loopResult.sources)

      console.log(JSON.stringify({
        event: 'qa.complete',
        request_id: requestId,
        scope,
        history_messages: trimmed.length,
        loop_iterations: loopResult.toolTrace.length,
        tool_calls: loopResult.toolTrace,
        total_wall_ms: Date.now() - started,
        partial: loopResult.partial,
        reached_cap: loopResult.reachedBudgetCap,
        invalid_citations_stripped: stripped,
        answer_chars: answer.length,
        citations_returned: citations.length,
      }))

      return reply.code(200).send({
        answer,
        citations,
        partial: loopResult.partial || undefined,
        reached_cap: loopResult.reachedBudgetCap || undefined,
        debug_tool_trace: process.env.DEBUG_QA === '1' ? loopResult.toolTrace : undefined,
      })
    }
  )
}

function trimHistory(messages: z.infer<typeof Body>['messages']): Array<{ role: 'user' | 'assistant'; content: string }> {
  let trimmed = messages.slice()
  if (trimmed.length > MAX_HISTORY_MESSAGES) {
    const first = trimmed[0]!
    trimmed = [first, ...trimmed.slice(-(MAX_HISTORY_MESSAGES - 1))]
  }
  while (estimateTokens(trimmed) > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    trimmed.splice(1, 1)
  }
  return trimmed
}

function estimateTokens(messages: Array<{ content: string }>): number {
  let chars = 0
  for (const m of messages) chars += m.content.length
  return Math.ceil(chars / CHAR_PER_TOKEN)
}
