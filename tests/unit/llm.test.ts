import { describe, it, expect, vi } from 'vitest'
import { ClaudeLLMService } from '../../src/services/llm.js'

function fakeAnthropic(textBlock: string) {
  return {
    messages: {
      create: vi.fn(async () => ({ content: [{ type: 'text', text: textBlock }] })),
    },
  }
}

describe('ClaudeLLMService.segmentTranscript', () => {
  it('parses JSON array of boundaries from Claude', async () => {
    const json = JSON.stringify([
      { title: 'A', speaker: 'X', startMs: 0, endMs: 1000 },
      { title: 'B', speaker: 'Y', startMs: 1000, endMs: 2000 },
    ])
    const client = fakeAnthropic(json)
    const svc = new ClaudeLLMService(client as any)
    const out = await svc.segmentTranscript('some transcript')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ title: 'A', startMs: 0 })
  })

  it('extracts JSON when Claude adds prose around it', async () => {
    const client = fakeAnthropic('Here is the JSON:\n[{"title":"A","speaker":"X","startMs":0,"endMs":1}]\nDone.')
    const svc = new ClaudeLLMService(client as any)
    const out = await svc.segmentTranscript('x')
    expect(out).toHaveLength(1)
  })

  it('throws when no JSON array found', async () => {
    const client = fakeAnthropic('I cannot.')
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.segmentTranscript('x')).rejects.toThrow(/JSON/)
  })

  it('throws when JSON array contains malformed boundaries', async () => {
    const client = fakeAnthropic(JSON.stringify([{ title: 'A' }])) // missing speaker, startMs, endMs
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.segmentTranscript('x')).rejects.toThrow(/malformed/i)
  })
})

describe('ClaudeLLMService.summarizeTalk', () => {
  it('returns the model text directly', async () => {
    const client = fakeAnthropic('Talk was great.')
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.summarizeTalk('x')).resolves.toBe('Talk was great.')
  })
})

// answerQuestion was removed in favor of toolCall + runner loop (see qa-runner tests)
describe.skip('ClaudeLLMService.answerQuestion', () => {
  it('includes question and context in prompt', async () => {
    const client = fakeAnthropic('The answer is 42.')
    const svc = new ClaudeLLMService(client as any)
    const ans = await (svc as any).answerQuestion('What is the answer?', 'Reference text.')
    expect(ans).toBe('The answer is 42.')
    const call = (client.messages.create as any).mock.calls[0][0]
    const userMsg = call.messages.find((m: any) => m.role === 'user')
    expect(userMsg.content).toContain('What is the answer?')
    expect(userMsg.content).toContain('Reference text.')
  })
})

describe('ClaudeLLMService retry behavior', () => {
  it('retries client.messages.create on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      messages: {
        create: vi.fn(async () => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { content: [{ type: 'text', text: 'A summary.' }] }
        }),
      },
    }
    const svc = new ClaudeLLMService(client as any)
    const result = await svc.summarizeTalk('some transcript')
    expect(result).toBe('A summary.')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry client.messages.create on 400', async () => {
    const err = new Error('bad prompt') as Error & { status?: number }
    err.status = 400
    const client = { messages: { create: vi.fn(async () => { throw err }) } }
    const svc = new ClaudeLLMService(client as any)
    await expect(svc.summarizeTalk('x')).rejects.toThrow('bad prompt')
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })
})
