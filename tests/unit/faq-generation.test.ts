import { describe, it, expect } from 'vitest'
import { generateFaqsForVideo } from '../../src/workers/steps/generate-faqs.js'
import { MockLLMService } from '../mocks/llm.mock.js'

describe('generateFaqsForVideo', () => {
  it('passes the video title and talk summaries to the LLM, returns the faqs', async () => {
    const llm = new MockLLMService([], 'unused', [
      { question: 'What is this?', answer: 'A talk.' },
    ])
    const result = await generateFaqsForVideo({
      llm,
      videoTitle: 'AI Engineer Day 1',
      talks: [
        { title: 'Daytona Sandboxes', summary: 'How Daytona isolates user code.' },
        { title: 'Vector DBs', summary: 'A tour of vector stores.' },
      ],
    })
    expect(result).toEqual([{ question: 'What is this?', answer: 'A talk.' }])
    expect(llm.faqCalls).toHaveLength(1)
    expect(llm.faqCalls[0]?.videoTitle).toBe('AI Engineer Day 1')
    expect(llm.faqCalls[0]?.talks).toHaveLength(2)
  })

  it('returns an empty array when there are no talks', async () => {
    const llm = new MockLLMService([], 'unused', [
      { question: 'Q', answer: 'A' },
    ])
    const result = await generateFaqsForVideo({
      llm,
      videoTitle: 'Empty',
      talks: [],
    })
    expect(result).toEqual([])
    expect(llm.faqCalls).toHaveLength(0)
  })
})
