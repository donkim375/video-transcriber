import { describe, it, expect } from 'vitest'
import { runToolLoop } from '../../src/services/qa-tools/runner.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type { ToolDefinition } from '../../src/services/qa-tools/types.js'

function makeFakeTool(name: string, output: unknown): ToolDefinition {
  return {
    name,
    description: '',
    input_schema: { type: 'object' },
    async execute() { return { json: output, sources: [] } },
  }
}

describe('runToolLoop', () => {
  it('terminates on end_turn', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
    })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      scope: {},
      tools: [],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.answer).toBe('Done.')
    expect(result.reachedBudgetCap).toBe(false)
  })

  it('runs a single tool then terminates', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'get_metadata', input: {} }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '5 talks.' }],
    })
    const tool = makeFakeTool('get_metadata', { total_talks: 5 })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'how many talks' }],
      scope: {},
      tools: [tool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.answer).toBe('5 talks.')
    expect(result.toolTrace).toHaveLength(1)
    expect(result.toolTrace[0]!.tool).toBe('get_metadata')
    expect(result.toolTrace[0]!.ok).toBe(true)
  })

  it('reaches iteration cap and forces final answer', async () => {
    const llm = new MockLLMService()
    // maxIterations=2 → 2 loop calls consume 2 tool_uses, then 1 forced call returns end_turn
    for (let i = 0; i < 2; i++) {
      llm.pushToolCallResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu${i}`, name: 'get_metadata', input: {} }],
      })
    }
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Capped answer.' }],
    })
    const tool = makeFakeTool('get_metadata', { total_talks: 5 })
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      scope: {},
      tools: [tool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 2, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.reachedBudgetCap).toBe(true)
    expect(result.answer).toBe('Capped answer.')
  })

  it('tool failure becomes tool_result error, not exception', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'failing', input: {} }],
    })
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'gave up.' }],
    })
    const failingTool: ToolDefinition = {
      name: 'failing',
      description: '',
      input_schema: { type: 'object' },
      async execute() { throw new Error('boom') },
    }
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'x' }],
      scope: {},
      tools: [failingTool],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    expect(result.partial).toBe(true)
    expect(result.toolTrace[0]!.ok).toBe(false)
    expect(result.toolTrace[0]!.error).toContain('boom')
  })

  it('strips assistant prior turns to text only when sending to llm', async () => {
    const llm = new MockLLMService()
    llm.pushToolCallResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK.' }],
    })
    await runToolLoop({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
      ],
      scope: {},
      tools: [],
      llm: llm as any,
      embeddings: {} as any,
      pool: {} as any,
      budget: { maxIterations: 5, maxWallMs: 10_000, maxToolResultTokens: 5000 },
    })
    const sent = llm.toolCallLog[0]!.messages
    expect(sent).toHaveLength(3)
    expect((sent[1] as any).content).toBe('first answer')
  })
})
