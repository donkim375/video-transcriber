import { describe, it, expect } from 'vitest'
import {
  boundariesFromChapters,
  sliceUtterancesByBoundary,
  resolveSegmentationStrategy,
  validateBoundaries,
} from '../../src/services/segmentation.js'
import { sampleChapters } from '../fixtures/chapters.js'
import { sampleUtterances } from '../fixtures/utterances.js'
import { MockLLMService } from '../mocks/llm.mock.js'
import type { TranscriptionResult } from '../../src/types/index.js'

const transcription: TranscriptionResult = {
  assemblyaiId: 'tx-fixture',
  rawText: 'Welcome to the conference. Our first talk is by Alice.',
  utterances: sampleUtterances,
}

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

describe('resolveSegmentationStrategy', () => {
  it('returns a strategy whose name matches the requested content type', () => {
    expect(resolveSegmentationStrategy('single_speaker').name).toBe('single_speaker')
    expect(resolveSegmentationStrategy('conference').name).toBe('conference')
    expect(resolveSegmentationStrategy('podcast_interview').name).toBe('podcast_interview')
    expect(resolveSegmentationStrategy('auto').name).toBe('auto')
  })
})

describe('SingleSpeakerStrategy', () => {
  it('returns one boundary spanning [0, max(endMs)] using videoTitle', async () => {
    const strategy = resolveSegmentationStrategy('single_speaker')
    const boundaries = await strategy.segment({
      chapters: [],
      transcription,
      videoTitle: 'My Talk',
      llm: new MockLLMService(),
    })
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ title: 'My Talk', speaker: '', startMs: 0, endMs: 24000 })
  })

  it('falls back to "Full Talk" when videoTitle is missing', async () => {
    const strategy = resolveSegmentationStrategy('single_speaker')
    const [b] = await strategy.segment({ chapters: [], transcription, llm: new MockLLMService() })
    expect(b!.title).toBe('Full Talk')
  })

  it('does not call the LLM', async () => {
    const llm = new MockLLMService()
    await resolveSegmentationStrategy('single_speaker').segment({
      chapters: sampleChapters, transcription, llm,
    })
    expect(llm.segmentCalls).toHaveLength(0)
  })
})

describe('ConferenceStrategy', () => {
  it('uses chapters when present', async () => {
    const llm = new MockLLMService()
    const boundaries = await resolveSegmentationStrategy('conference').segment({
      chapters: sampleChapters, transcription, llm,
    })
    expect(boundaries).toHaveLength(3)
    expect(boundaries[1]).toMatchObject({ title: 'Alice on Vectors', speaker: '', startMs: 5000, endMs: 13000 })
    expect(llm.segmentCalls).toHaveLength(0)
  })

  it('falls back to LLM when no chapters', async () => {
    const llmBoundaries = [{ title: 'AI talk', speaker: 'A', startMs: 0, endMs: 24000 }]
    const llm = new MockLLMService(llmBoundaries)
    const boundaries = await resolveSegmentationStrategy('conference').segment({
      chapters: [], transcription, llm,
    })
    expect(llm.segmentCalls).toHaveLength(1)
    expect(boundaries).toEqual(llmBoundaries)
  })
})

describe('PodcastInterviewStrategy', () => {
  it('returns a single boundary with "Episode" fallback', async () => {
    const boundaries = await resolveSegmentationStrategy('podcast_interview').segment({
      chapters: [], transcription, llm: new MockLLMService(),
    })
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ title: 'Episode', startMs: 0, endMs: 24000 })
  })

  it('uses videoTitle when provided', async () => {
    const [b] = await resolveSegmentationStrategy('podcast_interview').segment({
      chapters: [], transcription, videoTitle: 'Ep 42: Vectors', llm: new MockLLMService(),
    })
    expect(b!.title).toBe('Ep 42: Vectors')
  })
})

describe('AutoStrategy', () => {
  it('routes to conference behaviour when YouTube chapters are present', async () => {
    const llm = new MockLLMService()
    const boundaries = await resolveSegmentationStrategy('auto').segment({
      chapters: sampleChapters, transcription, videoTitle: 'My Talk', llm,
    })
    expect(boundaries).toHaveLength(3)
    expect(llm.segmentCalls).toHaveLength(0)
  })

  it('routes to single-speaker behaviour when no chapters', async () => {
    const llm = new MockLLMService()
    const boundaries = await resolveSegmentationStrategy('auto').segment({
      chapters: [], transcription, videoTitle: 'My Talk', llm,
    })
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ title: 'My Talk', startMs: 0, endMs: 24000 })
    expect(llm.segmentCalls).toHaveLength(0)
  })
})

describe('validateBoundaries', () => {
  const good = [
    { title: 'Intro', speaker: '', startMs: 0, endMs: 5000 },
    { title: 'Talk 1', speaker: 'Alice', startMs: 5000, endMs: 13000 },
    { title: 'Talk 2', speaker: 'Bob', startMs: 13000, endMs: 24000 },
  ]

  it('passes on a valid contiguous boundary set', () => {
    expect(() => validateBoundaries(good, { audioDurationMs: 24000 })).not.toThrow()
  })

  it('throws on empty array', () => {
    expect(() => validateBoundaries([], { audioDurationMs: 24000 })).toThrow(/empty/i)
  })

  it('throws on zero-or-negative duration boundary, naming index', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 5000 },
      { title: 'B', speaker: '', startMs: 5000, endMs: 5000 },
      { title: 'C', speaker: '', startMs: 5000, endMs: 24000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 24000 })).toThrow(/boundary 1/)
  })

  it('throws on overlap, naming the offending index', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 6000 },
      { title: 'B', speaker: '', startMs: 5000, endMs: 13000 },
      { title: 'C', speaker: '', startMs: 13000, endMs: 24000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 24000 })).toThrow(/overlap.*boundary 1/i)
  })

  it('throws on gap larger than maxGapMs', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 5000 },
      { title: 'B', speaker: '', startMs: 200000, endMs: 240000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 240000 })).toThrow(/gap/i)
  })

  it('throws when intro starts after introMaxStartMs', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 90000, endMs: 100000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 100000 })).toThrow(/intro/i)
  })

  it('throws when last endMs covers less than minCoverageRatio of audio', () => {
    const bad = [
      { title: 'A', speaker: '', startMs: 0, endMs: 50000 },
    ]
    expect(() => validateBoundaries(bad, { audioDurationMs: 100000 })).toThrow(/coverage/i)
  })

  it('respects custom minCoverageRatio', () => {
    const bs = [{ title: 'A', speaker: '', startMs: 0, endMs: 60000 }]
    expect(() =>
      validateBoundaries(bs, { audioDurationMs: 100000, minCoverageRatio: 0.5 })
    ).not.toThrow()
  })
})
