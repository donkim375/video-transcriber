import { describe, it, expect } from 'vitest'
import { parseScope, toScopeFilters } from '../../src/services/qa-scope.js'

describe('parseScope', () => {
  it('accepts empty scope', () => {
    const r = parseScope(undefined)
    expect(r).toEqual({})
  })

  it('accepts all fields', () => {
    const r = parseScope({
      series_slug: 'aies-2026',
      source_video_id: ['11111111-1111-1111-1111-111111111111'],
      talk_id: '22222222-2222-2222-2222-222222222222',
      speaker: 'jane',
    })
    expect(r.series_slug).toBe('aies-2026')
    expect(r.talk_id).toBe('22222222-2222-2222-2222-222222222222')
  })

  it('rejects malformed UUID in talk_id', () => {
    expect(() => parseScope({ talk_id: 'not-a-uuid' })).toThrow()
  })

  it('rejects malformed UUID in source_video_id', () => {
    expect(() => parseScope({ source_video_id: ['nope'] })).toThrow()
  })
})

describe('toScopeFilters', () => {
  it('maps to db query shape', () => {
    const f = toScopeFilters({
      talk_id: '22222222-2222-2222-2222-222222222222',
      source_video_id: ['11111111-1111-1111-1111-111111111111'],
      series_slug: 'aies-2026',
      speaker: 'Jane',
    })
    expect(f).toEqual({
      talkId: '22222222-2222-2222-2222-222222222222',
      sourceVideoIds: ['11111111-1111-1111-1111-111111111111'],
      seriesSlug: 'aies-2026',
      speaker: 'Jane',
    })
  })

  it('omits undefined fields', () => {
    const f = toScopeFilters({ speaker: 'Jane' })
    expect(f).toEqual({ speaker: 'Jane' })
  })
})
