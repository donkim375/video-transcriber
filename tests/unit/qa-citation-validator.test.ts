import { describe, it, expect } from 'vitest'
import { validateAndRewriteCitations, type CitationSource } from '../../src/services/qa-tools/citation-validator.js'

const sources: CitationSource[] = [
  {
    type: 'chunk',
    chunk_id: '11111111-1111-1111-1111-111111111111',
    talk_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    source_video_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    youtube_id: 'yt1',
    start_ms: 1000,
    end_ms: 2000,
    talk_title: 'T1',
    speaker: 'Alice',
    video_title: 'V1',
    day_label: 'Day 1',
    series_slug: 'aies-2026',
    similarity: 0.8,
  },
  {
    type: 'talk',
    chunk_id: null,
    talk_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    source_video_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    youtube_id: 'yt1',
    start_ms: 60000,
    end_ms: 120000,
    talk_title: 'T2',
    speaker: 'Bob',
    video_title: 'V1',
    day_label: 'Day 1',
    series_slug: 'aies-2026',
    similarity: null,
  },
]

describe('validateAndRewriteCitations', () => {
  it('rewrites valid markers to [N]', () => {
    const r = validateAndRewriteCitations(
      'A [chunk:11111111-1111-1111-1111-111111111111] then B [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb].',
      sources
    )
    expect(r.answer).toBe('A [1] then B [2].')
    expect(r.citations).toHaveLength(2)
    expect(r.citations[0]!.chunk_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(r.citations[1]!.source).toBe('talk')
  })

  it('strips invalid markers', () => {
    const r = validateAndRewriteCitations(
      'A [chunk:00000000-0000-0000-0000-000000000000] then B [chunk:11111111-1111-1111-1111-111111111111].',
      sources
    )
    expect(r.answer).toBe('A  then B [1].')
    expect(r.citations).toHaveLength(1)
    expect(r.stripped).toBe(1)
  })

  it('deduplicates repeated valid markers to same number', () => {
    const r = validateAndRewriteCitations(
      'X [chunk:11111111-1111-1111-1111-111111111111] Y [chunk:11111111-1111-1111-1111-111111111111] Z.',
      sources
    )
    expect(r.answer).toBe('X [1] Y [1] Z.')
    expect(r.citations).toHaveLength(1)
  })

  it('orders citations by first appearance', () => {
    const r = validateAndRewriteCitations(
      'A [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb] then B [chunk:11111111-1111-1111-1111-111111111111].',
      sources
    )
    expect(r.citations[0]!.source).toBe('talk')
    expect(r.citations[1]!.source).toBe('chunk')
  })

  it('handles answer with zero citations', () => {
    const r = validateAndRewriteCitations('Plain answer.', sources)
    expect(r.answer).toBe('Plain answer.')
    expect(r.citations).toEqual([])
    expect(r.stripped).toBe(0)
  })

  it('builds transcript_anchor from chunk or talk id', () => {
    const r = validateAndRewriteCitations(
      '[chunk:11111111-1111-1111-1111-111111111111] and [talk:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb].',
      sources
    )
    expect(r.citations[0]!.transcript_anchor).toBe('#chunk-11111111-1111-1111-1111-111111111111')
    expect(r.citations[1]!.transcript_anchor).toBe('#talk-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  it('builds youtube_deeplink from youtube_id and start_ms', () => {
    const r = validateAndRewriteCitations(
      '[chunk:11111111-1111-1111-1111-111111111111]',
      sources
    )
    expect(r.citations[0]!.youtube_deeplink).toBe('https://youtu.be/yt1?t=1')
  })
})
