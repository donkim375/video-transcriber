import { describe, it, expect } from 'vitest'
import { boundariesFromChapters, sliceUtterancesByBoundary } from '../../src/services/segmentation.js'
import { sampleChapters } from '../fixtures/chapters.js'
import { sampleUtterances } from '../fixtures/utterances.js'

describe('boundariesFromChapters', () => {
  it('maps each chapter to a TalkBoundary', () => {
    const result = boundariesFromChapters(sampleChapters)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ title: 'Intro', startMs: 0, endMs: 5000 })
    expect(result[1]!.title).toBe('Alice on Vectors')
  })

  it('returns empty array for empty input', () => {
    expect(boundariesFromChapters([])).toEqual([])
  })

  it('parses speaker from "Title by Speaker" pattern', () => {
    const result = boundariesFromChapters([{ title: 'Vectors by Alice', startMs: 0, endMs: 1000 }])
    expect(result[0]).toMatchObject({ title: 'Vectors', speaker: 'Alice' })
  })

  it('sets empty speaker when not parseable', () => {
    const result = boundariesFromChapters([{ title: 'Intro', startMs: 0, endMs: 1000 }])
    expect(result[0]!.speaker).toBe('')
  })
})

describe('sliceUtterancesByBoundary', () => {
  it('returns utterances within [startMs, endMs)', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 5000, endMs: 13000 })
    expect(slice).toHaveLength(2)
    expect(slice[0]!.text).toBe('Thanks. Today I will discuss vectors.')
    expect(slice[1]!.text).toBe('Vectors are arrays of numbers.')
  })

  it('returns empty array when no utterances fall in range', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 100000, endMs: 200000 })
    expect(slice).toEqual([])
  })

  it('uses utterance start as inclusion criterion', () => {
    const slice = sliceUtterancesByBoundary(sampleUtterances, { title: 'X', speaker: '', startMs: 0, endMs: 5000 })
    expect(slice).toHaveLength(2)
  })
})
