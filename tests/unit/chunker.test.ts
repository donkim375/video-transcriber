import { describe, it, expect } from 'vitest'
import { chunkText, chunkUtterances } from '../../src/services/chunker.js'
import type { Utterance } from '../../src/types/index.js'
import { utterancesWithWords } from '../fixtures/utterances-with-words.js'

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

describe('chunkUtterances', () => {
  const opts = { targetTokens: 400, overlapTokens: 50 }

  it('returns empty array for empty utterances', () => {
    expect(chunkUtterances([], opts)).toEqual([])
  })

  it('returns a single chunk preserving min(startMs)/max(endMs) across utterances', () => {
    const utts: Utterance[] = [
      { speaker: 'A', text: 'Hello world.', startMs: 1000, endMs: 2000 },
      { speaker: 'A', text: 'How are you.', startMs: 2000, endMs: 3500 },
    ]
    const chunks = chunkUtterances(utts, opts)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.startMs).toBe(1000)
    expect(chunks[0]!.endMs).toBe(3500)
    expect(chunks[0]!.text).toBe('Hello world. How are you.')
  })

  it('chunks split by token budget retain their member utterance timestamps', () => {
    const utts: Utterance[] = Array.from({ length: 30 }, (_, i) => ({
      speaker: 'A',
      text: `Sentence number ${i}.`,
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
    }))
    const chunks = chunkUtterances(utts, { targetTokens: 30, overlapTokens: 5 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.startMs).not.toBeNull()
      expect(c.endMs).not.toBeNull()
      expect(c.startMs! % 1000).toBe(0)
      expect(c.endMs! % 1000).toBe(0)
      expect(c.endMs!).toBeGreaterThan(c.startMs!)
    }
    expect(chunks[0]!.startMs).toBe(0)
    const last = chunks[chunks.length - 1]!
    expect(last.endMs).toBe(30000)
  })

  it('splits an utterance into sentences and tracks tokens', () => {
    const utts: Utterance[] = [
      { speaker: 'A', text: 'First. Second. Third.', startMs: 0, endMs: 3000 },
    ]
    const chunks = chunkUtterances(utts, opts)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0)
    expect(chunks[0]!.startMs).toBe(0)
    expect(chunks[0]!.endMs).toBe(3000)
  })

  it('derives per-sentence spans from words when present', () => {
    // Tiny token budget forces each sentence into its own chunk.
    const chunks = chunkUtterances(utterancesWithWords, { targetTokens: 5, overlapTokens: 0 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ text: 'Hello world.',           startMs: 0,    endMs: 1000 })
    expect(chunks[1]).toMatchObject({ text: 'This is a test.',        startMs: 1500, endMs: 4000 })
    expect(chunks[2]).toMatchObject({ text: 'Another sentence here.', startMs: 5000, endMs: 7000 })
  })

  it('falls back to utterance span when words are absent', () => {
    // Note: same fixture shape as the words case but with `words` omitted.
    const utts: Utterance[] = [
      { speaker: 'A', text: 'Hello world. This is a test.', startMs: 0,    endMs: 4000 },
      { speaker: 'A', text: 'Another sentence here.',       startMs: 5000, endMs: 7000 },
    ]
    const chunks = chunkUtterances(utts, { targetTokens: 5, overlapTokens: 0 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ text: 'Hello world.',           startMs: 0,    endMs: 4000 })
    expect(chunks[1]).toMatchObject({ text: 'This is a test.',        startMs: 0,    endMs: 4000 })
    expect(chunks[2]).toMatchObject({ text: 'Another sentence here.', startMs: 5000, endMs: 7000 })
  })

  it('aligns sentences containing contractions, decimals, and punctuation', () => {
    const utts: Utterance[] = [
      {
        speaker: 'A',
        text: "It's 3.14 percent.",
        startMs: 0,
        endMs: 2000,
        words: [
          { text: "It's",     startMs: 0,    endMs: 400  },
          { text: '3.14',     startMs: 400,  endMs: 1200 },
          { text: 'percent.', startMs: 1200, endMs: 2000 },
        ],
      },
    ]
    const chunks = chunkUtterances(utts, { targetTokens: 50, overlapTokens: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ startMs: 0, endMs: 2000 })
  })
})
