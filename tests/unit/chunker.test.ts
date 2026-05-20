import { describe, it, expect } from 'vitest'
import { chunkText } from '../../src/services/chunker.js'

describe('chunkText', () => {
  it('returns a single chunk for short input', () => {
    const chunks = chunkText('Short sentence.', { targetTokens: 400, overlapTokens: 50 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('Short sentence.')
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0)
  })

  it('splits long text into multiple chunks', () => {
    const longText = Array.from({ length: 300 }, (_, i) => `Sentence ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 100, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(140)
    }
  })

  it('chunks overlap by approximately overlapTokens', () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 80, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    const a = chunks[0]!.text
    const b = chunks[1]!.text
    const tailWords = a.split(/\s+/).slice(-5)
    const headStart = b.split(/\s+/).slice(0, 30).join(' ')
    expect(tailWords.some((w) => headStart.includes(w))).toBe(true)
  })

  it('splits at sentence boundaries (no mid-sentence break)', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.'
    const chunks = chunkText(text, { targetTokens: 6, overlapTokens: 1 })
    for (const c of chunks) {
      expect(c.text.trim()).toMatch(/[.!?]$/)
    }
  })

  it('attaches sequential chunkIndex', () => {
    const longText = Array.from({ length: 100 }, (_, i) => `Sentence ${i}.`).join(' ')
    const chunks = chunkText(longText, { targetTokens: 60, overlapTokens: 10 })
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i))
  })
})
